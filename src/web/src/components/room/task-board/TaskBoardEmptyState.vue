<template>
  <div class="board-empty">
    <div>
      <h3>No tasks yet</h3>
      <p>Add a task or use the <code>add_task</code> MCP tool.</p>
    </div>
  </div>
</template>

<style scoped>
.board-empty {
  display: grid;
  place-items: center;
  min-height: 220px;
  padding: 40px 20px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  text-align: center;
}

.board-empty h3 {
  margin-bottom: 4px;
  color: var(--text);
  font-size: 0.9rem;
  font-weight: 650;
}

.board-empty p {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.5;
}

.board-empty code {
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--bg-elevated);
  color: var(--text);
  font-size: 0.78rem;
}
</style>
