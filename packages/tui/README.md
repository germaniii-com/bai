# @bai/tui

The terminal surface: a **React Ink 7** application rendered by Bun directly
(no build step). A thin client — it owns rendering and interaction only,
never domain state.

Ink 7 requires React 19.2+ (satisfied) and supports full-screen
`alternateScreen: true` rendering since v7. Production pedigree: Claude Code,
Gemini CLI, GitHub Copilot CLI.

## Responsibilities

- Root component with view-state enum: `chat`, `sessions`, `gallery`, `jobs`,
  `settings` (+ onboarding/pairing when needed).
- Focus-state routing: overlay dialogs intercept keys first, then global
  keybindings, then the focused component.
- Components: chat view (streaming markdown), session picker, diff viewer
  (code workbench), gallery grid, jobs queue, settings form, permission
  prompt dialog, message-actions modal (enter/space on a focused user
  message: revert / copy / fork / restore).
- All data flows through `@bai/api`'s client against the in-process loopback
  server started by the same binary (works unchanged against remote servers).
- Applies event streams with reducers mirroring the web app's semantics.

## Rendering conventions

- Markdown: parse with `marked`, map blocks to Ink components, highlight
  fenced code with `cli-highlight` (the Claude Code pattern). Avoid stale
  string-renderer shortcuts for interactive views.
- Diffs: `diff` (jsdiff) structured patches → colored `<Text>` lines.
- Streaming text: coalesce adjacent `message.part.delta` appends per render
  tick before painting.
- Keys via `useInput`; bracketed paste via `usePaste`; focus via
  `useFocus`/`useFocusManager`.
- Permission asks arrive as events → modal dialog → reply via client; any
  other paired device may win the race (first-reply-wins) — handle gracefully.

## Non-goals

- Any direct provider/store/core access — if the TUI needs something, the API
  grows an endpoint.
- Mouse-heavy interactions and complex media editing belong to the web
  surface (Ink has no mouse support).

## Key types (planned)

```tsx
export function App(props: { client: BaiClient }): JSX.Element;

type UiState = "chat" | "sessions" | "gallery" | "jobs" | "settings";
type FocusState = { overlay: OverlayId | null; focused: ComponentId };

render(<App client={client} />, { alternateScreen: true, exitOnCtrlC: false });
```

## Testing

- Reducers/state machines: plain unit tests under `bun:test`.
- End-to-end smoke: spawn the TUI through a real PTY (`Bun.spawn` terminal
  option) and assert on output — the pattern the Ink repo itself uses.
  (`ink-testing-library` is stale at Ink 5 and deliberately not load-bearing.)

## Notes

- Terminal without image protocol support degrades to asset paths/links.
- See [ARCHITECTURE.md §13.1](../../ARCHITECTURE.md#131-tui-baitui-ink-7).
