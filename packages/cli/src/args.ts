import { parseArgs } from "node:util";

export type CliMode = "tui" | "web" | "host" | "oneshot" | "router" | "mcp";

export interface CliArgs {
  mode: CliMode;
  prompt?: string;
  port?: number;
  token?: string;
  config?: string;
  continueLast: boolean;
  sessionId?: string;
  auto: boolean;
  format: "json" | "text";
  dev: boolean;
  open: boolean;
  /** Router gateway: mount `/api/help`; combined with `--web`/`--host` in one process. */
  router: boolean;
  /** Force the MCP server role (`/mcp`) on, regardless of config. */
  mcp: boolean;
  /** `bai mcp`: target a specific running server instead of server.json. */
  url?: string;
  version: boolean;
  help: boolean;
}

export class UsageError extends Error {}

const USAGE = `bai — one runtime, every surface, every modality

Usage:
  bai                      TUI (default)
  bai --code               TUI (explicit alias)
  bai --web [--open]       serve API + web UI on loopback
  bai --host               bind beyond loopback (LAN/tailnet); prints pairing URL
  bai --router             headless OpenAI-compatible router (no web UI)
  bai --web --router       web UI + router gateway + /api/help, one process
  bai --web --mcp          web UI + bai as an MCP server at /mcp
  bai mcp                  stdio MCP bridge to a running bai (Claude Desktop etc.)
  bai --one-shot "prompt"  headless run; NDJSON (or --format text) on stdout

Shared flags:
  --port <n>        preferred port (default 9640, else ephemeral)
  --token <t>       bearer token (required for non-loopback access)
  --url <u>         mcp bridge: MCP endpoint to proxy (default: server.json)
  --config <path>   override global config file location
  --continue        continue the most recent session
  --session <id>    use a specific session
  --auto            headless: approve-once instead of fail-closed (Phase 3+)
  --format json|text  one-shot output format (default json)
  --dev             development mode
  --version, --help
`;

export function usage(): string {
  return USAGE;
}

function buildParser(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      code: { type: "boolean", default: false },
      web: { type: "boolean", default: false },
      host: { type: "boolean", default: false },
      router: { type: "boolean", default: false },
      mcp: { type: "boolean", default: false },
      url: { type: "string" },
      "one-shot": { type: "string" },
      port: { type: "string" },
      token: { type: "string" },
      config: { type: "string" },
      continue: { type: "boolean", default: false },
      session: { type: "string" },
      auto: { type: "boolean", default: false },
      format: { type: "string", default: "json" },
      dev: { type: "boolean", default: false },
      open: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
}

/** Parse + validate argv. Mode flags are mutually exclusive; bare = TUI. */
export function parseCliArgs(argv: string[]): CliArgs {
  let parsed: ReturnType<typeof buildParser>;
  try {
    parsed = buildParser(argv);
  } catch (err) {
    // parseArgs throws its own errors (e.g. missing option values) — normalize.
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;

  if (values.version === true) {
    return {
      mode: "tui",
      continueLast: false,
      auto: false,
      format: "json",
      dev: false,
      open: false,
      router: false,
      mcp: false,
      version: true,
      help: false,
    };
  }
  if (values.help === true) {
    return {
      mode: "tui",
      continueLast: false,
      auto: false,
      format: "json",
      dev: false,
      open: false,
      router: false,
      mcp: false,
      version: false,
      help: true,
    };
  }

  const router = values.router === true;
  const mcp = values.mcp === true;
  // `--router`/`--mcp` are modifiers: they can accompany --web/--host (one
  // process, one listener). `--router` alone is its own headless mode. Neither
  // can combine with --one-shot.
  if (router && values["one-shot"] !== undefined) {
    throw new UsageError("--router cannot be combined with --one-shot");
  }
  if (mcp && values["one-shot"] !== undefined) {
    throw new UsageError("--mcp cannot be combined with --one-shot");
  }
  // `bai mcp` is the stdio bridge: its own mode, never booting the core.
  const bridge = positionals[0] === "mcp";
  if (bridge && (values.web === true || values.host === true || values["one-shot"] !== undefined || router)) {
    throw new UsageError("`bai mcp` cannot be combined with mode flags");
  }
  const modes: CliMode[] = [];
  if (values.web === true) modes.push("web");
  if (values.host === true) modes.push("host");
  if (values["one-shot"] !== undefined) modes.push("oneshot");
  if (modes.length > 1) {
    throw new UsageError(`mode flags are mutually exclusive: ${modes.join(", ")}`);
  }
  const mode: CliMode = bridge ? "mcp" : (modes[0] ?? (router ? "router" : "tui"));

  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new UsageError(`invalid --port: ${String(values.port)}`);
    }
  }

  const format = values.format === "text" ? "text" : values.format === "json" ? "json" : undefined;
  if (format === undefined) {
    throw new UsageError(`invalid --format: ${String(values.format)} (expected json|text)`);
  }

  const prompt = values["one-shot"];
  if (mode === "oneshot" && (prompt === undefined || prompt.length === 0)) {
    throw new UsageError("--one-shot requires a prompt");
  }
  if (mode === "mcp" && positionals.length > 1) {
    throw new UsageError(`unexpected positional argument: ${String(positionals[1])}`);
  }
  if (mode !== "oneshot" && mode !== "mcp" && positionals.length > 0) {
    throw new UsageError(`unexpected positional argument: ${String(positionals[0])}`);
  }

  return {
    mode,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(values.token !== undefined ? { token: values.token } : {}),
    ...(values.config !== undefined ? { config: values.config } : {}),
    continueLast: values.continue === true,
    ...(values.session !== undefined ? { sessionId: values.session } : {}),
    auto: values.auto === true,
    format,
    dev: values.dev === true,
    open: values.open === true,
    router,
    mcp,
    ...(values.url !== undefined ? { url: values.url } : {}),
    version: false,
    help: false,
  };
}
