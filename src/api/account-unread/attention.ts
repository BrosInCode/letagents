/**
 * "Needs you" for every room an account can read, in one answer.
 *
 * 1. The rooms are the account's room list (`/account/rooms`, up to 100
 *    rooms) and their focus rooms.
 * 2. Each room passes the same check as `GET /rooms/:room/attention`: a room
 *    with a repository asks for repository access, any other room for
 *    membership. A room that fails the check is named in `failures`, with no
 *    content, as the per-room route would answer 401 or 403.
 * 3. A readable room returns what `GET /rooms/:room/attention` returns: its
 *    requests (up to 200) and its blocked or in-review cards.
 * 4. A room where the account is an admin also returns its pending board
 *    intents, as `GET /rooms/:room/board-intents?status=pending` would. A
 *    pending intent lives 24 hours and is always announced by a message, so a
 *    room with no message in 24 hours returns an empty list without a read.
 */
import { and, desc, asc, inArray } from "drizzle-orm";

import { db } from "../db/client.js";
import { listBoardIntents } from "../db/coordination/board-intent-lifecycle.js";
import { listRoomKnowledge } from "../db/room-knowledge.js";
import { getProjectById } from "../db/rooms.js";
import { tasks as tasksTable } from "../db/schema.js";
import { formatTaskId } from "../db/utils.js";
import type { BoardIntent, Project } from "../db/types.js";
import { decideRoomRead, type RoomAccessAccount } from "../rooms/access-decision.js";
import type { KnowledgeRecord } from "../../../shared/room-knowledge.mjs";

const BOARD_INTENT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** Rooms read at once; each room runs its reads one after another, so this bounds the connections used. */
const ROOMS_AT_ONCE = 3;

export interface AccountAttentionRoomInput {
  room_id: string;
  role: "admin" | "participant";
  latest_message_at: string | null;
}

export interface AccountAttentionTask {
  id: string;
  title: string;
  status: string;
  description: string | null;
  updated_at: string;
}

export interface AccountAttentionRoom {
  room_id: string;
  records: KnowledgeRecord[];
  truncated: boolean;
  tasks: AccountAttentionTask[];
  /** Only in rooms where the account is an admin. */
  board_intents?: BoardIntent[];
}

export interface AccountAttention {
  rooms: AccountAttentionRoom[];
  /** Rooms the account cannot read now, or whose check or read failed. */
  failures: Array<{ room_id: string }>;
}

export interface AccountAttentionDeps {
  getProject(roomId: string): Promise<Project | undefined>;
  mayRead(project: Project, account: RoomAccessAccount): Promise<boolean>;
  listRequests: typeof listRoomKnowledge;
  /** Blocked and in-review cards of these rooms, newest change first. */
  getTasks(roomIds: readonly string[]): Promise<Array<AccountAttentionTask & { room_id: string }>>;
  listBoardIntents: typeof listBoardIntents;
  now(): number;
}

/** Only the cards "Needs you" shows, and only the columns it shows, in the per-room route's order. */
export async function getAttentionTasksForRooms(roomIds: readonly string[]): Promise<Array<AccountAttentionTask & { room_id: string }>> {
  if (roomIds.length === 0) return [];
  const rows = await db.select({
    room_id: tasksTable.room_id, number: tasksTable.number, title: tasksTable.title, status: tasksTable.status,
    description: tasksTable.description, updated_at: tasksTable.updated_at,
  }).from(tasksTable)
    .where(and(inArray(tasksTable.room_id, [...roomIds]), inArray(tasksTable.status, ["blocked", "in_review"])))
    .orderBy(desc(tasksTable.updated_at), asc(tasksTable.number));
  return rows.map((row) => ({
    room_id: row.room_id, id: formatTaskId(row.number), title: row.title, status: row.status,
    description: row.description ?? null, updated_at: row.updated_at,
  }));
}

/** The decision `requireGitRoomParticipant` makes for a signed-in person. */
export async function accountMayReadRoom(project: Project, account: RoomAccessAccount): Promise<boolean> {
  return (await decideRoomRead({ project, principal: { kind: "person", account } })).kind === "allow";
}

const defaultDeps: AccountAttentionDeps = {
  getProject: getProjectById,
  mayRead: accountMayReadRoom,
  listRequests: listRoomKnowledge,
  getTasks: getAttentionTasksForRooms,
  listBoardIntents,
  now: Date.now,
};

export async function loadAccountAttention(
  account: RoomAccessAccount,
  rooms: readonly AccountAttentionRoomInput[],
  deps: AccountAttentionDeps = defaultDeps,
): Promise<AccountAttention> {
  const unique = [...new Map(rooms.map((room) => [room.room_id, room])).values()];
  const readable: Array<{ room: AccountAttentionRoomInput; result: AccountAttentionRoom }> = [];
  const failures: Array<{ room_id: string }> = [];
  const queue = [...unique];
  await Promise.all(Array.from({ length: Math.min(ROOMS_AT_ONCE, queue.length) }, async () => {
    for (let room = queue.shift(); room; room = queue.shift()) {
      try {
        const project = await deps.getProject(room.room_id);
        if (!project || !(await deps.mayRead(project, account))) {
          failures.push({ room_id: room.room_id });
          continue;
        }
        const latest = Date.parse(room.latest_message_at ?? "");
        const mayHoldIntents = room.role === "admin"
          && (!Number.isFinite(latest) || deps.now() - latest < BOARD_INTENT_PENDING_TTL_MS);
        // One read at a time per room: at most ROOMS_AT_ONCE connections in use.
        const page = await deps.listRequests(project.id, "attention");
        const intents = room.role !== "admin" ? undefined
          : mayHoldIntents ? await deps.listBoardIntents({ room_id: project.id, status: "pending", limit: 200 }) : [];
        readable.push({ room, result: {
          room_id: project.id, records: page.records, truncated: page.truncated, tasks: [],
          ...(intents ? { board_intents: intents } : {}),
        } });
      } catch (error) {
        console.error("[account attention] room failed", room.room_id, error);
        failures.push({ room_id: room.room_id });
      }
    }
  }));
  // One read for every readable room's cards.
  const tasks = await deps.getTasks(readable.map((entry) => entry.result.room_id));
  const byRoom = new Map<string, AccountAttentionTask[]>();
  for (const task of tasks) {
    const list = byRoom.get(task.room_id) ?? [];
    list.push({ id: task.id, title: task.title, status: task.status, description: task.description, updated_at: task.updated_at });
    byRoom.set(task.room_id, list);
  }
  // In the order of the room list.
  const order = new Map(unique.map((room, index) => [room.room_id, index]));
  readable.sort((a, b) => (order.get(a.room.room_id) ?? 0) - (order.get(b.room.room_id) ?? 0));
  return {
    rooms: readable.map(({ result }) => ({ ...result, tasks: byRoom.get(result.room_id) ?? [] })),
    failures: failures.sort((a, b) => (order.get(a.room_id) ?? 0) - (order.get(b.room_id) ?? 0)),
  };
}
