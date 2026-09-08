---
description: Review code changes with an evidence-first checklist.
version: 1.0.0
author: bai
tags: [Code Review, Quality, Checklist]
---

# Code Review

A structured review pass over code changes: read the diff in context, check it against a fixed checklist, and report findings with file/line evidence. Read-only — reviews never edit the workspace.

This skill covers the review method. It does NOT replace project-specific conventions; when the repo has an AGENTS.md or CONTRIBUTING.md, its rules outrank this checklist.

## When to Use

- The user asks to review a diff, a PR, or recent changes.
- You finished an implementation and want a self-review before declaring done.
- You are the subagent reviewing another agent's work.

## Prerequisites

- Read-only tools: `fs.read`, `fs.list`, `fs.glob`, `fs.grep` (and `bash` with `git diff` when the changes are uncommitted).
- The change under review: a diff, a commit range, or a set of files the user names.

## How to Run

1. Establish the change surface: `git diff` / `git diff --stat` (via `bash`) or the file list the user gave.
2. Read every changed file IN FULL — never review a hunk without its surrounding context.
3. Walk the checklist below; note each finding as file:line + one-sentence why.
4. Report: verdict first (approve / request changes), then findings ordered by severity, then nits.

## Quick Reference

Severity order: correctness bugs → security → API/contract breaks → tests → error handling → performance → style nits.

## Procedure

1. **Correctness**: does the code do what the change claims? Trace the main path end-to-end; check edge cases the diff touches (empty, zero, negative, huge, concurrent, error paths).
2. **Security**: unvalidated input reaching exec/SQL/fs paths; secrets logged; new attack surface (endpoints, deserialization, path traversal). Check any user-supplied path resolves where it claims.
3. **Contracts**: renamed/moved exports, changed function signatures, changed response shapes — grep for every caller of the changed symbols and confirm each was updated.
4. **Tests**: do the changes come with tests that would FAIL without them? Do existing tests still assert the right behavior (updated, not deleted)?
5. **Error handling**: new failure modes handled or propagated? Swallowed errors (`catch {}`) justified? User-facing error messages actionable?
6. **Consistency**: naming, patterns, and structure match the surrounding code and the repo's conventions.
7. **Performance**: only flag what this change makes materially worse (N+1 queries, unbounded loops, large sync I/O) — not hypothetical scale.

## Pitfalls

- Reviewing the diff without reading the whole file — context bugs hide outside the hunks.
- Style opinions dressed as blockers — put them in nits, not the verdict.
- "Looks good" without tracing the main path is not a review.
- Flagging pre-existing issues as if this change caused them — note them separately or not at all.
- Trusting names: a function called `validate` may not validate. Read the body.

## Verification

The report names a verdict, every finding carries file:line evidence, and no finding is an opinion without a rule behind it.
