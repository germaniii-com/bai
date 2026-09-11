import { checkpointAndClose, openDb, type SqliteDb } from "./db";
import type { Input, Message, SessionId } from "@bai/shared";
import type { HistoryCursor } from "./messages";
import { AssetsRepo } from "./assets";
import { AutomationsRepo, AutomationRunsRepo } from "./automations";
import { EventsRepo } from "./events";
import { InputsRepo } from "./inputs";
import { JobsRepo } from "./jobs";
import { KvRepo } from "./kv";
import { MessagesRepo, PartsRepo } from "./messages";
import { PermissionsRepo } from "./permissions";
import { SessionsRepo } from "./sessions";
import { SkillUsageRepo } from "./skill-usage";
import { UsageRepo } from "./usage";

/**
 * The only SQL-talking object in the repo. One connection, WAL, explicit
 * transactions. Media blobs live on disk — rows hold metadata + paths.
 */
export class Store {
  readonly sessions: SessionsRepo;
  readonly messages: MessagesRepo;
  readonly parts: PartsRepo;
  readonly inputs: InputsRepo;
  readonly events: EventsRepo;
  readonly permissions: PermissionsRepo;
  readonly jobs: JobsRepo;
  readonly assets: AssetsRepo;
  readonly kv: KvRepo;
  readonly usage: UsageRepo;
  readonly skillUsage: SkillUsageRepo;
  readonly automations: AutomationsRepo;
  readonly automationRuns: AutomationRunsRepo;
  private readonly db: SqliteDb;

  constructor(file: string) {
    this.db = openDb(file);
    this.sessions = new SessionsRepo(this.db);
    this.messages = new MessagesRepo(this.db);
    this.parts = new PartsRepo(this.db);
    this.inputs = new InputsRepo(this.db);
    this.events = new EventsRepo(this.db);
    this.permissions = new PermissionsRepo(this.db);
    this.jobs = new JobsRepo(this.db);
    this.assets = new AssetsRepo(this.db);
    this.kv = new KvRepo(this.db);
    this.usage = new UsageRepo(this.db);
    this.skillUsage = new SkillUsageRepo(this.db);
    this.automations = new AutomationsRepo(this.db);
    this.automationRuns = new AutomationRunsRepo(this.db);
  }

  close(): void {
    checkpointAndClose(this.db);
  }

  /**
   * Consistent snapshot for snapshot-then-stream surfaces: paged history plus
   * the event-log frontier to resume the session stream from. Both reads share
   * one transaction — reading them separately races an in-flight run (either a
   * missing message or a replayed duplicate). `pendingInputs` seeds the
   * surfaces' queued-message lists (admitted, not yet promoted).
   * No opts → full history (legacy); `{limit}` → newest N + hasMore cursor.
   */
  sessionSnapshot(sessionId: SessionId, opts: { limit?: number; before?: HistoryCursor } = {}): {
    messages: Message[];
    afterSeq: number;
    pendingInputs: Input[];
    hasMore: boolean;
    nextCursor?: string;
  } {
    return this.db.transaction(() => {
      const page = this.messages.historyPage(sessionId, opts);
      return {
        messages: page.messages,
        afterSeq: this.events.latestSeq(sessionId),
        pendingInputs: this.inputs.pendingBySession(sessionId),
        hasMore: page.hasMore,
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      };
    })();
  }
}

export { openDb, checkpointAndClose };
export type { SqliteDb };
