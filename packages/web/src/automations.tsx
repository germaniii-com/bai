import { useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import { LoaderCircle } from "lucide-react";
import {
  computeNextRun,
  describeSchedule,
  isValidAutomationName,
  type AgentInfo,
  type Automation,
  type AutomationRun,
  type AutomationSchedule,
  type SessionId,
} from "@bai/shared";
import {
  Button,
  Combobox,
  Field,
  SectionHeader,
  Select,
  SubNav,
  SubNavCreate,
  SubNavItem,
  TextInput,
  Textarea,
  ToggleRow,
  type ComboboxOption,
} from "./components";

/** Toast feedback callback (matches the app's pushNotice). */
type OnNotice = (message: string, kind?: "success" | "error" | "info") => void;

/**
 * Automations section, split for the two-level nav: `AutomationsNav` renders
 * the nested sidebar (`+ New Automation` + the list, each titled by name and
 * subtitled by its schedule), the main pane is either the create form or the
 * selected automation's editor (schedule + prompt + agent/workspace + run
 * history). Definitions live on the server; `automations.updated` keeps every
 * surface's list live.
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
      <SubNavCreate label="+ New Automation" disabled={busy} onClick={onCreate} />
      {sorted.map((a) => (
        <SubNavItem
          key={a.id}
          title={a.name}
          subtitle={a.scheduleDisplay}
          trailing={
            a.lastStatus === "running" ? (
              <span className="run-indicator" title="Running">
                <LoaderCircle size={12} className="icon-spin" aria-hidden="true" />
              </span>
            ) : !a.enabled ? (
              <span className="dim">paused</span>
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

/** Creation form: name + schedule + prompt (+ optional agent/workspace), written on submit. */
export function AutomationCreateForm({
  agents,
  workspaces,
  existing,
  onSubmit,
  onCancel,
}: {
  agents: AgentInfo[];
  workspaces: string[];
  /** Existing automation names — duplicate guard. */
  existing: string[];
  onSubmit: (input: {
    name: string;
    prompt: string;
    schedule: AutomationSchedule;
    agent?: string;
    workspace?: string;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(`automation-${Date.now().toString(36)}`);
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState<AutomationSchedule>({ kind: "interval", minutes: 30 });
  const [agent, setAgent] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!isValidAutomationName(trimmed)) {
      setError("Names start with a letter or digit and may contain letters, digits, spaces, - and _ (up to 64 characters).");
      return;
    }
    if (existing.includes(trimmed)) {
      setError(`An automation named "${trimmed}" already exists — pick another name.`);
      return;
    }
    if (prompt.trim().length === 0) {
      setError("A prompt is required — it is what the agent runs on each fire.");
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        name: trimmed,
        prompt: prompt.trim(),
        schedule,
        ...(agent.length > 0 ? { agent } : {}),
        ...(workspace.length > 0 ? { workspace } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form
      className="agent-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <SectionHeader title="New automation" />
      <Field label="Name" hint="(shown in the sidebar and used for updates)">
        <TextInput
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          autoFocus
          required
          maxLength={64}
          spellCheck={false}
        />
      </Field>
      <Field label="Prompt" hint="(what the agent runs on each fire)">
        <Textarea
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setError(null);
          }}
          rows={6}
          required
          placeholder="e.g. Summarize unread email and flag anything urgent."
        />
      </Field>
      <ScheduleBuilder value={schedule} onChange={setSchedule} />
      <div className="schedule-row">
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
      </div>
      {error !== null && <div className="error">{error}</div>}
      <p className="section-lede">
        Automation runs execute unattended with every tool auto-approved. The first run creates a Chat session you can
        open from the run history.
      </p>
      <div className="agents-actions">
        <Button type="submit" variant="primary" loading={busy}>
          Create
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Main pane: the selected automation's editor (or an empty prompt). */
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
}) {
  const automation = automations.find((a) => a.id === selectedId);
  if (automation === undefined) {
    return (
      <div className="agents-pane">
        <p className="dim empty">Select or create an automation.</p>
      </div>
    );
  }
  return (
    <div className="agents-pane">
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
}: {
  client: BaiClient;
  automation: Automation;
  agents: AgentInfo[];
  workspaces: string[];
  refresh: () => Promise<void>;
  onNotice: OnNotice;
  onOpenSession: (sessionId: SessionId) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(automation.name);
  const [prompt, setPrompt] = useState(automation.prompt);
  const [schedule, setSchedule] = useState<AutomationSchedule>(automation.schedule);
  const [agent, setAgent] = useState(automation.agent ?? "");
  const [model, setModel] = useState(automation.model ?? "");
  const [workspace, setWorkspace] = useState(automation.workspace ?? "");
  const [enabled, setEnabled] = useState(automation.enabled);
  const [busy, setBusy] = useState(false);
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
  }, [client, automation.id, automation.updatedAt, running, refresh]);

  const save = async (): Promise<void> => {
    if (!isValidAutomationName(name.trim())) {
      onNotice("Names start with a letter or digit and may contain letters, digits, spaces, - and _.", "error");
      return;
    }
    setBusy(true);
    try {
      await client.updateAutomation(automation.id, {
        name: name.trim(),
        prompt,
        schedule,
        agent: agent.trim().length > 0 ? agent.trim() : null,
        model: model.trim().length > 0 ? model.trim() : null,
        workspace: workspace.trim().length > 0 ? workspace.trim() : null,
        enabled,
      });
      await refresh();
      onNotice(`saved "${name.trim()}" — live everywhere`);
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

  const toggleEnabled = async (next: boolean): Promise<void> => {
    setEnabled(next);
    setBusy(true);
    try {
      await client.updateAutomation(automation.id, { enabled: next });
      await refresh();
    } catch (err) {
      setEnabled(!next); // revert the optimistic flip
      onNotice(err instanceof Error ? err.message : String(err), "error");
    } finally {
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
      <SectionHeader
        title={
          <>
            {automation.name} <span className="dim">· {automation.scheduleDisplay}</span>
          </>
        }
        lede={
          <>
            {running && (
              <span className="run-live">
                <LoaderCircle size={12} className="icon-spin" aria-hidden="true" /> running now
              </span>
            )}
            {running && " · "}Next run: {nextRun}
            <span className="run-clock"> · now: {clock}</span>
            {automation.lastRunAt !== null && ` · last: ${new Date(automation.lastRunAt).toLocaleString()}`}
            {automation.lastStatus === "error" && automation.lastError !== undefined && (
              <span className="run-error"> · {automation.lastError}</span>
            )}
          </>
        }
      />
      <Field label="Name">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required spellCheck={false} />
      </Field>
      <Field label="Prompt" hint="(what the agent runs on each fire)">
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={10} required />
      </Field>
      <ScheduleBuilder value={schedule} onChange={setSchedule} />
      <div className="schedule-row">
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
      </div>
      <Field label="Model override" hint="(catalog id — optional)">
        <TextInput value={model} onChange={(e) => setModel(e.target.value)} placeholder="(agent/session model)" />
      </Field>
      <ToggleRow
        checked={enabled}
        onChange={(next) => void toggleEnabled(next)}
        title="Enabled"
        description="Paused automations do not fire on schedule (Run now still works)."
      />
      <p className="section-lede">
        Runs execute unattended with every tool auto-approved — including a config-level deny, for automation sessions
        only.
      </p>
      <div className="agents-actions">
        <Button type="submit" variant="primary" loading={busy}>
          Save
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void runNow()}>
          Run now
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => void remove()}>
          Delete
        </Button>
      </div>

      <div className="automation-runs">
        <SectionHeader title="Run history" />
        {runs.length === 0 ? (
          <p className="dim">No runs yet.</p>
        ) : (
          <ul className="run-list">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  className="run-row"
                  disabled={run.sessionId === undefined}
                  title={run.sessionId === undefined ? undefined : "Open the run's session"}
                  onClick={() => run.sessionId !== undefined && onOpenSession(run.sessionId)}
                >
                  <span className={`run-status run-${run.status}`}>
                    {run.status === "running" ? (
                      <>
                        <LoaderCircle size={11} className="icon-spin" aria-hidden="true" /> running
                      </>
                    ) : (
                      run.status
                    )}
                  </span>
                  <span className="run-time">{new Date(run.startedAt).toLocaleString()}</span>
                  {run.error !== undefined && <span className="run-error">{run.error}</span>}
                  {run.output !== undefined && <span className="run-output">{run.output}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </form>
  );
}
