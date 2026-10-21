import type {
  MyWorkCard,
  MyWorkNeedsMeReason,
  MyWorkPage,
  MyWorkPullRequest,
} from "../../../../../../../../shared/ticket-connectors.mjs";
import type { DesktopAccountActivityState } from "../../../../../../electron/ipc-types";

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
    { id: "native", label: "No ticket" },
  ];
}

/** Room filter choices: rooms that hold a loaded card, plus the chosen room. */
export function myWorkRoomOptions(cards: readonly MyWorkCard[], chosen: string, chosenName?: string | null): Array<{ id: string; label: string }> {
  const rooms = new Map<string, string>();
  for (const card of cards) rooms.set(card.room_id, card.room_name);
  if (chosen && !rooms.has(chosen)) rooms.set(chosen, chosenName || chosen);
  return [...rooms].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
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
 * Rooms whose cards changed between two account activity states. The first
 * state a room reports is not a change: My work reads everything when it opens.
 */
export function roomsWithChangedTasks(
  next: DesktopAccountActivityState["rooms"],
  previous: DesktopAccountActivityState["rooms"] | undefined,
): string[] {
  if (!previous) return [];
  const changed: string[] = [];
  for (const [key, room] of Object.entries(next)) {
    const before = previous[key];
    if (before && room.tasksChangedAt && room.tasksChangedAt !== before.tasksChangedAt) changed.push(room.roomId);
  }
  return changed;
}
