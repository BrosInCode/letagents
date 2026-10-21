/**
 * "My work" (ticket connectors PR4): the cards across an account's rooms that
 * are the account's work. A card counts when its synced ticket is assigned to
 * the account's tracker user (matched through `tracker_connections.tracker_user_id`
 * on the same tracker site), or, for a card bound to no ticket, when the card is
 * assigned to the account's login or to an agent the account owns.
 *
 * Reads only. Every query is bounded: the room set is the account's room list
 * (at most 100 rooms and their focus rooms), a page holds at most 100 cards,
 * and each enrichment query reads only the page's rooms and cards.
 */
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import {
  isTicketState,
  isTrackerProvider,
  type MyWorkCard,
  type MyWorkNeedsMeReason,
  type MyWorkPage,
  type MyWorkPullRequest,
  type TrackerProvider,
} from "../../../shared/ticket-connectors.mjs";
import { getAccountRoomsForAccount } from "../account-room-membership/list.js";
import { db } from "../db/client.js";
import { getTasksGitHubArtifactStatus } from "../db/github/artifact-status.js";
import { visibleMessageCondition } from "../db/messages/visibility.js";
import {
  external_items,
  github_room_events,
  messages,
  room_agent_presence,
  room_agent_sessions,
  room_knowledge,
  task_mentions,
  tasks,
  tracker_connections,
} from "../db/schema.js";
import type { TaskGitHubArtifactStatus } from "../db/types.js";
import type { TaskWorkflowArtifact } from "../repo-workflow.js";
import { resolveRoomDisplayName } from "../rooms/display-name.js";

export const MY_WORK_DEFAULT_LIMIT = 50;
export const MY_WORK_MAX_LIMIT = 100;
/** The same room cap as `/account/rooms` and the account activity stream. */
const MY_WORK_ROOM_LIMIT = 100;
/** A request reads at most this many candidate cards (it matters with `needs_me`). */
const MY_WORK_NEEDS_ME_SCAN = 500;
/** Newest review events and open requests read per page. */
const SIGNAL_ROW_LIMIT = 500;
/** Rooms whose PR status is read at once. */
const PR_STATUS_CONCURRENCY = 4;

export type MyWorkTrackerFilter = TrackerProvider | "native";

export interface MyWorkQuery {
  accountId: string;
  login: string | null;
  cursor?: string | null;
  limit?: number;
  tracker?: MyWorkTrackerFilter | null;
  roomId?: string | null;
  needsMe?: boolean;
}

export class MyWorkInputError extends Error {}

interface Cursor { updated_at: string; room_id: string; number: number }

/** A Postgres `timestamptz::text` value, e.g. `2026-10-21 10:00:00.123456+00`. */
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;

export function encodeMyWorkCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.updated_at, cursor.room_id, cursor.number]), "utf8").toString("base64url");
}

export function decodeMyWorkCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(parsed) && parsed.length === 3
      && typeof parsed[0] === "string" && CURSOR_TIME.test(parsed[0])
      && typeof parsed[1] === "string" && parsed[1]
      && Number.isInteger(parsed[2]) && parsed[2] > 0) {
      return { updated_at: parsed[0], room_id: parsed[1], number: parsed[2] };
    }
  } catch { /* fall through */ }
  throw new MyWorkInputError("Invalid cursor.");
}

// ---------------------------------------------------------------------------
// "Needs me": pure rules over existing signals.

/** A review request or review by the account on one pull request. */
export interface ReviewSignalEvent {
  room_id: string;
  event_type: string;
  action: string;
  github_object_url: string | null;
  event_order_at: string;
}

/**
 * Pull requests (by room and URL) where the account's newest signal is an open
 * review request: requested, and neither removed nor answered with a review since.
 * `events` must be newest first.
 */
export function openReviewRequests(events: readonly ReviewSignalEvent[]): Set<string> {
  const decided = new Set<string>();
  const requested = new Set<string>();
  for (const event of events) {
    const url = pullRequestUrl(event.github_object_url);
    if (!url) continue;
    const id = `${event.room_id}\n${url}`;
    if (decided.has(id)) continue;
    decided.add(id);
    if (event.event_type === "pull_request" && event.action === "review_requested") requested.add(id);
  }
  return requested;
}

/**
 * One spelling per pull request: lower case, without a fragment, query or a
 * path after the number (`/files`, a trailing `/`). Review events carry the
 * review URL (`…/pull/88#pullrequestreview-1`); cards may carry any form.
 */
export function pullRequestUrl(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/[#?].*$/, "");
  const match = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+)(?:\/.*)?$/i.exec(trimmed);
  return (match ? match[1]! : trimmed.replace(/\/+$/, "")).toLowerCase();
}

/** An unanswered, unarchived room request (`room_knowledge` type `attention`). */
export interface OpenRequestSignal {
  room_id: string;
  title: string;
  body: string;
  source_message_number: number | null;
}

export interface NeedsMeInput {
  room_id: string;
  task_id: string;
  key: string | null;
  ticket_state: string | null;
  pull_requests: readonly Pick<MyWorkPullRequest, "url" | "state" | "merged">[];
  /** Messages that name the card's ticket (`task_mentions`). */
  mention_message_numbers: ReadonlySet<number>;
}

export interface NeedsMeSignals {
  reviewRequests: ReadonlySet<string>;
  openRequests: readonly OpenRequestSignal[];
}

function isOpenPullRequest(pr: Pick<MyWorkPullRequest, "state" | "merged">): boolean {
  return pr.merged !== true && (pr.state === "open" || pr.state === "draft");
}

function namesCard(text: string, card: NeedsMeInput): boolean {
  const words = [card.task_id, card.key].filter((word): word is string => Boolean(word));
  return words.some((word) => new RegExp(
    `(^|[^A-Za-z0-9_-])${word.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![A-Za-z0-9_]|-\\d)`,
    "i",
  ).test(text));
}

/**
 * The reasons a card needs the account, from existing signals only:
 * 1. a review of one of its open pull requests is requested of the account;
 * 2. an open room request names the card (its key or task id), or was asked
 *    from a message that names the card's ticket;
 * 3. the tracker says the ticket is done while one of its pull requests is open.
 */
export function needsMeReasons(card: NeedsMeInput, signals: NeedsMeSignals): MyWorkNeedsMeReason[] {
  const reasons: MyWorkNeedsMeReason[] = [];
  if (card.pull_requests.some((pr) => isOpenPullRequest(pr) && signals.reviewRequests.has(`${card.room_id}\n${pullRequestUrl(pr.url)}`))) {
    reasons.push("review_requested");
  }
  if (signals.openRequests.some((request) => request.room_id === card.room_id && (
    (request.source_message_number !== null && card.mention_message_numbers.has(request.source_message_number))
    || namesCard(`${request.title}\n${request.body}`, card)
  ))) {
    reasons.push("human_request");
  }
  if (card.ticket_state === "done" && card.pull_requests.some(isOpenPullRequest)) {
    reasons.push("ticket_done_pr_open");
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Database reads.

interface CandidateRow {
  room_id: string;
  number: number;
  title: string;
  status: string;
  assignee: string | null;
  assignee_agent_key: string | null;
  external_ref: string | null;
  ticket_state: string | null;
  pr_url: string | null;
  workflow_artifacts: TaskWorkflowArtifact[] | null;
  updated_at: string;
  /** `updated_at` at full database precision, for the cursor. */
  cursor_at: string;
  item_provider: string | null;
  item_key: string | null;
  item_url: string | null;
  item_raw_status: string | null;
  item_assignee_label: string | null;
  via_tracker: boolean;
}

interface MyConnection { provider: string; site_key: string; tracker_user_id: string }

async function readCandidates(input: {
  accountId: string;
  login: string | null;
  roomIds: string[];
  connections: MyConnection[];
  tracker: MyWorkTrackerFilter | null;
  cursor: Cursor | null;
  limit: number;
}): Promise<CandidateRow[]> {
  const t = tasks;
  const ei = external_items;
  const ec = tracker_connections;
  const assignedNatively: SQL[] = [];
  if (input.login) assignedNatively.push(sql`lower(${t.assignee}) = lower(${input.login})`);
  assignedNatively.push(sql`${t.assignee_agent_key} IN (
    SELECT ${room_agent_sessions.agent_key} FROM ${room_agent_sessions}
     WHERE ${room_agent_sessions.owner_account_id} = ${input.accountId}
       AND ${room_agent_sessions.room_id} = ${t.room_id})`);
  const native = sql`(${t.external_item_id} IS NULL AND (${sql.join(assignedNatively, sql` OR `)}))`;
  // Invariant 1: with no connection, the tracker join is never part of the match.
  const viaTracker = input.connections.length
    ? sql`EXISTS (
        SELECT 1 FROM ${tracker_connections} mine
         WHERE mine.account_id = ${input.accountId}
           AND mine.tracker_user_id IS NOT NULL
           AND mine.provider = ${ec.provider}
           AND mine.site_key = ${ec.site_key}
           AND mine.tracker_user_id = ${ei.assignee_id})`
    : sql`FALSE`;
  const conditions: SQL[] = [
    sql`${t.room_id} IN (${sql.join(input.roomIds.map((id) => sql`${id}`), sql`, `)})`,
    sql`(${viaTracker} OR ${native})`,
    // Finished work leaves the page, unless the ticket is still open in the tracker.
    sql`NOT (${t.status} IN ('done', 'merged', 'cancelled') AND (${t.ticket_state} IS NULL OR ${t.ticket_state} = 'done'))`,
  ];
  if (input.tracker === "native") conditions.push(sql`${t.external_ref} IS NULL`);
  else if (input.tracker) conditions.push(sql`split_part(${t.external_ref}, ':', 1) = ${input.tracker}`);
  if (input.cursor) {
    conditions.push(sql`(${t.updated_at}, ${t.room_id}, ${t.number}) < (${input.cursor.updated_at}::timestamptz, ${input.cursor.room_id}, ${input.cursor.number})`);
  }
  const result = await db.execute(sql`
    SELECT ${t.room_id} AS room_id, ${t.number} AS number, ${t.title} AS title, ${t.status} AS status,
           ${t.assignee} AS assignee, ${t.assignee_agent_key} AS assignee_agent_key,
           ${t.external_ref} AS external_ref, ${t.ticket_state} AS ticket_state, ${t.pr_url} AS pr_url,
           ${t.workflow_artifacts} AS workflow_artifacts, ${t.updated_at} AS updated_at,
           ${t.updated_at}::text AS cursor_at, ${ei.provider} AS item_provider, ${ei.key} AS item_key, ${ei.url} AS item_url,
           ${ei.raw_status} AS item_raw_status, ${ei.assignee_label} AS item_assignee_label,
           ${viaTracker} AS via_tracker
      FROM ${t}
      LEFT JOIN ${ei} ON ${ei.id} = ${t.external_item_id}
      LEFT JOIN ${ec} ON ${ec.id} = ${ei.connection_id}
     WHERE ${sql.join(conditions, sql` AND `)}
     ORDER BY ${t.updated_at} DESC, ${t.room_id} DESC, ${t.number} DESC
     LIMIT ${input.limit}
  `);
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    room_id: String(row.room_id),
    number: Number(row.number),
    title: String(row.title),
    status: String(row.status),
    assignee: (row.assignee as string | null) ?? null,
    assignee_agent_key: (row.assignee_agent_key as string | null) ?? null,
    external_ref: (row.external_ref as string | null) ?? null,
    ticket_state: (row.ticket_state as string | null) ?? null,
    pr_url: (row.pr_url as string | null) ?? null,
    workflow_artifacts: Array.isArray(row.workflow_artifacts) ? row.workflow_artifacts as TaskWorkflowArtifact[] : null,
    updated_at: timestampString(row.updated_at),
    cursor_at: String(row.cursor_at),
    item_provider: (row.item_provider as string | null) ?? null,
    item_key: (row.item_key as string | null) ?? null,
    item_url: (row.item_url as string | null) ?? null,
    item_raw_status: (row.item_raw_status as string | null) ?? null,
    item_assignee_label: (row.item_assignee_label as string | null) ?? null,
    via_tracker: row.via_tracker === true,
  }));
}

function timestampString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? String(value) : new Date(parsed).toISOString();
}

type PageKey = `${string}\n${number}`;
const pageKey = (roomId: string, number: number): PageKey => `${roomId}\n${number}`;

function pageTuples(rows: readonly CandidateRow[], roomColumn: unknown, numberColumn: unknown): SQL {
  return sql`(${roomColumn}, ${numberColumn}) IN (${sql.join(rows.map((row) => sql`(${row.room_id}, ${row.number})`), sql`, `)})`;
}

async function readPresence(rows: readonly CandidateRow[]) {
  const withAgent = rows.filter((row) => row.assignee_agent_key);
  const result = new Map<string, { display_name: string; status: string; status_text: string | null; last_heartbeat_at: string }>();
  if (!withAgent.length) return result;
  const p = room_agent_presence;
  const found = await db.execute(sql`
    SELECT DISTINCT ON (${p.room_id}, ${p.agent_key})
           ${p.room_id} AS room_id, ${p.agent_key} AS agent_key, ${p.display_name} AS display_name,
           ${p.status} AS status, ${p.status_text} AS status_text, ${p.last_heartbeat_at} AS last_heartbeat_at
      FROM ${p}
     WHERE (${p.room_id}, ${p.agent_key}) IN (${sql.join(withAgent.map((row) => sql`(${row.room_id}, ${row.assignee_agent_key})`), sql`, `)})
     ORDER BY ${p.room_id}, ${p.agent_key}, ${p.last_heartbeat_at} DESC
  `);
  for (const row of found.rows as Array<Record<string, unknown>>) {
    result.set(`${row.room_id}\n${row.agent_key}`, {
      display_name: String(row.display_name),
      status: String(row.status),
      status_text: (row.status_text as string | null) ?? null,
      last_heartbeat_at: timestampString(row.last_heartbeat_at),
    });
  }
  return result;
}

/** Visible messages that name each card's ticket: count, newest time, and their numbers. */
async function readMentions(rows: readonly CandidateRow[]) {
  const result = new Map<PageKey, { count: number; last_activity_at: string | null; numbers: Set<number> }>();
  const withRef = rows.filter((row) => row.external_ref);
  if (!withRef.length) return result;
  const found = await db
    .select({
      room_id: task_mentions.room_id,
      task_number: task_mentions.task_number,
      count: sql<number>`count(*)::int`,
      last_activity_at: sql<string | null>`max(${messages.timestamp})`,
      // Only for matching open requests; a card lists at most its newest 200.
      numbers: sql<number[]>`(array_agg(${task_mentions.message_number} ORDER BY ${task_mentions.message_number} DESC))[1:200]`,
    })
    .from(task_mentions)
    .innerJoin(messages, and(eq(messages.room_id, task_mentions.room_id), eq(messages.number, task_mentions.message_number)))
    .where(and(
      pageTuples(withRef, task_mentions.room_id, task_mentions.task_number),
      visibleMessageCondition(),
      or(isNull(messages.visibility), eq(messages.visibility, "rental_visible")),
    ))
    .groupBy(task_mentions.room_id, task_mentions.task_number);
  for (const row of found) {
    result.set(pageKey(row.room_id, row.task_number), {
      count: Number(row.count),
      last_activity_at: row.last_activity_at ? timestampString(row.last_activity_at) : null,
      numbers: new Set((row.numbers ?? []).map(Number)),
    });
  }
  return result;
}

/** The board's PR status for each page room, a few rooms at a time. */
async function readPullRequestStatus(roomIds: readonly string[]) {
  const result = new Map<string, Map<string, TaskGitHubArtifactStatus>>();
  for (let index = 0; index < roomIds.length; index += PR_STATUS_CONCURRENCY) {
    const batch = roomIds.slice(index, index + PR_STATUS_CONCURRENCY);
    const statuses = await Promise.all(batch.map((roomId) => getTasksGitHubArtifactStatus(roomId)));
    batch.forEach((roomId, position) => result.set(roomId, statuses[position]!));
  }
  return result;
}

async function readReviewSignals(roomIds: readonly string[], login: string | null): Promise<ReviewSignalEvent[]> {
  if (!login || !roomIds.length) return [];
  const e = github_room_events;
  const rows = await db
    .select({
      room_id: e.room_id,
      event_type: e.event_type,
      action: e.action,
      github_object_url: e.github_object_url,
      event_order_at: e.event_order_at,
    })
    .from(e)
    .where(and(
      inArray(e.room_id, [...roomIds]),
      or(
        and(
          eq(e.event_type, "pull_request"),
          inArray(e.action, ["review_requested", "review_request_removed"]),
          sql`lower(${e.metadata}->'participant'->>'login') = lower(${login})`,
        ),
        and(eq(e.event_type, "pull_request_review"), sql`lower(${e.actor_login}) = lower(${login})`),
      ),
    ))
    .orderBy(desc(e.event_order_at), desc(e.id))
    .limit(SIGNAL_ROW_LIMIT);
  return rows.map((row) => ({ ...row, room_id: row.room_id ?? "", event_order_at: String(row.event_order_at) }));
}

async function readOpenRequests(roomIds: readonly string[]): Promise<OpenRequestSignal[]> {
  if (!roomIds.length) return [];
  const k = room_knowledge;
  const rows = await db
    .select({ room_id: k.room_id, value: k.value })
    .from(k)
    .where(and(
      inArray(k.room_id, [...roomIds]),
      eq(k.type, "attention"),
      sql`jsonb_typeof(${k.value}->'response') IS DISTINCT FROM 'object'`,
      sql`COALESCE((${k.value}->>'archived')::boolean, false) = false`,
    ))
    .orderBy(desc(sql`${k.value}->>'created_at'`))
    .limit(SIGNAL_ROW_LIMIT);
  return rows.map((row) => {
    const value = row.value as unknown as Record<string, unknown>;
    const source = typeof value.source_message_id === "string" ? /^msg_(\d+)$/.exec(value.source_message_id)?.[1] : undefined;
    return {
      room_id: row.room_id,
      title: typeof value.title === "string" ? value.title : "",
      body: typeof value.body === "string" ? value.body : "",
      source_message_number: source ? Number(source) : null,
    };
  });
}

function pullRequestsFor(row: CandidateRow, status: TaskGitHubArtifactStatus | undefined): MyWorkPullRequest[] {
  const list: MyWorkPullRequest[] = [];
  const seen = new Set<string>();
  if (status?.pr_url) {
    seen.add(pullRequestUrl(status.pr_url)!);
    list.push({
      url: status.pr_url,
      number: status.pr_number,
      title: status.pr_title,
      state: status.pr_merged ? "merged" : status.pr_state,
      draft: status.pr_draft,
      merged: status.pr_merged,
      review_summary: status.review_summary,
      check_summary: status.check_summary,
    });
  }
  const artifacts = (row.workflow_artifacts ?? []).filter((artifact) =>
    artifact.provider === "github" && artifact.kind === "pull_request" && typeof artifact.url === "string");
  for (const artifact of artifacts) {
    const url = pullRequestUrl(artifact.url!)!;
    if (seen.has(url)) continue;
    seen.add(url);
    list.push({
      url: artifact.url!,
      number: artifact.number != null ? String(artifact.number) : null,
      title: artifact.title ?? null,
      state: artifact.state ?? null,
      draft: null,
      merged: artifact.state === "merged" ? true : null,
      review_summary: null,
      check_summary: null,
    });
  }
  if (row.pr_url && !seen.has(pullRequestUrl(row.pr_url)!)) {
    list.push({ url: row.pr_url, number: null, title: null, state: null, draft: null, merged: null, review_summary: null, check_summary: null });
  }
  return list;
}

function splitRef(ref: string | null): { provider: TrackerProvider | null; key: string | null } {
  if (!ref) return { provider: null, key: null };
  const separator = ref.indexOf(":");
  const provider = ref.slice(0, separator);
  return { provider: isTrackerProvider(provider) ? provider : null, key: separator > 0 ? ref.slice(separator + 1) : null };
}

/**
 * Room-level reads one request shares across its batches: each room's PR
 * status, review signals and open requests are read once per request.
 */
interface RequestCache {
  prStatus: Map<string, Map<string, TaskGitHubArtifactStatus>>;
  reviewEvents: Map<string, ReviewSignalEvent[]>;
  openRequests: Map<string, OpenRequestSignal[]>;
}

const newRequestCache = (): RequestCache => ({ prStatus: new Map(), reviewEvents: new Map(), openRequests: new Map() });

async function fillRequestCache(cache: RequestCache, roomIds: readonly string[], login: string | null): Promise<void> {
  const missing = roomIds.filter((id) => !cache.prStatus.has(id));
  if (!missing.length) return;
  const [prStatus, reviewEvents, openRequests] = await Promise.all([
    readPullRequestStatus(missing),
    readReviewSignals(missing, login),
    readOpenRequests(missing),
  ]);
  for (const id of missing) {
    cache.prStatus.set(id, prStatus.get(id) ?? new Map());
    cache.reviewEvents.set(id, reviewEvents.filter((event) => event.room_id === id));
    cache.openRequests.set(id, openRequests.filter((request) => request.room_id === id));
  }
}

async function buildCards(
  rows: CandidateRow[],
  roomNames: Map<string, string>,
  login: string | null,
  cache: RequestCache,
): Promise<MyWorkCard[]> {
  if (!rows.length) return [];
  const pageRoomIds = [...new Set(rows.map((row) => row.room_id))];
  const [presence, mentions] = await Promise.all([
    readPresence(rows),
    readMentions(rows),
    fillRequestCache(cache, pageRoomIds, login),
  ]);
  const prStatus = cache.prStatus;
  const reviewRequests = openReviewRequests(pageRoomIds.flatMap((id) => cache.reviewEvents.get(id) ?? []));
  const openRequests = pageRoomIds.flatMap((id) => cache.openRequests.get(id) ?? []);
  return rows.map((row) => {
    const taskId = `task_${row.number}`;
    const ref = splitRef(row.external_ref);
    const mention = mentions.get(pageKey(row.room_id, row.number));
    const pullRequests = pullRequestsFor(row, prStatus.get(row.room_id)?.get(taskId));
    const ticketState = isTicketState(row.ticket_state) ? row.ticket_state : null;
    const reasons = needsMeReasons({
      room_id: row.room_id,
      task_id: taskId,
      key: ref.key,
      ticket_state: ticketState,
      pull_requests: pullRequests,
      mention_message_numbers: mention?.numbers ?? new Set(),
    }, { reviewRequests, openRequests });
    const agentPresence = row.assignee_agent_key ? presence.get(`${row.room_id}\n${row.assignee_agent_key}`) : undefined;
    const label = row.assignee ?? agentPresence?.display_name ?? row.assignee_agent_key;
    return {
      task_id: taskId,
      room_id: row.room_id,
      room_name: roomNames.get(row.room_id) ?? row.room_id,
      title: row.title,
      external_ref: row.external_ref,
      key: ref.key,
      provider: ref.provider,
      ticket_state: ticketState,
      ticket_status: row.item_raw_status,
      // Only a web link leaves the app.
      ticket_url: row.item_url && /^https:\/\//i.test(row.item_url) ? row.item_url : null,
      ticket_assignee_label: row.item_assignee_label,
      work_state: row.status,
      assigned_via: row.via_tracker ? "tracker" : "native",
      agent: label ? {
        label,
        agent_key: row.assignee_agent_key,
        display_name: agentPresence?.display_name ?? null,
        status: agentPresence?.status ?? null,
        status_text: agentPresence?.status_text ?? null,
        last_heartbeat_at: agentPresence?.last_heartbeat_at ?? null,
      } : null,
      threads: { count: mention?.count ?? 0, last_activity_at: mention?.last_activity_at ?? null },
      pull_requests: pullRequests,
      needs_me: reasons.length > 0,
      needs_me_reasons: reasons,
      updated_at: row.updated_at,
    } satisfies MyWorkCard;
  });
}

export interface MyWorkDeps {
  listRoomNames(accountId: string, login: string | null): Promise<Map<string, string>>;
  /** Whether the account may read the room now. Only rooms that hold a candidate card are asked. */
  canReadRoom(accountId: string, roomId: string): Promise<boolean>;
}

async function listRoomNames(accountId: string, login: string | null): Promise<Map<string, string>> {
  const rooms = await getAccountRoomsForAccount(accountId, { login, limit: MY_WORK_ROOM_LIMIT });
  const names = new Map<string, string>();
  for (const room of rooms) {
    names.set(room.room_id, resolveRoomDisplayName(room.room_id, room.display_name, room.kind));
    for (const focus of room.focus_rooms) names.set(focus.room_id, focus.display_name);
  }
  return names;
}

/**
 * The room list remembers rooms the account once opened; a private Git Room
 * may have dropped the account since. The cached access decision the push
 * path uses answers that: a room that is not backed by a repository allows
 * every account. Only a confirmed allow counts.
 */
async function canReadRoom(accountId: string, roomId: string): Promise<boolean> {
  const { filterAccountIdsWithRoomAccess } = await import("../server/events.js");
  const access = await filterAccountIdsWithRoomAccess(roomId, [accountId]);
  return access.recents.includes(accountId);
}

const defaultDeps: MyWorkDeps = { listRoomNames, canReadRoom };

/** One page of the account's work, newest change first. */
export async function listMyWork(query: MyWorkQuery, overrides: Partial<MyWorkDeps> = {}): Promise<MyWorkPage> {
  const deps: MyWorkDeps = { ...defaultDeps, ...overrides };
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? MY_WORK_DEFAULT_LIMIT) || MY_WORK_DEFAULT_LIMIT, 1), MY_WORK_MAX_LIMIT);
  let cursor = query.cursor ? decodeMyWorkCursor(query.cursor) : null;
  const connectionRows = await db
    .select({ provider: tracker_connections.provider, site_key: tracker_connections.site_key, tracker_user_id: tracker_connections.tracker_user_id })
    .from(tracker_connections)
    .where(eq(tracker_connections.account_id, query.accountId));
  const connections = connectionRows
    .filter((row): row is MyConnection => typeof row.tracker_user_id === "string" && row.tracker_user_id.length > 0);
  const providers = [...new Set(connectionRows.map((row) => row.provider).filter(isTrackerProvider))];
  const page: MyWorkPage = { cards: [], next_cursor: null, has_connections: providers.length > 0, providers };

  const roomNames = await deps.listRoomNames(query.accountId, query.login);
  let roomIds = [...roomNames.keys()];
  if (query.roomId) roomIds = roomIds.filter((id) => id === query.roomId);
  if (!roomIds.length) return page;

  // Read candidates in batches until the page is full, the candidates run
  // out, or the scan bound is reached. Without `needs_me` one batch usually
  // fills the page; rows in rooms the account can no longer read are skipped.
  const cache = newRequestCache();
  const readable = new Map<string, boolean>();
  let scanned = 0;
  for (;;) {
    const batchSize = Math.min(
      query.needsMe ? MY_WORK_MAX_LIMIT : limit - page.cards.length,
      MY_WORK_NEEDS_ME_SCAN - scanned,
    );
    const rows = await readCandidates({
      accountId: query.accountId,
      login: query.login,
      roomIds,
      connections,
      tracker: query.tracker ?? null,
      cursor,
      limit: batchSize + 1,
    });
    const more = rows.length > batchSize;
    const batch = rows.slice(0, batchSize);
    if (!batch.length) return page;
    scanned += batch.length;
    for (const roomId of new Set(batch.map((row) => row.room_id))) {
      if (readable.has(roomId)) continue;
      let allowed = false;
      try { allowed = await deps.canReadRoom(query.accountId, roomId); }
      catch (error) { console.warn(`[my work] room access check failed room=${roomId}`, error); }
      readable.set(roomId, allowed);
    }
    const visible = batch.filter((row) => readable.get(row.room_id));
    const cards = new Map((await buildCards(visible, roomNames, query.login, cache))
      .map((card) => [pageKey(card.room_id, Number(card.task_id.slice("task_".length))), card]));
    let lastTaken: CandidateRow | null = null;
    for (const row of batch) {
      const card = cards.get(pageKey(row.room_id, row.number));
      if (!card || (query.needsMe && !card.needs_me)) { lastTaken = row; continue; }
      if (page.cards.length >= limit) break;
      page.cards.push(card);
      lastTaken = row;
    }
    const filled = page.cards.length >= limit;
    const consumedBatch = lastTaken === batch[batch.length - 1];
    if (lastTaken) cursor = { updated_at: lastTaken.cursor_at, room_id: lastTaken.room_id, number: lastTaken.number };
    if (!more && consumedBatch) return page;
    if (filled || scanned >= MY_WORK_NEEDS_ME_SCAN) {
      page.next_cursor = cursor ? encodeMyWorkCursor(cursor) : null;
      return page;
    }
  }
}

