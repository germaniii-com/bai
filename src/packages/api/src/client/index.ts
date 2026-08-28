import { hc } from "hono/client";
import type {
  Config,
  ConfigPatch,
  CreateSessionBody,
  EnqueueJobBody,
  Event,
  Job,
  Message,
  Session,
} from "@bai/shared";
import type { ApiType } from "../server/app";
import { eventStream } from "./sse";

export interface ClientOptions {
  baseURL: string;
  token?: string;
}

/**
 * Typed client for bai's HTTP API — the single way any surface (TUI,
 * one-shot, web, tests) talks to a server. REST calls are fully typed via
 * `hc<ApiType>` (mounted at baseURL + "/api"); SSE streams are consumed with
 * fetch + eventsource-parser (Hono's RPC client has no native SSE support).
 */
export class BaiClient {
  private readonly headers: Record<string, string>;

  constructor(readonly opts: ClientOptions) {
    this.headers = opts.token !== undefined ? { Authorization: `Bearer ${opts.token}` } : {};
  }

  private rpc() {
    return hc<ApiType>(`${this.opts.baseURL.replace(/\/$/, "")}/api`, { headers: this.headers });
  }

  private url(path: string): string {
    return `${this.opts.baseURL.replace(/\/$/, "")}${path}`;
  }

  // --- REST (typed via ApiType) ---

  async health(): Promise<{ ok: boolean; version: string }> {
    const res = await this.rpc().health.$get();
    if (!res.ok) throw new Error(`health failed: ${res.status}`);
    return res.json();
  }

  async listSessions(limit = 50, offset = 0): Promise<Session[]> {
    const res = await this.rpc().session.$get({ query: { limit: String(limit), offset: String(offset) } });
    if (!res.ok) throw new Error(`list sessions failed: ${res.status}`);
    return (await res.json()).sessions;
  }

  async createSession(body: CreateSessionBody): Promise<Session> {
    const res = await this.rpc().session.$post({ json: body });
    if (!res.ok) throw new Error(`create session failed: ${res.status}`);
    return (await res.json()).session;
  }

  async getSession(id: string): Promise<Session | undefined> {
    const res = await this.rpc().session[":id"].$get({ param: { id: encodeURIComponent(id) } });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`get session failed: ${res.status}`);
    return (await res.json()).session;
  }

  async history(id: string): Promise<Message[]> {
    const res = await this.rpc().session[":id"].message.$get({ param: { id: encodeURIComponent(id) } });
    if (!res.ok) throw new Error(`history failed: ${res.status}`);
    return (await res.json()).messages;
  }

  /**
   * Snapshot-then-stream bootstrap: full history plus the event-log cursor to
   * pass as `after` when opening the session stream (no replay duplicates).
   */
  async historySnapshot(id: string): Promise<{ messages: Message[]; afterSeq: number }> {
    const res = await this.rpc().session[":id"].message.$get({ param: { id: encodeURIComponent(id) } });
    if (!res.ok) throw new Error(`history failed: ${res.status}`);
    return res.json();
  }

  async submitPrompt(id: string, body: { text: string; queue?: boolean }): Promise<void> {
    const res = await this.rpc().session[":id"].message.$post({
      param: { id: encodeURIComponent(id) },
      json: body,
    });
    if (!res.ok) throw new Error(`submit failed: ${res.status}`);
  }

  async interrupt(id: string): Promise<void> {
    const res = await this.rpc().session[":id"].interrupt.$post({ param: { id: encodeURIComponent(id) } });
    if (!res.ok) throw new Error(`interrupt failed: ${res.status}`);
  }

  async replyPermission(
    id: string,
    body: { status: "approved" | "rejected"; scope?: "once" | "always" },
  ): Promise<void> {
    const res = await this.rpc().permission[":id"].reply.$post({
      param: { id: encodeURIComponent(id) },
      json: body,
    });
    if (!res.ok) throw new Error(`permission reply failed: ${res.status}`);
  }

  async getConfig(): Promise<Config> {
    const res = await this.rpc().config.$get();
    if (!res.ok) throw new Error(`get config failed: ${res.status}`);
    return (await res.json()).config;
  }

  async putConfig(patch: ConfigPatch): Promise<Config> {
    const res = await this.rpc().config.$put({ json: patch });
    if (!res.ok) throw new Error(`put config failed: ${res.status}`);
    return (await res.json()).config;
  }

  async providers(): Promise<{ providers: string[]; models: unknown[] }> {
    const res = await this.rpc().provider.$get();
    if (!res.ok) throw new Error(`providers failed: ${res.status}`);
    return (await res.json()) as { providers: string[]; models: unknown[] };
  }

  async enqueueJob(body: EnqueueJobBody): Promise<Job> {
    const res = await this.rpc().job.$post({ json: body });
    if (!res.ok) throw new Error(`enqueue job failed: ${res.status}`);
    return (await res.json()).job;
  }

  async getJob(id: string): Promise<Job | undefined> {
    const res = await this.rpc().job[":id"].$get({ param: { id: encodeURIComponent(id) } });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`get job failed: ${res.status}`);
    return (await res.json()).job;
  }

  // --- SSE streams ---

  /** Durable per-session stream (replay-then-live) starting after `after`. */
  sessionEvents(id: string, opts: { after?: number; signal?: AbortSignal } = {}): AsyncGenerator<Event> {
    const after = opts.after ?? 0;
    return eventStream(this.url(`/api/session/${encodeURIComponent(id)}/event?after=${after}`), {
      headers: this.headers,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }

  /** Global live firehose. */
  globalEvents(opts: { signal?: AbortSignal } = {}): AsyncGenerator<Event> {
    return eventStream(this.url("/api/event"), {
      headers: this.headers,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }
}

export function createClient(opts: ClientOptions): BaiClient {
  return new BaiClient(opts);
}

/** Local mode: dial the ephemeral loopback listener started in-process. */
export function dialListener(port: number, token?: string): BaiClient {
  return new BaiClient({ baseURL: `http://127.0.0.1:${port}`, ...(token !== undefined ? { token } : {}) });
}

/**
 * Follow a session's durable stream with cursor tracking and reconnect.
 * Returns when `until` matches an event or the signal aborts. Drops are
 * retried with backoff from the last cursor — the DB is the buffer, so no
 * gaps; `onDrop` (default: console.error) observes each reconnect.
 */
export async function followSession(
  client: BaiClient,
  id: string,
  opts: {
    from?: number;
    signal?: AbortSignal;
    onEvent: (evt: Event) => void;
    until?: (evt: Event) => boolean;
    onDrop?: (err: unknown) => void;
  },
): Promise<void> {
  let cursor = opts.from ?? 0;
  while (!(opts.signal?.aborted ?? false)) {
    try {
      for await (const evt of client.sessionEvents(id, { after: cursor, signal: opts.signal })) {
        if (evt.seq > cursor) cursor = evt.seq;
        opts.onEvent(evt);
        if (opts.until?.(evt) ?? false) return;
      }
    } catch (err) {
      if (opts.signal?.aborted ?? false) return;
      // Backoff and resume from the cursor — the DB is the buffer, no gaps.
      if (opts.onDrop !== undefined) opts.onDrop(err);
      else console.error(`[bai] session stream dropped, retrying: ${err instanceof Error ? err.message : err}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
