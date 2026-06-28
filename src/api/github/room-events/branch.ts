import type { GitHubWebhookPayload } from "../app.js";
import {
  branchNameFromGitRef,
  buildDeliveryScopedKey,
  buildTimedSemanticKey,
  isZeroSha,
  normalizeGitHubTimestamp,
  normalizeGitRef,
} from "./helpers.js";
import type {
  GitHubRepoEventBase,
  MaterializedGitHubRoomEvent,
} from "./types.js";

function getRefTypeForPushRef(ref: string | null): string {
  if (ref?.startsWith("refs/heads/")) {
    return "branch";
  }
  if (ref?.startsWith("refs/tags/")) {
    return "tag";
  }
  return "ref";
}

function shortRefName(ref: string | null, refType: string): string | null {
  if (!ref) {
    return null;
  }
  if (refType === "branch") {
    return branchNameFromGitRef(ref);
  }
  if (refType === "tag" && ref.startsWith("refs/tags/")) {
    return ref.slice("refs/tags/".length);
  }
  return ref;
}

function branchOrTagUrl(
  repositoryUrl: string | null | undefined,
  refType: string,
  ref: string
): string | null {
  if (!repositoryUrl || (refType !== "branch" && refType !== "tag")) {
    return null;
  }

  const path = refType === "branch" ? "tree" : "releases/tag";
  return `${repositoryUrl.replace(/\/+$/, "")}/${path}/${encodeURIComponent(ref)}`;
}

function latestCommitTimestamp(payload: GitHubWebhookPayload): string | null {
  const timestamps = [
    payload.head_commit?.timestamp,
    ...(payload.commits ?? []).map((commit) => commit.timestamp),
  ]
    .map(normalizeGitHubTimestamp)
    .filter((value): value is string => Boolean(value));

  return timestamps.sort().at(-1) ?? null;
}

export function materializePushEvent(
  payload: GitHubWebhookPayload,
  action: string,
  deliveryId: string,
  actorLogin: string | null,
  repoIdentity: string,
  base: GitHubRepoEventBase,
): MaterializedGitHubRoomEvent | null {
  if (action !== "push" || !payload.repository) {
    return null;
  }

  const ref = normalizeGitRef(payload.ref);
  if (!ref) {
    return null;
  }

  const refType = getRefTypeForPushRef(ref);
  const displayRef = shortRefName(ref, refType);
  if (!displayRef) {
    return null;
  }

  const beforeSha = normalizeGitRef(payload.before);
  const afterSha = normalizeGitRef(payload.after);
  const headSha = afterSha && !isZeroSha(afterSha) ? afterSha : null;
  const semanticId = `${repoIdentity}:push:${ref}:${beforeSha ?? ""}:${afterSha ?? ""}`;
  const providerEventAt = latestCommitTimestamp(payload);

  return {
    event_type: "push",
    action,
    idempotency_key: buildDeliveryScopedKey(semanticId, deliveryId),
    semantic_id: semanticId,
    github_object_id: ref,
    github_object_url: payload.compare ?? branchOrTagUrl(payload.repository.html_url, refType, displayRef),
    title: `${refType} ${displayRef}`,
    state: payload.deleted ? "deleted" : payload.created ? "created" : payload.forced ? "forced" : "pushed",
    actor_login: actorLogin ?? payload.head_commit?.author?.username ?? payload.pusher?.name ?? null,
    provider_event_at: providerEventAt,
    provider_object_updated_at: normalizeGitHubTimestamp(
      payload.repository.pushed_at ?? payload.repository.updated_at
    ),
    ref,
    base_ref: null,
    head_ref: refType === "branch" ? displayRef : null,
    head_sha: headSha,
    metadata: {
      ref_type: refType,
      before: beforeSha,
      after: afterSha,
      created: payload.created ?? false,
      deleted: payload.deleted ?? false,
      forced: payload.forced ?? false,
      compare: payload.compare ?? null,
      head_commit_id: payload.head_commit?.id ?? null,
      head_commit_message: payload.head_commit?.message ?? null,
      commit_count: payload.commits?.length ?? 0,
      pusher_name: payload.pusher?.name ?? null,
    },
    roomEvent: {
      ...base,
      action,
      kind: "push",
      senderLogin: actorLogin ?? payload.pusher?.name ?? null,
      push: {
        ref: displayRef,
        refType,
        beforeSha,
        afterSha: headSha,
        compareUrl: payload.compare ?? null,
        headCommitMessage: payload.head_commit?.message ?? null,
      },
    },
  };
}

export function materializeBranchLifecycleEvent(
  payload: GitHubWebhookPayload,
  action: string,
  deliveryId: string,
  actorLogin: string | null,
  repoIdentity: string,
  base: GitHubRepoEventBase,
): MaterializedGitHubRoomEvent | null {
  if ((action !== "create" && action !== "delete") || !payload.repository) {
    return null;
  }

  const ref = normalizeGitRef(payload.ref);
  if (!ref) {
    return null;
  }

  const refType = normalizeGitRef(payload.ref_type) ?? "ref";
  const repositoryUpdatedAt = normalizeGitHubTimestamp(payload.repository.updated_at);
  const semanticId = buildTimedSemanticKey(
    `${repoIdentity}:${action}:${refType}:${ref}`,
    repositoryUpdatedAt
  );
  const objectUrl = branchOrTagUrl(payload.repository.html_url, refType, ref);

  return {
    event_type: action,
    action,
    idempotency_key: buildDeliveryScopedKey(semanticId, deliveryId),
    semantic_id: semanticId,
    github_object_id: `${refType}:${ref}`,
    github_object_url: objectUrl,
    title: `${refType} ${ref}`,
    state: action === "create" ? "created" : "deleted",
    actor_login: actorLogin,
    provider_event_at: null,
    provider_object_updated_at: null,
    ref,
    base_ref: payload.repository.default_branch ?? payload.master_branch ?? null,
    head_ref: refType === "branch" ? ref : null,
    head_sha: null,
    metadata: {
      ref_type: refType,
      repository_updated_at: repositoryUpdatedAt,
      master_branch: payload.master_branch ?? payload.repository.default_branch ?? null,
      description: payload.description ?? null,
      pusher_type: payload.pusher_type ?? null,
    },
    roomEvent: {
      ...base,
      action,
      kind: "branch_ref",
      branch: {
        ref,
        refType,
        defaultBranch: payload.master_branch ?? payload.repository.default_branch ?? null,
      },
    },
  };
}
