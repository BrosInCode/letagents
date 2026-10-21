import { and, eq } from "drizzle-orm";

import { isTicketState, type TaskTicketDetails, type TrackerProvider } from "../../../shared/ticket-connectors.mjs";
import { db } from "../db/client.js";
import { external_items, tasks } from "../db/schema.js";
import { parseScopedId } from "../db/utils.js";

/**
 * The cached tracker record behind a card, or null when the card names no
 * ticket or no room filter has synced it yet. One indexed read; the desktop
 * asks only for cards that carry a ticket state.
 */
export async function getTaskTicketDetails(roomId: string, taskId: string): Promise<TaskTicketDetails | null> {
  const number = parseScopedId(taskId, "task");
  if (!number) return null;
  const [row] = await db.select({
    external_ref: tasks.external_ref,
    provider: external_items.provider,
    key: external_items.key,
    title: external_items.title,
    ticket_state: external_items.ticket_state,
    raw_status: external_items.raw_status,
    assignee_label: external_items.assignee_label,
    url: external_items.url,
    tracker_updated_at: external_items.tracker_updated_at,
    synced_at: external_items.synced_at,
  }).from(tasks)
    .innerJoin(external_items, eq(external_items.id, tasks.external_item_id))
    .where(and(eq(tasks.room_id, roomId), eq(tasks.number, number)))
    .limit(1);
  if (!row?.external_ref || !isTicketState(row.ticket_state)) return null;
  return {
    external_ref: row.external_ref,
    provider: row.provider as TrackerProvider,
    key: row.key,
    title: row.title,
    ticket_state: row.ticket_state,
    raw_status: row.raw_status,
    assignee_label: row.assignee_label,
    // Only a web link leaves the app.
    url: row.url && /^https:\/\//i.test(row.url) ? row.url : null,
    tracker_updated_at: row.tracker_updated_at,
    synced_at: row.synced_at,
  };
}
