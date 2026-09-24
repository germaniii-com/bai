import { Box, Text, useInput } from "ink";
import { isMouseInput } from "../components/dialog";
import { Panel } from "../components/ui";
import { useTheme } from "../theme";

/** Key-column width — the longest chord is `ctrl+j / ctrl+k` (15). */
const KEY_WIDTH = 16;

interface ShortcutSection {
  label: string;
  rows: Array<[keys: string, description: string]>;
}

/**
 * The full key map, opened with `?` (NORMAL mode). The composer hub's
 * commands row is deliberately minimal (`i insert mode · ? list shortcuts`);
 * this panel is where every binding lives, grouped by
 * surface. Two columns keep it within a 24-row terminal. Rendered as a
 * floating overlay over the live chat (DialogOverlay).
 */
const LEFT: ShortcutSection[] = [
  {
    label: "modes",
    rows: [
      ["i / a", "insert mode"],
      ["esc", "normal mode"],
      ["?", "shortcuts"],
      ["space space", "supermenu"],
      ["ctrl+t", "todos"],
    ],
  },
  {
    label: "composer",
    rows: [
      ["enter", "send"],
      ["ctrl+j / ctrl+k", "newline"],
      ["ctrl+w", "delete word"],
      ["#", "reference a file"],
      ["tab / shift+tab", "cycle agent"],
    ],
  },
];

const RIGHT: ShortcutSection[] = [
  {
    label: "transcript",
    rows: [
      ["j / k · ↑ / ↓", "scroll a row"],
      ["pgup / pgdn", "half a page"],
      ["ctrl+u / ctrl+d", "a quarter page"],
      ["ctrl+j / ctrl+k", "focus node"],
      ["gg / GG", "top / bottom"],
      ["enter / space", "act on node"],
      ["f", "full tool output"],
    ],
  },
  {
    label: "mouse",
    rows: [
      ["wheel", "scroll"],
      ["click", "chips · nodes"],
    ],
  },
];

function Column({ sections }: { sections: ShortcutSection[] }) {
  const t = useTheme();
  return (
    <Box flexDirection="column" flexBasis={0} flexGrow={1} flexShrink={1} marginRight={1}>
      {sections.map((section, si) => (
        <Box key={section.label} flexDirection="column" marginTop={si === 0 ? 0 : 1}>
          <Text color={t.dim}>{section.label}</Text>
          {section.rows.map(([keys, description]) => (
            <Text key={keys} wrap="truncate">
              <Text color={t.accent}>{keys.padEnd(KEY_WIDTH)}</Text>
              <Text color={t.text}>{description}</Text>
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export function ShortcutsDialog({
  onClose,
  deferInput = false,
}: {
  onClose: () => void;
  /** True while another App-level overlay owns the keyboard. */
  deferInput?: boolean;
}) {
  useInput(
    (ch, key) => {
      if (isMouseInput(ch)) return;
      // esc or `?` again closes.
      if (key.escape || ch === "?") onClose();
    },
    { isActive: !deferInput },
  );

  return (
    <Panel title="shortcuts" titleTone="accent" hint="esc close">
      <Box flexDirection="row">
        <Column sections={LEFT} />
        <Column sections={RIGHT} />
      </Box>
    </Panel>
  );
}
