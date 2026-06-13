export function buildRepositoryPayload() {
  return {
    id: 4242,
    full_name: "BrosInCode/letagents",
    name: "letagents",
    owner: {
      login: "BrosInCode",
    },
  };
}

export function buildCheckRunPayload(input: {
  id: number;
  name: string;
  suiteId: number;
  conclusion?: string;
  url?: string;
  branchRef?: string;
  sha?: string;
}) {
  return {
    action: "completed",
    repository: buildRepositoryPayload(),
    sender: { login: "github-actions[bot]" },
    check_run: {
      id: input.id,
      name: input.name,
      status: "completed",
      conclusion: input.conclusion ?? "failure",
      html_url: input.url ?? `https://github.com/BrosInCode/letagents/actions/runs/${input.id}`,
      head_sha: input.sha ?? "abc123def456",
      app: { name: "GitHub Actions" },
      check_suite: {
        id: input.suiteId,
        head_branch: input.branchRef ?? "codex/default-branch",
        head_sha: input.sha ?? "abc123def456",
      },
    },
  };
}

export function buildPullRequestPayload(input: {
  action?: "opened" | "closed";
  number: number;
  title: string;
  body: string;
  url: string;
  branchRef: string;
  sha: string;
  actor?: string;
  merged?: boolean;
  mergedBy?: string;
}) {
  return {
    action: input.action ?? "opened",
    repository: buildRepositoryPayload(),
    sender: { login: input.actor ?? "octocat" },
    pull_request: {
      number: input.number,
      title: input.title,
      body: input.body,
      html_url: input.url,
      head: {
        ref: input.branchRef,
        sha: input.sha,
      },
      merged: input.merged ?? false,
      merged_by: input.mergedBy ? { login: input.mergedBy } : undefined,
      user: { login: "octocat" },
    },
  };
}

export function buildPullRequestReviewPayload(input: {
  number: number;
  title: string;
  body: string;
  url: string;
  branchRef: string;
  sha: string;
  reviewId: number;
  reviewState: string;
  actor?: string;
}) {
  return {
    action: "submitted",
    repository: buildRepositoryPayload(),
    sender: { login: input.actor ?? "reviewer" },
    pull_request: {
      number: input.number,
      title: input.title,
      body: input.body,
      html_url: input.url,
      head: {
        ref: input.branchRef,
        sha: input.sha,
      },
    },
    review: {
      id: input.reviewId,
      state: input.reviewState,
      html_url: `${input.url}#pullrequestreview-${input.reviewId}`,
    },
  };
}

export function buildRepositoryRenamedPayload(input: {
  from: string;
  actor?: string;
}) {
  return {
    action: "renamed",
    repository: buildRepositoryPayload(),
    changes: {
      repository: {
        name: {
          from: input.from,
        },
      },
    },
    sender: { login: input.actor ?? "octocat" },
  };
}
