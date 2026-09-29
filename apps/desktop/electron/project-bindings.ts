import type {
  DesktopProjectBinding,
  DesktopProjectBindingContext,
  DesktopProjectBindingSource,
} from "./ipc-types.js";

function normalize(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

/**
 * Collapse navigation-scoped room identifiers to the project that owns them.
 * Hosted focus/branch rooms and local Git branch rooms share one folder.
 */
export function canonicalProjectRoomIdentifier(
  value: string | null | undefined,
): string | null {
  const normalized = normalize(value);
  if (!normalized) return null;
  const legacyLocalGit = normalized.match(/^local\/([a-f0-9]{16})$/)?.[1];
  if (legacyLocalGit) return `git-room:local:${legacyLocalGit}`;
  const focusParent = normalized.match(/^(.+)\/focus\/[^/]+$/)?.[1];
  if (focusParent) return focusParent;
  const localGit = normalized.match(
    /^(git-room:local:[a-f0-9]+)(?::(?:branch|ref|tag):[^:]+|:repo)?$/,
  )?.[1];
  return localGit || normalized;
}

/** Stable aliases that let every view of a project resolve one local binding. */
export function projectBindingAliases(
  context: DesktopProjectBindingContext | null | undefined,
): string[] {
  const aliases = new Set<string>();
  const exactRoom = normalize(context?.roomIdentifier);
  const projectRoom = canonicalProjectRoomIdentifier(context?.roomIdentifier);
  if (exactRoom) aliases.add(`room:${exactRoom}`);
  if (projectRoom) aliases.add(`project-room:${projectRoom}`);

  const gitRoom = context?.gitRoom;
  if (gitRoom) {
    const host = normalize(gitRoom.host);
    const repositoryId = normalize(gitRoom.repository.id);
    const fullName = normalize(gitRoom.repository.fullName);
    if (host && repositoryId) aliases.add(`repository-id:${host}:${repositoryId}`);
    if (host && fullName) aliases.add(`repository:${host}:${fullName}`);
    const hostedRoom = canonicalProjectRoomIdentifier(
      host && fullName ? `${host}/${fullName}` : null,
    );
    if (hostedRoom) aliases.add(`project-room:${hostedRoom}`);
  }
  return [...aliases].sort();
}

/**
 * The key that owns a binding. Hosted repository IDs win over mutable names;
 * local projects fall back to their canonical project-room identity.
 */
export function projectBindingIdentityKey(
  context: DesktopProjectBindingContext | null | undefined,
): string | null {
  const host = normalize(context?.gitRoom?.host);
  const repositoryId = normalize(context?.gitRoom?.repository.id);
  if (host && repositoryId) return `repository-id:${host}:${repositoryId}`;
  const projectRoom = canonicalProjectRoomIdentifier(context?.roomIdentifier);
  return projectRoom ? `project-room:${projectRoom}` : null;
}

/** Filesystem-observable keys used to prove that a stored path still belongs. */
export function projectBindingVerificationKeys(
  context: DesktopProjectBindingContext | null | undefined,
): string[] {
  return projectBindingAliases(context).filter(
    (alias) => alias.startsWith("project-room:") || alias.startsWith("repository-id:local:"),
  );
}

export function findProjectBinding(
  bindings: readonly DesktopProjectBinding[],
  context: DesktopProjectBindingContext | null | undefined,
): DesktopProjectBinding | null {
  const identityKey = projectBindingIdentityKey(context);
  if (identityKey) {
    const exact = bindings.find((binding) => binding.identityKey === identityKey);
    if (exact) return exact;
    // A stable hosted repository identity must never fall back to a mutable
    // name-only legacy binding. A rename/reuse requires explicit reconnect.
    if (identityKey.startsWith("repository-id:") && !identityKey.startsWith("repository-id:local:")) {
      return null;
    }
  }
  const aliases = new Set(projectBindingAliases(context));
  if (!aliases.size) return null;
  return bindings
    .filter((binding) => (
      !binding.identityKey.startsWith("repository-id:")
      && binding.aliases.some((alias) => aliases.has(alias))
    ))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] || null;
}

/**
 * Explicit reconnect is the recovery authority for local-only projects whose
 * generated identity cannot be independently verified after a folder move.
 * Hosted repositories remain strict: their remote identity must match.
 */
export function projectContextsCompatibleForConnection(
  current: DesktopProjectBindingContext,
  selected: DesktopProjectBindingContext,
  selectedSource: DesktopProjectBindingSource,
): boolean {
  const selectedAliases = new Set(projectBindingAliases(selected));
  const overlaps = projectBindingVerificationKeys(current).some(
    (alias) => selectedAliases.has(alias),
  );
  const currentHost = normalize(current.gitRoom?.host);
  if (currentHost && currentHost !== "local") {
    return selectedSource === "git_remote" && overlaps;
  }
  if (selectedSource === "git_remote" && overlaps) return true;
  if (
    currentHost === "local"
    && normalize(selected.gitRoom?.host) === "local"
    && selectedSource === "local_git"
  ) return true;
  return !current.gitRoom
    && /^local-[a-z0-9-]+-[a-f0-9]{10}$/.test(normalize(current.roomIdentifier))
    && selectedSource === "local_folder";
}
