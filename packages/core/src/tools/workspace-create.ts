import path from "node:path";
import type { ConfigPatch, SessionId } from "@bai/shared";
import { createFolder, expandHomeInput, FsError, statPath } from "../fs/paths";
import { QuestionRejectedError } from "../question/service";
import type { Tool, ToolContext, ToolResult } from "./registry";

/**
 * workspace.create — the orchestrator's "create a workspace" capability,
 * mirroring the webui's "+ New workspace" flow (AddWorkspaceModal →
 * POST /api/fs/mkdir + PUT /api/config workspaces patch) as one agent
 * tool — WITH a consent gate of its own: before touching anything it
 * raises a dedicated path ask ("Where should the workspace be created?")
 * pre-filled with the suggested absolute path; the user edits it freely
 * and confirms (or dismisses — nothing is created). The ask replaces the
 * generic permission dialog (the tool is auto-allowed; the confirm IS the
 * consent), and its Q&A is retained on the tool_result for the transcript.
 *
 * Creation itself mirrors the web modal exactly: statPath first (an
 * EXISTING directory at any readable path registers as-is), and only a
 * MISSING path falls to createFolder — home-only creation, the same three
 * safety guards (shared code via @bai/core).
 *
 * The brainstorm→workspace flow: the user works out an idea in chat, then
 * asks for a workspace for it — the agent derives a folder name from the
 * conversation and calls this tool; the user confirms where it lands.
 */

/** Structural ask dep — the QuestionService satisfies it; tests stub it. */
export interface PathAsker {
  askPath(input: {
    sessionId?: SessionId;
    path: { prompt: string; prefill: string; hint?: string };
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface WorkspaceCreateDeps {
  /**
   * The path-ask service (QuestionService). The tool blocks on it until
   * the user confirms or dismisses on any surface.
   */
  questions: PathAsker;
  /**
   * Persist a config patch (ServiceDeps.updateConfig → ConfigStore.update):
   * writes the global layer file atomically and fires onChange (bus
   * config.updated). Optional at the Service level — absent (bare test
   * constructors) the tool fails with a clear error.
   */
  updateConfig(patch: ConfigPatch): unknown;
  /** The server's home directory (creation guard root + ~ expansion). */
  home(): string;
  /** Current config (the workspaces list to dedupe against + archived to re-activate). */
  config(): { workspaces?: string[]; archivedWorkspaces?: string[] };
}

export function workspaceCreateTool(deps: WorkspaceCreateDeps): Tool {
  return {
    name: "workspace.create",
    origin: "builtin",
    description:
      "Create and register a workspace folder — it appears in the Workspace section and new code sessions can root " +
      "there. Use when the user wants a dedicated folder for an idea worked out in chat (\"make a workspace for " +
      "this project\"): derive a short kebab-case folder name from the conversation. The user ALWAYS confirms the " +
      "location first — a prompt pre-filled with your suggested absolute path, freely editable — so suggest the " +
      "path you'd put it at (under ~ unless they said otherwise). An EXISTING folder at the confirmed path " +
      "registers as-is; a missing one is created (home-only). Idempotent: an already-registered path succeeds " +
      "without changes.",
    schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Suggested folder path — absolute, ~/relative, or a bare name (bare/relative resolves under the home directory), e.g. \"my-idea\" or \"~/Work/my-idea\"",
        },
      },
      required: ["path"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { path: rawPath } = args as { path?: unknown };
      if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
        throw new Error("path is required (absolute, ~/relative, or a bare folder name).");
      }
      if (deps.updateConfig === undefined) {
        throw new Error("workspace.create is unavailable: the service has no config update path.");
      }
      // The suggested ABSOLUTE path (display + prefill — not stat'd yet;
      // the user is free to edit it into something else entirely).
      const home = deps.home();
      const suggested = path.resolve(expandHomeInput(rawPath.trim(), home));
      const name = suggested.split("/").filter((s) => s.length > 0).pop() ?? suggested;
      const prompt = "Where should the workspace be created?";
      // The consent gate: block until the user confirms/edits the path on
      // any surface (or dismisses — nothing is created, the run continues
      // with an error result explaining why).
      let confirmed: string;
      try {
        confirmed = await deps.questions.askPath({
          sessionId: ctx.sessionId,
          path: { prompt, prefill: suggested, hint: `Suggested from this conversation: "${name}"` },
          signal: ctx.signal,
        });
      } catch (err) {
        if (err instanceof QuestionRejectedError) {
          throw new Error(`No workspace created — ${err.message}`);
        }
        throw err;
      }
      // The web modal's exact two-step flow on the CONFIRMED path: stat
      // first (existing dirs register from anywhere readable); only a
      // MISSING path falls to createFolder — home-only creation, guards
      // inside.
      let stat;
      try {
        stat = statPath(confirmed.trim(), home);
      } catch (err) {
        if (err instanceof FsError && err.message === "path not found") {
          stat = createFolder(confirmed.trim(), home);
        } else {
          throw err;
        }
      }
      if (stat.type !== "dir") {
        throw new FsError("path is not a directory");
      }
      const resolved = stat.path;
      // Register (dedupe): ConfigStore.update merges the patch into the
      // global layer and fires onChange — the single broadcast point (bus +
      // firehose config.updated; also covers external file edits from a
      // sibling bai process). A path sitting in archivedWorkspaces is
      // re-activated (dropped from the archive) — creating at a
      // previously-archived path means the user wants it back.
      const current = deps.config();
      const active = current.workspaces ?? [];
      const already = active.includes(resolved);
      const wasArchived = (current.archivedWorkspaces ?? []).includes(resolved);
      if (!already || wasArchived) {
        deps.updateConfig({
          ...(already ? {} : { workspaces: [...active, resolved] }),
          ...(wasArchived ? { archivedWorkspaces: (current.archivedWorkspaces ?? []).filter((w) => w !== resolved) } : {}),
        });
      }
      return {
        content:
          (already
            ? `Workspace already registered: ${resolved} (no changes).`
            : `Created workspace ${resolved} and registered it in config.`) +
          `\nConfirmed location: ${confirmed.trim()}` +
          `\nIt now appears in the Workspace section — new code sessions can root there. ` +
          `The user can open it from the workspace list (or the tool node's "Open workspace" action in the webui).`,
        meta: {
          workspace: resolved,
          title: `Workspace: ${name}`,
          // Retained Q&A — the transcript renders the confirmed path as a
          // re-openable review (same contract as the question tool).
          questions: [{ header: "Workspace folder", question: prompt, answers: [confirmed.trim()] }],
        },
      };
    },
  };
}
