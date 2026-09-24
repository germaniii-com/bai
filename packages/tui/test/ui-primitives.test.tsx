import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { ThemeProvider, tuiTheme } from "../src/theme";
import { EmptyState, HintRow, ListRow, Panel } from "../src/components/ui";

const Frame = ({ children }: { children: ReactNode }) => (
  <ThemeProvider theme={tuiTheme("dark")}>
    <Box flexDirection="column" width={40}>
      {children}
    </Box>
  </ThemeProvider>
);

const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("TUI primitives", () => {
  test("Panel renders a square border, title, body, and hint", async () => {
    const { lastFrame, unmount } = render(
      <Frame>
        <Panel title="sessions" titleSuffix="(2)" hint="esc close">
          <Text>row one</Text>
        </Panel>
      </Frame>,
    );
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("┌");
    expect(frame).toContain("sessions");
    expect(frame).toContain("(2)");
    expect(frame).toContain("row one");
    expect(frame).toContain("esc close");
  });

  test("ListRow marks the highlighted row with the ❯ cursor", () => {
    const { lastFrame, unmount } = render(
      <Frame>
        <ListRow selected gutter="✓" hint="src/a.ts">
          {"alpha"}
        </ListRow>
        <ListRow>{"beta"}</ListRow>
      </Frame>,
    );
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("❯ ✓ alpha");
    expect(frame).toContain("  beta");
  });

  test("HintRow and EmptyState render their content", () => {
    const { lastFrame, unmount } = render(
      <Frame>
        <HintRow>{"enter run · esc back"}</HintRow>
        <EmptyState title="Gallery" body="nothing here yet" hints="esc back" />
      </Frame>,
    );
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("enter run");
    expect(frame).toContain("Gallery");
    expect(frame).toContain("nothing here yet");
  });
});
