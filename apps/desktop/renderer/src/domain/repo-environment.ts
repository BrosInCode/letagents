import type {
  DesktopGitHubRoomEvent,
  DesktopRoomInfo,
  DesktopRoomSharedArtifact,
  RepoBranchDelta,
  RepoStatus,
} from "../../../electron/ipc-types";
import { repoChangedFileCount } from "./repo-status";

export function shouldShowRepoEnvironmentForRoom(
  room: Pick<DesktopRoomInfo, "gitRoom">,
  repoStatus: RepoStatus,
  gitRoomMatchesActiveRepo: boolean,
): boolean {
  return Boolean(room.gitRoom && repoStatus.isGitRepo && gitRoomMatchesActiveRepo);
}

export function repoEnvironmentRoomRefLabel(room: Pick<DesktopRoomInfo, "gitRoom">): string | null {
  const gitRoom = room.gitRoom;
  if (!gitRoom) return null;
  const ref = gitRoom.ref;
  if (ref.type === "branch" || ref.type === "default_branch") {
    return ref.name || ref.defaultBranch || "default branch";
  }
  if (ref.type === "pull_request") {
    return ref.name ? `PR ${ref.name}` : "pull request";
  }
  return ref.name || null;
}

export function repoEnvironmentLinkedRoomLabel(room: Pick<DesktopRoomInfo, "displayName" | "gitRoom">): string {
  const repoName = room.gitRoom?.repository.fullName || room.displayName || "This room";
  const refLabel = repoEnvironmentRoomRefLabel(room);
  return refLabel ? `${repoName} · ${refLabel}` : repoName;
}

export function repoEnvironmentCurrentBranchMatchesRoom(
  room: Pick<DesktopRoomInfo, "gitRoom">,
  repoStatus: Pick<RepoStatus, "isGitRepo" | "detached" | "branch" | "defaultBranch">,
  gitRoomMatchesActiveRepo = true,
): boolean {
  if (!gitRoomMatchesActiveRepo || !room.gitRoom || !repoStatus.isGitRepo || repoStatus.detached) return false;
  const roomRef = repoEnvironmentRoomRefLabel(room);
  if (
    !roomRef ||
    (room.gitRoom.ref.type !== "branch" && room.gitRoom.ref.type !== "default_branch")
  ) return false;
  return repoStatus.branch === roomRef;
}

function repoEnvironmentCodeDeltaLabel(delta: RepoBranchDelta | null | undefined): string | null {
  if (!delta) return null;
  const additions = delta.additions.toLocaleString();
  const deletions = delta.deletions.toLocaleString();
  return `+${additions} -${deletions}`;
}

function repoEnvironmentFileDeltaLabel(filesChanged: number): string {
  return `${filesChanged.toLocaleString()} ${filesChanged === 1 ? "file" : "files"} changed`;
}

export function repoEnvironmentChangeLabel(
  repoStatus: RepoStatus,
  delta?: RepoBranchDelta | null,
): string {
  const changes = repoStatus.changes;
  const changedCount = repoChangedFileCount(repoStatus);
  if (!changes || changedCount === 0) return "Clean";
  const codeDelta = repoEnvironmentCodeDeltaLabel(delta);
  if (changes.conflicted === 0) {
    return [repoEnvironmentFileDeltaLabel(changedCount), codeDelta].filter(Boolean).join(" · ");
  }
  const parts = [
    changes.staged ? `${changes.staged} staged` : null,
    changes.unstaged ? `${changes.unstaged} modified` : null,
    changes.untracked ? `${changes.untracked} untracked` : null,
    changes.conflicted ? `${changes.conflicted} conflicted` : null,
    codeDelta,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function repoEnvironmentBranchDeltaLabel(delta: RepoBranchDelta | null | undefined): string | null {
  if (!delta) return null;
  return [
    repoEnvironmentFileDeltaLabel(delta.filesChanged),
    repoEnvironmentCodeDeltaLabel(delta),
  ].filter(Boolean).join(" · ");
}

export function repoEnvironmentBranchDeltaForRoom(
  room: Pick<DesktopRoomInfo, "gitRoom">,
  repoStatus: Pick<RepoStatus, "branch" | "branchDelta" | "branchDeltas">,
  gitRoomMatchesActiveRepo = true,
): RepoBranchDelta | null {
  const roomRef = repoEnvironmentRoomRefLabel(room);
  if (!roomRef) return null;
  const deltas = repoStatus.branchDeltas || [];
  const activeDelta = repoStatus.branchDelta ?? null;
  if (!gitRoomMatchesActiveRepo) {
    return activeDelta && (activeDelta.branch === roomRef || repoStatus.branch === roomRef)
      ? activeDelta
      : null;
  }
  return deltas.find((delta) => delta.branch === roomRef) ??
    (activeDelta && (activeDelta.branch === roomRef || repoStatus.branch === roomRef) ? activeDelta : null);
}

export function repoEnvironmentInspectableBranchDeltaForRoom(
  room: Pick<DesktopRoomInfo, "gitRoom">,
  repoStatus: Pick<
    RepoStatus,
    "isGitRepo" | "detached" | "branch" | "defaultBranch" | "branchDelta" | "branchDeltas"
  >,
  gitRoomMatchesActiveRepo = true,
): RepoBranchDelta | null {
  if (!repoEnvironmentCurrentBranchMatchesRoom(room, repoStatus, gitRoomMatchesActiveRepo)) return null;
  return repoEnvironmentBranchDeltaForRoom(room, repoStatus, gitRoomMatchesActiveRepo);
}

export interface RepoEnvironmentPullRequest {
  label: string;
  description: string | null;
  value: string | null;
  tone: "neutral" | "positive" | "attention" | "danger";
  delta: RepoBranchDelta | null;
  url: string | null;
}

export function repoEnvironmentPullRequestForRoom(
  room: Pick<DesktopRoomInfo, "gitRoom">,
  artifacts: readonly DesktopRoomSharedArtifact[],
  events: readonly DesktopGitHubRoomEvent[] = [],
): RepoEnvironmentPullRequest | null {
  const roomRef = repoEnvironmentRoomRefLabel(room);
  if (!roomRef) return null;
  const event = latestPullRequestEventForRef(events, roomRef);

  const artifact = artifacts
    .filter((candidate) =>
      candidate.kind === "pull_request" &&
      Boolean(candidate.ref && refsMatch(candidate.ref, roomRef))
    )
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  if (artifact) {
    const artifactEvent = event && pullRequestIdentityMatchesArtifact(event, artifact) ? event : null;
    return {
      label: artifact.artifactNumber ? `PR #${artifact.artifactNumber}` : "Pull request",
      description: artifact.title,
      value: artifactStateLabel(artifact.state),
      tone: pullRequestTone(artifact.state),
      delta: artifactEvent ? pullRequestDeltaFromEvent(artifactEvent, roomRef) : null,
      url: artifact.url,
    };
  }

  if (!event) return null;
  const number = event.githubObjectId || metadataNumber(event.metadata, ["number"]) ||
    metadataNumber(event.metadata, ["pull_request", "number"]);
  return {
    label: number ? `PR #${number}` : "Pull request",
    description: event.title || metadataString(event.metadata, ["pull_request", "title"]),
    value: artifactStateLabel(event.state || event.action),
    tone: pullRequestTone(event.state || event.action),
    delta: pullRequestDeltaFromEvent(event, roomRef),
    url: event.githubObjectUrl,
  };
}

function latestPullRequestEventForRef(
  events: readonly DesktopGitHubRoomEvent[],
  roomRef: string,
): DesktopGitHubRoomEvent | null {
  return events
    .filter((candidate) =>
      candidate.eventType === "pull_request" &&
      Boolean(eventBranchRef(candidate) && refsMatch(eventBranchRef(candidate) || "", roomRef))
    )
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] || null;
}

function pullRequestIdentityMatchesArtifact(
  event: DesktopGitHubRoomEvent,
  artifact: DesktopRoomSharedArtifact,
): boolean {
  const eventNumber = event.githubObjectId || metadataNumber(event.metadata, ["number"]) ||
    metadataNumber(event.metadata, ["pull_request", "number"]);
  if (artifact.artifactNumber && eventNumber) return String(artifact.artifactNumber) === eventNumber;
  if (artifact.url && event.githubObjectUrl) {
    return normalizeUrl(artifact.url) === normalizeUrl(event.githubObjectUrl);
  }
  return false;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/$/, "").toLowerCase();
}

function refsMatch(candidate: string, roomRef: string): boolean {
  const normalizedCandidate = candidate.trim().toLowerCase();
  const normalizedRoomRef = roomRef.trim().toLowerCase();
  return normalizedCandidate === normalizedRoomRef || normalizedCandidate.endsWith(`:${normalizedRoomRef}`);
}

function eventBranchRef(event: DesktopGitHubRoomEvent): string | null {
  return metadataString(event.metadata, ["head_branch"]) ||
    metadataString(event.metadata, ["head_ref"]) ||
    metadataString(event.metadata, ["branch"]) ||
    metadataString(event.metadata, ["ref"]) ||
    metadataString(event.metadata, ["pull_request", "head_ref"]) ||
    metadataString(event.metadata, ["pull_request", "head", "ref"]) ||
    metadataString(event.metadata, ["pull_request", "head", "label"]);
}

function artifactStateLabel(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function pullRequestDeltaFromEvent(event: DesktopGitHubRoomEvent, fallbackBranch: string): RepoBranchDelta | null {
  const filesChanged = metadataNumeric(event.metadata, ["changed_files"]) ??
    metadataNumeric(event.metadata, ["pull_request", "changed_files"]);
  const additions = metadataNumeric(event.metadata, ["additions"]) ??
    metadataNumeric(event.metadata, ["pull_request", "additions"]);
  const deletions = metadataNumeric(event.metadata, ["deletions"]) ??
    metadataNumeric(event.metadata, ["pull_request", "deletions"]);
  if (filesChanged === null && additions === null && deletions === null) return null;
  return {
    branch: eventBranchRef(event) || fallbackBranch,
    filesChanged: filesChanged ?? 0,
    additions: additions ?? 0,
    deletions: deletions ?? 0,
    baseBranch: metadataString(event.metadata, ["base_ref"]) ||
      metadataString(event.metadata, ["pull_request", "base_ref"]) ||
      metadataString(event.metadata, ["pull_request", "base", "ref"]),
  };
}

function pullRequestTone(value: string | null | undefined): RepoEnvironmentPullRequest["tone"] {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "neutral";
  if (["closed", "failure", "failed", "changes_requested"].includes(normalized)) return "danger";
  if (["draft", "converted_to_draft", "review_requested", "queued", "pending"].includes(normalized)) {
    return "attention";
  }
  if (["open", "opened", "reopened", "ready_for_review", "merged", "success"].includes(normalized)) {
    return "positive";
  }
  return "neutral";
}

function metadataString(metadata: Record<string, unknown>, path: string[]): string | null {
  let value: unknown = metadata;
  for (const key of path) {
    if (!value || typeof value !== "object" || !(key in value)) return null;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataNumber(metadata: Record<string, unknown>, path: string[]): string | null {
  let value: unknown = metadata;
  for (const key of path) {
    if (!value || typeof value !== "object" || !(key in value)) return null;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "number" || typeof value === "string" ? String(value) : null;
}

function metadataNumeric(metadata: Record<string, unknown>, path: string[]): number | null {
  const value = metadataNumber(metadata, path);
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
