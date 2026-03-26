<template>
  <div class="team-board-visual">
    <!-- Top: Agent presence -->
    <div class="agents-row">
      <div class="agent-chip" v-for="agent in agents" :key="agent.name"
        :style="{ animationDelay: `${agent.delay}s` }"
      >
        <div class="agent-dot" :style="{ background: agent.color }" />
        <span>{{ agent.name }}</span>
        <span class="agent-status">{{ agent.status }}</span>
      </div>
    </div>

    <!-- Center: Task board -->
    <div class="board">
      <div class="board-column" v-for="col in columns" :key="col.title">
        <div class="board-col-header">
          <span class="board-col-title">{{ col.title }}</span>
          <span class="board-col-count">{{ col.tasks.length }}</span>
        </div>
        <div class="board-tasks">
          <div
            v-for="task in col.tasks"
            :key="task.id"
            class="board-task"
            :style="{ animationDelay: `${task.delay}s` }"
          >
            <span class="task-id">{{ task.id }}</span>
            <span class="task-title">{{ task.title }}</span>
            <div v-if="task.assignee" class="task-assignee">
              <div class="task-dot" :style="{ background: task.color }" />
              {{ task.assignee }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Bottom: Human observer -->
    <div class="human-row">
      <div class="human-chip">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
        <span>You</span>
      </div>
      <span class="human-label">Watching from the browser — real-time updates</span>
    </div>
  </div>
</template>

<script setup lang="ts">
const agents = [
  { name: 'Sage', status: 'reviewing PR #18', color: '#60a5fa', delay: 0 },
  { name: 'Atlas', status: 'writing tests', color: '#4ade80', delay: 0.2 },
  { name: 'Nova', status: 'idle', color: '#a78bfa', delay: 0.4 },
]

const columns = [
  {
    title: 'Accepted',
    tasks: [
      { id: 'T-5', title: 'Add search', assignee: null, color: null, delay: 0.1 },
    ],
  },
  {
    title: 'In Progress',
    tasks: [
      { id: 'T-3', title: 'Auth refactor', assignee: 'Atlas', color: '#4ade80', delay: 0.3 },
      { id: 'T-4', title: 'Landing redesign', assignee: 'Nova', color: '#a78bfa', delay: 0.5 },
    ],
  },
  {
    title: 'In Review',
    tasks: [
      { id: 'T-2', title: 'Rate limiting', assignee: 'Sage', color: '#60a5fa', delay: 0.6 },
    ],
  },
  {
    title: 'Done',
    tasks: [
      { id: 'T-1', title: 'CI pipeline', assignee: 'Sage', color: '#60a5fa', delay: 0.8 },
    ],
  },
]
</script>

<style scoped>
.team-board-visual {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-lg);
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  overflow: hidden;
}

/* Agent presence row */
.agents-row {
  display: flex;
  gap: var(--space-sm);
  flex-wrap: wrap;
}

.agent-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text);
  opacity: 0;
  animation: chipIn 400ms var(--ease-out) forwards;
}

.agent-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  animation: pulse 2s ease-in-out infinite;
}

.agent-status {
  color: var(--text-muted);
  font-weight: 500;
}

/* Board */
.board {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-sm);
}

.board-column {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.board-col-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  margin-bottom: 2px;
}

.board-col-title {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-tertiary);
}

.board-col-count {
  width: 18px;
  height: 18px;
  border-radius: var(--radius-xs);
  background: var(--accent-dim);
  display: grid;
  place-items: center;
  font-size: 0.62rem;
  font-weight: 700;
  color: var(--text-tertiary);
}

.board-task {
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: 4px;
  opacity: 0;
  animation: chipIn 400ms var(--ease-out) forwards;
}

.task-id {
  font-size: 0.62rem;
  font-weight: 700;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.task-title {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text);
}

.task-assignee {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.62rem;
  color: var(--text-tertiary);
}

.task-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

/* Human row */
.human-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding-top: var(--space-sm);
  border-top: 1px solid var(--border);
}

.human-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.2);
  font-size: 0.72rem;
  font-weight: 600;
  color: #fbbf24;
}

.human-label {
  font-size: 0.68rem;
  color: var(--text-muted);
}

@keyframes chipIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@media (max-width: 640px) {
  .board {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
