import { describe, expect, test } from "bun:test";
import { galleryNavState } from "../src/image-nav";

const images = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("galleryNavState", () => {
  test("returns undefined when nothing is open or the image is not loaded", () => {
    expect(galleryNavState(images, null, { hasMore: false, total: 3 })).toBeUndefined();
    expect(galleryNavState(images, "z", { hasMore: false, total: 3 })).toBeUndefined();
  });

  test("bounds at the first, middle, and last loaded image", () => {
    expect(galleryNavState(images, "a", { hasMore: false, total: 3 })).toEqual({
      index: 0,
      total: 3,
      hasPrevious: false,
      hasNext: true,
    });
    expect(galleryNavState(images, "b", { hasMore: false, total: 3 })).toEqual({
      index: 1,
      total: 3,
      hasPrevious: true,
      hasNext: true,
    });
    expect(galleryNavState(images, "c", { hasMore: false, total: 3 })).toEqual({
      index: 2,
      total: 3,
      hasPrevious: true,
      hasNext: false,
    });
  });

  test("hasMore keeps next enabled at the loaded end", () => {
    expect(galleryNavState(images, "c", { hasMore: true, total: 10 })).toEqual({
      index: 2,
      total: 10,
      hasPrevious: true,
      hasNext: true,
    });
  });

  test("total never drops below the loaded count", () => {
    expect(galleryNavState(images, "b", { hasMore: false, total: 1 })?.total).toBe(3);
  });
});
