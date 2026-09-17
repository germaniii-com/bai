import path from "node:path";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { recordInbound, resultBytes } from "./analytics";
import type { McpServerDeps } from "./deps";

/**
 * The skills half of the MCP server role. Each bai skill
 * (`~/.config/bai/skills/<name>/SKILL.md`) is exposed three ways so any client
 * can consume it:
 * - a PROMPT of the same name whose message is the skill body (slash-command
 *   semantics);
 * - RESOURCES `skill://<name>` (SKILL.md) and `skill://<name>/<file>` for its
 *   supporting files (references/templates/scripts/assets);
 * - the `skills_list` TOOL for clients that surface neither prompts nor
 *   resources (bai's own `skills_view` registry tool is exposed as usual too).
 */

const LIST_SCHEMA = { type: "object", properties: {} } as const;

/** Best-effort MIME type for a skill support file. */
function mimeFor(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return "text/plain";
  }
}

export function registerSkills(server: McpServer, deps: McpServerDeps): void {
  const skills = deps.core.listSkills();

  for (const skill of skills) {
    // SKILL.md as a resource.
    server.registerResource(
      skill.name,
      `skill://${skill.name}`,
      { title: skill.name, description: skill.description, mimeType: "text/markdown" },
      async (uri) => {
        const started = Date.now();
        try {
          const current = deps.core.getSkill(skill.name);
          if (current === undefined) throw new Error(`Unknown skill: ${skill.name}`);
          recordInbound(deps, {
            tool: skill.name,
            kind: "resource",
            ok: true,
            durationMs: Date.now() - started,
            bytes: resultBytes(current.body),
          });
          return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: current.body }] };
        } catch (err) {
          recordInbound(deps, {
            tool: skill.name,
            kind: "resource",
            ok: false,
            durationMs: Date.now() - started,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    );

    // Supporting files as resources (path-guarded by the core service).
    for (const file of skill.linkedFiles) {
      server.registerResource(
        `${skill.name}/${file}`,
        `skill://${skill.name}/${file}`,
        { title: `${skill.name}/${file}`, mimeType: mimeFor(file) },
        async (uri) => {
          const started = Date.now();
          try {
            const text = deps.core.skillFile(skill.name, file);
            recordInbound(deps, {
              tool: `${skill.name}/${file}`,
              kind: "resource",
              ok: true,
              durationMs: Date.now() - started,
              bytes: resultBytes(text),
            });
            return { contents: [{ uri: uri.href, mimeType: mimeFor(file), text }] };
          } catch (err) {
            recordInbound(deps, {
              tool: `${skill.name}/${file}`,
              kind: "resource",
              ok: false,
              durationMs: Date.now() - started,
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        },
      );
    }

    // The skill as a prompt (body verbatim).
    server.registerPrompt(
      skill.name,
      { title: skill.name, description: skill.description },
      () => ({
        messages: [{ role: "user", content: { type: "text", text: skill.body } }],
      }),
    );
  }

  // A discovery tool for clients without prompt/resource support.
  server.registerTool(
    "skills_list",
    {
      title: "List skills",
      description:
        "List bai's available skills (name and description). Load a skill's full instructions with the skills_view tool or the matching MCP prompt.",
      inputSchema: fromJsonSchema(LIST_SCHEMA),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const started = Date.now();
      const current = deps.core.listSkills();
      const text =
        current.length === 0
          ? "No skills installed."
          : current.map((skill) => `${skill.name}: ${skill.description}`).join("\n");
      recordInbound(deps, {
        tool: "skills_list",
        kind: "tool",
        ok: true,
        durationMs: Date.now() - started,
        bytes: resultBytes(text),
      });
      return { content: [{ type: "text", text }] };
    },
  );
}
