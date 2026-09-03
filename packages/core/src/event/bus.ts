import type { Event } from "@bai/shared";

export interface Subscription {
  readonly id: number;
  /** Set when events were dropped for this subscriber (slow consumer). */
  stale: boolean;
  /** Drain buffered events. */
  take(): Event[];
  /** Resolves when new events arrive (or the subscription closes/aborts). */
  wait(signal?: AbortSignal): Promise<void>;
  close(): void;
}

class SubState implements Subscription {
  stale = false;
  buffer: Event[] = [];
  private resolvers: Array<() => void> = [];
  private closed = false;

  constructor(
    readonly id: number,
    private readonly cap: number,
    private readonly onNotify?: () => void,
  ) {}

  push(evt: Event): void {
    if (this.closed) return;
    if (this.buffer.length >= this.cap) {
      this.stale = true;
      this.buffer.length = 0;
    }
    this.buffer.push(evt);
    this.wake();
  }

  take(): Event[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.closed || this.buffer.length > 0 || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let resolver: () => void = () => {};
      const onAbort = () => resolver();
      resolver = () => {
        signal?.removeEventListener("abort", onAbort);
        const i = this.resolvers.indexOf(resolver);
        if (i >= 0) this.resolvers.splice(i, 1);
        resolve();
      };
      this.resolvers.push(resolver);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const resolvers = this.resolvers.splice(0);
    for (const r of resolvers) r();
    this.onNotify?.();
  }
}

/**
 * In-process pub/sub feeding the live SSE firehose. Topic-less by design —
 * subscribers filter by event type / session. Slow consumers are dropped and
 * marked stale (their owner triggers a snapshot refresh); publishers never
 * block and drops are never silent.
 */
export class Bus {
  private subs = new Map<number, SubState>();
  private nextId = 1;

  subscribe(opts: { buffer?: number; onNotify?: () => void } = {}): Subscription {
    const sub = new SubState(this.nextId++, opts.buffer ?? 1024, opts.onNotify);
    this.subs.set(sub.id, sub);
    return sub;
  }

  unsubscribe(id: number): void {
    this.subs.get(id)?.close();
    this.subs.delete(id);
  }

  publish(evt: Event): void {
    for (const sub of this.subs.values()) sub.push(evt);
  }

  subscriberCount(): number {
    return this.subs.size;
  }
}
