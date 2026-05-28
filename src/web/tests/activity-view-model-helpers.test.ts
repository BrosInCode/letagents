import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  RoomActivityHistoryEntry,
  RoomAgentPresence,
  RoomMessage,
  RoomParticipant,
  RoomReasoningSession,
  RoomTask,
  TaskGitHubArtifactStatus,
} from '../src/composables/useRoom'
import {
  getActivityTaskLink,
  reasoningCardSummary,
  reasoningStatusLabel,
} from '../src/components/room/activity/displayHelpers'
import {
  buildHistoryParticipant,
  buildHistoryRoomOptions,
  countHistoryOpenTasks,
  resolveHistoryRoomOption,
} from '../src/components/room/activity/historyModel'
import {
  buildAgentParticipant,
  buildHumanParticipant,
  groupAgentMessagesByActor,
} from '../src/components/room/activity/liveParticipants'

test('live participant helpers group agent messages and build current agent work', () => {
  const actorLabel = 'Noether | Codex'
  const messages = [
    message({ id: 'm1', sender: actorLabel, text: '[status] reviewing PR', source: 'agent' }),
    message({ id: 'm2', sender: 'emmy', text: 'ship it', source: 'browser' }),
  ]
  const grouped = groupAgentMessagesByActor(messages)

  assert.deepEqual([...grouped.keys()], [actorLabel])

  const participant = buildAgentParticipant({
    source: {
      key: 'agent:noether',
      actorLabel,
      participant: roomParticipant({
        kind: 'agent',
        actor_label: actorLabel,
        display_name: 'Noether',
        owner_label: 'Emmy',
        ide_label: 'Codex',
      }),
      presence: presence({
        actor_label: actorLabel,
        status: 'working',
        status_text: 'reviewing PR',
      }),
      activityState: 'active',
    },
    messagesByActor: grouped,
    reasoningSessions: [
      reasoningSession({ id: 'r1', actor_label: actorLabel, status: 'working' }),
      reasoningSession({ id: 'r2', actor_label: actorLabel, status: 'done' }),
    ],
    tasks: [
      task({ id: 'task-1', assignee: actorLabel, status: 'in_progress' }),
      task({ id: 'task-2', created_by: actorLabel, status: 'done' }),
    ],
  })

  assert.equal(participant.label, 'Noether')
  assert.equal(participant.workSignal?.label, 'Working')
  assert.equal(participant.workSignal?.detail, 'reviewing PR')
  assert.deepEqual(participant.currentTasks.map((item) => item.id), ['task-1'])
  assert.deepEqual(participant.createdTasks.map((item) => item.id), ['task-2'])
  assert.deepEqual(participant.activeReasoning.map((item) => item.id), ['r1'])
})

test('live participant helpers build human participants from browser activity', () => {
  const participant = buildHumanParticipant({
    participant: roomParticipant({
      kind: 'human',
      participant_key: 'human:emmy',
      display_name: 'Emmy',
      github_login: 'emmyleke',
    }),
    messages: [
      message({ id: 'm1', sender: 'emmyleke', text: 'reviewed', source: 'browser' }),
      message({ id: 'm2', sender: 'Noether | Codex', text: 'working', source: 'agent' }),
    ],
    tasks: [
      task({ id: 'task-1', assignee: 'emmyleke', status: 'blocked' }),
      task({ id: 'task-2', created_by: 'Emmy', status: 'done' }),
    ],
  })

  assert.equal(participant.kind, 'human')
  assert.equal(participant.messageCount, 1)
  assert.deepEqual(participant.currentTasks.map((item) => item.id), ['task-1'])
  assert.deepEqual(participant.createdTasks.map((item) => item.id), ['task-2'])
})

test('history helpers build room options and participant summaries', () => {
  const historyEntry = activityHistoryEntry({
    participant: {
      kind: 'human',
      display_name: 'Emmy',
      github_login: 'emmyleke',
    },
  })
  const options = buildHistoryRoomOptions({
    currentRoom: {
      id: 'main-id',
      identifier: 'main-room',
      displayName: 'Main Room',
      kind: 'main',
      sourceTaskId: null,
    },
    currentRoomIdentifier: 'main-room',
    focusRooms: [{
      room_id: 'focus-room',
      display_name: 'Focus Room',
      kind: 'focus',
      source_task_id: 'task-1',
    } as never],
  })

  assert.deepEqual(options.map((option) => [option.id, option.label]), [
    ['main-room', 'Main Room'],
    ['focus-room', 'Focus Room'],
  ])
  assert.equal(
    resolveHistoryRoomOption({
      selectedRoomId: '',
      options: [],
      firstHistoryEntry: historyEntry,
    })?.label,
    'History Room',
  )
  assert.equal(buildHistoryParticipant(historyEntry).actorLabel, 'emmyleke')
  assert.equal(countHistoryOpenTasks([historyEntry]), 1)
})

test('activity display helpers preserve task and reasoning labels', () => {
  const linkedTask = task({ id: 'task-1' })
  const ghStatus: Record<string, TaskGitHubArtifactStatus> = {
    'task-1': {
      task_id: 'task-1',
      pr_state: 'open',
      pr_title: 'Split helpers',
      pr_url: 'https://github.com/BrosInCode/letagents/pull/1',
      pr_number: '1',
      pr_author: null,
      pr_actor: null,
      pr_draft: false,
      pr_merged: false,
      checks: [],
    },
  }

  assert.deepEqual(getActivityTaskLink(linkedTask, ghStatus), {
    label: 'PR #1',
    url: 'https://github.com/BrosInCode/letagents/pull/1',
  })
  assert.equal(
    reasoningCardSummary(reasoningSession({
      latest_payload: { checking: 'Reviewing split' },
      summary: 'fallback',
    })),
    'Reviewing split',
  )
  assert.equal(reasoningStatusLabel(reasoningSession({ status: 'in_review' })), 'In Review')
})

function message(overrides: Partial<RoomMessage>): RoomMessage {
  return {
    id: 'message',
    sender: 'sender',
    text: 'text',
    source: 'agent',
    timestamp: '2026-05-28T00:00:00.000Z',
    agent_identity: null,
    ...overrides,
  }
}

function roomParticipant(overrides: Partial<RoomParticipant>): RoomParticipant {
  return {
    participant_key: 'participant',
    kind: 'agent',
    agent_key: null,
    agent_instance_id: null,
    agent_session_id: null,
    actor_label: null,
    github_login: null,
    display_name: null,
    owner_label: null,
    ide_label: null,
    source_flags: [],
    activity_state: null,
    hidden_at: null,
    last_seen_at: '2026-05-28T00:00:00.000Z',
    last_room_activity_at: null,
    ...overrides,
  }
}

function presence(overrides: Partial<RoomAgentPresence>): RoomAgentPresence {
  return {
    agent_session_id: 'session',
    agent_key: 'agent',
    agent_instance_id: null,
    display_name: 'Noether',
    owner_label: null,
    ide_label: null,
    actor_label: null,
    status: 'idle',
    status_text: null,
    session_kind: 'worker',
    source_flags: ['delivery'],
    freshness: 'active',
    activity_state: 'active',
    liveness_observation: null,
    last_heartbeat_at: '2026-05-28T00:00:00.000Z',
    ...overrides,
  }
}

function task(overrides: Partial<RoomTask>): RoomTask {
  return {
    id: 'task',
    title: 'Task',
    description: '',
    status: 'accepted',
    assignee: null,
    assignee_agent_key: null,
    created_by: null,
    pr_url: null,
    workflow_artifacts: [],
    workflow_refs: [],
    created_at: '2026-05-28T00:00:00.000Z',
    updated_at: '2026-05-28T00:00:00.000Z',
    ...overrides,
  }
}

function reasoningSession(overrides: Partial<RoomReasoningSession>): RoomReasoningSession {
  return {
    id: 'reasoning',
    actor_label: 'Noether | Codex',
    status: null,
    summary: null,
    latest_payload: null,
    updates: null,
    entries: null,
    created_at: '2026-05-28T00:00:00.000Z',
    updated_at: '2026-05-28T00:00:00.000Z',
    ...overrides,
  }
}

function activityHistoryEntry(overrides: Partial<RoomActivityHistoryEntry> = {}): RoomActivityHistoryEntry {
  return {
    id: 'history-1',
    room: {
      id: 'history-room',
      display_name: 'History Room',
      kind: 'main',
      source_task_id: null,
    },
    participant: {
      kind: 'agent',
      actor_label: 'Noether | Codex',
      display_name: 'Noether',
      github_login: null,
      owner_label: null,
      ide_label: null,
    },
    first_seen_at: '2026-05-28T00:00:00.000Z',
    last_seen_at: '2026-05-28T01:00:00.000Z',
    current_tasks: [
      {
        id: 'task-1',
        title: 'Current',
        status: 'in_progress',
        workflow_refs: [],
      },
    ],
    completed_tasks: [],
    created_tasks: [],
    ...overrides,
  }
}
