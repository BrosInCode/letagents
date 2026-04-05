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

export interface TaskWorkflowRef {
  provider: TaskWorkflowRefProvider;
  kind: TaskWorkflowRefKind;
  label: string;
  url: string;
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
    const alreadyPresent = merged.some((existing) => {
      if (existing.url && artifact.url && existing.url === artifact.url) {
        return true;
      }

      return (
        existing.provider === artifact.provider &&
        existing.kind === artifact.kind &&
        (existing.number ?? null) === (artifact.number ?? null) &&
        (existing.ref ?? null) === (artifact.ref ?? null) &&
        (existing.id ?? null) === (artifact.id ?? null)
      );
    });

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
