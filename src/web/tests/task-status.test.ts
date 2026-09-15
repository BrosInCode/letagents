import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'

import type { RoomTask } from '../src/composables/useRoom'
import { boardOwnerKey, filterBoardTasks, useTaskGroups } from '../src/components/room/task-board/model'
import { useRoomTaskHandlers } from '../src/pages/room/useRoomTaskHandlers'
import { applyMarkdownTool, taskContentPatch } from '../../../shared/task-markdown-editing.mjs'
import { renderMessageContent } from '../src/components/room/chat-message/formatting'
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

test('board filters separate actionable work from closeout and preserve unknown states', () => {
  const tasks = ['proposed', 'accepted', 'assigned', 'in_progress', 'blocked', 'in_review', 'merged', 'done', 'cancelled', 'waiting_on_owner']
    .map((status, id) => ({ id: `task_${id}`, title: status, status, workflow_refs: [] } as unknown as RoomTask))
  assert.deepEqual(filterBoardTasks(tasks, 'open', '').map(task => task.status),
    ['proposed', 'accepted', 'assigned', 'in_progress', 'blocked', 'in_review', 'waiting_on_owner'])
  assert.deepEqual(filterBoardTasks(tasks, 'review', '').map(task => task.status), ['in_review'])
  assert.deepEqual(filterBoardTasks(tasks, 'closeout', '').map(task => task.status), ['merged', 'done', 'cancelled'])
  assert.equal(filterBoardTasks(tasks, 'all', '').length, tasks.length)
})

test('board search combines the active filter with title, short ID, owner, and workflow links', () => {
  const tasks = [{
    id: 'task_42', title: 'Verify handoff', status: 'in_review', assignee: 'Casey',
    workflow_refs: [{ label: 'PR #1159', url: 'https://github.com/org/repo/pull/1159' }],
  } as unknown as RoomTask]
  for (const query of [' HANDOFF ', 'T42', 'task_42', 'casey', '#1159', 'org/repo']) {
    assert.equal(filterBoardTasks(tasks, 'review', query).length, 1, query)
  }
  assert.equal(filterBoardTasks(tasks, 'closeout', 'Casey').length, 0)
  assert.equal(filterBoardTasks(tasks, 'all', 'missing').length, 0)
})

test('owner and status filters combine with search without mutating task order', () => {
  const tasks = [
    { id: 'task_1', title: 'Zulu', assignee: 'Casey', status: 'accepted', created_at: '2026-01-01', updated_at: '2026-01-03' },
    { id: 'task_2', title: 'Alpha', assignee: null, status: 'accepted', created_at: '2026-01-02', updated_at: '2026-01-04' },
    { id: 'task_3', title: 'Beta', assignee: 'Casey', status: 'in_review', created_at: '2026-01-03', updated_at: '2026-01-05' },
  ] as RoomTask[]
  assert.deepEqual(filterBoardTasks(tasks, 'all', '', { owner: boardOwnerKey(tasks[0]), status: 'in_review' }).map(task => task.id), ['task_3'])
  assert.deepEqual(filterBoardTasks(tasks, 'all', 'alpha', { owner: 'unassigned' }).map(task => task.id), ['task_2'])
  assert.equal(filterBoardTasks(tasks, 'all', 'alpha', { owner: 'owner:Casey' }).length, 0)
  assert.deepEqual(filterBoardTasks(tasks, 'all', '', { sort: 'recent' }).map(task => task.id), ['task_3', 'task_2', 'task_1'])
  assert.deepEqual(filterBoardTasks(tasks, 'all', '', { sort: 'oldest' }).map(task => task.id), ['task_1', 'task_2', 'task_3'])
  assert.deepEqual(filterBoardTasks(tasks, 'all', '', { sort: 'title' }).map(task => task.id), ['task_2', 'task_3', 'task_1'])
  assert.deepEqual(tasks.map(task => task.id), ['task_1', 'task_2', 'task_3'])
})

test('lease mutation callbacks report failure so the open dialog can show an error', async () => {
  const results: boolean[] = []
  const errors: string[] = []
  const handlers = useRoomTaskHandlers({
    addTask: async () => true,
    updateTask: async () => true,
    updateTaskLease: async () => false,
    updateTaskReviewLease: async () => true,
    setTaskStalePromptMute: async () => true,
    toast: { error: message => { errors.push(message) } },
  })
  await handlers.handleTaskLeaseAction({ taskId: 'task_1', action: 'release', onSettled: updated => results.push(Boolean(updated)) })
  await handlers.handleTaskReviewLeaseAction({ taskId: 'task_1', action: 'release', onSettled: updated => results.push(Boolean(updated)) })
  assert.deepEqual(results, [false, true])
  assert.deepEqual(errors, ['Task lease could not be updated.'])
})

test('ticket Markdown tools preserve surrounding text and selected lines', () => {
  assert.deepEqual(applyMarkdownTool('before text after', 7, 11, 'bold'), { value: 'before **text** after', start: 9, end: 13 })
  assert.equal(applyMarkdownTool('first\nsecond\nlast', 0, 13, 'check').value, '- [ ] first\n- [ ] second\nlast')
  assert.equal(applyMarkdownTool('first\nsecond', 0, 12, 'number').value, '1. first\n2. second')
  assert.equal(applyMarkdownTool('\nnext', 0, 0, 'heading').value, '## text\nnext')
  assert.equal(applyMarkdownTool('label', 0, 5, 'link').value, '[label](https://)')
  assert.equal(applyMarkdownTool('const x = 1', 0, 11, 'code').value, '\x60\x60\x60\nconst x = 1\n\x60\x60\x60')
})

test('ticket Markdown preview renders formatting without executing raw HTML or unsafe links', () => {
  const html = renderMessageContent('## Criteria\n- [x] **Checked**\n\n<script>alert(1)</script>\n[unsafe](javascript:alert(1))')
  assert.match(html, /<h2>Criteria<\/h2>/)
  assert.match(html, /type="checkbox" disabled checked/)
  assert.match(html, /<strong>Checked<\/strong>/)
  assert.doesNotMatch(html, /<script|href="javascript:/)
})

test('ticket editing forwards content without changing task status or clearing failed drafts', async () => {
  let patch: Partial<RoomTask> | null = null
  let outcome: boolean | undefined
  const handlers = useRoomTaskHandlers({
    addTask: async () => true,
    updateTask: async (_id, updates) => { patch = updates; return false },
    updateTaskLease: async () => true, updateTaskReviewLease: async () => true,
    setTaskStalePromptMute: async () => true, toast: { error() {} },
  })
  await handlers.handleUpdateTask({
    taskId: 'task_1', ...taskContentPatch({ title: 'Original', description: '**Acceptance**' }, { title: 'Updated ticket', description: '**Acceptance**' }),
    onSettled: updated => { outcome = updated },
  })
  assert.deepEqual(patch, { title: 'Updated ticket', expected_content: { title: 'Original' } })
  assert.equal(outcome, false)
  assert.deepEqual(taskContentPatch({ title: 'Original', description: 'Old' }, { title: 'Original', description: '' }), {
    description: '', expected_content: { description: 'Old' },
  })
})

let vite: ViteDevServer
let TaskBoardCard: object
let TaskBoardTaskDialog: object
let TaskBoard: object
before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom', logLevel: 'silent', server: { middlewareMode: true },
  })
  TaskBoardCard = (await vite.ssrLoadModule('/src/components/room/task-board/TaskBoardCard.vue')).default
  TaskBoardTaskDialog = (await vite.ssrLoadModule('/src/components/room/task-board/TaskBoardTaskDialog.vue')).default
  TaskBoard = (await vite.ssrLoadModule('/src/components/room/TaskBoard.vue')).default
})
after(async () => { await vite?.close() })

test('board filters reuse the shared select with labelled native controls', async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(TaskBoard, {
      tasks: [], presence: [], canManageLeases: false,
      roomIdentifier: 'test-room', taskGithubStatus: {}, selectedTaskId: null,
    }),
  }))
  assert.equal((html.match(/class="app-select"/g) || []).length, 3)
  for (const label of ['Filter by owner', 'Filter by status', 'Sort tasks']) {
    assert.match(html, new RegExp(`<select[^>]*aria-label="${label}"[^>]*class="app-select__control"`))
  }
  assert.match(html, /value="oldest"[^>]*>Oldest first/)
  assert.match(html, /value="done"[^>]*>Done/)
})

function detailTask(): RoomTask {
  return {
    id: 'task_42', title: 'Verify handoff', description: 'Keep the full acceptance criteria.',
    status: 'proposed', assignee: null, assignee_agent_key: null, created_by: 'Casey',
    created_at: '2026-01-01', updated_at: '2026-01-02',
    pr_url: null, workflow_artifacts: [], active_leases: [], active_locks: [],
    workflow_refs: [1, 2, 3].map(number => ({ provider: 'github', kind: 'pull_request', label: `PR #${number}`, url: `https://github.com/org/repo/pull/${number}` })),
  }
}

test('cards expose a keyboard modal trigger, not an expanding details section', async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(TaskBoardCard, { task: detailTask(), updating: false, githubStatus: null }),
  }))
  assert.match(html, /<button[^>]+aria-haspopup="dialog"[^>]+aria-label="Open T42: Verify handoff"/)
  assert.doesNotMatch(html, /<details|<summary|Keep the full acceptance criteria/)
  assert.match(html, />Accept<\/button>/)
  assert.doesNotMatch(html, />Cancel task<\/button>/)
  assert.match(html, /\+1 links/)
})

test('task modal retains description, all links, metadata, and secondary actions', async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(TaskBoardTaskDialog, {
      task: detailTask(), presence: [], canManageLeases: true,
      updating: false, updatingLease: false, updatingReviewLease: false, githubStatus: null,
      error: 'Task could not be updated. Try again.',
    }),
  }))
  assert.match(html, /<dialog[^>]+aria-labelledby=/)
  assert.match(html, /aria-label="Close task"/)
  assert.match(html, /Keep the full acceptance criteria/)
  assert.match(html, /<dt[^>]*>Owner<\/dt>/)
  assert.match(html, /<dt[^>]*>Created by<\/dt><dd[^>]*>Casey<\/dd>/)
  assert.match(html, /PR #3/)
  assert.match(html, />Cancel task<\/button>/)
  assert.match(html, /role="alert"[^>]*>Task could not be updated/)
})
