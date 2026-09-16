import type { Booted } from "../boot";
import { serve, shutdown, waitForever, writeServerState } from "./web";

/**
 * `bai --router` — the headless router listener: OpenAI-compatible `/v1/*`
 * plus `/api/help`. No web UI. It reuses the ONE core booted in this process
 * (combined with `--web`/`--host` when those flags are also present).
 */
export async function runRouter(booted: Booted): Promise<void> {
  const { server, url } = serve(booted, "127.0.0.1");
  writeServerState(url, booted);
  console.log(`bai router: ${url}`);
  console.log(`help: ${url}/api/help`);
  await waitForever();
  await shutdown(booted, server);
}
