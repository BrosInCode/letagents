import {
  trackerProviderLabel,
  type TicketState,
  type TrackerConnectionView,
  type TrackerProvider,
} from "../../../../../../../shared/ticket-connectors.mjs";

export const ticketStateOptions: Array<{ value: TicketState; label: string }> =
  [
    { value: "todo", label: "To do" },
    { value: "in_progress", label: "In progress" },
    { value: "in_review", label: "In review" },
    { value: "done", label: "Done" },
  ];

export function trackerLabel(provider: TrackerProvider): string {
  return trackerProviderLabel(provider);
}

export function ticketStateLabel(state: TicketState): string {
  return (
    ticketStateOptions.find((option) => option.value === state)?.label ?? state
  );
}

export interface StatusMapRow {
  name: string;
  state: TicketState;
  /** Seen in the tracker with no map entry; shown as in progress until saved. */
  unmapped: boolean;
}

/** Linear `type:<type>` keys read as "Any <type> status" in the editor. */
export function statusMapRowLabel(name: string): string {
  const type = /^type:(.+)$/.exec(name)?.[1];
  return type ? `Any ${type} status` : name;
}

/** The map as editor rows: unmapped statuses first, so they are fixed first. */
export function statusMapRows(
  connection: TrackerConnectionView,
): StatusMapRow[] {
  const mapped = Object.entries(connection.status_map).map(([name, state]) => ({
    name,
    state,
    unmapped: false,
  }));
  const known = new Set(mapped.map((row) => row.name.toLowerCase()));
  const unmapped = connection.unmapped_statuses
    .filter((name) => !known.has(name.toLowerCase()))
    .map((name) => ({
      name,
      state: "in_progress" as TicketState,
      unmapped: true,
    }));
  return [...unmapped, ...mapped];
}

export function statusMapFromRows(
  rows: StatusMapRow[],
): Record<string, TicketState> {
  const map: Record<string, TicketState> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) map[name] = row.state;
  }
  return map;
}

export function connectionStateLabel(connection: TrackerConnectionView): {
  label: string;
  state: string;
} {
  if (connection.status === "needs_reauth")
    return { label: "Reconnect", state: "failed" };
  if (connection.status === "error") return { label: "Error", state: "away" };
  return { label: "Connected", state: "connected" };
}

/** The remote MCP URL for this server, e.g. `https://letagents.chat/mcp`. */
export function remoteConnectorUrl(apiUrl: string | null | undefined): string {
  const base = (apiUrl ?? "").trim().replace(/\/+$/, "");
  return `${base || "https://letagents.chat"}/mcp`;
}
