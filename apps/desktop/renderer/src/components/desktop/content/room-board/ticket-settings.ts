import { desktopIpc } from "../../../../ipc/index";

/**
 * The Room settings rail summary for Tickets: "No filters", "1 filter",
 * "3 filters", or null when the section is hidden (no filter and no active
 * tracker connection).
 */
export function ticketSettingsSummary(filterCount: number, activeConnectionCount: number): string | null {
  if (filterCount === 0 && activeConnectionCount === 0) return null;
  if (filterCount === 0) return "No filters";
  return `${filterCount} ${filterCount === 1 ? "filter" : "filters"}`;
}

// Active tracker connections last seen in this app session; Room settings and
// the check below keep it current. Unknown counts as none.
let knownActiveConnections = 0;

export function rememberActiveConnectionCount(count: number): void {
  knownActiveConnections = count;
}

/**
 * Whether Board manager may ask the server about ticket settings at all: the
 * board shows an imported card, or you have an active tracker connection. A
 * room with neither (no connectors) makes no request.
 */
export function boardMayShowTicketSettings(tasks: ReadonlyArray<{ externalRef?: string | null }>): boolean {
  return knownActiveConnections > 0 || tasks.some((task) => Boolean(task.externalRef));
}

/**
 * True when Room settings shows its Tickets section for this room: the room
 * has a ticket filter, or you have an active tracker connection. Otherwise the
 * board shows no ticket entry (ticket connectors invariant 1).
 */
export async function roomShowsTicketSettings(roomIdentifier: string): Promise<boolean> {
  const [filterList, connectionList] = await Promise.allSettled([
    Promise.resolve().then(() => desktopIpc.room.listTrackerFilters(roomIdentifier)),
    Promise.resolve().then(() => desktopIpc.connectors.list()),
  ]);
  const filterCount = filterList.status === "fulfilled" ? filterList.value.filters.length : 0;
  const activeConnectionCount = connectionList.status === "fulfilled"
    ? connectionList.value.connections.filter((connection) => connection.status === "active").length
    : 0;
  if (connectionList.status === "fulfilled") rememberActiveConnectionCount(activeConnectionCount);
  return ticketSettingsSummary(filterCount, activeConnectionCount) !== null;
}
