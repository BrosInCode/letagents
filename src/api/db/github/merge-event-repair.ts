import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

import { db } from "../client.js";
import { toGitHubWebhookDelivery, toTaskLease } from "../mappers.js";
import { github_room_events, github_webhook_deliveries, messages, rooms, task_leases } from "../schema.js";
import type { GitHubRoomEvent, GitHubWebhookDelivery, TaskLease, TaskLeaseRow } from "../types.js";

// Reads for the one-time repair of merge events that were stored but never
// applied (src/api/github/room-event-projection/unapplied-merge-repair.ts).
// Nothing here writes.

/** Every stored pull request merge a task holds, oldest first. */
export async function listLinkedPullRequestMergeEvents(): Promise<GitHubRoomEvent[]> {
  const rows = await db
    .select()
    .from(github_room_events)
    .where(and(
      eq(github_room_events.event_type, "pull_request"),
      eq(github_room_events.action, "closed"),
      isNotNull(github_room_events.linked_task_id),
      sql`${github_room_events.metadata}->>'merged' = 'true'`
    ))
    .orderBy(asc(github_room_events.event_order_at), asc(github_room_events.id));

  return rows as GitHubRoomEvent[];
}

/** The newest stored event of one pull request, whatever room holds it. */
export async function getNewestPullRequestRoomEvent(
  githubObjectUrl: string
): Promise<GitHubRoomEvent | null> {
  const [event] = await db
    .select()
    .from(github_room_events)
    .where(and(
      eq(github_room_events.event_type, "pull_request"),
      eq(github_room_events.github_object_url, githubObjectUrl)
    ))
    .orderBy(
      desc(github_room_events.event_order_at),
      desc(github_room_events.created_at),
      desc(github_room_events.id)
    )
    .limit(1);

  return (event as GitHubRoomEvent | undefined) ?? null;
}

export async function getGitHubWebhookDelivery(
  deliveryId: string
): Promise<GitHubWebhookDelivery | null> {
  const [row] = await db
    .select()
    .from(github_webhook_deliveries)
    .where(eq(github_webhook_deliveries.delivery_id, deliveryId))
    .limit(1);

  return row ? toGitHubWebhookDelivery(row) : null;
}

/**
 * The leases of a room (or of one task) that are marked active. Unlike
 * `getActiveTaskLeases` it does not mark the expired ones as expired, so a dry
 * run stays a read; the caller drops the expired ones by `expires_at`.
 */
export async function readActiveTaskLeases(roomId: string, taskId?: string): Promise<TaskLease[]> {
  const rows = (await db
    .select()
    .from(task_leases)
    .where(and(
      eq(task_leases.room_id, roomId),
      eq(task_leases.status, "active"),
      taskId ? eq(task_leases.task_id, taskId) : undefined
    ))
    .orderBy(asc(task_leases.created_at))) as TaskLeaseRow[];

  return rows.map(toTaskLease);
}

/**
 * Traces that a merge event moved its task to merged, read in the task's room,
 * the room that holds the event, and the focus rooms under the task's room (a
 * status message lands in the task's focus room when it has one).
 */
export async function getMergeApplicationTraces(input: {
  task_room_id: string;
  event_room_id: string | null;
  /** The deterministic id of the status message the live projection posts for this event. */
  status_message_client_id: string;
  /** The start of any "was merged" status message of the task, e.g. "[status] task_4 was merged:". */
  merged_message_prefix: string;
  /** Only messages from this time on count as later. */
  since: string;
}): Promise<{ status_message_posted: boolean; merged_message_posted_since: boolean }> {
  const roomIds = db
    .select({ id: rooms.id })
    .from(rooms)
    .where(or(
      eq(rooms.id, input.task_room_id),
      input.event_room_id ? eq(rooms.id, input.event_room_id) : undefined,
      eq(rooms.parent_room_id, input.task_room_id)
    ));

  const [statusMessage] = await db
    .select({ number: messages.number })
    .from(messages)
    .where(and(
      inArray(messages.room_id, roomIds),
      eq(messages.client_message_id, input.status_message_client_id)
    ))
    .limit(1);

  const [mergedMessage] = await db
    .select({ number: messages.number })
    .from(messages)
    .where(and(
      inArray(messages.room_id, roomIds),
      eq(messages.sender, "letagents"),
      sql`left(${messages.text}, ${input.merged_message_prefix.length}) = ${input.merged_message_prefix}`,
      sql`${messages.timestamp} >= ${input.since}`
    ))
    .limit(1);

  return {
    status_message_posted: Boolean(statusMessage),
    merged_message_posted_since: Boolean(mergedMessage),
  };
}
