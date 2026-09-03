import type { Event, EventType } from "@bai/shared";
import type { EventsRepo } from "../store/events";

/**
 * Durable, per-aggregate event storage with monotonic sequence numbers and
 * cursor replay. `append` allocates the next seq inside the same transaction
 * as the state change it describes (the repos own those transactions; the
 * service appends right after mutating).
 */
export class EventLog {
  constructor(private repo: EventsRepo) {}

  append(aggregateId: string, type: EventType, payload: unknown, now: string): Event {
    return this.repo.append(aggregateId, type, payload, now);
  }

  /** Rows with seq > after, ascending. Gaps are impossible — the DB is the buffer. */
  replay(aggregateId: string, after: number): Event[] {
    return this.repo.replay(aggregateId, after);
  }

  latestSeq(aggregateId: string): number {
    return this.repo.latestSeq(aggregateId);
  }
}
