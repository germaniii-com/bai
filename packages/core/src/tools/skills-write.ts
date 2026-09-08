import { lstatSync, mkdirSync, rmdirSync, rmSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isValidSkillName, SKILL_SUPPORT_DIRS } from "@bai/shared";
import type { Tool, ToolContext, ToolResult } from "./registry";
import type { SkillRegistry } from "../skills/registry";
import { parseSkillMarkdown } from "../skills/registry";
import { resolveLinkedPath } from "../skills/paths";

/**
 * Skill authoring tools — the write side of progressive disclosure (the
 * `skill_manage` create/write_file subset, hermes parity). The learn flow
 * (and natural-language "save this as a skill") needs the agent to be able
 * to persist skills; both tools are root-restricted to the skills directory
 * inside the tool, the same stance as plan.write.
 *
 * skills.save creates or REPLACES a skill's SKILL.md — the authoring guidance
 * tells the agent to check existing skills first (skills.view) and extend a
 * matching one instead of minting near-duplicates. skills.writeFile adds one
 * linked supporting file (references/|templates/|scripts/|assets/) — the
 * knowledge-base layout's per-chapter unit.
 */

/** Content cap for authored files (matches the API's putSkillSchema body cap). */
const MAX_CONTENT_CHARS = 200_000;

export function skillsSaveTool(deps: { skills: SkillRegistry }): Tool {
  return {
    name: "skills.save",
    origin: "builtin",
    description:
      "Create or replace a skill (writes ~/.config/bai/skills/<skill>/SKILL.md). Check the existing skills first " +
      "(skills.view) — extend a matching skill instead of creating a near-duplicate. Follow the skill-authoring " +
      "standards from your context: description ONE sentence <=60 chars ending with a period, author stays the " +
      "literal 'bai', tight scannable body (~100-200 lines).",
    schema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill name (directory stem): starts with a letter, then letters/digits/-/_ (max 64)" },
        description: { type: "string", description: "ONE sentence, <=60 characters, ends with a period — this is what the skill index shows" },
        body: { type: "string", description: "Full markdown body of SKILL.md (the skill's instructions)" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags, e.g. [\"research\", \"papers\"]" },
        version: { type: "string", description: "Optional version, e.g. 0.1.0" },
      },
      required: ["skill", "description", "body"],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { skill, description, body, tags, version } = args as {
        skill?: string;
        description?: string;
        body?: string;
        tags?: unknown;
        version?: string;
      };
      if (typeof skill !== "string" || !isValidSkillName(skill.trim())) {
        throw new Error("skill must start with a letter and contain only letters, digits, '-' and '_' (max 64 chars).");
      }
      const name = skill.trim();
      if (typeof description !== "string" || description.trim().length === 0) {
        throw new Error("description must be a non-empty sentence (<=60 characters reads best in the skill index).");
      }
      if (typeof body !== "string" || body.trim().length === 0) {
        throw new Error("body must be non-empty markdown (the skill's instructions).");
      }
      if (body.length > MAX_CONTENT_CHARS) {
        throw new Error(`body is too large (${body.length} chars; max ${MAX_CONTENT_CHARS}). Distill structure, not a copy of the source.`);
      }
      const tagList = Array.isArray(tags)
        ? tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim()).slice(0, 20)
        : undefined;
      const saved = deps.skills.put(name, {
        description: description.trim(),
        ...(version !== undefined && version.trim().length > 0 ? { version: version.trim() } : {}),
        ...(tagList !== undefined && tagList.length > 0 ? { tags: tagList } : {}),
        body,
      });
      return {
        content: `Saved skill "${name}" (${Buffer.byteLength(body)} bytes) at ${saved.path}. It is live: the skill index picks it up on the next agent turn.`,
        meta: { skill: name, path: saved.path, bytes: Buffer.byteLength(body), title: `Saved skill: ${name}` },
      };
    },
  };
}

export function skillsWriteFileTool(deps: { skills: SkillRegistry }): Tool {
  return {
    name: "skills.writeFile",
    origin: "builtin",
    description:
      "Write one linked supporting file of an existing skill — under references/, templates/, scripts/, or assets/ " +
      "(e.g. path \"references/ch04-replication.md\"). The skill must already exist (skills.save creates it). " +
      "Reference files are loaded on demand via skills.view(skill, path).",
    schema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Name of an existing skill" },
        path: { type: "string", description: "Relative path under the skill directory, starting with references/, templates/, scripts/, or assets/" },
        content: { type: "string", description: "Full file content (markdown for references/templates; code for scripts)" },
      },
      required: ["skill", "path", "content"],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { skill, path: filePath, content } = args as { skill?: string; path?: string; content?: string };
      if (typeof skill !== "string" || skill.trim().length === 0) {
        throw new Error("skill must be the name of an existing skill.");
      }
      const name = skill.trim();
      const existing = deps.skills.get(name);
      if (existing === undefined) {
        throw new Error(`Unknown skill: ${name}. Create it with skills.save first.`);
      }
      if (typeof filePath !== "string" || filePath.trim().length === 0) {
        throw new Error("path must be a relative path starting with references/, templates/, scripts/, or assets/.");
      }
      const clean = filePath.trim();
      const invalid =
        path.isAbsolute(clean) ||
        clean.split("/").some((segment) => segment === "..") ||
        !SKILL_SUPPORT_DIRS.includes(clean.split("/")[0] as (typeof SKILL_SUPPORT_DIRS)[number]);
      if (invalid) {
        throw new Error(
          `path must be relative and start with one of: ${SKILL_SUPPORT_DIRS.map((d) => `${d}/`).join(", ")} (no "..").`,
        );
      }
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error("content must be non-empty.");
      }
      if (content.length > MAX_CONTENT_CHARS) {
        throw new Error(`content is too large (${content.length} chars; max ${MAX_CONTENT_CHARS}).`);
      }
      const guard = resolveLinkedPath(deps.skills.dirFor(name), clean);
      if (!guard.ok) throw new Error(guard.error);
      mkdirSync(path.dirname(guard.resolved), { recursive: true });
      writeFileSync(guard.resolved, content);
      // Refresh the registry's cached linkedFiles set (signature-diffed —
      // only fires onChange when the set actually changed).
      deps.skills.scan();
      return {
        content: `Wrote ${guard.relative} (${Buffer.byteLength(content)} bytes) for skill "${name}".`,
        meta: { skill: name, filePath: guard.relative, bytes: Buffer.byteLength(content), title: `${name}/${guard.relative}` },
      };
    },
  };
}

/**
 * skills.patch — surgical find-and-replace in a skill's SKILL.md or one
 * linked file (hermes skill_manage action="patch", minus the fuzzy engine:
 * exact-match semantics mirroring fs.edit). Operates on the RAW file text so
 * user formatting survives; a SKILL.md patch must leave valid frontmatter.
 */
export function skillsPatchTool(deps: { skills: SkillRegistry }): Tool {
  return {
    name: "skills.patch",
    origin: "builtin",
    description:
      "Replace an exact string in a skill's SKILL.md (or one linked file via path). oldString must match the file's " +
      "exact current content including whitespace/indentation, and must appear exactly once unless replaceAll is " +
      "true. Read the file first (skills.view) and copy the snippet verbatim — do NOT fall back to skills.save for " +
      "a targeted fix (it rewrites the whole file).",
    schema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Name of an existing skill" },
        oldString: { type: "string", description: "Exact text to replace" },
        newString: { type: "string", description: "Replacement text (empty string deletes the match; must differ from oldString)" },
        path: { type: "string", description: "Optional linked file to patch instead of SKILL.md, e.g. 'references/api.md'" },
        replaceAll: { type: "boolean", description: "Replace every occurrence (default false)" },
      },
      required: ["skill", "oldString", "newString"],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { skill, oldString, newString, path: filePath, replaceAll } = args as {
        skill?: string;
        oldString?: string;
        newString?: string;
        path?: string;
        replaceAll?: boolean;
      };
      if (typeof skill !== "string" || skill.trim().length === 0) {
        throw new Error("skill must be the name of an existing skill.");
      }
      const name = skill.trim();
      if (deps.skills.get(name) === undefined) {
        throw new Error(`Unknown skill: ${name}.`);
      }
      if (typeof oldString !== "string" || oldString.length === 0) {
        throw new Error(
          "oldString is required and must be the EXACT text currently in the file. Read the target first " +
            "(skills.view) and copy the snippet verbatim, then retry. Do NOT fall back to skills.save — that " +
            "rewrites the entire file and destroys unrelated content.",
        );
      }
      if (typeof newString !== "string") {
        throw new Error("newString is required (use an empty string to delete the matched text).");
      }
      if (oldString === newString) {
        throw new Error("No changes to apply: oldString and newString are identical.");
      }

      // Resolve the target: SKILL.md by default, else a guarded linked file.
      const skillDir = deps.skills.dirFor(name);
      let target: string;
      let label: string;
      if (filePath === undefined) {
        target = deps.skills.fileFor(name);
        label = "SKILL.md";
      } else {
        const guard = resolveLinkedPath(skillDir, filePath);
        if (!guard.ok) throw new Error(guard.error);
        target = guard.resolved;
        label = guard.relative;
      }

      const original = readFileSync(target, "utf8");
      const ending = original.includes("\r\n") ? "\r\n" : "\n";
      const normalize = (text: string): string => {
        const unified = text.replaceAll("\r\n", "\n");
        return ending === "\n" ? unified : unified.replaceAll("\n", "\r\n");
      };
      const oldText = normalize(oldString);
      const newText = normalize(newString);

      const occurrences = countOccurrences(original, oldText);
      if (occurrences === 0) {
        throw new Error(
          `Could not find oldString in ${label}. It must match exactly, including whitespace, indentation, and line endings.`,
        );
      }
      if (occurrences > 1 && replaceAll !== true) {
        throw new Error(
          `Found ${occurrences} matches for oldString in ${label}. Provide more surrounding context to make the match unique, or set replaceAll: true.`,
        );
      }
      const replacements = replaceAll === true ? occurrences : 1;
      const updated = replaceAll === true ? original.split(oldText).join(newText) : original.replace(oldText, newText);
      if (updated === original) {
        throw new Error("No changes made: the replacement produced identical content.");
      }
      if (updated.length > MAX_CONTENT_CHARS) {
        throw new Error(`Patched content is too large (${updated.length} chars; max ${MAX_CONTENT_CHARS}).`);
      }
      // A SKILL.md patch must leave a parseable skill (frontmatter intact,
      // non-empty body) — reject before writing, never after.
      if (label === "SKILL.md" && parseSkillMarkdown(updated, name, target) === undefined) {
        throw new Error("Patch would break SKILL.md structure: the result must keep valid YAML frontmatter and a non-empty body.");
      }
      writeFileSync(target, updated);
      // Refresh the registry's parsed cache (the file changed underneath it).
      deps.skills.scan();
      return {
        content: `Patched ${label} in skill "${name}" (${replacements} replacement${replacements === 1 ? "" : "s"}).`,
        meta: { skill: name, filePath: label === "SKILL.md" ? undefined : label, replacements, title: `Patched ${name}/${label}` },
      };
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}

/**
 * skills.delete — remove one linked file, or (no path) an entire skill
 * directory. Whole-skill deletes are guarded: the directory must not be a
 * symlink, must not be a skills root, and must resolve inside the skills
 * root (hermes _validate_delete_target). Deleting a BUNDLED skill is allowed
 * — the sync manifest remembers the deletion so it never comes back.
 */
export function skillsDeleteTool(deps: { skills: SkillRegistry }): Tool {
  return {
    name: "skills.delete",
    origin: "builtin",
    description:
      "Delete a skill entirely (no path) or one of its linked files (path, e.g. 'references/old.md'). Whole-skill " +
      "deletion removes the directory including all linked files and is irreversible. Prefer skills.patch for " +
      "content fixes.",
    schema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Name of an existing skill" },
        path: { type: "string", description: "Optional linked file to delete instead of the whole skill" },
      },
      required: ["skill"],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { skill, path: filePath } = args as { skill?: string; path?: string };
      if (typeof skill !== "string" || skill.trim().length === 0) {
        throw new Error("skill must be the name of an existing skill.");
      }
      const name = skill.trim();
      if (deps.skills.get(name) === undefined) {
        throw new Error(`Unknown skill: ${name}.`);
      }
      const skillDir = deps.skills.dirFor(name);

      // --- single linked file ---
      if (filePath !== undefined) {
        const guard = resolveLinkedPath(skillDir, filePath);
        if (!guard.ok) throw new Error(guard.error);
        let existed = false;
        try {
          existed = lstatSync(guard.resolved).isFile();
        } catch {
          existed = false;
        }
        if (!existed) {
          const available = deps.skills.get(name)?.linkedFiles ?? [];
          throw new Error(
            `"${guard.relative}" not found in skill "${name}". Linked files: ` +
              `${available.length > 0 ? available.join(", ") : "(none)"}.`,
          );
        }
        rmSync(guard.resolved, { force: true });
        pruneEmptyDirs(skillDir, path.dirname(guard.resolved));
        deps.skills.scan();
        return {
          content: `Removed ${guard.relative} from skill "${name}".`,
          meta: { skill: name, filePath: guard.relative, title: `Removed ${name}/${guard.relative}` },
        };
      }

      // --- whole skill directory ---
      // The skills root is the skill dir's parent (layout: <root>/<name>/).
      const root = path.resolve(path.dirname(skillDir));
      let stat;
      try {
        stat = lstatSync(skillDir);
      } catch {
        throw new Error(`Skill directory not found: ${skillDir}`);
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to delete "${name}": the skill directory is a symlink. Remove the link target manually if intended.`);
      }
      const resolved = path.resolve(skillDir);
      if (resolved === root) {
        throw new Error("Refusing to delete: the target resolves to the skills root itself.");
      }
      if (!resolved.startsWith(root + path.sep)) {
        throw new Error(`Refusing to delete "${name}": the directory resolves outside the skills root.`);
      }
      rmSync(skillDir, { recursive: true, force: true });
      deps.skills.scan();
      return {
        content: `Skill "${name}" deleted (directory and all linked files).`,
        meta: { skill: name, deleted: true, title: `Deleted skill: ${name}` },
      };
    },
  };
}

/** Remove now-empty support subdirectories left behind by a file delete. */
function pruneEmptyDirs(skillDir: string, dir: string): void {
  const stop = path.resolve(skillDir);
  let current = path.resolve(dir);
  while (current !== stop && current.startsWith(stop + path.sep)) {
    try {
      rmdirSync(current); // throws when non-empty — the prune stops there
    } catch {
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
