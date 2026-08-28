import { render } from "ink";
import type { BaiClient } from "@bai/api/client";
import { App } from "./app";

export interface RenderedApp {
  waitUntilExit(): Promise<void>;
  unmount(): void;
}

/** Entry used by @bai/cli: full-screen alternate-buffer Ink app. */
export function renderApp(opts: { client: BaiClient; version: string }): RenderedApp {
  const instance = render(<App client={opts.client} version={opts.version} />, {
    alternateScreen: true,
    exitOnCtrlC: true,
  });
  return {
    waitUntilExit: async () => {
      await instance.waitUntilExit();
    },
    unmount: () => instance.unmount(),
  };
}
