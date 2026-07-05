import type { DesktopRoomSharedArtifact } from "../../../electron/ipc-types";

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
