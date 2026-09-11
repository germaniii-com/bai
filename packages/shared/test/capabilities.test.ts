import { describe, expect, test } from "bun:test";
import { modelCapabilities, supportsThinking, supportsVision } from "../src/capabilities";
import type { ModelInfo } from "../src/domain";

function model(partial: Partial<ModelInfo> & { id: string }): ModelInfo {
  return { provider: partial.id.split("/")[0] ?? "p", label: partial.id, ...partial };
}

describe("model capabilities", () => {
  test("thinking follows the catalog reasoning flag", () => {
    expect(supportsThinking(model({ id: "p/a", reasoning: true }))).toBe(true);
    expect(supportsThinking(model({ id: "p/b", reasoning: false }))).toBe(false);
    expect(supportsThinking(model({ id: "p/c" }))).toBe(false);
  });

  test("vision follows the image input modality, not attachments", () => {
    expect(supportsVision(model({ id: "p/a", inputModalities: ["text", "image"] }))).toBe(true);
    // attachment alone also covers PDFs — not a vision signal
    expect(supportsVision(model({ id: "p/b", supportsAttachments: true }))).toBe(false);
    // text/pdf-only is not vision
    expect(supportsVision(model({ id: "p/c", inputModalities: ["text", "pdf"] }))).toBe(false);
    expect(supportsVision(model({ id: "p/d" }))).toBe(false);
  });

  test("modelCapabilities orders thinking then vision and omits the unknown", () => {
    expect(
      modelCapabilities(
        model({ id: "p/both", reasoning: true, inputModalities: ["text", "image", "pdf"] }),
      ).map((c) => c.key),
    ).toEqual(["thinking", "vision"]);
    expect(modelCapabilities(model({ id: "p/plain" }))).toEqual([]);
    expect(modelCapabilities(model({ id: "p/vision", inputModalities: ["text", "image"] }))).toEqual([
      { key: "vision", label: "vision", hint: "This model supports vision" },
    ]);
  });

  test("capability descriptors carry the hover hints the web renders", () => {
    const caps = modelCapabilities(model({ id: "p/both", reasoning: true, inputModalities: ["image"] }));
    expect(caps[0]?.hint).toBe("This model supports thinking");
    expect(caps[1]?.hint).toBe("This model supports vision");
  });
});
