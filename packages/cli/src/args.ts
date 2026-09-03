import { parseArgs } from "node:util";

export type CliMode = "tui" | "web" | "host" | "oneshot";

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
  bai --one-shot "prompt"  headless run; NDJSON (or --format text) on stdout

Shared flags:
  --port <n>        preferred port (default 9640, else ephemeral)
  --token <t>       bearer token (required for non-loopback access)
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
      version: false,
      help: true,
    };
  }

  const modes: CliMode[] = [];
  if (values.web === true) modes.push("web");
  if (values.host === true) modes.push("host");
  if (values["one-shot"] !== undefined) modes.push("oneshot");
  if (modes.length > 1) {
    throw new UsageError(`mode flags are mutually exclusive: ${modes.join(", ")}`);
  }
  const mode = modes[0] ?? "tui";

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
  if (mode !== "oneshot" && positionals.length > 0) {
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
    version: false,
    help: false,
  };
}
