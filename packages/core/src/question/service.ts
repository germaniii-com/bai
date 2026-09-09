import { newId, systemClock, type Clock, type Event, type QuestionPathAsk, type QuestionPrompt, type QuestionRequest, type SessionId } from "@bai/shared";
import type { Bus } from "../event/bus";
import type { EventLog } from "../event/log";

/**
 * The question service — the agent asks the USER mid-run (opencode's
 * Question.Service pattern, bai's PermissionGate shape):
 *
 *   ask() → durable `question.asked` event → the tool's promise blocks →
 *   a surface replies/rejects via the API → `question.replied|rejected`
 *   → the tool resolves (answers) or throws (QuestionRejectedError).
 *
 * Pending requests live in memory only (they are meaningless after a
 * restart); answered questions persist as the tool_result part. Like the
 * permission gate, first reply wins: the first reply/reject consumes the
 * pending entry and every later one is a no-op.
 */

/** Thrown into the awaiting tool when the user dismisses the questions. */
export class QuestionRejectedError extends Error {
  constructor(message?: string) {
    super(message ?? "The user dismissed this question.");
    this.name = "QuestionRejectedError";
  }
}

interface Pending {
  request: QuestionRequest;
  resolve: (answers: string[][]) => void;
  reject: (err: QuestionRejectedError) => void;
  /** Abort hookup so an interrupted run can't leak a pending question. */
  onAbort: () => void;
  signal?: AbortSignal;
}

export interface QuestionDeps {
  bus: Bus;
  log: EventLog;
  clock?: Clock;
}

export class QuestionService {
  private pending = new Map<string, Pending>();
  private readonly clock: Clock;

  constructor(private deps: QuestionDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Raise a question block and await the answers (string[][] — one row per question). */
  ask(input: { sessionId?: SessionId; questions: QuestionPrompt[]; signal?: AbortSignal }): Promise<string[][]> {
    const id = newId.questionRequest();
    const request: QuestionRequest = {
      id,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      questions: input.questions,
    };
    return this.await_(id, request, input.signal);
  }

  /**
   * Raise a path ask (one pre-filled editable field + confirm — the
   * workspace.create flow) and await the answered path. Resolves with the
   * (possibly edited) path string; rejects with QuestionRejectedError on
   * dismissal or run interrupt.
   */
  askPath(input: { sessionId?: SessionId; path: QuestionPathAsk; signal?: AbortSignal }): Promise<string> {
    const id = newId.questionRequest();
    const request: QuestionRequest = {
      id,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      path: input.path,
    };
    return this.await_(id, request, input.signal).then((answers) => {
      const answer = answers[0]?.[0];
      if (answer === undefined || answer.trim().length === 0) {
        throw new QuestionRejectedError("The path answer was empty.");
      }
      return answer;
    });
  }

  /** Shared pending machinery: register, emit asked, resolve/reject on reply/reject/abort. */
  private await_(id: string, request: QuestionRequest, signal?: AbortSignal): Promise<string[][]> {
    return new Promise<string[][]>((resolve, reject) => {
      const onAbort = () => {
        // The run was interrupted while waiting — clean up like a dismissal.
        if (this.pending.get(id) === undefined) return;
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        this.emit(request.sessionId, "question.rejected", { requestId: id });
        reject(new QuestionRejectedError("The run was interrupted while waiting for an answer."));
      };
      const entry: Pending = { request, resolve, reject, onAbort, ...(signal !== undefined ? { signal } : {}) };
      this.pending.set(id, entry);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.emit(request.sessionId, "question.asked", { request });
    });
  }

  /** Answer a pending block (first reply wins). Returns false for unknown/answered ids. */
  reply(id: string, answers: string[][]): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) return false;
    this.pending.delete(id);
    entry.signal?.removeEventListener("abort", entry.onAbort);
    this.emit(entry.request.sessionId, "question.replied", { requestId: id, answers });
    entry.resolve(answers);
    return true;
  }

  /** Dismiss a pending block; `message` is optional user context for the model. */
  reject(id: string, message?: string): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) return false;
    this.pending.delete(id);
    entry.signal?.removeEventListener("abort", entry.onAbort);
    this.emit(entry.request.sessionId, "question.rejected", { requestId: id, ...(message !== undefined && message.length > 0 ? { message } : {}) });
    entry.reject(new QuestionRejectedError(message !== undefined && message.length > 0 ? `The user dismissed this question: ${message}` : undefined));
    return true;
  }

  /** Pending requests for a session (snapshot field; usually 0 or 1). */
  pendingBySession(sessionId: SessionId): QuestionRequest[] {
    return [...this.pending.values()].map((p) => p.request).filter((r) => r.sessionId === sessionId);
  }

  /** All pending requests (any session). */
  list(): QuestionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  /**
   * Fail every pending request — shutdown / server-stop hygiene so no tool
   * promise hangs forever (opencode's finalizer pattern).
   */
  stop(): void {
    for (const entry of this.pending.values()) {
      entry.signal?.removeEventListener("abort", entry.onAbort);
      entry.reject(new QuestionRejectedError("The server is shutting down."));
    }
    this.pending.clear();
  }

  private emit(sessionId: SessionId | undefined, type: "question.asked" | "question.replied" | "question.rejected", payload: unknown): void {
    const evt = this.deps.log.append(sessionId ?? "questions", type as never, payload, this.clock.iso());
    this.deps.bus.publish(evt as Event);
  }
}
