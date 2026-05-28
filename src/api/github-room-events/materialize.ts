import type { GitHubWebhookPayload } from "../github-app.js";
import type { RepoRoomEvent } from "../repo-workflow.js";
import { materializeCheckRunEvent } from "./check-run.js";
import {
  getRepoIdentity,
  normalizeDeliveryId,
} from "./helpers.js";
import {
  materializeInstallationEvent,
  materializeInstallationRepositoriesEvent,
} from "./installation.js";
import {
  materializeIssueCommentEvent,
  materializeIssueEvent,
} from "./issue.js";
import { materializePullRequestEvent } from "./pull-request.js";
import { materializeRepositoryEvent } from "./repository.js";
import { materializePullRequestReviewEvent } from "./review.js";
import type {
  GitHubRepoEventBase,
  MaterializedGitHubRoomEvent,
} from "./types.js";

export function materializeGitHubWebhookEvent(
  eventName: string,
  payload: GitHubWebhookPayload,
  deliveryId: string,
): MaterializedGitHubRoomEvent | null {
  const action = payload.action;
  if (!action) {
    return null;
  }

  const normalizedDeliveryId = normalizeDeliveryId(deliveryId);
  if (!normalizedDeliveryId) {
    return null;
  }

  const actorLogin = payload.sender?.login ?? null;

  if (eventName === "installation") {
    return materializeInstallationEvent(
      payload,
      action,
      normalizedDeliveryId,
      actorLogin,
    );
  }

  if (eventName === "installation_repositories") {
    return materializeInstallationRepositoriesEvent(
      payload,
      action,
      normalizedDeliveryId,
      actorLogin,
    );
  }

  if (!payload.repository) {
    return null;
  }

  const base: GitHubRepoEventBase = {
    provider: "github",
    action,
    repositoryFullName: payload.repository.full_name,
    senderLogin: actorLogin,
  };
  const repoIdentity = getRepoIdentity(payload.repository.full_name);

  switch (eventName) {
    case "pull_request":
      return materializePullRequestEvent(
        payload,
        action,
        normalizedDeliveryId,
        actorLogin,
        repoIdentity,
        base,
      );
    case "issues":
      return materializeIssueEvent(
        payload,
        action,
        normalizedDeliveryId,
        actorLogin,
        repoIdentity,
        base,
      );
    case "issue_comment":
      return materializeIssueCommentEvent(
        payload,
        action,
        normalizedDeliveryId,
        actorLogin,
        repoIdentity,
        base,
      );
    case "pull_request_review":
      return materializePullRequestReviewEvent(
        payload,
        action,
        normalizedDeliveryId,
        actorLogin,
        repoIdentity,
        base,
      );
    case "check_run":
      return materializeCheckRunEvent(
        payload,
        action,
        normalizedDeliveryId,
        actorLogin,
        repoIdentity,
        base,
      );
    case "repository":
      return materializeRepositoryEvent(
        payload,
        action,
        normalizedDeliveryId,
        actorLogin,
        repoIdentity,
        base,
      );
    default:
      return null;
  }
}

export function materializeGitHubRoomEvent(
  eventName: string,
  payload: GitHubWebhookPayload,
  deliveryId = "legacy-room-event",
): RepoRoomEvent | null {
  return materializeGitHubWebhookEvent(eventName, payload, deliveryId)?.roomEvent ?? null;
}
