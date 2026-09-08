import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  isValidSkillName,
  SKILL_SUPPORT_DIRS,
  skillFrontmatterSchema,
  type PutSkillBody,
  type SkillFrontmatter,
  type SkillInfo,
} from "@bai/shared";

/**
 * Frontmatter delimiter plan for one SKILL.md file:
 *
 *   ---\n<yaml>\n---\n<body>
 *
 * Unlike agents (a bare file is a valid prompt), a skill REQUIRES
 * frontmatter — the description is what the system-prompt index is built
 * from. Files without valid frontmatter are skipped with a console warning —
 * one bad file must never take down the registry.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

/** Parse one SKILL.md file's text into a SkillInfo (name and file path supplied by caller). */
export function parseSkillMarkdown(
  source: string,
  name: string,
  path: string,
  linkedFiles: string[] = [],
): SkillInfo | undefined {
  const match = FRONTMATTER_RE.exec(source);
  const rawFrontmatter = match?.[1];
  const body = (match?.[2] ?? "").trim();
  if (rawFrontmatter === undefined || body.length === 0) return undefined;

  const doc = parseYaml(rawFrontmatter);
  if (doc === null || doc === undefined) return undefined;
  const parsed = skillFrontmatterSchema.safeParse(doc);
  if (!parsed.success) return undefined;
  const fm: SkillFrontmatter = parsed.data;

  return {
    name,
    description: fm.description,
    ...(fm.version !== undefined ? { version: fm.version } : {}),
    ...(fm.author !== undefined ? { author: fm.author } : {}),
    ...(fm.platforms !== undefined ? { platforms: fm.platforms } : {}),
    ...(fm.tags !== undefined ? { tags: fm.tags } : {}),
    body,
    source: "file",
    path,
    linkedFiles,
  };
}

/** Serialize a skill definition back to SKILL.md (frontmatter + body). */
export function serializeSkillMarkdown(input: PutSkillBody): string {
  const fm: Record<string, unknown> = { description: input.description };
  if (input.version !== undefined) fm.version = input.version;
  if (input.author !== undefined) fm.author = input.author;
  if (input.platforms !== undefined && input.platforms.length > 0) fm.platforms = input.platforms;
  if (input.tags !== undefined && input.tags.length > 0) fm.tags = input.tags;
  return `---\n${stringifyYaml(fm)}---\n\n${input.body.trim()}\n`;
}

/**
 * Collect supporting files under the skill's progressive-disclosure
 * directories (references/, templates/, scripts/, assets/ — hermes'
 * SKILL_SUPPORT_DIRS), as slash-relative paths. Nested directories are
 * walked; dotfiles/dot-dirs are skipped; unreadable dirs are ignored.
 */
function scanLinkedFiles(skillDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) files.push(`${prefix}${entry.name}`);
    }
  };
  for (const dir of SKILL_SUPPORT_DIRS) walk(path.join(skillDir, dir), `${dir}/`);
  return files;
}

export interface SkillRegistryOpts {
  /** Directory scanned for <name>/SKILL.md skills (created on boot when missing). */
  dir: string;
  /** Watcher debounce; tests lower this. Default 150ms. */
  debounceMs?: number;
  /** Polling safety-net interval (fs.watch misses events under load / on
   * some FSEvents setups). 0 disables. Default 2000ms. */
  pollMs?: number;
  /** Fired after a rescan actually changed the skill set (watcher or CRUD). */
  onChange?: () => void;
  /** Platform gate (frontmatter `platforms:`); injectable for tests. Default process.platform. */
  platform?: string;
}

/**
 * File-defined skills, hot-reloaded. The registry is read-through: `get`/
 * `list` reflect the current scan; a debounced `fs.watch` rescans the
 * directory on any change, so skills dropped into `~/.config/bai/skills/`
 * are live within ~150ms — no restart (opencode's forever-cache weakness,
 * deliberately inverted — the same stance as AgentRegistry).
 *
 * Layout: `<dir>/<name>/SKILL.md` (+ optional references/templates/scripts/
 * assets/ subdirectories). The name is the directory stem; frontmatter
 * `platforms` gates by OS (hermes parity). There are no built-in skills —
 * every skill is file-defined.
 */
export class SkillRegistry {
  private skills = new Map<string, SkillInfo>();
  private watcher: ReturnType<typeof watch> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  private signature = "";
  private readonly debounceMs: number;
  private readonly platform: string;

  constructor(private opts: SkillRegistryOpts) {
    this.debounceMs = opts.debounceMs ?? 150;
    this.platform = opts.platform ?? process.platform;
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

  /** Rescan the directory; returns true when the skill set changed. */
  scan(): boolean {
    const next = new Map<string, SkillInfo>();
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(this.opts.dir, { withFileTypes: true });
    } catch {
      // Directory vanished mid-run: keep serving the previous set.
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith(".")) continue;
      if (!isValidSkillName(name)) {
        console.warn(`[bai] skill directory ignored, invalid name: ${name}`);
        continue;
      }
      const skillDir = path.join(this.opts.dir, name);
      const skillMd = path.join(skillDir, "SKILL.md");
      let source: string;
      try {
        source = readFileSync(skillMd, "utf8");
      } catch {
        continue; // no SKILL.md (or unreadable) — not a skill directory
      }
      let skill: SkillInfo | undefined;
      try {
        skill = parseSkillMarkdown(source, name, skillMd, scanLinkedFiles(skillDir));
      } catch (err) {
        // Malformed YAML must never take down the boot (one bad file is
        // skipped with a warning — the agent registry's same stance).
        console.warn(`[bai] skill ignored (unparseable frontmatter): ${name}/SKILL.md: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (skill === undefined) {
        console.warn(`[bai] skill ignored (missing/invalid frontmatter or empty body): ${name}/SKILL.md`);
        continue;
      }
      // Platform gate (hermes skill_matches_platform): a skill that declares
      // platforms and doesn't include this one is intentionally hidden.
      if (skill.platforms !== undefined && !skill.platforms.includes(this.platform)) continue;
      next.set(name, skill);
    }
    const signature = JSON.stringify([...next.entries()]);
    const changed = signature !== this.signature;
    this.skills = next;
    this.signature = signature;
    return changed;
  }

  get(name: string): SkillInfo | undefined {
    return this.skills.get(name);
  }

  /** Alphabetically by name. */
  list(): SkillInfo[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Absolute path of the SKILL.md file that defines (or would define) `name`. */
  fileFor(name: string): string {
    return path.join(this.opts.dir, name, "SKILL.md");
  }

  /** Absolute path of the skill's directory. */
  dirFor(name: string): string {
    return path.join(this.opts.dir, name);
  }

  /** Create or replace a skill file; surfaces are notified live. */
  put(name: string, input: PutSkillBody): SkillInfo {
    if (!isValidSkillName(name)) throw new Error(`Invalid skill name: ${name}`);
    mkdirSync(this.dirFor(name), { recursive: true });
    const tmp = `${this.fileFor(name)}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, serializeSkillMarkdown(input));
    // Atomic on POSIX: readers never see a partial SKILL.md.
    renameSync(tmp, this.fileFor(name));
    // put's own scan records the change before the watcher fires, so the
    // watcher's later scan sees no diff — CRUD must broadcast itself.
    if (this.scan() && this.opts.onChange) this.opts.onChange();
    return this.get(name) as SkillInfo;
  }

  /** Delete a skill (the whole directory, linked files included). */
  remove(name: string): boolean {
    const dir = this.dirFor(name);
    if (!existsDir(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
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
      console.warn(`[bai] skill hot-reload unavailable (${err instanceof Error ? err.message : err}); restart to pick up skill file changes`);
    }
  }
}

function existsDir(dir: string): boolean {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** Template written when a surface creates a new skill from scratch. */
export function skillTemplate(name: string): PutSkillBody {
  return {
    description: `What the ${name} skill does, in one sentence.`,
    body: `# ${name}

Describe the workflow here: when to use it, the steps to follow, and how to verify the result.

Supporting files can live in references/, templates/, scripts/, and assets/ — the agent reads them on demand via skills.view(name, path).`,
  };
}
