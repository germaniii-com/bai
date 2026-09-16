/**
 * JSONC tolerance: strip line and block comments that appear outside string
 * literals, so hand-edited config/provider files parse with `JSON.parse`.
 * Lives in `@bai/shared` because both core's config loader and the provider
 * package's file registry need it.
 */
export function stripJsonComments(src: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    const next = src[i + 1] as string | undefined;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++; // skip trailing '/'
      continue;
    }
    out += ch;
  }
  return out;
}
