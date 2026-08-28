import { dialListener } from "@bai/api/client";
import type { Booted } from "../boot";

/** `bai` / `bai --code` — ephemeral loopback server + Ink TUI in-process. */
export async function runTui(booted: Booted): Promise<void> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: booted.app.fetch });
  // Bun always assigns a real port for TCP listeners (typed optional for Unix sockets).
  const client = dialListener(server.port ?? 0, booted.token);

  // Dynamic import: ink should not load for --web/--host/--one-shot.
  const tui = await import("@bai/tui");
  try {
    await tui.renderApp({ client, version: booted.core.version() }).waitUntilExit();
  } finally {
    await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 2000))]);
    await booted.stop();
  }
}
