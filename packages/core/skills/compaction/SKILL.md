---
description: Compact a long session before its context window fills.
version: 1.0.0
author: bai
tags: [Context, Compaction, Sessions]
---

# Compaction

Keep a long session useful when its context fills: bai auto-compacts at **~75%** of the model's context window, replacing the older transcript with a reference-only summary while the recent tail stays verbatim. This skill covers how to work with that system — what the summary keeps, where durable state must live, and how to write a manual handoff when you want one.

It does NOT cover token discipline (identical-result stubbing and old-result pruning already happen automatically at render time), and it can NOT trigger the automatic compaction — that fires on its own from provider-reported usage.

## When to Use

- A session is running long and you want to avoid losing work at the next compaction.
- The user asks why you "forgot" something from earlier in the conversation.
- You are about to start a context-heavy step (a big exploration, a long file read) in an already-full session.
- You want a clean handoff summary before switching agents or delegating a large task.

## Prerequisites

- The session-artifact tools: `notes.read` / `notes.write` (the Notes panel), `plan.read` / `plan.write` (the Plans panel), and `todo` (the Checklist).
- `skills.view` to load this skill — only agents whose tool set includes it see the compaction entry in the index.

## How to Run

1. Recognize the risk: a long transcript, many large tool results, or a pending multi-step task.
2. Move durable state OUT of the conversation and into the artifacts that survive compaction: the goal and next steps into the plan, the running findings into the notes, the open items into the todo list.
3. Keep exact identifiers — file paths, symbol names, commands, error strings — in those artifacts, never only in prose the summarizer may compress.
4. For a manual compact, write the structured handoff below into `notes.write` (read the note first and write the FULL note back) and continue from it.
5. After any compaction, re-read the plan/notes before acting — the summary is reference-only and may compress detail.

## Quick Reference

- Trigger: provider-reported input ≥ **75%** of the context window (80K floor when the window is unknown).
- Summary sections: Goal · Progress · Key Decisions · Next Steps · Critical Context.
- Appendix: `<read-files>` / `<modified-files>` / `<attached-files>` harvested from tool calls.
- Preserved verbatim: the recent tail after the trigger point.
- Durable survivors: session notes, plans, todos, skills — anything on disk.
- Summary framing: `[Context summary of earlier conversation — REFERENCE ONLY...]`.

## Procedure

1. **Check what is at risk.** Scan the transcript for decisions, paths, and constraints the next compaction would compress. Anything you would be upset to lose gets moved to an artifact now.
2. **Write the handoff.** Use `notes.write` with the FULL note:
   - Goal — what the user is trying to accomplish
   - Progress — done, in progress, blocked
   - Key Decisions — choices made and why
   - Next Steps — the immediate next actions
   - Critical Context — exact paths, symbols, commands, errors
3. **Compact breadth, not correctness.** Summarize many low-value tool results in one line instead of pasting raw output; never invent a path or flag to shorten prose.
4. **Re-anchor after compaction.** The summary leads the next turn as reference-only: respond to the latest user message, not to old tasks the summary mentions.
5. **Keep the session lean going forward.** Batch independent lookups, avoid re-reading unchanged files, delegate open-ended exploration to a `task` subagent, and spill large outputs to a file instead of carrying them in the transcript.

## Pitfalls

- Relying on conversation memory: the summary compresses; the plan and notes do not.
- Treating the auto-generated summary as instructions — it is reference material for the model that wrote it.
- Re-reading files or re-running searches just to rebuild context you already summarized — trust the artifacts.
- Letting a huge tool result land with no use: write it to a file and cite the path.
- Assuming the automatic compaction can be forced — it cannot; write a manual handoff if you need one now.
- Forgetting the appendix lists paths, not contents — re-read a file before editing it after a compaction.

## Verification

A compaction is lossless when the plan holds the goal and next steps, the notes hold the findings with exact identifiers, and the todo list holds the open items — so work resumes from those artifacts without re-deriving anything from the conversation.
