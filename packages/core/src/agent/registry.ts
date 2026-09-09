import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  agentFrontmatterSchema,
  BUILTIN_BUILD_AGENT,
  BUILTIN_CHAT_AGENT,
  BUILTIN_LEARN_AGENT,
  BUILTIN_PLAN_AGENT,
  isValidAgentName,
  type AgentFrontmatter,
  type AgentInfo,
  type PutAgentBody,
} from "@bai/shared";

/** Built-ins beyond `build` — always present, never file-shadowable. */
const BUILTIN_AGENTS = [BUILTIN_BUILD_AGENT, BUILTIN_CHAT_AGENT, BUILTIN_PLAN_AGENT, BUILTIN_LEARN_AGENT];

function builtinFor(name: string): AgentInfo | undefined {
  return BUILTIN_AGENTS.find((a) => a.name === name);
}

/**
 * Frontmatter delimiter plan for one agent markdown file:
 *
 *   ---\n<yaml>\n---\n<body>
 *
 * A file without frontmatter is a bare system prompt (no description, no
 * tools). Invalid files are skipped with a console warning — one bad file
 * must never take down the registry.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

/** Parse one agent markdown file's text into an AgentInfo (name supplied by caller). */
export function parseAgentMarkdown(
  source: string,
  name: string,
  path?: string,
): AgentInfo | undefined {
  const match = FRONTMATTER_RE.exec(source);
  const rawFrontmatter = match?.[1];
  const body = (match?.[2] ?? source).trim();
  if (body.length === 0) return undefined;

  let frontmatter: AgentFrontmatter = {};
  if (rawFrontmatter !== undefined) {
    const doc = parseYaml(rawFrontmatter);
    if (doc === null || doc === undefined) {
      frontmatter = {};
    } else {
      const parsed = agentFrontmatterSchema.safeParse(doc);
      if (!parsed.success) return undefined;
      frontmatter = parsed.data;
    }
  }

  return {
    name,
    ...(frontmatter.description !== undefined ? { description: frontmatter.description } : {}),
    ...(frontmatter.model !== undefined ? { model: frontmatter.model } : {}),
    tools: frontmatter.tools ?? [],
    ...(frontmatter.skills !== undefined ? { skills: frontmatter.skills } : {}),
    prompt: body,
    source: "file",
    ...(path !== undefined ? { path } : {}),
  };
}

/** Serialize an agent definition back to markdown (frontmatter only when fields exist). */
export function serializeAgentMarkdown(input: {
  description?: string;
  model?: string;
  tools?: string[];
  skills?: string[];
  prompt: string;
}): string {
  const fm: Record<string, unknown> = {};
  if (input.description !== undefined) fm.description = input.description;
  if (input.model !== undefined) fm.model = input.model;
  if (input.tools !== undefined && input.tools.length > 0) fm.tools = input.tools;
  if (input.skills !== undefined && input.skills.length > 0) fm.skills = input.skills;
  const head = Object.keys(fm).length > 0 ? `---\n${stringifyYaml(fm)}---\n\n` : "";
  return `${head}${input.prompt.trim()}\n`;
}

export interface AgentRegistryOpts {
  /** Directory scanned for *.md agents (created on boot when missing). */
  dir: string;
  /** Watcher debounce; tests lower this. Default 150ms. */
  debounceMs?: number;
  /** Polling safety-net interval (fs.watch misses events under load / on
   * some FSEvents setups). 0 disables. Default 2000ms. */
  pollMs?: number;
  /** Fired after a rescan actually changed the agent set (watcher or CRUD). */
  onChange?: () => void;
}

/**
 * File-defined agents, hot-reloaded. The registry is read-through: `get`/
 * `list` reflect the current scan; a debounced `fs.watch` rescans the
 * directory on any change, so agents dropped into `~/.config/bai/agents/`
 * are live within ~150ms — no restart (opencode's forever-cache weakness,
 * deliberately inverted).
 *
 * The built-in `build` agent always exists; file agents may not shadow it.
 */
export class AgentRegistry {
  private agents = new Map<string, AgentInfo>();
  private watcher: ReturnType<typeof watch> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  private signature = "";
  private readonly debounceMs: number;

  constructor(private opts: AgentRegistryOpts) {
    this.debounceMs = opts.debounceMs ?? 150;
    mkdirSync(opts.dir, { recursive: true });
    this.scan();
    this.watchDir();
    // Safety net: fs.watch (FSEvents) can miss or delay events under load;
    // a slow rescan loop guarantees eventual hot-reload either way.
    const pollMs = opts.pollMs ?? 2000;
    if (pollMs > 0) {
      this.poller = setInterval(() => {
        if (this.scan() && this.opts.onChange) this.opts.onChange();
      }, pollMs);
      this.poller.unref?.();
    }
  }

  /** Rescan the directory; returns true when the agent set changed. */
  scan(): boolean {
    const next = new Map<string, AgentInfo>();
    let entries: string[] = [];
    try {
      entries = readdirSync(this.opts.dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      // Directory vanished mid-run: keep serving the previous set.
    }
    for (const file of entries) {
      const name = file.slice(0, -3);
      if (builtinFor(name) !== undefined) continue; // built-ins are never file-defined
      if (!isValidAgentName(name)) {
        console.warn(`[bai] agent file ignored, invalid name: ${file}`);
        continue;
      }
      try {
        const agent = parseAgentMarkdown(readFileSync(path.join(this.opts.dir, file), "utf8"), name, path.join(this.opts.dir, file));
        if (agent === undefined) {
          console.warn(`[bai] agent file ignored (empty body or bad frontmatter): ${file}`);
          continue;
        }
        next.set(name, agent);
      } catch (err) {
        console.warn(`[bai] agent file ignored (unreadable): ${file}: ${err instanceof Error ? err.message : err}`);
      }
    }
    const signature = JSON.stringify([...next.entries()]);
    const changed = signature !== this.signature;
    this.agents = next;
    this.signature = signature;
    return changed;
  }

  get(name: string): AgentInfo | undefined {
    return builtinFor(name) ?? this.agents.get(name);
  }

  /** build first, then built-ins, then file agents alphabetically. */
  list(): AgentInfo[] {
    const fileAgents = [...this.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
    return [...BUILTIN_AGENTS, ...fileAgents];
  }

  /** The default agent for sessions (always present). */
  default(): AgentInfo {
    return BUILTIN_BUILD_AGENT;
  }

  /** Absolute path of the markdown file that defines (or would define) `name`. */
  fileFor(name: string): string {
    return path.join(this.opts.dir, `${name}.md`);
  }

  /** Create or replace an agent file; surfaces are notified live. */
  put(name: string, input: PutAgentBody): AgentInfo {
    if (!isValidAgentName(name)) throw new Error(`Invalid agent name: ${name}`);
    if (builtinFor(name) !== undefined) throw new Error(`"${name}" is built-in and cannot be overwritten`);
    const tmp = `${this.fileFor(name)}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, serializeAgentMarkdown(input));
    renameSync(tmp, this.fileFor(name));
    // put's own scan records the change before the watcher fires, so the
    // watcher's later scan sees no diff — CRUD must broadcast itself.
    if (this.scan() && this.opts.onChange) this.opts.onChange();
    return this.get(name) as AgentInfo;
  }

  remove(name: string): boolean {
    if (builtinFor(name) !== undefined) throw new Error(`"${name}" is built-in and cannot be deleted`);
    const file = this.fileFor(name);
    if (!existsSync(file)) return false;
    rmSync(file);
    if (this.scan() && this.opts.onChange) this.opts.onChange();
    return true;
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.poller !== undefined) clearInterval(this.poller);
    this.watcher?.close();
    this.watcher = undefined;
  }

  private watchDir(): void {
    try {
      this.watcher = watch(this.opts.dir, { recursive: true }, () => {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          if (this.scan() && this.opts.onChange) this.opts.onChange();
        }, this.debounceMs);
      });
    } catch (err) {
      console.warn(`[bai] agent hot-reload unavailable (${err instanceof Error ? err.message : err}); restart to pick up agent file changes`);
    }
  }
}

/** Template written when a surface creates a new agent from scratch. */
export function agentTemplate(name: string): PutAgentBody {
  return {
    description: `What ${name} is for.`,
    prompt: `You are ${name}, an agent inside bai.\n\nDescribe the agent's role, tone, and workflow here. Its body is the system prompt.`,
    tools: [],
  };
}
