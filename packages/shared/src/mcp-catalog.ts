import type { McpCatalogEntry } from "./config";

/**
 * Curated MCP catalog — official vendor-hosted remote servers, all OAuth.
 * Installing one writes `~/.config/bai/mcp/<name>.json` (a drop-in file) and
 * then starts the OAuth flow.
 *
 * Endpoints mirror the vendor-published remote MCP URLs (cross-checked against
 * hermes-agent's per-vendor optional MCP manifests, which track them).
 */
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    name: "figma",
    title: "Figma",
    description: "Design context, Code Connect, and write-to-canvas via Figma's hosted MCP.",
    // Figma's Dynamic Client Registration allowlists exact client_name strings
    // ("Claude Code" / "Codex"); anything else 403s. Override via
    // `oauth.clientName` if Figma changes the allowlist.
    server: { transport: "http", url: "https://mcp.figma.com/mcp", oauth: { clientName: "Claude Code" } },
    oauth: true,
  },
  {
    name: "atlassian",
    title: "Atlassian (Jira / Confluence)",
    description: "Jira issues and Confluence pages via Atlassian's hosted remote MCP.",
    server: { transport: "http", url: "https://mcp.atlassian.com/v1/mcp/authv2", oauth: true },
    oauth: true,
  },
  {
    name: "notion",
    title: "Notion",
    description: "Pages and databases from your Notion workspace.",
    server: { transport: "http", url: "https://mcp.notion.com/mcp", oauth: true },
    oauth: true,
  },
  {
    name: "linear",
    title: "Linear",
    description: "Find, create, and update Linear issues, projects, and comments.",
    server: { transport: "http", url: "https://mcp.linear.app/mcp", oauth: true },
    oauth: true,
  },
  {
    name: "gitlab",
    title: "GitLab",
    description: "Issues, merge requests, pipelines, and repo context.",
    server: { transport: "http", url: "https://gitlab.com/api/v4/mcp", oauth: true },
    oauth: true,
  },
  {
    name: "sentry",
    title: "Sentry",
    description: "Issues, stack traces, and error context from Sentry.",
    server: { transport: "http", url: "https://mcp.sentry.dev/mcp", oauth: true },
    oauth: true,
  },
];

export function mcpCatalogEntry(name: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.name === name);
}
