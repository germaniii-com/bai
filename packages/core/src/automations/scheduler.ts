import {
  computeNextRun,
  describeSchedule,
  isValidAutomationName,
  systemClock,
  type Automation,
  type AutomationId,
  type AutomationRun,
  type AutomationSchedule,
  type Clock,
  type SessionId,
} from "@bai/shared";
import type { Bus } from "../event/bus";
import type { Store } from "../store/store";

/** Final assistant text stored on a run row is bounded (transcript holds the rest). */
const OUTPUT_LIMIT = 4000;

export interface AutomationDraft {
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  agent?: string;
  model?: string;
  workspace?: string;
  enabled?: boolean;
}

export interface AutomationUpdate {
  name?: string;
  prompt?: string;
  schedule?: AutomationSchedule;
  /** null clears the field. */
  agent?: string | null;
  model?: string | null;
  workspace?: string | null;
  enabled?: boolean;
}

export interface AutomationSchedulerDeps {
  store: Store;
  bus: Bus;
  clock?: Clock;
  /**
   * Launch a run: create the run session + submit the prompt, resolving with
   * the session id and a promise that settles when the drain goes idle.
   */
  launch(automation: Automation): Promise<{ sessionId: SessionId; done: Promise<void> }>;
  /** Validation hooks (boot wires the agent registry / config workspaces). */
  agentExists?(name: string): boolean;
  workspaceRoots?(): string[];
  /** Tick interval; default 30s. */
  tickMs?: number;
}

/**
 * The automation ticker. Owns CRUD (with live `automations.updated`
 * broadcasts), a due scan, a per-automation in-flight guard (a due fire is
 * skipped while the previous run is still going), and boot recovery of runs
 * interrupted by a crashed process.
 *
 * Every run is a normal Chat session (the launch callback creates it), so
 * progress/transcripts stream through the existing session events; this
 * scheduler only maintains the definition + run ledger.
 */
export class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private readonly inFlight = new Set<AutomationId>();
  private readonly clock: Clock;

  constructor(private deps: AutomationSchedulerDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  start(): void {
    this.recoverInterrupted();
    void this.tick();
    const tickMs = this.deps.tickMs ?? 30_000;
    this.timer = setInterval(() => void this.tick(), tickMs);
    // Never hold the process open (one-shot/test boots).
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  // --- queries ---

  list(): Automation[] {
    return this.deps.store.automations.list();
  }

  get(id: string): Automation | undefined {
    return this.deps.store.automations.get(id);
  }

  runs(id: string, limit = 50): AutomationRun[] {
    return this.deps.store.automationRuns.listByAutomation(id, limit);
  }

  isRunning(id: string): boolean {
    return this.inFlight.has(id as AutomationId);
  }

  // --- mutations (broadcast automations.updated) ---

  create(input: AutomationDraft): Automation {
    const name = this.validateName(input.name, undefined);
    const prompt = input.prompt.trim();
    if (prompt.length === 0) throw new Error("A prompt is required.");
    this.validateAgent(input.agent);
    this.validateWorkspace(input.workspace);
    const enabled = input.enabled ?? true;
    const now = this.clock.iso();
    const nextRunAt = enabled ? computeNextRun(input.schedule, new Date(now)).toISOString() : null;
    const automation = this.deps.store.automations.insert({
      name,
      prompt,
      schedule: input.schedule,
      scheduleDisplay: describeSchedule(input.schedule),
      ...(input.agent !== undefined && input.agent.length > 0 ? { agent: input.agent } : {}),
      ...(input.model !== undefined && input.model.length > 0 ? { model: input.model } : {}),
      ...(input.workspace !== undefined && input.workspace.length > 0 ? { workspace: input.workspace } : {}),
      enabled,
      nextRunAt,
      now,
    });
    this.emit();
    return automation;
  }

  update(id: string, patch: AutomationUpdate): Automation | undefined {
    const existing = this.deps.store.automations.get(id);
    if (existing === undefined) return undefined;
    const name = patch.name !== undefined ? this.validateName(patch.name, id) : existing.name;
    const prompt = patch.prompt !== undefined ? patch.prompt.trim() : existing.prompt;
    if (prompt.length === 0) throw new Error("A prompt is required.");
    if (patch.agent !== undefined) this.validateAgent(patch.agent ?? undefined);
    if (patch.workspace !== undefined) this.validateWorkspace(patch.workspace ?? undefined);

    const schedule = patch.schedule ?? existing.schedule;
    const enabled = patch.enabled ?? existing.enabled;
    const now = this.clock.iso();
    let nextRunAt: string | null;
    if (!enabled) {
      nextRunAt = null;
    } else if (patch.schedule !== undefined || (patch.enabled === true && !existing.enabled)) {
      nextRunAt = computeNextRun(schedule, new Date(now)).toISOString();
    } else {
      nextRunAt = existing.nextRunAt ?? computeNextRun(schedule, new Date(now)).toISOString();
    }

    const updated = this.deps.store.automations.update(
      id,
      {
        name,
        prompt,
        schedule,
        scheduleDisplay: describeSchedule(schedule),
        ...(patch.agent !== undefined ? { agent: patch.agent } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.workspace !== undefined ? { workspace: patch.workspace } : {}),
        enabled,
        nextRunAt,
      },
      now,
    );
    if (updated !== undefined) this.emit();
    return updated;
  }

  remove(id: string): boolean {
    const removed = this.deps.store.automations.remove(id);
    if (removed) this.emit();
    return removed;
  }

  /** Trigger a run now (works while paused); throws when already running. */
  runNow(id: string): AutomationRun | undefined {
    const automation = this.deps.store.automations.get(id);
    if (automation === undefined) return undefined;
    if (this.inFlight.has(automation.id)) throw new Error("Automation is already running");
    const run = this.startRun(automation, "manual");
    void this.execute(automation, run);
    return run;
  }

  // --- ticking ---

  /** One due-scan pass (also the interval body; public for tests/manual tick). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.clock.iso();
      for (const automation of this.deps.store.automations.due(now)) {
        this.fire(automation);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Schedule fire: start the run, or skip + advance when one is in flight. */
  private fire(automation: Automation): void {
    if (this.inFlight.has(automation.id)) {
      const now = this.clock.iso();
      this.deps.store.automations.update(
        automation.id,
        { nextRunAt: computeNextRun(automation.schedule, new Date(now)).toISOString() },
        now,
      );
      this.emit();
      return;
    }
    const run = this.startRun(automation, "schedule");
    void this.execute(automation, run);
  }

  /** Mark the automation running, arm the next fire, and open a run row. */
  private startRun(automation: Automation, source: "schedule" | "manual"): AutomationRun {
    const now = this.clock.iso();
    this.deps.store.automations.update(
      automation.id,
      {
        lastRunAt: now,
        lastStatus: "running",
        lastError: null,
        ...(source === "schedule"
          ? { nextRunAt: computeNextRun(automation.schedule, new Date(now)).toISOString() }
          : {}),
      },
      now,
    );
    const run = this.deps.store.automationRuns.insert({ automationId: automation.id, now });
    this.emit();
    return run;
  }

  /** Launch the run session and settle the ledger when the drain finishes. */
  private async execute(automation: Automation, run: AutomationRun): Promise<void> {
    // Set before the first await so a same-tick duplicate can't slip in.
    this.inFlight.add(automation.id);
    try {
      const { sessionId, done } = await this.deps.launch(automation);
      this.deps.store.automationRuns.setSession(run.id, sessionId);
      this.deps.store.automations.update(automation.id, { lastSessionId: sessionId }, this.clock.iso());
      this.emit();
      await done;
      const output = this.finalOutput(sessionId);
      this.deps.store.automationRuns.finish(run.id, {
        status: "ok",
        ...(output !== undefined ? { output } : {}),
        now: this.clock.iso(),
      });
      this.deps.store.automations.update(automation.id, { lastStatus: "ok", lastError: null }, this.clock.iso());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.store.automationRuns.finish(run.id, {
        status: "error",
        error: message,
        now: this.clock.iso(),
      });
      this.deps.store.automations.update(
        automation.id,
        { lastStatus: "error", lastError: message },
        this.clock.iso(),
      );
    } finally {
      this.inFlight.delete(automation.id);
      this.emit();
    }
  }

  /** Boot recovery: runs a dead process left `running` become errors. */
  private recoverInterrupted(): void {
    const now = this.clock.iso();
    const recovered = this.deps.store.automationRuns.recoverRunning(now);
    for (const run of recovered) {
      this.deps.store.automations.update(
        run.automationId,
        { lastStatus: "error", lastError: run.error ?? "interrupted by restart" },
        now,
      );
    }
    if (recovered.length > 0) this.emit();
  }

  private finalOutput(sessionId: SessionId): string | undefined {
    const history = this.deps.store.messages.history(sessionId);
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i];
      if (message?.role !== "assistant") continue;
      const text = message.parts
        .filter((part) => part.kind === "text")
        .map((part) => (part.payload as { text?: unknown }).text)
        .filter((value): value is string => typeof value === "string")
        .join("")
        .trim();
      if (text.length > 0) return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}…` : text;
    }
    return undefined;
  }

  private validateName(name: string, selfId: string | undefined): string {
    const trimmed = name.trim();
    if (!isValidAutomationName(trimmed)) {
      throw new Error(
        "Names start with a letter or digit and may contain letters, digits, spaces, - and _ (up to 64 characters).",
      );
    }
    const existing = this.deps.store.automations.getByName(trimmed);
    if (existing !== undefined && existing.id !== selfId) {
      throw new Error(`An automation named "${trimmed}" already exists.`);
    }
    return trimmed;
  }

  private validateAgent(agent: string | undefined): void {
    if (agent === undefined || agent.length === 0) return;
    if (this.deps.agentExists !== undefined && !this.deps.agentExists(agent)) {
      throw new Error(`Unknown agent: ${agent}`);
    }
  }

  private validateWorkspace(workspace: string | undefined): void {
    if (workspace === undefined || workspace.length === 0) return;
    const roots = this.deps.workspaceRoots?.() ?? [];
    if (!roots.includes(workspace)) {
      throw new Error(`Workspace is not registered: ${workspace}`);
    }
  }

  private emit(): void {
    this.deps.bus.publish({
      seq: 0,
      type: "automations.updated",
      ts: this.clock.iso(),
      payload: {},
    });
  }
}
