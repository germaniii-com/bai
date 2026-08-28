import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Bus,
  EchoProvider,
  EventLog,
  JobQueue,
  ProviderRegistry,
  Service,
  Store,
  ToolRegistry,
  createDefaultWorkbenches,
} from "@bai/core";
import { DEFAULT_CONFIG, type Config } from "@bai/shared";
import type { ApiDeps } from "../src";

export interface TestStack {
  dir: string;
  store: Store;
  bus: Bus;
  core: Service;
  deps: ApiDeps;
  cleanup(): void;
}

/** Full core + Hono app against a throwaway data dir. */
export function makeStack(overrides: Partial<ApiDeps> = {}): TestStack {
  const dir = mkdtempSync(join(tmpdir(), "bai-api-"));
  const store = new Store(join(dir, "test.db"));
  const bus = new Bus();
  const log = new EventLog(store.events);
  const providers = new ProviderRegistry();
  providers.register(new EchoProvider());
  const workbenches = createDefaultWorkbenches({ dataDir: dir });
  const jobs = new JobQueue({
    store,
    bus,
    assetsDir: join(dir, "assets"),
    executors: Object.assign({}, ...workbenches.map((wb) => wb.jobExecutors())),
  });
  const tools = new ToolRegistry({ spillDir: join(dir, "tmp") });
  const config: Config = { ...DEFAULT_CONFIG, models: { default: "stub/echo" } };
  const core = new Service({
    store,
    bus,
    log,
    providers,
    tools,
    workbenches,
    jobs,
    config: () => config,
    version: "test",
  });
  const deps: ApiDeps = {
    core,
    store,
    bus,
    log,
    configStore: {
      get: () => config,
      update: () => config,
    } as unknown as ApiDeps["configStore"],
    jobs,
    providers,
    version: "test",
    loopbackBind: true,
    ...overrides,
  };
  return {
    dir,
    store,
    bus,
    core,
    deps,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
