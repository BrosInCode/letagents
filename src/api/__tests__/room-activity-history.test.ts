import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRoomActivityHistoryEntries,
  filterRoomActivityHistoryEntries,
  paginateRoomActivityHistoryEntries,
  sortRoomActivityHistoryEntries,
} from "../room-activity-history.js";
import type { Project, RoomParticipant, Task } from "../db.js";

const rooms: Project[] = [
  {
    id: "github.com/BrosInCode/letagents",
    code: null,
    display_name: "LetAgents",
    name: "github.com/BrosInCode/letagents",
    kind: "main",
    parent_room_id: null,
    focus_key: null,
    source_task_id: null,
    focus_status: null,
    focus_parent_visibility: null,
    focus_activity_scope: null,
    focus_github_event_routing: null,
    concluded_at: null,
    conclusion_summary: null,
    created_at: "2026-04-21T10:00:00.000Z",
  },
  {
    id: "focus_14",
    code: "ABCD-1234",
    display_name: "Attachment Work",
    kind: "focus",
    parent_room_id: "github.com/BrosInCode/letagents",
    focus_key: "task_142",
    source_task_id: "task_142",
    focus_status: "active",
    focus_parent_visibility: null,
    focus_activity_scope: null,
    focus_github_event_routing: null,
    concluded_at: null,
    conclusion_summary: null,
    created_at: "2026-04-21T10:05:00.000Z",
  } as Project,
];

const participants: RoomParticipant[] = [
  {
    room_id: "github.com/BrosInCode/letagents",
    participant_key: "agent:thicket",
    kind: "agent",
    actor_label: "Thicket | EmmyMay's agent | Codex",
    agent_key: "emmymay/thicket",
    github_login: null,
    display_name: "Thicket",
    owner_label: "EmmyMay",
    ide_label: "Codex",
    hidden_at: null,
    hidden_by: null,
    last_seen_at: "2026-04-21T12:00:00.000Z",
    last_room_activity_at: "2026-04-21T12:00:00.000Z",
    last_live_heartbeat_at: null,
    activity_state: null,
    source_flags: [],
    created_at: "2026-04-21T10:10:00.000Z",
    updated_at: "2026-04-21T12:00:00.000Z",
  },
  {
    room_id: "focus_14",
    participant_key: "agent:maple",
    kind: "agent",
    actor_label: "Maple | EmmyMay's agent | Codex",
    agent_key: "emmymay/maple",
    github_login: null,
    display_name: "Maple",
    owner_label: "EmmyMay",
    ide_label: "Codex",
    hidden_at: "2026-04-21T13:00:00.000Z",
    hidden_by: "EmmyMay",
    last_seen_at: "2026-04-21T11:30:00.000Z",
    last_room_activity_at: "2026-04-21T11:30:00.000Z",
    last_live_heartbeat_at: null,
    activity_state: null,
    source_flags: [],
    created_at: "2026-04-21T10:20:00.000Z",
    updated_at: "2026-04-21T13:00:00.000Z",
  },
];

const tasks: Task[] = [
  {
    id: "task_142",
    room_id: "focus_14",
    title: "Attachment history",
    description: "",
    status: "in_review",
    assignee: "Maple | EmmyMay's agent | Codex",
    assignee_agent_key: "emmymay/maple",
    created_by: "EmmyMay",
    source_message_id: null,
    pr_url: null,
    workflow_artifacts: [],
    workflow_refs: [],
    created_at: "2026-04-21T10:25:00.000Z",
    updated_at: "2026-04-21T11:45:00.000Z",
  },
  {
    id: "task_141",
    room_id: "github.com/BrosInCode/letagents",
    title: "Spinner polish",
    description: "",
    status: "done",
    assignee: "Thicket | EmmyMay's agent | Codex",
    assignee_agent_key: "emmymay/thicket",
    created_by: "EmmyMay",
    source_message_id: null,
    pr_url: null,
    workflow_artifacts: [],
    workflow_refs: [],
    created_at: "2026-04-21T10:30:00.000Z",
    updated_at: "2026-04-21T12:30:00.000Z",
  },
];

test("buildRoomActivityHistoryEntries maps room-participant history with task summaries", () => {
  const entries = buildRoomActivityHistoryEntries({ rooms, participants, tasks });

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.participant.display_name, "Thicket");
  assert.equal(entries[0]?.completed_tasks[0]?.id, "task_141");
  assert.equal(entries[1]?.participant.hidden_by, "EmmyMay");
  assert.equal(entries[1]?.current_tasks[0]?.id, "task_142");
});

test("filterRoomActivityHistoryEntries matches room, participant, and task search text", () => {
  const entries = buildRoomActivityHistoryEntries({ rooms, participants, tasks });

  assert.equal(filterRoomActivityHistoryEntries(entries, { query: "attachment" }).length, 1);
  assert.equal(filterRoomActivityHistoryEntries(entries, { kind: "human" }).length, 0);
  assert.equal(filterRoomActivityHistoryEntries(entries, { kind: "agent", query: "spinner" }).length, 1);
  assert.equal(filterRoomActivityHistoryEntries(entries, { roomId: "focus_14" }).length, 1);
  assert.equal(filterRoomActivityHistoryEntries(entries, { roomId: "github.com/BrosInCode/letagents" })[0]?.participant.display_name, "Thicket");
});

test("filterRoomActivityHistoryEntries searches tasks beyond the displayed top five", () => {
  const extendedTasks: Task[] = [
    ...tasks,
    ...Array.from({ length: 6 }, (_, index) => {
      const hour = String(15 - index).padStart(2, "0");
      return {
        id: `task_archive_${index + 1}`,
        room_id: "github.com/BrosInCode/letagents",
        title: index === 5 ? "Legacy archive migration" : `Recent archive ${index + 1}`,
        description: "",
        status: "done",
        assignee: "Thicket | EmmyMay's agent | Codex",
        assignee_agent_key: "emmymay/thicket",
        created_by: "EmmyMay",
        source_message_id: null,
        pr_url: null,
        workflow_artifacts: [],
        workflow_refs: [],
        created_at: `2026-04-21T${hour}:00:00.000Z`,
        updated_at: `2026-04-21T${hour}:30:00.000Z`,
      };
    }),
  ];

  const entries = buildRoomActivityHistoryEntries({ rooms, participants, tasks: extendedTasks });
  const thicketEntry = entries.find((entry) => entry.participant.display_name === "Thicket");

  assert.ok(thicketEntry);
  assert.equal(thicketEntry.completed_tasks.length, 5);
  assert.equal(filterRoomActivityHistoryEntries(entries, { query: "legacy archive migration" }).length, 1);
});

test("buildRoomActivityHistoryEntries sorts by canonical last-seen time, not task churn", () => {
  const entries = buildRoomActivityHistoryEntries({
    rooms,
    participants: [
      ...participants,
      {
        room_id: "github.com/BrosInCode/letagents",
        participant_key: "agent:cedar",
        kind: "agent",
        actor_label: "Cedar | EmmyMay's agent | Codex",
        agent_key: "emmymay/cedar",
        github_login: null,
        display_name: "Cedar",
        owner_label: "EmmyMay",
        ide_label: "Codex",
        hidden_at: null,
        hidden_by: null,
        last_seen_at: "2026-04-21T11:50:00.000Z",
        last_room_activity_at: "2026-04-21T11:50:00.000Z",
        last_live_heartbeat_at: null,
        activity_state: null,
        source_flags: [],
        created_at: "2026-04-21T10:15:00.000Z",
        updated_at: "2026-04-21T11:50:00.000Z",
      },
    ],
    tasks: [
      ...tasks,
      {
        id: "task_143",
        room_id: "github.com/BrosInCode/letagents",
        title: "Late task churn",
        description: "",
        status: "in_review",
        assignee: "Cedar | EmmyMay's agent | Codex",
        assignee_agent_key: "emmymay/cedar",
        created_by: "EmmyMay",
        source_message_id: null,
        pr_url: null,
        workflow_artifacts: [],
        workflow_refs: [],
        created_at: "2026-04-21T11:55:00.000Z",
        updated_at: "2026-04-21T12:45:00.000Z",
      },
    ],
  });

  assert.equal(entries[0]?.participant.display_name, "Thicket");
  assert.equal(entries[1]?.participant.display_name, "Cedar");
});

test("paginateRoomActivityHistoryEntries returns bounded pages", () => {
  const entries = buildRoomActivityHistoryEntries({ rooms, participants, tasks });
  const paginated = paginateRoomActivityHistoryEntries(entries, { page: 2, pageSize: 1 });

  assert.equal(paginated.total, 2);
  assert.equal(paginated.page_count, 2);
  assert.equal(paginated.page, 2);
  assert.equal(paginated.entries.length, 1);
});

test("sortRoomActivityHistoryEntries reorders decorated entries by last_seen_at", () => {
  const sorted = sortRoomActivityHistoryEntries([
    {
      id: "focus_14:agent:maple",
      room: {
        id: "focus_14",
        display_name: "Attachment Work",
        kind: "focus",
        focus_status: "active",
        source_task_id: "task_142",
      },
      participant: {
        participant_key: "agent:maple",
        kind: "agent",
        actor_label: "Maple | EmmyMay's agent | Codex",
        agent_key: "emmymay/maple",
        github_login: null,
        display_name: "Maple",
        owner_label: "EmmyMay",
        ide_label: "Codex",
        hidden_at: null,
        hidden_by: null,
        last_live_heartbeat_at: null,
        activity_state: "offline",
        source_flags: ["messages"],
      },
      first_seen_at: "2026-04-21T10:20:00.000Z",
      last_seen_at: "2026-04-21T11:40:00.000Z",
      last_room_activity_at: "2026-04-21T12:10:00.000Z",
      current_tasks: [],
      completed_tasks: [],
      created_tasks: [],
    },
    {
      id: "github.com/BrosInCode/letagents:agent:thicket",
      room: {
        id: "github.com/BrosInCode/letagents",
        display_name: "LetAgents",
        kind: "main",
        focus_status: null,
        source_task_id: null,
      },
      participant: {
        participant_key: "agent:thicket",
        kind: "agent",
        actor_label: "Thicket | EmmyMay's agent | Codex",
        agent_key: "emmymay/thicket",
        github_login: null,
        display_name: "Thicket",
        owner_label: "EmmyMay",
        ide_label: "Codex",
        hidden_at: null,
        hidden_by: null,
        last_live_heartbeat_at: null,
        activity_state: "offline",
        source_flags: ["messages"],
      },
      first_seen_at: "2026-04-21T10:10:00.000Z",
      last_seen_at: "2026-04-21T12:00:00.000Z",
      last_room_activity_at: "2026-04-21T12:00:00.000Z",
      current_tasks: [],
      completed_tasks: [],
      created_tasks: [],
    },
  ]);

  assert.equal(sorted[0]?.participant.display_name, "Thicket");
  assert.equal(sorted[1]?.participant.display_name, "Maple");
});
