import type {
  DesktopRoomSharedArtifact,
  DesktopRoomSharedArtifactChangedFile,
  DesktopRoomSharedArtifactChangeSummaryDetail,
} from "../../../electron/ipc-types";

export const CHANGE_SUMMARY_FILE_COLLAPSED_LIMIT = 3;

// One-line "N files  +A  −D" headline for a change-summary artifact.
export function changeSummaryHeadline(
  detail: DesktopRoomSharedArtifactChangeSummaryDetail,
): string {
  const parts = [`${detail.changedFileCount} ${detail.changedFileCount === 1 ? "file" : "files"}`];
  if (detail.additions) parts.push(`+${detail.additions}`);
  if (detail.deletions) parts.push(`−${detail.deletions}`);
  return parts.join("  ");
}

// Split a change-summary file list into the visible slice and the count hidden by
// the collapsed view (distinct from detail.hiddenFileCount, which is the count the
// backend truncated beyond the persisted ceiling).
export function splitChangeSummaryFiles(
  files: readonly DesktopRoomSharedArtifactChangedFile[],
  expanded: boolean,
  limit: number = CHANGE_SUMMARY_FILE_COLLAPSED_LIMIT,
): { visible: DesktopRoomSharedArtifactChangedFile[]; hiddenCount: number } {
  if (expanded) return { visible: [...files], hiddenCount: 0 };
  return { visible: files.slice(0, limit), hiddenCount: Math.max(0, files.length - limit) };
}

// Keep only expanded identities that still have a collapsible list (present
// change_summary detail with more files than the collapsed limit). Used to prune
// stale expansion state as artifacts update (e.g. dirty -> clean -> dirty), so a
// row never silently reopens expanded.
export function retainExpandableChangeArtifacts(
  expanded: ReadonlySet<string>,
  artifacts: readonly DesktopRoomSharedArtifact[],
  limit: number = CHANGE_SUMMARY_FILE_COLLAPSED_LIMIT,
): Set<string> {
  const next = new Set<string>();
  for (const artifact of artifacts) {
    if (
      expanded.has(artifact.identityKey) &&
      artifact.kind === "change_summary" &&
      (artifact.detail?.files.length ?? 0) > limit
    ) {
      next.add(artifact.identityKey);
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
  artifact: DesktopRoomSharedArtifact,
  artifacts: readonly DesktopRoomSharedArtifact[],
  scope: PullRequestRepoScope | null,
): LinkedPullRequest | null {
  if (artifact.kind !== "change_summary") return null;
  const ref = artifact.ref?.trim();
  if (!ref || !scope?.host || !scope.owner || !scope.name) return null;
  const candidates = artifacts.filter(
    (c): c is DesktopRoomSharedArtifact & { url: string; artifactNumber: number } =>
      c.kind === "pull_request" &&
      c.ref?.trim() === ref &&
      c.artifactNumber !== null &&
      typeof c.url === "string" &&
      pullRequestUrlMatches(c.url, scope, c.artifactNumber),
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
  return { number: chosen.artifactNumber, url: chosen.url, state: chosen.state };
}

export interface RoomArtifactTimelineItem {
  artifact: DesktopRoomSharedArtifact;
  title: string;
  kindLabel: string;
  metaLabel: string;
  taskCountLabel: string | null;
  firstSeenAt: string | null;
  updatedAt: string | null;
  occurredAt: string | null;
  wasUpdated: boolean;
}

export interface RoomArtifactTimelineOptions {
  taskId?: string | null;
}

export function roomArtifactTimelineItems(
  artifacts: readonly DesktopRoomSharedArtifact[],
  options: RoomArtifactTimelineOptions = {},
): RoomArtifactTimelineItem[] {
  const taskId = options.taskId?.trim() || null;
  return [...artifacts]
    .filter((artifact) =>
      taskId ? artifact.linkedTaskIds.includes(taskId) : true
    )
    .sort(compareRoomArtifacts)
    .map((artifact) => {
      const firstSeenAt = timestampOrNull(artifact.firstSeenAt);
      const updatedAt = timestampOrNull(artifact.updatedAt);
      const artifactNumberLabel = artifact.artifactNumber !== null ? `#${artifact.artifactNumber}` : null;
      const artifactIdLabel = artifact.artifactId?.trim() || null;
      const stateLabel = artifact.state?.trim() || null;
      const refLabel = artifact.ref?.trim() ? `ref ${artifact.ref.trim()}` : null;
      const sourceLabel = artifactSourceLabel(artifact.source, artifact.provider);
      return {
        artifact,
        title: artifactTitle(artifact),
        kindLabel: artifactKindLabel(artifact.kind),
        metaLabel: [sourceLabel, stateLabel, refLabel, artifactNumberLabel, artifactIdLabel]
          .filter(Boolean)
          .join(" · "),
        taskCountLabel: taskCountLabel(artifact.linkedTaskIds.length),
        firstSeenAt,
        updatedAt,
        occurredAt: updatedAt || firstSeenAt,
        wasUpdated: Boolean(firstSeenAt && updatedAt && firstSeenAt !== updatedAt),
      };
    });
}

function artifactKindLabel(kind: DesktopRoomSharedArtifact["kind"]): string {
  switch (kind) {
    case "pull_request":
      return "Pull request";
    case "merge_request":
      return "Merge request";
    case "check_run":
      return "Check";
    case "change_summary":
      return "Change summary";
    default:
      return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, " ");
  }
}

function artifactTitle(artifact: DesktopRoomSharedArtifact): string {
  if (artifact.title?.trim()) return artifact.title.trim();
  if (artifact.ref?.trim()) return artifact.ref.trim();
  if (artifact.artifactNumber !== null) return `${artifactKindLabel(artifact.kind)} #${artifact.artifactNumber}`;
  if (artifact.artifactId?.trim()) return artifact.artifactId.trim();
  return artifactKindLabel(artifact.kind);
}

function artifactSourceLabel(
  source: DesktopRoomSharedArtifact["source"],
  provider: DesktopRoomSharedArtifact["provider"],
): string {
  if (source === "github_event") return "GitHub event";
  if (source === "task_workflow_artifact") return "Task workflow";
  if (provider === "git") return "Manual Git artifact";
  return "Manual artifact";
}

function compareRoomArtifacts(
  left: DesktopRoomSharedArtifact,
  right: DesktopRoomSharedArtifact,
): number {
  const leftTime = timestampValue(left.updatedAt || left.firstSeenAt);
  const rightTime = timestampValue(right.updatedAt || right.firstSeenAt);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return left.identityKey.localeCompare(right.identityKey);
}

function timestampValue(value: string | null | undefined): number {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : -1;
}

function timestampOrNull(value: string | null | undefined): string | null {
  return timestampValue(value) >= 0 ? value || null : null;
}

function taskCountLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 linked task" : `${count} linked tasks`;
}
