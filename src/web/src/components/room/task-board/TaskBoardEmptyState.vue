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
  padding: 40px 20px;
  color: var(--muted, #71717a);
  text-align: center;
}

.board-empty h3 {
  margin-bottom: 4px;
  color: var(--text, #fafafa);
  font-size: 0.88rem;
}

.board-empty p {
  font-size: 0.82rem;
  line-height: 1.5;
}

.board-empty code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface, #18181b);
  font-size: 0.78rem;
}
</style>
