import { and, asc, eq, inArray, or, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { getGitRoomBindingsForRooms } from "../db/git-room-bindings.js";
import { isRepoBackedRoomId } from "../rooms/room-ids.js";
import { classifyTopLevelRoomIds, membershipRoomsReadableBy } from "../rooms/access-decision.js";
import {
  account_room_recents,
  messages,
  project_admins,
  room_agent_sessions,
  room_participants,
  rooms,
} from "../db/schema.js";
import { visibleMessageCondition } from "../db/messages/visibility.js";
import { formatMessageId } from "../db/utils.js";
import {
  accountRoomDeleteReason,
  mergeAccountRoomCandidate,
  normalizeAccountRoomCandidate,
  recentSourceHasDirectParentAccess,
  roomSelectColumns,
  toAccountRoomListFocusRoom,
  toAccountRoomProject,
} from "./candidates.js";
import type {
  AccountRoomCandidate,
  AccountRoomListEntry,
} from "./types.js";

/** Repo rooms checked at once; each check is cached, so most cost no GitHub call. */
const REPO_ACCESS_CHECK_CONCURRENCY = 8;

type LatestRoomMessage = {
  latest_message_id: string | null;
  latest_message_at: string | null;
};

export async function getAccountRoomsForAccount(
  accountId: string,
  options: {
    login?: string | null;
    limit?: number;
    includeArchived?: boolean;
  } = {}
): Promise<AccountRoomListEntry[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
  const candidatesByRoomId = new Map<string, AccountRoomCandidate>();
  const login = options.login?.trim() || null;
  const normalizedLogin = login?.toLowerCase() || null;

  function addCandidate(candidate: AccountRoomCandidate): void {
    const existing = candidatesByRoomId.get(candidate.project.id);
    candidatesByRoomId.set(
      candidate.project.id,
      existing ? mergeAccountRoomCandidate(existing, candidate) : candidate
    );
  }

  // The four sources are independent reads; the candidates still merge in
  // the same order (admin, participant, agent, recent) as before.
  const loginValue = normalizedLogin ? login || normalizedLogin : null;
  const [adminRows, participantRows, agentSessionRows, recentRows] = await Promise.all([
    db
      .select({
        ...roomSelectColumns,
        assigned_at: project_admins.assigned_at,
      })
      .from(project_admins)
      .innerJoin(rooms, eq(project_admins.project_id, rooms.id))
      .where(eq(project_admins.account_id, accountId)),
    normalizedLogin && loginValue
      ? db
        .select({
          ...roomSelectColumns,
          last_seen_at: room_participants.last_seen_at,
        })
        .from(room_participants)
        .innerJoin(rooms, eq(room_participants.room_id, rooms.id))
        .where(
          and(
            eq(room_participants.kind, "human"),
            or(
              eq(room_participants.github_login, loginValue),
              eq(room_participants.participant_key, `human:login:${normalizedLogin}`)
            )
          )
        )
      : Promise.resolve([]),
    db
      .select({
        ...roomSelectColumns,
        session_created_at: room_agent_sessions.created_at,
        last_seen_at: room_agent_sessions.last_seen_at,
      })
      .from(room_agent_sessions)
      .innerJoin(rooms, eq(room_agent_sessions.room_id, rooms.id))
      .where(eq(room_agent_sessions.owner_account_id, accountId)),
    db
      .select({
        ...roomSelectColumns,
        recent_display_name: account_room_recents.display_name,
        source: account_room_recents.source,
        pinned: account_room_recents.pinned,
        archived: account_room_recents.archived,
        first_opened_at: account_room_recents.first_opened_at,
        last_opened_at: account_room_recents.last_opened_at,
      })
      .from(account_room_recents)
      .innerJoin(rooms, eq(account_room_recents.room_id, rooms.id))
      .where(eq(account_room_recents.account_id, accountId)),
  ]);

  for (const row of adminRows) {
    const project = toAccountRoomProject(row);
    if (project.kind === "focus" && project.focus_archived_at) {
      continue;
    }
    addCandidate(normalizeAccountRoomCandidate(project, {
      role: "admin",
      source: "admin",
      directParentAccess: project.kind === "main",
      firstOpenedAt: row.assigned_at,
      lastOpenedAt: row.assigned_at,
    }));
  }

  if (normalizedLogin) {
    for (const row of participantRows) {
      const project = toAccountRoomProject(row);
      if (project.kind === "focus" && project.focus_archived_at) {
        continue;
      }
      addCandidate(normalizeAccountRoomCandidate(project, {
        role: "participant",
        source: "participant",
        directParentAccess: project.kind === "main",
        firstOpenedAt: row.last_seen_at,
        lastOpenedAt: row.last_seen_at,
      }));
    }
  }

  for (const row of agentSessionRows) {
    const project = toAccountRoomProject(row);
    if (project.kind === "focus" && project.focus_archived_at) {
      continue;
    }
    addCandidate(normalizeAccountRoomCandidate(project, {
      role: "participant",
      source: "agent",
      directParentAccess: project.kind === "main",
      firstOpenedAt: row.session_created_at,
      lastOpenedAt: row.last_seen_at,
    }));
  }

  for (const row of recentRows) {
    const project = {
      ...toAccountRoomProject(row),
      display_name: row.recent_display_name || row.display_name,
    };
    if (project.kind === "focus" && project.focus_archived_at) {
      continue;
    }
    addCandidate(normalizeAccountRoomCandidate(project, {
      role: "participant",
      source: row.source || "recent",
      pinned: row.pinned,
      archived: row.archived,
      canDelete: row.source === "create_invite",
      directParentAccess: project.kind === "main" && recentSourceHasDirectParentAccess(row.source || "recent"),
      firstOpenedAt: row.first_opened_at,
      lastOpenedAt: row.last_opened_at,
    }));
  }

  const parentRoomIds = new Set<string>();
  const directParentRoomIds = new Set<string>();
  const directFocusRoomIds = new Set<string>();
  const parentCandidates = new Map<string, AccountRoomCandidate>();
  const hiddenParentRoomIds = new Set<string>();

  if (!options.includeArchived) {
    for (const candidate of candidatesByRoomId.values()) {
      if (candidate.archived && candidate.project.kind === "main") {
        hiddenParentRoomIds.add(candidate.project.id);
      }
    }
  }

  for (const candidate of candidatesByRoomId.values()) {
    if (candidate.archived && !options.includeArchived) {
      continue;
    }

    if (
      candidate.project.kind === "focus"
      && candidate.project.parent_room_id
      && hiddenParentRoomIds.has(candidate.project.parent_room_id)
    ) {
      continue;
    }

    if (candidate.project.kind === "main") {
      parentRoomIds.add(candidate.project.id);
      if (candidate.directParentAccess) {
        directParentRoomIds.add(candidate.project.id);
      }
      parentCandidates.set(candidate.project.id, candidate);
      continue;
    }

    if (candidate.project.parent_room_id) {
      parentRoomIds.add(candidate.project.parent_room_id);
      directFocusRoomIds.add(candidate.project.id);
    }
  }

  const missingParentIds = [...parentRoomIds].filter((roomId) => !parentCandidates.has(roomId));
  if (missingParentIds.length) {
    const parentRows = await db
      .select(roomSelectColumns)
      .from(rooms)
      .where(inArray(rooms.id, missingParentIds));

    for (const row of parentRows) {
      const parent = toAccountRoomProject(row);
      const focusCandidates = [...candidatesByRoomId.values()].filter(
        (candidate) => candidate.project.parent_room_id === parent.id
      );
      const fallback = focusCandidates.reduce<AccountRoomCandidate | null>(
        (current, candidate) => current ? mergeAccountRoomCandidate(current, candidate) : candidate,
        null
      );
      parentCandidates.set(parent.id, normalizeAccountRoomCandidate(parent, {
        role: fallback?.role ?? "participant",
        source: fallback?.source ?? "focus",
        directParentAccess: fallback?.directParentAccess ?? false,
        firstOpenedAt: fallback?.first_opened_at ?? parent.created_at,
        lastOpenedAt: fallback?.last_opened_at ?? parent.created_at,
      }));
    }
  }

  // A room's name and activity are room data, so the list shows a room, with
  // its focus rooms, only to a person who may open it: a member of a room
  // that is not tied to a repository; for a repo room, a person the cached
  // repository access check allows, or cannot decide yet (GitHub gave no
  // answer). A definite refusal drops the room.
  const dropParent = (roomId: string) => {
    parentCandidates.delete(roomId);
    parentRoomIds.delete(roomId);
  };
  // One batch read each for the room kind and the membership rows; the rule
  // is the access decision's (rooms/access-decision.ts).
  const unboundParentIds = [...parentCandidates.keys()].filter((roomId) => !isRepoBackedRoomId(roomId));
  const [memberRoomIds, bindings] = await Promise.all([
    membershipRoomsReadableBy(accountId, unboundParentIds),
    getGitRoomBindingsForRooms(unboundParentIds),
  ]);
  const repoParentIds: string[] = [];
  for (const [roomId, kind] of classifyTopLevelRoomIds([...parentCandidates.keys()], bindings)) {
    if (kind === "repo") repoParentIds.push(roomId);
    else if (!memberRoomIds.has(roomId)) dropParent(roomId);
  }
  if (repoParentIds.length) {
    const { filterAccountIdsWithRoomAccess } = await import("../server/events.js");
    for (let index = 0; index < repoParentIds.length; index += REPO_ACCESS_CHECK_CONCURRENCY) {
      await Promise.all(repoParentIds.slice(index, index + REPO_ACCESS_CHECK_CONCURRENCY).map(async (roomId) => {
        const access = await filterAccountIdsWithRoomAccess(roomId, [accountId]);
        if (!access.notify.includes(accountId)) dropParent(roomId);
      }));
    }
  }

  const focusRoomsByParentId = new Map<string, AccountRoomListEntry["focus_rooms"]>();
  if (parentRoomIds.size) {
    const focusRows = await db
      .select(roomSelectColumns)
      .from(rooms)
      .where(and(
        eq(rooms.kind, "focus"),
        inArray(rooms.parent_room_id, [...parentRoomIds]),
        sql`${rooms.focus_archived_at} IS NULL`
      ))
      .orderBy(asc(rooms.created_at));

    for (const row of focusRows) {
      const focusRoom = toAccountRoomProject(row);
      const parentRoomId = focusRoom.parent_room_id;
      if (!parentRoomId) {
        continue;
      }

      const focusCandidate = candidatesByRoomId.get(focusRoom.id);
      if (!directParentRoomIds.has(parentRoomId) && !focusCandidate && !directFocusRoomIds.has(focusRoom.id)) {
        continue;
      }

      const parentCandidate = parentCandidates.get(parentRoomId);
      if (!parentCandidate) {
        continue;
      }

      const focusRooms = focusRoomsByParentId.get(parentRoomId) ?? [];
      focusRooms.push(toAccountRoomListFocusRoom(focusRoom, parentCandidate, focusCandidate));
      focusRoomsByParentId.set(parentRoomId, focusRooms);
    }
  }

  const visibleParentCandidates = [...parentCandidates.values()]
    .filter((candidate) => options.includeArchived || !candidate.archived)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const aLastOpened = a.last_opened_at ?? "";
      const bLastOpened = b.last_opened_at ?? "";
      if (aLastOpened !== bLastOpened) return bLastOpened.localeCompare(aLastOpened);
      return a.project.display_name.localeCompare(b.project.display_name);
    })
    .slice(0, limit);

  const latestMessagesByRoomId = await latestMessagesForRooms([
    ...visibleParentCandidates.map((candidate) => candidate.project.id),
    ...visibleParentCandidates.flatMap((candidate) =>
      (focusRoomsByParentId.get(candidate.project.id) ?? []).map((room) => room.room_id)
    ),
  ]);

  return visibleParentCandidates
    .map((candidate) => {
      const deleteReason = accountRoomDeleteReason(candidate);
      const focusRooms = focusRoomsByParentId.get(candidate.project.id) ?? [];
      const latestMessage = latestMessagesByRoomId.get(candidate.project.id) ?? nullLatestRoomMessage();
      return {
        room_id: candidate.project.id,
        display_name: candidate.project.display_name,
        kind: "main",
        role: candidate.role,
        source: candidate.source,
        pinned: candidate.pinned,
        archived: candidate.archived,
        can_leave: true,
        can_delete: !deleteReason,
        delete_reason: deleteReason,
        first_opened_at: candidate.first_opened_at,
        last_opened_at: candidate.last_opened_at,
        latest_message_id: latestMessage.latest_message_id,
        latest_message_at: latestMessage.latest_message_at,
        focus_rooms: focusRooms.map((room) => ({
          ...room,
          ...(latestMessagesByRoomId.get(room.room_id) ?? nullLatestRoomMessage()),
        })),
      };
    });
}

/**
 * Each room's newest message that its members can see, as the room list reports it.
 *
 * Two backward walks per room, each stopping at the first visible message, so
 * the cost follows the number of rooms, not their history:
 * - the id is the highest visible number, read from messages_pk (room_id, number);
 * - the time is the latest visible timestamp, read from
 *   messages_room_timestamp_idx (room_id, timestamp).
 * They are separate walks because the highest number need not carry the
 * latest time (a renamed room can reuse vacant lower numbers; a clock can step
 * back). Both equal the MAX(number) and MAX(timestamp) the list used before.
 * Until the post-migration rollout has built the timestamp index the answer
 * is the same, only slower.
 */
export async function latestMessagesForRooms(roomIds: string[]): Promise<Map<string, LatestRoomMessage>> {
  const uniqueRoomIds = [...new Set(roomIds.filter(Boolean))];
  if (!uniqueRoomIds.length) return new Map();

  const listedRoomIds = sql.join(uniqueRoomIds.map((roomId) => sql`${roomId}`), sql`, `);
  const rows = await db
    .select({
      room_id: sql<string>`listed.room_id`,
      latest_number: sql<number | null>`latest.number`,
      latest_message_at: sql<string | null>`newest.timestamp`,
    })
    .from(sql`unnest(ARRAY[${listedRoomIds}]::text[]) AS listed(room_id)
      CROSS JOIN LATERAL (
        SELECT ${messages.number} AS number
        FROM ${messages}
        WHERE ${messages.room_id} = listed.room_id AND ${visibleMessageCondition()}
        ORDER BY ${messages.number} DESC
        LIMIT 1
      ) AS latest
      CROSS JOIN LATERAL (
        SELECT ${messages.timestamp} AS timestamp
        FROM ${messages}
        WHERE ${messages.room_id} = listed.room_id AND ${visibleMessageCondition()}
        ORDER BY ${messages.timestamp} DESC
        LIMIT 1
      ) AS newest`);

  return new Map(rows.map((row) => [
    row.room_id,
    {
      latest_message_id: row.latest_number ? formatMessageId(row.latest_number) : null,
      latest_message_at: row.latest_message_at,
    },
  ]));
}

function nullLatestRoomMessage(): LatestRoomMessage {
  return {
    latest_message_id: null,
    latest_message_at: null,
  };
}
