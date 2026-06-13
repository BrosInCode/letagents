import type { GitHubWebhookPayload } from "../app.js";
import { toGitHubRepoPullRequestRef } from "../pull-request-ref.js";
import { buildDeliveryScopedKey } from "./helpers.js";
import type {
  GitHubRepoEventBase,
  MaterializedGitHubRoomEvent,
} from "./types.js";

const SUPPORTED_PULL_REQUEST_REVIEW_ACTIONS = new Set(["submitted", "dismissed"]);

export function materializePullRequestReviewEvent(
  payload: GitHubWebhookPayload,
  action: string,
  deliveryId: string,
  actorLogin: string | null,
  repoIdentity: string,
  base: GitHubRepoEventBase,
): MaterializedGitHubRoomEvent | null {
  if (
    !SUPPORTED_PULL_REQUEST_REVIEW_ACTIONS.has(action) ||
    !payload.pull_request ||
    !payload.review
  ) {
    return null;
  }

  const pullRequest = toGitHubRepoPullRequestRef(payload.pull_request);
  const reviewState = action === "dismissed" ? "dismissed" : payload.review.state;
  const reviewActorLogin = payload.review.user?.login ?? actorLogin ?? null;

  return {
    event_type: "pull_request_review",
    action,
    idempotency_key: buildDeliveryScopedKey(
      `${repoIdentity}:review:${payload.review.id}:${action}`,
      deliveryId,
    ),
    github_object_id: String(pullRequest.number),
    github_object_url: payload.review.html_url,
    title: pullRequest.title,
    state: reviewState,
    actor_login: reviewActorLogin,
    metadata: {
      body: payload.review.body ?? null,
      dismissed_by_login: action === "dismissed" ? actorLogin : null,
      pull_request_author_login: pullRequest.authorLogin ?? null,
      head_ref: payload.pull_request.head?.ref ?? null,
      head_sha: payload.pull_request.head?.sha ?? null,
    },
    roomEvent: {
      ...base,
      kind: "pull_request_review",
      pullRequest,
      review: {
        id: String(payload.review.id),
        state: reviewState,
        url: payload.review.html_url,
        body: payload.review.body,
      },
    },
  };
}
