import type {
  RoomTrackerFilterList,
  RoomTrackerFilterTestResult,
  TaskTicketDetails,
} from "../../../../../shared/ticket-connectors.mjs";
import type { DesktopTaskTicket, DesktopTrackerFilterInput } from "../../ipc-types.js";
import { apiFetch } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

const FILTER_ID = /^rtf_[0-9a-f-]{36}$/;
const CONNECTION_ID = /^tcon_[0-9a-f-]{36}$/;
const EMPTY_FILTERS: RoomTrackerFilterList = { filters: [], can_manage: false };

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** The cloud room path, or null for a local-only room (no ticket filters there). */
async function cloudRoomPath(roomIdentifier: string): Promise<string | null> {
  const trimmed = String(roomIdentifier ?? "").trim();
  if (!trimmed) return null;
  const storage = await resolveLocalAwareRoomStorageMode(trimmed);
  if (storage.effectiveMode === "local") return null;
  return `/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, trimmed))}`;
}

async function requireCloudRoomPath(roomIdentifier: string): Promise<string> {
  const path = await cloudRoomPath(roomIdentifier);
  if (!path) throw new Error("Ticket filters need a cloud room.");
  return path;
}

function filterInput(input: DesktopTrackerFilterInput): { connection_id: string; filter: string; enabled?: boolean } {
  const connectionId = String(input?.connectionId ?? "");
  if (!CONNECTION_ID.test(connectionId)) throw new Error("Choose a tracker connection.");
  return {
    connection_id: connectionId,
    filter: String(input?.filter ?? ""),
    ...(typeof input?.enabled === "boolean" ? { enabled: input.enabled } : {}),
  };
}

function filterId(id: unknown): string {
  if (typeof id !== "string" || !FILTER_ID.test(id)) throw new Error("Choose a ticket filter.");
  return id;
}

export async function listDesktopRoomTrackerFilters(roomIdentifier: string): Promise<RoomTrackerFilterList> {
  const path = await cloudRoomPath(roomIdentifier);
  if (!path) return EMPTY_FILTERS;
  return apiFetch<RoomTrackerFilterList>(`${path}/tracker-filters`);
}

export async function saveDesktopRoomTrackerFilter(roomIdentifier: string, input: DesktopTrackerFilterInput): Promise<RoomTrackerFilterList> {
  const path = await requireCloudRoomPath(roomIdentifier);
  return apiFetch<RoomTrackerFilterList>(`${path}/tracker-filters`, json("PUT", filterInput(input)));
}

export async function setDesktopRoomTrackerFilterEnabled(roomIdentifier: string, id: string, enabled: boolean): Promise<RoomTrackerFilterList> {
  const path = await requireCloudRoomPath(roomIdentifier);
  return apiFetch<RoomTrackerFilterList>(`${path}/tracker-filters/${filterId(id)}`, json("PATCH", { enabled: enabled === true }));
}

export async function removeDesktopRoomTrackerFilter(roomIdentifier: string, id: string): Promise<RoomTrackerFilterList> {
  const path = await requireCloudRoomPath(roomIdentifier);
  return apiFetch<RoomTrackerFilterList>(`${path}/tracker-filters/${filterId(id)}`, { method: "DELETE" });
}

export async function testDesktopRoomTrackerFilter(roomIdentifier: string, input: DesktopTrackerFilterInput): Promise<RoomTrackerFilterTestResult> {
  const path = await requireCloudRoomPath(roomIdentifier);
  const { connection_id, filter } = filterInput(input);
  return apiFetch<RoomTrackerFilterTestResult>(`${path}/tracker-filters/test`, json("POST", { connection_id, filter }), { timeoutMs: 45_000 });
}

/** The tracker record behind a card, or null when there is none yet. */
export async function getDesktopRoomTaskTicket(roomIdentifier: string, taskId: string): Promise<DesktopTaskTicket | null> {
  const path = await cloudRoomPath(roomIdentifier);
  if (!path || !String(taskId ?? "").trim()) return null;
  const data = await apiFetch<{ ticket?: TaskTicketDetails | null }>(`${path}/tasks/${encodeURIComponent(taskId)}/ticket`);
  const ticket = data.ticket;
  if (!ticket || typeof ticket.key !== "string") return null;
  return {
    externalRef: ticket.external_ref,
    provider: ticket.provider,
    key: ticket.key,
    title: ticket.title,
    ticketState: ticket.ticket_state,
    rawStatus: ticket.raw_status,
    assigneeLabel: ticket.assignee_label ?? null,
    // Only a web link is opened from the app.
    url: typeof ticket.url === "string" && /^https:\/\//i.test(ticket.url) ? ticket.url : null,
    trackerUpdatedAt: ticket.tracker_updated_at ?? null,
    syncedAt: ticket.synced_at,
  };
}

const PULL_REQUEST_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d{1,10}$/;

/** PR6: a room admin accepts or rejects a pull request Jev suggested for a card. */
export async function decideDesktopTaskJevLink(roomIdentifier: string, taskId: string, prUrl: string, decision: unknown): Promise<void> {
  const path = await cloudRoomPath(roomIdentifier);
  if (!path) throw new Error("Local rooms have no ticket links.");
  if (!/^task_\d{1,10}$/.test(String(taskId ?? ""))) throw new Error("Choose a card.");
  if (typeof prUrl !== "string" || !PULL_REQUEST_URL.test(prUrl)) throw new Error("Choose a pull request.");
  if (decision !== "accept" && decision !== "reject") throw new Error("Choose accept or reject.");
  await apiFetch<unknown>(`${path}/tasks/${encodeURIComponent(taskId)}/jev-link/${decision}`, json("POST", { pr_url: prUrl }));
}
