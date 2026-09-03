import type { PermissionAction } from "@bai/shared";

/**
 * Pattern match for permission rules: dot-separated segments; `*` matches one
 * segment, or the whole remainder when it is the last segment
 * (`bash.*` matches `bash.run`, `fs.*` matches `fs.read`).
 */
export function patternMatches(pattern: string, tool: string): boolean {
  if (pattern === "*") return true;
  const pat = pattern.split(".");
  const parts = tool.split(".");
  for (let i = 0; i < pat.length; i++) {
    const seg = pat[i] as string;
    if (seg === "*") {
      if (i === pat.length - 1) return true; // trailing wildcard: match rest
      if (i >= parts.length) return false;
      continue;
    }
    if ((parts[i] ?? "") !== seg) return false;
  }
  return pat.length === parts.length;
}

/**
 * Evaluate a tool name against ordered rule layers (defaults < global <
 * project < session approvals). Last matching pattern wins; unmatched → ask.
 */
export function evaluatePermission(
  tool: string,
  layers: Array<Record<string, PermissionAction>>,
): { action: PermissionAction; rule?: string } {
  let action: PermissionAction = "ask";
  let rule: string | undefined;
  for (const layer of layers) {
    for (const [pattern, act] of Object.entries(layer)) {
      if (patternMatches(pattern, tool)) {
        action = act;
        rule = pattern;
      }
    }
  }
  return rule !== undefined ? { action, rule } : { action };
}
