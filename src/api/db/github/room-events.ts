import crypto from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "../client.js";
import { github_room_events } from "../schema.js";
import type { GitHubRoomEventMetadata, GitHubRoomEventType } from "../schema.js";
import type { GitHubRoomEvent } from "../types.js";

export async function insertGitHubRoomEvent(input: {
  room_id?: string | null;
  delivery_id?: string | null;
  event_type: GitHubRoomEventType;
  action: string;
  idempotency_key: string;
  github_object_id?: string | null;
  github_object_url?: string | null;
  title?: string | null;
  state?: string | null;
  actor_login?: string | null;
  metadata?: GitHubRoomEventMetadata | null;
  linked_task_id?: string | null;
}): Promise<{ event: GitHubRoomEvent; duplicate: boolean }> {
  const id = `gre_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date().toISOString();

  const [created] = await db
    .insert(github_room_events)
    .values({
      id,
      room_id: input.room_id ?? null,
      delivery_id: input.delivery_id ?? null,
      event_type: input.event_type,
      action: input.action,
      idempotency_key: input.idempotency_key,
      github_object_id: input.github_object_id ?? null,
      github_object_url: input.github_object_url ?? null,
      title: input.title ?? null,
      state: input.state ?? null,
      actor_login: input.actor_login ?? null,
      metadata: input.metadata ?? null,
      linked_task_id: input.linked_task_id ?? null,
      created_at: now,
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return { event: created as GitHubRoomEvent, duplicate: false };
  }

  const [existing] = await db
    .select()
    .from(github_room_events)
    .where(eq(github_room_events.idempotency_key, input.idempotency_key))
    .limit(1);

  if (!existing) {
    throw new Error(
      `GitHub room event with idempotency key '${input.idempotency_key}' could not be recorded`
    );
  }

  return { event: existing as GitHubRoomEvent, duplicate: true };
}

export async function updateGitHubRoomEventLinkedTaskId(
  idempotencyKey: string,
  linkedTaskId: string | null
): Promise<void> {
  await db
    .update(github_room_events)
    .set({
      linked_task_id: linkedTaskId,
    })
    .where(eq(github_room_events.idempotency_key, idempotencyKey));
}

export async function getGitHubRoomEvents(input: {
  room_id: string;
  event_type?: string;
  github_object_id?: string;
  actor_login?: string;
  since?: string;
  until?: string;
  after?: string;
  limit?: number;
}): Promise<{ events: GitHubRoomEvent[]; has_more: boolean }> {
  const MAX_LIMIT = 100;
  const limit = Math.min(input.limit ?? 50, MAX_LIMIT);
  const conditions = [eq(github_room_events.room_id, input.room_id)];

  if (input.event_type) {
    conditions.push(eq(github_room_events.event_type, input.event_type));
  }
  if (input.github_object_id) {
    conditions.push(eq(github_room_events.github_object_id, input.github_object_id));
  }
  if (input.actor_login) {
    conditions.push(eq(github_room_events.actor_login, input.actor_login));
  }
  if (input.since) {
    conditions.push(sql`${github_room_events.created_at} >= ${input.since}`);
  }
  if (input.until) {
    conditions.push(sql`${github_room_events.created_at} <= ${input.until}`);
  }
  if (input.after) {
    const [cursorRow] = await db
      .select({
        created_at: github_room_events.created_at,
        id: github_room_events.id,
      })
      .from(github_room_events)
      .where(and(
        eq(github_room_events.id, input.after),
        eq(github_room_events.room_id, input.room_id),
      ))
      .limit(1);
    if (cursorRow) {
      conditions.push(
        sql`(${github_room_events.created_at}, ${github_room_events.id}) < (${cursorRow.created_at}, ${cursorRow.id})`
      );
    }
  }

  const rows = await db
    .select()
    .from(github_room_events)
    .where(and(...conditions))
    .orderBy(desc(github_room_events.created_at), desc(github_room_events.id))
    .limit(limit + 1);

  const has_more = rows.length > limit;
  const events = (has_more ? rows.slice(0, limit) : rows) as GitHubRoomEvent[];

  return { events, has_more };
}
