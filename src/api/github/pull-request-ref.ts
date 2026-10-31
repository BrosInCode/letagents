import type { GitHubWebhookPullRequest } from "./app.js";
import type { RepoPullRequestRef } from "../repo-workflow.js";

export function toGitHubRepoPullRequestRef(
  pullRequest: GitHubWebhookPullRequest,
): RepoPullRequestRef {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.html_url,
    body: pullRequest.body,
    headRef: pullRequest.head?.ref,
    headSha: pullRequest.head?.sha,
    merged: pullRequest.merged,
    ...(pullRequest.draft ? { draft: true } : {}),
    authorLogin: pullRequest.user?.login,
    ...(typeof pullRequest.user?.id === "number" ? { authorId: String(pullRequest.user.id) } : {}),
    ...(pullRequest.author_association ? { authorAssociation: pullRequest.author_association } : {}),
    mergedByLogin: pullRequest.merged_by?.login,
  };
}
