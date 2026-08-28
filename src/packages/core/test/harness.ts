import { mkdtempSync } from "node:fs";
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
} from "../src";
import { DEFAULT_CONFIG, type Event, type EventType } from "@bai/shared";
export interface TestCore {
  dir: string;
  store: Store;
  bus: Bus;
  log: EventLog;
  core: Service;
}

/** Full core stack against a throwaway data dir. */
export function makeCore(): TestCore {
  const dir = mkdtempSync(join(tmpdir(), "bai-test-"));
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
  const core = new Service({
    store,
    bus,
    log,
    providers,
    tools,
    workbenches,
    jobs,
    config: () => ({ ...DEFAULT_CONFIG, models: { default: "stub/echo" } }),
    version: "test",
  });
  return { dir, store, bus, log, core };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Subscribe first, then poll until the expected event arrives (payload typed). */
export async function waitForEvent<K extends EventType>(
  bus: Bus,
  type: K,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Event<K>> {
  const sub = bus.subscribe();
  const deadline = Date.now() + (opts.timeoutMs ?? 3000);
  try {
    while (Date.now() < deadline) {
      for (const evt of sub.take()) {
        if (evt.type === type) return evt as Event<K>;
      }
      if (opts.signal?.aborted) throw new Error("aborted while waiting");
      await sleep(10);
    }
    throw new Error(`timeout waiting for event "${type}"`);
  } finally {
    bus.unsubscribe(sub.id);
  }
}
