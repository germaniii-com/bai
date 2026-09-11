/**
 * Automations — scheduled prompts (the "Jobs / Automations" feature).
 *
 * An Automation is a named prompt plus a schedule (interval, daily, or
 * weekly). The core scheduler fires it, and each fire runs the prompt in a
 * fresh Chat session (auto-approved). All schedule parsing/description and
 * next-run math is pure and lives here so the core scheduler and the web UI
 * share one source of truth.
 *
 * Time is server-local (bai is local-first; there is no per-schedule zone).
 */
import type { AutomationId, AutomationRunId, SessionId } from "./ids";

/** Structured schedule — the stored/transported shape. */
export type AutomationSchedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekdays: number[]; hour: number; minute: number };

export type AutomationRunStatus = "running" | "ok" | "error";

/** An automation's last-run state; "idle" before the first run. */
export type AutomationStatus = "idle" | AutomationRunStatus;

export interface Automation {
  id: AutomationId;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  /** Human display derived from `schedule` (e.g. "Every 30 minutes"). */
  scheduleDisplay: string;
  /** Agent name; unset → the configured default agent at run time. */
  agent?: string;
  /** Catalog model id override; unset → the agent/config model. */
  model?: string;
  /** Registered workspace folder the run is rooted at (session cwd); unset → cwd-less chat. */
  workspace?: string;
  enabled: boolean;
  /** ISO timestamp of the next scheduled fire; null when paused/never armed. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: AutomationStatus;
  lastError?: string;
  /** The session created by the most recent run. */
  lastSessionId?: SessionId;
  createdAt: string;
  updatedAt: string;
}

/** One recorded execution of an automation. */
export interface AutomationRun {
  id: AutomationRunId;
  automationId: AutomationId;
  /** The Chat session the run created (openable from the run history). */
  sessionId?: SessionId;
  status: AutomationRunStatus;
  error?: string;
  /** Truncated final assistant text (the transcript holds the full reply). */
  output?: string;
  startedAt: string;
  finishedAt?: string;
}

/** Valid automation names: alnum start, then alnum/space/dash/underscore, ≤64 chars. No leading/trailing space. */
export function isValidAutomationName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 64 &&
    name === name.trim() &&
    /^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)
  );
}

const DURATION_RE = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i;
const DURATION_BARE_RE = /^(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i;

const UNIT_MINUTES: Record<string, number> = { m: 1, h: 60, d: 1440 };

/** Parse a duration phrase ("30m", "2h", "1d", "hour") into whole minutes. */
export function parseDuration(input: string): number {
  const text = input.trim().toLowerCase();
  const match = DURATION_RE.exec(text);
  if (match) {
    const unit = (match[2] as string)[0] as "m" | "h" | "d";
    const minutes = Number(match[1]) * (UNIT_MINUTES[unit] ?? 1);
    if (minutes <= 0) throw new Error(`Duration must be positive: "${input}".`);
    return minutes;
  }
  if (DURATION_BARE_RE.test(text)) {
    const unit = text[0] as "m" | "h" | "d";
    return UNIT_MINUTES[unit] ?? 1;
  }
  throw new Error(`Invalid duration "${input}". Use e.g. "30m", "2h", "1d".`);
}

const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const DAILY_KEYWORDS = new Set(["day", "daily", "everyday"]);
const WEEKDAY_KEYWORDS = new Set(["weekday", "weekdays"]);
const WEEKEND_KEYWORDS = new Set(["weekend", "weekends"]);

/** Parse a wall-clock time ("9am", "9:30am", "14:00", "noon", "midnight") to 24h. */
export function parseClockTime(input: string): { hour: number; minute: number } {
  const text = input.trim().toLowerCase().replace(/\s+/g, "");
  if (text === "noon" || text === "midday") return { hour: 12, minute: 0 };
  if (text === "midnight") return { hour: 0, minute: 0 };
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(text);
  if (!match) throw new Error(`Invalid time "${input}". Use e.g. "9am", "9:30am", or "14:00".`);
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3];
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) throw new Error(`Invalid time "${input}".`);
    hour = meridiem === "am" ? (hour === 12 ? 0 : hour) : hour === 12 ? 12 : hour + 12;
  }
  if (hour > 23 || minute > 59) throw new Error(`Invalid time "${input}".`);
  return { hour, minute };
}

/**
 * Parse a day/time phrase (with or without a leading "every" already
 * stripped) such as "day at 9am", "monday 9am", "mon, wed at 9:30",
 * "weekdays at 9am". Returns undefined when the phrase is not day/time shaped.
 */
function parseDayTimePhrase(rest: string): AutomationSchedule | undefined {
  const tokens = rest.toLowerCase().replace(/,/g, " ").split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  const first = tokens[0] as string;

  let weekdays: number[] | undefined;
  let daily = false;
  let idx = 1;
  if (DAILY_KEYWORDS.has(first)) {
    daily = true;
  } else if (WEEKDAY_KEYWORDS.has(first)) {
    weekdays = [1, 2, 3, 4, 5];
  } else if (WEEKEND_KEYWORDS.has(first)) {
    weekdays = [0, 6];
  } else {
    const days: number[] = [];
    while (idx <= tokens.length) {
      const token = tokens[idx - 1] as string;
      if (token === "and") {
        idx++;
        continue;
      }
      const day = WEEKDAY_NAMES[token];
      if (day === undefined) break;
      if (!days.includes(day)) days.push(day);
      idx++;
    }
    if (days.length === 0) return undefined;
    weekdays = days;
  }

  let timeTokens = tokens.slice(idx);
  if (timeTokens[0] === "at") timeTokens = timeTokens.slice(1);
  if (timeTokens.length === 0) return undefined;
  const { hour, minute } = parseClockTime(timeTokens.join(" "));

  if (daily) return { kind: "daily", hour, minute };
  return { kind: "weekly", weekdays: [...(weekdays ?? [])].sort((a, b) => a - b), hour, minute };
}

/**
 * Parse a human schedule string into the structured form. Accepts:
 *   "30m", "every 2h", "every 1d"        → interval
 *   "every day at 9am", "daily at 9:30"  → daily
 *   "every monday at 9am", "weekdays at 9am", "mon, wed at 9:00" → weekly
 */
export function parseScheduleInput(input: string): AutomationSchedule {
  const raw = (input ?? "").trim();
  if (raw.length === 0) throw new Error("A schedule is required.");
  const lower = raw.toLowerCase();

  if (lower.startsWith("every ")) {
    const rest = raw.slice(6).trim();
    const phrase = parseDayTimePhrase(rest);
    if (phrase !== undefined) return phrase;
    return { kind: "interval", minutes: parseDuration(rest) };
  }

  const phrase = parseDayTimePhrase(lower);
  if (phrase !== undefined) return phrase;

  return { kind: "interval", minutes: parseDuration(raw) };
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "9:00 AM" — 12-hour clock with minutes only when non-zero? Keep minutes always. */
function formatClock(hour: number, minute: number): string {
  const meridiem = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${meridiem}`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Human display for a schedule ("Every 30 minutes", "Every day at 9:00 AM"). */
export function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === "interval") {
    const { minutes } = schedule;
    if (minutes % 1440 === 0) return `Every ${plural(minutes / 1440, "day")}`;
    if (minutes % 60 === 0) return `Every ${plural(minutes / 60, "hour")}`;
    return `Every ${plural(minutes, "minute")}`;
  }
  const clock = formatClock(schedule.hour, schedule.minute);
  if (schedule.kind === "daily") return `Every day at ${clock}`;
  const days = [...schedule.weekdays].sort((a, b) => a - b);
  if (days.join(",") === "1,2,3,4,5") return `Every weekday at ${clock}`;
  if (days.join(",") === "0,6") return `Every weekend at ${clock}`;
  if (days.length === 7) return `Every day at ${clock}`;
  return `Every ${days.map((d) => WEEKDAY_SHORT[d] ?? "?").join(", ")} at ${clock}`;
}

function atTime(base: Date, hour: number, minute: number): Date {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** The next fire strictly after `from`, in server-local time. */
export function computeNextRun(schedule: AutomationSchedule, from: Date): Date {
  if (schedule.kind === "interval") {
    return new Date(from.getTime() + schedule.minutes * 60_000);
  }
  if (schedule.kind === "daily") {
    const today = atTime(from, schedule.hour, schedule.minute);
    if (today.getTime() > from.getTime()) return today;
    const tomorrow = new Date(from);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return atTime(tomorrow, schedule.hour, schedule.minute);
  }
  const wanted = new Set(schedule.weekdays);
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(from);
    day.setDate(day.getDate() + offset);
    const candidate = atTime(day, schedule.hour, schedule.minute);
    if (wanted.has(candidate.getDay()) && candidate.getTime() > from.getTime()) return candidate;
  }
  // Unreachable for a non-empty weekday set; defensive fallback.
  return new Date(from.getTime() + 7 * 86_400_000);
}
