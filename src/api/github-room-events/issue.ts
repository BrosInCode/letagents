import type { GitHubWebhookPayload } from "../github-app.js";
import {
  buildDeliveryScopedKey,
  toRepoIssueRef,
} from "./helpers.js";
import {
  SUPPORTED_ISSUE_ACTIONS,
  SUPPORTED_ISSUE_COMMENT_ACTIONS,
} from "./supported-actions.js";
import type {
  GitHubRepoEventBase,
  MaterializedGitHubRoomEvent,
} from "./types.js";

export function materializeIssueEvent(
  payload: GitHubWebhookPayload,
  action: string,
  deliveryId: string,
  actorLogin: string | null,
  repoIdentity: string,
  base: GitHubRepoEventBase,
): MaterializedGitHubRoomEvent | null {
  if (!SUPPORTED_ISSUE_ACTIONS.has(action)) {
    return null;
  }

  const issue = toRepoIssueRef(payload.issue);
  if (!issue) {
    return null;
  }

  return {
    event_type: "issue",
    action,
    idempotency_key: buildDeliveryScopedKey(
      `${repoIdentity}:issue:${issue.number}:${action}`,
      deliveryId,
    ),
    github_object_id: String(issue.number),
    github_object_url: issue.url,
    title: issue.title,
    state: payload.issue?.state ?? (action === "closed" ? "closed" : "open"),
    actor_login: actorLogin ?? payload.issue?.user?.login ?? null,
    metadata: {
      labels: payload.issue?.labels?.map((label) => label.name) ?? [],
      is_pull_request: issue.isPullRequest ?? false,
    },
    roomEvent: {
      ...base,
      kind: "issue",
      issue,
    },
  };
}

export function materializeIssueCommentEvent(
  payload: GitHubWebhookPayload,
  action: string,
  deliveryId: string,
  actorLogin: string | null,
  repoIdentity: string,
  base: GitHubRepoEventBase,
): MaterializedGitHubRoomEvent | null {
  if (!SUPPORTED_ISSUE_COMMENT_ACTIONS.has(action)) {
    return null;
  }

  const issue = toRepoIssueRef(payload.issue);
  if (!issue || !payload.comment) {
    return null;
  }

  return {
    event_type: "issue_comment",
    action,
    idempotency_key: buildDeliveryScopedKey(
      `${repoIdentity}:comment:${payload.comment.id}:created`,
      deliveryId,
    ),
    github_object_id: String(issue.number),
    github_object_url: payload.comment.html_url,
    title: issue.title,
    state: payload.issue?.state ?? null,
    actor_login: actorLogin ?? payload.comment.user?.login ?? null,
    metadata: {
      body: payload.comment.body,
      is_pull_request: issue.isPullRequest ?? false,
    },
    roomEvent: {
      ...base,
      kind: "issue_comment",
      issue,
      comment: {
        body: payload.comment.body,
        url: payload.comment.html_url,
      },
    },
  };
}
