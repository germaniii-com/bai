/**
 * Opaque, URL-safe keyset cursors for paged list reads.
 *
 * A cursor is base64url-encoded JSON — clients treat it as a black box and
 * pass it back verbatim as `?before=<cursor>`. Encode/decode are total
 * (decode returns undefined on malformed input) so a bad cursor is a clean
 * 400, never a crash.
 */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor<T>(raw: string): T | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as T;
  } catch {
    return undefined;
  }
}

/** Escape `%`, `_`, and `\` for a SQL `LIKE … ESCAPE '\'` pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
