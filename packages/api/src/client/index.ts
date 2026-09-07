import { hc } from "hono/client";
import type {
  AgentInfo,
  Config,
  ConfigPatch,
  CreateSessionBody,
  CustomTheme,
  CustomThemeInput,
  EnqueueJobBody,
   Event,
   Input,
   Job,
  Message,
  PermissionRequest,
  PutAgentBody,
  QuestionRequest,
  Session,
  ToolListEntry,
} from "@bai/shared";
import type { PutAccountBody, ProviderListResponse, SetSessionModelBody, UsageAnalyticsQuery, UsageAnalyticsResponse } from "@bai/shared";
import type { ApiType } from "../server/app";
import { eventStream } from "./sse";
import { EventMux, eventMux } from "./mux";

export { EventMux, eventMux };

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

  async listSessions(
    limit = 50,
    offset = 0,
    filters: { workbench?: string; cwd?: string } = {},
  ): Promise<Session[]> {
    const res = await this.rpc().session.$get({
      query: {
        limit: String(limit),
        offset: String(offset),
        ...(filters.workbench !== undefined ? { workbench: filters.workbench } : {}),
        ...(filters.cwd !== undefined ? { cwd: filters.cwd } : {}),
      },
    });
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
   * `runActive` reports a run already in flight at snapshot time;
   * `pendingPermissions` carries asks raised before this surface connected;
   * `pendingInputs` seeds the queued-message list (admitted, not yet
   * promoted).
   */
  async historySnapshot(
    id: string,
  ): Promise<{
    messages: Message[];
    afterSeq: number;
    runActive: boolean;
    pendingPermissions: PermissionRequest[];
    pendingQuestions: QuestionRequest[];
    pendingInputs: Input[];
  }> {
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

  /**
   * Send-now on a pending queued input: flips it to steer semantics — it
   * promotes at the next safe boundary (immediately when idle, mid-run at
   * the next provider-turn boundary otherwise).
   */
  async sendInputNow(id: string, inputId: string): Promise<void> {
    const res = await this.rpc().session[":id"].input[":inputId"].send.$post({
      param: { id: encodeURIComponent(id), inputId: encodeURIComponent(inputId) },
    });
    if (!res.ok) throw new Error(`input send failed: ${res.status}`);
  }

  /** Cancel a pending input (queued or steering) — it never runs. */
  async cancelInput(id: string, inputId: string): Promise<void> {
    const res = await this.rpc().session[":id"].input[":inputId"].cancel.$post({
      param: { id: encodeURIComponent(id), inputId: encodeURIComponent(inputId) },
    });
    if (!res.ok) throw new Error(`input cancel failed: ${res.status}`);
  }

  async interrupt(id: string): Promise<void> {
    const res = await this.rpc().session[":id"].interrupt.$post({ param: { id: encodeURIComponent(id) } });
    if (!res.ok) throw new Error(`interrupt failed: ${res.status}`);
  }

  async replyPermission(
    id: string,
    body: { status: "approved" | "rejected"; scope?: "once" | "always"; message?: string },
  ): Promise<void> {
    const res = await this.rpc().permission[":id"].reply.$post({
      param: { id: encodeURIComponent(id) },
      json: body,
    });
    if (!res.ok) throw new Error(`permission reply failed: ${res.status}`);
  }

  /**
   * Every pending ask across ALL sessions — the global indicator seed
   * (TUI sessions list, web nav badge). Re-seed on connect/reconnect:
   * the firehose is live-only, so events missed during drops heal here.
   */
  async pendingAsks(): Promise<{ pendingPermissions: PermissionRequest[]; pendingQuestions: QuestionRequest[] }> {
    const res = await this.rpc().permission.$get();
    if (!res.ok) throw new Error(`pending asks failed: ${res.status}`);
    return res.json();
  }

  /** Answer a pending question block (one label-array per question, in order). */
  async replyQuestion(id: string, answers: string[][]): Promise<void> {
    const res = await this.rpc().question[":id"].reply.$post({
      param: { id: encodeURIComponent(id) },
      json: { answers },
    });
    if (!res.ok) throw new Error(`question reply failed: ${res.status}`);
  }

  /** Dismiss a pending question block; the optional message is context for the model. */
  async rejectQuestion(id: string, message?: string): Promise<void> {
    const res = await this.rpc().question[":id"].reject.$post({
      param: { id: encodeURIComponent(id) },
      json: { ...(message !== undefined ? { message } : {}) },
    });
    if (!res.ok) throw new Error(`question reject failed: ${res.status}`);
  }

  async getConfig(): Promise<Config> {
    const res = await this.rpc().config.$get();
    if (!res.ok) throw new Error(`get config failed: ${res.status}`);
    return (await res.json()).config;
  }

  /**
   * List one directory inside `root` (read-only; powers the file tree).
   * `root` must be a registered workspace. Throws with the server's plain
   * message on failures ("path not found", "permission denied", …).
   */
  async listDir(
    root: string,
    path?: string,
  ): Promise<{ path: string; root: string; entries: { name: string; type: "dir" | "file" }[]; truncated: boolean }> {
    const res = await this.rpc().fs.$get({
      query: { root, ...(path !== undefined ? { path } : {}) },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `list directory failed: ${res.status}`);
    }
    return (await res.json()).listing;
  }

  /**
   * Fetch ONE file's raw bytes from a registered workspace (read-only
   * preview; powers the file viewer). Text consumers read the body as
   * text; media consumers wrap it in a blob URL. The mime is sanitized
   * server-side (never text/html or text/javascript). Throws with the
   * server's plain message on failures ("path not found", "file too
   * large", …).
   */
  async readFile(root: string, path?: string): Promise<Response> {
    const res = await this.rpc().fs.file.$get({
      query: { root, ...(path !== undefined ? { path } : {}) },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `read file failed: ${res.status}`);
    }
    // The runtime object is a real fetch Response; Hono's typed wrapper
    // just isn't structurally assignable to it.
    return res as unknown as Response;
  }

  /**
   * Validate a single candidate workspace path: exists, is a directory, and
   * is readable by the server's user. Throws with the server's message.
   */
  async statPath(path: string): Promise<{ path: string; type: "dir" | "file" | "other" }> {
    const res = await this.rpc().fs.stat.$get({ query: { path } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `stat path failed: ${res.status}`);
    }
    return (await res.json()).stat;
  }

  /**
   * Create a missing folder (and missing parents) as a workspace target.
   * The server only allows creation inside the user's home directory and
   * answers with plain messages ("permission denied", "folder creation is
   * only allowed inside your home directory", …). Returns the resolved path.
   */
  async createFolder(path: string): Promise<{ path: string; type: "dir" | "file" | "other" }> {
    const res = await this.rpc().fs.mkdir.$post({ json: { path } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `create folder failed: ${res.status}`);
    }
    return (await res.json()).stat;
  }

  /**
   * Complete one folder-path segment against its parent (directories only).
   * Powers the two-column explorer in the add-workspace modal; `dotfiles`
   * includes hidden (dot) directories — the explorer's show-dotfiles toggle.
   */
  async completePath(
    path: string,
    opts: { dotfiles?: boolean } = {},
  ): Promise<{ base: string; prefix: string; entries: string[]; truncated: boolean }> {
    const res = await this.rpc().fs.complete.$get({
      query: { path, ...(opts.dotfiles === true ? { dotfiles: "1" } : {}) },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `complete path failed: ${res.status}`);
    }
    return (await res.json()).completion;
  }

  async putConfig(patch: ConfigPatch): Promise<Config> {
    const res = await this.rpc().config.$put({ json: patch });
    if (!res.ok) throw new Error(`put config failed: ${res.status}`);
    return (await res.json()).config;
  }

  // --- custom themes (~/.config/bai/themes/*.json) ---

  async listCustomThemes(): Promise<CustomTheme[]> {
    const res = await this.rpc().theme.custom.$get();
    if (!res.ok) throw new Error(`list custom themes failed: ${res.status}`);
    return (await res.json()).themes;
  }

  /** Create or replace a custom theme file (id = filename stem). */
  async putCustomTheme(id: string, body: CustomThemeInput): Promise<CustomTheme> {
    const res = await this.rpc().theme.custom[":id"].$put({
      param: { id: encodeURIComponent(id) },
      json: body,
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(errBody?.error ?? `put custom theme failed: ${res.status}`);
    }
    return (await res.json()).theme;
  }

  async deleteCustomTheme(id: string): Promise<void> {
    const res = await this.rpc().theme.custom[":id"].$delete({ param: { id: encodeURIComponent(id) } });
    if (!res.ok) throw new Error(`delete custom theme failed: ${res.status}`);
  }

  // --- agents ---

  async listAgents(): Promise<AgentInfo[]> {
    const res = await this.rpc().agent.$get();
    if (!res.ok) throw new Error(`list agents failed: ${res.status}`);
    return (await res.json()).agents;
  }

  async getAgent(name: string): Promise<AgentInfo | undefined> {
    const res = await this.rpc().agent[":name"].$get({ param: { name: encodeURIComponent(name) } });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`get agent failed: ${res.status}`);
    return (await res.json()).agent;
  }

  /** Create or replace an agent (server writes the markdown file; hot-reload does the rest). */
  async putAgent(name: string, body: PutAgentBody): Promise<AgentInfo> {
    const res = await this.rpc().agent[":name"].$put({
      param: { name: encodeURIComponent(name) },
      json: body,
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(errBody?.error ?? `put agent failed: ${res.status}`);
    }
    return (await res.json()).agent;
  }

  async deleteAgent(name: string): Promise<boolean> {
    const res = await this.rpc().agent[":name"].$delete({ param: { name: encodeURIComponent(name) } });
    if (res.status === 404) return false;
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(errBody?.error ?? `delete agent failed: ${res.status}`);
    }
    return true;
  }

  // --- tools ---

  async listTools(): Promise<ToolListEntry[]> {
    const res = await this.rpc().tool.$get();
    if (!res.ok) throw new Error(`list tools failed: ${res.status}`);
    return (await res.json()).tools;
  }

  /** Current source of a custom tool file (404 for built-ins). */
  async getToolCode(name: string): Promise<string> {
    const res = await this.rpc().tool[":name"].$get({ param: { name: encodeURIComponent(name) } });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(errBody?.error ?? `get tool failed: ${res.status}`);
    }
    return (await res.json()).code;
  }

  /** Create or replace a custom tool file (hot-registers on save). */
  async putTool(name: string, code: string): Promise<{ name: string; registered: boolean }> {
    const res = await this.rpc().tool[":name"].$put({
      param: { name: encodeURIComponent(name) },
      json: { code },
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(errBody?.error ?? `put tool failed: ${res.status}`);
    }
    return (await res.json());
  }

  async deleteTool(name: string): Promise<boolean> {
    const res = await this.rpc().tool[":name"].$delete({ param: { name: encodeURIComponent(name) } });
    if (res.status === 404) return false;
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(errBody?.error ?? `delete tool failed: ${res.status}`);
    }
    return true;
  }

  async providers(): Promise<ProviderListResponse> {
    const res = await this.rpc().provider.$get();
    if (!res.ok) throw new Error(`providers failed: ${res.status}`);
    return res.json();
  }

  /** Usage analytics aggregation (D26) — KPIs, per-model totals, chart series. */
  async usageAnalytics(query: UsageAnalyticsQuery = {}): Promise<UsageAnalyticsResponse> {
    const res = await this.rpc().usage.analytics.$get({ query });
    if (!res.ok) throw new Error(`usage analytics failed: ${res.status}`);
    return res.json();
  }

  /** Upsert one provider account (API key lives server-side; never echoed). */
  async putAccount(provider: string, account: string, body: PutAccountBody): Promise<void> {
    const res = await this.rpc().provider[":provider"].account[":account"].$put({
      param: { provider: encodeURIComponent(provider), account: encodeURIComponent(account) },
      json: body,
    });
    if (!res.ok) throw new Error(`put account failed: ${res.status}`);
  }

  async deleteAccount(provider: string, account: string): Promise<void> {
    const res = await this.rpc().provider[":provider"].account[":account"].$delete({
      param: { provider: encodeURIComponent(provider), account: encodeURIComponent(account) },
    });
    if (!res.ok) throw new Error(`delete account failed: ${res.status}`);
  }

  /** Set the per-session model (and optionally account) — applies next prompt. */
  async setSessionModel(id: string, body: SetSessionModelBody): Promise<void> {
    const res = await this.rpc().session[":id"].model.$put({
      param: { id: encodeURIComponent(id) },
      json: body,
    });
    if (!res.ok) throw new Error(`set session model failed: ${res.status}`);
  }

  /** Select (or clear) the session's agent — applies next prompt. */
  async setSessionAgent(id: string, body: { agent?: string; clear?: boolean }): Promise<void> {
    const res = await this.rpc().session[":id"].agent.$put({
      param: { id: encodeURIComponent(id) },
      json: body,
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(errBody?.error ?? `set session agent failed: ${res.status}`);
    }
  }

  /** Rename a session (manual rename; auto-titles arrive via session.updated). */
  async renameSession(id: string, title: string): Promise<Session> {
    const res = await this.rpc().session[":id"].title.$put({
      param: { id: encodeURIComponent(id) },
      json: { title },
    });
    if (!res.ok) throw new Error(`rename session failed: ${res.status}`);
    return (await res.json()).session;
  }

  /**
   * Revert to a user message: it and everything after it are hidden (and
   * hard-deleted at the next prompt) and file changes after it are rolled
   * back. Returns the session carrying `meta.revert` (the boundary).
   */
  async revertSession(id: string, messageId: string): Promise<Session> {
    const res = await this.rpc().session[":id"].revert.$post({
      param: { id: encodeURIComponent(id) },
      json: { messageId },
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(errBody?.error ?? `revert session failed: ${res.status}`);
    }
    return (await res.json()).session;
  }

  /** Undo a revert: restore the snapshot and bring the hidden messages back. */
  async unrevertSession(id: string): Promise<Session> {
    const res = await this.rpc().session[":id"].unrevert.$post({
      param: { id: encodeURIComponent(id) },
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(errBody?.error ?? `unrevert session failed: ${res.status}`);
    }
    return (await res.json()).session;
  }

  /**
   * Fork at a message: a new session with everything BEFORE it (all messages
   * when omitted); surfaces seed the composer with the message's text.
   */
  async forkSession(id: string, messageId?: string): Promise<Session> {
    const res = await this.rpc().session[":id"].fork.$post({
      param: { id: encodeURIComponent(id) },
      json: messageId !== undefined ? { messageId } : {},
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(errBody?.error ?? `fork session failed: ${res.status}`);
    }
    return (await res.json()).session;
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

/**
 * Follow the global firehose with reconnect-on-drop (best-effort stream).
 * Returns when the signal aborts. Live-only events (config.updated,
 * provider.updated, server.hello) can be missed during drops — surfaces
 * should refresh their snapshot on reconnect.
 */
export async function followGlobal(
  client: BaiClient,
  opts: {
    signal?: AbortSignal;
    onEvent: (evt: Event) => void;
    onDrop?: (err: unknown) => void;
  },
): Promise<void> {
  while (!(opts.signal?.aborted ?? false)) {
    try {
      for await (const evt of client.globalEvents({ signal: opts.signal })) {
        opts.onEvent(evt);
      }
    } catch (err) {
      if (opts.signal?.aborted ?? false) return;
      if (opts.onDrop !== undefined) opts.onDrop(err);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
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
