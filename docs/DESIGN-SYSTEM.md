# bai — Design System

The web surface's visual language: fonts, the type scale, weights, spacing,
radii, control heights, and elevation. Everything here is a **token** defined
once in `packages/web/src/styles.css` (`:root`) and consumed by name — no
component hardcodes a raw size, weight, or color.

This document is the contract. `packages/web/test/theme-css.test.ts` enforces
the parts that can be checked statically (font tokens exist, no raw sizes or
weights outside `:root`).

---

## 1. Fonts

Two self-hosted variable families, one per role. Both ship in the Vite bundle
(no CDN, no Google Fonts) because the app is an **offline-first PWA** — the
same reason Monaco is bundled locally rather than fetched from jsdelivr.

| Role | Family | Token | Used by |
|---|---|---|---|
| UI sans | **Inter Variable** | `--font-sans` | Everything by default (`body`) |
| Code / mono | **JetBrains Mono Variable** | `--font-mono` | Monaco, the web shell (xterm), inline code, code blocks, mono inputs |

### Delivery

- Declared in `packages/web/src/fonts.css` as `@font-face` rules pointing at
  the `@fontsource-variable/*` woff2 files.
- Only the **latin + latin-ext** subsets are declared (the UI is English-only);
  the full `@fontsource` `index.css` would also pull cyrillic/greek/vietnamese.
- `font-display: swap` — text renders immediately in the fallback, then swaps.
- The woff2 files land in `dist/assets/*` (immutable-cached) and are precached
  by the service worker, so the PWA renders correctly offline.
- Bundle cost: Inter ≈ 133 KB, JetBrains Mono ≈ 56 KB (both subsets, woff2).

### Fallback stacks

The tokens lead with the self-hosted family and fall back to the system stack
for the boot frame before the woff2 loads, and for any environment that blocks
them:

```css
--font-sans: "Inter Variable", "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
--font-mono: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
```

### Editor & terminal

Monaco and xterm take concrete strings, not CSS variables, so their config
lives in one shared module — `packages/web/src/editor-font.ts`:

- `EDITOR_FONT_FAMILY` — mirrors `--font-mono`.
- `EDITOR_FONT_SIZE` — `13` (the `--text-md` step).

Monaco enables **ligatures** (`fontLigatures: true`); xterm does not (it needs
`@xterm/addon-ligatures`, which is not a dependency).

### Surfaces that cannot use the bundled fonts

- **TUI** (`@bai/tui`): Ink renders to the terminal — fonts come from the
  user's terminal emulator, not bai. Typography there is semantic only
  (`bold` / `italic` / `dimColor` / `strikethrough`).
- **Server-rendered HTML** (the "web UI not built" hint page, OAuth/MCP
  callbacks): standalone pages that cannot load the SPA bundle. They name
  `Inter` with a `system-ui` fallback, so they use Inter only if it is
  installed OS-wide.
- **`icon.svg`**: names `Inter` with a system fallback for the "bai" mark.

---

## 2. Type scale

Five sizes. **These are the only font sizes components may use.**

| Token | Value | Role |
|---|---|---|
| `--text-xs` | 11px* | captions, badges, column heads, nav labels |
| `--text-sm` | 12px | meta, labels, hints |
| `--text-md` | 13px | controls, dense body, code |
| `--text-lg` | 15px | body, section headings |
| `--text-xl` | 20px | page titles, KPI values |

\* **Touch floor:** under `@media (pointer: coarse)` (phones/tablets) the scale
shifts so no caption falls below 12px and no text-entry control falls below
16px (iOS Safari focus-zooms anything under 16px):

| Token / alias | Fine pointer | `pointer: coarse` |
|---|---|---|
| `--text-xs` | 11px | **12px** |
| `--control-text` (inputs, buttons, selects) | `--text-md` (13px) | **16px** |
| `--text-min` (em-relative floors, e.g. `.md code`) | 12px | 12px |

`html { text-size-adjust: 100% }` disables WebKit font boosting; pinch-zoom
stays unlocked (`no maximum-scale` / `user-scalable=no` — WCAG 1.4.4).

There is **no sub-11px tier**: micro labels that used to be 8/9/10px collapse
onto `--text-xs`. Legacy semantic aliases (`--text-caption`, `--text-meta`,
`--text-control`, `--text-body`) map onto the scale and exist only so older
rules can migrate one at a time.

**Exceptions (intentional, not debt):** the markdown renderer uses
`em`-relative sizes (`.md h1` `1.3em`, `.md code` `max(var(--text-min), 0.9em)`, …)
so headings and inline code scale with their surrounding text but never drop
below `--text-min` (12px). These are the only non-token sizes in the
stylesheet.

---

## 3. Font weights

Four weights. **These are the only weights components may use.**

| Token | Value | Role |
|---|---|---|
| `--font-weight-normal` | 400 | body text |
| `--font-weight-medium` | 500 | list titles, subtle emphasis |
| `--font-weight-semibold` | 600 | headings, labels, tool names |
| `--font-weight-bold` | 700 | page titles, KPI values, strong |

---

## 4. Spacing

A 4px base scale. **These are the only padding/margin/gap values.**

| Token | Value |
|---|---|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 20px |
| `--space-6` | 24px |
| `--space-8` | 32px |

---

## 5. Radii

Raw scale:

| Token | Value |
|---|---|
| `--radius-sm` | 6px |
| `--radius-md` | 8px |
| `--radius-lg` | 10px |
| `--radius-xl` | 12px |
| `--radius-full` | 999px |

### Component-role radii (the uniformity contract)

Components reference the **role** tokens, never the raw scale, so every
control/surface/dialog rounds consistently:

| Role token | Maps to | Used by |
|---|---|---|
| `--radius-control` | `--radius-md` (8px) | Buttons, inputs, textareas, selects, comboboxes, tag fields, chips, checkboxes, radios, segmented controls |
| `--radius-card` | `--radius-lg` (10px) | Cards, menus, dropdowns, popovers, toasts, banners |
| `--radius-modal` | `--radius-xl` (12px) | Modals, lightboxes |
| `--radius-full` | 999px | Pills, badges, avatars |

---

## 6. Control heights

Buttons and inputs share one height per size, so a button can never drift
taller than the text input beside it. On coarse pointers (touch) every size
bumps to meet the 44px target.

| Token | Default | `pointer: coarse` |
|---|---|---|
| `--control-h-sm` | 28px | 36px |
| `--control-h-md` | 34px | 40px |
| `--control-h-lg` | 40px | 44px |

Secondary chrome that isn't a named size (`.master-item`, `.new-session`,
`.provider-item`, `.attachment-remove`, `.image-card-menu-btn`, `.key-bar-key`)
also floors to **44×44** under `pointer: coarse`, and lists of them scroll
horizontally (`overflow-x: auto`) rather than crushing targets on a 320px
phone. Hover-only affordances (card menu buttons) become always-visible under
`@media (hover: none)`.

**Composer status row**: session/workspace, context, Learn, and locked-chat
chips sit beside the agent/model pickers. Chips alone default to `sm` /
`--text-sm` while pickers use `md` / `--control-text`, so `.composer-status`
forces every child (and its plain-text hints) onto **`--control-h-md` +
`--control-text`** — one height and one type for the whole hub row. Icons in
that row are 13px (matching the picker Bot/Cpu glyphs).

---

## 7. Line height & elevation

| Token | Value |
|---|---|
| `--leading-tight` | 1.25 |
| `--leading-normal` | 1.5 |
| `--shadow-sm` | `0 1px 2px rgb(0 0 0 / 0.18)` |
| `--shadow-md` | `0 4px 12px rgb(0 0 0 / 0.25)` |
| `--shadow-lg` | `0 6px 24px rgb(0 0 0 / 0.3)` |

Role elevation: floating surfaces (menus, dropdowns, popovers, toasts) use
`--shadow-popover` (= `--shadow-md`); dialogs use `--shadow-modal`
(= `--shadow-lg`); raised cards (`Card variant="raised"`) use
`--shadow-card` (= `--shadow-sm`) for a soft surface lift. Components must not
hardcode a `box-shadow`.

### Motion

| Token | Value |
|---|---|
| `--duration-fast` | 120ms |
| `--duration-normal` | 180ms |
| `--duration-slow` | 240ms |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` |
| `--ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` |

Motion is subtle and functional: quick fades/slides/scales on enter **and**
exit. A single global `@media (prefers-reduced-motion: reduce)` block at the
end of `styles.css` neutralizes all animation and transitions app-wide —
components must not add their own reduced-motion blocks.

---

## 8. Color & theming

Colors are **not** part of this document's token list because they are
theme-scoped: every `[data-theme="…"]` block in `styles.css` redefines the
full palette, and the blocks are pinned to the shared catalog
(`packages/shared/src/themes.ts`) by `theme-css.test.ts`. See
[FEATURES.md](FEATURES.md) for the theme catalog and
[ARCHITECTURE.md §13.2](ARCHITECTURE.md#132-web-baiweb-served-by-baiai) for the
surface.

The slot → variable mapping (documented at the top of `styles.css`):

| Theme slot | CSS var |
|---|---|
| `surface` | `--bg` |
| `surfaceSecondary` | `--panel` |
| `border` | `--border` |
| `text` | `--text` |
| `textMuted` | `--dim` |
| `primary` | `--accent` |
| `success` | `--user` / `--success` |
| `danger` | `--danger` |
| `warning` | `--warning` |
| `secondary` | `--secondary` |

Monaco derives its editor theme from the same palette data at call time
(`monaco-setup.ts`), so a theme switch re-skins the editor on the fly.

### TUI (terminal) mapping

Ink has no alpha, shadows, radii, or blending, so the TUI expresses the same
language with **tone + border**. The elevation triad maps directly
(`packages/tui/src/theme.tsx`):

| Design role | Theme slot | TUI token | Applied to |
|---|---|---|---|
| Page surface | `surface` | `background` | Full-terminal root (painted across the alt-screen) |
| Raised surface | `surfaceSecondary` | `panel` | Dialog panels, composer hub, user-turn cards, selected rows |
| Recessed well | `background` | `inset` | Code blocks, tool-output bodies, diff bodies, pending/queued wells |
| Selection bar | `color-mix(accent 14%, panel)` | `selection` | Full-width highlighted row in pickers/lists |
| Accent | `primary` | `accent` | Focus markers (`❯`), titles, active borders |
| Decorative accent | `accent` | `accentAlt` | Markdown headings and secondary flourishes |

Rules for TUI contributors:

1. **Never hardcode a color** — read roles from `useTheme()` (`TuiTheme`).
2. **Elevation, not shadow**: raised surfaces use `panel`; recessed wells use
   `inset`; every panel uses a square (`single`) border (color = the surface's
   tone) — rounded corners clash with the rectangular surface fills.
3. **Selection is a bar, not a fill**: a full-width `Box` with the `selection`
   background plus an accent `❯`/label — never an accent-filled row
   (`onAccent` is not part of `ThemeColors`).
4. **Typography is semantic only** (`bold`/`italic`/`dimColor`/
   `strikethrough`) — fonts come from the terminal emulator (§13.1).
5. **No transcript animation** (a static `▌` streaming cursor; only the
   spinner ticks) so input latency stays flat.

---

## 9. Rules for contributors

1. **Never hardcode** a font size, weight, spacing, radius, control height, or
   color in a component. Use the token. For corners and elevation use the
   **role** tokens (`--radius-control/--radius-card/--radius-modal`,
   `--shadow-popover/--shadow-modal`), never the raw scale.
2. New sizes/weights require a new token in `:root` — and a reason. The scale
   is deliberately small.
3. `components/components.css` is the reference implementation: every rule
   there is token-driven. `styles.css` is being migrated to the same standard.
   Forms group fields with `FormSection` (a titled `.form-grid`) and close with
   `ActionRow` — screens should not hand-roll section headings or action rows.
4. **Screens compose `components/` — they must not render raw
   `<button>/<input>/<select>/<textarea>`.** Existing files use the
   primitives; the source-scan contract test
   (`test/components-contract.test.ts`) fails otherwise.
5. The contract tests fail if a raw `font-size: <n>px` / `font-weight: <n>`, a
   raw `border-radius: <n>px`, or a hardcoded `box-shadow` appears outside
   `:root`. Run `bun test` in `packages/web` before committing.
6. Monaco/xterm font changes go through `editor-font.ts`, not the call sites.
7. Motion uses the duration/easing tokens; the single global
   `prefers-reduced-motion` guard covers every animation. Do not add a
   per-component reduced-motion block.

---

## 10. Where things live

| Concern | File |
|---|---|
| Tokens (`:root`) + all component styles | `packages/web/src/styles.css` |
| Shared component library styles | `packages/web/src/components/components.css` |
| Form grouping + action rows | `packages/web/src/components/FormSection.tsx`, `ActionRow.tsx` |
| Range slider | `packages/web/src/components/Slider.tsx` |
| Form-row switch | `packages/web/src/components/Switch.tsx` (`SwitchField`) |
| Stat rows (model info, telemetry) | `packages/web/src/components/Stat.tsx` |
| Filter/action toolbar | `packages/web/src/components/Toolbar.tsx` |
| `@font-face` declarations | `packages/web/src/fonts.css` |
| Monaco/xterm font config | `packages/web/src/editor-font.ts` |
| Monaco theme derivation | `packages/web/src/monaco-setup.ts` |
| Theme catalog (shared data) | `packages/shared/src/themes.ts` |
| Coarse-pointer / autofocus helpers | `packages/web/src/pointer.ts` |
| `visualViewport` keyboard refit | `packages/web/src/viewport.ts` |
| Long-press → context menu | `packages/web/src/use-long-press.ts` |
| Mobile shell key bar | `packages/web/src/components/KeyBar.tsx` |
| Contract tests | `packages/web/test/theme-css.test.ts`, `test/mobile-css.test.ts` |
