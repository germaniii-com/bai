import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isValidSkillName, SKILL_SUPPORT_DIRS } from "@bai/shared";
import type { Tool, ToolContext, ToolResult } from "./registry";
import type { SkillRegistry } from "../skills/registry";

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
      // Belt-and-suspenders containment (the support-dir prefix check is the
      // real guard; the resolve-prefix check costs nothing).
      const root = path.resolve(deps.skills.dirFor(name));
      const resolved = path.resolve(root, clean);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error(`Path escapes the skill directory: ${clean}`);
      }
      mkdirSync(path.dirname(resolved), { recursive: true });
      writeFileSync(resolved, content);
      // Refresh the registry's cached linkedFiles set (signature-diffed —
      // only fires onChange when the set actually changed).
      deps.skills.scan();
      return {
        content: `Wrote ${clean} (${Buffer.byteLength(content)} bytes) for skill "${name}".`,
        meta: { skill: name, filePath: clean, bytes: Buffer.byteLength(content), title: `${name}/${clean}` },
      };
    },
  };
}
