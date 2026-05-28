import type { GitHubWebhookPayload } from "../github-app.js";
import {
  buildDeliveryScopedKey,
  toGitHubId,
} from "./helpers.js";
import type { MaterializedGitHubRoomEvent } from "./types.js";

const SUPPORTED_INSTALLATION_REPOSITORY_ACTIONS = new Set(["added", "removed"]);

function getInstallationState(action: string): string {
  if (action === "deleted") {
    return "deleted";
  }
  if (action === "suspend") {
    return "suspended";
  }
  return "active";
}

function buildInstallationRepositoriesKey(
  installationId: string,
  action: string,
  repositories: GitHubWebhookPayload["repositories_added"] | GitHubWebhookPayload["repositories_removed"],
): string | null {
  const repositoryIds = (repositories ?? [])
    .map((repository) => toGitHubId(repository.id))
    .filter((value): value is string => Boolean(value))
    .sort();

  if (repositoryIds.length === 0) {
    return null;
  }

  return `installation_repositories:${installationId}:${action}:${repositoryIds.join(",")}`;
}

export function materializeInstallationEvent(
  payload: GitHubWebhookPayload,
  action: string,
  deliveryId: string,
  actorLogin: string | null,
): MaterializedGitHubRoomEvent | null {
  const installationId = toGitHubId(payload.installation?.id);
  if (!installationId) {
    return null;
  }

  return {
    event_type: "installation",
    action,
    idempotency_key: buildDeliveryScopedKey(
      `installation:${installationId}:${action}`,
      deliveryId,
    ),
    github_object_id: installationId,
    github_object_url: null,
    title: payload.installation?.account?.login ?? payload.organization?.login ?? null,
    state: getInstallationState(action),
    actor_login: actorLogin,
    metadata: {
      target_login: payload.installation?.account?.login ?? payload.organization?.login ?? null,
      target_type: payload.installation?.target_type ?? null,
      repository_selection: payload.installation?.repository_selection ?? null,
      permissions: payload.installation?.permissions ?? null,
    },
    roomEvent: null,
  };
}

export function materializeInstallationRepositoriesEvent(
  payload: GitHubWebhookPayload,
  action: string,
  deliveryId: string,
  actorLogin: string | null,
): MaterializedGitHubRoomEvent | null {
  const installationId = toGitHubId(payload.installation?.id);
  if (
    !installationId ||
    !SUPPORTED_INSTALLATION_REPOSITORY_ACTIONS.has(action)
  ) {
    return null;
  }

  const repositories =
    action === "added" ? payload.repositories_added : payload.repositories_removed;
  const idempotencyKey = buildInstallationRepositoriesKey(
    installationId,
    action,
    repositories,
  );
  if (!idempotencyKey) {
    return null;
  }

  return {
    event_type: "installation_repositories",
    action,
    idempotency_key: buildDeliveryScopedKey(idempotencyKey, deliveryId),
    github_object_id: installationId,
    github_object_url: null,
    title: payload.installation?.account?.login ?? payload.organization?.login ?? null,
    state: action,
    actor_login: actorLogin,
    metadata: {
      target_login: payload.installation?.account?.login ?? payload.organization?.login ?? null,
      repositories_added: (payload.repositories_added ?? []).map((repository) => ({
        id: toGitHubId(repository.id),
        full_name: repository.full_name,
      })),
      repositories_removed: (payload.repositories_removed ?? []).map((repository) => ({
        id: toGitHubId(repository.id),
        full_name: repository.full_name,
      })),
    },
    roomEvent: null,
  };
}
