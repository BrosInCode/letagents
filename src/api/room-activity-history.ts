import type { Project, RoomParticipant, Task } from "./db.js";
import type { TaskWorkflowRef } from "./repo-workflow.js";

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
    hidden_at: string | null;
    hidden_by: string | null;
  };
  first_seen_at: string;
  last_seen_at: string;
  current_tasks: RoomActivityHistoryTaskSummary[];
  completed_tasks: RoomActivityHistoryTaskSummary[];
  created_tasks: RoomActivityHistoryTaskSummary[];
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

function sortTasksByUpdated(tasks: readonly Task[]): Task[] {
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

function toTaskSummary(task: Task): RoomActivityHistoryTaskSummary {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    updated_at: task.updated_at,
    workflow_refs: task.workflow_refs,
  };
}

function participantMatchesAssignee(participant: RoomParticipant, task: Task): boolean {
  if (participant.kind === "agent") {
    const assigneeAgentKey = normalize(task.assignee_agent_key);
    if (assigneeAgentKey && assigneeAgentKey === normalize(participant.agent_key)) {
      return true;
    }

    const assignee = normalize(task.assignee);
    return Boolean(
      assignee
      && (assignee === normalize(participant.actor_label) || assignee === normalize(participant.display_name))
    );
  }

  const assignee = normalize(task.assignee);
  return Boolean(
    assignee
    && (assignee === normalize(participant.github_login) || assignee === normalize(participant.display_name))
  );
}

function participantMatchesCreator(participant: RoomParticipant, task: Task): boolean {
  const createdBy = normalize(task.created_by);
  if (!createdBy) {
    return false;
  }

  if (participant.kind === "agent") {
    return createdBy === normalize(participant.actor_label)
      || createdBy === normalize(participant.display_name);
  }

  return createdBy === normalize(participant.github_login)
    || createdBy === normalize(participant.display_name);
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
    return cached;
  }

  return buildHistorySearchText({
    roomDisplayName: entry.room.display_name,
    roomId: entry.room.id,
    participantDisplayName: entry.participant.display_name,
    actorLabel: entry.participant.actor_label,
    githubLogin: entry.participant.github_login,
    ownerLabel: entry.participant.owner_label,
    ideLabel: entry.participant.ide_label,
    currentTasks: entry.current_tasks,
    completedTasks: entry.completed_tasks,
    createdTasks: entry.created_tasks,
  });
}

export function buildRoomActivityHistoryEntries(input: {
  rooms: readonly Project[];
  participants: readonly RoomParticipant[];
  tasks: readonly Task[];
}): RoomActivityHistoryEntry[] {
  const roomsById = new Map(input.rooms.map((room) => [room.id, room]));
  const tasksByRoom = new Map<string, Task[]>();

  for (const task of input.tasks) {
    const existing = tasksByRoom.get(task.room_id);
    if (existing) {
      existing.push(task);
      continue;
    }
    tasksByRoom.set(task.room_id, [task]);
  }

  return input.participants
    .map((participant) => {
      const room = roomsById.get(participant.room_id);
      if (!room) {
        return null;
      }

      const roomTasks = tasksByRoom.get(room.id) ?? [];
      const assignedTasks = roomTasks.filter((task) => participantMatchesAssignee(participant, task));
      const currentTasks = sortTasksByUpdated(
        assignedTasks.filter((task) =>
          ["proposed", "accepted", "assigned", "in_progress", "blocked", "in_review"].includes(task.status)
        )
      );
      const completedTasks = sortTasksByUpdated(
        assignedTasks.filter((task) => ["merged", "done"].includes(task.status))
      );
      const createdTasks = sortTasksByUpdated(
        roomTasks.filter((task) => participantMatchesCreator(participant, task))
      );

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
          hidden_at: participant.hidden_at,
          hidden_by: participant.hidden_by,
        },
        first_seen_at: participant.created_at,
        last_seen_at: latestTimestamp(
          participant.last_seen_at,
          currentTasks[0]?.updated_at,
          completedTasks[0]?.updated_at,
          createdTasks[0]?.updated_at
        ),
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
          currentTasks,
          completedTasks,
          createdTasks,
        }),
        enumerable: false,
      });

      return entry;
    })
    .filter((entry): entry is RoomActivityHistoryEntry => entry !== null)
    .sort((left, right) => {
      const leftTime = Date.parse(left.last_seen_at);
      const rightTime = Date.parse(right.last_seen_at);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return rightTime - leftTime;
      }

      const roomDelta = left.room.display_name.localeCompare(right.room.display_name);
      if (roomDelta !== 0) {
        return roomDelta;
      }

      return left.participant.display_name.localeCompare(right.participant.display_name);
    });
}

export function filterRoomActivityHistoryEntries(
  entries: readonly RoomActivityHistoryEntry[],
  options?: {
    kind?: RoomActivityHistoryKind;
    query?: string | null;
  }
): RoomActivityHistoryEntry[] {
  const kind = options?.kind ?? "all";
  const query = normalize(options?.query);

  return entries.filter((entry) => {
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
