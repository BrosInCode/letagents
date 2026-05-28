import {
  COMMAND_BLOCKED,
  COMMAND_OUTPUT,
  COMMAND_RUN,
  COMMAND_TIMED_OUT,
} from "../activity-event-types.js";
import {
  asObject,
  isoTs,
  readString,
} from "./helpers.js";
import type {
  ContinuityCommandEntry,
  ContinuityPackEvent,
} from "./types.js";

export function collectCommands(
  events: ReadonlyArray<ContinuityPackEvent>,
): ContinuityCommandEntry[] {
  const out: ContinuityCommandEntry[] = [];

  for (const event of events) {
    if (!isCommandEvent(event.event_type)) continue;

    const payload = asObject(event.payload);
    if (!payload) continue;

    const command = readString(payload, "command");
    if (!command) continue;

    out.push({
      command,
      ranAt: isoTs(event.created_at),
      outcome: commandOutcome(event.event_type),
      exitCode: readExitCode(payload),
      source: event.source,
    });
  }

  return out.sort((a, b) => {
    const priorityDelta = outcomePriority(b.outcome) - outcomePriority(a.outcome);
    if (priorityDelta !== 0) return priorityDelta;
    return b.ranAt.localeCompare(a.ranAt);
  });
}

function isCommandEvent(eventType: string): boolean {
  return eventType === COMMAND_RUN
    || eventType === COMMAND_TIMED_OUT
    || eventType === COMMAND_BLOCKED
    || eventType === COMMAND_OUTPUT;
}

function commandOutcome(eventType: string): ContinuityCommandEntry["outcome"] {
  if (eventType === COMMAND_TIMED_OUT) return "timed_out";
  if (eventType === COMMAND_BLOCKED) return "blocked";
  return "run";
}

function readExitCode(payload: Record<string, unknown>): number | null {
  const snakeCase = payload.exit_code;
  if (typeof snakeCase === "number") return snakeCase;

  const camelCase = payload.exitCode;
  return typeof camelCase === "number" ? camelCase : null;
}

function outcomePriority(outcome: ContinuityCommandEntry["outcome"]): number {
  switch (outcome) {
    case "blocked":
    case "timed_out":
      return 2;
    case "run":
      return 1;
  }
}
