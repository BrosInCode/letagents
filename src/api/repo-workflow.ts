import { normalizeRoomName } from "./room-routing.js";

export type RepoWorkflowProvider = "github" | "gitlab" | "bitbucket";

const REPO_PROVIDER_HOSTS: Record<RepoWorkflowProvider, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

const HOST_TO_PROVIDER = new Map<string, RepoWorkflowProvider>(
  Object.entries(REPO_PROVIDER_HOSTS).map(([provider, host]) => [
    host,
    provider as RepoWorkflowProvider,
  ])
);

export interface RepoRoomRef {
  provider: RepoWorkflowProvider;
  host: string;
  namespace: string;
  repo: string;
  fullName: string;
}

export interface RepoPullRequestRef {
  number: number;
  title: string;
  url: string;
  body?: string | null;
  merged?: boolean;
  authorLogin?: string | null;
  mergedByLogin?: string | null;
}

export interface RepoIssueRef {
  number: number;
  title: string;
  url: string;
  isPullRequest?: boolean;
}

export interface RepoIssueCommentRef {
  body: string;
  url: string;
}

export interface RepoReviewRef {
  id: string;
  state: string;
  url: string;
  body?: string | null;
}

export interface RepoCheckRunRef {
  id: string;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  appName?: string | null;
}

interface RepoRoomEventBase {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  senderLogin?: string | null;
}

export interface RepoPullRequestEvent extends RepoRoomEventBase {
  kind: "pull_request";
  pullRequest: RepoPullRequestRef;
}

export interface RepoIssueEvent extends RepoRoomEventBase {
  kind: "issue";
  issue: RepoIssueRef;
}

export interface RepoIssueCommentEvent extends RepoRoomEventBase {
  kind: "issue_comment";
  issue: RepoIssueRef;
  comment: RepoIssueCommentRef;
}

export interface RepoPullRequestReviewEvent extends RepoRoomEventBase {
  kind: "pull_request_review";
  pullRequest: RepoPullRequestRef;
  review: RepoReviewRef;
}

export interface RepoCheckRunEvent extends RepoRoomEventBase {
  kind: "check_run";
  checkRun: RepoCheckRunRef;
}

export interface RepoRepositoryEvent extends RepoRoomEventBase {
  kind: "repository";
  oldFullName?: string | null;
}

export type RepoRoomEvent =
  | RepoPullRequestEvent
  | RepoIssueEvent
  | RepoIssueCommentEvent
  | RepoPullRequestReviewEvent
  | RepoCheckRunEvent
  | RepoRepositoryEvent;

export type TaskWorkflowRefProvider = RepoWorkflowProvider | "unknown";
export type TaskWorkflowArtifactKind =
  | "issue"
  | "branch"
  | "pull_request"
  | "merge_request"
  | "review"
  | "check_run"
  | "merge";
export type TaskWorkflowRefKind = TaskWorkflowArtifactKind;

export interface TaskWorkflowArtifact {
  provider: TaskWorkflowRefProvider;
  kind: TaskWorkflowArtifactKind;
  id?: string | null;
  number?: number | null;
  title?: string | null;
  url?: string | null;
  ref?: string | null;
  state?: string | null;
}

export interface TaskWorkflowArtifactMatch {
  provider: TaskWorkflowRefProvider;
  kind: TaskWorkflowArtifactKind;
  id?: string | null;
  number?: number | null;
  title?: string | null;
  url?: string | null;
  ref?: string | null;
}

const TASK_WORKFLOW_ARTIFACT_PROVIDERS = new Set<TaskWorkflowRefProvider>([
  "github",
  "gitlab",
  "bitbucket",
  "unknown",
]);

const TASK_WORKFLOW_ARTIFACT_KINDS = new Set<TaskWorkflowArtifactKind>([
  "issue",
  "branch",
  "pull_request",
  "merge_request",
  "review",
  "check_run",
  "merge",
]);

const TASK_WORKFLOW_ARTIFACT_KEYS = new Set([
  "provider",
  "kind",
  "id",
  "number",
  "title",
  "url",
  "ref",
  "state",
]);

const MAX_TASK_WORKFLOW_ARTIFACTS = 32;

function areSameTaskWorkflowArtifact(
  left: TaskWorkflowArtifact,
  right: TaskWorkflowArtifact
): boolean {
  if (left.url && right.url) {
    return left.url === right.url;
  }

  return (
    left.provider === right.provider &&
    left.kind === right.kind &&
    (left.number ?? null) === (right.number ?? null) &&
    (left.ref ?? null) === (right.ref ?? null) &&
    (left.id ?? null) === (right.id ?? null)
  );
}

export interface TaskWorkflowRef {
  provider: TaskWorkflowRefProvider;
  kind: TaskWorkflowRefKind;
  label: string;
  url: string;
}

function addTaskWorkflowArtifactMatch(
  matches: TaskWorkflowArtifactMatch[],
  seen: Set<string>,
  match: TaskWorkflowArtifactMatch
): void {
  const key = JSON.stringify(match);
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  matches.push(match);
}

export function buildTaskWorkflowArtifactMatches(
  input: TaskWorkflowArtifactMatch
): TaskWorkflowArtifactMatch[] {
  const matches: TaskWorkflowArtifactMatch[] = [];
  const seen = new Set<string>();
  const base = {
    provider: input.provider,
    kind: input.kind,
  } satisfies Pick<TaskWorkflowArtifactMatch, "provider" | "kind">;

  if (input.url) {
    addTaskWorkflowArtifactMatch(matches, seen, { ...base, url: input.url });
  }

  if (input.number !== undefined && input.number !== null) {
    addTaskWorkflowArtifactMatch(matches, seen, { ...base, number: input.number });
  }

  if (input.id) {
    addTaskWorkflowArtifactMatch(matches, seen, { ...base, id: input.id });
  }

  if (input.ref) {
    addTaskWorkflowArtifactMatch(matches, seen, { ...base, ref: input.ref });
  }

  if (input.title) {
    addTaskWorkflowArtifactMatch(matches, seen, { ...base, title: input.title });
  }

  return matches;
}

function getProviderHost(provider: RepoWorkflowProvider): string {
  return REPO_PROVIDER_HOSTS[provider];
}

function getPullRequestLabel(provider: RepoWorkflowProvider, number: number): string {
  switch (provider) {
    case "gitlab":
      return `MR !${number}`;
    default:
      return `PR #${number}`;
  }
}

export function buildRepoRoomId(provider: RepoWorkflowProvider, fullName: string): string {
  return normalizeRoomName(`${getProviderHost(provider)}/${fullName}`);
}

export function parseRepoRoomName(roomName: string): RepoRoomRef | null {
  const normalized = normalizeRoomName(roomName);
  const parts = normalized.split("/");
  const host = parts[0]?.toLowerCase();
  const provider = host ? HOST_TO_PROVIDER.get(host) : undefined;

  if (!provider || parts.length < 3) {
    return null;
  }

  const repo = parts.at(-1) ?? "";
  const namespace = parts.slice(1, -1).join("/");

  if (!namespace || !repo) {
    return null;
  }

  return {
    provider,
    host,
    namespace,
    repo,
    fullName: `${namespace}/${repo}`,
  };
}

export function extractReferencedTaskId(
  ...texts: Array<string | null | undefined>
): string | null {
  for (const value of texts) {
    if (!value) {
      continue;
    }

    const match = /\b(task_\d+)\b/i.exec(value);
    if (match) {
      return match[1].toLowerCase();
    }
  }

  return null;
}

export function formatRepoPullRequestEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  pullRequest: RepoPullRequestRef;
  senderLogin?: string | null;
  linkedTaskId?: string | null;
}): string | null {
  const actor = input.senderLogin || input.pullRequest.authorLogin || input.provider;
  const prLabel = getPullRequestLabel(input.provider, input.pullRequest.number);
  const title = input.pullRequest.title.trim();
  const taskSuffix = input.linkedTaskId ? ` linked to ${input.linkedTaskId}` : "";

  switch (input.action) {
    case "opened":
      return `${prLabel} opened by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.pullRequest.url}`;
    case "reopened":
      return `${prLabel} reopened by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.pullRequest.url}`;
    case "ready_for_review":
      return `${prLabel} is ready for review in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.pullRequest.url}`;
    case "synchronize":
      return `${prLabel} received new commits from ${actor} in ${input.repositoryFullName}${taskSuffix}: ${input.pullRequest.url}`;
    case "converted_to_draft":
      return `${prLabel} was converted to draft by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${input.pullRequest.url}`;
    case "closed":
      if (input.pullRequest.merged) {
        const merger = input.pullRequest.mergedByLogin || actor;
        return `${prLabel} was merged by ${merger} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.pullRequest.url}`;
      }
      return `${prLabel} was closed by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.pullRequest.url}`;
    default:
      return null;
  }
}

export function formatRepoRepositoryEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  oldFullName?: string | null;
  senderLogin?: string | null;
}): string | null {
  const actor = input.senderLogin || input.provider;
  switch (input.action) {
    case "renamed":
      return input.oldFullName
        ? `Repository renamed from ${input.oldFullName} to ${input.repositoryFullName} by ${actor}`
        : `Repository ${input.repositoryFullName} was renamed by ${actor}`;
    case "transferred":
      return input.oldFullName
        ? `Repository transferred from ${input.oldFullName} to ${input.repositoryFullName} by ${actor}`
        : `Repository ${input.repositoryFullName} was transferred by ${actor}`;
    default:
      return null;
  }
}

function buildTaskWorkflowRefLabel(artifact: TaskWorkflowArtifact): string {
  switch (artifact.kind) {
    case "issue":
      return artifact.number ? `Issue #${artifact.number}` : "Issue";
    case "branch":
      return artifact.ref ? `Branch ${artifact.ref}` : "Branch";
    case "pull_request":
      return artifact.number ? `PR #${artifact.number}` : "PR";
    case "merge_request":
      return artifact.number ? `MR !${artifact.number}` : "MR";
    case "review":
      return "Review";
    case "check_run":
      return artifact.title ? `Check ${artifact.title}` : "Check";
    case "merge":
      return "Merge";
    default:
      return "Link";
  }
}

export function buildLegacyTaskWorkflowArtifacts(input: {
  prUrl?: string | null;
}): TaskWorkflowArtifact[] {
  if (!input.prUrl) {
    return [];
  }

  try {
    const url = new URL(input.prUrl);
    const hostname = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");

    if (hostname === "github.com") {
      const match = /^\/[^/]+\/[^/]+\/pull\/(\d+)$/.exec(path);
      if (match) {
        return [{
          provider: "github",
          kind: "pull_request",
          number: Number(match[1]),
          url: input.prUrl,
        }];
      }
    }

    if (hostname === "gitlab.com") {
      const match = /^\/.+\/-\/merge_requests\/(\d+)$/.exec(path);
      if (match) {
        return [{
          provider: "gitlab",
          kind: "merge_request",
          number: Number(match[1]),
          url: input.prUrl,
        }];
      }
    }

    if (hostname === "bitbucket.org") {
      const match = /^\/[^/]+\/[^/]+\/pull-requests\/(\d+)$/.exec(path);
      if (match) {
        return [{
          provider: "bitbucket",
          kind: "pull_request",
          number: Number(match[1]),
          url: input.prUrl,
        }];
      }
    }
  } catch {
    // Fall through to a generic artifact when the stored URL is not parseable.
  }

  return [{
    provider: "unknown",
    kind: "pull_request",
    url: input.prUrl,
  }];
}

export function normalizeTaskWorkflowArtifacts(input: {
  artifacts?: TaskWorkflowArtifact[] | null;
  prUrl?: string | null;
}): TaskWorkflowArtifact[] {
  const persisted = input.artifacts ?? [];
  const legacy = buildLegacyTaskWorkflowArtifacts({ prUrl: input.prUrl });

  if (!persisted.length) {
    return legacy;
  }

  const merged = [...persisted];

  for (const artifact of legacy) {
    const alreadyPresent = merged.some((existing) => areSameTaskWorkflowArtifact(existing, artifact));

    if (!alreadyPresent) {
      merged.push(artifact);
    }
  }

  return merged;
}

export function buildTaskWorkflowRefs(input: {
  artifacts?: TaskWorkflowArtifact[] | null;
  prUrl?: string | null;
}): TaskWorkflowRef[] {
  return normalizeTaskWorkflowArtifacts(input)
    .filter((artifact): artifact is TaskWorkflowArtifact & { url: string } => Boolean(artifact.url))
    .map((artifact) => ({
      provider: artifact.provider,
      kind: artifact.kind,
      label: buildTaskWorkflowRefLabel(artifact),
      url: artifact.url,
    }));
}

function asOptionalString(
  value: unknown,
  field: string,
  index: number
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`workflow_artifacts[${index}].${field} must be a string`);
  }
  return value;
}

function asOptionalInteger(
  value: unknown,
  field: string,
  index: number
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`workflow_artifacts[${index}].${field} must be a non-negative integer`);
  }
  return value;
}

export function validateTaskWorkflowArtifactsInput(input: unknown): TaskWorkflowArtifact[] | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (!Array.isArray(input)) {
    throw new Error("workflow_artifacts must be an array");
  }

  if (input.length > MAX_TASK_WORKFLOW_ARTIFACTS) {
    throw new Error(`workflow_artifacts cannot contain more than ${MAX_TASK_WORKFLOW_ARTIFACTS} entries`);
  }

  return input.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`workflow_artifacts[${index}] must be an object`);
    }

    const record = value as Record<string, unknown>;

    for (const key of Object.keys(record)) {
      if (!TASK_WORKFLOW_ARTIFACT_KEYS.has(key)) {
        throw new Error(`workflow_artifacts[${index}] has unsupported key "${key}"`);
      }
    }

    const provider = record.provider;
    const kind = record.kind;

    if (
      typeof provider !== "string" ||
      !TASK_WORKFLOW_ARTIFACT_PROVIDERS.has(provider as TaskWorkflowRefProvider)
    ) {
      throw new Error(`workflow_artifacts[${index}].provider is invalid`);
    }

    if (
      typeof kind !== "string" ||
      !TASK_WORKFLOW_ARTIFACT_KINDS.has(kind as TaskWorkflowArtifactKind)
    ) {
      throw new Error(`workflow_artifacts[${index}].kind is invalid`);
    }

    return {
      provider: provider as TaskWorkflowRefProvider,
      kind: kind as TaskWorkflowArtifactKind,
      ...(record.id !== undefined ? { id: asOptionalString(record.id, "id", index) } : {}),
      ...(record.number !== undefined
        ? { number: asOptionalInteger(record.number, "number", index) }
        : {}),
      ...(record.title !== undefined
        ? { title: asOptionalString(record.title, "title", index) }
        : {}),
      ...(record.url !== undefined ? { url: asOptionalString(record.url, "url", index) } : {}),
      ...(record.ref !== undefined ? { ref: asOptionalString(record.ref, "ref", index) } : {}),
      ...(record.state !== undefined
        ? { state: asOptionalString(record.state, "state", index) }
        : {}),
    };
  });
}

export function synchronizeTaskWorkflowArtifactsWithPrUrl(input: {
  artifacts?: TaskWorkflowArtifact[] | null;
  previousPrUrl?: string | null;
  nextPrUrl?: string | null;
}): TaskWorkflowArtifact[] {
  const baseArtifacts = [...(input.artifacts ?? [])];

  if (input.previousPrUrl && input.previousPrUrl !== input.nextPrUrl) {
    const previousLegacyArtifacts = buildLegacyTaskWorkflowArtifacts({
      prUrl: input.previousPrUrl,
    });

    return normalizeTaskWorkflowArtifacts({
      artifacts: baseArtifacts.filter(
        (artifact) =>
          !previousLegacyArtifacts.some((previousArtifact) =>
            areSameTaskWorkflowArtifact(artifact, previousArtifact)
          )
      ),
      prUrl: input.nextPrUrl,
    });
  }

  return normalizeTaskWorkflowArtifacts({
    artifacts: baseArtifacts,
    prUrl: input.nextPrUrl,
  });
}

export function formatRepoIssueEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  issue: { number: number; title: string; url: string };
  senderLogin?: string | null;
  linkedTaskId?: string | null;
}): string | null {
  const actor = input.senderLogin || input.provider;
  const issueLabel = `Issue #${input.issue.number}`;
  const title = input.issue.title.trim();
  const taskSuffix = input.linkedTaskId ? ` linked to ${input.linkedTaskId}` : "";

  switch (input.action) {
    case "opened":
      return `${issueLabel} opened by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.issue.url}`;
    case "closed":
      return `${issueLabel} closed by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.issue.url}`;
    case "reopened":
      return `${issueLabel} reopened by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.issue.url}`;
    case "labeled":
    case "unlabeled":
      return null; // Too noisy
    default:
      return null;
  }
}

export function formatRepoIssueCommentEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  issue: { number: number; title: string };
  comment: { body: string; url: string };
  senderLogin?: string | null;
  linkedTaskId?: string | null;
  isPullRequest?: boolean;
}): string | null {
  if (input.action !== "created") return null;

  const actor = input.senderLogin || input.provider;
  // GitHub sends issue_comment for both issues and PRs; use the correct label
  const contextLabel = input.isPullRequest
    ? getPullRequestLabel(input.provider, input.issue.number)
    : `Issue #${input.issue.number}`;
  const bodyPreview = input.comment.body.length > 80
    ? input.comment.body.slice(0, 77) + "..."
    : input.comment.body;
  const taskSuffix = input.linkedTaskId ? ` linked to ${input.linkedTaskId}` : "";

  return `${actor} commented on ${contextLabel} in ${input.repositoryFullName}${taskSuffix}: "${bodyPreview}" ${input.comment.url}`;
}

export function formatRepoPullRequestReviewEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  pullRequest: { number: number; title: string };
  review: { state: string; url: string };
  senderLogin?: string | null;
  linkedTaskId?: string | null;
}): string | null {
  if (input.action !== "submitted") return null;

  const actor = input.senderLogin || input.provider;
  const prLabel = getPullRequestLabel(input.provider, input.pullRequest.number);
  const taskSuffix = input.linkedTaskId ? ` linked to ${input.linkedTaskId}` : "";

  switch (input.review.state) {
    case "approved":
      return `${actor} approved ${prLabel} in ${input.repositoryFullName}${taskSuffix} ${input.review.url}`;
    case "changes_requested":
      return `${actor} requested changes on ${prLabel} in ${input.repositoryFullName}${taskSuffix} ${input.review.url}`;
    case "commented":
      return `${actor} reviewed ${prLabel} in ${input.repositoryFullName}${taskSuffix} ${input.review.url}`;
    default:
      return null;
  }
}

export function formatRepoCheckRunEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  checkRun: { name: string; status: string; conclusion: string | null; url: string; appName?: string | null };
  linkedTaskId?: string | null;
}): string | null {
  if (input.action !== "completed") return null;

  const conclusion = input.checkRun.conclusion || "unknown";
  const appLabel = input.checkRun.appName ? ` (${input.checkRun.appName})` : "";
  const taskSuffix = input.linkedTaskId ? ` linked to ${input.linkedTaskId}` : "";

  if (conclusion === "success") return null; // Only surface failures

  return `Check "${input.checkRun.name}"${appLabel} ${conclusion} in ${input.repositoryFullName}${taskSuffix} ${input.checkRun.url}`;
}

export function buildRepoRoomEventArtifactMatches(event: RepoRoomEvent): TaskWorkflowArtifactMatch[] {
  switch (event.kind) {
    case "pull_request":
      return buildTaskWorkflowArtifactMatches({
        provider: event.provider,
        kind: "pull_request",
        url: event.pullRequest.url,
        number: event.pullRequest.number,
      });
    case "issue":
    case "issue_comment":
      return buildTaskWorkflowArtifactMatches({
        provider: event.provider,
        kind: event.issue.isPullRequest ? "pull_request" : "issue",
        url: event.issue.url,
        number: event.issue.number,
      });
    case "pull_request_review":
      return [
        ...buildTaskWorkflowArtifactMatches({
          provider: event.provider,
          kind: "review",
          id: event.review.id,
          url: event.review.url,
        }),
        ...buildTaskWorkflowArtifactMatches({
          provider: event.provider,
          kind: "pull_request",
          url: event.pullRequest.url,
          number: event.pullRequest.number,
        }),
      ];
    case "check_run":
      return buildTaskWorkflowArtifactMatches({
        provider: event.provider,
        kind: "check_run",
        id: event.checkRun.id,
        title: event.checkRun.name,
        url: event.checkRun.url,
      });
    case "repository":
      return [];
    default:
      return [];
  }
}

export function getRepoRoomEventReferenceTexts(
  event: RepoRoomEvent
): Array<string | null | undefined> {
  switch (event.kind) {
    case "pull_request":
      return [event.pullRequest.title, event.pullRequest.body];
    case "issue":
      return [event.issue.title];
    case "issue_comment":
      return [event.issue.title, event.comment.body];
    case "pull_request_review":
      return [event.pullRequest.title, event.pullRequest.body, event.review.body];
    case "check_run":
    case "repository":
      return [];
    default:
      return [];
  }
}

export function formatRepoRoomEventMessage(input: {
  event: RepoRoomEvent;
  linkedTaskId?: string | null;
}): string | null {
  switch (input.event.kind) {
    case "pull_request":
      return formatRepoPullRequestEventMessage({
        provider: input.event.provider,
        action: input.event.action,
        repositoryFullName: input.event.repositoryFullName,
        pullRequest: input.event.pullRequest,
        senderLogin: input.event.senderLogin,
        linkedTaskId: input.linkedTaskId,
      });
    case "issue":
      return formatRepoIssueEventMessage({
        provider: input.event.provider,
        action: input.event.action,
        repositoryFullName: input.event.repositoryFullName,
        issue: input.event.issue,
        senderLogin: input.event.senderLogin,
        linkedTaskId: input.linkedTaskId,
      });
    case "issue_comment":
      return formatRepoIssueCommentEventMessage({
        provider: input.event.provider,
        action: input.event.action,
        repositoryFullName: input.event.repositoryFullName,
        issue: {
          number: input.event.issue.number,
          title: input.event.issue.title,
        },
        comment: input.event.comment,
        senderLogin: input.event.senderLogin,
        linkedTaskId: input.linkedTaskId,
        isPullRequest: Boolean(input.event.issue.isPullRequest),
      });
    case "pull_request_review":
      return formatRepoPullRequestReviewEventMessage({
        provider: input.event.provider,
        action: input.event.action,
        repositoryFullName: input.event.repositoryFullName,
        pullRequest: {
          number: input.event.pullRequest.number,
          title: input.event.pullRequest.title,
        },
        review: {
          state: input.event.review.state,
          url: input.event.review.url,
        },
        senderLogin: input.event.senderLogin,
        linkedTaskId: input.linkedTaskId,
      });
    case "check_run":
      return formatRepoCheckRunEventMessage({
        provider: input.event.provider,
        action: input.event.action,
        repositoryFullName: input.event.repositoryFullName,
        checkRun: input.event.checkRun,
        linkedTaskId: input.linkedTaskId,
      });
    case "repository":
      return formatRepoRepositoryEventMessage({
        provider: input.event.provider,
        action: input.event.action,
        repositoryFullName: input.event.repositoryFullName,
        oldFullName: input.event.oldFullName,
        senderLogin: input.event.senderLogin,
      });
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Board projection — pure functions to derive task status transitions from
// provider events. These are intentionally side-effect-free so they can be
// unit-tested without the database or server context.
// ---------------------------------------------------------------------------

export type TaskStatusLike =
  | "proposed"
  | "accepted"
  | "assigned"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "merged"
  | "done"
  | "cancelled";

export interface BoardProjectionResult {
  newStatus: TaskStatusLike;
  reason: string;
}

export function shouldAutoPromptForBoardProjection(result: BoardProjectionResult | null): boolean {
  return result?.reason === "pr_opened" || result?.reason === "review_changes_requested";
}

/**
 * Determine the task status transition when a pull request event occurs.
 * Returns null when no transition should happen.
 */
export function projectPullRequestEvent(input: {
  action: string;
  merged: boolean;
  currentStatus: TaskStatusLike;
}): BoardProjectionResult | null {
  const PRE_REVIEW: Set<TaskStatusLike> = new Set(["assigned", "in_progress"]);
  const MERGEABLE: Set<TaskStatusLike> = new Set(["in_review", "in_progress", "assigned"]);

  if (input.action === "opened" || input.action === "ready_for_review") {
    if (PRE_REVIEW.has(input.currentStatus)) {
      return { newStatus: "in_review", reason: "pr_opened" };
    }
  }

  if (input.action === "closed" && input.merged) {
    if (MERGEABLE.has(input.currentStatus)) {
      return { newStatus: "merged", reason: "pr_merged" };
    }
  }

  return null;
}

/**
 * Determine the task status transition when a PR review event occurs.
 * Returns null when no transition should happen.
 */
export function projectPullRequestReviewEvent(input: {
  action: string;
  reviewState: string;
  currentStatus: TaskStatusLike;
}): BoardProjectionResult | null {
  if (input.action !== "submitted") return null;

  if (input.reviewState === "changes_requested" && input.currentStatus === "in_review") {
    return { newStatus: "blocked", reason: "review_changes_requested" };
  }

  return null;
}

/**
 * Determine the task status transition when an issue event occurs.
 * Returns null when no transition should happen.
 */
export function projectIssueEvent(input: {
  action: string;
  currentStatus: TaskStatusLike;
}): BoardProjectionResult | null {
  const CLOSEABLE: Set<TaskStatusLike> = new Set(["merged", "in_review", "in_progress"]);

  if (input.action === "closed" && CLOSEABLE.has(input.currentStatus)) {
    return { newStatus: "done", reason: "issue_closed" };
  }

  return null;
}

export function projectRepoRoomEvent(input: {
  event: RepoRoomEvent;
  currentStatus: TaskStatusLike;
}): BoardProjectionResult | null {
  switch (input.event.kind) {
    case "pull_request":
      return projectPullRequestEvent({
        action: input.event.action,
        merged: Boolean(input.event.pullRequest.merged),
        currentStatus: input.currentStatus,
      });
    case "pull_request_review":
      return projectPullRequestReviewEvent({
        action: input.event.action,
        reviewState: input.event.review.state,
        currentStatus: input.currentStatus,
      });
    case "issue":
      return projectIssueEvent({
        action: input.event.action,
        currentStatus: input.currentStatus,
      });
    case "issue_comment":
    case "check_run":
    case "repository":
      return null;
    default:
      return null;
  }
}
