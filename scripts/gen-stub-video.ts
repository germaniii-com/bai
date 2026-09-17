/**
 * Regenerate the embedded offline-video stub clip.
 *
 * The video stub (`core/src/workbench/media/video/stub.ts`) returns a tiny
 * deterministic MP4 so the workbench, gallery, and tests work with no provider
 * key. This script (re)generates `stub-mp4.ts` from a source clip:
 *
 *   1. Generate a clip with ffmpeg, e.g.:
 *        ffmpeg -f lavfi -i color=c=0x1e1e2e:s=320x180:d=1:r=8 \
 *          -c:v libx264 -pix_fmt yuv420p -movflags +faststart -y stub.mp4
 *   2. bun run scripts/gen-stub-video.ts /path/to/stub.mp4
 *
 * Run from the repo root (bai-ts/).
 */
import { readFileSync, writeFileSync } from "node:fs";

const source = process.argv[2];
if (source === undefined) {
  console.error("usage: bun run scripts/gen-stub-video.ts <path-to-mp4>");
  process.exit(1);
}

const b64 = readFileSync(source).toString("base64");
const out =
  "// Generated from a 1s 320x180 H.264 clip — the offline video stub.\n" +
  "// Regenerate with scripts/gen-stub-video.ts; do not hand-edit.\n" +
  "export const STUB_MP4_B64 =\n  " +
  JSON.stringify(b64) +
  ";\n";
const target = "packages/core/src/workbench/media/video/stub-mp4.ts";
writeFileSync(target, out);
console.log(`wrote ${target} (${b64.length} b64 chars)`);
