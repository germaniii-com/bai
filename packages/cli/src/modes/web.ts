import { writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { shellAuthorized, shellWebSocketHandlers, type ShellSocketData } from "@bai/api";
import type { Booted } from "../boot";
import { serverStatePath } from "../paths";

const PREFERRED_PORT = 9640;

/**
 * Bun's default idleTimeout (10s) is shorter than the SSE heartbeat (15s), so
 * idle event streams get their socket reaped mid-stream. Keep the server-side
 * ceiling comfortably above the heartbeat; dead peers still get reaped.
 */
const IDLE_TIMEOUT_SECONDS = 60;

export interface ServeResult {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  port: number;
}

/**
 * The fetch wrapper: intercepts the shell WebSocket upgrade before Hono —
 * Bun's `server.upgrade()` is only reachable here (Hono's fetch handler has
 * no server reference). Everything else rides the normal app fetch.
 */
function shellAwareFetch(
  booted: Booted,
): (req: Request, server: ReturnType<typeof Bun.serve>) => Response | Promise<Response> {
  return (req, server) => {
    const path = new URL(req.url).pathname;
    if (path === "/api/shell/ws") {
      if (!shellAuthorized(req, { token: booted.token, loopbackBind: booted.loopbackBind })) {
        return new Response("unauthorized", { status: 401 });
      }
      if (!server.upgrade(req, { data: { session: null } satisfies ShellSocketData })) {
        return new Response("websocket upgrade failed", { status: 400 });
      }
      return undefined as unknown as Response; // upgraded — Bun ignores this
    }
    return booted.app.fetch(req, server);
  };
}

/** Serve the app: preferred port (config/--port, default 9640), else ephemeral. */
export function serve(booted: Booted, hostname: string): ServeResult {
  const preferred = booted.config.server.port ?? PREFERRED_PORT;
  const websocket = shellWebSocketHandlers();
  try {
    const server = Bun.serve({ port: preferred, hostname, idleTimeout: IDLE_TIMEOUT_SECONDS, fetch: shellAwareFetch(booted), websocket });
    return { server, url: `http://${displayHost(hostname)}:${server.port ?? preferred}`, port: server.port ?? preferred };
  } catch {
    const server = Bun.serve({ port: 0, hostname, idleTimeout: IDLE_TIMEOUT_SECONDS, fetch: shellAwareFetch(booted), websocket });
    // Bun always assigns a real port for TCP listeners (typed optional for Unix sockets).
    const port = server.port ?? 0;
    return { server, url: `http://${displayHost(hostname)}:${port}`, port };
  }
}

function displayHost(hostname: string): string {
  return hostname === "0.0.0.0" ? lanAddress() : "127.0.0.1";
}

function lanAddress(): string {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const iface of interfaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

/** `bai --web` — loopback server + browser URL. */
export async function runWeb(booted: Booted, opts: { open: boolean }): Promise<void> {
  const { server, url } = serve(booted, "127.0.0.1");
  writeServerState(url, booted);
  console.log(`bai web: ${url}`);
  if (opts.open) openBrowser(url);
  await waitForever();
  await shutdown(booted, server);
}

/** `bai --host` — bind beyond loopback; print URL (+ token) for pairing. */
export async function runHost(booted: Booted): Promise<void> {
  const { server, url } = serve(booted, "0.0.0.0");
  writeServerState(url, booted);
  console.log(`bai host: ${url}`);
  if (booted.token !== undefined) {
    console.log(`pairing token: ${booted.token}`);
    console.log(`(QR pairing arrives in Phase 2 — pass this token as a bearer header)`);
  }
  await waitForever();
  await shutdown(booted, server);
}

export async function shutdown(booted: Booted, server: ReturnType<typeof Bun.serve>): Promise<void> {
  // Drain in-flight requests, but guard against the known Bun hang on
  // server-initiated closes (oven-sh/bun#36223).
  await Promise.race([server.stop(), new Promise((r) => setTimeout(r, 2000))]);
  await booted.stop();
}

function writeServerState(url: string, booted: Booted): void {
  try {
    writeFileSync(
      serverStatePath(),
      `${JSON.stringify(
        {
          url,
          pid: process.pid,
          ...(booted.token !== undefined ? { token: booted.token } : {}),
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    // state file is best-effort
  }
}

function openBrowser(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    console.log(`(could not launch a browser — open ${url} manually)`);
  }
}

function waitForever(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
