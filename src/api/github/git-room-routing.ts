import {
  getGitChildRoom,
  getOrCreateCanonicalRoom,
  getOrCreateGitChildRoom,
  upsertGitRoomBinding,
  type Project,
} from "../db.js";
import { normalizeGitRoomVisibility } from "../db/git-room-bindings.js";
import type { GitRoomRefType } from "../db/types.js";
import { parseFocusRoomLocator } from "../rooms/routing.js";
import {
  buildGitHubRepoRoomId,
  type GitHubWebhookPayload,
  type GitHubWebhookRepository,
} from "./app.js";
import type { MaterializedGitHubRoomEvent } from "./room-events.js";

type RefRoomType = Extract<GitRoomRefType, "branch" | "tag">;

export interface GitHubRefRoomTarget {
  refType: RefRoomType;
  refName: string;
}

function encodeRefForRoomId(refName: string): string {
  return Buffer.from(refName, "utf8").toString("base64url");
}

function decodeRefFromRoomId(encodedRef: string): string | null {
  try {
    const decoded = Buffer.from(encodedRef, "base64url").toString("utf8");
    if (!decoded || encodeRefForRoomId(decoded) !== encodedRef) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function normalizeRefName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function splitRepositoryFullName(fullName: string): { owner: string; name: string } {
  const [owner = "", name = ""] = fullName.split("/", 2);
  return { owner, name };
}

function refRoomTarget(
  refType: string | null | undefined,
  refName: string | null | undefined
): GitHubRefRoomTarget | null {
  const normalizedRefName = normalizeRefName(refName);
  if (!normalizedRefName || (refType !== "branch" && refType !== "tag")) {
    return null;
  }
  return { refType, refName: normalizedRefName };
}

export function buildGitHubRefRoomLocator(input: {
  repositoryFullName: string;
  refType: RefRoomType;
  refName: string;
}): string {
  const parentRoomLocator = buildGitHubRepoRoomId(input.repositoryFullName);
  return `${parentRoomLocator}/focus/${buildGitHubRefFocusKey(input)}`;
}

export function parseGitHubRefRoomLocator(roomLocator: string): {
  repositoryFullName: string;
  refType: RefRoomType;
  refName: string;
} | null {
  const focusLocator = parseFocusRoomLocator(roomLocator.trim());
  if (!focusLocator) {
    return null;
  }

  const parentMatch = /^github\.com\/([^/\s]+\/[^/\s]+)$/.exec(focusLocator.parentRoomId);
  const ref = parseGitHubRefFocusKey(focusLocator.focusKey);
  if (!parentMatch || !ref) {
    return null;
  }

  return {
    repositoryFullName: parentMatch[1].toLowerCase(),
    ...ref,
  };
}

export function buildGitHubRefFocusKey(input: {
  refType: RefRoomType;
  refName: string;
}): string {
  return `git:${input.refType}:${encodeRefForRoomId(input.refName)}`;
}

export function parseGitHubRefFocusKey(focusKey: string): GitHubRefRoomTarget | null {
  const match = /^git:(branch|tag):([A-Za-z0-9_-]+)$/.exec(focusKey.trim());
  if (!match) {
    return null;
  }

  const refName = decodeRefFromRoomId(match[2]);
  return refName ? { refType: match[1] as RefRoomType, refName } : null;
}

function gitRefRoomDisplayName(target: GitHubRefRoomTarget): string {
  return `${target.refType === "branch" ? "Branch" : "Tag"}: ${target.refName}`;
}

export async function getOrCreateGitHubRefRoomFromLocator(
  roomLocator: string
): Promise<Project | null> {
  const parsed = parseGitHubRefRoomLocator(roomLocator);
  if (!parsed) {
    return null;
  }

  const { owner, name } = splitRepositoryFullName(parsed.repositoryFullName);
  if (!owner || !name) {
    return null;
  }

  const { room: repoRoom } = await getOrCreateCanonicalRoom(
    buildGitHubRepoRoomId(parsed.repositoryFullName)
  );
  const { room } = await getOrCreateGitChildRoom({
    parentRoomId: repoRoom.id,
    focusKey: buildGitHubRefFocusKey(parsed),
    displayName: gitRefRoomDisplayName(parsed),
  });

  await upsertGitRoomBinding({
    room_id: room.id,
    provider: "github",
    host: "github.com",
    repository_id: null,
    repository_full_name: parsed.repositoryFullName,
    repository_owner: owner,
    repository_name: name,
    ref_type: parsed.refType,
    ref_name: parsed.refName,
    default_branch: null,
    base_ref: null,
    head_ref: parsed.refType === "branch" ? parsed.refName : null,
    head_repository_id: null,
    head_repository_full_name: null,
    head_repository_owner: null,
    head_repository_name: null,
    visibility: "unknown",
    is_default: false,
    source: "manual",
  });

  return room;
}

export function selectGitHubEventRefRoomTarget(input: {
  event: MaterializedGitHubRoomEvent;
  defaultBranch?: string | null;
}): GitHubRefRoomTarget | null {
  const roomEvent = input.event.roomEvent;
  let target: GitHubRefRoomTarget | null = null;

  if (roomEvent?.kind === "push") {
    target = refRoomTarget(roomEvent.push.refType, roomEvent.push.ref);
  } else if (roomEvent?.kind === "branch_ref") {
    target = refRoomTarget(roomEvent.branch.refType, roomEvent.branch.ref);
  } else {
    const headRef = normalizeRefName(input.event.head_ref);
    if (headRef) {
      target = { refType: "branch", refName: headRef };
    }
  }

  if (
    target?.refType === "branch" &&
    input.defaultBranch &&
    target.refName === input.defaultBranch
  ) {
    return null;
  }

  return target;
}

export function shouldCreateGitHubRefRoomForEvent(
  event: MaterializedGitHubRoomEvent
): boolean {
  const roomEvent = event.roomEvent;
  if (!roomEvent) {
    return false;
  }

  if (roomEvent.kind === "branch_ref" && roomEvent.action === "delete") {
    return false;
  }

  if (roomEvent.kind === "push" && event.state === "deleted") {
    return false;
  }

  if (roomEvent.kind === "pull_request" && event.action === "closed") {
    return false;
  }

  return true;
}

export function shouldResolveArchivedGitRefRoomForEvent(
  event: MaterializedGitHubRoomEvent
): boolean {
  return (
    event.roomEvent?.kind === "pull_request" &&
    event.action === "closed" &&
    event.state === "merged"
  );
}

function getPullRequestHeadRepository(
  payload: GitHubWebhookPayload
): {
  id: string | null;
  fullName: string | null;
  owner: string | null;
  name: string | null;
} | null {
  const repo = payload.pull_request?.head?.repo;
  if (!repo?.full_name) {
    return null;
  }

  const { owner, name } = splitRepositoryFullName(repo.full_name);
  return {
    id: repo.id === undefined || repo.id === null ? null : String(repo.id),
    fullName: repo.full_name,
    owner: repo.owner?.login ?? (owner || null),
    name: repo.name ?? (name || null),
  };
}

function isCrossRepositoryPullRequestEvent(input: {
  event: MaterializedGitHubRoomEvent;
  payload: GitHubWebhookPayload;
  repositoryFullName: string;
}): boolean {
  if (input.event.roomEvent?.kind !== "pull_request") {
    return false;
  }

  const headRepository = getPullRequestHeadRepository(input.payload);
  return Boolean(
    !headRepository?.fullName ||
    headRepository.fullName.toLowerCase() !== input.repositoryFullName.toLowerCase()
  );
}

export interface GitHubEventRefRoomDeps {
  getGitChildRoom: typeof getGitChildRoom;
  upsertGitRoomBinding: typeof upsertGitRoomBinding;
}

const defaultGitHubEventRefRoomDeps: GitHubEventRefRoomDeps = {
  getGitChildRoom,
  upsertGitRoomBinding,
};

export async function getExistingGitHubEventRefRoom(input: {
  event: MaterializedGitHubRoomEvent;
  payload: GitHubWebhookPayload;
  repository: GitHubWebhookRepository | undefined;
  githubRepoId: string | null;
  deps?: Partial<GitHubEventRefRoomDeps>;
}): Promise<Project | null> {
  const deps = {
    ...defaultGitHubEventRefRoomDeps,
    ...input.deps,
  };
  const repository = input.repository;
  if (!repository?.full_name) {
    return null;
  }

  const target = selectGitHubEventRefRoomTarget({
    event: input.event,
    defaultBranch: repository.default_branch,
  });
  if (!target) {
    return null;
  }

  if (isCrossRepositoryPullRequestEvent({
    event: input.event,
    payload: input.payload,
    repositoryFullName: repository.full_name,
  })) {
    return null;
  }

  const { owner, name } = splitRepositoryFullName(repository.full_name);
  if (!owner || !name) {
    return null;
  }

  const parentRoomId = buildGitHubRepoRoomId(repository.full_name);
  const focusKey = buildGitHubRefFocusKey(target);
  const room = await deps.getGitChildRoom({
    parentRoomId,
    focusKey,
  });

  if (!room) {
    return null;
  }

  if (!shouldCreateGitHubRefRoomForEvent(input.event)) {
    return !room.focus_archived_at ||
      shouldResolveArchivedGitRefRoomForEvent(input.event)
      ? room
      : null;
  }

  const headRepository = getPullRequestHeadRepository(input.payload);

  await deps.upsertGitRoomBinding({
    room_id: room.id,
    provider: "github",
    host: "github.com",
    repository_id: input.githubRepoId,
    repository_full_name: repository.full_name,
    repository_owner: owner,
    repository_name: name,
    ref_type: target.refType,
    ref_name: target.refName,
    default_branch: repository.default_branch ?? null,
    base_ref: repository.default_branch ?? null,
    head_ref: target.refType === "branch" ? target.refName : null,
    head_repository_id: headRepository?.id ?? null,
    head_repository_full_name: headRepository?.fullName ?? null,
    head_repository_owner: headRepository?.owner ?? null,
    head_repository_name: headRepository?.name ?? null,
    visibility: normalizeGitRoomVisibility(
      typeof repository.private === "boolean"
        ? repository.private ? "private" : "public"
        : undefined
    ),
    is_default: false,
    source: "webhook",
  });

  return room;
}
