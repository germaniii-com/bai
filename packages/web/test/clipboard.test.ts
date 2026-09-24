import { describe, expect, test } from "bun:test";
import { clipboardImageFiles } from "../src/clipboard";

function file(type: string, name = "x"): File {
  return { type, name } as unknown as File;
}

describe("clipboardImageFiles", () => {
  test("collects image files from dataTransfer.files (screenshots)", () => {
    const dt = {
      files: [file("image/png", "shot.png"), file("text/plain", "a.txt")],
      items: [],
    } as unknown as DataTransfer;
    expect(clipboardImageFiles(dt).map((f) => f.type)).toEqual(["image/png"]);
  });

  test("falls back to items when files is empty", () => {
    const dt = {
      files: [],
      items: [{ kind: "file", type: "image/jpeg", getAsFile: () => file("image/jpeg") }],
    } as unknown as DataTransfer;
    expect(clipboardImageFiles(dt)).toHaveLength(1);
  });

  test("null and text-only pastes yield nothing", () => {
    expect(clipboardImageFiles(null)).toEqual([]);
    expect(clipboardImageFiles({ files: [], items: [] } as unknown as DataTransfer)).toEqual([]);
    expect(
      clipboardImageFiles({ files: [file("text/plain")], items: [] } as unknown as DataTransfer),
    ).toEqual([]);
  });
});
