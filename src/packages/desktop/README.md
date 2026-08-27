# @bai/desktop

Native desktop shell — deliberately a **stub until Phase 6**. The web app
already covers desktop use; this shell will add native windowing, menus,
tray, and auto-update once the web UI stabilizes.

## Technology decision (deferred)

Two candidates, to be chosen when Phase 6 starts:

| Option    | Shape                                                                 |
| --------- | --------------------------------------------------------------------- |
| Tauri v2  | Lightweight Rust shell wrapping the same web bundle; small binaries   |
| Electron  | Pure-JS ecosystem; opencode precedent (desktop forks server as sidecar)|

Either way, the contract is identical:

- Render the **same** `@bai/web` bundle — zero UI divergence from web.
- Spawn or reuse the core server: discover an already-running bai via
  `~/.local/state/bai/server.json` (`{url, pid, token}`), else spawn one as a
  child process and pair with it.

## Non-goals (until Phase 6)

- Any package.json / build config here — this directory is documentation only.
- Platform-specific features that would fork the web surface's behavior.

## Notes

- Mirrors the Go design's Wails v3 deferral (decision D10): isolate shell
  churn from the rest of the repo by keeping it contained in this directory.
