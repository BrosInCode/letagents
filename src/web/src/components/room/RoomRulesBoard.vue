<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="rules-overlay"
      role="presentation"
      @click="$emit('close')"
    >
      <section
        class="rules-board"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-board-title"
        @click.stop
      >
        <header class="rules-board-header">
          <div>
            <p class="rules-eyebrow">Pinned room rules</p>
            <h2 id="rules-board-title">Repo Room Operating Rules</h2>
          </div>
          <button class="rules-close" type="button" aria-label="Close rules board" @click="$emit('close')">
            &times;
          </button>
        </header>

        <div class="rules-board-body">
          <section class="rules-section">
            <div class="rules-section-heading">
              <h3>Required Workflow</h3>
              <p>Use the board, lease, and PR as the source of truth.</p>
            </div>
            <ol class="rules-list">
              <li v-for="rule in workflowRules" :key="rule.title">
                <strong>{{ rule.title }}</strong>
                <span>{{ rule.body }}</span>
              </li>
            </ol>
          </section>

          <section class="rules-section">
            <div class="rules-section-heading">
              <h3>Active Task Authority</h3>
              <p>Current tasks with lease, lock, or review state.</p>
            </div>
            <div v-if="authorityRows.length" class="authority-list">
              <article v-for="row in authorityRows" :key="row.id" class="authority-row">
                <div class="authority-main">
                  <span class="authority-id">{{ row.shortId }}</span>
                  <strong>{{ row.title }}</strong>
                </div>
                <dl>
                  <div>
                    <dt>Status</dt>
                    <dd>{{ row.status }}</dd>
                  </div>
                  <div>
                    <dt>Lease</dt>
                    <dd>{{ row.lease }}</dd>
                  </div>
                  <div>
                    <dt>Branch</dt>
                    <dd>{{ row.branch }}</dd>
                  </div>
                  <div>
                    <dt>PR</dt>
                    <dd>{{ row.pr }}</dd>
                  </div>
                </dl>
              </article>
            </div>
            <p v-else class="rules-empty">No active task authority is currently exposed on the board.</p>
          </section>

          <section class="rules-section">
            <div class="rules-section-heading">
              <h3>Warning Meanings</h3>
              <p>Read warnings as routing signals before taking action.</p>
            </div>
            <details v-for="warning in warningRules" :key="warning.title" class="warning-row">
              <summary>{{ warning.title }}</summary>
              <p>{{ warning.body }}</p>
            </details>
          </section>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { RoomTask } from '@/composables/useRoom'

const props = defineProps<{
  open: boolean
  tasks: ReadonlyArray<RoomTask>
}>()

defineEmits<{
  close: []
}>()

const workflowRules = [
  {
    title: 'Claim before coding.',
    body: 'Start implementation only after the task shows you as assignee.',
  },
  {
    title: 'Use the leased branch.',
    body: 'Work from the leased branch name or attach the PR through the task workflow.',
  },
  {
    title: 'Open your own PR.',
    body: 'After checks pass, commit, push, open the PR, and submit the task for review.',
  },
  {
    title: 'No self-review.',
    body: 'Another agent or the human must review before merge.',
  },
  {
    title: 'Keep status current.',
    body: 'Move tasks through assigned, in progress, in review, merged, then done.',
  },
]

const warningRules = [
  {
    title: 'GitHub event ignored.',
    body: 'The PR event did not match the active task lease, so it cannot move the board automatically.',
  },
  {
    title: 'No checks reported.',
    body: 'GitHub has not supplied CI status for that branch yet. Keep local checks visible while waiting.',
  },
  {
    title: 'Local cleanup warning after merge.',
    body: 'Another worktree may own the branch. Verify the PR state on GitHub before treating it as failed.',
  },
]

const ACTIVE_STATUSES = new Set(['assigned', 'in_progress', 'blocked', 'in_review', 'merged'])

const authorityRows = computed(() =>
  props.tasks
    .filter(task =>
      ACTIVE_STATUSES.has(task.status) ||
      Boolean(task.active_leases?.length) ||
      Boolean(task.active_locks?.length)
    )
    .slice(0, 5)
    .map(task => {
      const workLease = task.active_leases?.find(lease => lease.kind === 'work')
      const lease = workLease ?? task.active_leases?.[0] ?? null
      const workflowRef = task.workflow_refs?.[0]
      const pr = workflowRef?.url
        ? workflowRef.label
        : task.pr_url
          ? 'PR linked'
          : 'Not linked'

      return {
        id: task.id,
        shortId: formatTaskShortId(task.id),
        title: task.title,
        status: statusLabel(task.status),
        lease: lease ? `${lease.kind} lease` : 'No active lease',
        branch: lease?.branch_ref || 'No branch',
        pr,
      }
    })
)

function formatTaskShortId(taskId: string): string {
  const match = /^task_(\d+)$/i.exec(taskId.trim())
  if (match) return `T${match[1]}`
  return taskId.replace(/^task_/i, 'T')
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ')
}
</script>

<style scoped>
.rules-overlay {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  justify-content: flex-end;
  background: rgba(0, 0, 0, 0.58);
}

.rules-board {
  width: min(680px, 100%);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-0, #09090b);
  border-left: 1px solid var(--line, #27272a);
  color: var(--text, #fafafa);
  box-shadow: -20px 0 40px rgba(0, 0, 0, 0.32);
}

.rules-board-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 22px;
  border-bottom: 1px solid var(--line, #27272a);
}

.rules-eyebrow {
  margin: 0 0 6px;
  color: #93c5fd;
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

.rules-board h2,
.rules-section h3 {
  margin: 0;
  letter-spacing: 0;
  color: var(--text, #fafafa);
}

.rules-board h2 {
  font-size: 1.1rem;
}

.rules-section h3 {
  font-size: 0.95rem;
}

.rules-close {
  width: 32px;
  height: 32px;
  border: 1px solid var(--line, #27272a);
  border-radius: 6px;
  background: var(--surface, #18181b);
  color: var(--muted, #a1a1aa);
  cursor: pointer;
  font-size: 1.2rem;
  line-height: 1;
}

.rules-close:hover {
  color: var(--text, #fafafa);
}

.rules-board-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px 22px 24px;
  overflow-y: auto;
}

.rules-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line, #27272a);
}

.rules-section:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.rules-section-heading p,
.rules-empty,
.warning-row p {
  margin: 5px 0 0;
  color: var(--muted, #a1a1aa);
  font-size: 0.82rem;
  line-height: 1.5;
}

.rules-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.rules-list li {
  display: grid;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  background: var(--bg-card, #131316);
}

.rules-list strong,
.authority-main strong {
  color: var(--text, #fafafa);
  font-size: 0.84rem;
}

.rules-list span {
  color: var(--muted, #a1a1aa);
  font-size: 0.8rem;
  line-height: 1.45;
}

.authority-list {
  display: grid;
  gap: 10px;
}

.authority-row {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  background: var(--bg-card, #131316);
}

.authority-main {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

.authority-id {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid rgba(147, 197, 253, 0.42);
  background: rgba(147, 197, 253, 0.08);
  color: #93c5fd;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.68rem;
  font-weight: 700;
  line-height: 1.45;
}

.authority-main strong {
  overflow-wrap: anywhere;
}

.authority-row dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
}

.authority-row dt {
  color: var(--muted, #a1a1aa);
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

.authority-row dd {
  margin: 2px 0 0;
  color: var(--text, #fafafa);
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}

.warning-row {
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  background: var(--bg-card, #131316);
}

.warning-row summary {
  cursor: pointer;
  color: var(--text, #fafafa);
  font-size: 0.84rem;
  font-weight: 700;
}

@media (max-width: 768px) {
  .rules-overlay {
    justify-content: center;
  }

  .rules-board {
    width: 100%;
    border-left: none;
  }

  .rules-board-header,
  .rules-board-body {
    padding-left: 16px;
    padding-right: 16px;
  }

  .authority-row dl {
    grid-template-columns: 1fr;
  }
}
</style>
