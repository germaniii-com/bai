import { describe, expect, test } from "bun:test";
import { buildCommandSpecs, flattenSections, paletteSections, SUGGESTED_LABEL, type CommandContext } from "../src/state/commands";

/**
 * The supermenu's pure registry: context-driven Suggested flags, the
 * Suggested-first + category-grouped sectioning, and the flat filtered
 * view — the exact math the palette renders.
 */

const ctx: CommandContext = {
  sessionCount: 0,
  hasActiveSession: false,
  needsSetup: false,
  awayFromChat: false,
};

describe("buildCommandSpecs", () => {
  test("full v1 registry in display order", () => {
    const specs = buildCommandSpecs(ctx);
    expect(specs.map((s) => s.id)).toEqual([
      "session.switch",
      "session.new",
      "model.switch",
      "provider.connect",
      "agent.switch",
      "theme.switch",
      "view.gallery",
      "view.settings",
      "view.chat",
      "app.quit",
    ]);
  });

  test("context flags drive Suggested (opencode's contextual semantics)", () => {
    const none = buildCommandSpecs(ctx).filter((s) => s.suggested);
    expect(none).toEqual([]);

    const live = buildCommandSpecs({
      sessionCount: 2,
      hasActiveSession: true,
      needsSetup: true,
      awayFromChat: true,
    });
    expect(live.filter((s) => s.suggested).map((s) => s.id)).toEqual([
      "session.switch",
      "session.new",
      "provider.connect",
      "view.chat",
    ]);
  });
});

describe("paletteSections", () => {
  test("empty query: Suggested section first, then category groups in registry order", () => {
    const sections = paletteSections(buildCommandSpecs({ ...ctx, needsSetup: true }), "");
    expect(sections.map((s) => s.label)).toEqual([
      SUGGESTED_LABEL,
      "Session",
      "Model",
      "Provider",
      "Agent",
      "Theme",
      "View",
      "System",
    ]);
    // Suggested floats Connect provider; the full registry still follows.
    expect(sections[0]!.commands.map((c) => c.id)).toEqual(["provider.connect"]);
    expect(sections[3]!.commands.map((c) => c.id)).toEqual(["provider.connect"]);
  });

  test("no suggested flags: no Suggested section at all", () => {
    const sections = paletteSections(buildCommandSpecs(ctx), "");
    expect(sections[0]!.label).toBe("Session");
  });

  test("adjacent same-category specs share one group; a category gap reopens one", () => {
    const specs = buildCommandSpecs(ctx);
    // View sits in one contiguous block in the registry — both entries in
    // one group despite being two commands.
    const view = sections_noSuggested(specs).find((s) => s.label === "View");
    expect(view?.commands.map((c) => c.id)).toEqual(["view.gallery", "view.settings", "view.chat"]);
  });

  test("filter matches title, category, or id, case-insensitively, as one flat section", () => {
    const specs = buildCommandSpecs(ctx);
    const byTitle = paletteSections(specs, "session");
    expect(byTitle[0]!.label).toBeNull();
    expect(byTitle[0]!.commands.map((c) => c.id)).toEqual(["session.switch", "session.new"]);

    // Category match: every View command.
    const byCategory = paletteSections(specs, "view");
    expect(byCategory[0]!.commands.map((c) => c.id)).toEqual(["view.gallery", "view.settings", "view.chat"]);

    // Id match.
    const byId = paletteSections(specs, "provider.connect");
    expect(byId[0]!.commands.map((c) => c.id)).toEqual(["provider.connect"]);
  });

  test("no matches: flat section with an empty command list", () => {
    const sections = paletteSections(buildCommandSpecs(ctx), "zzz");
    expect(sections).toEqual([{ label: null, commands: [] }]);
  });
});

describe("flattenSections", () => {
  test("walks sections in order — the cursor path across headers", () => {
    const sections = paletteSections(buildCommandSpecs({ ...ctx, needsSetup: true }), "");
    const flat = flattenSections(sections);
    // Suggested first, then every registry command in order.
    expect(flat[0]!.id).toBe("provider.connect");
    expect(flat.length).toBe(11);
    expect(flat.slice(1).map((c) => c.id)).toEqual(buildCommandSpecs({ ...ctx, needsSetup: true }).map((c) => c.id));
  });
});

function sections_noSuggested(specs: ReturnType<typeof buildCommandSpecs>) {
  return paletteSections(specs, "");
}
