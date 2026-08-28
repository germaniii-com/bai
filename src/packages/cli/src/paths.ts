import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Filesystem layout (mirrors the Go design):
 *   data   ~/.local/share/bai     bai.db, assets/, tmp/
 *   config ~/.config/bai          config.json
 *   state  ~/.local/state/bai     server.json
 * XDG vars override; BAI_DATA_DIR overrides everything for tests.
 */
export function dataDir(): string {
  if (process.env.BAI_DATA_DIR !== undefined && process.env.BAI_DATA_DIR !== "") {
    return process.env.BAI_DATA_DIR;
  }
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData !== undefined && xdgData !== "") return path.join(xdgData, "bai");
  return path.join(homedir(), ".local", "share", "bai");
}

export function configDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig !== undefined && xdgConfig !== "") return path.join(xdgConfig, "bai");
  return path.join(homedir(), ".config", "bai");
}

export function stateDir(): string {
  const xdgState = process.env.XDG_STATE_HOME;
  if (xdgState !== undefined && xdgState !== "") return path.join(xdgState, "bai");
  return path.join(homedir(), ".local", "state", "bai");
}

export const dbPath = (): string => path.join(dataDir(), "bai.db");
export const assetsDir = (): string => path.join(dataDir(), "assets");
export const tmpDir = (): string => path.join(dataDir(), "tmp");
export const globalConfigPath = (): string => path.join(configDir(), "config.json");
export const serverStatePath = (): string => path.join(stateDir(), "server.json");

/**
 * Built web SPA resolution order:
 *   1. BAI_WEB_DIST env (explicit override)
 *   2. source-tree layout: import.meta.dir/../../web/dist
 *   3. embedded compile assets (bun ≥ 1.4): import.meta.dir/src/packages/web/dist
 *   4. sibling of the executable (make build copies dist/web for bun 1.3.x,
 *      whose --compile ignores the assets option)
 * undefined → @bai/api renders the "build the web app" hint page.
 */
export function webDistDir(): string | undefined {
  if (process.env.BAI_WEB_DIST !== undefined && process.env.BAI_WEB_DIST !== "") {
    return process.env.BAI_WEB_DIST;
  }
  const candidates = [
    path.join(import.meta.dir, "..", "..", "web", "dist"),
    path.join(import.meta.dir, "src", "packages", "web", "dist"),
    // Sibling of the executable (dist/web) — used by compiled binaries on
    // bun < 1.4, where --compile ignores the assets option. Harmless in
    // source mode (the bun install dir has no web/ sibling).
    path.join(path.dirname(process.execPath), "web"),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return undefined;
}
