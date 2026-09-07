import { Snapshot, snapshotDir } from "./packages/core/src/snapshot";

const cwd = "/var/folders/xn/hfdb4mhn7rsfp9ywrwdrrldr0000gn/T/opencode/bai-live/git-ws";
const snap = new Snapshot(snapshotDir("/var/folders/xn/hfdb4mhn7rsfp9ywrwdrrldr0000gn/T/opencode/bai-live/data"));
const enabled = await snap.enabled(cwd);
console.log("enabled:", enabled);
const hash = await snap.track(cwd).catch((e) => `track-error: ${e.message}`);
console.log("hash:", hash);
if (typeof hash === "string") {
  const files = await snap.patch(cwd, hash).catch((e) => `patch-error: ${e.message}`);
  console.log("patch files (vs pre-write tree):", files);
}
process.exit(0);
