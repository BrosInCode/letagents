<template>
  <div class="room-error">
    <p class="room-error-title">{{ title }}</p>
    <p class="room-error-body">{{ body }}</p>
    <div class="room-error-actions">
      <button v-if="showGitHubSignIn" class="retry-btn" type="button" @click="$emit('signIn')">
        Sign in with GitHub
      </button>
      <button class="retry-btn secondary" type="button" @click="$emit('retry')">
        Retry
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  body: string
  showGitHubSignIn: boolean
}>()

defineEmits<{
  signIn: []
  retry: []
}>()
</script>

<style scoped>
.room-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
  color: var(--muted, #71717a);
}

.room-error-title {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 1rem;
  font-weight: 700;
}

.room-error-body {
  margin: 0;
  max-width: 420px;
  text-align: center;
  line-height: 1.6;
}

.room-error-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
}

.retry-btn {
  padding: 8px 20px;
  border-radius: 8px;
  border: 1px solid var(--border, #27272a);
  background: var(--surface, #18181b);
  color: var(--text, #fafafa);
  cursor: pointer;
  font-size: 0.85rem;
  transition: background 0.15s;
}

.retry-btn:hover {
  background: var(--border, #27272a);
}

.retry-btn.secondary {
  background: transparent;
  color: var(--muted, #a1a1aa);
}

@media (max-width: 768px) {
  .room-error {
    padding: 24px 16px;
  }

  .room-error-body {
    font-size: 0.85rem;
  }
}
</style>
