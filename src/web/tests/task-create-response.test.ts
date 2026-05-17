import assert from 'node:assert/strict'
import test from 'node:test'

Object.assign(globalThis, {
  localStorage: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
})

const { mergeCreatedTask, taskFromCreateTaskResponse } = await import('../src/composables/useRoom')

const task = {
  id: 'task_123',
  title: 'Refresh board after create',
  status: 'proposed',
}

test('taskFromCreateTaskResponse accepts legacy nested task payloads', () => {
  assert.equal(taskFromCreateTaskResponse({ task }), task)
})

test('taskFromCreateTaskResponse accepts current top-level task payloads', () => {
  assert.equal(taskFromCreateTaskResponse(task), task)
})

test('taskFromCreateTaskResponse rejects non-task payloads', () => {
  assert.equal(taskFromCreateTaskResponse({ ok: true }), null)
})

test('mergeCreatedTask preserves a created task after stale refresh results', () => {
  assert.deepEqual(
    mergeCreatedTask([], task),
    [task],
  )
})

test('mergeCreatedTask replaces the optimistic task without duplicating it', () => {
  const optimisticTask = { ...task, title: 'Optimistic title' }

  assert.deepEqual(
    mergeCreatedTask([optimisticTask], task),
    [task],
  )
})
