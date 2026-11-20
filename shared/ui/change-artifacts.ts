/**
 * Helpers for the room's shared work artifacts (change summaries and pull
 * requests), used by the web activity panel and the desktop activity tab. Each
 * app maps its own artifact shape (snake_case API, camelCase IPC) into
 * ChangeArtifactRef.
 */

/** The artifact fields these helpers read. */
export interface ChangeArtifactRef {
  /** The artifact's identity key. */
  id: string;
  kind: string;
  ref?: string | null;
  url?: string | null;
  /** The PR or issue number. */
  number: number | null;
  state?: string | null;
  /** Files in a change summary's detail; 0 for other kinds. */
  fileCount: number;
}

export const CHANGE_SUMMARY_FILE_COLLAPSED_LIMIT = 3;

// One-line "N files  +A  −D" headline for a change-summary artifact.
export function changeSummaryHeadline(detail: {
  changedFileCount: number;
  additions?: number | null;
  deletions?: number | null;
}): string {
  const parts = [`${detail.changedFileCount} ${detail.changedFileCount === 1 ? "file" : "files"}`];
  if (detail.additions) parts.push(`+${detail.additions}`);
  if (detail.deletions) parts.push(`−${detail.deletions}`);
  return parts.join("  ");
}

// Split a change-summary file list into the visible slice and the count hidden by
// the collapsed view (distinct from detail.hiddenFileCount, which is the count the
// backend truncated beyond the persisted ceiling).
export function splitChangeSummaryFiles<F>(
  files: readonly F[],
  expanded: boolean,
  limit: number = CHANGE_SUMMARY_FILE_COLLAPSED_LIMIT,
): { visible: F[]; hiddenCount: number } {
  if (expanded) return { visible: [...files], hiddenCount: 0 };
  return { visible: files.slice(0, limit), hiddenCount: Math.max(0, files.length - limit) };
}

// Keep only expanded identities that still have a collapsible list (present
// change_summary detail with more files than the collapsed limit). Used to prune
// stale expansion state as artifacts update (e.g. dirty -> clean -> dirty), so a
// row never silently reopens expanded.
export function retainExpandableChangeArtifacts(
  expanded: ReadonlySet<string>,
  artifacts: readonly ChangeArtifactRef[],
  limit: number = CHANGE_SUMMARY_FILE_COLLAPSED_LIMIT,
): Set<string> {
  const next = new Set<string>();
  for (const artifact of artifacts) {
    if (expanded.has(artifact.id) && artifact.kind === "change_summary" && artifact.fileCount > limit) {
      next.add(artifact.id);
    }
  }
  return next;
}

export interface LinkedPullRequest {
  number: number;
  url: string;
  state: string | null;
}

export interface PullRequestRepoScope {
  host: string;
  owner: string;
  name: string;
}

// Structurally verify a PR URL against the room repo and its number — not a substring
// match (which a deceptive host like https://evil.example/owner/repo/pull/1 would pass,
// and which can't tie the URL to artifact_number). Requires http(s), exact host, exact
// owner/repo path segments, a `pull` segment, and `/pull/<number>` === the artifact
// number. Fails closed on parse errors.
function pullRequestUrlMatches(
  url: string,
  scope: PullRequestRepoScope,
  number: number,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.host.toLowerCase() !== scope.host.toLowerCase()) return false;
  const segments = parsed.pathname.split("/").filter(Boolean);
  return (
    segments.length >= 4 &&
    segments[0].toLowerCase() === scope.owner.toLowerCase() &&
    segments[1].toLowerCase() === scope.name.toLowerCase() &&
    segments[2] === "pull" &&
    segments[3] === String(number)
  );
}

// Find the pull_request artifact associated with a change_summary by shared branch
// (ref). Branch names aren't globally unique, so matching is scoped to the room's
// known repository: a candidate must be a same-branch PR with a usable number and a
// URL that structurally verifies against the repo scope (see above). Selection fails
// closed on ambiguity — a unique open PR, or (when none are open) a single lone
// candidate; multiple open, or multiple closed with none open, link nothing. Returns
// null when the repo scope is unknown or nothing verifies.
export function findLinkedPullRequest(
  artifact: ChangeArtifactRef,
  artifacts: readonly ChangeArtifactRef[],
  scope: PullRequestRepoScope | null,
): LinkedPullRequest | null {
  if (artifact.kind !== "change_summary") return null;
  const ref = artifact.ref?.trim();
  if (!ref || !scope?.host || !scope.owner || !scope.name) return null;
  const candidates = artifacts.filter(
    (c): c is ChangeArtifactRef & { url: string; number: number } =>
      c.kind === "pull_request" &&
      c.ref?.trim() === ref &&
      c.number !== null &&
      typeof c.url === "string" &&
      pullRequestUrlMatches(c.url, scope, c.number),
  );
  if (!candidates.length) return null;
  const open = candidates.filter((c) => (c.state ?? "").toLowerCase() === "open");
  // Fail closed on ambiguity: a PR URL identifies the base repo, so forks / differing
  // base branches can share a head ref. Link only a unique open PR, or — when none are
  // open — a single lone candidate. Multiple open (or multiple closed) → no link.
  const chosen =
    open.length === 1
      ? open[0]
      : open.length === 0 && candidates.length === 1
        ? candidates[0]
        : null;
  if (!chosen) return null;
  return { number: chosen.number, url: chosen.url, state: chosen.state ?? null };
}
