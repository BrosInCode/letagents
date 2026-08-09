import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'

import type { RoomTask } from '../src/composables/useRoom'
import { useTaskGroups } from '../src/components/room/task-board/model'
import {
  TASK_STATUS_LABELS,
  TASK_STATUS_ORDER,
  taskStatusAccent,
  taskStatusLabel,
} from '../src/domain/taskStatus'

test('task lifecycle presentation covers every canonical status in order', () => {
  assert.deepEqual(TASK_STATUS_ORDER, [
    'proposed',
    'accepted',
    'assigned',
    'in_progress',
    'blocked',
    'in_review',
    'merged',
    'done',
    'cancelled',
  ])

  for (const status of TASK_STATUS_ORDER) {
    assert.ok(TASK_STATUS_LABELS[status])
    assert.match(taskStatusAccent(status), /^var\(--task-/)
  }
})

test('task lifecycle presentation keeps unknown values readable', () => {
  assert.equal(taskStatusLabel('waiting_on_owner'), 'waiting on owner')
  assert.equal(taskStatusAccent('waiting_on_owner'), 'var(--text-tertiary)')
})

test('task groups keep populated canonical statuses first without empty runway columns', () => {
  const task = (id: string, status: string): RoomTask => ({
    id,
    title: id,
    description: '',
    status,
    assignee: null,
    assignee_agent_key: null,
    created_by: null,
    pr_url: null,
    workflow_artifacts: [],
    workflow_refs: [],
    created_at: '2026-08-09T00:00:00.000Z',
    updated_at: '2026-08-09T00:00:00.000Z',
    active_leases: [],
    active_locks: [],
  })
  const groups = useTaskGroups(ref([
    task('task_1', 'accepted'),
    task('task_2', 'waiting_on_owner'),
  ]))

  assert.deepEqual(groups.value.map(group => group.status), [
    'accepted',
    'waiting_on_owner',
  ])
})
