import type { Project, RoomParticipant, Task } from "../db.js";
import type { TaskWorkflowRef } from "../repo-workflow.js";
import type {
  RoomActivitySourceFlag,
  RoomAgentActivityState,
} from "../../shared/room-agent-activity.js";

// History needs task identity, matching/search fields and workflow summaries only.
export type RoomActivityHistoryTask = Pick<Task,
  "id" | "room_id" | "title" | "status" | "assignee" | "assignee_agent_key"
  | "created_by" | "updated_at" | "workflow_refs"
>;

export type RoomActivityHistoryKind = "all" | "agent" | "human";

export interface RoomActivityHistoryTaskSummary {
  id: string;
  title: string;
  status: string;
  updated_at: string;
  workflow_refs: readonly TaskWorkflowRef[];
}

export interface RoomActivityHistoryEntry {
  id: string;
  room: {
    id: string;
    display_name: string;
    kind: Project["kind"];
    focus_status: Project["focus_status"];
    source_task_id: string | null;
  };
  participant: {
    participant_key: string;
    kind: RoomParticipant["kind"];
    actor_label: string | null;
    agent_key: string | null;
    github_login: string | null;
    display_name: string;
    owner_label: string | null;
    ide_label: string | null;
    repo_branch: string | null;
    hidden_at: string | null;
    hidden_by: string | null;
    last_live_heartbeat_at: string | null;
    activity_state: RoomAgentActivityState | null;
    source_flags: RoomActivitySourceFlag[];
  };
  first_seen_at: string;
  last_seen_at: string;
  last_room_activity_at: string;
  message_count: number;
  reasoning_session_count: number;
  current_tasks: RoomActivityHistoryTaskSummary[];
  completed_tasks: RoomActivityHistoryTaskSummary[];
  created_tasks: RoomActivityHistoryTaskSummary[];
}

export interface RoomActivityHistoryActorCount {
  actor_label: string;
  count: number;
}

const SEARCH_TEXT = Symbol("roomActivityHistorySearchText");
type RoomActivityHistoryEntryWithSearch = RoomActivityHistoryEntry & {
  [SEARCH_TEXT]?: string;
};
type SearchableTaskLike = {
  id: string;
  title: string;
  status: string;
};

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function sortTasksByUpdated(tasks: readonly RoomActivityHistoryTask[]): RoomActivityHistoryTask[] {
  return [...tasks].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

function latestTimestamp(...values: Array<string | null | undefined>): string {
  let best = "";
  let bestValue = -1;

  for (const value of values) {
    const parsed = Date.parse(String(value ?? ""));
    if (Number.isFinite(parsed) && parsed > bestValue) {
      bestValue = parsed;
      best = String(value ?? "");
    }
  }

  return best;
}

function toTaskSummary(task: RoomActivityHistoryTask): RoomActivityHistoryTaskSummary {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    updated_at: task.updated_at,
    workflow_refs: task.workflow_refs,
  };
}

function compareRoomActivityHistoryEntries(
  left: RoomActivityHistoryEntry,
  leftTime: number,
  right: RoomActivityHistoryEntry,
  rightTime: number
): number {
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  const roomDelta = left.room.display_name.localeCompare(right.room.display_name);
  if (roomDelta !== 0) {
    return roomDelta;
  }

  return left.participant.display_name.localeCompare(right.participant.display_name);
}

// Each seen time is parsed once: the comparator runs many times per entry.
export function sortRoomActivityHistoryEntries(
  entries: readonly RoomActivityHistoryEntry[]
): RoomActivityHistoryEntry[] {
  return entries
    .map((entry) => ({ entry, time: Date.parse(entry.last_seen_at) }))
    .sort((left, right) => compareRoomActivityHistoryEntries(left.entry, left.time, right.entry, right.time))
    .map(({ entry }) => entry);
}

const CURRENT_TASK_STATUSES: ReadonlySet<string> = new Set([
  "proposed", "accepted", "assigned", "in_progress", "blocked", "in_review",
]);
const COMPLETED_TASK_STATUSES: ReadonlySet<string> = new Set(["merged", "done"]);

/**
 * The tasks of one room under each normalized name that can claim them, so a
 * participant finds its tasks by lookup. Comparing every participant with
 * every task made the history cost participants times tasks on each read.
 */
interface RoomTaskIndex {
  order: Map<RoomActivityHistoryTask, number>;
  byAssignee: Map<string, RoomActivityHistoryTask[]>;
  byAssigneeAgentKey: Map<string, RoomActivityHistoryTask[]>;
  byCreator: Map<string, RoomActivityHistoryTask[]>;
}

function buildRoomTaskIndex(tasks: readonly RoomActivityHistoryTask[]): RoomTaskIndex {
  const index: RoomTaskIndex = {
    order: new Map(),
    byAssignee: new Map(),
    byAssigneeAgentKey: new Map(),
    byCreator: new Map(),
  };
  const add = (map: Map<string, RoomActivityHistoryTask[]>, name: string, task: RoomActivityHistoryTask) => {
    if (!name) return;
    const existing = map.get(name);
    if (existing) existing.push(task);
    else map.set(name, [task]);
  };
  tasks.forEach((task, position) => {
    index.order.set(task, position);
    add(index.byAssignee, normalize(task.assignee), task);
    add(index.byAssigneeAgentKey, normalize(task.assignee_agent_key), task);
    add(index.byCreator, normalize(task.created_by), task);
  });
  return index;
}

/** The tasks under any of the lists, once each, in the room's task order. */
function unionInRoomOrder(
  index: RoomTaskIndex,
  lists: ReadonlyArray<readonly RoomActivityHistoryTask[] | undefined>
): readonly RoomActivityHistoryTask[] {
  const found = [...new Set(lists.filter((list): list is readonly RoomActivityHistoryTask[] => Boolean(list)))];
  if (found.length === 0) return [];
  if (found.length === 1) return found[0];
  return [...new Set(found.flat())].sort((left, right) => index.order.get(left)! - index.order.get(right)!);
}

function tasksAssignedTo(index: RoomTaskIndex, participant: RoomParticipant): readonly RoomActivityHistoryTask[] {
  const displayName = normalize(participant.display_name);
  if (participant.kind === "agent") {
    return unionInRoomOrder(index, [
      index.byAssigneeAgentKey.get(normalize(participant.agent_key)),
      index.byAssignee.get(normalize(participant.actor_label)),
      index.byAssignee.get(displayName),
    ]);
  }

  return unionInRoomOrder(index, [
    index.byAssignee.get(normalize(participant.github_login)),
    index.byAssignee.get(displayName),
  ]);
}

function tasksCreatedBy(index: RoomTaskIndex, participant: RoomParticipant): readonly RoomActivityHistoryTask[] {
  return unionInRoomOrder(index, [
    index.byCreator.get(normalize(participant.kind === "agent" ? participant.actor_label : participant.github_login)),
    index.byCreator.get(normalize(participant.display_name)),
  ]);
}

function buildTaskSearchText(
  tasks: ReadonlyArray<SearchableTaskLike>
): string[] {
  return tasks.flatMap((task) => [task.id, task.title, task.status]);
}

function buildHistorySearchText(input: {
  roomDisplayName: string;
  roomId: string;
  participantDisplayName: string;
  actorLabel: string | null;
  githubLogin: string | null;
  ownerLabel: string | null;
  ideLabel: string | null;
  repoBranch?: string | null;
  currentTasks: ReadonlyArray<SearchableTaskLike>;
  completedTasks: ReadonlyArray<SearchableTaskLike>;
  createdTasks: ReadonlyArray<SearchableTaskLike>;
}): string {
  return [
    input.roomDisplayName,
    input.roomId,
    input.participantDisplayName,
    input.actorLabel,
    input.githubLogin,
    input.ownerLabel,
    input.ideLabel,
    input.repoBranch,
    ...buildTaskSearchText(input.currentTasks),
    ...buildTaskSearchText(input.completedTasks),
    ...buildTaskSearchText(input.createdTasks),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function buildEntrySearchText(entry: RoomActivityHistoryEntry): string {
  const cached = (entry as RoomActivityHistoryEntryWithSearch)[SEARCH_TEXT];
  if (cached) {
    const repoBranch = normalize(entry.participant.repo_branch);
    return repoBranch ? `${cached} ${repoBranch}` : cached;
  }

  return buildHistorySearchText({
    roomDisplayName: entry.room.display_name,
    roomId: entry.room.id,
    participantDisplayName: entry.participant.display_name,
    actorLabel: entry.participant.actor_label,
    githubLogin: entry.participant.github_login,
    ownerLabel: entry.participant.owner_label,
    ideLabel: entry.participant.ide_label,
    repoBranch: entry.participant.repo_branch,
    currentTasks: entry.current_tasks,
    completedTasks: entry.completed_tasks,
    createdTasks: entry.created_tasks,
  });
}

function buildCountMap(counts: readonly RoomActivityHistoryActorCount[]): Map<string, number> {
  const grouped = new Map<string, number>();
  for (const entry of counts) {
    const key = normalize(entry.actor_label);
    if (!key) continue;
    grouped.set(key, (grouped.get(key) ?? 0) + Math.max(0, Number(entry.count) || 0));
  }
  return grouped;
}

function countForParticipant(
  counts: ReadonlyMap<string, number>,
  participant: RoomActivityHistoryEntry["participant"]
): number {
  const keys = new Set([
    normalize(participant.actor_label),
    normalize(participant.display_name),
    normalize(participant.github_login),
  ].filter(Boolean));
  let total = 0;
  for (const key of keys) {
    total += counts.get(key) ?? 0;
  }
  return total;
}

export function buildRoomActivityHistoryEntries(input: {
  rooms: readonly Project[];
  participants: readonly RoomParticipant[];
  tasks: readonly RoomActivityHistoryTask[];
}): RoomActivityHistoryEntry[] {
  const roomsById = new Map(input.rooms.map((room) => [room.id, room]));
  const tasksByRoom = new Map<string, RoomActivityHistoryTask[]>();

  for (const task of input.tasks) {
    const existing = tasksByRoom.get(task.room_id);
    if (existing) {
      existing.push(task);
      continue;
    }
    tasksByRoom.set(task.room_id, [task]);
  }
  const taskIndexByRoom = new Map<string, RoomTaskIndex>();
  const taskIndexFor = (roomId: string): RoomTaskIndex => {
    let index = taskIndexByRoom.get(roomId);
    if (!index) {
      index = buildRoomTaskIndex(tasksByRoom.get(roomId) ?? []);
      taskIndexByRoom.set(roomId, index);
    }
    return index;
  };

  const entries = input.participants
    .map((participant) => {
      const room = roomsById.get(participant.room_id);
      if (!room) {
        return null;
      }

      const taskIndex = taskIndexFor(room.id);
      const assignedTasks = tasksAssignedTo(taskIndex, participant);
      const currentTasks = sortTasksByUpdated(
        assignedTasks.filter((task) => CURRENT_TASK_STATUSES.has(task.status))
      );
      const completedTasks = sortTasksByUpdated(
        assignedTasks.filter((task) => COMPLETED_TASK_STATUSES.has(task.status))
      );
      const createdTasks = sortTasksByUpdated(tasksCreatedBy(taskIndex, participant));

      const entry: RoomActivityHistoryEntryWithSearch = {
        id: `${room.id}:${participant.participant_key}`,
        room: {
          id: room.id,
          display_name: room.display_name,
          kind: room.kind,
          focus_status: room.focus_status,
          source_task_id: room.source_task_id,
        },
        participant: {
          participant_key: participant.participant_key,
          kind: participant.kind,
          actor_label: participant.actor_label,
          agent_key: participant.agent_key,
          github_login: participant.github_login,
          display_name: participant.display_name,
          owner_label: participant.owner_label,
          ide_label: participant.ide_label,
          repo_branch: null,
          hidden_at: participant.hidden_at,
          hidden_by: participant.hidden_by,
          last_live_heartbeat_at: participant.last_live_heartbeat_at,
          activity_state: participant.activity_state,
          source_flags: participant.source_flags,
        },
        first_seen_at: participant.created_at,
        last_seen_at: participant.last_seen_at,
        last_room_activity_at: latestTimestamp(
          participant.last_seen_at,
          currentTasks[0]?.updated_at,
          completedTasks[0]?.updated_at,
          createdTasks[0]?.updated_at
        ),
        message_count: 0,
        reasoning_session_count: 0,
        current_tasks: currentTasks.slice(0, 5).map(toTaskSummary),
        completed_tasks: completedTasks.slice(0, 5).map(toTaskSummary),
        created_tasks: createdTasks.slice(0, 5).map(toTaskSummary),
      };
      Object.defineProperty(entry, SEARCH_TEXT, {
        value: buildHistorySearchText({
          roomDisplayName: room.display_name,
          roomId: room.id,
          participantDisplayName: participant.display_name,
          actorLabel: participant.actor_label,
          githubLogin: participant.github_login,
          ownerLabel: participant.owner_label,
          ideLabel: participant.ide_label,
          repoBranch: null,
          currentTasks,
          completedTasks,
          createdTasks,
        }),
        enumerable: true,
      });

      return entry;
    })
    .filter((entry): entry is RoomActivityHistoryEntry => entry !== null);
  return sortRoomActivityHistoryEntries(entries);
}

export function decorateRoomActivityHistoryEntriesWithCounts(input: {
  entries: readonly RoomActivityHistoryEntry[];
  messageCounts: readonly RoomActivityHistoryActorCount[];
  reasoningSessionCounts: readonly RoomActivityHistoryActorCount[];
}): RoomActivityHistoryEntry[] {
  const messageCounts = buildCountMap(input.messageCounts);
  const reasoningSessionCounts = buildCountMap(input.reasoningSessionCounts);
  return input.entries.map((entry) => ({
    ...entry,
    message_count: countForParticipant(messageCounts, entry.participant),
    reasoning_session_count: countForParticipant(reasoningSessionCounts, entry.participant),
  }));
}

export function filterRoomActivityHistoryEntries(
  entries: readonly RoomActivityHistoryEntry[],
  options?: {
    kind?: RoomActivityHistoryKind;
    query?: string | null;
    roomId?: string | null;
  }
): RoomActivityHistoryEntry[] {
  const kind = options?.kind ?? "all";
  const query = normalize(options?.query);
  const roomId = String(options?.roomId ?? "").trim();

  return entries.filter((entry) => {
    if (roomId && entry.room.id !== roomId) {
      return false;
    }

    if (kind !== "all" && entry.participant.kind !== kind) {
      return false;
    }

    return !query || buildEntrySearchText(entry).includes(query);
  });
}

export function paginateRoomActivityHistoryEntries(
  entries: readonly RoomActivityHistoryEntry[],
  options?: {
    page?: number;
    pageSize?: number;
  }
): {
  entries: RoomActivityHistoryEntry[];
  page: number;
  page_size: number;
  page_count: number;
  total: number;
} {
  const total = entries.length;
  const pageSize = Math.min(Math.max(options?.pageSize ?? 20, 1), 50);
  const pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);
  const page = Math.min(Math.max(options?.page ?? 1, 1), pageCount);
  const start = (page - 1) * pageSize;

  return {
    entries: entries.slice(start, start + pageSize),
    page,
    page_size: pageSize,
    page_count: pageCount,
    total,
  };
}
