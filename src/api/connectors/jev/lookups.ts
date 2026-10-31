/**
 * Database and GitHub reads for Jev questions (ticket connectors PR6). Each
 * is bounded and reads only what one question needs.
 */
import { and, asc, desc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";

import { JEV_COMMIT_SUBJECTS_MAX, JEV_LINK_MAX_CANDIDATES, type TrackerProvider } from "../../../../shared/ticket-connectors.mjs";
import { db } from "../../db/client.js";
import { accounts, external_items, room_tracker_filters, tasks, tracker_connections } from "../../db/schema.js";

/** A room's filter connection with the Jev switch on. */
export interface RoomJevConnection {
  connection_id: string;
  account_id: string;
  provider: TrackerProvider;
  site_key: string;
}

/**
 * The room's enabled filters whose connection has the Jev switch on, is
 * active, and belongs to the person who set the filter, oldest first (a room
 * has at most one per tracker). Empty means no Jev call at all (invariant 7).
 * With `provider`, only that tracker's filter.
 */
export async function findRoomJevConnections(roomId: string, provider?: TrackerProvider): Promise<RoomJevConnection[]> {
  const rows = await db.select({
    connection_id: tracker_connections.id,
    account_id: tracker_connections.account_id,
    provider: tracker_connections.provider,
    site_key: tracker_connections.site_key,
  }).from(room_tracker_filters)
    .innerJoin(tracker_connections, eq(tracker_connections.id, room_tracker_filters.connection_id))
    .where(and(
      eq(room_tracker_filters.room_id, roomId),
      eq(room_tracker_filters.enabled, true),
      eq(tracker_connections.status, "active"),
      eq(tracker_connections.jev_linking_enabled, true),
      eq(room_tracker_filters.created_by_account_id, tracker_connections.account_id),
      ...(provider ? [eq(tracker_connections.provider, provider)] : []),
    ))
    .orderBy(asc(room_tracker_filters.created_at));
  return rows.map((row) => ({ ...row, provider: row.provider as TrackerProvider }));
}

/** The first of `findRoomJevConnections`, for a question about one tracker's card. */
export async function findRoomJevConnection(roomId: string, provider?: TrackerProvider): Promise<RoomJevConnection | null> {
  return (await findRoomJevConnections(roomId, provider))[0] ?? null;
}

/** The card in the room that already shows this pull request, if any. */
export async function findCardHoldingPullRequest(roomId: string, prUrl: string): Promise<string | null> {
  const { findTaskByPrUrl, findTaskByWorkflowArtifactMatches } = await import("../../db/tasks.js");
  const task = await findTaskByWorkflowArtifactMatches(roomId, [{ provider: "github", kind: "pull_request", url: prUrl }])
    ?? await findTaskByPrUrl(roomId, prUrl);
  return task?.id ?? null;
}

/**
 * The tracker user of a pull request author: the LetAgents account signed in
 * with that GitHub user, and its own active connection to the same tracker
 * site. The immutable GitHub user id is used when the webhook carries it (a
 * renamed login cannot map to someone else); the login only otherwise. Null
 * when there is none, or when two accounts would give different users.
 */
export async function findAuthorTrackerUserId(input: { login: string; githubUserId?: string | null; provider: TrackerProvider; siteKey: string }): Promise<string | null> {
  const login = input.login.trim();
  if (!login || /\[bot\]$/i.test(login)) return null;
  const githubUserId = input.githubUserId?.trim();
  const rows = await db.selectDistinct({ tracker_user_id: tracker_connections.tracker_user_id })
    .from(accounts)
    .innerJoin(tracker_connections, eq(tracker_connections.account_id, accounts.id))
    .where(and(
      eq(accounts.provider, "github"),
      githubUserId ? eq(accounts.provider_user_id, githubUserId) : sql`lower(${accounts.login}) = lower(${login})`,
      eq(tracker_connections.provider, input.provider),
      eq(tracker_connections.site_key, input.siteKey),
      eq(tracker_connections.status, "active"),
      isNotNull(tracker_connections.tracker_user_id),
    ))
    .limit(2);
  return rows.length === 1 ? rows[0]!.tracker_user_id : null;
}

export interface JevLinkCandidate {
  task_id: string;
  external_ref: string;
  key: string;
  title: string;
}

const FINISHED_WORK = ["done", "merged", "cancelled"] as const;

/**
 * The tickets Jev may choose from: open tickets that the room's filter
 * imported (sync bound them to a card in this room through this connection),
 * assigned to the pull request author's tracker user, on unfinished cards,
 * newest change first, at most 20. A ticket outside the room's filter has no
 * card bound here, so it is never a candidate.
 */
export async function listJevLinkCandidates(input: {
  roomId: string;
  connectionId: string;
  trackerUserId: string;
  limit?: number;
}): Promise<JevLinkCandidate[]> {
  const limit = Math.max(1, Math.min(input.limit ?? JEV_LINK_MAX_CANDIDATES, JEV_LINK_MAX_CANDIDATES));
  const rows = await db.select({
    number: tasks.number,
    external_ref: tasks.external_ref,
    key: external_items.key,
    title: external_items.title,
  }).from(tasks)
    .innerJoin(external_items, eq(external_items.id, tasks.external_item_id))
    .where(and(
      eq(tasks.room_id, input.roomId),
      eq(external_items.connection_id, input.connectionId),
      eq(external_items.assignee_id, input.trackerUserId),
      sql`${external_items.ticket_state} IS DISTINCT FROM 'done'`,
      notInArray(tasks.status, [...FINISHED_WORK]),
      isNotNull(tasks.external_ref),
    ))
    .orderBy(desc(sql`coalesce(${external_items.tracker_updated_at}, ${external_items.synced_at})`), desc(tasks.number))
    .limit(limit);
  return rows.map((row) => ({ task_id: `task_${row.number}`, external_ref: row.external_ref!, key: row.key, title: row.title }));
}

/** The tickets with these keys that the connection holds, for checking a draft or an answer. */
export async function externalItemsByKey(connectionId: string, keys: string[]): Promise<Map<string, { title: string }>> {
  if (keys.length === 0) return new Map();
  const rows = await db.select({ key: external_items.key, title: external_items.title }).from(external_items)
    .where(and(eq(external_items.connection_id, connectionId), inArray(external_items.key, keys.slice(0, 50))));
  return new Map(rows.map((row) => [row.key, { title: row.title }]));
}

/**
 * Up to 20 commit subjects of a pull request, read with the GitHub App's
 * installation token. Best effort: any failure gives none, and the question
 * is asked without them.
 */
export async function fetchPullRequestCommitSubjects(input: {
  installationId: string | null;
  repositoryFullName: string;
  number: number;
  timeoutMs?: number;
}): Promise<string[]> {
  if (!input.installationId || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repositoryFullName)) return [];
  try {
    const [{ getGitHubAppConfig }, { githubRequest, mintInstallationToken }] = await Promise.all([
      import("../../github/config.js"),
      import("../../github/app-client.js"),
    ]);
    const signal = AbortSignal.timeout(input.timeoutMs ?? 4_000);
    const token = await mintInstallationToken({ config: await getGitHubAppConfig(), installationId: input.installationId, signal });
    const response = await githubRequest({
      url: `https://api.github.com/repos/${input.repositoryFullName}/pulls/${input.number}/commits?per_page=${JEV_COMMIT_SUBJECTS_MAX}`,
      token,
      signal,
    });
    if (!response.ok) return [];
    const body = await response.json() as unknown;
    if (!Array.isArray(body)) return [];
    return body.slice(0, JEV_COMMIT_SUBJECTS_MAX).flatMap((entry) => {
      const message = (entry as { commit?: { message?: unknown } } | null)?.commit?.message;
      const subject = typeof message === "string" ? message.split("\n", 1)[0]!.trim() : "";
      return subject ? [subject] : [];
    });
  } catch {
    return [];
  }
}
