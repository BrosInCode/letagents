import {
  TRACKER_PROVIDER_LABELS,
  type MyWorkCard,
  type MyWorkLocalSession,
  type MyWorkNeedsMeReason,
  type MyWorkPage,
  type MyWorkPullRequest,
  type MyWorkSessionPullRequest,
} from "../../ticket-connectors.mjs";

export type MyWorkTrackerFilter = "" | "jira" | "linear" | "github" | "native";

export interface MyWorkFilters {
  tracker: MyWorkTrackerFilter;
  roomId: string;
  needsMe: boolean;
}

/** Tracker filter choices: the account's trackers and native cards; none without a connection. */
export function myWorkTrackerOptions(
  page: Pick<MyWorkPage, "providers"> | null,
): Array<{ id: MyWorkTrackerFilter; label: string }> {
  if (!page?.providers.length) return [];
  const labels: Readonly<Record<string, string>> = TRACKER_PROVIDER_LABELS;
  return [
    { id: "", label: "All sources" },
    ...page.providers.map((provider) => ({
      id: provider as MyWorkTrackerFilter,
      label: labels[provider] ?? provider,
    })),
    // Cards sync did not bind to a ticket, typed keys included.
    { id: "native", label: "LetAgents" },
  ];
}

/** Room filter choices: rooms that held a loaded card, plus the chosen room. */
export function myWorkRoomOptions(
  rooms: ReadonlyArray<Pick<MyWorkCard, "room_id" | "room_name">>,
  chosen: string,
): Array<{ id: string; label: string }> {
  const names = new Map<string, string>();
  for (const room of rooms) names.set(room.room_id, room.room_name);
  if (chosen && !names.has(chosen)) names.set(chosen, chosen);
  return [...names]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
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
export function primaryPullRequest(
  card: Pick<MyWorkCard, "pull_requests">,
): MyWorkPullRequest | null {
  return (
    card.pull_requests.find(
      (pr) =>
        pr.merged !== true && (pr.state === "open" || pr.state === "draft"),
    ) ??
    card.pull_requests[0] ??
    null
  );
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
  if (summary.changes_requested)
    parts.push(
      `${summary.changes_requested} ${summary.changes_requested === 1 ? "change request" : "change requests"}`,
    );
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
export function myWorkCardKey(
  card: Pick<MyWorkCard, "room_id" | "task_id">,
): string {
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
    .filter(
      ([roomId, stamp]) =>
        stamp && roomId in previous && previous[roomId] !== stamp,
    )
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
  const gap = changedRooms.some((roomId) => loadedRooms.has(roomId))
    ? MY_WORK_REFRESH_GAP_MS
    : MY_WORK_OTHER_ROOM_GAP_MS;
  return Math.max(0, lastReadAt + gap - now);
}

/** PR6: Jev's reading of who a card waits on. Advice only; nothing changes. */
export function jevNeedsMeLabel(
  state: "waiting_on_human" | "waiting_on_agent" | "nothing" | "unavailable",
): string {
  if (state === "waiting_on_human") return "Jev: this waits on a person.";
  if (state === "waiting_on_agent") return "Jev: this waits on an agent.";
  if (state === "nothing") return "Jev: nothing waits on this card.";
  return "Jev could not tell. Try again after the next message.";
}

export type WorkGroup = "attention" | "active" | "queue" | "done";
export type WorkView = "all" | "attention" | "active" | "done";
export const workGroups: {
  id: WorkGroup;
  label: string;
  icon: string;
}[] = [
  {
    id: "attention",
    label: "Needs you",
    icon: "review",
  },
  {
    id: "active",
    label: "In progress",
    icon: "progress",
  },
  {
    id: "queue",
    label: "Up next",
    icon: "queue",
  },
  {
    id: "done",
    label: "Completed",
    icon: "check",
  },
];
export function workGroup(card: MyWorkCard): WorkGroup {
  if (card.needs_me) return "attention";
  if (["done", "merged", "cancelled"].includes(card.work_state)) return "done";
  if (["in_progress", "in_review", "blocked"].includes(card.work_state))
    return "active";
  return "queue";
}
function agentOwner(card: MyWorkCard): string | null {
  return (
    card.agent?.display_name || card.agent?.label.split("|")[0]?.trim() || null
  );
}
/**
 * Who has the card: its LetAgents assignee, else the ticket's tracker assignee
 * ("Tracker: Ada"), else "Unassigned". The stored work state is not changed.
 */
export function workOwner(card: MyWorkCard): string {
  const agent = agentOwner(card);
  if (agent) return agent;
  return card.ticket_assignee_label
    ? `Tracker: ${card.ticket_assignee_label}`
    : "Unassigned";
}
/** The name the owner avatar shows: the person, without the "Tracker:" prefix. */
export function workOwnerAvatarName(card: MyWorkCard): string {
  return agentOwner(card) || card.ticket_assignee_label || "Unassigned";
}
export function workState(state: string): string {
  const label = state.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
export function workKey(card: MyWorkCard): string {
  return card.key || card.task_id.replace(/^task_/, "T");
}
export function workSignal(card: MyWorkCard): string {
  if (card.needs_me)
    return card.needs_me_reasons[0] === "review_requested"
      ? "Review requested"
      : card.needs_me_reasons[0] === "ticket_done_pr_open"
        ? "PR still open"
        : "Answer requested";
  const pr = primaryPullRequest(card);
  if (card.work_state === "blocked") return "Blocked";
  if (pr?.check_summary?.failure) return "Checks failed";
  if (pr?.check_summary?.pending) return "Checks running";
  return workState(card.work_state);
}
export function workTone(card: MyWorkCard): string {
  if (
    card.work_state === "blocked" ||
    primaryPullRequest(card)?.check_summary?.failure
  )
    return "red";
  return { attention: "amber", active: "blue", queue: "muted", done: "green" }[
    workGroup(card)
  ];
}
export function workMatches(card: MyWorkCard, search: string): boolean {
  return [card.title, card.room_name, card.key, card.task_id, workOwner(card)]
    .join(" ")
    .toLocaleLowerCase()
    .includes(search.trim().toLocaleLowerCase());
}
export function workDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}
export function safeWorkUrl(value: string | null): string | undefined {
  try {
    const url = new URL(value || "");
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Sessions on this computer (desktop only).

/** A session waiting on the person shows as "Needs you" only while it is this recent. */
export const SESSION_NEEDS_YOU_MS = 3 * 24 * 60 * 60 * 1000;

export function sessionKey(session: Pick<MyWorkLocalSession, "provider" | "id">): string {
  return `${session.provider}\n${session.id}`;
}

/** One spelling per pull request, so a session and a card agree on it. */
export function pullRequestKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(url.trim());
  return match ? `${match[1]}/${match[2]}/${match[3]}/${match[4]}`.toLowerCase() : null;
}

/** The sessions that opened or work on one of the card's pull requests, newest first. */
export function sessionsForCards(
  cards: readonly MyWorkCard[],
  sessions: readonly MyWorkLocalSession[],
): Map<string, MyWorkLocalSession[]> {
  const byPullRequest = new Map<string, MyWorkLocalSession[]>();
  for (const session of sessions)
    for (const pr of session.pullRequests) {
      const key = pullRequestKey(pr.url);
      if (!key) continue;
      const list = byPullRequest.get(key) ?? [];
      if (!list.includes(session)) list.push(session);
      byPullRequest.set(key, list);
    }
  const result = new Map<string, MyWorkLocalSession[]>();
  for (const card of cards) {
    const linked = new Set<MyWorkLocalSession>();
    for (const pr of card.pull_requests)
      for (const session of byPullRequest.get(pullRequestKey(pr.url) ?? "") ?? [])
        linked.add(session);
    if (linked.size)
      result.set(
        myWorkCardKey(card),
        [...linked].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
      );
  }
  return result;
}

function sessionNeedsYou(session: MyWorkLocalSession, now: number): boolean {
  return (
    session.state === "needs_you" &&
    now - Date.parse(session.lastActivityAt) <= SESSION_NEEDS_YOU_MS
  );
}

export function openSessionPullRequests(
  session: Pick<MyWorkLocalSession, "pullRequests">,
): MyWorkSessionPullRequest[] {
  return session.pullRequests.filter((pr) => pr.state === "OPEN");
}

/**
 * Sessions to list without a card: those on no card that are working now,
 * need the person, or hold an open pull request. Other sessions are history.
 */
export function sessionsWithoutCard(
  sessions: readonly MyWorkLocalSession[],
  linked: ReadonlyMap<string, readonly MyWorkLocalSession[]>,
  now: number,
): MyWorkLocalSession[] {
  const onCards = new Set([...linked.values()].flat());
  return sessions.filter(
    (session) =>
      !onCards.has(session) &&
      (session.state === "working" ||
        sessionNeedsYou(session, now) ||
        openSessionPullRequests(session).length > 0),
  );
}

export function sessionProviderLabel(
  provider: MyWorkLocalSession["provider"],
): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}

export function sessionTitle(session: MyWorkLocalSession): string {
  return session.title || `Untitled ${sessionProviderLabel(session.provider)} session`;
}

/** "Working", "Needs you", or how long ago it last changed. */
export function sessionStateLabel(session: MyWorkLocalSession, now: number): string {
  if (session.state === "working") return "Working";
  if (sessionNeedsYou(session, now)) return "Needs you";
  return `Idle · ${sessionAge(session.lastActivityAt, now)}`;
}

export function sessionTone(session: MyWorkLocalSession, now: number): string {
  if (session.state === "working") return "blue";
  if (sessionNeedsYou(session, now)) return "amber";
  return "muted";
}

export function sessionAge(at: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The room label of a session's project: the repository name, else the folder name. */
export function sessionRoomLabel(session: MyWorkLocalSession): string {
  const room = session.projectRoomId ?? "";
  const repo = /^github\.com\/[^/]+\/([^/]+)$/i.exec(room)?.[1];
  return repo || session.projectRoot.split(/[\\/]/).filter(Boolean).at(-1) || room;
}

export function sessionPullRequestLabel(pr: MyWorkSessionPullRequest): string {
  const state = pr.state ? pr.state.charAt(0) + pr.state.slice(1).toLowerCase() : "Linked";
  return `#${pr.number} · ${state}`;
}

export function sessionMatches(session: MyWorkLocalSession, search: string): boolean {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  return [
    sessionTitle(session),
    sessionProviderLabel(session.provider),
    sessionRoomLabel(session),
    session.branch ?? "",
    ...session.pullRequests.map((pr) => `#${pr.number}`),
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}
