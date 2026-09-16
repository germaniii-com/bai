/**
 * The generic custom-provider mapping engine: request-body interpolation and
 * response path reading. Pure + dependency-free, so it is trivially unit
 * tested and safe to run inside the media job executor.
 *
 * Request tokens (string leaves of the body template):
 *   `$prompt $model $count $mode $width $height $seed $param.<key>`
 * A leaf that is exactly one token keeps the token's native type (number /
 * boolean); tokens embedded in a larger string are stringified. Unknown tokens
 * are left verbatim (so `$5` prices survive).
 *
 * Response paths are a tiny JSON path: `a.b`, `a[0]`, `a[*]`.
 */

import type { MediaParamValue } from "@bai/shared";

export interface MappingVars {
  prompt: string;
  model: string;
  count: number;
  mode: "t2i" | "i2i";
  width?: number;
  height?: number;
  seed?: number;
  params: Record<string, MediaParamValue>;
}

const SINGLE_TOKEN = /^\$([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)$/i;
const TOKEN = /\$([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)/gi;

/** Recursively interpolate `$`-tokens in a JSON template. */
export function interpolate(template: unknown, vars: MappingVars): unknown {
  if (typeof template === "string") return interpolateString(template, vars);
  if (Array.isArray(template)) return template.map((v) => interpolate(v, vars));
  if (template !== null && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) out[key] = interpolate(value, vars);
    return out;
  }
  return template;
}

function interpolateString(value: string, vars: MappingVars): unknown {
  const single = SINGLE_TOKEN.exec(value);
  if (single !== null) {
    const resolved = resolveToken(single[1] as string, vars);
    return resolved === undefined ? value : resolved;
  }
  return value.replace(TOKEN, (match, name: string) => {
    const resolved = resolveToken(name, vars);
    return resolved === undefined ? match : String(resolved);
  });
}

function resolveToken(name: string, vars: MappingVars): unknown {
  switch (name) {
    case "prompt":
      return vars.prompt;
    case "model":
      return vars.model;
    case "count":
      return vars.count;
    case "mode":
      return vars.mode;
    case "width":
      return vars.width;
    case "height":
      return vars.height;
    case "seed":
      return vars.seed;
    default:
      if (name.startsWith("param.")) return vars.params[name.slice("param.".length)];
      return undefined;
  }
}

/**
 * Read a value from a decoded response with a tiny path syntax.
 * Supports dot segments (`usage.cost`), indexes (`data[0]`) and wildcards
 * (`data[*].url`). Wildcards flatten one level; a missing path yields
 * `undefined`.
 */
export function readPath(root: unknown, path: string): unknown {
  const parts = path.split(".").filter((p) => p.length > 0);
  let current: unknown[] = [root];
  for (const part of parts) {
    const match = /^([^[\]]*)((?:\[[^\]]*\])*)$/.exec(part);
    const name = match?.[1] ?? "";
    const indexes = match?.[2] ?? "";
    if (name.length > 0) {
      current = current.map((c) => (isRecord(c) ? c[name] : undefined));
    }
    const indexRe = /\[([^\]]*)\]/g;
    let index: RegExpExecArray | null;
    while ((index = indexRe.exec(indexes)) !== null) {
      const token = index[1] ?? "";
      if (token === "*") {
        current = current.flatMap((c) => (Array.isArray(c) ? c : []));
      } else {
        const n = Number(token);
        current = Number.isInteger(n) ? current.map((c) => (Array.isArray(c) ? c[n] : undefined)) : current;
      }
    }
  }
  return current.length === 1 ? current[0] : current;
}

/** Normalize a path result to an array (a single object/primitive wraps). */
export function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
