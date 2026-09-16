import { randomUUID } from "node:crypto";
import type { OAuthLoginSession, OAuthProviderInfo, OAuthStartMode } from "@bai/shared";
import type { AuthStore } from "../auth-store";
import type { OAuthFlowContext, OAuthFlowSpec, OAuthLoginSessionInternal, OAuthProgress, OAuthTokens } from "./types";
import { OAUTH_SPECS, oauthProviders } from "./specs";

/**
 * Server-side OAuth login sessions.
 *
 * Flows run detached; the manager exposes a small start/poll/submit/cancel
 * surface that works identically for local and remote (phone, `--host`)
 * clients — device-code and paste-code need no client-side loopback.
 */
export interface OAuthLoginManagerDeps {
  accounts: AuthStore;
  /** Override the provider spec table (tests). */
  specs?: Record<string, OAuthFlowSpec>;
  /** Fired after a login/import writes an account (registry emits provider.updated). */
  onConnected?: (providerId: string, accountId: string) => void;
  /** Test hooks. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

const SESSION_TTL_MS = 15 * 60 * 1000;

export class OAuthLoginManager {
  private sessions = new Map<string, OAuthLoginSessionInternal>();
  private aborts = new Map<string, AbortController>();
  private readonly specs: Record<string, OAuthFlowSpec>;
  private readonly accounts: AuthStore;
  private readonly onConnected: ((providerId: string, accountId: string) => void) | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(deps: OAuthLoginManagerDeps) {
    this.accounts = deps.accounts;
    this.specs = deps.specs ?? OAUTH_SPECS;
    this.onConnected = deps.onConnected;
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = deps.now ?? Date.now;
  }

  /** Providers that support a login flow, with connection state. */
  providers(): OAuthProviderInfo[] {
    return oauthProviders(this.specs, this.accounts);
  }

  /** Begin a login. Resolves once the flow is actionable or finished. */
  async start(providerId: string, opts: { account?: string; mode?: OAuthStartMode } = {}): Promise<OAuthLoginSession> {
    const spec = this.specs[providerId];
    if (spec === undefined) throw new Error(`provider "${providerId}" does not support OAuth login`);
    // Prefer the browser redirect flow when the provider supports it and the
    // surface did not ask for device mode (remote clients need device/paste).
    const useRedirect = opts.mode !== "device" && spec.redirect !== undefined;
    const accountId = normalizeAccountId(opts.account ?? spec.accountId ?? "oauth");
    const id = `oas_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const internal: OAuthLoginSessionInternal = {
      id,
      provider: providerId,
      method: useRedirect ? "redirect" : spec.method,
      status: "pending",
      accountId,
      createdAt: new Date(this.now()).toISOString(),
      cancelled: false,
    };
    this.sessions.set(id, internal);

    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    internal.ready = ready;

    const controller = new AbortController();
    this.aborts.set(id, controller);

    const ctx: OAuthFlowContext = {
      accountId,
      label: spec.name,
      fetch: this.fetchImpl,
      signal: controller.signal,
      now: this.now,
      progress: (update) => {
        applyProgress(internal, update);
        if (isActionable(update) || isTerminal(update.status)) internal.ready?.();
      },
      waitForCode: () =>
        new Promise<string>((resolve, reject) => {
          internal.codeResolver = resolve;
          internal.codeRejecter = reject;
          internal.status = "awaiting_code";
          internal.ready?.();
        }),
      sleep: (ms) => sleepAbortable(ms, controller.signal),
    };

    void runFlow(this, spec, ctx, internal, useRedirect ? spec.redirect! : spec.run);
    await readyPromise;
    return project(internal);
  }

  poll(sessionId: string): OAuthLoginSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return undefined;
    if (
      (session.status === "pending" || session.status === "awaiting_code") &&
      session.expiresAt !== undefined &&
      this.now() > session.expiresAt
    ) {
      session.status = "expired";
      session.error = session.error ?? "login session expired";
    }
    return project(session);
  }

  /** Paste-code flows: deliver the user-submitted code. */
  submit(sessionId: string, code: string): OAuthLoginSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error("unknown login session");
    if (session.status !== "awaiting_code") throw new Error("login session is not awaiting a code");
    session.status = "pending";
    session.codeResolver?.(code);
    return project(session);
  }

  cancel(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return false;
    session.cancelled = true;
    session.status = "cancelled";
    session.codeRejecter?.(new Error("cancelled"));
    this.aborts.get(sessionId)?.abort();
    session.ready?.();
    return true;
  }

  /** Remove terminal sessions past their TTL (housekeeping). */
  reap(): void {
    for (const [id, session] of this.sessions) {
      const terminal = session.status !== "pending" && session.status !== "awaiting_code";
      if (terminal && this.now() - Date.parse(session.createdAt) > SESSION_TTL_MS) {
        this.sessions.delete(id);
        this.aborts.delete(id);
      }
    }
  }

  /** Internal: called by the detached runner on success. */
  complete(sessionId: string, tokens: OAuthTokens, providerId: string, accountId: string): void {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      session.status = "approved";
      session.accountId = accountId;
      session.error = undefined;
    }
    this.accounts.setOAuth(providerId, accountId, {
      label: this.specs[providerId]?.name ?? providerId,
      access: tokens.access,
      ...(tokens.refresh !== undefined ? { refresh: tokens.refresh } : {}),
      ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
      ...(tokens.accountId !== undefined ? { accountId: tokens.accountId } : {}),
      ...(tokens.idToken !== undefined ? { idToken: tokens.idToken } : {}),
      ...(tokens.baseUrl !== undefined ? { baseUrl: tokens.baseUrl } : {}),
    });
    session?.ready?.();
    this.onConnected?.(providerId, accountId);
  }

  fail(sessionId: string, err: unknown): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.status = session.cancelled ? "cancelled" : "error";
    session.error = err instanceof Error ? err.message : String(err);
    session.ready?.();
  }
}

async function runFlow(
  manager: OAuthLoginManager,
  spec: OAuthFlowSpec,
  ctx: OAuthFlowContext,
  session: OAuthLoginSessionInternal,
  runner: (ctx: OAuthFlowContext) => Promise<OAuthTokens>,
): Promise<void> {
  try {
    const tokens = await runner(ctx);
    if (session.cancelled) return;
    manager.complete(session.id, tokens, spec.id, session.accountId);
  } catch (err) {
    if (session.cancelled) return;
    // A redirect flow whose fixed loopback port is taken falls back to the
    // provider's device/paste path rather than failing the whole login.
    if (runner !== spec.run && isBindError(err)) {
      try {
        const tokens = await spec.run(ctx);
        if (session.cancelled) return;
        manager.complete(session.id, tokens, spec.id, session.accountId);
        return;
      } catch (fallbackErr) {
        manager.fail(session.id, fallbackErr);
        return;
      }
    }
    manager.fail(session.id, err);
  }
}

/** True when a loopback listener could not bind (port already in use). */
function isBindError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /EADDRINUSE|address already in use|is port .* in use|failed to start server/i.test(message);
}

function applyProgress(session: OAuthLoginSessionInternal, update: OAuthProgress): void {
  if (update.status !== undefined) session.status = update.status;
  if (update.userCode !== undefined) session.userCode = update.userCode;
  if (update.verificationUri !== undefined) session.verificationUri = update.verificationUri;
  if (update.verificationUriComplete !== undefined) session.verificationUriComplete = update.verificationUriComplete;
  if (update.authorizeUrl !== undefined) session.authorizeUrl = update.authorizeUrl;
  if (update.instructions !== undefined) session.instructions = update.instructions;
  if (update.expiresAt !== undefined) session.expiresAt = update.expiresAt;
  if (update.error !== undefined) session.error = update.error;
}

function isActionable(update: OAuthProgress): boolean {
  return update.userCode !== undefined || update.authorizeUrl !== undefined || update.instructions !== undefined;
}

function isTerminal(status: OAuthProgress["status"]): boolean {
  return status === "approved" || status === "error" || status === "cancelled" || status === "expired";
}

function project(session: OAuthLoginSessionInternal): OAuthLoginSession {
  return {
    id: session.id,
    provider: session.provider,
    method: session.method,
    status: session.status,
    ...(session.userCode !== undefined ? { userCode: session.userCode } : {}),
    ...(session.verificationUri !== undefined ? { verificationUri: session.verificationUri } : {}),
    ...(session.verificationUriComplete !== undefined ? { verificationUriComplete: session.verificationUriComplete } : {}),
    ...(session.authorizeUrl !== undefined ? { authorizeUrl: session.authorizeUrl } : {}),
    ...(session.instructions !== undefined ? { instructions: session.instructions } : {}),
    ...(session.accountId !== undefined ? { accountId: session.accountId } : {}),
    ...(session.error !== undefined ? { error: session.error } : {}),
    createdAt: session.createdAt,
    ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}),
  };
}

export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("cancelled"));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeAccountId(id: string): string {
  return id.trim().toLowerCase();
}
