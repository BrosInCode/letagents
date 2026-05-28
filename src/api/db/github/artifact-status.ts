import { and, desc, eq, or, sql } from "drizzle-orm";

import { db } from "../client.js";
import { github_room_events, tasks } from "../schema.js";
import type { GitHubRoomEventMetadata } from "../schema.js";
import type { GitHubRoomEvent, TaskGitHubArtifactStatus } from "../types.js";

const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAILED_CHECK_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
]);
const DECISIVE_REVIEW_STATES = new Set(["approved", "changes_requested", "dismissed"]);

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
  for (const row of queryResults) {
    applyGitHubRoomEvent(statusMap, row.taskId, row.event as GitHubRoomEvent);
  }

  summarizeStatuses(statusMap);
  return statusMap;
}

function applyGitHubRoomEvent(
  statusMap: Map<string, TaskGitHubArtifactStatus>,
  taskId: string,
  event: GitHubRoomEvent
): void {
  const status = getOrCreateStatus(statusMap, taskId);

  if (event.event_type === "pull_request" && status.pr_state === null) {
    applyPullRequestEvent(status, event);
  }

  if (event.event_type === "check_run") {
    applyCheckRunEvent(status, event);
  }

  if (event.event_type === "pull_request_review") {
    applyReviewEvent(status, event);
  }
}

function getOrCreateStatus(
  statusMap: Map<string, TaskGitHubArtifactStatus>,
  taskId: string
): TaskGitHubArtifactStatus {
  const existing = statusMap.get(taskId);
  if (existing) {
    return existing;
  }

  const status: TaskGitHubArtifactStatus = {
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
  };

  statusMap.set(taskId, status);
  return status;
}

function applyPullRequestEvent(
  status: TaskGitHubArtifactStatus,
  event: GitHubRoomEvent
): void {
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

function applyCheckRunEvent(
  status: TaskGitHubArtifactStatus,
  event: GitHubRoomEvent
): void {
  const checkName = event.title ?? event.github_object_id ?? "unknown";
  if (status.checks.some((check) => check.name === checkName)) {
    return;
  }

  const metadata = metadataRecord(event.metadata);
  status.checks.push({
    name: checkName,
    conclusion: metadataString(metadata, "conclusion") ?? event.state,
    state: metadataString(metadata, "status") ?? event.action,
    actor: event.actor_login,
  });
}

function applyReviewEvent(
  status: TaskGitHubArtifactStatus,
  event: GitHubRoomEvent
): void {
  const metadata = metadataRecord(event.metadata);
  status.pr_title ??= event.title;
  status.pr_number ??= event.github_object_id;
  status.pr_url ??= reviewUrlToPullRequestUrl(event.github_object_url);
  status.pr_author ??= metadataString(metadata, "pull_request_author_login");

  const actor = event.actor_login;
  const incomingState = event.state ?? event.action;
  const existingReview = status.reviews.find((review) => review.actor === actor);
  if (!existingReview) {
    status.reviews.push({
      actor,
      state: incomingState,
    });
    return;
  }

  if (
    !isDecisiveReviewState(existingReview.state)
    && isDecisiveReviewState(incomingState)
  ) {
    existingReview.state = incomingState;
  }
}

function summarizeStatuses(statusMap: Map<string, TaskGitHubArtifactStatus>): void {
  for (const status of statusMap.values()) {
    status.check_summary.total = status.checks.length;
    for (const check of status.checks) {
      const conclusion = check.conclusion?.toLowerCase();
      if (conclusion && SUCCESSFUL_CHECK_CONCLUSIONS.has(conclusion)) {
        status.check_summary.success++;
      } else if (conclusion && FAILED_CHECK_CONCLUSIONS.has(conclusion)) {
        status.check_summary.failure++;
      } else {
        status.check_summary.pending++;
      }
    }

    status.review_summary.total = status.reviews.length;
    for (const review of status.reviews) {
      const state = review.state?.toLowerCase();
      if (state === "approved") {
        status.review_summary.approved++;
      } else if (state === "changes_requested") {
        status.review_summary.changes_requested++;
      }
    }
  }
}

function metadataRecord(value: GitHubRoomEventMetadata | null): Record<string, unknown> {
  return value && typeof value === "object" ? value : {};
}

function metadataString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function metadataBoolean(value: Record<string, unknown>, key: string): boolean | null {
  const raw = value[key];
  return typeof raw === "boolean" ? raw : null;
}

function normalizedReviewState(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function isDecisiveReviewState(value: string | null): boolean {
  const state = normalizedReviewState(value);
  return state ? DECISIVE_REVIEW_STATES.has(state) : false;
}

function reviewUrlToPullRequestUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const marker = "#pullrequestreview-";
  return value.includes(marker) ? value.slice(0, value.indexOf(marker)) : value;
}
