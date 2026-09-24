import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Mobile / iOS friendliness contract (packages/web).
 *
 * Pins the Phase-1 foundations so a regression can't reintroduce the
 * classic iOS Safari papercuts:
 *  - sub-16px text-entry controls (focus-zooms the page)
 *  - sub-12px captions on touch (--text-xs floor, em-relative text)
 *  - missing text-size-adjust (WebKit font boosting)
 *  - maximum-scale / user-scalable=no (zoom lock, WCAG 1.4.4)
 *  - viewport-dependent pop surfaces still on plain vh (dvh tracks the
 *    dynamic viewport under the iOS toolbar)
 */

const cssPath = fileURLToPath(new URL("../src/styles.css", import.meta.url));
const componentsPath = fileURLToPath(new URL("../src/components/components.css", import.meta.url));
const htmlPath = fileURLToPath(new URL("../index.html", import.meta.url));
const css = readFileSync(cssPath, "utf8");
const componentsCss = readFileSync(componentsPath, "utf8");
const html = readFileSync(htmlPath, "utf8");

/** First :root block (styles.css only) — the only place raw px font sizes are allowed. */
function stripRoot(source: string): string {
  const root = source.match(/:root\s*\{[\s\S]*?\n\}/);
  // components.css defines no :root — nothing to strip, the whole file is fair game.
  if (root === null) return source;
  return source.replace(root[0], "");
}

describe("mobile CSS contract", () => {
  test("tokens: --control-text and --text-min exist in :root", () => {
    expect(css).toContain("--control-text:");
    expect(css).toContain("--text-min: 12px;");
  });

  test("coarse pointers floor control text at 16px and captions at 12px", () => {
    const coarse = css.match(/@media \(pointer: coarse\)\s*\{[\s\S]*?\n\}/);
    expect(coarse).not.toBeNull();
    expect(coarse![0]).toContain("--control-text: 16px;");
    expect(coarse![0]).toContain("--text-xs: 12px;");
    // Existing 44px touch heights stay (HIG target).
    expect(coarse![0]).toContain("--control-h-lg: 44px;");
  });

  test("html disables text inflation (text-size-adjust: 100%)", () => {
    expect(css).toMatch(/html\s*\{[^}]*-webkit-text-size-adjust:\s*100%/);
    expect(css).toMatch(/html\s*\{[^}]*text-size-adjust:\s*100%/);
  });

  test("no maximum-scale / user-scalable zoom lock in index.html", () => {
    expect(html).not.toMatch(/maximum-scale/);
    expect(html).not.toMatch(/user-scalable\s*=\s*no/i);
    expect(html).toMatch(/viewport-fit=cover/);
  });

  test("text-entry controls use --control-text (never a raw/sub-16 size)", () => {
    const entrySelectors = [
      ".input {",
      ".input.mono {",
      ".select select {",
      ".combobox-input {",
      ".picker-trigger {",
      ".file-input {",
    ];
    for (const sel of entrySelectors) {
      const block = componentsCss.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^}]*\\}`));
      expect(block, `missing block for ${sel}`).not.toBeNull();
      expect(block![0], `${sel} must size via --control-text`).toContain("font-size: var(--control-text);");
      expect(block![0]).not.toMatch(/font-size:\s*(var\(--text-(xs|sm|md|lg|xl)\)|[0-9.]+px)/);
    }

    const styleEntrySelectors = [".ws-newname {", ".todos-add {", ".notes-textarea {", ".tag-input-text {", ".composer-input-row .composer-input {"];
    for (const sel of styleEntrySelectors) {
      const block = css.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^}]*\\}`));
      expect(block, `missing block for ${sel}`).not.toBeNull();
      expect(block![0], `${sel} must size via --control-text`).toContain("font-size: var(--control-text);");
    }

    // Inline edit + reject reason were font:inherit-only (inheriting 15px
    // body text still zooms iOS at <16 — they must take the control token).
    expect(css).toMatch(/\.todo-edit\s*\{[^}]*font-size:\s*var\(--control-text\)/);
    expect(css).toMatch(/\.perm-reject textarea\s*\{[^}]*font-size:\s*var\(--control-text\)/);
  });

  test("em-relative text floors at --text-min (never below 12px)", () => {
    expect(css).toMatch(/\.md code\s*\{[^}]*font-size:\s*max\(var\(--text-min\),\s*0\.9em\)/);
    expect(css).toMatch(/\.attachment-chip\s*\{[^}]*font-size:\s*max\(var\(--text-min\),\s*0\.85em\)/);
    expect(css).not.toMatch(/font-size:\s*0\.9em/);
    expect(css).not.toMatch(/font-size:\s*0\.85em/);
  });

  test("no raw px font sizes outside the first :root block", () => {
    // Mirrors theme-css.test.ts's rule — kept here so Phase-1 regressions
    // fail with a mobile-specific message too.
    expect(stripRoot(css)).not.toMatch(/font-size:\s*[0-9.]+px/);
    expect(stripRoot(componentsCss)).not.toMatch(/font-size:\s*[0-9.]+px/);
  });

  test("viewport-dependent pop surfaces use dvh (not vh)", () => {
    for (const source of [css, componentsCss]) {
      expect(source).not.toMatch(/max-height:\s*[^;]*\b\d+vh\b/);
    }
  });

  test("interactive chrome opts out of double-tap zoom (touch-action: manipulation)", () => {
    expect(css).toMatch(/button[^{]*\{[^}]*touch-action:\s*manipulation/);
    expect(css).toContain("-webkit-tap-highlight-color: transparent");
  });
});

describe("mobile shell (Phase 2)", () => {
  test("top strip pads under the notch (safe-area-inset-top)", () => {
    // Match the MOBILE master-nav (inside the 640px block), not the desktop rail.
    const block = css.match(/@media \(max-width: 640px\)\s*\{[\s\S]*?\.master-nav\s*\{[\s\S]*?\n  \}/);
    expect(block, "mobile master-nav block missing").not.toBeNull();
    expect(block![0]).toContain("env(safe-area-inset-top");
  });

  test("bottom-fixed chrome clears the home indicator", () => {
    expect(css).toMatch(/\.composer\s*\{[^}]*env\(safe-area-inset-bottom/);
    expect(css).toMatch(/\.toast-stack\s*\{[^}]*env\(safe-area-inset-bottom/);
  });

  test("nav targets are at least 44px on coarse pointers", () => {
    const coarseBlocks = [...css.matchAll(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
    const joined = coarseBlocks.join("\n");
    expect(joined).toMatch(/\.master-item\s*\{[^}]*min-width:\s*44px/);
    expect(joined).toMatch(/\.master-item\s*\{[^}]*min-height:\s*44px/);
    expect(joined).toMatch(/\.new-session\s*\{[^}]*min-height:\s*44px/);
    expect(joined).toMatch(/\.provider-item\s*\{[^}]*min-height:\s*44px/);
  });

  test("master nav: brand stays pinned; only items scroll at 320px", () => {
    // The mobile .master-nav rule is the one that pads for the notch.
    const navBlocks = [...css.matchAll(/\.master-nav\s*\{[^}]*\}/g)].map((m) => m[0] ?? "");
    const mobileNav = navBlocks.find((b) => b.includes("safe-area-inset-top"));
    expect(mobileNav, "mobile master-nav block missing").toBeDefined();
    // The nav shell itself must NOT be the scroll container (that would pan
    // the bai brand mark away) — overflow lives on .master-scroll only.
    expect(mobileNav!).not.toMatch(/overflow-x:\s*auto/);
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.master-scroll\s*\{[^}]*overflow-x:\s*auto/);
    // Brand is a sibling of the scroll region (outside it in MasterNav).
    const app = readFileSync(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8");
    const brandIdx = app.indexOf('className="brand-mark"');
    const scrollIdx = app.indexOf('className="master-scroll"');
    const itemsIdx = app.indexOf('className="master-items"');
    expect(brandIdx).toBeGreaterThan(-1);
    expect(scrollIdx).toBeGreaterThan(-1);
    expect(itemsIdx).toBeGreaterThan(-1);
    expect(brandIdx).toBeLessThan(scrollIdx);
    expect(scrollIdx).toBeLessThan(itemsIdx);
    // .master-item's 44×44 lives later in the same 640px block.
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.master-item\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/);
    // Desktop (coarse) rail also floors to 44 — Phase 2 coarse test covers it.
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.master-item\s*\{[^}]*min-width:\s*44px/);
  });

  test("SIDEBAR_HIDDEN sections keep MasterNav (no separate mobile header needed)", () => {
    // MasterNav renders outside showNestedPanel in App.tsx — the top icon
    // row is the section switcher for shell/analytics/image/video too.
    const app = readFileSync(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8");
    expect(app).toMatch(/SIDEBAR_HIDDEN/);
    // MasterNav is a direct child of .app, not gated on showNestedPanel.
    const afterReturn = app.slice(app.indexOf("return ("));
    const masterIdx = afterReturn.indexOf("<MasterNav");
    const nestedIdx = afterReturn.indexOf("{showNestedPanel");
    expect(masterIdx).toBeGreaterThan(-1);
    expect(nestedIdx).toBeGreaterThan(-1);
    expect(masterIdx).toBeLessThan(nestedIdx);
  });
});

describe("subnav as Drawer (post-plan)", () => {
  const app = readFileSync(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8");
  const mediaSrc = readFileSync(fileURLToPath(new URL("../src/use-media-query.ts", import.meta.url)), "utf8");

  test("narrow viewports use useMediaQuery — nested column is desktop-only", () => {
    expect(mediaSrc).toContain("matchMedia");
    expect(app).toContain('useMediaQuery("(max-width: 640px)")');
    expect(app).toMatch(/showNestedPanel && !isNarrow/);
    // One content tree shared by column + Drawer.
    expect(app).toContain("{nestedBody}");
    expect(app.match(/\{nestedBody\}/g)!.length).toBeGreaterThanOrEqual(2);
  });

  test("MasterNav has a right-edge subnav toggle (opposite the brand)", () => {
    const navSrc = readFileSync(fileURLToPath(new URL("../src/components/nav.tsx", import.meta.url)), "utf8");
    expect(app).toContain("subnavToggle");
    expect(app).toContain("<SubNavToggle");
    // The control itself lives in the component library (raw button OK).
    expect(navSrc).toContain('className="master-item subnav-toggle"');
    expect(navSrc).toContain("PanelRight");
    expect(navSrc).toContain("aria-expanded={open}");
    // Brand mark is a sibling before master-scroll; toggle is after it.
    const brandIdx = app.indexOf('className="brand-mark"');
    const scrollIdx = app.indexOf('className="master-scroll"');
    const toggleIdx = app.indexOf("<SubNavToggle");
    expect(brandIdx).toBeGreaterThan(-1);
    expect(scrollIdx).toBeGreaterThan(-1);
    expect(toggleIdx).toBeGreaterThan(-1);
    expect(brandIdx).toBeLessThan(scrollIdx);
    expect(scrollIdx).toBeLessThan(toggleIdx);
    // Toggle sits outside .master-scroll (right edge of the row, not panning).
    const scrollClose = app.indexOf("</div>", toggleIdx);
    expect(scrollClose).toBeLessThan(toggleIdx);

    // Content-sized like the brand mark (must not inherit .master-item's
    // flex:1 0 auto — that made it wider than the scroll region).
    // Match the mobile-block rules (they set flex), not the base display toggle.
    const subnavBlocks = [...css.matchAll(/\.subnav-toggle\s*\{[^}]*\}/g)].map((m) => m[0] ?? "");
    expect(subnavBlocks.some((b) => /flex:\s*0 0 auto/.test(b))).toBe(true);
    // Scroll region takes the freed space and stays the overflow surface.
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.master-scroll\s*\{[^}]*flex:\s*1 1 auto/);
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.master-scroll\s*\{[^}]*overflow-x:\s*auto/);

    // | separator sits between the scroll region and the toggle.
    expect(navSrc).toContain('className="subnav-toggle-group"');
    expect(navSrc).toContain('className="nav-divider"');
    expect(css).toMatch(/\.subnav-toggle-group\s*\{[^}]*flex:\s*0 0 auto/);
    // Group + toggle hidden on desktop (no nested-column replacement chrome).
    expect(css).toMatch(/\.subnav-toggle-group,\s*\.subnav-toggle\s*\{\s*display:\s*none/);
    expect(css).toMatch(/@media \(max-width: 640px\)\s*\{\s*\.subnav-toggle\s*\{[^}]*display:\s*flex/);
  });

  test("subnav Drawer mounts with shared body and section-title", () => {
    expect(app).toMatch(/title=\{nestedTitle\}/);
    expect(app).toMatch(/open=\{showNestedPanel && isNarrow && subnavOpen\}/);
    // Selecting a session / settings row closes the drawer.
    expect(app).toMatch(/setSubnavOpen\(false\)/);
  });

  test("horizontal strip layout for nested panel is gone", () => {
    // Mobile block must not turn .nested-panel into an overflow strip.
    const nestedBlocks = [...css.matchAll(/\.nested-panel\s*\{[^}]*\}/g)].map((m) => m[0] ?? "");
    for (const block of nestedBlocks) {
      expect(block).not.toMatch(/overflow-x:\s*auto/);
      expect(block).not.toMatch(/flex-direction:\s*row/);
    }
    // Safety: hard-hidden if somehow mounted under 640px.
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.nested-panel\s*\{[^}]*display:\s*none/);
    // Toggle visible only ≤640px.
    expect(css).toMatch(/\.subnav-toggle\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/@media \(max-width: 640px\)\s*\{\s*\.subnav-toggle\s*\{[^}]*display:\s*flex/);
  });
});

describe("chat on mobile (Phase 3)", () => {
  test("composer row wraps on narrow panes", () => {
    expect(css).toMatch(/\.composer-input-row\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  test("send button uses the lg control height (44px coarse)", () => {
    expect(css).toMatch(/\.send-button\s*\{[^}]*width:\s*var\(--control-h-lg\)/);
    // Coarse block already floors --control-h-lg at 44 (Phase 1 test).
  });

  test("transcript does not pan as a whole; wide children scroll themselves", () => {
    expect(css).toMatch(/\.messages\s*\{[^}]*overflow-x:\s*hidden/);
    expect(css).toMatch(/\.md pre\.md-code\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.md table\s*\{[^}]*overflow-x:\s*auto/);
  });

  test("ask/perm actions stack full-width on phones", () => {
    expect(css).toMatch(/\.ask-panel \.perm-actions\s*\{[^}]*flex-direction:\s*column/);
    expect(css).toMatch(/\.ask-panel \.perm-actions > \*\s*\{[^}]*width:\s*100%/);
  });

  test("queued message actions wrap instead of overflowing", () => {
    expect(css).toMatch(/\.queued-row\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  test("attachment remove hit area is finger-sized on coarse", () => {
    const coarse = [...css.matchAll(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    expect(coarse).toMatch(/\.attachment-remove\s*\{[^}]*min-height:\s*44px/);
  });

  test("model-picker search suppresses autoFocus on touch", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/model-picker.tsx", import.meta.url)), "utf8");
    expect(src).toContain("autoFocus={shouldAutoFocus()}");
    expect(src).not.toMatch(/autoFocus\s*(\/?>|\})/);
  });

  test("stale .model-button mobile rule removed (PickerTrigger is the control)", () => {
    expect(css).not.toContain(".model-button");
  });

  test("status-row chips and pickers share one height + type (hub looks uneven otherwise)", () => {
    // Chips default to control-h-sm/text-sm; pickers to control-h-md/control-text.
    // The status row forces both to md + control-text so the hub controls match.
    const chipRule = css.match(/\.composer-status \.chip,\s*\.composer-status \.picker-trigger\s*\{([^}]*)\}/);
    expect(chipRule, "composer-status unify rule missing").not.toBeNull();
    expect(chipRule![1]).toContain("height: var(--control-h-md)");
    expect(chipRule![1]).toContain("font-size: var(--control-text)");
    // Plain-text hints in the same row match the control type.
    const hintRule = css.match(/\.composer-status \.hint,\s*\.composer-status \.dim\s*\{([^}]*)\}/);
    expect(hintRule, "composer-status hint type rule missing").not.toBeNull();
    expect(hintRule![1]).toContain("font-size: var(--control-text)");
  });

  test("composer hub: context/controls groups, soft pills, tidy phone stack", () => {
    const chatSrc = readFileSync(fileURLToPath(new URL("../src/chat-pane.tsx", import.meta.url)), "utf8");
    // Two logical groups so the row can arrange itself per viewport.
    expect(chatSrc).toContain('className="composer-context"');
    expect(chatSrc).toContain('className="composer-controls"');
    // Soft pills (full radius, no hard border) at one height/type.
    const pill = css.match(/\.composer-status \.chip,\s*\.composer-status \.picker-trigger\s*\{([^}]*)\}/);
    expect(pill, "composer pill rule missing").not.toBeNull();
    expect(pill![1]).toContain("border-radius: var(--radius-full)");
    expect(pill![1]).toContain("border-color: transparent");
    // Items that mount when a session becomes active animate in, and the groups
    // are adjacent (not pushed to opposite ends) so a sparse row never gaps.
    expect(pill![1]).toContain("animation: hub-item-in");
    expect(css).toContain("@keyframes hub-item-in");
    expect(css).not.toMatch(/\.composer-controls\s*\{[^}]*margin-left:\s*auto/);
    expect(css).toMatch(/\.composer-context:empty,\s*\.composer-controls:empty\s*\{[^}]*display:\s*none/);
    // Phones: stacked (context above, controls below) — no ragged wrap.
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.composer-status\s*\{[^}]*flex-direction:\s*column/);
    // The model picker shows a compact label on touch (full id overflows).
    const modelPickerSrc = readFileSync(fileURLToPath(new URL("../src/model-picker.tsx", import.meta.url)), "utf8");
    expect(modelPickerSrc).toContain("useCoarsePointer");
    expect(modelPickerSrc).toMatch(/displayLabel/);
    // Truncation is keyed off a STABLE class — the modal overlay renders as a
    // sibling in the same group, so a `:last-child` selector stops matching the
    // moment the modal opens and the trigger expands past the viewport.
    expect(modelPickerSrc).toContain("model-picker-trigger");
    expect(css).toMatch(/\.composer-controls \.model-picker-trigger\s*\{[^}]*overflow:\s*hidden/);
    expect(css).not.toContain("picker-trigger:last-child");
  });

  test("model modal rows show full cost/provider (no cascade-clip from .li-sub)", () => {
    // components.css loads AFTER styles.css; equal-specificity `.model-row
    // .li-sub` loses to `.list-item .li-sub` (nowrap+ellipsis). Rules must
    // use `.list-item.model-row` and stretch to full row width.
    expect(css).toMatch(/\.list-item\.model-row \.li-sub\s*\{[^}]*white-space:\s*normal/);
    expect(css).toMatch(/\.list-item\.model-row \.li-sub\s*\{[^}]*overflow:\s*visible/);
    expect(css).toMatch(/\.list-item\.model-row \.li-head,\s*\.list-item\.model-row \.li-sub\s*\{[^}]*width:\s*100%/);
    // Description lines wrap — never ellipsis-clip cost/provider.
    expect(css).toMatch(/\.list-item\.model-row \.model-row-meta,\s*\.list-item\.model-row \.model-row-owner\s*\{[^}]*white-space:\s*normal/);
    expect(css).toMatch(/\.list-item\.model-row \.model-row-owner\s*\{[^}]*opacity:\s*0\.8/);
    // Trailing badges live in the head (in-flow) — absolute top-right overlapped titles.
    expect(componentsCss).toMatch(/\.list-item \.li-trailing\s*\{[^}]*margin-left:\s*auto/);
    expect(componentsCss).not.toMatch(/\.list-item \.li-trailing\s*\{[^}]*position:\s*absolute/);
    expect(componentsCss).toMatch(/\.list-item \.li-head\s*\{[^}]*width:\s*100%/);
    const listSrc = readFileSync(fileURLToPath(new URL("../src/components/list.tsx", import.meta.url)), "utf8");
    expect(listSrc).toMatch(/li-head[\s\S]*li-trailing[\s\S]*<\/span>[\s\S]*li-sub/);
    expect(listSrc).not.toContain("!inline && trailing");
  });

  test("list rows never flex-shrink (coarse 44px floor would overlap long lists)", () => {
    // In a scrolling flex column the coarse-pointer touch floor
    // (`min-height: 44px`) replaces the automatic min-content minimum, so a
    // long list (e.g. the 400+ model catalog) would flex-shrink every row to
    // 44px while its content stays ~83px — titles paint over the next row's
    // description on phones. Rows must pin flex-shrink to 0; the list scrolls.
    const base = componentsCss.match(/\.list-item\s*\{([^}]*)\}/);
    expect(base, ".list-item base rule missing").not.toBeNull();
    expect(base![1]).toContain("flex-shrink: 0");
  });

  test("model modal rows breathe (padding/gaps on the space scale, not 1–2px nits)", () => {
    const row = css.match(/\.list-item\.model-row\s*\{([^}]*)\}/);
    expect(row, "model-row rule missing").not.toBeNull();
    expect(row![1]).toContain("padding: var(--space-3)");
    expect(row![1]).toContain("gap: var(--space-2)");
    // Dedicated .li-sub rule (not the shared width/align block above it).
    const subs = [...css.matchAll(/\.list-item\.model-row \.li-sub\s*\{([^}]*)\}/g)]
      .map((m) => m[1] ?? "")
      .filter((body) => body.includes("display: flex"));
    expect(subs.length, "model-row .li-sub layout rule missing").toBeGreaterThan(0);
    expect(subs[0]).toContain("gap: var(--space-1)");
    expect(subs[0]).toContain("line-height: var(--leading-normal)");
    // List column itself isn't a 2px hairline stack — rows need visible air.
    expect(css).toMatch(/\.model-list\s*\{[^}]*gap:\s*var\(--space-2\)/);
    expect(css).toMatch(/\.agent-modal-list\s*\{[^}]*gap:\s*var\(--space-2\)/);
  });
});

describe("workspace drawer + long-press (Phase 4)", () => {
  const app = readFileSync(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8");
  const drawerSrc = readFileSync(fileURLToPath(new URL("../src/components/Drawer.tsx", import.meta.url)), "utf8");
  const longPressSrc = readFileSync(fileURLToPath(new URL("../src/use-long-press.ts", import.meta.url)), "utf8");
  const fileTreeSrc = readFileSync(fileURLToPath(new URL("../src/file-tree.tsx", import.meta.url)), "utf8");

  test("Drawer is a dialog with focus trap, Esc, and backdrop close", () => {
    expect(drawerSrc).toContain('role="dialog"');
    expect(drawerSrc).toContain("aria-modal");
    expect(drawerSrc).toContain("useDialogFocus");
    expect(drawerSrc).toMatch(/Escape/);
    expect(drawerSrc).toContain("onClick={onClose}");
    // Token-driven chrome (no raw radii/shadows outside :root).
    expect(componentsCss).toMatch(/\.drawer\s*\{[^}]*border-radius:\s*var\(--radius-modal\)/);
    expect(componentsCss).toMatch(/\.drawer\s*\{[^}]*box-shadow:\s*var\(--shadow-modal\)/);
  });

  test("Drawer tabs = Files / Todos / Notes / Plans", () => {
    expect(app).toMatch(/label:\s*"Files"/);
    expect(app).toMatch(/label:\s*"Todos"/);
    expect(app).toMatch(/label:\s*"Notes"/);
    expect(app).toMatch(/label:\s*"Plans"/);
    expect(app).toContain("setRailOpen");
    expect(app).toContain("drawer-open-btn");
    // Icon-only affordance (not the text label "Rail") — hamburger.
    expect(app).toContain("Menu");
    expect(app).toContain('aria-label="Open workspace menu"');
    expect(app).not.toMatch(/>Rail</);
    expect(app).not.toContain("PanelRight");
  });

  test("desktop keeps the right-rail column; phones open the Drawer", () => {
    // Sidebar/resizer still hidden only under 640px (Drawer replaces them there).
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.workspace-sidebar\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.workspace-resizer\s*\{[^}]*display:\s*none/);
    // Must NOT blanket-hide .file-tree — the Drawer's tree lives on that class.
    expect(css).not.toMatch(/@media \(max-width: 640px\)[\s\S]*?\.file-tree\s*\{[^}]*display:\s*none/);
    // Rail button hidden on desktop (min-width 641).
    expect(componentsCss).toMatch(/@media \(min-width: 641px\)[\s\S]*?\.drawer-open-btn\s*\{[^}]*display:\s*none/);
  });

  test("Drawer body scrolls within a dvh-safe cap", () => {
    expect(componentsCss).toMatch(/\.drawer-body\s*\{[^}]*max-height:\s*[^;]*dvh/);
    expect(componentsCss).toMatch(/\.drawer-body\s*\{[^}]*overflow-y:\s*auto/);
    expect(componentsCss).toContain("env(safe-area-inset-bottom");
  });

  test("mobile file tree fills the drawer (flush body, no desktop 240px column)", () => {
    // Files tab opts into a full-bleed body so the tree isn't a bordered card.
    expect(app).toMatch(/bodyClassName=\{[^}]*drawer-body-flush/);
    expect(componentsCss).toMatch(/\.drawer-body\.drawer-body-flush\s*\{[^}]*padding:\s*0/);
    expect(componentsCss).toMatch(/\.drawer-body\.drawer-body-flush\s*\{[^}]*gap:\s*0/);
    expect(componentsCss).toMatch(/\.drawer-body\.drawer-body-flush\s*>\s*\.file-tree\s*\{[^}]*width:\s*100%/);
    expect(componentsCss).toMatch(/\.drawer-body\.drawer-body-flush\s*>\s*\.file-tree\s*\{[^}]*border-left:\s*0/);
    // Redundant root collapse header is hidden inside the Drawer.
    expect(componentsCss).toMatch(/\.drawer-body\.drawer-body-flush\s+\.file-tree-head\s*\{[^}]*display:\s*none/);
    // Drawer accepts a body class.
    const drawerSrc = readFileSync(fileURLToPath(new URL("../src/components/Drawer.tsx", import.meta.url)), "utf8");
    expect(drawerSrc).toContain("bodyClassName");
  });

  test("use-long-press exists and uses pointer events (not contextmenu alone)", () => {
    expect(longPressSrc).toContain("pointerdown");
    expect(longPressSrc).toContain("setTimeout");
    expect(longPressSrc).toMatch(/450/);
    // Must not rely on contextmenu as the only signal.
    expect(longPressSrc).not.toContain("addEventListener(\"contextmenu\"");
  });

  test("file tree rows bind long-press alongside onContextMenu", () => {
    expect(fileTreeSrc).toContain("useLongPress");
    expect(fileTreeSrc).toContain("onContextMenu");
    expect(fileTreeSrc).toMatch(/bindLongPress/);
  });

  test("session rows wire long-press → ContextMenu", () => {
    expect(app).toContain("onLongPress={(x, y) => setSessionMenu");
    expect(app).toContain("sessionMenuItems");
    expect(app).toContain('ariaLabel="Session actions"');
  });

  test("tree/session content stays selectable (no blanket user-select:none)", () => {
    // user-select: none only on chrome selectors, never on .messages/.md/.notes.
    const userSelectHits = [...css.matchAll(/([^{}]+)\{[^}]*user-select:\s*none/g)].map((m) => (m[1] ?? "").trim());
    for (const sel of userSelectHits) {
      expect(sel).not.toMatch(/\.messages|\.md\b|\.notes|\.tree-name|\.li-title/);
    }
  });
});

describe("settings + CRUD on mobile (Phase 5)", () => {
  test("CRUD form action rows stack full-width on phones", () => {
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.agents-actions\s*\{[^}]*flex-direction:\s*column/);
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.agents-actions \.btn\s*\{[^}]*width:\s*100%/);
  });

  test("settings + agents panes scroll (no 50/50 split below 640px)", () => {
    // .app is already flex-direction: column at 640 — nested strip stacks above
    // the pane. Panes must scroll rather than clip the form.
    expect(css).toMatch(/\.settings-pane\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.agents-pane\s*\{[^}]*overflow-y:\s*auto/);
  });

  test("coarse form actions clear HIG", () => {
    const coarse = [...css.matchAll(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    expect(coarse).toMatch(/\.agents-actions[^{]*\{[^}]*min-height:\s*var\(--control-h-lg\)/);
  });

  test("combobox popup is dvh-capped on phones", () => {
    expect(componentsCss).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.combobox-pop\s*\{[^}]*dvh/);
  });
});

describe("image/video/analytics (Phase 6)", () => {
  const imageSrc = readFileSync(fileURLToPath(new URL("../src/image.tsx", import.meta.url)), "utf8");
  const videoSrc = readFileSync(fileURLToPath(new URL("../src/video.tsx", import.meta.url)), "utf8");
  const inViewSrc = readFileSync(fileURLToPath(new URL("../src/use-in-view.ts", import.meta.url)), "utf8");
  const analyticsSrc = readFileSync(fileURLToPath(new URL("../src/analytics.tsx", import.meta.url)), "utf8");

  test("use-in-view is extracted as a shared hook", () => {
    expect(inViewSrc).toContain("IntersectionObserver");
    expect(imageSrc).toContain('from "./use-in-view"');
    expect(videoSrc).toContain('from "./use-in-view"');
  });

  test("galleries auto-load the next page via an in-view sentinel", () => {
    expect(imageSrc).toContain("gallerySentinelRef");
    expect(imageSrc).toMatch(/gallerySentinelInView && galleryHasMore/);
    expect(videoSrc).toContain("gallerySentinelRef");
    expect(videoSrc).toMatch(/gallerySentinelInView && galleryHasMore/);
    // Manual Load more remains as a fallback.
    expect(imageSrc).toContain("Load more");
    expect(videoSrc).toContain("Load more");
  });

  test("image-card menu button is finger-sized on coarse / always visible on hover:none", () => {
    const coarse = [...css.matchAll(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    expect(coarse).toMatch(/\.image-card-menu-btn\s*\{[^}]*width:\s*44px/);
    expect(css).toMatch(/@media \(hover: none\)[\s\S]*?\.image-card-menu-btn\s*\{[^}]*opacity:\s*1/);
  });

  test("chart ticks floor at 12px on touch", () => {
    expect(analyticsSrc).toMatch(/CHART_TICK_FONT_SIZE\s*=\s*isCoarsePointer\(\)\s*\?\s*12\s*:\s*11/);
  });
});

describe("KeyBar + visualViewport refit (Phase 7)", () => {
  const keyBarSrc = readFileSync(fileURLToPath(new URL("../src/components/KeyBar.tsx", import.meta.url)), "utf8");
  const viewportSrc = readFileSync(fileURLToPath(new URL("../src/viewport.ts", import.meta.url)), "utf8");
  const mainSrc = readFileSync(fileURLToPath(new URL("../src/main.tsx", import.meta.url)), "utf8");
  const shellSrc = readFileSync(fileURLToPath(new URL("../src/shell.tsx", import.meta.url)), "utf8");
  const indexSrc = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

  test("KeyBar exists, emits raw terminal bytes, sticky Ctrl/Esc", () => {
    expect(keyBarSrc).toContain("export function KeyBar");
    expect(keyBarSrc).toContain('role="toolbar"');
    expect(keyBarSrc).toContain("useCoarsePointer");
    expect(keyBarSrc).toMatch(/setCtrl/);
    expect(keyBarSrc).toMatch(/setEsc/);
    // Control codes: Ctrl+letter computed as code-64 (Ctrl+C = 0x03),
    // Esc = 0x1b, Backspace = 0x7f, arrows are CSI sequences.
    expect(keyBarSrc).toContain("String.fromCharCode(code - 64)");
    expect(keyBarSrc).toContain("\\x1b");
    expect(keyBarSrc).toContain("\\x7f");
    expect(keyBarSrc).toContain("\\x1b[A"); // arrow up CSI
    expect(keyBarSrc).toContain("\\r"); // Enter
    // Screens compose components/ — KeyBar is the library (raw <button> OK).
    expect(keyBarSrc).toContain("<button");
  });

  test("KeyBar CSS: 44px keys, hidden on fine pointers, safe-area", () => {
    expect(css).toMatch(/\.key-bar-key\s*\{[^}]*min-width:\s*44px/);
    expect(css).toMatch(/\.key-bar-key\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/\.key-bar\s*\{[^}]*env\(safe-area-inset-bottom/);
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\)[\s\S]*?\.key-bar\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.key-bar-key\s*\{[^}]*font-size:\s*var\(--control-text\)/);
  });

  test("shell mounts KeyBar and wires term.input", () => {
    expect(shellSrc).toContain("<KeyBar");
    expect(shellSrc).toContain("termRef");
    expect(shellSrc).toMatch(/termRef\.current\?\.input\(/);
    expect(shellSrc).toContain("disabled={status !== \"open\"}");
  });

  test("viewport module listens to visualViewport and writes --keyboard-inset", () => {
    expect(viewportSrc).toContain("visualViewport");
    expect(viewportSrc).toContain("--vvh");
    expect(viewportSrc).toContain("--keyboard-inset");
    expect(viewportSrc).toContain("initViewportRefit");
    expect(mainSrc).toContain("initViewportRefit");
    // Keyboard heuristic: shrink > 120px below layout viewport.
    expect(viewportSrc).toMatch(/KEYBOARD_SLOP_PX\s*=\s*120/);
  });

  test("index.html: no zoom lock, interactive-widget, apple PWA meta", () => {
    expect(indexSrc).not.toMatch(/maximum-scale/);
    expect(indexSrc).not.toMatch(/user-scalable\s*=\s*no/i);
    expect(indexSrc).toContain("viewport-fit=cover");
    expect(indexSrc).toContain("interactive-widget=resizes-content");
    expect(indexSrc).toContain('apple-mobile-web-app-capable');
    expect(indexSrc).toContain('rel="apple-touch-icon"');
  });
});

describe("PWA icons (Phase 8)", () => {
  const config = readFileSync(fileURLToPath(new URL("../vite.config.ts", import.meta.url)), "utf8");
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));

  test("manifest ships 192/512 PNG + maskable icons", () => {
    expect(config).toContain("/icon-192.png");
    expect(config).toContain("/icon-512.png");
    expect(config).toContain("/icon-maskable-512.png");
    expect(config).toMatch(/purpose:\s*"maskable"/);
    expect(config).toMatch(/sizes:\s*"192x192"/);
    expect(config).toMatch(/sizes:\s*"512x512"/);
    expect(config).toMatch(/type:\s*"image\/png"/);
  });

  test("icon files exist on disk", () => {
    for (const f of ["icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) {
      expect(readFileSync(`${publicDir}/${f}`).length, `${f} missing or empty`).toBeGreaterThan(0);
    }
  });
});
