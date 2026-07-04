import type {
  TaskWorkflowArtifact,
  TaskWorkflowArtifactKind,
  TaskWorkflowArtifactMatch,
  TaskWorkflowRef,
  TaskWorkflowRefProvider,
} from "./types.js";

const TASK_WORKFLOW_ARTIFACT_PROVIDERS = new Set<TaskWorkflowRefProvider>([
  "git",
  "github",
  "gitlab",
  "bitbucket",
  "unknown",
]);

const TASK_WORKFLOW_ARTIFACT_KINDS = new Set<TaskWorkflowArtifactKind>([
  "issue",
  "branch",
  "commit",
  "diff",
  "change_summary",
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

function buildTaskWorkflowRefLabel(artifact: TaskWorkflowArtifact): string {
  switch (artifact.kind) {
    case "issue":
      return artifact.number ? `Issue #${artifact.number}` : "Issue";
    case "branch":
      return artifact.ref ? `Branch ${artifact.ref}` : "Branch";
    case "commit":
      return artifact.id ? `Commit ${artifact.id.slice(0, 12)}` : "Commit";
    case "diff":
      return artifact.title ? `Diff ${artifact.title}` : "Diff";
    case "change_summary":
      return artifact.title ? `Change summary ${artifact.title}` : "Change summary";
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

  const merged: TaskWorkflowArtifact[] = [];

  for (const artifact of persisted) {
    const alreadyPresent = merged.some((existing) =>
      areSameTaskWorkflowArtifact(existing, artifact)
    );
    if (!alreadyPresent) {
      merged.push(artifact);
    }
  }

  for (const artifact of legacy) {
    const alreadyPresent = merged.some((existing) =>
      areSameTaskWorkflowArtifact(existing, artifact)
    );

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
