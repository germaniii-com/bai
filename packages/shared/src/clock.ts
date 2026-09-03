/** Injectable clock so time-dependent logic is testable. */
export interface Clock {
  nowMs(): number;
  /** RFC3339 UTC timestamp string. */
  iso(): string;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  iso: () => new Date().toISOString(),
};

/** Fixed clock for tests. */
export function fixedClock(atMs = 1_700_000_000_000): Clock & { advance(ms: number): void } {
  let now = atMs;
  return {
    nowMs: () => now,
    iso: () => new Date(now).toISOString(),
    advance(ms: number) {
      now += ms;
    },
  };
}
