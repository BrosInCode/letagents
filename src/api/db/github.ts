import crypto from "crypto";
import { and, desc, eq, or, sql } from "drizzle-orm";

import { normalizeRoomName } from "../room-routing.js";
import { db } from "./client.js";
import { github_app_installations, github_app_repositories, github_repositories, github_room_events, github_webhook_deliveries, room_aliases, rooms, tasks } from "./schema.js";
import type { GitHubRoomEventMetadata, GitHubRoomEventType } from "./schema.js";
import { toGitHubAppInstallation, toGitHubAppRepository, toGitHubRepositoryLink, toGitHubWebhookDelivery } from "./mappers.js";
import { assertRoomAliasAvailable, getProjectById } from "./rooms.js";
import type { GitHubAppInstallation, GitHubAppRepository, GitHubRepositoryLink, GitHubRoomEvent, GitHubWebhookDelivery, GitHubWebhookDeliveryStatus, Project, TaskGitHubArtifactStatus } from "./types.js";

export function serializeGitHubPermissions(
  permissions: Record<string, string> | null | undefined
): string | null {
  if (!permissions) {
    return null;
  }

  const entries = Object.entries(permissions).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return null;
  }

  return JSON.stringify(Object.fromEntries(entries));
}

export async function getGitHubRepositoryLinkById(
  githubRepoId: string
): Promise<GitHubRepositoryLink | undefined> {
  const [repo] = await db
    .select()
    .from(github_repositories)
    .where(eq(github_repositories.github_repo_id, githubRepoId))
    .limit(1);

  return repo ? toGitHubRepositoryLink(repo) : undefined;
}

export async function upsertGitHubRepositoryLink(input: {
  github_repo_id: string;
  room_id: string;
  owner_login: string;
  repo_name: string;
}): Promise<GitHubRepositoryLink> {
  const created_at = new Date().toISOString();
  const updated_at = created_at;
  const full_name = `${input.owner_login}/${input.repo_name}`;

  const [repo] = await db
    .insert(github_repositories)
    .values({
      github_repo_id: input.github_repo_id,
      room_id: input.room_id,
      owner_login: input.owner_login,
      repo_name: input.repo_name,
      full_name,
      created_at,
      updated_at,
    })
    .onConflictDoUpdate({
      target: github_repositories.github_repo_id,
      set: {
        room_id: input.room_id,
        owner_login: input.owner_login,
        repo_name: input.repo_name,
        full_name,
        updated_at,
      },
    })
    .returning();

  return toGitHubRepositoryLink(repo);
}

export async function migrateGitHubRepositoryCanonicalRoom(input: {
  github_repo_id: string;
  owner_login: string;
  repo_name: string;
}): Promise<Project | null> {
  const existing = await getGitHubRepositoryLinkById(input.github_repo_id);
  if (!existing) {
    return null;
  }

  const nextRoomId = normalizeRoomName(`github.com/${input.owner_login}/${input.repo_name}`);
  if (existing.room_id === nextRoomId) {
    await upsertGitHubRepositoryLink({
      github_repo_id: input.github_repo_id,
      room_id: nextRoomId,
      owner_login: input.owner_login,
      repo_name: input.repo_name,
    });
    return (await getProjectById(nextRoomId)) ?? null;
  }

  const updated_at = new Date().toISOString();
  await db.transaction(async (tx) => {
    await assertRoomAliasAvailable(nextRoomId, existing.room_id, tx);

    const [existingAlias] = await tx
      .select()
      .from(room_aliases)
      .where(eq(room_aliases.alias, nextRoomId))
      .limit(1);
    if (existingAlias?.room_id === existing.room_id) {
      await tx.delete(room_aliases).where(eq(room_aliases.alias, nextRoomId));
    }

    await tx
      .update(rooms)
      .set({ id: nextRoomId })
      .where(eq(rooms.id, existing.room_id));

    await tx
      .insert(room_aliases)
      .values({
        alias: existing.room_id,
        room_id: nextRoomId,
        created_at: updated_at,
      })
      .onConflictDoNothing();

    await tx
      .update(github_repositories)
      .set({
        room_id: nextRoomId,
        owner_login: input.owner_login,
        repo_name: input.repo_name,
        full_name: `${input.owner_login}/${input.repo_name}`,
        updated_at,
      })
      .where(eq(github_repositories.github_repo_id, input.github_repo_id));
  });

  return (await getProjectById(nextRoomId)) ?? null;
}

export async function upsertGitHubAppInstallation(input: {
  installation_id: string;
  target_type: string;
  target_login: string;
  target_github_id: string;
  repository_selection: string;
  permissions?: Record<string, string> | null;
  suspended_at?: string | null;
  uninstalled_at?: string | null;
}): Promise<GitHubAppInstallation> {
  const now = new Date().toISOString();
  const permissions_json = serializeGitHubPermissions(input.permissions);

  const [installation] = await db
    .insert(github_app_installations)
    .values({
      installation_id: input.installation_id,
      target_type: input.target_type,
      target_login: input.target_login,
      target_github_id: input.target_github_id,
      repository_selection: input.repository_selection,
      permissions_json,
      suspended_at: input.suspended_at ?? null,
      uninstalled_at: input.uninstalled_at ?? null,
      last_synced_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: github_app_installations.installation_id,
      set: {
        target_type: input.target_type,
        target_login: input.target_login,
        target_github_id: input.target_github_id,
        repository_selection: input.repository_selection,
        permissions_json,
        suspended_at: input.suspended_at ?? null,
        uninstalled_at: input.uninstalled_at ?? null,
        last_synced_at: now,
        updated_at: now,
      },
    })
    .returning();

  return toGitHubAppInstallation(installation);
}

export async function markGitHubAppInstallationUninstalled(
  installationId: string,
  uninstalledAt = new Date().toISOString()
): Promise<void> {
  await db
    .update(github_app_installations)
    .set({
      uninstalled_at: uninstalledAt,
      last_synced_at: uninstalledAt,
      updated_at: uninstalledAt,
    })
    .where(eq(github_app_installations.installation_id, installationId));
}

export async function setGitHubAppInstallationSuspended(
  installationId: string,
  suspendedAt: string | null
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(github_app_installations)
    .set({
      suspended_at: suspendedAt,
      last_synced_at: now,
      updated_at: now,
    })
    .where(eq(github_app_installations.installation_id, installationId));
}

export async function upsertGitHubAppRepository(input: {
  github_repo_id: string;
  installation_id: string;
  owner_login: string;
  repo_name: string;
}): Promise<GitHubAppRepository> {
  const now = new Date().toISOString();
  const full_name = `${input.owner_login}/${input.repo_name}`;
  const room_id = normalizeRoomName(`github.com/${full_name}`);

  const [repository] = await db
    .insert(github_app_repositories)
    .values({
      github_repo_id: input.github_repo_id,
      installation_id: input.installation_id,
      owner_login: input.owner_login,
      repo_name: input.repo_name,
      full_name,
      room_id,
      removed_at: null,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: github_app_repositories.github_repo_id,
      set: {
        installation_id: input.installation_id,
        owner_login: input.owner_login,
        repo_name: input.repo_name,
        full_name,
        room_id,
        removed_at: null,
        updated_at: now,
      },
    })
    .returning();

  return toGitHubAppRepository(repository);
}

export async function markGitHubAppRepositoryRemoved(
  githubRepoId: string,
  removedAt = new Date().toISOString()
): Promise<void> {
  await db
    .update(github_app_repositories)
    .set({
      removed_at: removedAt,
      updated_at: removedAt,
    })
    .where(eq(github_app_repositories.github_repo_id, githubRepoId));
}

export async function getGitHubAppRepositoryByFullName(
  fullName: string
): Promise<GitHubAppRepository | undefined> {
  const [repository] = await db
    .select()
    .from(github_app_repositories)
    .where(eq(github_app_repositories.full_name, fullName))
    .limit(1);

  return repository ? toGitHubAppRepository(repository) : undefined;
}

export async function getGitHubAppRepositoryByRoomId(
  roomId: string
): Promise<GitHubAppRepository | undefined> {
  const [repository] = await db
    .select()
    .from(github_app_repositories)
    .where(eq(github_app_repositories.room_id, roomId))
    .orderBy(desc(github_app_repositories.updated_at))
    .limit(1);

  return repository ? toGitHubAppRepository(repository) : undefined;
}

export async function getGitHubAppInstallationById(
  installationId: string
): Promise<GitHubAppInstallation | undefined> {
  const [installation] = await db
    .select()
    .from(github_app_installations)
    .where(eq(github_app_installations.installation_id, installationId))
    .limit(1);

  return installation ? toGitHubAppInstallation(installation) : undefined;
}

export async function recordGitHubWebhookDelivery(input: {
  delivery_id: string;
  event_name: string;
  action?: string | null;
  installation_id?: string | null;
  github_repo_id?: string | null;
  room_id?: string | null;
}): Promise<{ delivery: GitHubWebhookDelivery; duplicate: boolean }> {
  const received_at = new Date().toISOString();
  const [created] = await db
    .insert(github_webhook_deliveries)
    .values({
      delivery_id: input.delivery_id,
      event_name: input.event_name,
      action: input.action ?? null,
      installation_id: input.installation_id ?? null,
      github_repo_id: input.github_repo_id ?? null,
      room_id: input.room_id ?? null,
      status: "received",
      error: null,
      received_at,
      processed_at: null,
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return {
      delivery: toGitHubWebhookDelivery(created),
      duplicate: false,
    };
  }

  const [existing] = await db
    .select()
    .from(github_webhook_deliveries)
    .where(eq(github_webhook_deliveries.delivery_id, input.delivery_id))
    .limit(1);

  if (!existing) {
    throw new Error(`Webhook delivery '${input.delivery_id}' could not be recorded`);
  }

  return {
    delivery: toGitHubWebhookDelivery(existing),
    duplicate: true,
  };
}

export async function markGitHubWebhookDeliveryProcessed(
  deliveryId: string,
  input: {
    status: Exclude<GitHubWebhookDeliveryStatus, "received">;
    error?: string | null;
    installation_id?: string | null;
    github_repo_id?: string | null;
    room_id?: string | null;
  }
): Promise<void> {
  const update: Partial<typeof github_webhook_deliveries.$inferInsert> = {
    status: input.status,
    processed_at: new Date().toISOString(),
  };

  if (input.error !== undefined) {
    update.error = input.error;
  }
  if (input.installation_id !== undefined) {
    update.installation_id = input.installation_id;
  }
  if (input.github_repo_id !== undefined) {
    update.github_repo_id = input.github_repo_id;
  }
  if (input.room_id !== undefined) {
    update.room_id = input.room_id;
  }

  await db
    .update(github_webhook_deliveries)
    .set(update)
    .where(eq(github_webhook_deliveries.delivery_id, deliveryId));
}

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

  // Idempotency key conflict — fetch the existing record (key is globally unique)
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
    // Keyset cursor: fetch events strictly after the cursor using (created_at, id)
    // to avoid skipping events with identical timestamps
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

/**
 * Get GitHub artifact status for all tasks in a room that have linked events.
 * Uses linked_task_id from github_room_events to aggregate per task.
 */
export async function getTasksGitHubArtifactStatus(
  roomId: string
): Promise<Map<string, TaskGitHubArtifactStatus>> {
  const queryResults = await db
    .select({
      event: github_room_events,
      taskId: sql<string>`'task_' || ${tasks.number}`,
    })
    .from(github_room_events)
    .innerJoin(
      tasks,
      and(
        eq(tasks.room_id, roomId),
        or(
          eq(github_room_events.linked_task_id, sql`'task_' || ${tasks.number}`),
          eq(github_room_events.github_object_url, tasks.pr_url),
          sql`${tasks.workflow_artifacts} @> jsonb_build_array(jsonb_build_object('url', ${github_room_events.github_object_url}))`
        )
      )
    )
    .where(eq(github_room_events.room_id, roomId))
    .orderBy(desc(github_room_events.created_at))
    .limit(500);

  const statusMap = new Map<string, TaskGitHubArtifactStatus>();

  function metadataRecord(value: GitHubRoomEventMetadata | null): Record<string, unknown> {
    return value && typeof value === "object" ? value : {};
  }

  function metadataString(
    value: Record<string, unknown>,
    key: string
  ): string | null {
    const raw = value[key];
    return typeof raw === "string" && raw.trim() ? raw : null;
  }

  function metadataBoolean(
    value: Record<string, unknown>,
    key: string
  ): boolean | null {
    const raw = value[key];
    return typeof raw === "boolean" ? raw : null;
  }

  function normalizedReviewState(value: string | null): string | null {
    const normalized = value?.trim().toLowerCase();
    return normalized || null;
  }

  function isDecisiveReviewState(value: string | null): boolean {
    const state = normalizedReviewState(value);
    return state === "approved" || state === "changes_requested" || state === "dismissed";
  }

  function reviewUrlToPullRequestUrl(value: string | null): string | null {
    if (!value) return null;
    const marker = "#pullrequestreview-";
    if (!value.includes(marker)) return value;
    return value.slice(0, value.indexOf(marker));
  }

  for (const row of queryResults) {
    const event = row.event;
    const taskId = row.taskId;

    if (!statusMap.has(taskId)) {
      statusMap.set(taskId, {
        task_id: taskId,
        pr_state: null,
        pr_title: null,
        pr_url: null,
        pr_number: null,
        pr_author: null,
        pr_actor: null,
        pr_draft: null,
        pr_merged: null,
        checks: [],
        reviews: [],
        check_summary: { total: 0, success: 0, failure: 0, pending: 0 },
        review_summary: { total: 0, approved: 0, changes_requested: 0 },
      });
    }

    const status = statusMap.get(taskId)!;

    if (event.event_type === "pull_request" && status.pr_state === null) {
      const metadata = metadataRecord(event.metadata);
      status.pr_state = event.state;
      status.pr_title = event.title;
      status.pr_url = event.github_object_url;
      status.pr_number = event.github_object_id;
      status.pr_author = metadataString(metadata, "author_login");
      status.pr_actor = event.actor_login;
      status.pr_draft = metadataBoolean(metadata, "draft");
      status.pr_merged = metadataBoolean(metadata, "merged");
    }

    if (event.event_type === "check_run") {
      const checkName = event.title ?? event.github_object_id ?? "unknown";
      if (!status.checks.some((c) => c.name === checkName)) {
        const metadata = metadataRecord(event.metadata);
        const conclusion = metadataString(metadata, "conclusion") ?? event.state;
        const checkState = metadataString(metadata, "status") ?? event.action;
        status.checks.push({
          name: checkName,
          conclusion,
          state: checkState,
          actor: event.actor_login,
        });
      }
    }

    if (event.event_type === "pull_request_review") {
      const metadata = metadataRecord(event.metadata);
      status.pr_title ??= event.title;
      status.pr_number ??= event.github_object_id;
      status.pr_url ??= reviewUrlToPullRequestUrl(event.github_object_url);
      status.pr_author ??= metadataString(metadata, "pull_request_author_login");

      const actor = event.actor_login;
      const incomingState = event.state ?? event.action;
      const existingReview = status.reviews.find((r) => r.actor === actor);
      if (!existingReview) {
        status.reviews.push({
          actor,
          state: incomingState,
        });
      } else if (
        !isDecisiveReviewState(existingReview.state)
        && isDecisiveReviewState(incomingState)
      ) {
        existingReview.state = incomingState;
      }
    }
  }

  for (const status of statusMap.values()) {
    status.check_summary.total = status.checks.length;
    for (const check of status.checks) {
      const conclusion = check.conclusion?.toLowerCase();
      if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") status.check_summary.success++;
      else if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "cancelled" || conclusion === "action_required") status.check_summary.failure++;
      else status.check_summary.pending++;
    }

    status.review_summary.total = status.reviews.length;
    for (const review of status.reviews) {
      const state = review.state?.toLowerCase();
      if (state === "approved") status.review_summary.approved++;
      else if (state === "changes_requested") status.review_summary.changes_requested++;
    }
  }

  return statusMap;
}
