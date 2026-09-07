import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * D26 enforcement (docs/ARCHITECTURE.md §17): EVERY LLM call — present or
 * future — must record a kind-tagged usage row through
 * `RunCoordinator.recordLlmUsage`. Analytics completeness is by
 * construction: a new `provider.stream(...)` call site that skips capture
 * fails this test and points the author at the invariant.
 *
 * The scan looks for `provider.stream(` — the shape every call site uses
 * (the run loop's `run.provider.stream`, the title/compaction refines'
 * `summarizer.provider.stream` / `input.provider.stream`). Adapter files
 * define `stream(` as a method (never `provider.stream(`), so vendor SDK
 * internals don't trip it. If a future call site uses a different variable
 * name, keep the `provider.stream(` convention or extend the scan here.
 */

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("D26 — every LLM call site records usage", () => {
  test("each file calling provider.stream( also invokes recordLlmUsage", () => {
    const srcDir = join(import.meta.dir, "..", "src");
    const violations: string[] = [];
    for (const file of walk(srcDir)) {
      const code = readFileSync(file, "utf8");
      if (!code.includes("provider.stream(")) continue;
      if (!code.includes("recordLlmUsage")) {
        violations.push(file.replace(srcDir + "/", ""));
      }
    }
    expect(
      violations,
      `LLM call site(s) without usage capture (D26 — route them through RunCoordinator.recordLlmUsage): ${violations.join(", ")}`,
    ).toEqual([]);
  });
});
