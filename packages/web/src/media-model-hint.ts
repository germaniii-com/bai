import type { MediaMode, MediaModelInfo } from "@bai/shared";

/** `t2i` → "T2I", `i2i` → "I2I". */
export function modeLabel(mode: MediaMode): string {
  return mode === "t2i" ? "T2I" : "I2I";
}

/** Every field of a {@link MediaModelInfo}, compacted for a dropdown row. */
export function modelOptionHint(model: MediaModelInfo): string {
  const parts: string[] = [];
  if (model.label !== undefined && model.label !== model.id) parts.push(model.label);
  parts.push(model.modes.map(modeLabel).join("/"));
  parts.push(`refs≤${model.maxReferences}`);
  parts.push(`n≤${model.maxCount}`);
  if (model.rates !== undefined && model.rates.length > 0) {
    parts.push(model.rates.map((r) => `${r.label} ${r.value}`).join(", "));
  }
  return parts.join(" · ");
}
