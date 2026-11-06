import { asRecord, asString } from "./http.js";

export interface TrackerIteration {
  id: string;
  name: string;
  state: "future" | "active" | "closed";
  startDate: string | null;
  endDate: string | null;
  goal: string | null;
}

export interface TrackerPlanning {
  estimate: number | null;
  iterations: TrackerIteration[];
  assigneeAvatarUrl: string | null;
  /** False means the tracker did not expose an unambiguous points field. */
  estimateAvailable: boolean;
  iterationsAvailable: boolean;
  /** Linear schedules are time-based; keep exact instants so reads can cross cycle boundaries. */
  cycleTiming?: { startsAt: string; endsAt: string; completedAt: string | null };
}

export const TRACKER_ITERATION_STALE_MS = 10 * 60_000;

export function linearCycleState(value: unknown, now: Date): TrackerIteration["state"] | null {
  const cycle = asRecord(value);
  const start = Date.parse(asString(cycle.startsAt) ?? ""), end = Date.parse(asString(cycle.endsAt) ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const completed = Date.parse(asString(cycle.completedAt) ?? "");
  return Number.isFinite(completed) || now.getTime() >= end ? "closed" : now.getTime() < start ? "future" : "active";
}

export function planningEstimate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000 ? value : null;
}

export function trackerAvatarUrl(value: unknown): string | null {
  const text = asString(value);
  if (!text || text.length > 2048) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function calendarDate(value: unknown): string | null {
  const text = asString(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(text)) return null;
  const day = text.slice(0, 10);
  return Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day ? day : null;
}

/** Jira's modern sprint custom-field value, not the legacy Java toString representation. */
export function jiraIteration(value: unknown): TrackerIteration | null {
  const sprint = asRecord(value);
  const rawId = sprint.id;
  const id = typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId > 0 ? String(rawId) : asString(rawId);
  const name = asString(sprint.name)?.trim();
  if (!id || !/^[A-Za-z0-9_-]{1,120}$/.test(id) || !name || !["future", "active", "closed"].includes(String(sprint.state))) return null;
  return {
    id, name: name.slice(0, 160), state: sprint.state as TrackerIteration["state"],
    startDate: calendarDate(sprint.startDate), endDate: calendarDate(sprint.endDate),
    goal: asString(sprint.goal)?.slice(0, 2000) || null,
  };
}

export function linearPlanning(value: unknown, now: Date): TrackerPlanning {
  const issue = asRecord(value), cycle = asRecord(issue.cycle);
  const id = asString(cycle.id);
  const startDate = calendarDate(cycle.startsAt), endDate = calendarDate(cycle.endsAt);
  const start = Date.parse(asString(cycle.startsAt) ?? ""), end = Date.parse(asString(cycle.endsAt) ?? "");
  const validCycle = id && /^[A-Za-z0-9_-]{1,120}$/.test(id) && Number.isFinite(start) && Number.isFinite(end) && end >= start;
  const completed = Date.parse(asString(cycle.completedAt) ?? "");
  const cycleTiming = validCycle ? { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(),
    completedAt: Number.isFinite(completed) ? new Date(completed).toISOString() : null } : undefined;
  return {
    estimate: planningEstimate(issue.estimate),
    assigneeAvatarUrl: trackerAvatarUrl(asRecord(issue.assignee).avatarUrl),
    estimateAvailable: Object.hasOwn(issue, "estimate"),
    iterationsAvailable: Object.hasOwn(issue, "cycle"),
    ...(cycleTiming ? { cycleTiming } : {}),
    iterations: validCycle ? [{
      id, name: asString(cycle.name)?.trim().slice(0, 160) || `Cycle ${typeof cycle.number === "number" ? cycle.number : id}`,
      state: linearCycleState(cycleTiming, now)!,
      startDate, endDate, goal: asString(cycle.description)?.slice(0, 2000) || null,
    }] : [],
  };
}
