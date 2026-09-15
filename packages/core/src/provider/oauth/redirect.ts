import type { OAuthProgress, OAuthTokens } from "./types";
import { pkcePair, randomState } from "./pkce";

/**
 * Loopback redirect login (RFC 8252): bai binds a local callback server, the
 * user authenticates in their browser, and the provider redirects back to
 * `http://localhost:<port><path>` with an authorization code. The code is
 * exchanged server-side with PKCE.
 *
 * Only usable from a client on the same machine as the bai server — remote
 * surfaces use the device-code/paste-code fallbacks instead.
 */
export interface RedirectFlowOptions {
  /** Provider-registered loopback port (0 = ephemeral). Some providers require an exact port. */
  port?: number;
  /** Callback path (default "/callback"). */
  path?: string;
  /** Host used in the redirect URI (default "localhost"). */
  host?: string;
  /** Abort after this long waiting for the callback (default 5 min). */
  timeoutMs?: number;
  /** Build the provider authorize URL for the given redirect URI + PKCE/state. */
  authorizeUrl(redirectUri: string, pkce: { verifier: string; challenge: string; state: string }): string;
  /** Exchange the callback code for tokens. */
  exchange(code: string, ctx: { redirectUri: string; verifier: string; state: string }): Promise<OAuthTokens>;
  signal: AbortSignal;
  now(): number;
  progress(update: OAuthProgress): void;
}

export async function runRedirectFlow(opts: RedirectFlowOptions): Promise<OAuthTokens> {
  const path = opts.path ?? "/callback";
  const host = opts.host ?? "localhost";
  const pkce = pkcePair();
  const state = randomState();

  let settle!: (value: { code: string; state: string }) => void;
  let fail!: (err: Error) => void;
  const callback = new Promise<{ code: string; state: string }>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== path) return new Response("Not found", { status: 404 });
      const error = url.searchParams.get("error");
      if (error !== null && error.length > 0) {
        fail(new Error(url.searchParams.get("error_description") ?? error));
        return callbackPage("Login failed — you can close this tab.", 400);
      }
      const code = url.searchParams.get("code");
      if (code === null || code.length === 0) {
        fail(new Error("OAuth callback did not include a code"));
        return callbackPage("Login failed — you can close this tab.", 400);
      }
      settle({ code, state: url.searchParams.get("state") ?? "" });
      return callbackPage("Signed in to bai — you can close this tab.");
    },
  });

  const redirectUri = `http://${host}:${server.port}${path}`;
  try {
    opts.progress({
      status: "pending",
      authorizeUrl: opts.authorizeUrl(redirectUri, { ...pkce, state }),
      instructions: "Complete the sign-in in the browser tab that just opened.",
    });
    const result = await withTimeoutAndAbort(callback, opts.timeoutMs ?? 5 * 60 * 1000, opts.signal);
    if (result.state !== state) throw new Error("OAuth state mismatch — request aborted");
    return await opts.exchange(result.code, { redirectUri, verifier: pkce.verifier, state });
  } finally {
    // Let the callback response flush before closing the listener — an
    // immediate forced stop resets the browser connection mid-response. This
    // also closes the server deterministically (no lingering listener).
    await new Promise((resolve) => setTimeout(resolve, 200));
    server.stop(true);
  }
}

function callbackPage(message: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>bai</title>` +
      `<body style="font-family:Inter,system-ui,sans-serif;padding:2.5rem;color:#111">${message}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function withTimeoutAndAbort<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OAuth login timed out")), ms);
    const onAbort = (): void => reject(new Error("login cancelled"));
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    if (signal.aborted) {
      done(() => reject(new Error("login cancelled")));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => done(() => resolve(value)),
      (err) => done(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
}
