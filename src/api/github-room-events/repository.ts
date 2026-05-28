import type { GitHubWebhookPayload } from "../github-app.js";
import {
  buildDeliveryScopedKey,
  getPreviousRepositoryFullName,
  toGitHubId,
} from "./helpers.js";
import { SUPPORTED_REPOSITORY_ACTIONS } from "./supported-actions.js";
import type {
  GitHubRepoEventBase,
  MaterializedGitHubRoomEvent,
} from "./types.js";

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

  const oldFullName = getPreviousRepositoryFullName(payload);
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
