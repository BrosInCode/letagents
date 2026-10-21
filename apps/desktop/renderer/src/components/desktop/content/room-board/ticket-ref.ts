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
  return `${(match[1] || "jira").toLowerCase()}:${match[2]!.toUpperCase()}`;
}
