import type { Service, Store } from "@bai/core";
import type { Config } from "@bai/shared";

/**
 * Everything the MCP server role needs — handed in by the composition root
 * (`@bai/cli`). Like `@bai/router`, the service is composed IN-PROCESS into
 * the one bai server and never boots its own core: a second core would
 * double-run media jobs and automations (D29).
 */
export interface McpServerDeps {
  /** Core service — the single tool/session execution path. */
  core: Service;
  /** Store — reads `mcp_events` (server-role usage analytics) + session reads. */
  store: Store;
  /** bai version, reported as the MCP server version. */
  version: string;
  /** Live config accessor (tool filter, shared-session shape, autoApprove). */
  config: () => Config;
  /** Bearer token; required for non-loopback access. */
  token?: string;
  /** True when bound to 127.0.0.1 — loopback requests bypass auth. */
  loopbackBind: boolean;
  /** Live enablement gate. Omitted → always enabled. */
  enabled?: () => boolean;
  /** Optional notice channel (skipped tools, etc.); no-op by default. */
  onNotice?: (message: string) => void;
}
