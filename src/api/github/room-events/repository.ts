import type { GitHubWebhookPayload } from "../app.js";
import {
  buildDeliveryScopedKey,
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

  return {
    event_type: "repository",
    action,
    idempotency_key: buildDeliveryScopedKey(
      `${repoIdentity}:repository:${repositoryId ?? repoIdentity}:${action}:${oldFullName.toLowerCase()}`,
      deliveryId,
    ),
    github_object_id: repositoryId,
    github_object_url: null,
    title: payload.repository.full_name,
    state: null,
    actor_login: actorLogin,
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
