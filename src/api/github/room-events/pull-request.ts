import type { GitHubWebhookPayload } from "../app.js";
import { toGitHubRepoPullRequestRef } from "../pull-request-ref.js";
import {
  buildDeliveryScopedKey,
  buildTimedSemanticKey,
  normalizeGitHubTimestamp,
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

export function materializePullRequestEvent(
  payload: GitHubWebhookPayload,
  action: string,
  deliveryId: string,
  actorLogin: string | null,
  repoIdentity: string,
  base: GitHubRepoEventBase,
): MaterializedGitHubRoomEvent | null {
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
    metadata: {
      body: pullRequest.body ?? null,
      author_login: pullRequest.authorLogin ?? null,
      draft: payload.pull_request.draft ?? null,
      merged: payload.pull_request.merged ?? null,
      merged_by_login: pullRequest.mergedByLogin ?? null,
      head_ref: headRef,
      head_sha: headSha,
    },
    roomEvent: {
      ...base,
      kind: "pull_request",
      pullRequest,
    },
  };
}
