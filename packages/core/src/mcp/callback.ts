import { createServer, type Server } from "node:http";

/**
 * Loopback OAuth callback listener. Binds 127.0.0.1 on the preferred port
 * (1455) or an ephemeral one, serves `/callback`, captures the query params,
 * answers with a small success page, and closes.
 *
 * The redirect URL must be known before the OAuth client registers, so start()
 * is called first and `redirectUrl` is read from the bound port.
 */
export class McpCallbackServer {
  private server: Server | undefined;
  private pending: ((params: URLSearchParams) => void) | undefined;
  /** Bound port after start(). */
  port = 0;
  /** Redirect URL to register with the authorization server. */
  redirectUrl = "";

  async start(preferredPort = 1455): Promise<void> {
    try {
      await this.listen(preferredPort);
    } catch {
      await this.listen(0);
    }
    const address = this.server?.address();
    this.port = typeof address === "object" && address !== null ? address.port : preferredPort;
    this.redirectUrl = `http://127.0.0.1:${this.port}/callback`;
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><meta charset=utf-8><title>Authorized</title>" +
            "<body style=\"font-family:system-ui;padding:3rem\"><h1>Authorized</h1>" +
            "<p>You can close this tab and return to bai.</p></body>",
        );
        const resolvePending = this.pending;
        this.pending = undefined;
        resolvePending?.(url.searchParams);
      });
      server.on("error", reject);
      server.listen(port, "127.0.0.1", () => {
        this.server = server;
        resolve();
      });
    });
  }

  /** Resolve with the callback query params once the browser lands. */
  waitForCode(timeoutMs = 300_000): Promise<URLSearchParams> {
    return new Promise((resolve, reject) => {
      this.pending = resolve;
      const timer = setTimeout(() => {
        if (this.pending === resolve) {
          this.pending = undefined;
          reject(new Error("OAuth callback timed out"));
        }
      }, timeoutMs);
      timer.unref?.();
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.pending = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
