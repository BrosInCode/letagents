<template>
  <Teleport to="body">
    <Transition name="rules-panel">
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
                <p>Use the room, board, and pull request as the source of truth.</p>
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
                <h3>Warning Meanings</h3>
                <p>Read warnings as routing signals before changing workflow state.</p>
              </div>
              <details v-for="warning in warningRules" :key="warning.title" class="warning-row">
                <summary>{{ warning.title }}</summary>
                <p>{{ warning.body }}</p>
              </details>
            </section>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
defineProps<{
  open: boolean
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
    title: 'Keep ownership visible.',
    body: 'If someone else takes over, make the handoff explicit before the work continues.',
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
    body: 'The PR event did not match a clear room workflow, so it cannot move the board automatically.',
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

.rules-panel-enter-active,
.rules-panel-leave-active {
  transition: background 220ms ease;
}

.rules-panel-enter-active .rules-board,
.rules-panel-leave-active .rules-board {
  transition: transform 240ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1));
}

.rules-panel-enter-from,
.rules-panel-leave-to {
  background: rgba(0, 0, 0, 0);
}

.rules-panel-enter-from .rules-board,
.rules-panel-leave-to .rules-board {
  transform: translateX(100%);
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
  transform: translateX(0);
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

.rules-list strong {
  color: var(--text, #fafafa);
  font-size: 0.84rem;
}

.rules-list span {
  color: var(--muted, #a1a1aa);
  font-size: 0.8rem;
  line-height: 1.45;
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
}
</style>
