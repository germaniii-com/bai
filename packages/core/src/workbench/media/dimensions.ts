/**
 * Minimal image-dimension reader for generated assets. Providers return only
 * base64 bytes + a media type, so the gallery card's "1920x1080" is parsed
 * from the image header itself. Supports PNG, GIF, JPEG, WebP (VP8X), and SVG;
 * unknown formats return undefined (the card then shows only the ratio).
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

export function imageDimensions(bytes: Uint8Array, mime: string): ImageDimensions | undefined {
  if (mime === "image/svg+xml" || mime === "image/svg") return svgDimensions(bytes);
  if (bytes.length < 10) return undefined;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return pngDimensions(bytes);
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return gifDimensions(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegDimensions(bytes);
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return webpDimensions(bytes);
  }
  return undefined;
}

/** A known raster signature (used to reject non-image provider payloads). */
export function looksLikeImage(bytes: Uint8Array, mime: string): boolean {
  if (mime.startsWith("image/")) {
    if (mime === "image/svg+xml" || mime === "image/svg") return true;
    return imageDimensions(bytes, mime) !== undefined;
  }
  return false;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 24) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 10) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  let offset = 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    // Standalone markers have no length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 30) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourCC = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
  if (fourCC === "VP8X") {
    const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
    const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
    return { width, height };
  }
  if (fourCC === "VP8 ") {
    // Lossy VP8 frame header: 3-byte frame tag, 3-byte start code, then 16-bit dims.
    if (bytes.length < 30) return undefined;
    const width = view.getUint16(26, true) & 0x3fff;
    const height = view.getUint16(28, true) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  return undefined;
}

function svgDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  const width = /\bwidth=["']?([\d.]+)/i.exec(text)?.[1];
  const height = /\bheight=["']?([\d.]+)/i.exec(text)?.[1];
  if (width !== undefined && height !== undefined) {
    const w = Math.round(Number.parseFloat(width));
    const h = Math.round(Number.parseFloat(height));
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h };
  }
  const viewBox = /\bviewBox=["']?([\d.\s-]+)/i.exec(text)?.[1];
  if (viewBox !== undefined) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4) {
      const w = Math.round(parts[2] ?? 0);
      const h = Math.round(parts[3] ?? 0);
      if (w > 0 && h > 0) return { width: w, height: h };
    }
  }
  return undefined;
}
