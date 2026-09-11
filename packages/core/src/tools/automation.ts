import {
  parseScheduleInput,
  type Automation,
} from "@bai/shared";
import type { AutomationScheduler, AutomationUpdate } from "../automations/scheduler";
import type { Tool, ToolContext, ToolResult } from "./registry";

/**
 * Automation authoring tools — the AI's half of the Automations feature
 * (parity with hermes's `cronjob` tool, narrowed to bai's shape).
 *
 * automation.list is read-only (auto-allowed, like agent.view).
 * automation.save is deliberately NOT auto-allowed: it can schedule an
 * unattended, auto-approved run (arbitrary fs/bash on a schedule), so the
 * first use raises a permission ask — the same stance as tool.create.
 */

/** Compact, model-friendly projection of an automation. */
function summarize(automation: Automation): Record<string, unknown> {
  return {
    id: automation.id,
    name: automation.name,
    schedule: automation.scheduleDisplay,
    enabled: automation.enabled,
    ...(automation.agent !== undefined ? { agent: automation.agent } : {}),
    ...(automation.workspace !== undefined ? { workspace: automation.workspace } : {}),
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    lastStatus: automation.lastStatus,
  };
}

function summarizeRun(automation: Automation): string {
  return (
    `Saved automation "${automation.name}" (${automation.scheduleDisplay})` +
    (automation.enabled ? ", enabled" : ", paused") +
    (automation.agent !== undefined ? `, agent ${automation.agent}` : "") +
    (automation.workspace !== undefined ? `, workspace ${automation.workspace}` : "") +
    `.\nEach run starts a new Chat session and runs with all tools auto-approved.`
  );
}

export function automationListTool(deps: { automations: AutomationScheduler }): Tool {
  return {
    name: "automation.list",
    origin: "builtin",
    description:
      "List the user's scheduled automations (name, schedule, enabled state, agent/workspace, next/last run). " +
      "Read this before automation.save so you extend an existing automation instead of creating a duplicate.",
    schema: { type: "object", properties: {} },
    async execute(): Promise<ToolResult> {
      const automations = deps.automations.list().map(summarize);
      return {
        content: automations.length > 0 ? JSON.stringify(automations, null, 2) : "No automations yet.",
      };
    },
  };
}

export function automationSaveTool(deps: { automations: AutomationScheduler }): Tool {
  return {
    name: "automation.save",
    origin: "builtin",
    description:
      "Create or update a scheduled automation. An automation runs a prompt on a schedule; each run starts a new " +
      "Chat session and executes unattended with every tool auto-approved. `schedule` is a human string: " +
      "\"every 30m\", \"every 2h\", \"every 1d\", \"every day at 9am\", \"every monday at 9am\", or " +
      "\"weekdays at 9am\". Saving an existing name updates it. This tool raises a permission ask — scheduling " +
      "unattended auto-approved runs is a sensitive capability. Use automation.list first to avoid duplicates.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Automation name (unique); saving an existing name updates it" },
        prompt: { type: "string", description: "The instruction the agent runs on each fire" },
        schedule: {
          type: "string",
          description:
            "Human schedule: \"every 30m\", \"every 2h\", \"every 1d\", \"every day at 9am\", \"every monday at 9am\", \"weekdays at 9am\"",
        },
        agent: { type: "string", description: "Optional agent name; omit for the configured default agent" },
        model: { type: "string", description: "Optional catalog model id override" },
        workspace: { type: "string", description: "Optional registered workspace path to root the run in" },
        enabled: { type: "boolean", description: "false pauses the automation (default true)" },
      },
      required: ["name", "prompt", "schedule"],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { name, prompt, schedule, agent, model, workspace, enabled } = args as {
        name?: unknown;
        prompt?: unknown;
        schedule?: unknown;
        agent?: unknown;
        model?: unknown;
        workspace?: unknown;
        enabled?: unknown;
      };
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new Error("name must be a non-empty automation name.");
      }
      if (typeof prompt !== "string" || prompt.trim().length === 0) {
        throw new Error("prompt must be a non-empty instruction.");
      }
      if (typeof schedule !== "string" || schedule.trim().length === 0) {
        throw new Error('schedule must be a string like "every 30m" or "every day at 9am".');
      }
      let parsedSchedule;
      try {
        parsedSchedule = parseScheduleInput(schedule);
      } catch (err) {
        throw new Error(`Invalid schedule: ${err instanceof Error ? err.message : String(err)}`);
      }
      const cleanName = name.trim();
      const existing = deps.automations.list().find((a) => a.name === cleanName);

      const patch: AutomationUpdate = {
        name: cleanName,
        prompt: prompt.trim(),
        schedule: parsedSchedule,
      };
      if (agent !== undefined) patch.agent = typeof agent === "string" && agent.trim().length > 0 ? agent.trim() : null;
      if (model !== undefined) patch.model = typeof model === "string" && model.trim().length > 0 ? model.trim() : null;
      if (workspace !== undefined) {
        patch.workspace = typeof workspace === "string" && workspace.trim().length > 0 ? workspace.trim() : null;
      }
      if (enabled !== undefined) patch.enabled = Boolean(enabled);

      const saved =
        existing !== undefined
          ? deps.automations.update(existing.id, patch)
          : deps.automations.create({
              name: cleanName,
              prompt: prompt.trim(),
              schedule: parsedSchedule,
              ...(patch.agent !== undefined && patch.agent !== null ? { agent: patch.agent } : {}),
              ...(patch.model !== undefined && patch.model !== null ? { model: patch.model } : {}),
              ...(patch.workspace !== undefined && patch.workspace !== null ? { workspace: patch.workspace } : {}),
              ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
            });
      if (saved === undefined) throw new Error(`Unknown automation: ${cleanName}`);
      return {
        content: summarizeRun(saved),
        meta: { automation: saved.id, title: `Saved automation: ${saved.name}` },
      };
    },
  };
}
