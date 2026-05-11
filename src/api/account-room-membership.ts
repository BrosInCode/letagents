import { and, asc, eq, inArray, or } from "drizzle-orm";

import { db } from "./db/client.js";
import {
  account_room_recents,
  project_admins,
  room_agent_sessions,
  room_participants,
  rooms,
} from "./db/schema.js";

type RoomKind = "main" | "focus";
type FocusRoomStatus = "active" | "concluded";

export type AccountRoomMembershipRole = "admin" | "participant";

export interface AccountRoomListFocusRoom {
  room_id: string;
  display_name: string;
  kind: "focus";
  parent_room_id: string;
  focus_key: string | null;
  source_task_id: string | null;
  focus_status: FocusRoomStatus | null;
  role: AccountRoomMembershipRole;
  source: string | null;
  first_opened_at: string | null;
  last_opened_at: string | null;
}

export interface AccountRoomListEntry {
  room_id: string;
  display_name: string;
  kind: "main";
  role: AccountRoomMembershipRole;
  source: string | null;
  pinned: boolean;
  archived: boolean;
  first_opened_at: string | null;
  last_opened_at: string | null;
  focus_rooms: AccountRoomListFocusRoom[];
}

type AccountRoomProject = {
  id: string;
  display_name: string;
  kind: RoomKind;
  parent_room_id: string | null;
  focus_key: string | null;
  source_task_id: string | null;
  focus_status: FocusRoomStatus | null;
  created_at: string;
};

type AccountRoomProjectRow = Omit<AccountRoomProject, "kind" | "focus_status"> & {
  kind: string;
  focus_status: string | null;
};

type AccountRoomCandidate = {
  project: AccountRoomProject;
  role: AccountRoomMembershipRole;
  source: string | null;
  pinned: boolean;
  archived: boolean;
  first_opened_at: string | null;
  last_opened_at: string | null;
};

const roomSelectColumns = {
  id: rooms.id,
  display_name: rooms.display_name,
  kind: rooms.kind,
  parent_room_id: rooms.parent_room_id,
  focus_key: rooms.focus_key,
  source_task_id: rooms.source_task_id,
  focus_status: rooms.focus_status,
  created_at: rooms.created_at,
};

function toAccountRoomProject(row: AccountRoomProjectRow): AccountRoomProject {
  return {
    id: row.id,
    display_name: row.display_name,
    kind: row.kind as RoomKind,
    parent_room_id: row.parent_room_id,
    focus_key: row.focus_key,
    source_task_id: row.source_task_id,
    focus_status: row.focus_status as FocusRoomStatus | null,
    created_at: row.created_at,
  };
}

function earlierTimestamp(current: string | null, next: string | null): string | null {
  if (!current) return next;
  if (!next) return current;
  return next < current ? next : current;
}

function laterTimestamp(current: string | null, next: string | null): string | null {
  if (!current) return next;
  if (!next) return current;
  return next > current ? next : current;
}

function mergeAccountRoomCandidate(
  existing: AccountRoomCandidate,
  next: AccountRoomCandidate
): AccountRoomCandidate {
  return {
    project: existing.project,
    role: existing.role === "admin" || next.role === "admin" ? "admin" : "participant",
    source: existing.source || next.source,
    pinned: existing.pinned || next.pinned,
    archived: existing.archived || next.archived,
    first_opened_at: earlierTimestamp(existing.first_opened_at, next.first_opened_at),
    last_opened_at: laterTimestamp(existing.last_opened_at, next.last_opened_at),
  };
}

function normalizeAccountRoomCandidate(
  project: AccountRoomProject,
  options: {
    role: AccountRoomMembershipRole;
    source?: string | null;
    pinned?: boolean;
    archived?: boolean;
    firstOpenedAt?: string | null;
    lastOpenedAt?: string | null;
  }
): AccountRoomCandidate {
  const firstOpenedAt = options.firstOpenedAt ?? options.lastOpenedAt ?? project.created_at;
  const lastOpenedAt = options.lastOpenedAt ?? options.firstOpenedAt ?? project.created_at;
  return {
    project,
    role: options.role,
    source: options.source ?? null,
    pinned: Boolean(options.pinned),
    archived: Boolean(options.archived),
    first_opened_at: firstOpenedAt,
    last_opened_at: lastOpenedAt,
  };
}

function toAccountRoomListFocusRoom(
  focusRoom: AccountRoomProject,
  parentCandidate: AccountRoomCandidate,
  focusCandidate: AccountRoomCandidate | undefined
): AccountRoomListFocusRoom {
  return {
    room_id: focusRoom.id,
    display_name: focusRoom.display_name,
    kind: "focus",
    parent_room_id: focusRoom.parent_room_id ?? parentCandidate.project.id,
    focus_key: focusRoom.focus_key,
    source_task_id: focusRoom.source_task_id,
    focus_status: focusRoom.focus_status,
    role: focusCandidate?.role ?? parentCandidate.role,
    source: focusCandidate?.source ?? null,
    first_opened_at: focusCandidate?.first_opened_at ?? null,
    last_opened_at: focusCandidate?.last_opened_at ?? null,
  };
}

export async function upsertAccountRoomRecent(input: {
  accountId: string;
  roomId: string;
  displayName?: string | null;
  source?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(account_room_recents)
    .values({
      account_id: input.accountId,
      room_id: input.roomId,
      display_name: input.displayName ?? null,
      source: input.source ?? null,
      pinned: false,
      archived: false,
      first_opened_at: now,
      last_opened_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [account_room_recents.account_id, account_room_recents.room_id],
      set: {
        display_name: input.displayName ?? null,
        source: input.source ?? null,
        archived: false,
        last_opened_at: now,
        updated_at: now,
      },
    });
}

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

  const adminRows = await db
    .select({
      ...roomSelectColumns,
      assigned_at: project_admins.assigned_at,
    })
    .from(project_admins)
    .innerJoin(rooms, eq(project_admins.project_id, rooms.id))
    .where(eq(project_admins.account_id, accountId));

  for (const row of adminRows) {
    const project = toAccountRoomProject(row);
    addCandidate(normalizeAccountRoomCandidate(project, {
      role: "admin",
      source: "admin",
      firstOpenedAt: row.assigned_at,
      lastOpenedAt: row.assigned_at,
    }));
  }

  if (normalizedLogin) {
    const loginValue = login || normalizedLogin;
    const participantRows = await db
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
      );

    for (const row of participantRows) {
      const project = toAccountRoomProject(row);
      addCandidate(normalizeAccountRoomCandidate(project, {
        role: "participant",
        source: "participant",
        firstOpenedAt: row.last_seen_at,
        lastOpenedAt: row.last_seen_at,
      }));
    }
  }

  const agentSessionRows = await db
    .select({
      ...roomSelectColumns,
      session_created_at: room_agent_sessions.created_at,
      last_seen_at: room_agent_sessions.last_seen_at,
    })
    .from(room_agent_sessions)
    .innerJoin(rooms, eq(room_agent_sessions.room_id, rooms.id))
    .where(eq(room_agent_sessions.owner_account_id, accountId));

  for (const row of agentSessionRows) {
    const project = toAccountRoomProject(row);
    addCandidate(normalizeAccountRoomCandidate(project, {
      role: "participant",
      source: "agent",
      firstOpenedAt: row.session_created_at,
      lastOpenedAt: row.last_seen_at,
    }));
  }

  const recentRows = await db
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
    .where(eq(account_room_recents.account_id, accountId));

  for (const row of recentRows) {
    const project = {
      ...toAccountRoomProject(row),
      display_name: row.recent_display_name || row.display_name,
    };
    addCandidate(normalizeAccountRoomCandidate(project, {
      role: "participant",
      source: row.source || "recent",
      pinned: row.pinned,
      archived: row.archived,
      firstOpenedAt: row.first_opened_at,
      lastOpenedAt: row.last_opened_at,
    }));
  }

  const parentRoomIds = new Set<string>();
  const directParentRoomIds = new Set<string>();
  const directFocusRoomIds = new Set<string>();
  const parentCandidates = new Map<string, AccountRoomCandidate>();

  for (const candidate of candidatesByRoomId.values()) {
    if (candidate.archived && !options.includeArchived) {
      continue;
    }

    if (candidate.project.kind === "main") {
      parentRoomIds.add(candidate.project.id);
      directParentRoomIds.add(candidate.project.id);
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
        firstOpenedAt: fallback?.first_opened_at ?? parent.created_at,
        lastOpenedAt: fallback?.last_opened_at ?? parent.created_at,
      }));
    }
  }

  const focusRoomsByParentId = new Map<string, AccountRoomListFocusRoom[]>();
  if (parentRoomIds.size) {
    const focusRows = await db
      .select(roomSelectColumns)
      .from(rooms)
      .where(and(eq(rooms.kind, "focus"), inArray(rooms.parent_room_id, [...parentRoomIds])))
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

  return [...parentCandidates.values()]
    .filter((candidate) => options.includeArchived || !candidate.archived)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const aLastOpened = a.last_opened_at ?? "";
      const bLastOpened = b.last_opened_at ?? "";
      if (aLastOpened !== bLastOpened) return bLastOpened.localeCompare(aLastOpened);
      return a.project.display_name.localeCompare(b.project.display_name);
    })
    .slice(0, limit)
    .map((candidate) => ({
      room_id: candidate.project.id,
      display_name: candidate.project.display_name,
      kind: "main",
      role: candidate.role,
      source: candidate.source,
      pinned: candidate.pinned,
      archived: candidate.archived,
      first_opened_at: candidate.first_opened_at,
      last_opened_at: candidate.last_opened_at,
      focus_rooms: focusRoomsByParentId.get(candidate.project.id) ?? [],
    }));
}
