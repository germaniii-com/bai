import { readFileSync } from "node:fs";
import { runStdioBridge } from "@bai/mcp";
import type { CliArgs } from "../args";
import { serverStatePath } from "../paths";
import { VERSION } from "../version";

/** `~/.local/state/bai/server.json` — written by the web/host modes. */
interface ServerState {
  url?: string;
  token?: string;
}

interface Target {
  url: string;
  token?: string;
}

/**
 * Resolve the running bai server for the stdio bridge: explicit `--url`/env
 * first, then the discovery file. Returns a human-readable reason when there is
 * no target (the CLI prints it to stderr — stdout is the JSON-RPC channel).
 */
function resolveTarget(args: CliArgs): Target | { error: string } {
  let url = args.url ?? process.env.BAI_URL;
  let token = args.token ?? process.env.BAI_TOKEN;
  if (url === undefined || url.length === 0) {
    try {
      const state = JSON.parse(readFileSync(serverStatePath(), "utf8")) as ServerState;
      url = state.url;
      token = token ?? state.token;
    } catch {
      return {
        error: `no running bai server found (${serverStatePath()} missing). Start one with \`bai --web\` or pass --url.`,
      };
    }
  }
  if (url === undefined || url.length === 0) {
    return { error: `no server url in ${serverStatePath()}; start \`bai --web\` or pass --url.` };
  }
  const endpoint = url.endsWith("/mcp") ? url : `${url.replace(/\/$/, "")}/mcp`;
  return { url: endpoint, ...(token !== undefined && token.length > 0 ? { token } : {}) };
}

/**
 * `bai mcp` — serve a stdio MCP server that proxies to a RUNNING bai's `/mcp`.
 * Never boots the core (a second core would double-run jobs/automations, D29).
 */
export async function runMcpBridge(args: CliArgs): Promise<number> {
  const target = resolveTarget(args);
  if ("error" in target) {
    console.error(`bai mcp: ${target.error}`);
    return 1;
  }
  try {
    await runStdioBridge({
      url: target.url,
      ...(target.token !== undefined ? { token: target.token } : {}),
      version: VERSION,
    });
    return 0;
  } catch (err) {
    console.error(
      `bai mcp: could not connect to ${target.url} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}
