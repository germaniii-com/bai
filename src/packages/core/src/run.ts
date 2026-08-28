import type { Clock, EventType, PartId, PromptPayload, SessionId } from "@bai/shared";
import type { Bus } from "./event/bus";
import type { EventLog } from "./event/log";
import type { ProviderRegistry } from "./provider/registry";
import type { Store } from "./store/store";
import type { ToolRegistry } from "./tools/registry";

interface ActiveRun {
  controller: AbortController;
}

export interface RunCoordinatorDeps {
  store: Store;
  bus: Bus;
  log: EventLog;
  clock: Clock;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  /** Resolves the effective default model id, e.g. "stub/echo". */
  defaultModel(): string;
}

/**
 * One drain per session (process-global map keyed by session ID); different
 * sessions run concurrently. Wakes are joined/coalesced. Interrupt cancels
 * the drain; admitted-but-unpromoted inputs stay queued.
 */
export class RunCoordinator {
  private active = new Map<SessionId, ActiveRun>();
  private pendingWake = new Set<SessionId>();

  constructor(private deps: RunCoordinatorDeps) {}

  isActive(sessionId: SessionId): boolean {
    return this.active.has(sessionId);
  }

  activeSessions(): SessionId[] {
    return [...this.active.keys()];
  }

  wake(sessionId: SessionId): void {
    if (this.active.has(sessionId)) {
      this.pendingWake.add(sessionId);
      return;
    }
    void this.startDrain(sessionId).catch((err: unknown) => {
      // Drain errors still terminate the run cleanly.
      this.active.delete(sessionId);
      this.emitDurable(sessionId, "run.finished", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  interrupt(sessionId: SessionId): void {
    this.active.get(sessionId)?.controller.abort();
  }

  interruptAll(): void {
    for (const run of this.active.values()) run.controller.abort();
  }

  private async startDrain(sessionId: SessionId): Promise<void> {
    const controller = new AbortController();
    this.active.set(sessionId, { controller });
    this.emitDurable(sessionId, "run.started", {});
    try {
      do {
        this.pendingWake.delete(sessionId);
        await this.drainOnce(sessionId, controller.signal);
      } while (this.pendingWake.has(sessionId) && !controller.signal.aborted);
    } finally {
      this.active.delete(sessionId);
      this.emitDurable(sessionId, "run.finished", { aborted: controller.signal.aborted });
    }
  }

  /** Promote eligible inputs → provider turn → (tool calls, Phase 3) until idle. */
  private async drainOnce(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    const promoted = this.deps.store.inputs.promoteReady(sessionId);
    if (promoted.length === 0) return;

    const now = this.deps.clock.iso();
    for (const input of promoted) {
      const message = this.deps.store.messages.append(sessionId, "user", now);
      const part = this.deps.store.parts.append(message.id, 0, "text", { text: input.payload.text });
      this.emitDurable(sessionId, "message.created", { messageId: message.id, role: "user" });
      // The user's text must ride the event stream — surfaces build state from
      // events alone between snapshots, and message.created carries no payload.
      this.emitDurable(sessionId, "message.part.updated", {
        messageId: message.id,
        partId: part.id,
        kind: "text",
        payload: { text: input.payload.text },
      });
    }

    // Tool-call loop arrives with the code workbench (Phase 3); Phase 0 runs a
    // single provider turn per drain.
    const session = this.deps.store.sessions.get(sessionId);
    if (!session) return;
    const { provider, model } = this.deps.providers.resolveModel(this.deps.defaultModel());
    const history = this.deps.store.messages.history(sessionId);
    const stream = await provider.stream({
      model,
      messages: history.map((m) => ({
        role: m.role,
        content: m.parts
          .map((p) => (typeof (p.payload as { text?: unknown })?.text === "string" ? (p.payload as { text: string }).text : ""))
          .join(""),
      })),
    });

    const assistant = this.deps.store.messages.append(sessionId, "assistant", this.deps.clock.iso());
    this.emitDurable(sessionId, "message.created", { messageId: assistant.id, role: "assistant" });

    let ord = 0;
    let textPartId: PartId | null = null;
    let textBuffer = "";
    try {
      for await (const evt of stream) {
        if (signal.aborted) break;
        if (evt.type === "text_delta") {
          if (textPartId === null) {
            const part = this.deps.store.parts.append(assistant.id, ord++, "text", { text: "" });
            textPartId = part.id;
            textBuffer = "";
          }
          textBuffer += evt.delta;
          this.deps.store.parts.updatePayload(textPartId, { text: textBuffer });
          this.emitDurable(sessionId, "message.part.delta", {
            messageId: assistant.id,
            partId: textPartId,
            delta: evt.delta,
          });
        } else if (evt.type === "done") {
          break;
        }
        // tool_call_delta / usage handled from Phase 1/3 onward
      }
    } finally {
      await stream.close();
    }
  }

  private emitDurable(sessionId: SessionId, type: EventType, payload: unknown): void {
    const evt = this.deps.log.append(sessionId, type, payload, this.deps.clock.iso());
    this.deps.bus.publish(evt);
  }
}

export type { PromptPayload };
