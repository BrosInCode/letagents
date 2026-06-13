import type { DesktopGitHubRoomEvent } from "../../../../../../electron/ipc-types";

export type DesktopGitHubEventKind =
  | "pull-request"
  | "review"
  | "comment"
  | "check"
  | "issue"
  | "repository"
  | "installation"
  | "generic";

export type DesktopGitHubEventTone = "default" | "success" | "warning" | "danger" | "info";

export type DesktopGitHubEventFilter =
  | "actionable"
  | "failures"
  | "pulls"
  | "reviews"
  | "comments"
  | "checks"
  | "all";

export interface DesktopGitHubEventPresentation {
  id: string;
  kind: DesktopGitHubEventKind;
  tone: DesktopGitHubEventTone;
  title: string;
  subtitle: string | null;
  bodyText: string | null;
  actor: string | null;
  repository: string | null;
  objectLabel: string | null;
  stateLabel: string | null;
  linkedTaskId: string | null;
  url: string | null;
  createdAt: string;
  isActionable: boolean;
  isLowSignal: boolean;
  branchRef: string | null;
  commitSha: string | null;
  sourceLabel: string | null;
  metadata: Record<string, unknown>;
  rawEvent: DesktopGitHubRoomEvent;
}

export interface DesktopGitHubEventGroup {
  key: string;
  title: string;
  subtitle: string | null;
  repository: string | null;
  events: DesktopGitHubEventPresentation[];
  entries: DesktopGitHubEventGroupEntry[];
}

export interface DesktopGitHubEventGroupEntry {
  key: string;
  event: DesktopGitHubEventPresentation;
  events: DesktopGitHubEventPresentation[];
  hiddenCount: number;
}

export interface DesktopGitHubEventFilterOption {
  id: DesktopGitHubEventFilter;
  label: string;
  count: number;
}

export const desktopGitHubEventFilterOrder: DesktopGitHubEventFilter[] = [
  "actionable",
  "failures",
  "pulls",
  "reviews",
  "comments",
  "checks",
  "all",
];

const checkFailureStates = new Set(["failure", "timed_out", "cancelled", "action_required"]);
const checkSuccessStates = new Set(["success", "skipped"]);

export function presentDesktopGitHubEvent(
  event: DesktopGitHubRoomEvent,
  fallbackRepository: string | null = null,
): DesktopGitHubEventPresentation {
  const kind = eventKind(event);
  const repository = repositoryFromEvent(event, fallbackRepository);
  const branchRef = branchRefFromMetadata(event.metadata);
  const objectLabel = objectLabelForEvent(event, kind);
  const stateLabel = stateLabelForEvent(event, kind);
  const tone = toneForEvent(event, kind, stateLabel);
  const title = titleForEvent(event, kind, objectLabel, stateLabel);
  const subtitle = subtitleForEvent(event, repository);
  const commitSha = commitShaFromMetadata(event.metadata);
  return {
    id: event.id,
    kind,
    tone,
    title,
    subtitle,
    bodyText: bodyTextFromMetadata(event.metadata),
    actor: event.actorLogin,
    repository,
    objectLabel,
    stateLabel,
    linkedTaskId: event.linkedTaskId,
    url: event.githubObjectUrl,
    createdAt: event.createdAt,
    isActionable: isActionableEvent(event, kind, tone),
    isLowSignal: isLowSignalEvent(event, kind, stateLabel),
    branchRef,
    commitSha,
    sourceLabel: sourceLabelFromMetadata(event.metadata, kind),
    metadata: event.metadata,
    rawEvent: event,
  };
}

export function buildDesktopGitHubEventFilterOptions(
  presentations: readonly DesktopGitHubEventPresentation[],
): DesktopGitHubEventFilterOption[] {
  return desktopGitHubEventFilterOrder.map((filter) => ({
    id: filter,
    label: labelForFilter(filter),
    count: filter === "all"
      ? presentations.length
      : presentations.filter((event) => presentationMatchesFilter(event, filter)).length,
  }));
}

export function coalesceDesktopGitHubEventPresentations(
  presentations: readonly DesktopGitHubEventPresentation[],
): DesktopGitHubEventPresentation[] {
  const eventsByKey = new Map<string, DesktopGitHubEventPresentation>();
  for (const event of presentations) {
    const key = duplicateKeyForEvent(event);
    const existing = eventsByKey.get(key);
    if (!existing || comparePresentedEvents(event, existing, null) < 0) {
      eventsByKey.set(key, event);
    }
  }
  return [...eventsByKey.values()].sort((left, right) => comparePresentedEvents(left, right, null));
}

export function filterDesktopGitHubEventPresentations(
  presentations: readonly DesktopGitHubEventPresentation[],
  options: {
    filter: DesktopGitHubEventFilter;
    searchQuery?: string;
    currentBranch?: string | null;
    linkedTaskId?: string | null;
  },
): DesktopGitHubEventPresentation[] {
  const query = (options.searchQuery || "").trim().toLowerCase();
  return presentations
    .filter((event) => {
      if (!presentationMatchesFilter(event, options.filter)) return false;
      if (options.linkedTaskId && event.linkedTaskId !== options.linkedTaskId) return false;
      if (!query) return true;
      return eventSearchText(event).includes(query);
    })
    .sort((left, right) => comparePresentedEvents(left, right, options.currentBranch || null));
}

export function groupDesktopGitHubEvents(
  presentations: readonly DesktopGitHubEventPresentation[],
): DesktopGitHubEventGroup[] {
  const groups = new Map<string, DesktopGitHubEventGroup>();
  for (const event of presentations) {
    const key = groupKeyForEvent(event);
    const existing = groups.get(key);
    if (existing) {
      existing.events.push(event);
      continue;
    }
    groups.set(key, {
      key,
      title: event.objectLabel || event.title,
      subtitle: event.repository,
      repository: event.repository,
      events: [event],
      entries: [],
    });
  }
  return [...groups.values()].map((group) => {
    const events = [...group.events].sort((left, right) => comparePresentedEvents(left, right, null));
    return {
      ...group,
      events,
      entries: rollupGroupEvents(events),
    };
  });
}

export function isCurrentBranchEvent(
  event: DesktopGitHubEventPresentation,
  currentBranch: string | null | undefined,
): boolean {
  return branchesMatch(event.branchRef, currentBranch);
}

export function labelForFilter(filter: DesktopGitHubEventFilter): string {
  if (filter === "actionable") return "Actionable";
  if (filter === "failures") return "Failures";
  if (filter === "pulls") return "PRs";
  if (filter === "reviews") return "Reviews";
  if (filter === "comments") return "Comments";
  if (filter === "checks") return "Checks";
  return "All";
}

export function branchesMatch(
  branchRef: string | null | undefined,
  currentBranch: string | null | undefined,
): boolean {
  const eventBranch = normalizeBranch(branchRef);
  const localBranch = normalizeBranch(currentBranch);
  if (!eventBranch || !localBranch) return false;
  return eventBranch === localBranch || eventBranch.endsWith(`:${localBranch}`);
}

function eventKind(event: DesktopGitHubRoomEvent): DesktopGitHubEventKind {
  if (event.eventType === "pull_request") return "pull-request";
  if (event.eventType === "pull_request_review") return "review";
  if (event.eventType === "issue_comment") return "comment";
  if (event.eventType === "check_run") return "check";
  if (event.eventType === "issue") return "issue";
  if (event.eventType === "repository") return "repository";
  if (event.eventType === "installation" || event.eventType === "installation_repositories") return "installation";
  return "generic";
}

function repositoryFromEvent(
  event: DesktopGitHubRoomEvent,
  fallbackRepository: string | null,
): string | null {
  return stringFromMetadata(event.metadata, [
    ["repository", "full_name"],
    ["repository_full_name"],
    ["repo"],
    ["full_name"],
  ]) || fallbackRepository;
}

function branchRefFromMetadata(metadata: Record<string, unknown>): string | null {
  return stringFromMetadata(metadata, [
    ["head_branch"],
    ["head_ref"],
    ["branch"],
    ["ref"],
    ["pull_request", "head_ref"],
    ["pull_request", "head", "ref"],
    ["pull_request", "head", "label"],
    ["check_run", "check_suite", "head_branch"],
    ["check_suite", "head_branch"],
  ]);
}

function commitShaFromMetadata(metadata: Record<string, unknown>): string | null {
  return stringFromMetadata(metadata, [
    ["head_sha"],
    ["commit_sha"],
    ["sha"],
    ["pull_request", "head", "sha"],
    ["check_run", "head_sha"],
    ["check_run", "check_suite", "head_sha"],
    ["check_suite", "head_sha"],
  ]);
}

function sourceLabelFromMetadata(
  metadata: Record<string, unknown>,
  kind: DesktopGitHubEventKind,
): string | null {
  if (kind === "check") {
    return stringFromMetadata(metadata, [["app_name"], ["app", "name"]]);
  }
  return stringFromMetadata(metadata, [
    ["author_login"],
    ["pull_request_author_login"],
    ["merged_by_login"],
    ["dismissed_by_login"],
  ]);
}

function bodyTextFromMetadata(metadata: Record<string, unknown>): string | null {
  const body = stringFromMetadata(metadata, [
    ["body"],
    ["comment", "body"],
    ["review", "body"],
    ["pull_request", "body"],
  ]);
  if (!body) return null;
  const normalized = body
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return null;
  return normalized.length > 700 ? `${normalized.slice(0, 697).trimEnd()}...` : normalized;
}

function objectLabelForEvent(
  event: DesktopGitHubRoomEvent,
  kind: DesktopGitHubEventKind,
): string | null {
  const number = event.githubObjectId || stringFromMetadata(event.metadata, [
    ["number"],
    ["pull_request", "number"],
    ["issue", "number"],
  ]);
  if (kind === "pull-request" || (kind === "comment" && metadataBoolean(event.metadata, ["is_pull_request"]))) {
    return number ? `PR #${number}` : "Pull request";
  }
  if (kind === "review") return number ? `PR #${number}` : "Review";
  if (kind === "issue" || kind === "comment") return number ? `Issue #${number}` : "Issue";
  if (kind === "check") return "Check run";
  if (kind === "repository") return "Repository";
  if (kind === "installation") return "Installation";
  return null;
}

function stateLabelForEvent(
  event: DesktopGitHubRoomEvent,
  kind: DesktopGitHubEventKind,
): string | null {
  if (kind === "check") {
    return humanize(
      event.state
      || stringFromMetadata(event.metadata, [["conclusion"], ["status"]])
      || event.action,
    );
  }
  if (kind === "review") {
    return humanize(event.state || event.action);
  }
  return humanize(event.state || event.action);
}

function toneForEvent(
  event: DesktopGitHubRoomEvent,
  kind: DesktopGitHubEventKind,
  stateLabel: string | null,
): DesktopGitHubEventTone {
  const normalized = normalizeState(stateLabel || event.action);
  if (kind === "check") {
    if (checkFailureStates.has(normalized)) return "danger";
    if (normalized === "success") return "success";
    if (normalized === "neutral" || normalized === "queued" || normalized === "in_progress") return "warning";
    return "info";
  }
  if (kind === "review") {
    if (normalized.includes("changes_requested") || normalized.includes("requested_changes")) return "danger";
    if (normalized.includes("approved")) return "success";
    return "info";
  }
  if (kind === "pull-request") {
    if (normalized === "merged") return "success";
    if (normalized === "closed") return "default";
    if (normalized === "draft" || normalized.includes("draft")) return "warning";
    return "info";
  }
  if (kind === "issue") {
    if (normalized === "closed") return "default";
    return "warning";
  }
  if (kind === "comment") return "info";
  return "default";
}

function titleForEvent(
  event: DesktopGitHubRoomEvent,
  kind: DesktopGitHubEventKind,
  objectLabel: string | null,
  stateLabel: string | null,
): string {
  const rawTitle = event.title?.trim();
  if (rawTitle) return rawTitle;
  if (objectLabel && stateLabel) return `${objectLabel} ${stateLabel}`;
  if (objectLabel) return objectLabel;
  if (kind === "generic") return "GitHub event";
  return `${humanize(kind)} event`;
}

function subtitleForEvent(
  event: DesktopGitHubRoomEvent,
  repository: string | null,
): string | null {
  const parts = [
    event.actorLogin ? `by ${event.actorLogin}` : null,
    repository,
    event.linkedTaskId,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function isActionableEvent(
  event: DesktopGitHubRoomEvent,
  kind: DesktopGitHubEventKind,
  tone: DesktopGitHubEventTone,
): boolean {
  if (tone === "danger" || tone === "warning") return true;
  if (kind === "review" || kind === "comment") return true;
  if (kind === "pull-request") {
    const action = normalizeState(event.action);
    return ["opened", "reopened", "ready_for_review", "synchronize", "updated", "review_requested"].includes(action);
  }
  return false;
}

function isLowSignalEvent(
  event: DesktopGitHubRoomEvent,
  kind: DesktopGitHubEventKind,
  stateLabel: string | null,
): boolean {
  if (kind !== "check") return false;
  const normalized = normalizeState(
    stateLabel || event.state || stringFromMetadata(event.metadata, [["conclusion"], ["status"]]) || event.action,
  );
  return checkSuccessStates.has(normalized);
}

function presentationMatchesFilter(
  event: DesktopGitHubEventPresentation,
  filter: DesktopGitHubEventFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "actionable") return event.isActionable && !event.isLowSignal;
  if (filter === "failures") return event.tone === "danger";
  if (filter === "pulls") return event.kind === "pull-request";
  if (filter === "reviews") return event.kind === "review";
  if (filter === "comments") return event.kind === "comment";
  return event.kind === "check";
}

function comparePresentedEvents(
  left: DesktopGitHubEventPresentation,
  right: DesktopGitHubEventPresentation,
  currentBranch: string | null,
): number {
  const leftCurrent = isCurrentBranchEvent(left, currentBranch) ? 1 : 0;
  const rightCurrent = isCurrentBranchEvent(right, currentBranch) ? 1 : 0;
  if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
  const leftActionable = left.isActionable ? 1 : 0;
  const rightActionable = right.isActionable ? 1 : 0;
  if (leftActionable !== rightActionable) return rightActionable - leftActionable;
  const leftTime = Date.parse(left.createdAt || "");
  const rightTime = Date.parse(right.createdAt || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return right.id.localeCompare(left.id);
}

function groupKeyForEvent(event: DesktopGitHubEventPresentation): string {
  const objectId = event.rawEvent.githubObjectId || event.objectLabel || event.id;
  if (
    event.kind === "pull-request"
    || event.kind === "review"
    || (event.kind === "comment" && event.objectLabel?.startsWith("PR #"))
  ) {
    return `${event.repository || "repo"}:pr:${objectId}`;
  }
  if (event.kind === "issue" || event.kind === "comment") {
    return `${event.repository || "repo"}:issue:${objectId}`;
  }
  if (event.kind === "check" && event.branchRef) return `${event.repository || "repo"}:check:${event.branchRef}`;
  return `${event.kind}:${objectId}`;
}

function rollupGroupEvents(
  events: readonly DesktopGitHubEventPresentation[],
): DesktopGitHubEventGroupEntry[] {
  const entries = new Map<string, DesktopGitHubEventPresentation[]>();
  for (const event of events) {
    const key = rollupKeyForEvent(event);
    const existing = entries.get(key);
    if (existing) {
      existing.push(event);
    } else {
      entries.set(key, [event]);
    }
  }
  return [...entries.entries()]
    .map(([key, rolledEvents]) => {
      const sortedEvents = [...rolledEvents].sort((left, right) => comparePresentedEvents(left, right, null));
      return {
        key,
        event: sortedEvents[0]!,
        events: sortedEvents,
        hiddenCount: Math.max(0, sortedEvents.length - 1),
      };
    })
    .sort((left, right) => comparePresentedEvents(left.event, right.event, null));
}

function rollupKeyForEvent(event: DesktopGitHubEventPresentation): string {
  const bodyToken = event.kind === "comment" || event.kind === "review"
    ? normalizeDedupeToken(event.bodyText)
    : "";
  return [
    event.kind,
    event.rawEvent.eventType,
    event.rawEvent.action,
    event.rawEvent.githubObjectId || event.objectLabel || "",
    normalizeDedupeToken(event.title),
    normalizeState(event.rawEvent.state || event.stateLabel),
    normalizeDedupeToken(event.actor),
    normalizeDedupeToken(event.repository),
    normalizeDedupeToken(event.linkedTaskId),
    normalizeDedupeToken(event.branchRef),
    normalizeDedupeToken(event.sourceLabel),
    bodyToken,
  ].join("|");
}

function eventSearchText(event: DesktopGitHubEventPresentation): string {
  return [
    event.id,
    event.title,
    event.subtitle || "",
    event.actor || "",
    event.repository || "",
    event.objectLabel || "",
    event.stateLabel || "",
    event.linkedTaskId || "",
    event.branchRef || "",
  ].join(" ").toLowerCase();
}

function duplicateKeyForEvent(event: DesktopGitHubEventPresentation): string {
  return [
    event.kind,
    event.rawEvent.eventType,
    event.rawEvent.action,
    event.rawEvent.githubObjectId || "",
    exactUrlToken(event.url),
    normalizeDedupeToken(event.title),
    normalizeState(event.rawEvent.state || event.stateLabel),
    normalizeDedupeToken(event.actor),
    normalizeDedupeToken(event.repository),
    normalizeDedupeToken(event.linkedTaskId),
    normalizeDedupeToken(event.branchRef),
    stringFromMetadata(event.metadata, [["head_sha"], ["commit_sha"], ["sha"]]) || "",
    stringFromMetadata(event.metadata, [["suite_id"], ["check_suite", "id"]]) || "",
  ].join("|");
}

function exactUrlToken(value: string | null | undefined): string {
  return (value || "").trim().replace(/\/$/, "").toLowerCase();
}

function normalizeDedupeToken(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function stringFromMetadata(
  metadata: Record<string, unknown>,
  paths: Array<string[]>,
): string | null {
  for (const path of paths) {
    let cursor: unknown = metadata;
    for (const part of path) {
      if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
        cursor = null;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[part];
    }
    if (typeof cursor === "string" && cursor.trim()) return cursor.trim();
    if (typeof cursor === "number" && Number.isFinite(cursor)) return String(cursor);
  }
  return null;
}

function metadataBoolean(metadata: Record<string, unknown>, path: string[]): boolean {
  let cursor: unknown = metadata;
  for (const part of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return false;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor === true;
}

function normalizeBranch(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^refs\/heads\//, "");
}

function normalizeState(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function humanize(value: string | null | undefined): string | null {
  const normalized = normalizeState(value);
  if (!normalized) return null;
  return normalized
    .split("_")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`)
    .join(" ");
}
