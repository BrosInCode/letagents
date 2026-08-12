import type {
  DesktopGitHubRoomEvent,
  DesktopRoomInfo,
} from "../../../../../../electron/ipc-types";
import { repoEnvironmentRoomRefLabel } from "../../../../domain/repo-environment";
import type { GitHubEventPresentation } from "../desktop-chat-message/types";
import type { ComposerEventPreview } from "./RoomComposerEventChips.vue";

export function buildComposerEventPreview(
  messageId: string,
  event: GitHubEventPresentation,
  room: DesktopRoomInfo,
  events: readonly DesktopGitHubRoomEvent[] = [],
): ComposerEventPreview {
  const metadataEvent = previewMetadataEvent(event, events);
  return {
    id: messageId,
    kind: event.kind,
    tone: event.tone,
    kindLabel: event.kindLabel,
    statusLabel: event.statusLabel,
    headline: event.headline,
    repositoryLabel: previewRepositoryLabel(event, metadataEvent, room),
    refLabel: previewRefLabel(metadataEvent, room),
    numberLabel: previewNumberLabel(event, metadataEvent),
    stats: previewStats(metadataEvent),
    actionLabel: previewActionLabel(event),
    url: event.url,
  };
}

function previewMetadataEvent(
  event: GitHubEventPresentation,
  events: readonly DesktopGitHubRoomEvent[],
): DesktopGitHubRoomEvent | null {
  if (event.url) {
    const urlMatch = findEventByUrl(events, event.url);
    if (urlMatch) return urlMatch;
  }
  const number = previewNumber(event, null);
  if (!number) return null;
  return events.find((candidate) =>
    candidate.githubObjectId === number &&
    candidate.eventType === previewEventType(event.kind)
  ) || null;
}

function previewEventType(kind: GitHubEventPresentation["kind"]): DesktopGitHubRoomEvent["eventType"] {
  if (kind === "pull-request") return "pull_request";
  if (kind === "review") return "pull_request_review";
  if (kind === "comment") return "issue_comment";
  if (kind === "issue") return "issue";
  if (kind === "check") return "check_run";
  return "repository";
}

function previewRepositoryLabel(
  event: GitHubEventPresentation,
  metadataEvent: DesktopGitHubRoomEvent | null,
  room: DesktopRoomInfo,
): string | null {
  const fullName = event.repository ||
    metadataString(metadataEvent?.metadata, ["repository", "full_name"]) ||
    room.gitRoom?.repository.fullName ||
    repoRepositoryFromRoomIdentifier(room.identifier);
  if (!fullName) return null;
  return fullName.split("/").filter(Boolean).at(-1) || fullName;
}

function previewNumberLabel(
  event: GitHubEventPresentation,
  metadataEvent: DesktopGitHubRoomEvent | null,
): string | null {
  const number = previewNumber(event, metadataEvent);
  if (!number) return null;
  if (["pull-request", "review", "issue", "comment"].includes(event.kind)) return `#${number}`;
  return null;
}

function previewNumber(
  event: GitHubEventPresentation,
  metadataEvent: DesktopGitHubRoomEvent | null,
): string | null {
  return metadataEvent?.githubObjectId ||
    metadataNumber(metadataEvent?.metadata, ["number"]) ||
    metadataNumber(metadataEvent?.metadata, ["pull_request", "number"]) ||
    metadataNumber(metadataEvent?.metadata, ["issue", "number"]) ||
    event.headline.match(/#(\d+)/)?.[1] ||
    null;
}

function previewRefLabel(metadataEvent: DesktopGitHubRoomEvent | null, room: DesktopRoomInfo): string | null {
  return metadataString(metadataEvent?.metadata, ["head_branch"]) ||
    metadataString(metadataEvent?.metadata, ["head_ref"]) ||
    metadataString(metadataEvent?.metadata, ["branch"]) ||
    metadataString(metadataEvent?.metadata, ["ref"]) ||
    metadataString(metadataEvent?.metadata, ["pull_request", "head_ref"]) ||
    metadataString(metadataEvent?.metadata, ["pull_request", "head", "ref"]) ||
    repoEnvironmentRoomRefLabel(room);
}

function previewStats(metadataEvent: DesktopGitHubRoomEvent | null): ComposerEventPreview["stats"] {
  const additions = metadataNumeric(metadataEvent?.metadata, ["additions"]) ??
    metadataNumeric(metadataEvent?.metadata, ["pull_request", "additions"]);
  const deletions = metadataNumeric(metadataEvent?.metadata, ["deletions"]) ??
    metadataNumeric(metadataEvent?.metadata, ["pull_request", "deletions"]);
  if (additions === null && deletions === null) return null;
  return {
    additions: (additions ?? 0).toLocaleString(),
    deletions: (deletions ?? 0).toLocaleString(),
  };
}

function previewActionLabel(event: GitHubEventPresentation): string | null {
  if (event.kind === "pull-request") return event.statusLabel || "Open";
  if (event.kind === "check") return event.statusLabel || "Check";
  if (event.kind === "review") return event.statusLabel || "Review";
  return event.statusLabel || null;
}

function findEventByUrl(
  events: readonly DesktopGitHubRoomEvent[],
  url: string,
): DesktopGitHubRoomEvent | null {
  const exactUrl = normalizeExactGitHubUrl(url);
  if (!exactUrl) return null;
  const exactMatch = events.find((event) =>
    normalizeExactGitHubUrl(event.githubObjectUrl) === exactUrl
  );
  if (exactMatch) return exactMatch;

  const normalizedUrl = normalizeGitHubObjectUrl(url);
  if (!normalizedUrl) return null;
  return events.find((event) =>
    normalizeGitHubObjectUrl(event.githubObjectUrl) === normalizedUrl
  ) || null;
}

function repoRepositoryFromRoomIdentifier(identifier: string): string | null {
  const match = /^github\.com\/([^/]+\/[^/]+)$/i.exec(identifier.trim());
  return match ? match[1] : null;
}

function normalizeExactGitHubUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/$/, "").toLowerCase();
}

function normalizeGitHubObjectUrl(url: string | null | undefined): string | null {
  const exact = normalizeExactGitHubUrl(url);
  if (!exact) return null;
  return exact.replace(/#.*$/, "").replace(/\?.*$/, "");
}

function metadataString(metadata: Record<string, unknown> | null | undefined, path: string[]): string | null {
  const value = metadataValue(metadata, path);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataNumber(metadata: Record<string, unknown> | null | undefined, path: string[]): string | null {
  const value = metadataValue(metadata, path);
  return typeof value === "number" || typeof value === "string" ? String(value) : null;
}

function metadataNumeric(metadata: Record<string, unknown> | null | undefined, path: string[]): number | null {
  const value = metadataNumber(metadata, path);
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function metadataValue(metadata: Record<string, unknown> | null | undefined, path: string[]): unknown {
  let value: unknown = metadata;
  for (const key of path) {
    if (!value || typeof value !== "object" || !(key in value)) return null;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
