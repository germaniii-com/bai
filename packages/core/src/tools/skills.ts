import { readFileSync } from "node:fs";
import path from "node:path";
import type { Clock } from "@bai/shared";
import type { Tool, ToolContext, ToolResult } from "./registry";
import type { SkillRegistry } from "../skills/registry";
import type { SkillUsageRepo } from "../store/skill-usage";

/**
 * skills.view — the progressive-disclosure reader (hermes skill_view parity).
 * The system prompt carries only the skill index (name + short description);
 * this tool loads the full SKILL.md body on demand, or one linked supporting
 * file (`references/`, `templates/`, `scripts/`, `assets/`) via `path`.
 *
 * Content is returned whole — no pagination (hermes hardline: models read
 * page 1 and skip the rest). Every call records one row in the skill_events
 * analytics store (best-effort — analytics must never break a run).
 */
export function skillsViewTool(deps: {
  skills: SkillRegistry;
  usage: SkillUsageRepo;
  clock: Clock;
  /**
   * The calling agent's skills allow-list (agent.skills), resolved by agent
   * name at execute time — ctx.agent rides every ToolContext. null/undefined
   * or a list containing "*" = every skill. Mirrors the index filter in
   * run.ts (visibleSkills), so a whitelisted agent can neither SEE nor LOAD
   * a non-whitelisted skill.
   */
  agentSkills?: (agentName: string) => string[] | null | undefined;
}): Tool {
  /** Advisory analytics insert — a recording failure must never break the tool. */
  const record = (entry: {
    sessionId: ToolContext["sessionId"];
    skill: string;
    agent?: string;
    filePath?: string;
    ok: boolean;
    error?: string;
    bytes?: number;
  }): void => {
    try {
      deps.usage.insert({
        sessionId: entry.sessionId,
        skill: entry.skill,
        ...(entry.agent !== undefined ? { agent: entry.agent } : {}),
        ...(entry.filePath !== undefined ? { filePath: entry.filePath } : {}),
        ok: entry.ok,
        ...(entry.error !== undefined ? { error: entry.error } : {}),
        ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
        now: deps.clock.iso(),
      });
    } catch {
      // Analytics is advisory.
    }
  };

  return {
    name: "skills.view",
    origin: "builtin",
    description:
      "Load a skill's full instructions by name. When the skill index in your context matches the task — even " +
      "partially — call this with the skill's name BEFORE doing the work, then follow the returned instructions. " +
      "Pass `path` to read one of the skill's linked supporting files (listed in the result).",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name from the index" },
        path: {
          type: "string",
          description: "Optional linked file to read instead of the main instructions, e.g. 'references/api.md'",
        },
      },
      required: ["name"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { name, path: filePath } = args as { name?: string; path?: string };
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new Error("name must be a non-empty skill name from the index.");
      }
      const skillName = name.trim();

      // Agent skills whitelist (hard gate): the index only ever showed this
      // agent its allowed skills — a guessed or stale name is rejected here
      // rather than loaded. Checked BEFORE the existence lookup so the error
      // never leaks which non-whitelisted skills exist. Unresolvable agent
      // (no ctx.agent / no resolver) fails open — the gate is agent-scoped.
      const allowed = ctx.agent !== undefined ? deps.agentSkills?.(ctx.agent) : undefined;
      if (allowed !== undefined && allowed !== null && !allowed.includes("*") && !allowed.includes(skillName)) {
        record({
          sessionId: ctx.sessionId,
          skill: skillName,
          ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
          ok: false,
          error: `Skill "${skillName}" is not whitelisted for agent ${ctx.agent}`,
        });
        const allowedList = allowed.filter((s) => s !== "*");
        throw new Error(
          `Skill "${skillName}" is not available to this agent. Allowed skills: ` +
            `${allowedList.length > 0 ? allowedList.join(", ") : "(none)"}.`,
        );
      }

      const skill = deps.skills.get(skillName);
      if (skill === undefined) {
        record({ sessionId: ctx.sessionId, skill: skillName, ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}), ok: false, error: `Unknown skill: ${skillName}` });
        const available = deps.skills.list().map((s) => s.name).join(", ");
        throw new Error(`Unknown skill: ${skillName}. Available skills: ${available.length > 0 ? available : "(none)"}.`);
      }

      // --- linked-file read (progressive disclosure, tier 3) ---
      if (filePath !== undefined) {
        if (typeof filePath !== "string" || filePath.length === 0) {
          throw new Error("path must be a non-empty relative path from the skill's linkedFiles list.");
        }
        const invalid =
          path.isAbsolute(filePath) ||
          filePath.split("/").some((segment) => segment === "..");
        if (invalid || !skill.linkedFiles.includes(filePath)) {
          record({
            sessionId: ctx.sessionId,
            skill: skillName,
            ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
            ok: false,
            error: `Invalid linked-file path: ${filePath}`,
          });
          throw new Error(
            `"${filePath}" is not a linked file of skill "${skillName}". Linked files: ` +
              `${skill.linkedFiles.length > 0 ? skill.linkedFiles.join(", ") : "(none)"}.`,
          );
        }
        // Belt-and-suspenders containment (membership in the scanned list is
        // the real guard; the resolve-prefix check costs nothing).
        const root = path.resolve(deps.skills.dirFor(skillName));
        const resolved = path.resolve(root, filePath);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) {
          record({ sessionId: ctx.sessionId, skill: skillName, ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}), ok: false, error: `Linked-file path escapes the skill directory: ${filePath}` });
          throw new Error(`Linked-file path escapes the skill directory: ${filePath}`);
        }
        let content: string;
        try {
          content = readFileSync(resolved, "utf8");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          record({ sessionId: ctx.sessionId, skill: skillName, ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}), filePath, ok: false, error: `Unreadable linked file: ${message}` });
          throw new Error(`Could not read linked file "${filePath}" of skill "${skillName}": ${message}`);
        }
        record({
          sessionId: ctx.sessionId,
          skill: skillName,
          ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
          filePath,
          ok: true,
          bytes: Buffer.byteLength(content),
        });
        return {
          content,
          meta: { skill: skillName, filePath, bytes: Buffer.byteLength(content), title: `${skillName}/${filePath}` },
        };
      }

      // --- full SKILL.md view (tier 2) ---
      const bytes = Buffer.byteLength(skill.body);
      record({ sessionId: ctx.sessionId, skill: skillName, ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}), ok: true, bytes });
      const linkedHint =
        skill.linkedFiles.length > 0
          ? `\n\nLinked files (read one via skills.view(name, path)): ${skill.linkedFiles.join(", ")}`
          : "";
      return {
        content: `${skill.body}${linkedHint}`,
        meta: { skill: skillName, bytes, linkedFiles: skill.linkedFiles, title: `Skill: ${skillName}` },
      };
    },
  };
}
