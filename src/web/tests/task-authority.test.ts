import assert from 'node:assert/strict'
import test from 'node:test'

import type { RoomAgentPresence, RoomTask } from '../src/composables/useRoom'
import {
  formatAuthorityActorName,
  getReachableWorkerCandidates,
  toLeaseActionTarget,
} from '../src/components/room/task-authority/shared'
import {
  getAuthorityState,
  getLeaseArtifacts,
} from '../src/components/room/task-lease-authority/model'
import {
  getReviewCandidates,
  getReviewState,
} from '../src/components/room/task-review-authority/model'

type TaskLease = NonNullable<RoomTask['active_leases']>[number]

function task(overrides: Partial<RoomTask> = {}): RoomTask {
  return {
    id: 'task_1',
    title: 'Ship refactor',
    description: '',
    status: 'in_review',
    assignee: 'Ada | Codex',
    assignee_agent_key: 'ada',
    created_by: null,
    pr_url: null,
    workflow_artifacts: [],
    workflow_refs: [],
    created_at: '2026-05-28T10:00:00.000Z',
    updated_at: '2026-05-28T10:00:00.000Z',
    active_leases: [],
    active_locks: [],
    ...overrides,
  }
}

function lease(overrides: Partial<TaskLease> = {}): TaskLease {
  return {
    id: 'lease_1',
    room_id: 'room_1',
    task_id: 'task_1',
    kind: 'work',
    status: 'active',
    agent_key: 'ada',
    agent_instance_id: 'instance_a',
    agent_session_id: 'session_a',
    actor_label: 'Ada | Codex',
    branch_ref: null,
    pr_url: null,
    output_intent: null,
    ...overrides,
  }
}

function presence(overrides: Partial<RoomAgentPresence> = {}): RoomAgentPresence {
  return {
    room_id: 'room_1',
    actor_label: 'Ada | Codex',
    agent_key: 'ada',
    agent_instance_id: 'instance_a',
    agent_session_id: 'session_a',
    session_kind: 'worker',
    runtime: 'codex',
    display_name: 'Ada',
    owner_label: 'Emmy',
    ide_label: 'Codex',
    status: 'working',
    status_text: null,
    last_heartbeat_at: '2026-05-28T10:00:00.000Z',
    created_at: '2026-05-28T10:00:00.000Z',
    updated_at: '2026-05-28T10:00:00.000Z',
    freshness: 'active',
    activity_state: 'active',
    source_flags: ['delivery', 'presence'],
    liveness_observation: null,
    ...overrides,
  }
}

test('lease authority helpers summarize work lease ownership', () => {
  assert.equal(formatAuthorityActorName('Ada | Codex | Agent'), 'Ada')

  const matchingTask = task({
    active_leases: [
      lease({
        branch_ref: 'codex/refactor',
        output_intent: 'Open PR',
      }),
    ],
  })

  assert.equal(getAuthorityState(matchingTask).state, 'held')
  assert.deepEqual(
    getLeaseArtifacts(matchingTask.active_leases?.[0] ?? null),
    [
      { key: 'branch', label: 'Branch: codex/refactor' },
      { key: 'intent', label: 'Open PR' },
    ],
  )

  assert.equal(
    getAuthorityState(task({
      assignee: 'Grace | Codex',
      assignee_agent_key: 'grace',
      active_leases: [lease()],
    })).state,
    'mismatch',
  )
})

test('reachable worker helpers filter to delivery worker sessions', () => {
  const candidates = getReachableWorkerCandidates([
    presence({ display_name: 'Ada' }),
    presence({
      actor_label: 'Controller',
      agent_key: 'controller',
      agent_session_id: 'controller_session',
      session_kind: 'controller',
      display_name: 'Controller',
    }),
    presence({
      actor_label: 'No delivery',
      agent_key: 'no_delivery',
      agent_session_id: 'session_no_delivery',
      source_flags: ['presence'],
      display_name: 'No delivery',
    }),
    presence({
      actor_label: 'Bob | Codex',
      agent_key: 'bob',
      agent_instance_id: 'instance_b',
      agent_session_id: 'session_b',
      display_name: 'Bob',
    }),
  ])

  assert.deepEqual(candidates.map(candidate => candidate.agent_key), ['Ada', 'Bob'].map(name => name.toLowerCase()))
  assert.deepEqual(toLeaseActionTarget(candidates[1]!), {
    target_actor_key: 'bob',
    target_actor_instance_id: 'instance_b',
    target_agent_session_id: 'session_b',
  })
})

test('review authority helpers exclude work holders and current reviewers', () => {
  const workLease = lease({ agent_key: 'ada', agent_session_id: 'session_a' })
  const reviewLease = lease({
    id: 'review_1',
    kind: 'review',
    agent_key: 'bob',
    agent_instance_id: 'instance_b',
    agent_session_id: 'session_b',
    actor_label: 'Bob | Codex',
  })
  const sourceTask = task({ active_leases: [workLease, reviewLease] })

  assert.equal(getReviewState(sourceTask).state, 'assigned')
  assert.equal(
    getReviewState(task({ active_leases: [workLease, { ...reviewLease, agent_key: 'ada' }] })).state,
    'invalid',
  )

  const candidates = getReviewCandidates(
    [
      presence({ display_name: 'Ada' }),
      presence({
        actor_label: 'Bob | Codex',
        agent_key: 'bob',
        agent_instance_id: 'instance_b',
        agent_session_id: 'session_b',
        display_name: 'Bob',
      }),
      presence({
        actor_label: 'Clio | Codex',
        agent_key: 'clio',
        agent_instance_id: 'instance_c',
        agent_session_id: 'session_c',
        display_name: 'Clio',
      }),
    ],
    workLease,
    [reviewLease],
  )

  assert.deepEqual(candidates.map(candidate => candidate.agent_key), ['clio'])
})
