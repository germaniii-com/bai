import { render } from "ink";
import type { BaiClient } from "@bai/api/client";
import { App } from "./app";

export interface RenderedApp {
  waitUntilExit(): Promise<void>;
  unmount(): void;
}

/** Entry used by @bai/cli: full-screen alternate-buffer Ink app. */
export function renderApp(opts: { client: BaiClient; version: string; workspaceRoot?: string }): RenderedApp {
  const instance = render(
    <App client={opts.client} version={opts.version} {...(opts.workspaceRoot !== undefined ? { workspaceRoot: opts.workspaceRoot } : {})} />,
    {
      alternateScreen: true,
      // ctrl+c is app-managed (double-press: interrupt, then quit) — the App
      // component owns it via useInput + useApp().exit() so the CLI's finally
      // block still drains the server.
      exitOnCtrlC: false,
    },
  );
  return {
    waitUntilExit: async () => {
      await instance.waitUntilExit();
    },
    unmount: () => instance.unmount(),
  };
}
