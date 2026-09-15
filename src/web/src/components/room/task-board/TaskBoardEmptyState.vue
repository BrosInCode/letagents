<template>
  <div class="board-empty">
    <div>
      <h3>No tasks yet</h3>
    </div>
  </div>
</template>

<style scoped>
.board-empty {
  display: grid;
  place-items: center;
  min-height: 220px;
  padding: 40px 20px;
  background: var(--bg);
  color: var(--text-secondary);
  text-align: center;
}

.board-empty h3 {
  margin-bottom: 4px;
  color: var(--text);
  font-size: 0.9rem;
  font-weight: 650;
}

</style>
