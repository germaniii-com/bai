import { Box, Text } from "ink";
import { useMemo, type ReactNode } from "react";
import { Marked, type Token, type Tokens } from "marked";

/**
 * Markdown renderer for assistant replies and thinking transcripts,
 * modeled on pi's token-walk approach (marked lexer → styled Ink nodes)
 * with opencode's per-element color treatment: headings/strong/lists
 * colored, quotes dim-railed, code blocks boxed — no syntax highlighting,
 * no theme system (one hardcoded palette), no OSC-8 links.
 *
 * The palette below is opencode's dark `markdown*` theme mapping
 * (opencode/packages/tui/src/theme/assets/opencode.json), expressed as hex
 * colors — Ink maps them to the nearest terminal color.
 *
 * Streaming feeds PARTIAL text on every delta; the marked lexer tolerates
 * unterminated fences and unclosed emphasis, so partial input degrades to
 * plain text gracefully. Parsing is memoized on the text string.
 */

const THEME = {
  heading: "#9d7cd8", // markdownHeading (accent)
  strong: "#f5a742", // markdownStrong
  emph: "#e5c07b", // markdownEmph
  quote: "#e5c07b", // markdownBlockQuote
  quoteBorder: "#808080", // rail
  code: "#7fd88f", // markdownCode (inline)
  link: "#56b6c2", // markdownLinkText
  linkUrl: "#808080", // dim URL
  bullet: "#fab283", // markdownListItem
  enumeration: "#56b6c2", // markdownListEnumeration (also table headers)
  rule: "#808080", // markdownHorizontalRule
  codeBorder: "#808080", // code block containment
};

// One lexer instance for the app; lex() is stateless (no async extensions).
const LEXER = new Marked({ gfm: true });

export function Markdown({ text, marker, dim = false }: { text: string; marker?: ReactNode; /** Thinking bodies render dim overall. */ dim?: boolean }) {
  // Blocks are memoized on content: streaming re-renders every frame but
  // only re-lexes when the text actually changed.
  const blocks = useMemo(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    return renderBlocks(LEXER.lexer(trimmed), "md", dim, undefined, true);
  }, [text, dim]);
  if (blocks === null) return null;
  // Focused nodes render the ❯ marker as a hanging-indent column: the body
  // wraps in the remaining width, aligned under the marker's first line.
  if (marker !== undefined) {
    return (
      <Box flexDirection="row" flexShrink={0}>
        <Box flexShrink={0}>{marker}</Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {blocks}
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" flexShrink={0}>
      {blocks}
    </Box>
  );
}

/** The raw text of any token (falls back to empty — never print `[object]`). */
function textOf(token: Token): string {
  const raw = (token as { text?: unknown }).text;
  return typeof raw === "string" ? raw : "";
}

/** Inline tokens → styled Ink `<Text>` fragments (strings allowed inside). */
function renderInline(tokens: Token[] | undefined, keyPrefix: string, dim: boolean): ReactNode[] {
  if (tokens === undefined || tokens.length === 0) return [];
  return tokens.map((token, i) => {
    const key = `${keyPrefix}:${i}`;
    switch (token.type) {
      case "strong":
        return (
          <Text key={key} bold color={THEME.strong} dimColor={dim}>
            {renderInline(token.tokens, key, dim)}
          </Text>
        );
      case "em":
        return (
          <Text key={key} italic color={THEME.emph} dimColor={dim}>
            {renderInline(token.tokens, key, dim)}
          </Text>
        );
      case "del":
        return (
          <Text key={key} strikethrough dimColor>
            {renderInline(token.tokens, key, dim)}
          </Text>
        );
      case "codespan":
        return (
          <Text key={key} color={THEME.code} dimColor={dim}>
            {token.text}
          </Text>
        );
      case "link":
        return (
          <Text key={key}>
            <Text color={THEME.link} dimColor={dim}>
              {token.tokens !== undefined && token.tokens.length > 0 ? renderInline(token.tokens, key, dim) : textOf(token)}
            </Text>
            {token.href.length > 0 && <Text dimColor> ({token.href})</Text>}
          </Text>
        );
      case "image":
        return (
          <Text key={key}>
            <Text color={THEME.link} dimColor={dim}>
              ![{textOf(token)}]
            </Text>
            {token.href.length > 0 && <Text dimColor> ({token.href})</Text>}
          </Text>
        );
      case "br":
        return "\n";
      case "escape":
      case "html":
        // No HTML interpretation in the terminal — print the literal text.
        return textOf(token);
      case "text": {
        const nested = (token as Tokens.Text).tokens;
        if (nested !== undefined && nested.length > 0) {
          return <Text key={key}>{renderInline(nested, key, dim)}</Text>;
        }
        return textOf(token);
      }
      default:
        return textOf(token);
    }
  });
}

/**
 * Block tokens → a column of Ink boxes. `spaced` inserts one blank row
 * between top-level blocks (list items and quote interiors render tight).
 */
function renderBlocks(
  tokens: Token[],
  keyPrefix: string,
  dim: boolean,
  baseColor: string | undefined,
  spaced: boolean,
): ReactNode[] {
  return tokens.flatMap((token, i): ReactNode[] => {
    const key = `${keyPrefix}:${i}`;
    const mt = spaced && i > 0 ? 1 : 0;
    switch (token.type) {
      case "space":
      case "def":
        return [];
      case "heading": {
        const heading = token as Tokens.Heading;
        return [
          <Box key={key} marginTop={mt} flexShrink={0}>
            <Text bold color={THEME.heading} dimColor={dim} wrap="wrap">
              {renderInline(heading.tokens, key, dim)}
            </Text>
          </Box>,
        ];
      }
      case "paragraph":
      case "text": {
        // Block-level "text" tokens appear in loose list items / tight lists.
        const content =
          "tokens" in token && Array.isArray(token.tokens) && token.tokens.length > 0
            ? renderInline(token.tokens, key, dim)
            : textOf(token);
        return [
          <Box key={key} marginTop={mt} flexShrink={0}>
            <Text wrap="wrap" color={baseColor} dimColor={dim}>
              {content}
            </Text>
          </Box>,
        ];
      }
      case "code": {
        const code = token as Tokens.Code;
        return [
          <Box key={key} marginTop={mt} flexShrink={0} flexDirection="column" borderStyle="round" borderColor={THEME.codeBorder} paddingX={1}>
            {code.lang !== undefined && code.lang.length > 0 && <Text dimColor>{code.lang}</Text>}
            <Text wrap="wrap">{code.text.replace(/\n$/, "")}</Text>
          </Box>,
        ];
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        return [
          <Box
            key={key}
            marginTop={mt}
            flexShrink={0}
            borderStyle="single"
            borderLeft
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            borderColor={THEME.quoteBorder}
            paddingLeft={1}
          >
            {renderBlocks(quote.tokens ?? [], key, dim, THEME.quote, false)}
          </Box>,
        ];
      }
      case "list":
        return [renderList(token as Tokens.List, key, dim, baseColor, mt)];
      case "hr":
        return [
          <Box key={key} marginTop={mt} flexShrink={0}>
            <Text dimColor wrap="truncate">
              {"─".repeat(60)}
            </Text>
          </Box>,
        ];
      case "table":
        return [renderTable(token as Tokens.Table, key, dim, mt)];
      default: {
        // Unknown block token (html, etc.): print its literal text.
        const raw = textOf(token);
        if (raw.length === 0) return [];
        return [
          <Box key={key} marginTop={mt} flexShrink={0}>
            <Text wrap="wrap" dimColor={dim}>
              {raw}
            </Text>
          </Box>,
        ];
      }
    }
  });
}

/** One list: colored bullet/number column + hanging-indent item bodies. */
function renderList(list: Tokens.List, key: string, dim: boolean, baseColor: string | undefined, marginTop: number): ReactNode {
  const numbered = list.ordered === true;
  // marked types `start` as number | '' (missing start attr → '') —
  // normalize to 1 so the numbering math stays numeric.
  const start = typeof list.start === "number" && list.start > 0 ? list.start : 1;
  // Fixed marker column width (widest number + one space) so every item's
  // body aligns; nested lists recurse into the body column.
  const last = start + Math.max(0, list.items.length - 1);
  const markerWidth = numbered ? String(last).length + 2 : 2;
  return (
    <Box key={key} marginTop={marginTop} flexShrink={0} flexDirection="column">
      {list.items.map((item, i) => {
        const glyph = numbered ? `${start + i}.` : item.task === true ? (item.checked ? "☑" : "☐") : "•";
        return (
          <Box key={`${key}:i${i}`} flexDirection="row" flexShrink={0}>
            <Box width={markerWidth} flexShrink={0}>
              <Text color={numbered ? THEME.enumeration : THEME.bullet} dimColor={dim}>
                {glyph}
              </Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              {renderBlocks(item.tokens ?? [], `${key}:i${i}`, dim, baseColor, false)}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * One table: cyan header row, dim separator, plain body rows. Columns are
 * content-aligned (padded, clipped to a per-cell cap) and each row renders
 * as one truncated line — no box-drawing grid, no width negotiation.
 */
function renderTable(table: Tokens.Table, key: string, dim: boolean, marginTop: number): ReactNode {
  const CAP = 28;
  const clip = (s: string): string => (s.length > CAP ? `${s.slice(0, CAP - 1)}…` : s);
  const widths = table.header.map((cell, i) => {
    let w = clip(cell.text).length;
    for (const row of table.rows) {
      const c = row[i];
      if (c !== undefined) w = Math.max(w, clip(c.text).length);
    }
    return Math.min(w, CAP);
  });
  const line = (cells: { text: string }[]): string => cells.map((c, i) => clip(c.text).padEnd(widths[i] ?? 0, " ")).join("  ");
  const total = widths.reduce((sum, w) => sum + w, 0) + 2 * Math.max(0, widths.length - 1);
  return (
    <Box key={key} marginTop={marginTop} flexShrink={0} flexDirection="column">
      <Text color={THEME.enumeration} dimColor={dim} wrap="truncate">
        {line(table.header)}
      </Text>
      <Text dimColor wrap="truncate">
        {"─".repeat(total)}
      </Text>
      {table.rows.map((row, i) => (
        <Text key={`${key}:r${i}`} dimColor={dim} wrap="truncate">
          {line(row)}
        </Text>
      ))}
    </Box>
  );
}
