import type { Event } from "@bai/shared";
import type { BaiClient } from "./index";

/**
 * One shared SSE connection (the global firehose) fanned out to N
 * subscribers.
 *
 * Browsers cap ~6 concurrent connections per origin, and a page's budget is
 * already spoken for: the global firehose + the active session's durable
 * stream (see SubagentStream's polling rationale — the same math). Before
 * the mux, every consumer of global events opened its OWN firehose
 * connection (App's sync engine AND useProviders' provider/config watcher —
 * identical streams), tripling the held-connection cost for zero extra
 * information. The mux restores the budget: ONE connection, fanned out.
 *
 * Refcounted: the first subscribe opens the reconnect loop, the last
 * unsubscribe aborts it. Reconnects use the same 500ms backoff as
 * `followGlobal`; every (re)connect delivers `server.hello` through the
 * fan-out — the existing heal contract (surfaces refresh their snapshots on
 * it). A throwing subscriber is isolated: it must never tear the shared
 * stream down for everyone else.
 */
export class EventMux {
  private handlers = new Set<(evt: Event) => void>();
  private ctrl: AbortController | null = null;
  private running = false;
  private stopped = false;
  private pageHideWired = false;

  /** `open` yields the live event stream; aborting the signal closes it. */
  constructor(private open: (signal: AbortSignal) => AsyncGenerator<Event>) {}

  /** Fan `evt` out to every subscriber. Returns the unsubscribe function. */
  subscribe(handler: (evt: Event) => void): () => void {
    this.handlers.add(handler);
    this.stopped = false;
    this.wirePageHide();
    void this.ensureLoop();
    return () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0) {
        this.stopped = true;
        this.ctrl?.abort();
        this.ctrl = null;
      }
    };
  }

  /**
   * Abort the held connection when the page hides. Renderer destruction
   * does NOT cancel streaming fetches: without this, every reload leaks its
   * SSE into the browser's per-origin connection budget until new requests
   * queue forever. The abort is temporary — the loop's backoff reconnects
   * when the page is restored (bfcache) and dies with a destroyed page.
   */
  private wirePageHide(): void {
    if (this.pageHideWired) return;
    this.pageHideWired = true;
    // Browser only (the TUI/CLI never construct a mux over a window), and
    // typed lib-agnostic — @bai/api compiles without the DOM lib.
    const g = globalThis as {
      addEventListener?: (type: string, listener: () => void) => void;
    };
    if (typeof g.addEventListener !== "function") return;
    g.addEventListener("pagehide", () => {
      this.ctrl?.abort();
      this.ctrl = null;
    });
  }

  /** Reconnect loop — runs while at least one subscriber is attached. */
  private async ensureLoop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && this.handlers.size > 0) {
        const ctrl = new AbortController();
        this.ctrl = ctrl;
        try {
          for await (const evt of this.open(ctrl.signal)) {
            for (const handler of [...this.handlers]) {
              try {
                handler(evt);
              } catch (err) {
                // One bad subscriber must not reconnect the shared stream.
                console.error(`[bai] event mux subscriber failed: ${err instanceof Error ? err.message : err}`);
              }
            }
          }
        } catch {
          // Drop — reconnect below unless the last subscriber just left.
        }
        this.ctrl = null;
        if (this.stopped || this.handlers.size === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      this.running = false;
    }
  }
}

const muxes = new WeakMap<object, EventMux>();

/** The per-client mux singleton — one global firehose connection per client. */
export function eventMux(client: BaiClient): EventMux {
  let mux = muxes.get(client);
  if (mux === undefined) {
    mux = new EventMux((signal) => client.globalEvents({ signal }));
    muxes.set(client, mux);
  }
  return mux;
}
