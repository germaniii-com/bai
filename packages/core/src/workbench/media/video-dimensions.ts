/**
 * Minimal video container probe: reads width/height/duration straight from the
 * produced bytes (providers return no sidecar for most models), so gallery
 * cards can show `1920×1080 · 8s`. MP4/MOV (ISO BMFF) is fully supported; WebM
 * is sniffed but not probed (returns undefined), which the surfaces render as
 * "no dimensions" rather than failing.
 */

export interface VideoProbe {
  width?: number;
  height?: number;
  durationSeconds?: number;
}

/** A known video signature (used to reject non-video provider payloads). */
export function looksLikeVideo(bytes: Uint8Array, mime: string): boolean {
  if (mime.startsWith("video/")) return sniffVideoMime(bytes) !== undefined || bytes.byteLength > 0;
  return false;
}

/** Magic-byte video mime sniff (mp4/mov/webm), for providers that omit it. */
export function sniffVideoMime(bytes: Uint8Array): string | undefined {
  // ISO BMFF: `....ftyp` at offset 4.
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }
  // EBML header (WebM / Matroska).
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
  ) {
    return "video/webm";
  }
  return undefined;
}

/** File extension for a video mime. */
export function videoExtForMime(mime: string): string {
  switch (mime) {
    case "video/quicktime":
      return "mov";
    case "video/webm":
      return "webm";
    case "video/x-matroska":
      return "mkv";
    case "video/mpeg":
      return "mpeg";
    default:
      return "mp4";
  }
}

/** Probe an mp4/mov container for dimensions + duration (best-effort). */
export function videoProbe(bytes: Uint8Array, mime?: string): VideoProbe | undefined {
  if (mime !== undefined && mime.length > 0) {
    if (mime.startsWith("video/webm") || mime.startsWith("video/x-matroska")) return undefined;
  }
  if (!isIsoBmff(bytes)) return undefined;
  const out: VideoProbe = {};
  const moov = findBox(bytes, 0, bytes.length, "moov");
  const scope = moov ?? { start: 0, end: bytes.length };
  const mvhd = findBox(bytes, scope.start, scope.end, "mvhd");
  if (mvhd !== undefined) {
    const duration = readMvhdDuration(bytes, mvhd.start, mvhd.end);
    if (duration !== undefined) out.durationSeconds = duration;
  }
  const tkhd = findBox(bytes, scope.start, scope.end, "tkhd");
  if (tkhd !== undefined) {
    const dims = readTkhdDimensions(bytes, tkhd.start, tkhd.end);
    if (dims !== undefined) {
      out.width = dims.width;
      out.height = dims.height;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

interface Box {
  start: number;
  end: number;
}

function isIsoBmff(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  );
}

/** Container boxes whose children are worth descending into. */
const CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "moof", "traf"]);

/** Find the first descendant box of `type` in [start,end) (recursive scan). */
function findBox(bytes: Uint8Array, start: number, end: number, type: string): Box | undefined {
  let offset = start;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 8 <= end) {
    const size = view.getUint32(offset);
    const boxType = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    let header = 8;
    let boxSize = size;
    if (size === 1) {
      if (offset + 16 > end) return undefined;
      boxSize = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      boxSize = end - offset;
    }
    if (boxSize < header || offset + boxSize > end) return undefined;
    if (boxType === type) return { start: offset + header, end: offset + boxSize };
    if (CONTAINER_BOXES.has(boxType)) {
      const nested = findBox(bytes, offset + header, offset + boxSize, type);
      if (nested !== undefined) return nested;
    }
    offset += boxSize;
  }
  return undefined;
}

function readMvhdDuration(bytes: Uint8Array, start: number, end: number): number | undefined {
  if (start + 4 > end) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[start] ?? 0;
  if (version === 1) {
    if (start + 32 > end) return undefined;
    const timescale = view.getUint32(start + 20);
    const duration = Number(view.getBigUint64(start + 24));
    return timescale > 0 ? duration / timescale : undefined;
  }
  if (start + 20 > end) return undefined;
  const timescale = view.getUint32(start + 12);
  const duration = view.getUint32(start + 16);
  return timescale > 0 ? duration / timescale : undefined;
}

function readTkhdDimensions(bytes: Uint8Array, start: number, end: number): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[start] ?? 0;
  const base = version === 1 ? start + 88 : start + 76;
  if (base + 8 > end) return undefined;
  const width = view.getUint32(base) / 65536;
  const height = view.getUint32(base + 4) / 65536;
  return width > 0 && height > 0 ? { width, height } : undefined;
}
