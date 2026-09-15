import { describe, expect, test } from "bun:test";
import { imageDimensions } from "../src";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(14);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(20);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
}

describe("imageDimensions", () => {
  test("PNG (IHDR)", () => {
    expect(imageDimensions(png(1920, 1080), "image/png")).toEqual({ width: 1920, height: 1080 });
  });

  test("GIF (header)", () => {
    expect(imageDimensions(gif(300, 200), "image/gif")).toEqual({ width: 300, height: 200 });
  });

  test("JPEG (SOF0)", () => {
    expect(imageDimensions(jpeg(640, 480), "image/jpeg")).toEqual({ width: 640, height: 480 });
  });

  test("SVG (width/height attributes)", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="256"></svg>');
    expect(imageDimensions(svg, "image/svg+xml")).toEqual({ width: 512, height: 256 });
  });

  test("unknown format returns undefined (never throws)", () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), "image/png")).toBeUndefined();
    expect(imageDimensions(new Uint8Array(0), "image/webp")).toBeUndefined();
  });
});
