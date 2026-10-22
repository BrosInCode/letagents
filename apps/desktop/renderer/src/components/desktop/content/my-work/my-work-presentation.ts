import type {
  MyWorkCard,
  MyWorkNeedsMeReason,
  MyWorkPage,
  MyWorkPullRequest,
} from "../../../../../../../../shared/ticket-connectors.mjs";

export type MyWorkTrackerFilter = "" | "jira" | "linear" | "native";

export interface MyWorkFilters {
  tracker: MyWorkTrackerFilter;
  roomId: string;
  needsMe: boolean;
}

/** The table's columns. Zero-connector mode hides the ticket state (invariant 1). */
export function myWorkColumns(page: Pick<MyWorkPage, "has_connections"> | null): Array<{ id: string; label: string }> {
  return [
    { id: "ticket", label: "Ticket" },
    ...(page?.has_connections ? [{ id: "ticket-state", label: "Ticket state" }] : []),
    { id: "agent", label: "Agent work" },
    { id: "pr", label: "PR" },
  ];
}

/** Tracker filter choices: the account's trackers and native cards; none without a connection. */
export function myWorkTrackerOptions(page: Pick<MyWorkPage, "providers"> | null): Array<{ id: MyWorkTrackerFilter; label: string }> {
  if (!page?.providers.length) return [];
  const labels: Record<string, string> = { jira: "Jira", linear: "Linear" };
  return [
    { id: "", label: "All trackers" },
    ...page.providers.map((provider) => ({ id: provider as MyWorkTrackerFilter, label: labels[provider] ?? provider })),
    // Cards sync did not bind to a ticket, typed keys included.
    { id: "native", label: "Not from a tracker" },
  ];
}

/** Room filter choices: rooms that held a loaded card, plus the chosen room. */
export function myWorkRoomOptions(rooms: ReadonlyArray<Pick<MyWorkCard, "room_id" | "room_name">>, chosen: string): Array<{ id: string; label: string }> {
  const names = new Map<string, string>();
  for (const room of rooms) names.set(room.room_id, room.room_name);
  if (chosen && !names.has(chosen)) names.set(chosen, chosen);
  return [...names].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
}

const NEEDS_ME_LABELS: Record<MyWorkNeedsMeReason, string> = {
  review_requested: "Your review is requested",
  human_request: "A request waits for you",
  ticket_done_pr_open: "Ticket is done, PR still open",
};

export function needsMeLabel(reason: MyWorkNeedsMeReason): string {
  return NEEDS_ME_LABELS[reason] ?? reason.replace(/_/g, " ");
}

/** The card's main pull request: the first open one, else the first listed. */
export function primaryPullRequest(card: Pick<MyWorkCard, "pull_requests">): MyWorkPullRequest | null {
  return card.pull_requests.find((pr) => pr.merged !== true && (pr.state === "open" || pr.state === "draft"))
    ?? card.pull_requests[0]
    ?? null;
}

export function pullRequestLabel(pr: MyWorkPullRequest): string {
  return pr.number ? `#${pr.number}` : "Pull request";
}

export function pullRequestStateLabel(pr: MyWorkPullRequest): string {
  if (pr.merged) return "Merged";
  if (pr.draft || pr.state === "draft") return "Draft";
  if (!pr.state) return "Linked";
  return pr.state.charAt(0).toUpperCase() + pr.state.slice(1);
}

/** "1 approved, 1 change request" or "No reviews"; null when there is no summary. */
export function reviewSummaryLabel(pr: MyWorkPullRequest): string | null {
  const summary = pr.review_summary;
  if (!summary) return null;
  if (!summary.total) return "No reviews";
  const parts: string[] = [];
  if (summary.approved) parts.push(`${summary.approved} approved`);
  if (summary.changes_requested) parts.push(`${summary.changes_requested} ${summary.changes_requested === 1 ? "change request" : "change requests"}`);
  const other = summary.total - summary.approved - summary.changes_requested;
  if (other > 0) parts.push(`${other} ${other === 1 ? "comment" : "comments"}`);
  return parts.join(", ");
}

/** "Checks 3/4 passed, 1 failed"; null when there is no summary or no check. */
export function checkSummaryLabel(pr: MyWorkPullRequest): string | null {
  const summary = pr.check_summary;
  if (!summary?.total) return null;
  const parts = [`Checks ${summary.success}/${summary.total} passed`];
  if (summary.failure) parts.push(`${summary.failure} failed`);
  if (summary.pending) parts.push(`${summary.pending} pending`);
  return parts.join(", ");
}

/** A card's position in the loaded list; rows are keyed by room and task. */
export function myWorkCardKey(card: Pick<MyWorkCard, "room_id" | "task_id">): string {
  return `${card.room_id}\n${card.task_id}`;
}

/**
 * Rooms whose cards changed between two readings of the activity stream's
 * stamps. A room's first stamp is not a change: My work reads everything when
 * it opens.
 */
export function roomsWithChangedTasks(
  next: Readonly<Record<string, string | null>>,
  previous: Readonly<Record<string, string | null>> | undefined,
): string[] {
  if (!previous) return [];
  return Object.entries(next)
    .filter(([roomId, stamp]) => stamp && roomId in previous && previous[roomId] !== stamp)
    .map(([roomId]) => roomId);
}

/** A change in a room that holds a loaded card is read soon; others wait longer. */
export const MY_WORK_REFRESH_GAP_MS = 3_000;
export const MY_WORK_OTHER_ROOM_GAP_MS = 30_000;

/**
 * How long to wait before re-reading after changes in `changedRooms`: the
 * short gap when one of them holds a loaded card, else the long one, each
 * counted from the previous read.
 */
export function myWorkRefreshDelay(
  changedRooms: readonly string[],
  loadedRooms: ReadonlySet<string>,
  lastReadAt: number,
  now: number,
): number {
  const gap = changedRooms.some((roomId) => loadedRooms.has(roomId)) ? MY_WORK_REFRESH_GAP_MS : MY_WORK_OTHER_ROOM_GAP_MS;
  return Math.max(0, lastReadAt + gap - now);
}

/** PR6: Jev's reading of who a card waits on. Advice only; nothing changes. */
export function jevNeedsMeLabel(state: "waiting_on_human" | "waiting_on_agent" | "nothing" | "unavailable"): string {
  if (state === "waiting_on_human") return "Jev: this waits on a person.";
  if (state === "waiting_on_agent") return "Jev: this waits on an agent.";
  if (state === "nothing") return "Jev: nothing waits on this card.";
  return "Jev could not tell. Try again after the next message.";
}
