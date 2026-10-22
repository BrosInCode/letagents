import type { MyWorkJevNeedsMe, MyWorkPage } from "../../../../../shared/ticket-connectors.mjs";
import type { DesktopMyWorkQuery } from "../../ipc-types.js";
import { apiFetch } from "../auth.js";

const TRACKERS = new Set(["jira", "linear", "native"]);

/** The account's work across its cloud rooms (ticket connectors PR4). */
export async function getDesktopMyWork(query?: DesktopMyWorkQuery): Promise<MyWorkPage> {
  const params = new URLSearchParams();
  if (typeof query?.cursor === "string" && query.cursor) params.set("cursor", query.cursor);
  if (Number.isInteger(query?.limit) && query!.limit! > 0) params.set("limit", String(Math.min(query!.limit!, 100)));
  if (typeof query?.tracker === "string" && TRACKERS.has(query.tracker)) params.set("tracker", query.tracker);
  if (typeof query?.roomId === "string" && query.roomId.trim()) params.set("room", query.roomId.trim());
  if (query?.needsMe === true) params.set("needs_me", "true");
  if (query?.includeCompleted === true) params.set("include_completed", "true");
  const search = params.toString();
  return apiFetch<MyWorkPage>(`/account/my-work${search ? `?${search}` : ""}`);
}

/** PR6: Jev reads who one card waits on (cached on the server per card and last message). */
export function askDesktopMyWorkNeedsMe(roomId: unknown, taskId: unknown): Promise<MyWorkJevNeedsMe> {
  if (typeof roomId !== "string" || !roomId.trim() || typeof taskId !== "string" || !/^task_\d{1,10}$/.test(taskId)) {
    throw new Error("Choose a card.");
  }
  return apiFetch<MyWorkJevNeedsMe>("/account/my-work/needs-me", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room_id: roomId.trim(), task_id: taskId }),
  }, { timeoutMs: 20_000 });
}
