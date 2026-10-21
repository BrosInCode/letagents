/** A card's `external_ref`, e.g. `jira:HT-1234`, split for display. */
export interface TicketRefParts {
  provider: string;
  providerLabel: string;
  key: string;
}

const PROVIDER_LABELS: Record<string, string> = { jira: "Jira", linear: "Linear" };

export function ticketRefParts(externalRef: string | null | undefined): TicketRefParts | null {
  if (!externalRef) return null;
  const separator = externalRef.indexOf(":");
  if (separator <= 0 || separator === externalRef.length - 1) return null;
  const provider = externalRef.slice(0, separator);
  return {
    provider,
    providerLabel: PROVIDER_LABELS[provider] ?? provider,
    key: externalRef.slice(separator + 1),
  };
}

/** What the task editor saves: content edits and, on a cloud room, the ticket. */
export interface TaskEditPatch {
  title?: string;
  description?: string;
  /** Present only when the title or description changed. */
  expected_content?: { title?: string; description?: string };
  external_ref?: string | null;
}

/**
 * Reads a typed ticket key: `HT-1234` (Jira), `jira:HT-1234` or
 * `linear:ENG-12`. Null for an empty value, undefined for one that is not a
 * key. The server checks the key again; this only catches typos early.
 */
export function normalizedExternalRef(value: string): string | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^(?:(jira|linear):)?\s*([A-Za-z][A-Za-z0-9]*-\d+)$/i.exec(trimmed);
  if (!match) return undefined;
  const provider = (match[1] || "jira").toLowerCase();
  // Jira project keys have two or more characters; Linear team keys may have one.
  if (provider === "jira" && !/^[A-Za-z][A-Za-z0-9]+-/.test(match[2]!)) return undefined;
  return `${provider}:${match[2]!.toUpperCase()}`;
}

/** Cards that sync imported carry `created_by` `tracker:jira` or `tracker:linear`. */
export function isImportedTask(task: { createdBy?: string | null }): boolean {
  return task.createdBy === "tracker:jira" || task.createdBy === "tracker:linear";
}

const TICKET_STATE_LABELS: Record<string, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

/** The tracker's state, as a short label; null when the card has none. */
export function ticketStateLabel(state: string | null | undefined): string | null {
  if (!state) return null;
  return TICKET_STATE_LABELS[state] ?? state.replace(/_/g, " ");
}

/** Board source filter: every card, cards that name a ticket, or cards that do not. */
export type BoardSourceFilter = "all" | "tracker" | "native";

export const BOARD_SOURCE_OPTIONS: ReadonlyArray<{ id: BoardSourceFilter; label: string }> = [
  { id: "all", label: "All cards" },
  { id: "tracker", label: "Tracker cards" },
  { id: "native", label: "Native cards" },
];

export function isBoardSourceFilter(value: string): value is BoardSourceFilter {
  return value === "all" || value === "tracker" || value === "native";
}

export function taskMatchesSource(task: { externalRef?: string | null }, source: string | undefined): boolean {
  if (!source || source === "all") return true;
  return source === "tracker" ? Boolean(task.externalRef) : !task.externalRef;
}
