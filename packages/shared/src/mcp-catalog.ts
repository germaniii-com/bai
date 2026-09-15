import type { McpCatalogEntry } from "./config";

/**
 * Curated MCP catalog — remote vendor-hosted servers, mirrored from
 * hermes-agent's `optional-mcps/` manifests (which track the vendor-published
 * remote MCP URLs). Installing one writes `~/.config/bai/mcp/<name>.json` (a
 * drop-in file) and, for OAuth entries, starts the authorization flow.
 *
 * Categories drive the Integrations pane grouping; entry order here is the
 * group order in the UI.
 */

/** A remote streamable-HTTP server (SSE fallback is automatic). */
function httpEntry(
  name: string,
  title: string,
  category: string,
  description: string,
  url: string,
  extra: Partial<McpCatalogEntry> = {},
): McpCatalogEntry {
  return { name, title, category, description, server: { transport: "http", url }, ...extra };
}

/** A remote OAuth server over streamable HTTP. */
function oauthEntry(
  name: string,
  title: string,
  category: string,
  description: string,
  url: string,
  extra: Partial<McpCatalogEntry> = {},
): McpCatalogEntry {
  return {
    name,
    title,
    category,
    description,
    server: { transport: "http", url, oauth: true },
    oauth: true,
    ...extra,
  };
}

/** A remote OAuth server whose only endpoint is legacy SSE. */
function sseEntry(name: string, title: string, category: string, description: string, url: string): McpCatalogEntry {
  return {
    name,
    title,
    category,
    description,
    server: { transport: "sse", url, oauth: true },
    oauth: true,
  };
}

const DOCS = "Docs & knowledge";
const DEV = "Developer tools";
const PRODUCTIVITY = "Productivity";
const COMMS = "Communications & CRM";
const ANALYTICS = "Analytics & data";
const FINANCE = "Payments & finance";
const MEDIA = "Media & creative";
const TRAVEL = "Travel & fitness";
const JOBS = "Jobs";

export const MCP_CATALOG: McpCatalogEntry[] = [
  // --- Docs & knowledge (no auth — usable immediately) --------------------
  httpEntry("context7", "Context7", DOCS, "Up-to-date, version-specific library docs and code examples.", "https://mcp.context7.com/mcp", {
    envVars: [
      {
        name: "CONTEXT7_API_KEY",
        prompt: "Optional Context7 API key (higher rate limits; keyless works without it)",
        url: "https://context7.com",
        secret: true,
      },
    ],
  }),
  httpEntry("deepwiki", "DeepWiki", DOCS, "Ask questions about any public GitHub repository.", "https://mcp.deepwiki.com/mcp"),
  httpEntry("microsoft-learn", "Microsoft Learn", DOCS, "Official Microsoft, Azure, and .NET docs and samples.", "https://learn.microsoft.com/api/mcp"),
  httpEntry("twilio-docs", "Twilio Docs", DOCS, "Twilio developer docs search (read-only).", "https://mcp.twilio.com/docs"),
  httpEntry("wolfram", "Wolfram|Alpha", DOCS, "Computation, math, and curated knowledge from Wolfram|Alpha.", "https://agenttools.wolfram.com/mcp"),
  httpEntry("aws-knowledge", "AWS Knowledge", DOCS, "Authoritative AWS docs, API references, and best practices.", "https://knowledge-mcp.global.api.aws"),

  // --- Developer tools ----------------------------------------------------
  oauthEntry("cloudflare", "Cloudflare", DEV, "Full Cloudflare API access (very large tool surface).", "https://mcp.cloudflare.com/mcp?codemode=false", {
    envVars: [
      {
        name: "CLOUDFLARE_API_TOKEN",
        prompt: "Optional Cloudflare API token (alternative to OAuth)",
        url: "https://dash.cloudflare.com/profile/api-tokens",
        secret: true,
      },
    ],
  }),
  oauthEntry("vercel", "Vercel", DEV, "Deployments, logs, and projects.", "https://mcp.vercel.com"),
  oauthEntry("netlify", "Netlify", DEV, "Sites, deploys, and environment variables.", "https://netlify-mcp.netlify.app/mcp"),
  oauthEntry("railway", "Railway", DEV, "Projects, services, deployments, environments.", "https://mcp.railway.com"),
  oauthEntry("supabase", "Supabase", DEV, "Database, auth, and storage from Supabase projects.", "https://mcp.supabase.com/mcp"),
  oauthEntry("neon", "Neon", DEV, "Neon serverless Postgres: projects, branches, SQL.", "https://mcp.neon.tech/mcp"),
  oauthEntry("prisma-postgres", "Prisma Postgres", DEV, "Create and manage Prisma Postgres databases.", "https://mcp.prisma.io/mcp"),
  oauthEntry("motherduck", "MotherDuck", DEV, "Query DuckDB cloud warehouses with SQL.", "https://api.motherduck.com/mcp"),
  oauthEntry("sentry", "Sentry", DEV, "Issues, stack traces, and error context.", "https://mcp.sentry.dev/mcp"),
  oauthEntry("datadog", "Datadog", DEV, "Logs, monitors, dashboards, and incidents.", "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp"),
  oauthEntry("grafana", "Grafana", DEV, "Query metrics, logs, dashboards, alerts (Grafana Cloud).", "https://mcp.grafana.com/mcp"),
  oauthEntry("gitlab", "GitLab", DEV, "Issues, merge requests, pipelines, repo context.", "https://gitlab.com/api/v4/mcp"),
  oauthEntry("globalping", "Globalping", DEV, "Ping, traceroute, DNS, and HTTP tests from global probes.", "https://mcp.globalping.dev/mcp"),
  oauthEntry("semgrep", "Semgrep", DEV, "Scan code for security vulnerabilities.", "https://mcp.semgrep.ai/mcp"),
  oauthEntry("buildkite", "Buildkite", DEV, "CI/CD pipelines, builds, and test results.", "https://mcp.buildkite.com/mcp"),
  oauthEntry("circleci", "CircleCI", DEV, "Diagnose build failures, read logs, rerun workflows.", "https://mcp.circleci.com/v1/mcp"),
  oauthEntry("postman", "Postman", DEV, "Workspaces, collections, environments, and APIs.", "https://mcp.postman.com/minimal"),
  oauthEntry("hugging_face", "Hugging Face", DEV, "Models, datasets, Spaces, and papers from the HF Hub.", "https://huggingface.co/mcp"),
  oauthEntry("betterstack", "Better Stack", DEV, "Logs, uptime monitors, incidents, and status pages.", "https://mcp.betterstack.com"),

  // --- Productivity -------------------------------------------------------
  oauthEntry("linear", "Linear", PRODUCTIVITY, "Find, create, and update issues, projects, comments.", "https://mcp.linear.app/mcp"),
  oauthEntry("notion", "Notion", PRODUCTIVITY, "Pages and databases from your workspace.", "https://mcp.notion.com/mcp"),
  oauthEntry("atlassian", "Atlassian (Jira / Confluence)", PRODUCTIVITY, "Jira issues and Confluence pages.", "https://mcp.atlassian.com/v1/mcp/authv2"),
  {
    name: "figma",
    title: "Figma",
    category: PRODUCTIVITY,
    description: "Design context, Code Connect, and write-to-canvas.",
    // Figma's Dynamic Client Registration allowlists exact client_name strings
    // ("Claude Code" / "Codex"); anything else 403s.
    server: { transport: "http", url: "https://mcp.figma.com/mcp", oauth: { clientName: "Claude Code" } },
    oauth: true,
  },
  oauthEntry("miro", "Miro", PRODUCTIVITY, "Read and edit boards, diagrams, and frames.", "https://mcp.miro.com/"),
  oauthEntry("canva", "Canva", PRODUCTIVITY, "Create, search, and manage Canva designs.", "https://mcp.canva.com/mcp"),
  oauthEntry("dropbox", "Dropbox", PRODUCTIVITY, "Search, read, and manage files in Dropbox.", "https://mcp.dropbox.com/mcp"),
  oauthEntry("todoist", "Todoist", PRODUCTIVITY, "Manage Todoist tasks and projects.", "https://ai.todoist.net/mcp"),
  oauthEntry("monday", "monday.com", PRODUCTIVITY, "Boards, items, docs, and workflows.", "https://mcp.monday.com/mcp"),
  oauthEntry("clickup", "ClickUp", PRODUCTIVITY, "Tasks, docs, and workspaces in ClickUp.", "https://mcp.clickup.com/mcp"),
  sseEntry("asana", "Asana", PRODUCTIVITY, "Tasks, projects, and goals from Asana.", "https://mcp.asana.com/sse"),
  oauthEntry("airtable", "Airtable", PRODUCTIVITY, "Bases, tables, and records from your Airtable workspace.", "https://mcp.airtable.com/mcp"),
  oauthEntry("calendly", "Calendly", PRODUCTIVITY, "Scheduling links, events, and invitees.", "https://mcp.calendly.com"),
  oauthEntry("craft", "Craft", PRODUCTIVITY, "Structured docs, tasks, and personal knowledge base.", "https://mcp.craft.do/my/mcp"),

  // --- Communications & CRM ----------------------------------------------
  oauthEntry("intercom", "Intercom", COMMS, "Conversations, tickets, and customer data.", "https://mcp.intercom.com/mcp"),
  oauthEntry("close", "Close", COMMS, "Sales CRM: leads, opportunities, calls, emails.", "https://mcp.close.com/mcp"),
  oauthEntry("attio", "Attio", COMMS, "CRM records, lists, and notes in Attio.", "https://mcp.attio.com/mcp"),
  oauthEntry("fireflies", "Fireflies", COMMS, "Meeting transcripts, summaries, and action items.", "https://api.fireflies.ai/mcp"),
  oauthEntry(
    "klaviyo",
    "Klaviyo",
    COMMS,
    "Marketing campaigns, flows, segments, and reporting.",
    "https://mcp.klaviyo.com/mcp?core-tools-only=true&disable-tools-with-user-generated-content=true",
  ),

  // --- Analytics & data ---------------------------------------------------
  oauthEntry("amplitude", "Amplitude", ANALYTICS, "Analytics: charts, dashboards, experiments, flags.", "https://mcp.amplitude.com/mcp"),
  oauthEntry("mixpanel", "Mixpanel", ANALYTICS, "Analytics: events, funnels, retention, dashboards.", "https://mcp.mixpanel.com/mcp"),
  oauthEntry("algolia", "Algolia", ANALYTICS, "Algolia search: indices, analytics, settings (read-only).", "https://mcp.algolia.com/mcp"),

  // --- Payments & finance -------------------------------------------------
  oauthEntry("stripe", "Stripe", FINANCE, "Payments, customers, and invoices.", "https://mcp.stripe.com"),
  sseEntry("square", "Square", FINANCE, "Catalog, orders, and payments.", "https://mcp.squareup.com/sse"),
  oauthEntry("plaid", "Plaid", FINANCE, "Dashboard: integrations, Items, usage debugging.", "https://api.dashboard.plaid.com/mcp/"),
  sseEntry("paypal", "PayPal", FINANCE, "Payments, invoices, and subscriptions.", "https://mcp.paypal.com/sse"),
  oauthEntry("twelve-data", "Twelve Data", FINANCE, "Stocks, forex, and crypto market data.", "https://mcp.twelvedata.com/mcp"),
  oauthEntry("robinhood", "Robinhood", FINANCE, "Agentic trading: portfolio, balances, orders.", "https://agent.robinhood.com/mcp/trading"),

  // --- Media & creative ---------------------------------------------------
  oauthEntry("cloudinary", "Cloudinary", MEDIA, "Upload, search, and transform media assets.", "https://asset-management.mcp.cloudinary.com/mcp"),
  oauthEntry("comfy-cloud", "Comfy Cloud", MEDIA, "Generate images, video, audio, and 3D on Comfy Cloud.", "https://cloud.comfy.org/mcp"),
  oauthEntry("gamma", "Gamma", MEDIA, "Generate and edit AI presentations, docs, and sites.", "https://mcp.gamma.app/mcp"),
  oauthEntry("webflow", "Webflow", MEDIA, "Sites, CMS collections, and pages.", "https://mcp.webflow.com/mcp"),
  oauthEntry("wordpress-com", "WordPress.com", MEDIA, "Posts, pages, drafts, stats, and comments.", "https://public-api.wordpress.com/wpcom/v2/mcp/v1"),

  // --- Travel & fitness ---------------------------------------------------
  httpEntry("alltrails", "AllTrails", TRAVEL, "Find hikes and trails with reviews and ratings.", "https://www.alltrails.com/mcp"),
  httpEntry("kiwi", "Kiwi.com", TRAVEL, "Flight search: itineraries with direct booking links.", "https://mcp.kiwi.com"),
  httpEntry("trivago", "trivago", TRAVEL, "Hotel search: compare prices by city and dates.", "https://mcp.trivago.com/mcp"),
  oauthEntry("strava", "Strava", TRAVEL, "Activities, fitness trends, and training load (read-only).", "https://mcp.strava.com/mcp"),

  // --- Jobs ---------------------------------------------------------------
  oauthEntry("indeed", "Indeed", JOBS, "Search jobs and listings on Indeed.", "https://mcp.indeed.com/claude/mcp"),
];

export function mcpCatalogEntry(name: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.name === name);
}

/** Categories in first-seen order (drives the Integrations pane grouping). */
export function mcpCatalogCategories(): string[] {
  const seen: string[] = [];
  for (const entry of MCP_CATALOG) {
    if (!seen.includes(entry.category)) seen.push(entry.category);
  }
  return seen;
}
