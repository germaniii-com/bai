import type { OAuthLoginStatus, OAuthMethod } from "@bai/shared";

/**
 * Result of a completed login/import/refresh. `expiresAt` is epoch ms;
 * `baseUrl` lets a flow (Vertex) publish a computed endpoint that the account
 * record stores.
 */
export interface OAuthTokens {
  access: string;
  refresh?: string;
  expiresAt?: number;
  /** Upstream identity (Codex account id, Claude profile, Copilot login, …). */
  accountId?: string;
  idToken?: string;
  baseUrl?: string;
}

/** Progress update a flow pushes into its login session. */
export interface OAuthProgress {
  status?: OAuthLoginStatus;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  authorizeUrl?: string;
  instructions?: string;
  expiresAt?: number;
  error?: string;
}

/** Everything a flow needs to run. */
export interface OAuthFlowContext {
  /** Account id the manager will persist on success. */
  accountId: string;
  /** Default display label. */
  label: string;
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
  now(): number;
  /** Report progress (device codes, authorize URLs, status). */
  progress(update: OAuthProgress): void;
  /**
   * Paste-code flows: resolves with the user-submitted `code#state` string,
   * rejects if the session is cancelled.
   */
  waitForCode(): Promise<string>;
  sleep(ms: number): Promise<void>;
}

/** Context for refreshing an existing account. */
export interface OAuthRefreshContext {
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
  now(): number;
}

/** Per-provider login/refresh/import implementation. */
export interface OAuthFlowSpec {
  /** Provider id (matches the catalog/overlay id). */
  id: string;
  /** Display name. */
  name: string;
  method: OAuthMethod;
  /** UI hint (e.g. "imports ~/.qwen/oauth_creds.json"). */
  hint?: string;
  /** Default account id written on success. */
  accountId?: string;
  /**
   * Run to completion. Device-code flows report the user code then poll;
   * paste-code flows report the authorize URL then await `waitForCode()`;
   * import/adc flows resolve immediately; redirect flows open a loopback
   * callback server and return the authorize URL.
   */
  run(ctx: OAuthFlowContext): Promise<OAuthTokens>;
  /**
   * Loopback redirect variant (RFC 8252). Present only for providers whose
   * registered redirect URI uses localhost; the client opens the reported
   * `authorizeUrl` and the callback completes the login. Falls back to `run`
   * when absent or when the surface requests device mode.
   */
  redirect?(ctx: OAuthFlowContext): Promise<OAuthTokens>;
  /** Renew an expired access token. */
  refresh?(tokens: { access: string; refresh?: string; idToken?: string }, ctx: OAuthRefreshContext): Promise<OAuthTokens>;
  /** Import from an external CLI/store without user interaction. */
  import?(): Promise<OAuthTokens | undefined>;
}

/** Internal session state (never crosses the wire — includes run promise). */
export interface OAuthLoginSessionInternal {
  id: string;
  provider: string;
  method: OAuthMethod;
  status: OAuthLoginStatus;
  accountId: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  authorizeUrl?: string;
  instructions?: string;
  error?: string;
  createdAt: string;
  expiresAt?: number;
  /** Resolves when the user submits a paste-code. */
  codeResolver?: (code: string) => void;
  codeRejecter?: (err: Error) => void;
  cancelled: boolean;
  /** Wakes `start()` when the flow becomes actionable or finishes. */
  ready?: () => void;
}
