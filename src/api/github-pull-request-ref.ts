import type { GitHubWebhookPullRequest } from "./github-app.js";
import type { RepoPullRequestRef } from "./repo-workflow.js";

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
    authorLogin: pullRequest.user?.login,
    mergedByLogin: pullRequest.merged_by?.login,
  };
}
