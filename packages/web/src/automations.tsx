import { useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import { Clock, LoaderCircle } from "lucide-react";
import {
  computeNextRun,
  describeSchedule,
  isValidAutomationName,
  type AgentInfo,
  type Automation,
  type AutomationId,
  type AutomationRun,
  type AutomationSchedule,
  type ProviderListResponse,
  type SessionId,
} from "@bai/shared";
import { modelOverrideOptions } from "./provider-utils";
import { shouldAutoFocus } from "./pointer";
import {
  ActionRow,
  Button,
  Chip,
  Combobox,
  ConfirmDialog,
  EmptyState,
  Field,
  FormSection,
  ListItem,
  PageHeader,
  SectionHeader,
  Select,
  Stat,
  StatRow,
  SubNav,
  SubNavCreate,
  SubNavItem,
  Switch,
  TextInput,
  Textarea,
  type ComboboxOption,
} from "./components";

/** Toast feedback callback (matches the app's pushNotice). */
type OnNotice = (message: string, kind?: "success" | "error" | "info") => void;

/**
 * Automations section, split for the two-level nav: `AutomationsNav` renders
 * the nested sidebar (`New automation` + the list, each titled by name and
 * subtitled by its schedule); the main pane is the two-column editor — inputs
 * (name/enabled, agent/workspace, model override, schedule, prompt) left, run
 * history right — for the selected automation or a draft in `creating` mode.
 * Definitions live on the server; `automations.updated` keeps every surface's
 * list live.
 */

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const WEEKDAY_LONG = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const UNIT_MINUTES: Record<string, number> = { minutes: 1, hours: 60, days: 1440 };

function intervalParts(minutes: number): { amount: number; unit: string } {
  if (minutes % 1440 === 0) return { amount: minutes / 1440, unit: "days" };
  if (minutes % 60 === 0) return { amount: minutes / 60, unit: "hours" };
  return { amount: minutes, unit: "minutes" };
}

function clockValue(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseClock(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(":");
  return { hour: Number(h ?? 0), minute: Number(m ?? 0) };
}

/** Wall-clock HH:mm:ss for the live "now" readout in the editor header. */
function currentClock(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function basename(path: string): string {
  const parts = path.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? path;
}

function agentOptions(agents: AgentInfo[]): ComboboxOption[] {
  return [
    { value: "", label: "(default agent)", hint: "the configured default" },
    ...agents.map((a) => ({ value: a.name, label: a.name, hint: a.description ?? a.source })),
  ];
}

function workspaceOptions(workspaces: string[]): ComboboxOption[] {
  return [
    { value: "", label: "(no workspace)", hint: "runs as a cwd-less chat" },
    ...workspaces.map((w) => ({ value: w, label: basename(w), hint: w })),
  ];
}

/** Nested-sidebar list: create on top, then the automations (name / schedule). */
export function AutomationsNav({
  automations,
  selected,
  onSelect,
  onCreate,
  busy,
}: {
  automations: Automation[];
  selected: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  busy: boolean;
}) {
  const sorted = [...automations].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <SubNav>
      <SubNavCreate
        icon={<Clock size={15} aria-hidden="true" />}
        label="New automation"
        disabled={busy}
        onClick={onCreate}
      />
      {sorted.map((a) => (
        <SubNavItem
          key={a.id}
          title={
            <span className="auto-name-row">
              <span className="auto-name">{a.name}</span>
              {!a.enabled && (
                <Chip className="chip-paused" hint="Paused — does not fire on schedule">
                  Paused
                </Chip>
              )}
            </span>
          }
          subtitle={a.scheduleDisplay}
          trailing={
            a.lastStatus === "running" ? (
              <span className="run-indicator" title="Running">
                <LoaderCircle size={12} className="icon-spin" aria-hidden="true" />
              </span>
            ) : undefined
          }
          selected={selected === a.id}
          onClick={() => onSelect(a.id)}
          ariaCurrent={selected === a.id ? "page" : undefined}
        />
      ))}
      {sorted.length === 0 && <p className="dim">No automations yet.</p>}
    </SubNav>
  );
}

/** The schedule editor: mode (interval/daily/weekly) + its parameters + a live preview. */
export function ScheduleBuilder({
  value,
  onChange,
}: {
  value: AutomationSchedule;
  onChange: (schedule: AutomationSchedule) => void;
}) {
  const initial = value.kind === "interval" ? intervalParts(value.minutes) : { amount: 30, unit: "minutes" };
  const [amount, setAmount] = useState(String(initial.amount));
  const [unit, setUnit] = useState(initial.unit);
  const [time, setTime] = useState(
    value.kind === "interval" ? "09:00" : clockValue(value.hour, value.minute),
  );

  // Local field state is seeded once; the form (and this builder) remounts on
  // automation change via `key`, so no sync effect is needed — and syncing on
  // every `value` change would rewrite typed input (e.g. "60 minutes" → "1 hours").

  const emitInterval = (rawAmount: string, rawUnit: string): void => {
    const n = Number.parseInt(rawAmount, 10);
    if (!Number.isFinite(n) || n <= 0) return;
    onChange({ kind: "interval", minutes: n * (UNIT_MINUTES[rawUnit] ?? 1) });
  };
  const emitDaily = (rawTime: string): void => {
    const { hour, minute } = parseClock(rawTime);
    onChange({ kind: "daily", hour, minute });
  };
  const emitWeekly = (days: number[], rawTime: string): void => {
    const { hour, minute } = parseClock(rawTime);
    onChange({ kind: "weekly", weekdays: days.length > 0 ? days : [1], hour, minute });
  };

  const switchMode = (next: string): void => {
    if (next === "interval") emitInterval(amount, unit);
    else if (next === "daily") emitDaily(time);
    else emitWeekly(value.kind === "weekly" ? value.weekdays : [1], time);
  };

  const days = value.kind === "weekly" ? value.weekdays : [];

  return (
    <div className="schedule-builder">
      <Field label="Schedule">
        <Select
          value={value.kind}
          onChange={switchMode}
          ariaLabel="Schedule type"
          options={[
            { value: "interval", label: "Interval (every N minutes/hours/days)" },
            { value: "daily", label: "Daily at a time" },
            { value: "weekly", label: "Weekly on chosen days" },
          ]}
        />
      </Field>

      {value.kind === "interval" ? (
        <div className="schedule-row">
          <TextInput
            type="number"
            min={1}
            className="schedule-amount"
            aria-label="Interval amount"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              emitInterval(e.target.value, unit);
            }}
          />
          <Select
            value={unit}
            ariaLabel="Interval unit"
            onChange={(u) => {
              setUnit(u);
              emitInterval(amount, u);
            }}
            options={[
              { value: "minutes", label: "minutes" },
              { value: "hours", label: "hours" },
              { value: "days", label: "days" },
            ]}
          />
        </div>
      ) : (
        <>
          <div className="schedule-row">
            <TextInput
              type="time"
              aria-label="Time of day"
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
                if (value.kind === "daily") emitDaily(e.target.value);
                else emitWeekly(days, e.target.value);
              }}
            />
          </div>
          {value.kind === "weekly" && (
            <div className="weekday-toggles" role="group" aria-label="Weekdays">
              {WEEKDAY_LABELS.map((label, i) => {
                const selected = days.includes(i);
                return (
                  // @ui-raw: multi-select weekday toggle group — Tabs/segmented
                  // controls are single-select, so no primitive fits.
                  <button
                    key={i}
                    type="button"
                    className={selected ? "weekday active" : "weekday"}
                    aria-pressed={selected}
                    aria-label={WEEKDAY_LONG[i]}
                    onClick={() => {
                      const next = selected ? days.filter((d) => d !== i) : [...days, i].sort((a, b) => a - b);
                      emitWeekly(next, time);
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      <p className="schedule-preview dim">Runs {describeSchedule(value).toLowerCase()}.</p>
    </div>
  );
}

/** A not-yet-written automation (the create-mode form's draft). */
function draftAutomation(): Automation {
  return {
    id: "" as AutomationId,
    name: `automation-${Date.now().toString(36)}`,
    prompt: "",
    schedule: { kind: "interval", minutes: 30 },
    scheduleDisplay: "Every 30 minutes",
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: "idle",
    createdAt: "",
    updatedAt: "",
  };
}

/**
 * Main pane: the automation editor (two columns — inputs left, run history
 * right). In `creating` mode it edits a draft and creates on Save.
 */
export function AutomationsPane({
  client,
  automations,
  agents,
  workspaces,
  selectedId,
  refresh,
  onNotice,
  onOpenSession,
  onDeleted,
  creating = false,
  onCreated,
  onCancel,
  list = null,
}: {
  client: BaiClient;
  automations: Automation[];
  agents: AgentInfo[];
  workspaces: string[];
  selectedId: string | null;
  refresh: () => Promise<void>;
  onNotice: OnNotice;
  onOpenSession: (sessionId: SessionId) => void;
  onDeleted: () => void;
  /** Render the full form for a new automation (name editable). */
  creating?: boolean;
  /** Called with the new automation's id after a successful create. */
  onCreated?: (id: string) => void;
  /** Discard the draft (create mode). */
  onCancel?: () => void;
  /** Provider list — the model-override combobox's options. */
  list?: ProviderListResponse | null;
}) {
  if (creating) {
    return (
      <div className="pane-inner">
        <AutomationForm
          key="__new_automation__"
          client={client}
          automation={draftAutomation()}
          agents={agents}
          workspaces={workspaces}
          refresh={refresh}
          onNotice={onNotice}
          onOpenSession={onOpenSession}
          onDeleted={onDeleted}
          creating
          existing={automations.map((a) => a.name)}
          {...(onCreated !== undefined ? { onCreated } : {})}
          {...(onCancel !== undefined ? { onCancel } : {})}
          list={list}
        />
      </div>
    );
  }
  const automation = automations.find((a) => a.id === selectedId);
  if (automation === undefined) {
    return (
      <div className="pane-inner">
        <EmptyState
          icon={<Clock size={22} aria-hidden="true" />}
          title="No automation selected"
          description="Pick an automation from the list, or create a new one to get started."
        />
      </div>
    );
  }
  return (
    <div className="pane-inner">
      <AutomationForm
        key={automation.id}
        client={client}
        automation={automation}
        agents={agents}
        workspaces={workspaces}
        refresh={refresh}
        onNotice={onNotice}
        onOpenSession={onOpenSession}
        onDeleted={onDeleted}
        list={list}
      />
    </div>
  );
}

function AutomationForm({
  client,
  automation,
  agents,
  workspaces,
  refresh,
  onNotice,
  onOpenSession,
  onDeleted,
  creating = false,
  existing = [],
  onCreated,
  onCancel,
  list = null,
}: {
  client: BaiClient;
  automation: Automation;
  agents: AgentInfo[];
  workspaces: string[];
  refresh: () => Promise<void>;
  onNotice: OnNotice;
  onOpenSession: (sessionId: SessionId) => void;
  onDeleted: () => void;
  creating?: boolean;
  existing?: string[];
  onCreated?: (id: string) => void;
  onCancel?: () => void;
  list?: ProviderListResponse | null;
}) {
  const [name, setName] = useState(automation.name);
  const [prompt, setPrompt] = useState(automation.prompt);
  const [schedule, setSchedule] = useState<AutomationSchedule>(automation.schedule);
  const [agent, setAgent] = useState(automation.agent ?? "");
  const [model, setModel] = useState(automation.model ?? "");
  const [workspace, setWorkspace] = useState(automation.workspace ?? "");
  const [enabled, setEnabled] = useState(automation.enabled);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  // Live wall clock (HH:mm:ss) shown between the next/last run readouts.
  const [clock, setClock] = useState(currentClock);

  useEffect(() => {
    const timer = setInterval(() => setClock(currentClock()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Run history — live. `automation.updatedAt` changes on every scheduler
  // write (run start, session attach, finish), so the App's
  // `automations.updated` refresh re-runs this effect and the running →
  // ok/error flip is live. A short poll while a run is in flight covers a
  // missed firehose frame (and heals a dropped connection).
  const running = automation.lastStatus === "running";
  useEffect(() => {
    if (creating) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const result = await client.getAutomation(automation.id);
        if (!cancelled) setRuns(result?.runs ?? []);
      } catch {
        // advisory — the history just stays as-is
      }
    };
    void load();
    if (!running) {
      return () => {
        cancelled = true;
      };
    }
    const timer = setInterval(() => {
      void load();
      // Refresh the list too, so the sidebar status self-heals even if a
      // firehose frame is dropped.
      void refresh();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, automation.id, automation.updatedAt, running, refresh, creating]);

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!isValidAutomationName(trimmed)) {
      onNotice("Names start with a letter or digit and may contain letters, digits, spaces, - and _.", "error");
      return;
    }
    if (creating && existing.includes(trimmed)) {
      onNotice(`An automation named "${trimmed}" already exists — pick another name.`, "error");
      return;
    }
    if (prompt.trim().length === 0) {
      onNotice("A prompt is required — it is what the agent runs on each fire.", "error");
      return;
    }
    setBusy(true);
    try {
      if (creating) {
        const created = await client.createAutomation({
          name: trimmed,
          prompt: prompt.trim(),
          schedule,
          enabled,
          ...(agent.trim().length > 0 ? { agent: agent.trim() } : {}),
          ...(model.trim().length > 0 ? { model: model.trim() } : {}),
          ...(workspace.trim().length > 0 ? { workspace: workspace.trim() } : {}),
        });
        await refresh();
        onNotice(`created "${trimmed}" — live everywhere`);
        onCreated?.(created.id);
        return;
      }
      await client.updateAutomation(automation.id, {
        name: trimmed,
        prompt,
        schedule,
        agent: agent.trim().length > 0 ? agent.trim() : null,
        model: model.trim().length > 0 ? model.trim() : null,
        workspace: workspace.trim().length > 0 ? workspace.trim() : null,
        enabled,
      });
      await refresh();
      onNotice(`saved "${trimmed}" — live everywhere`);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.runAutomation(automation.id);
      await refresh();
      onNotice("automation run started", "info");
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.deleteAutomation(automation.id);
      await refresh();
      onNotice(`deleted "${automation.name}"`);
      onDeleted();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
      setBusy(false);
    }
  };

  const nextRun =
    enabled && automation.nextRunAt !== null
      ? new Date(automation.nextRunAt).toLocaleString()
      : enabled
        ? new Date(computeNextRun(schedule, new Date()).toISOString()).toLocaleString()
        : "paused";

  return (
    <form
      className="agent-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <PageHeader
        title={creating ? "New automation" : automation.name}
        lede={creating ? undefined : automation.scheduleDisplay}
      />
      {!creating && (
        <StatRow className="media-model-info" ariaLabel="Automation status">
          {running && (
            <Stat
              label="Status"
              tone="accent"
              value={
                <>
                  <LoaderCircle size={12} className="icon-spin" aria-hidden="true" /> running now
                </>
              }
            />
          )}
          <Stat label="Next run" value={nextRun} />
          <Stat label="Now" value={clock} />
          {automation.lastRunAt !== null && (
            <Stat label="Last" value={new Date(automation.lastRunAt).toLocaleString()} />
          )}
          {automation.lastStatus === "error" && automation.lastError !== undefined && (
            <Stat label="Last error" value={automation.lastError} tone="danger" />
          )}
        </StatRow>
      )}
      {/* Two columns: the inputs on the left (Name/Enabled → Agent/Workspace →
          Model override → Schedule → Prompt), the run history on the right. */}
      <div className="automation-layout">
        <div className="automation-form-col">
          <FormSection title="Details" columns={2}>
            <Field label="Name" hint="(shown in the sidebar and used for updates)">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus={creating && shouldAutoFocus()}
                maxLength={64}
                required
                spellCheck={false}
              />
            </Field>
            <Field label="Enabled">
              {/* Local state only — the enabled state persists on Save. */}
              <Switch
                checked={enabled}
                onChange={setEnabled}
                label={enabled ? "Fires on schedule" : "Paused"}
              />
            </Field>
          </FormSection>
          <FormSection title="Target" columns={2}>
            <Field label="Agent" hint="(default when unset)">
              <Combobox
                value={agent}
                onChange={setAgent}
                options={agentOptions(agents)}
                ariaLabel="Agent"
                emptyText="No matching agent."
              />
            </Field>
            <Field label="Workspace" hint="(optional)">
              <Combobox
                value={workspace}
                onChange={setWorkspace}
                options={workspaceOptions(workspaces)}
                ariaLabel="Workspace"
                emptyText="No matching workspace."
              />
            </Field>
            <Field label="Model override" hint="(optional — inherits the agent/session model when unset)">
              <Combobox
                value={model}
                onChange={setModel}
                options={modelOverrideOptions(list)}
                placeholder="(agent/session model)"
                ariaLabel="Model override"
                creatable
                emptyText="No matching model."
              />
            </Field>
          </FormSection>
          <FormSection title="Schedule" flow="stack">
            <ScheduleBuilder value={schedule} onChange={setSchedule} />
          </FormSection>
          {/* Prompt is the bottom-most input and the grow field. */}
          <FormSection title="Prompt" flow="stack" className="field-grow">
            <Field label="Prompt" hint="(what the agent runs on each fire)">
              <Textarea
                className="grow-input"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                required
                placeholder="e.g. Summarize unread email and flag anything urgent."
              />
            </Field>
          </FormSection>
        </div>
        <aside className="automation-runs" aria-label="Run history">
          <SectionHeader title="Run history" />
          {runs.length === 0 ? (
            <EmptyState title="No runs yet" description="Runs appear here after the automation fires." />
          ) : (
            <ul className="run-list">
              {runs.map((run) => (
                <li key={run.id}>
                  {/* Two lines: status + datetime, then the response preview
                      (italic, dim) below. Errors keep the red treatment. */}
                  <ListItem
                    className="run-row"
                    disabled={run.sessionId === undefined}
                    hint={run.sessionId === undefined ? undefined : "Open the run's session"}
                    onClick={() => run.sessionId !== undefined && onOpenSession(run.sessionId)}
                    title={
                      <>
                        <Chip className={`run-status run-${run.status}`}>
                          {run.status === "running" ? (
                            <>
                              <LoaderCircle size={11} className="icon-spin" aria-hidden="true" /> running
                            </>
                          ) : (
                            run.status
                          )}
                        </Chip>
                        <span className="run-time">{new Date(run.startedAt).toLocaleString()}</span>
                      </>
                    }
                    subtitle={
                      run.error !== undefined ? (
                        <span className="run-error">{run.error}</span>
                      ) : run.output !== undefined ? (
                        <span className="run-output">{run.output}</span>
                      ) : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
      <ActionRow align="between">
        <div className="action-row-group">
          <Button type="submit" variant="primary" loading={busy}>
            {creating ? "Create" : "Save"}
          </Button>
          {!creating && (
            <Button variant="secondary" disabled={busy} onClick={() => void runNow()}>
              Run now
            </Button>
          )}
        </div>
        <div className="action-row-group">
          {!creating && (
            <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
          {creating && onCancel !== undefined && (
            <Button variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </ActionRow>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete automation?"
        body={
          <>
            Delete <strong>{automation.name}</strong>? It stops firing and its run history is removed. This cannot be
            undone.
          </>
        }
        confirmLabel="Delete"
        busy={busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void remove();
        }}
      />
    </form>
  );
}
