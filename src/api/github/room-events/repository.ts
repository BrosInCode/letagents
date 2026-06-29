import type { GitHubWebhookPayload } from "../app.js";
import {
  buildDeliveryScopedKey,
  normalizeGitHubTimestamp,
  toGitHubId,
} from "./helpers.js";
import type {
  GitHubRepoEventBase,
  MaterializedGitHubRoomEvent,
} from "./types.js";

const SUPPORTED_REPOSITORY_ACTIONS = new Set(["renamed", "transferred"]);

function getPreviousRepositoryFullName(
  payload: GitHubWebhookPayload,
  action: string,
  repository: NonNullable<GitHubWebhookPayload["repository"]>,
): string | null {
  if (action === "renamed" && payload.changes?.repository?.name?.from) {
    const ownerLogin = repository.owner?.login
      ?? repository.full_name.split("/", 1)[0]
      ?? "";
    return `${ownerLogin}/${payload.changes.repository.name.from}`;
  }

  if (action === "transferred" && payload.changes?.owner?.from?.login) {
    return `${payload.changes.owner.from.login}/${repository.name}`;
  }

  return null;
}

export function materializeRepositoryEvent(
  payload: GitHubWebhookPayload,
  action: string,
  deliveryId: string,
  actorLogin: string | null,
  repoIdentity: string,
  base: GitHubRepoEventBase,
): MaterializedGitHubRoomEvent | null {
  if (!SUPPORTED_REPOSITORY_ACTIONS.has(action) || !payload.repository) {
    return null;
  }

  const oldFullName = getPreviousRepositoryFullName(payload, action, payload.repository);
  if (!oldFullName) {
    return null;
  }

  const repositoryId = toGitHubId(payload.repository.id);
  const semanticId = `${repoIdentity}:repository:${repositoryId ?? repoIdentity}:${action}:${oldFullName.toLowerCase()}`;
  const providerObjectUpdatedAt = normalizeGitHubTimestamp(payload.repository.updated_at);

  return {
    event_type: "repository",
    action,
    idempotency_key: buildDeliveryScopedKey(semanticId, deliveryId),
    semantic_id: semanticId,
    github_object_id: repositoryId,
    github_object_url: payload.repository.html_url ?? null,
    title: payload.repository.full_name,
    state: null,
    actor_login: actorLogin,
    provider_event_at: providerObjectUpdatedAt,
    provider_object_updated_at: providerObjectUpdatedAt,
    ref: null,
    base_ref: null,
    head_ref: null,
    head_sha: null,
    metadata: {
      old_full_name: oldFullName,
    },
    roomEvent: {
      ...base,
      kind: "repository",
      oldFullName,
    },
  };
}
