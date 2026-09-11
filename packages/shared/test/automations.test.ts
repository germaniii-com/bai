import { describe, expect, test } from "bun:test";
import {
  computeNextRun,
  describeSchedule,
  isValidAutomationName,
  parseClockTime,
  parseDuration,
  parseScheduleInput,
} from "../src";

describe("automation schedule parsing", () => {
  test("intervals", () => {
    expect(parseDuration("30m")).toBe(30);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("1d")).toBe(1440);
    expect(parseDuration("hour")).toBe(60);
    expect(parseScheduleInput("30m")).toEqual({ kind: "interval", minutes: 30 });
    expect(parseScheduleInput("every 2h")).toEqual({ kind: "interval", minutes: 120 });
    expect(parseScheduleInput("EVERY 1D")).toEqual({ kind: "interval", minutes: 1440 });
  });

  test("daily times", () => {
    expect(parseScheduleInput("every day at 9am")).toEqual({ kind: "daily", hour: 9, minute: 0 });
    expect(parseScheduleInput("daily at 9:30")).toEqual({ kind: "daily", hour: 9, minute: 30 });
    expect(parseScheduleInput("every day at 14:00")).toEqual({ kind: "daily", hour: 14, minute: 0 });
    expect(parseScheduleInput("everyday at noon")).toEqual({ kind: "daily", hour: 12, minute: 0 });
  });

  test("weekly times", () => {
    expect(parseScheduleInput("every monday at 9am")).toEqual({
      kind: "weekly",
      weekdays: [1],
      hour: 9,
      minute: 0,
    });
    expect(parseScheduleInput("weekdays at 9am")).toEqual({
      kind: "weekly",
      weekdays: [1, 2, 3, 4, 5],
      hour: 9,
      minute: 0,
    });
    expect(parseScheduleInput("mon, wed at 9:00")).toEqual({
      kind: "weekly",
      weekdays: [1, 3],
      hour: 9,
      minute: 0,
    });
    expect(parseScheduleInput("weekends at 10am")).toEqual({
      kind: "weekly",
      weekdays: [0, 6],
      hour: 10,
      minute: 0,
    });
  });

  test("invalid input throws a clear error", () => {
    expect(() => parseScheduleInput("")).toThrow(/required/i);
    expect(() => parseScheduleInput("banana")).toThrow(/duration/i);
    expect(() => parseDuration("nope")).toThrow(/duration/i);
    expect(() => parseClockTime("25:00")).toThrow(/time/i);
  });
});

describe("automation schedule display", () => {
  test("interval formatting", () => {
    expect(describeSchedule({ kind: "interval", minutes: 1 })).toBe("Every 1 minute");
    expect(describeSchedule({ kind: "interval", minutes: 30 })).toBe("Every 30 minutes");
    expect(describeSchedule({ kind: "interval", minutes: 60 })).toBe("Every 1 hour");
    expect(describeSchedule({ kind: "interval", minutes: 120 })).toBe("Every 2 hours");
    expect(describeSchedule({ kind: "interval", minutes: 1440 })).toBe("Every 1 day");
  });

  test("daily/weekly formatting", () => {
    expect(describeSchedule({ kind: "daily", hour: 9, minute: 0 })).toBe("Every day at 9:00 AM");
    expect(describeSchedule({ kind: "daily", hour: 0, minute: 30 })).toBe("Every day at 12:30 AM");
    expect(describeSchedule({ kind: "weekly", weekdays: [1], hour: 9, minute: 0 })).toBe(
      "Every Mon at 9:00 AM",
    );
    expect(
      describeSchedule({ kind: "weekly", weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0 }),
    ).toBe("Every weekday at 9:00 AM");
    expect(describeSchedule({ kind: "weekly", weekdays: [0, 6], hour: 10, minute: 0 })).toBe(
      "Every weekend at 10:00 AM",
    );
  });
});

describe("automation next-run math", () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number): Date =>
    new Date(y, mo - 1, d, h, mi, 0, 0);

  test("interval adds minutes", () => {
    const next = computeNextRun({ kind: "interval", minutes: 30 }, at(2026, 9, 14, 8, 15));
    expect(next.getTime()).toBe(at(2026, 9, 14, 8, 45).getTime());
  });

  test("daily: later today, else tomorrow", () => {
    const schedule = { kind: "daily" as const, hour: 9, minute: 0 };
    expect(computeNextRun(schedule, at(2026, 9, 14, 8, 0)).getTime()).toBe(
      at(2026, 9, 14, 9, 0).getTime(),
    );
    expect(computeNextRun(schedule, at(2026, 9, 14, 10, 0)).getTime()).toBe(
      at(2026, 9, 15, 9, 0).getTime(),
    );
  });

  test("weekly: next matching weekday", () => {
    const monday = at(2026, 9, 14, 8, 0);
    expect(monday.getDay()).toBe(1); // guard: 2026-09-14 is a Monday
    const schedule = { kind: "weekly" as const, weekdays: [1], hour: 9, minute: 0 };
    const sameDay = computeNextRun(schedule, monday);
    expect(sameDay.getDay()).toBe(1);
    expect(sameDay.getHours()).toBe(9);
    const after = computeNextRun(schedule, at(2026, 9, 14, 10, 0));
    expect(after.getDay()).toBe(1);
    expect(after.getTime()).toBe(at(2026, 9, 21, 9, 0).getTime());
  });
});

describe("automation names", () => {
  test("accepts sensible names and rejects bad ones", () => {
    expect(isValidAutomationName("Morning report")).toBe(true);
    expect(isValidAutomationName("inbox_triage-2")).toBe(true);
    expect(isValidAutomationName("")).toBe(false);
    expect(isValidAutomationName(" leading")).toBe(false);
    expect(isValidAutomationName("bad/name")).toBe(false);
    expect(isValidAutomationName("x".repeat(65))).toBe(false);
  });
});
