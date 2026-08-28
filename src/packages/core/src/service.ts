import {
  systemClock,
  type Clock,
  type Config,
  type Event,
  type EventType,
  type Input,
  type JobKind,
  type Message,
  type PermissionRequest,
  type PermissionStatus,
  type PromptPayload,
  type Session,
  type SessionId,
  type WorkbenchName,
} from "@bai/shared";
import type { Bus } from "./event/bus";
import type { EventLog } from "./event/log";
import type { JobQueue } from "./jobs/queue";
import type { ProviderRegistry } from "./provider/registry";
import { RunCoordinator } from "./run";
import type { Store } from "./store/store";
import type { ToolRegistry } from "./tools/registry";
import type { Workbench } from "./workbench/types";

export interface ServiceDeps {
  store: Store;
  bus: Bus;
  log: EventLog;
  clock?: Clock;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  workbenches: Workbench[];
  jobs: JobQueue;
  config(): Config;
  version: string;
}

/**
 * The domain heart: sessions, runs, tools, permissions. Knows nothing about
 * terminals, browsers, or HTTP — everything is emitted through the event
 * system; surfaces are notified exclusively via events.
 */
export class Service {
  readonly coordinator: RunCoordinator;
  readonly workbenches: Workbench[];
  private readonly clock: Clock;

  constructor(private deps: ServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.workbenches = deps.workbenches;
    this.coordinator = new RunCoordinator({
      store: deps.store,
      bus: deps.bus,
      log: deps.log,
      clock: this.clock,
      providers: deps.providers,
      tools: deps.tools,
      defaultModel: () => deps.config().models.default ?? "stub/echo",
    });
    for (const wb of deps.workbenches) {
      deps.tools.registerAll(wb.tools());
    }
  }

  // --- sessions ---

  createSession(opts: { title?: string; workbench?: WorkbenchName; cwd?: string } = {}): Session {
    const workbench = opts.workbench ?? "chat";
    if (!this.deps.workbenches.some((wb) => wb.name() === workbench)) {
      throw new Error(`Unknown workbench: ${workbench}`);
    }
    const session = this.deps.store.sessions.insert({
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      workbench,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      now: this.clock.iso(),
    });
    this.emitDurable(session.id, "session.created", { session });
    return session;
  }

  listSessions(limit = 50, offset = 0): Session[] {
    return this.deps.store.sessions.list(limit, offset);
  }

  getSession(id: SessionId): Session | undefined {
    return this.deps.store.sessions.get(id);
  }

  renameSession(id: SessionId, title: string): Session | undefined {
    const session = this.deps.store.sessions.update(id, { title, now: this.clock.iso() });
    if (session) this.emitDurable(id, "session.updated", { session });
    return session;
  }

  archiveSession(id: SessionId): Session | undefined {
    const existing = this.deps.store.sessions.get(id);
    if (!existing) return undefined;
    const session = this.deps.store.sessions.update(id, {
      meta: { ...existing.meta, archived: true },
      now: this.clock.iso(),
    });
    if (session) this.emitDurable(id, "session.updated", { session });
    return session;
  }

  // --- prompts & runs ---

  /** Durable admission first (crash-safe), then wake the coordinator. */
  submitPrompt(sessionId: SessionId, payload: PromptPayload): Input {
    if (!this.deps.store.sessions.get(sessionId)) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const input = this.deps.store.inputs.admit(sessionId, payload, this.clock.iso());
    this.emitDurable(sessionId, "input.admitted", {
      inputId: input.id,
      sessionId,
      text: payload.text,
      queued: payload.queue ?? false,
    });
    this.coordinator.wake(sessionId);
    return input;
  }

  interrupt(sessionId: SessionId): void {
    this.coordinator.interrupt(sessionId);
  }
  history(sessionId: SessionId): Message[] {
    return this.deps.store.messages.history(sessionId);
  }

  /**
   * History + event-log cursor in one consistent read — the snapshot half of
   * snapshot-then-stream. Surfaces open the durable stream with afterSeq so
   * replay never duplicates what the snapshot already contains.
   */
  sessionSnapshot(sessionId: SessionId): { messages: Message[]; afterSeq: number } {
    return this.deps.store.sessionSnapshot(sessionId);
  }

  // --- permissions ---

  replyPermission(id: string, status: PermissionStatus): PermissionRequest | undefined {
    const request = this.deps.store.permissions.reply(id, status);
    if (request) {
      const evt = this.deps.log.append(
        request.sessionId ?? id,
        "permission.replied",
        { requestId: request.id, status: request.status },
        this.clock.iso(),
      );
      this.deps.bus.publish(evt);
    }
    return request;
  }

  // --- jobs ---

  enqueueJob(kind: JobKind, sessionId: SessionId | undefined, input: unknown) {
    return this.deps.jobs.enqueue(kind, sessionId, input);
  }

  // --- events ---

  /** Durable append + live publish of the same envelope. */
  emitDurable(sessionId: SessionId, type: Parameters<EventLog["append"]>[1], payload: unknown): void {
    const evt = this.deps.log.append(sessionId, type, payload, this.clock.iso());
    this.deps.bus.publish(evt);
  }

  /** Live-only broadcast (firehose), e.g. config.updated / server.hello. */
  emitLive(type: EventType, payload: unknown): void {
    this.deps.bus.publish({
      seq: 0,
      type,
      ts: this.clock.iso(),
      payload,
    } as Event);
  }

  version(): string {
    return this.deps.version;
  }
}
