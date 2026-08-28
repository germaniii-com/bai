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
    // Per-session model/account (set via ctrl+p or the API) → global default.
    const meta = session.meta as { model?: unknown; account?: unknown };
    const modelId =
      typeof meta.model === "string" && meta.model.length > 0
        ? meta.model
        : this.deps.defaultModel();
    const { provider, providerId, model, reasoning } = await this.deps.providers.resolveModel(modelId);
    const requestedAccount = typeof meta.account === "string" && meta.account.length > 0 ? meta.account : undefined;
    const account = requestedAccount ?? (await this.deps.providers.defaultAccount(providerId));
    const credentials = await this.deps.providers.resolveCredentials(providerId, account);
    const history = this.deps.store.messages.history(sessionId);
    const stream = await provider.stream({
      model,
      messages: history.map((m) => ({
        role: m.role,
        content: m.parts
          .map((p) => (typeof (p.payload as { text?: unknown })?.text === "string" ? (p.payload as { text: string }).text : ""))
          .join(""),
      })),
      auth: {
        ...(credentials.apiKey !== undefined ? { apiKey: credentials.apiKey } : {}),
        ...(credentials.baseUrl !== undefined ? { baseUrl: credentials.baseUrl } : {}),
      },
      // Reasoning models: enable extended thinking so reasoning tokens flow.
      ...(reasoning ? { params: { thinking: { type: "enabled", budget_tokens: 2048 } } } : {}),
      signal,
    });

    const assistant = this.deps.store.messages.append(sessionId, "assistant", this.deps.clock.iso());
    this.emitDurable(sessionId, "message.created", { messageId: assistant.id, role: "assistant" });

    let ord = 0;
    let textPartId: PartId | null = null;
    let textBuffer = "";
    let thinkingPartId: PartId | null = null;
    let thinkingBuffer = "";
    try {
      for await (const evt of raceSignal(stream, signal)) {
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
        } else if (evt.type === "thinking_delta") {
          // Reasoning tokens live in their own part kind — surfaces render
          // them behind the click-to-reveal panel, never in the main reply.
          if (thinkingPartId === null) {
            const part = this.deps.store.parts.append(assistant.id, ord++, "thinking", { text: "" });
            thinkingPartId = part.id;
            thinkingBuffer = "";
            // Surfaces learn the kind before deltas arrive (mirrors user
            // parts) — otherwise they'd default the part to "text".
            this.emitDurable(sessionId, "message.part.updated", {
              messageId: assistant.id,
              partId: thinkingPartId,
              kind: "thinking",
              payload: { text: "" },
            });
          }
          thinkingBuffer += evt.delta;
          this.deps.store.parts.updatePayload(thinkingPartId, { text: thinkingBuffer });
          this.emitDurable(sessionId, "message.part.delta", {
            messageId: assistant.id,
            partId: thinkingPartId,
            delta: evt.delta,
          });
        } else if (evt.type === "done") {
          break;
        }
        // tool_call_delta / usage handled from Phase 1/3 onward
      }
    } catch (err) {
      // An interrupt cancels the in-flight request → the adapter's iterator
      // throws; that's a clean stop, not a failure. Real errors propagate.
      if (!signal.aborted) throw err;
    } finally {
      await stream.close();
    }
  }

  private emitDurable(sessionId: SessionId, type: EventType, payload: unknown): void {
    const evt = this.deps.log.append(sessionId, type, payload, this.deps.clock.iso());
    this.deps.bus.publish(evt);
  }
}

/**
 * Stop consuming the moment the run is interrupted — regardless of whether
 * the provider's HTTP layer honors the signal. Bun's fetch (as of 1.3) does
 * not cancel a streaming body after the headers arrive, so waiting for the
 * next chunk would hold the drain hostage until the provider finishes; the
 * race makes the stop instant. The abandoned `next()` settles later and its
 * value is dropped; `stream.close()` in the caller's finally releases what
 * the runtime can release (and cancels upstream on runtimes that support it).
 */
async function* raceSignal<T>(stream: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  const aborted = new Promise<"abort">((resolve) => {
    if (signal.aborted) {
      resolve("abort");
      return;
    }
    signal.addEventListener("abort", () => resolve("abort"), { once: true });
  });
  while (true) {
    const result = await Promise.race([iterator.next(), aborted]);
    if (result === "abort" || result.done) return;
    yield result.value;
  }
}

export type { PromptPayload };
