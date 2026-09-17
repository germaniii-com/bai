import { existsSync } from "node:fs";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";

/**
 * First-frame poster extraction for generated videos.
 *
 * The job queue runs this once per produced video: ffmpeg writes a small JPEG
 * beside the video file, and the asset's meta carries `posterPath`/`posterMime`
 * so the API can serve it (`GET /api/asset/:id/poster`). Wall galleries then
 * render the still image — the `<video>` element is only instantiated in the
 * full-screen modal.
 *
 * Best-effort by design: a missing ffmpeg (e.g. a compiled binary that can't
 * ship the static asset) or an undecodable stream leaves the asset with no
 * poster and never fails the job. Set `BAI_VIDEO_POSTERS=0` to disable.
 */

let resolvedBin: string | null | undefined;

/** The ffmpeg binary: `FFMPEG_PATH` → bundled ffmpeg-static → system PATH. */
function ffmpegBin(): string {
  if (resolvedBin !== undefined && resolvedBin !== null) return resolvedBin;
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) {
    resolvedBin = fromEnv;
    return resolvedBin;
  }
  if (typeof ffmpegStatic === "string" && ffmpegStatic.length > 0 && existsSync(ffmpegStatic)) {
    resolvedBin = ffmpegStatic;
    return resolvedBin;
  }
  // Compiled binaries cannot embed the static asset — fall back to PATH.
  resolvedBin = "ffmpeg";
  return resolvedBin;
}

export interface VideoPoster {
  path: string;
  mime: string;
}

/** The poster's sibling path for a stored video file (`…/id.mp4` → `…/id.poster.jpg`). */
export function posterPathFor(videoPath: string): string {
  const ext = path.extname(videoPath);
  return `${videoPath.slice(0, videoPath.length - ext.length)}.poster.jpg`;
}

/**
 * Extract the first frame of `videoPath` into `outPath` as a JPEG (scaled to
 * `width`, height preserved). Returns undefined when disabled or on failure.
 */
export async function extractVideoPoster(
  videoPath: string,
  outPath: string,
  opts: { width?: number } = {},
): Promise<VideoPoster | undefined> {
  if (process.env.BAI_VIDEO_POSTERS === "0") return undefined;
  const width = opts.width ?? 640;
  const bin = ffmpegBin();
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${width}:-2`,
    "-q:v",
    "4",
    outPath,
  ];
  try {
    const proc = Bun.spawn([bin, ...args], { stdout: "ignore", stderr: "ignore" });
    const code = await proc.exited;
    if (code !== 0 || !existsSync(outPath)) return undefined;
    return { path: outPath, mime: "image/jpeg" };
  } catch {
    // No ffmpeg / spawn failure — the video still renders without a poster.
    return undefined;
  }
}
