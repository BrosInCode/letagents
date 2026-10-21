import { randomUUID } from "node:crypto";

import {
  TRACKER_SYNC_EVENT_SOURCE,
  TRACKER_SYNC_EVENT_TYPE,
  type TrackerProvider,
} from "../../../shared/ticket-connectors.mjs";
import { db } from "../db/client.js";
import { github_room_events } from "../db/schema.js";
import { formatTaskId } from "../db/utils.js";

type InsertExecutor = Pick<typeof db, "insert">;

const PROVIDER_LABELS: Record<TrackerProvider, string> = { jira: "Jira", linear: "Linear" };

/**
 * A quiet room event for a ticket change: it is listed in the room's Events
 * tab and never posted as a chat message. It is not emitted on the GitHub
 * event bus either, so wake rules and the PR5 rules engine never see it
 * (ticket connectors invariant 4). `metadata.source` tags it for any reader
 * of the shared events table.
 */
export async function recordTrackerTicketEvent(executor: InsertExecutor, input: {
  room_id: string;
  task_number: number;
  provider: TrackerProvider;
  key: string;
  external_ref: string;
  title: string;
  url: string | null;
  action: "imported" | "ticket_state_changed";
  ticket_state: string;
  previous_ticket_state: string | null;
  raw_status: string;
  connection_id: string;
  /** Identifies the tracker change, so a webhook and a poll record it once. */
  change_id: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const idempotencyKey = `tracker:${input.room_id}:${input.external_ref}:${input.action}:${input.change_id}`;
  await executor.insert(github_room_events).values({
    id: `gre_${randomUUID().replace(/-/g, "")}`,
    room_id: input.room_id,
    delivery_id: null,
    event_type: TRACKER_SYNC_EVENT_TYPE,
    action: input.action,
    idempotency_key: idempotencyKey,
    semantic_id: idempotencyKey,
    github_object_id: input.external_ref,
    github_object_url: input.url,
    title: `${input.key} · ${input.title}`.slice(0, 500),
    state: input.ticket_state,
    actor_login: PROVIDER_LABELS[input.provider],
    provider_event_at: now,
    provider_object_updated_at: null,
    event_order_at: now,
    metadata: {
      source: TRACKER_SYNC_EVENT_SOURCE,
      provider: input.provider,
      key: input.key,
      external_ref: input.external_ref,
      raw_status: input.raw_status,
      previous_ticket_state: input.previous_ticket_state,
      connection_id: input.connection_id,
    },
    linked_task_id: formatTaskId(input.task_number),
    created_at: now,
  }).onConflictDoNothing();
}
