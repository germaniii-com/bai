/**
 * Pure cursor-aware editor model for the chat composer (and reusable by any
 * text input). No rendering, no Ink — every operation is a string slice, so
 * the composer's behavior is unit-testable without a terminal.
 *
 * Cursor semantics:
 * - `cursor` is a code-unit offset, invariant `0 <= cursor <= text.length`.
 * - Movement and deletion are surrogate-pair aware (astral letters like
 *   emoji move/delete as one unit); grapheme clusters (ZWJ sequences) are
 *   still split — accepted trade-off for a terminal composer.
 * - "Line" operations are relative to the line containing the cursor
 *   (readline/vim semantics), not the whole draft.
 */

/** Cursor-aware draft state. */
export interface Editor {
  text: string;
  cursor: number;
}

/** Start/end offsets of the line containing `cursor`. */
function lineBounds(text: string, cursor: number): [number, number] {
  const start = text.lastIndexOf("\n", cursor - 1) + 1;
  const nl = text.indexOf("\n", cursor);
  const end = nl === -1 ? text.length : nl;
  return [start, end];
}

/** Code-unit width of the character ending at offset `i` (surrogate pairs). */
function charWidthBefore(text: string, i: number): number {
  if (i >= 2) {
    const low = text.charCodeAt(i - 1);
    const high = text.charCodeAt(i - 2);
    if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) return 2;
  }
  return 1;
}

/** Code-unit width of the character starting at offset `i` (surrogate pairs). */
function charWidthAt(text: string, i: number): number {
  if (i + 1 < text.length) {
    const high = text.charCodeAt(i);
    const low = text.charCodeAt(i + 1);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) return 2;
  }
  return 1;
}

/**
 * Readline `unix-word-rubout`: skip whitespace backward, then the word before
 * it. "abc def" → "abc " (the separating space survives; the next press eats
 * it) — matches bash exactly.
 */
export function deleteWord(text: string): string {
  let i = text.length;
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
  return text.slice(0, i);
}

/** Strip C0 control characters except tab and newline (paste/typed-chunk sanitizer). */
export function sanitize(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Literal insert at the cursor (newlines included — the paste path). */
export function insert(e: Editor, str: string): Editor {
  if (str.length === 0) return e;
  return {
    text: e.text.slice(0, e.cursor) + str + e.text.slice(e.cursor),
    cursor: e.cursor + str.length,
  };
}

/**
 * Typed-text insert: `\n` inside `str` opens a line below the cursor's line
 * (vim o) instead of splitting mid-line — a lone "\n" chunk is ctrl+j in
 * legacy terminals, so typed newlines must be structural, not literal.
 */
export function insertMultiline(e: Editor, str: string): Editor {
  let out = e;
  const segments = str.split("\n");
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) out = openBelow(out);
    const segment = segments[i]!;
    if (segment.length > 0) out = insert(out, segment);
  }
  return out;
}

/** Delete the character before the cursor. */
export function backspace(e: Editor): Editor {
  if (e.cursor === 0) return e;
  const n = charWidthBefore(e.text, e.cursor);
  return {
    text: e.text.slice(0, e.cursor - n) + e.text.slice(e.cursor),
    cursor: e.cursor - n,
  };
}

/** Delete the character under the cursor (forward delete). */
export function deleteForward(e: Editor): Editor {
  if (e.cursor >= e.text.length) return e;
  const n = charWidthAt(e.text, e.cursor);
  return {
    text: e.text.slice(0, e.cursor) + e.text.slice(e.cursor + n),
    cursor: e.cursor,
  };
}

/** ctrl+w: delete the word before the cursor (readline semantics). */
export function deleteWordBefore(e: Editor): Editor {
  const prefix = deleteWord(e.text.slice(0, e.cursor));
  return { text: prefix + e.text.slice(e.cursor), cursor: prefix.length };
}

/** vim o: open an empty line below the cursor's line; cursor moves onto it. */
export function openBelow(e: Editor): Editor {
  const [, end] = lineBounds(e.text, e.cursor);
  return {
    text: e.text.slice(0, end) + "\n" + e.text.slice(end),
    cursor: end + 1,
  };
}

/** vim O: open an empty line above the cursor's line; cursor moves onto it. */
export function openAbove(e: Editor): Editor {
  const [start] = lineBounds(e.text, e.cursor);
  return {
    text: e.text.slice(0, start) + "\n" + e.text.slice(start),
    cursor: start,
  };
}

/** Move the cursor one character left (no wrap across lines). */
export function moveLeft(e: Editor): Editor {
  if (e.cursor === 0) return e;
  return { ...e, cursor: e.cursor - charWidthBefore(e.text, e.cursor) };
}

/** Move the cursor one character right (no wrap across lines). */
export function moveRight(e: Editor): Editor {
  if (e.cursor >= e.text.length) return e;
  return { ...e, cursor: e.cursor + charWidthAt(e.text, e.cursor) };
}

/** Home: start of the cursor's line. */
export function moveLineStart(e: Editor): Editor {
  const [start] = lineBounds(e.text, e.cursor);
  return { ...e, cursor: start };
}

/** End: end of the cursor's line (before its newline, if any). */
export function moveLineEnd(e: Editor): Editor {
  const [, end] = lineBounds(e.text, e.cursor);
  return { ...e, cursor: end };
}

/**
 * Up: one line up, keeping the column when the line above is long enough
 * (clamped to its end otherwise). No-op on the first line.
 */
export function moveLineUp(e: Editor): Editor {
  const [start] = lineBounds(e.text, e.cursor);
  if (start === 0) return e; // already on the first line
  const column = e.cursor - start;
  // The previous line spans [prevStart, start - 1); the \n at start - 1
  // terminates it. lastIndexOf from start - 2 finds its opening (or -1 → 0).
  const prevStart = e.text.lastIndexOf("\n", start - 2) + 1;
  const prevLineLen = start - 1 - prevStart;
  return { ...e, cursor: prevStart + Math.min(column, prevLineLen) };
}

/**
 * Down: one line down, keeping the column when possible (clamped to the
 * line's end). No-op on the last line.
 */
export function moveLineDown(e: Editor): Editor {
  const [start, end] = lineBounds(e.text, e.cursor);
  if (end >= e.text.length) return e; // already on the last line
  const column = e.cursor - start;
  const nextStart = end + 1;
  const nextNl = e.text.indexOf("\n", nextStart);
  const nextLineLen = (nextNl === -1 ? e.text.length : nextNl) - nextStart;
  return { ...e, cursor: nextStart + Math.min(column, nextLineLen) };
}
