import type { MyWorkPage } from "../../../../../shared/ticket-connectors.mjs";
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
  const search = params.toString();
  return apiFetch<MyWorkPage>(`/account/my-work${search ? `?${search}` : ""}`);
}
