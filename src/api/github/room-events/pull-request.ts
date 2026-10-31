import type { GitHubRoomEvent } from "../../db.js";
import type {
  RepoPullRequestEvent,
  RepoPullRequestParticipant,
  RepoPullRequestParticipantEvent,
  RepoPullRequestRef,
} from "../../repo-workflow.js";
import type { GitHubWebhookPayload } from "../app.js";
import { toGitHubRepoPullRequestRef } from "../pull-request-ref.js";
import {
  buildDeliveryScopedKey,
  buildTimedSemanticKey,
  normalizeGitHubTimestamp,
  toGitHubId,
} from "./helpers.js";
import type {
  GitHubRepoEventBase,
  MaterializedGitHubRoomEvent,
} from "./types.js";

const SUPPORTED_PULL_REQUEST_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
  "converted_to_draft",
  "closed",
]);

/** Actions that name one reviewer or assignee. GitHub sends one delivery per person. */
export const PARTICIPANT_PULL_REQUEST_ACTION_LIST = [
  "review_requested",
  "review_request_removed",
  "assigned",
  "unassigned",
] as const;

const PARTICIPANT_PULL_REQUEST_ACTIONS = new Set<string>(PARTICIPANT_PULL_REQUEST_ACTION_LIST);

function getPullRequestState(
  payload: NonNullable<GitHubWebhookPayload["pull_request"]>,
  action: string,
): string {
  if (payload.merged) {
    return "merged";
  }

  if (payload.state) {
    return payload.state;
  }

  if (action === "closed") {
    return "closed";
  }

  if (payload.draft) {
    return "draft";
  }

  return "open";
}

function buildPullRequestMetadata(
  payload: NonNullable<GitHubWebhookPayload["pull_request"]>,
  pullRequest: RepoPullRequestRef,
  baseRef: string | null,
  headRef: string | null,
  headSha: string | null,
) {
  return {
    body: pullRequest.body ?? null,
    author_login: pullRequest.authorLogin ?? null,
    draft: payload.draft ?? null,
    merged: payload.merged ?? null,
    merged_by_login: pullRequest.mergedByLogin ?? null,
    changed_files: payload.changed_files ?? null,
    additions: payload.additions ?? null,
    deletions: payload.deletions ?? null,
    base_ref: baseRef,
    head_ref: headRef,
    head_sha: headSha,
  };
}

function participantFromPayload(
  payload: GitHubWebhookPayload,
  action: string,
): RepoPullRequestParticipant | null {
  const role = action.startsWith("review") ? "reviewer" : "assignee";
  const change = action === "review_requested" || action === "assigned" ? "added" : "removed";

  if (role === "reviewer") {
    const reviewer = payload.requested_reviewer;
    if (reviewer?.login) {
      return {
        role,
        change,
        login: reviewer.login,
        github_user_id: toGitHubId(reviewer.id),
        team_slug: null,
        team_name: null,
      };
    }

    const team = payload.requested_team;
    if (team?.slug) {
      return {
        role,
        change,
        login: null,
        github_user_id: null,
        team_slug: team.slug,
        team_name: team.name?.trim() || null,
      };
    }

    return null;
  }

  const assignee = payload.assignee;
  if (!assignee?.login) {
    return null;
  }

  return {
    role,
    change,
    login: assignee.login,
    github_user_id: toGitHubId(assignee.id),
    team_slug: null,
    team_name: null,
  };
}

function materializePullRequestParticipantEvent(
  payload: GitHubWebhookPayload,
  action: string,
  deliveryId: string,
  actorLogin: string | null,
  repoIdentity: string,
  base: GitHubRepoEventBase,
): MaterializedGitHubRoomEvent | null {
  if (!payload.pull_request) {
    return null;
  }

  const participant = participantFromPayload(payload, action);
  if (!participant) {
    return null;
  }

  const pullRequest = toGitHubRepoPullRequestRef(payload.pull_request);
  const subject = participant.login
    ? `user:${participant.login}`
    : `team:${participant.team_slug}`;
  const providerObjectUpdatedAt = normalizeGitHubTimestamp(
    payload.pull_request.updated_at ?? payload.pull_request.created_at
  );
  const semanticId = buildTimedSemanticKey(
    `${repoIdentity}:pr:${pullRequest.number}:${action}:${subject}`,
    providerObjectUpdatedAt,
  );
  const headRef = payload.pull_request.head?.ref ?? null;
  const headSha = payload.pull_request.head?.sha ?? null;
  const baseRef = payload.pull_request.base?.ref ?? null;

  return {
    event_type: "pull_request",
    action,
    idempotency_key: buildDeliveryScopedKey(semanticId, deliveryId),
    semantic_id: semanticId,
    github_object_id: String(pullRequest.number),
    github_object_url: pullRequest.url,
    title: pullRequest.title,
    state: getPullRequestState(payload.pull_request, action),
    // Only the sender counts as the actor. The PR author is never used here.
    actor_login: actorLogin,
    provider_event_at: providerObjectUpdatedAt,
    provider_object_updated_at: providerObjectUpdatedAt,
    ref: headRef,
    base_ref: baseRef,
    head_ref: headRef,
    head_sha: headSha,
    metadata: {
      ...buildPullRequestMetadata(payload.pull_request, pullRequest, baseRef, headRef, headSha),
      participant,
    },
    roomEvent: {
      ...base,
      kind: "pull_request_participant",
      pullRequest,
      participant,
    },
  };
}

export function materializePullRequestEvent(
  payload: GitHubWebhookPayload,
  action: string,
  deliveryId: string,
  actorLogin: string | null,
  repoIdentity: string,
  base: GitHubRepoEventBase,
): MaterializedGitHubRoomEvent | null {
  if (PARTICIPANT_PULL_REQUEST_ACTIONS.has(action)) {
    return materializePullRequestParticipantEvent(
      payload,
      action,
      deliveryId,
      actorLogin,
      repoIdentity,
      base,
    );
  }

  if (!SUPPORTED_PULL_REQUEST_ACTIONS.has(action) || !payload.pull_request) {
    return null;
  }

  const pullRequest = toGitHubRepoPullRequestRef(payload.pull_request);
  let semanticId = `${repoIdentity}:pr:${pullRequest.number}:${action}`;
  if (action === "synchronize") {
    const headSha = payload.pull_request.head?.sha?.trim();
    if (!headSha) {
      return null;
    }
    semanticId = `${repoIdentity}:pr:${pullRequest.number}:sync:${headSha}`;
  }
  const headRef = payload.pull_request.head?.ref ?? null;
  const headSha = payload.pull_request.head?.sha ?? null;
  const baseRef = payload.pull_request.base?.ref ?? null;
  const providerObjectUpdatedAt = normalizeGitHubTimestamp(
    payload.pull_request.updated_at ?? payload.pull_request.created_at
  );
  if (action !== "synchronize") {
    semanticId = buildTimedSemanticKey(semanticId, providerObjectUpdatedAt);
  }

  return {
    event_type: "pull_request",
    action,
    idempotency_key: buildDeliveryScopedKey(semanticId, deliveryId),
    semantic_id: semanticId,
    github_object_id: String(pullRequest.number),
    github_object_url: pullRequest.url,
    title: pullRequest.title,
    state: getPullRequestState(payload.pull_request, action),
    actor_login: actorLogin ?? pullRequest.authorLogin ?? null,
    provider_event_at: providerObjectUpdatedAt,
    provider_object_updated_at: providerObjectUpdatedAt,
    ref: headRef,
    base_ref: baseRef,
    head_ref: headRef,
    head_sha: headSha,
    metadata: buildPullRequestMetadata(payload.pull_request, pullRequest, baseRef, headRef, headSha),
    roomEvent: {
      ...base,
      kind: "pull_request",
      pullRequest,
    },
  };
}

function metadataString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Reads a stored participant. Null when the row has no valid participant. */
function participantFromMetadata(value: unknown): RepoPullRequestParticipant | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const participant = value as Record<string, unknown>;
  const role = participant.role;
  const change = participant.change;
  if ((role !== "reviewer" && role !== "assignee") || (change !== "added" && change !== "removed")) {
    return null;
  }
  return {
    role,
    change,
    login: metadataString(participant.login),
    github_user_id: metadataString(participant.github_user_id),
    team_slug: metadataString(participant.team_slug),
    team_name: metadataString(participant.team_name),
  };
}

/**
 * The room event a stored pull_request row was materialized from. Reads only
 * what the webhook stored, so a replay of the row sees what the live event saw.
 */
export function rehydratePullRequestRoomEvent(
  row: GitHubRoomEvent,
): RepoPullRequestEvent | RepoPullRequestParticipantEvent | null {
  const number = Number(row.github_object_id);
  const url = row.github_object_url;
  const repositoryFullName = url
    ? /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+$/.exec(url)?.[1]
    : undefined;
  if (row.event_type !== "pull_request" || !Number.isInteger(number) || !url || !repositoryFullName) {
    return null;
  }

  const metadata = row.metadata ?? {};
  const pullRequest: RepoPullRequestRef = {
    number,
    title: row.title ?? "",
    url,
    body: metadataString(metadata.body),
    headRef: row.head_ref,
    headSha: row.head_sha,
    merged: metadata.merged === true,
    ...(metadata.draft === true ? { draft: true } : {}),
    authorLogin: metadataString(metadata.author_login),
    mergedByLogin: metadataString(metadata.merged_by_login),
  };

  if (PARTICIPANT_PULL_REQUEST_ACTIONS.has(row.action)) {
    const participant = participantFromMetadata(metadata.participant);
    if (!participant) {
      return null;
    }
    return {
      provider: "github",
      action: row.action,
      repositoryFullName,
      senderLogin: row.actor_login,
      kind: "pull_request_participant",
      pullRequest,
      participant,
    };
  }

  return {
    provider: "github",
    action: row.action,
    repositoryFullName,
    senderLogin: row.actor_login,
    kind: "pull_request",
    pullRequest,
  };
}
