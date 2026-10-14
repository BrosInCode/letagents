import type { DesktopGitHubRoomEvent } from "../../../electron/ipc-types";
import { timestampValue } from "./time";

/** A GitHub room event plus the room it belongs to. Events without a room use the panel room. */
export type PersonWorkEvent = DesktopGitHubRoomEvent & { roomId?: string | null };

export interface PersonWorkRow {
  prUrl: string;
  prNumber: number | null;
  title: string;
  state: string;
  roomId: string;
  updatedAt: string;
  note: string | null;
}

export interface PersonWork {
  openPrs: PersonWorkRow[];
  needsTheirReview: PersonWorkRow[];
  reviewed: PersonWorkRow[];
  mergedRecently: PersonWorkRow[];
}

/** How far back the panel loads GitHub events. */
export const PERSON_WORK_LOOKBACK_DAYS = 30;
/** Largest number of events the panel loads for each event type. */
export const PERSON_WORK_EVENT_LIMIT = 2000;
/** Page size the events route accepts (its maximum). */
export const PERSON_WORK_PAGE_LIMIT = 100;

const MERGED_WINDOW_MS = 24 * 60 * 60 * 1000;
// Review events store the review URL (".../pull/12#pullrequestreview-9"),
// so the pull request URL is the part before "/pull/<number>".
const PULL_REQUEST_URL = /^(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+))(?:[/?#].*)?$/;

interface PullRequestGroup {
  prUrl: string;
  prNumber: number | null;
  /** Newest first. */
  events: PersonWorkEvent[];
}

export function buildPersonWork(
  events: readonly PersonWorkEvent[],
  login: string,
  now: Date,
): PersonWork {
  const work: PersonWork = { openPrs: [], needsTheirReview: [], reviewed: [], mergedRecently: [] };
  const viewer = normalizeLogin(login);
  if (!viewer) return work;
  const nowMs = now.getTime();

  for (const group of groupByPullRequest(events)) {
    const pullRequestEvents = group.events.filter((event) => event.eventType === "pull_request");
    const current = pullRequestEvents[0] ?? null;
    const state = pullRequestState(current);
    const author = pullRequestAuthor(group, pullRequestEvents);

    if (state === "open" || state === "draft") {
      if (sameLogin(author, viewer)) {
        work.openPrs.push(buildRow(group, group.events[0], null));
      }
    }

    if (state === "merged") {
      const mergedBy = pullRequestEvents
        .map((event) => stringField(metadataOf(event), "merged_by_login"))
        .find((value): value is string => Boolean(value)) ?? null;
      // The merge time is the first merged event, not the newest event. A later event
      // (for example a sync after the merge) must not move the merge into the window.
      const mergeEvent = pullRequestEvents.filter(isMergedEvent).at(-1) ?? null;
      const mergedInWindow = mergeEvent !== null && nowMs - eventTime(mergeEvent) <= MERGED_WINDOW_MS;
      if (mergedInWindow && (sameLogin(author, viewer) || sameLogin(mergedBy, viewer))) {
        const note = mergedBy && !sameLogin(mergedBy, viewer) ? `merged by ${mergedBy}` : null;
        work.mergedRecently.push(buildRow(group, group.events[0], note));
      }
    }

    if (state !== "merged" && state !== "closed" && hasOpenReviewerRequest(group, viewer)) {
      work.needsTheirReview.push(buildRow(group, group.events[0], null));
    }

    if (state !== "merged") {
      const newestReview = group.events.find((event) =>
        event.eventType === "pull_request_review" && sameLogin(event.actorLogin, viewer),
      );
      if (newestReview) {
        work.reviewed.push(buildRow(group, newestReview, reviewNote(newestReview.state)));
      }
    }
  }

  return {
    openPrs: sortNewestFirst(work.openPrs),
    needsTheirReview: sortNewestFirst(work.needsTheirReview),
    reviewed: sortNewestFirst(work.reviewed),
    mergedRecently: sortNewestFirst(work.mergedRecently),
  };
}

export interface PersonWorkEventPage {
  events: DesktopGitHubRoomEvent[];
  hasMore: boolean;
}

/**
 * Read the pages of one event type, newest first. Stop at the last page, at a
 * page that adds nothing new, at a cursor that does not move, or at the event
 * cap. `truncated` is true only when the cap stopped a loop that had more pages.
 */
export async function loadRoomEventsOfType(
  fetchPage: (options: { after: string | null }) => Promise<PersonWorkEventPage>,
  options: { maxEvents: number },
): Promise<{ events: DesktopGitHubRoomEvent[]; truncated: boolean }> {
  const collected: DesktopGitHubRoomEvent[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const page = await fetchPage({ after });
    let added = 0;
    for (const event of page.events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      collected.push(event);
      added += 1;
    }
    const cursor = page.events.at(-1)?.id ?? null;
    if (!page.hasMore || !cursor || added === 0 || cursor === after) {
      return { events: collected, truncated: false };
    }
    if (collected.length >= options.maxEvents) return { events: collected, truncated: true };
    after = cursor;
  }
}

function groupByPullRequest(events: readonly PersonWorkEvent[]): PullRequestGroup[] {
  const groups = new Map<string, PullRequestGroup>();
  for (const event of events) {
    if (event.eventType !== "pull_request" && event.eventType !== "pull_request_review") continue;
    const match = PULL_REQUEST_URL.exec(event.githubObjectUrl ?? "");
    if (!match) continue;
    const key = match[1].toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { prUrl: match[1], prNumber: Number(match[2]), events: [] };
      groups.set(key, group);
    }
    group.events.push(event);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    events: [...group.events].sort(compareNewestFirst),
  }));
}

function pullRequestState(current: PersonWorkEvent | null): string {
  if (!current) return "unknown";
  const state = (current.state ?? "").trim().toLowerCase();
  if (state === "open" && metadataOf(current).draft === true) return "draft";
  return state || "unknown";
}

function pullRequestAuthor(group: PullRequestGroup, pullRequestEvents: readonly PersonWorkEvent[]): string | null {
  for (const event of group.events) {
    const metadata = metadataOf(event);
    const author = stringField(metadata, "author_login") ?? stringField(metadata, "pull_request_author_login");
    if (author) return author;
  }
  // The server always writes author_login. The oldest pull request event is a
  // fallback for malformed data only.
  return pullRequestEvents.at(-1)?.actorLogin ?? null;
}

/**
 * True when the newest reviewer participant event for the viewer is "added"
 * and no review by the viewer came after it.
 */
function hasOpenReviewerRequest(group: PullRequestGroup, viewer: string): boolean {
  let newestChange: string | null = null;
  let newestTime = -Infinity;
  for (const event of group.events) {
    const participant = objectField(metadataOf(event), "participant");
    if (!participant || participant.role !== "reviewer") continue;
    if (!sameLogin(stringField(participant, "login"), viewer)) continue;
    const time = eventTime(event);
    if (time > newestTime) {
      newestTime = time;
      newestChange = stringField(participant, "change");
    }
  }
  if (newestChange !== "added") return false;
  return !group.events.some((event) =>
    event.eventType === "pull_request_review"
    && sameLogin(event.actorLogin, viewer)
    && eventTime(event) > newestTime,
  );
}

function buildRow(group: PullRequestGroup, updatedFrom: PersonWorkEvent, note: string | null): PersonWorkRow {
  const current = group.events.find((event) => event.eventType === "pull_request") ?? null;
  const titled = current ?? group.events.find((event) => event.title) ?? null;
  return {
    prUrl: group.prUrl,
    prNumber: group.prNumber,
    title: titled?.title ?? "",
    state: pullRequestState(current),
    roomId: updatedFrom.roomId || group.events.find((event) => event.roomId)?.roomId || "",
    updatedAt: updatedFrom.eventOrderAt || updatedFrom.createdAt,
    note,
  };
}

function reviewNote(state: string | null): string {
  const normalized = (state ?? "").trim().toLowerCase();
  if (!normalized) return "reviewed";
  if (normalized === "changes_requested") return "changes requested";
  return normalized.replace(/_/g, " ");
}

function eventTime(event: PersonWorkEvent): number {
  return timestampValue(event.eventOrderAt || event.createdAt);
}

function compareNewestFirst(left: PersonWorkEvent, right: PersonWorkEvent): number {
  const byTime = eventTime(right) - eventTime(left);
  if (byTime !== 0) return byTime;
  const byCreated = timestampValue(right.createdAt) - timestampValue(left.createdAt);
  if (byCreated !== 0) return byCreated;
  return right.id.localeCompare(left.id);
}

function sortNewestFirst(rows: PersonWorkRow[]): PersonWorkRow[] {
  return rows.sort((left, right) => timestampValue(right.updatedAt) - timestampValue(left.updatedAt));
}

function normalizeLogin(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function sameLogin(value: string | null | undefined, viewer: string): boolean {
  const normalized = normalizeLogin(value);
  return normalized.length > 0 && normalized === viewer;
}

function isMergedEvent(event: PersonWorkEvent): boolean {
  return (event.state ?? "").trim().toLowerCase() === "merged";
}

function metadataOf(event: PersonWorkEvent): Record<string, unknown> {
  const metadata: unknown = event.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function objectField(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value: unknown = source[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
