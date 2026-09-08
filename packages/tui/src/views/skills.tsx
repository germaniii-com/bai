import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import { spawnSync } from "node:child_process";
import type { BaiClient } from "@bai/api/client";
import type { Session, SkillInfo, SkillUsageTotals } from "@bai/shared";
import { listWindow, PromptDialog } from "../components/dialog";
import { Markdown } from "../components/markdown";
import { useTheme } from "../theme";

/** List rows shown around the cursor (SelectDialog parity). */
const WINDOW = 12;
/** Detail view cap — the rest is one $EDITOR press away. */
const DETAIL_LINES = 60;

/**
 * Skills manager (the agent-manager pattern): list, view (enter), edit in
 * $EDITOR (e), create (n), delete with confirm (d), and learn (l) — the
 * learn action spawns a visible learn session via the API and hands it to
 * the App to switch to, so the user watches the agent distill the skill.
 * `catalogTick` bumps whenever skills.updated arrives on the firehose,
 * keeping the list fresh while the dialog is open.
 */
export function SkillsDialog({
  client,
  catalogTick,
  onLearned,
  onDone,
}: {
  client: BaiClient;
  catalogTick: number;
  /** The learn session was spawned — the App switches to it. */
  onLearned: (session: Session) => void;
  onDone: () => void;
}) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [index, setIndex] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [learnOpen, setLearnOpen] = useState(false);
  const [detail, setDetail] = useState<{ skill: SkillInfo; usage: SkillUsageTotals | null } | null>(null);
  const t = useTheme();

  const refresh = useCallback(async () => {
    try {
      setSkills(await client.listSkills());
      setNotice(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh, catalogTick]);

  // Keep the cursor in bounds as the list changes.
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, skills.length - 1)));
  }, [skills.length]);

  const openEditor = useCallback((path: string | undefined) => {
    if (path === undefined) return;
    const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
    // Inherit stdio so the editor owns the terminal; the watcher reloads on save.
    const result = spawnSync(editor, [path], { stdio: "inherit" });
    if (result.status !== 0) setNotice(`editor exited with ${result.status ?? "signal"}`);
    void refresh();
  }, []);

  /** Toggle the detail view for the highlighted skill (body + usage). */
  const toggleDetail = useCallback(async () => {
    if (detail !== null) {
      setDetail(null);
      return;
    }
    const skill = skills[index];
    if (skill === undefined) return;
    try {
      const got = await client.getSkill(skill.name);
      if (got !== undefined) setDetail({ skill: got.skill, usage: got.usage });
      else setNotice(`"${skill.name}" vanished — refresh with r`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }, [client, skills, index, detail]);

  const createSkill = useCallback(async () => {
    const name = `skill-${Date.now().toString(36)}`;
    try {
      await client.putSkill(name, {
        description: `What the ${name} skill does, in one sentence.`,
        body: `# ${name}\n\nDescribe the workflow here: when to use it, the steps to follow, and how to verify the result.\n\nSupporting files can live in references/, templates/, scripts/, and assets/ — the agent reads them on demand via skills.view(name, path).`,
      });
      const created = await client.getSkill(name);
      openEditor(created?.skill.path);
      void refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }, [client, openEditor, refresh]);

  const deleteSkill = useCallback(
    async (name: string) => {
      try {
        await client.deleteSkill(name);
        setDetail(null);
        setNotice(null);
        void refresh();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    },
    [client, refresh],
  );

  const startLearn = useCallback((request: string) => {
    const trimmed = request.trim();
    if (trimmed.length === 0) {
      setNotice("describe what to learn — a fresh learn session can't see this conversation");
      return;
    }
    setLearnOpen(false);
    void (async () => {
      try {
        const session = await client.learnSkill({ request: trimmed });
        onLearned(session);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [client, onLearned]);

  useInput((ch, key) => {
    if (learnOpen) return; // the nested PromptDialog owns the keys
    if (confirmDelete !== null) {
      if (ch === "y") {
        const name = confirmDelete;
        setConfirmDelete(null);
        void deleteSkill(name);
      } else if (ch === "n" || key.escape) {
        setConfirmDelete(null);
      }
      return;
    }
    if (key.escape || (key.ctrl && ch === "a")) {
      onDone();
      return;
    }
    if (key.upArrow || ch === "k") {
      setDetail(null);
      setIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow || ch === "j") {
      setDetail(null);
      setIndex((i) => Math.min(skills.length - 1, i + 1));
    } else if (key.return) {
      void toggleDetail();
    } else if (ch === "e" && skills[index] !== undefined) {
      setDetail(null);
      openEditor(skills[index]?.path);
    } else if (ch === "n") {
      void createSkill();
    } else if (ch === "d" && skills[index] !== undefined) {
      setConfirmDelete(skills[index]?.name ?? null);
    } else if (ch === "l") {
      setLearnOpen(true);
    } else if (ch === "r") {
      void refresh();
    }
  });

  const highlighted = skills[index];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.border} borderBackgroundColor={t.background} paddingX={1}>
      <Text bold color={t.text}>
        skills <Text color={t.dim}>(enter view · e edit · n new · d delete · l learn · esc close)</Text>
      </Text>
      {detail === null &&
        (() => {
          const { start, end } = listWindow(index, skills.length, WINDOW);
          const windowed = skills.slice(start, end);
          return (
            <>
              {start > 0 && <Text color={t.dim}>  ↑ {start} more</Text>}
              {windowed.map((skill, i) => {
                const absolute = start + i;
                return (
                  <Text key={skill.name} color={absolute === index ? t.accent : t.text}>
                    {absolute === index ? "❯ " : "  "}
                    {skill.name}{" "}
                    <Text color={t.dim}>
                      ({skill.tags !== undefined && skill.tags.length > 0 ? skill.tags.slice(0, 3).join(", ") : "skill"}
                      {skill.linkedFiles.length > 0 ? ` · ${skill.linkedFiles.length} file${skill.linkedFiles.length === 1 ? "" : "s"}` : ""})
                    </Text>
                  </Text>
                );
              })}
              {end < skills.length && <Text color={t.dim}>  ↓ {skills.length - end} more</Text>}
              {skills.length === 0 && <Text color={t.dim}>  (no skills yet — n to create, l to learn one)</Text>}
            </>
          );
        })()}
      {detail !== null && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={t.accent}>
            {detail.skill.name}{" "}
            <Text color={t.dim}>
              {detail.usage !== null
                ? `· ${detail.usage.views} view${detail.usage.views === 1 ? "" : "s"} · ${detail.usage.sessions} session${detail.usage.sessions === 1 ? "" : "s"}${
                    detail.usage.lastUsedAt !== undefined ? ` · last used ${new Date(detail.usage.lastUsedAt).toLocaleString()}`
                  : " · never used"}`
                : ""}
            </Text>
          </Text>
          {detail.skill.linkedFiles.length > 0 && (
            <Text color={t.dim}>  files: {detail.skill.linkedFiles.join(", ")}</Text>
          )}
          <Box marginTop={1} flexDirection="column">
            {(() => {
              const lines = detail.skill.body.split("\n");
              const shown = lines.slice(0, DETAIL_LINES).join("\n");
              return (
                <>
                  <Markdown text={shown} />
                  {lines.length > DETAIL_LINES && (
                    <Text color={t.dim}>… {lines.length - DETAIL_LINES} more lines — e to edit in $EDITOR</Text>
                  )}
                </>
              );
            })()}
          </Box>
          <Text color={t.dim}> </Text>
          <Text color={t.dim}>enter back · e edit ($EDITOR) · d delete · esc close</Text>
        </Box>
      )}
      {detail === null && (
        <Text color={t.dim}> </Text>
      )}
      {detail === null && (
        <Text color={t.dim}>n new · e edit ($EDITOR) · d delete · l learn (spawn a learn session) · r refresh · j/k move · esc close</Text>
      )}
      {confirmDelete !== null && <Text color={t.warning}>delete "{confirmDelete}"? y/n</Text>}
      {notice !== null && <Text color={t.warning}>{notice}</Text>}
      {learnOpen && (
        <PromptDialog
          title="learn a skill"
          placeholder="what would you like to learn? (sources, URLs, a workflow…)"
          onSubmit={startLearn}
          onClose={() => setLearnOpen(false)}
        />
      )}
      {highlighted === undefined && detail === null && !learnOpen && confirmDelete === null && (
        <Text color={t.dim}> </Text>
      )}
    </Box>
  );
}
