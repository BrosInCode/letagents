import {
  DEFAULT_STATUS_MAPS,
  STATUS_MAP_MAX_ENTRIES,
  STATUS_NAME_MAX_LENGTH,
  UNMAPPED_TICKET_STATE,
  isTicketState,
  type TicketState,
  type TrackerProvider,
} from "../../../shared/ticket-connectors.mjs";

export function defaultStatusMap(provider: TrackerProvider): Record<string, TicketState> {
  return { ...DEFAULT_STATUS_MAPS[provider] };
}

/**
 * The generic state for one tracker status. A status name entry wins over a
 * `type:<type>` entry; neither gives `in_progress`, flagged as unmapped.
 */
export function mapTicketState(
  statusMap: Record<string, string>,
  status: { name: string; type?: string | null },
): { ticket_state: TicketState; unmapped: boolean } {
  const byName = new Map(Object.entries(statusMap).map(([key, value]) => [key.trim().toLowerCase(), value]));
  const named = byName.get(status.name.trim().toLowerCase());
  if (isTicketState(named)) return { ticket_state: named, unmapped: false };
  if (status.type) {
    const typed = byName.get(`type:${status.type.trim().toLowerCase()}`);
    if (isTicketState(typed)) return { ticket_state: typed, unmapped: false };
  }
  return { ticket_state: UNMAPPED_TICKET_STATE, unmapped: true };
}

/** A validated copy of a user-supplied status map, or an error message. */
export function parseStatusMap(value: unknown): { ok: true; map: Record<string, TicketState> } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "status_map must be an object of status name to ticket state." };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > STATUS_MAP_MAX_ENTRIES) {
    return { ok: false, error: `status_map can hold at most ${STATUS_MAP_MAX_ENTRIES} entries.` };
  }
  const map: Record<string, TicketState> = {};
  for (const [rawKey, state] of entries) {
    const key = rawKey.trim();
    if (!key || key.length > STATUS_NAME_MAX_LENGTH) {
      return { ok: false, error: `Status names must be 1 to ${STATUS_NAME_MAX_LENGTH} characters.` };
    }
    if (!isTicketState(state)) {
      return { ok: false, error: `"${key.slice(0, 60)}" must map to todo, in_progress, in_review or done.` };
    }
    map[key] = state;
  }
  return { ok: true, map };
}

/** Unmapped statuses after a map change: drop the ones the map now names. */
export function remainingUnmapped(statusMap: Record<string, string>, unmapped: readonly string[]): string[] {
  return unmapped.filter((name) => mapTicketState(statusMap, { name }).unmapped);
}
