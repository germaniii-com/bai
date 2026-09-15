import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The web component contract, machine-enforced.
 *
 * 1. Screens must not render raw <button>/<input>/<select>/<textarea> — they
 *    compose the library in src/components/. A genuinely bespoke control is
 *    allowed only with a `@ui-raw: <reason>` comment in the 3 lines above it.
 * 2. Styles must not hardcode corner radii or elevation outside `:root`;
 *    components use the role tokens (--radius-control/card/modal,
 *    --shadow-popover/modal).
 * 3. The role + motion tokens exist.
 *
 * Run: `bun test` in packages/web.
 */

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

/** Every .ts/.tsx under src/ except the library itself (src/components/). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "components") continue;
      out.push(...walk(full));
    } else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const RAW_CONTROL = /<(button|input|select|textarea)\b/;

describe("component contract", () => {
  test("no raw form controls/buttons outside src/components (unless annotated @ui-raw)", () => {
    const offenders: string[] = [];
    for (const file of walk(srcDir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        // Skip matches that only appear inside a comment.
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        if (!RAW_CONTROL.test(line)) return;
        const context = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
        if (context.includes("@ui-raw")) return;
        offenders.push(`${file.slice(srcDir.length)}:${i + 1}: ${trimmed}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("no raw corner radii or elevation shadows outside :root", () => {
    for (const rel of ["../src/styles.css", "../src/components/components.css"]) {
      const path = fileURLToPath(new URL(rel, import.meta.url));
      const css = readFileSync(path, "utf8").replace(/:root\s*\{[\s\S]*?\n\}/, "");

      const badRadius = [...css.matchAll(/border-radius:\s*([^;]+);/g)]
        .map((m) => m[0])
        .filter((decl) => /[0-9]+px/.test(decl) && !/var\(|calc\(/.test(decl));

      const badShadow = [...css.matchAll(/box-shadow:\s*([^;]+);/g)]
        .map((m) => m[0])
        .filter((decl) => /[0-9]+px/.test(decl) && !/inset/.test(decl) && !/var\(/.test(decl));

      expect({ file: rel, badRadius }).toEqual({ file: rel, badRadius: [] });
      expect({ file: rel, badShadow }).toEqual({ file: rel, badShadow: [] });
    }
  });

  test("role + motion tokens are defined in :root", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
    for (const token of [
      "--radius-control:",
      "--radius-card:",
      "--radius-modal:",
      "--shadow-popover:",
      "--shadow-modal:",
      "--duration-fast:",
      "--duration-normal:",
      "--duration-slow:",
      "--ease-standard:",
      "--ease-out:",
    ]) {
      expect(css).toContain(token);
    }
  });
});
