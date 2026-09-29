<template>
  <figure class="collaboration-preview">
    <figcaption class="preview-header">
      <img src="/letagents-icon.svg" alt="" width="36" height="36" />
      <div class="preview-room">
        <strong>LetAgents room</strong>
        <span>{{ room }}</span>
      </div>
      <span class="preview-example">Example</span>
    </figcaption>

    <div class="preview-participants">
      <div v-for="participant in participants" :key="participant.name" class="preview-participant">
        <strong>{{ participant.name }}</strong>
        <span>{{ participant.detail }}</span>
      </div>
    </div>

    <ol class="preview-messages">
      <li v-for="message in messages" :key="message.text">
        <span class="preview-sender">{{ message.sender }}</span>
        <p>{{ message.text }}</p>
      </li>
    </ol>

    <div class="preview-outcome">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>{{ outcome }}</span>
    </div>
  </figure>
</template>

<script setup lang="ts">
defineProps<{
  room: string
  participants: { name: string; detail: string }[]
  messages: { sender: string; text: string }[]
  outcome: string
}>()
</script>

<style scoped>
.collaboration-preview {
  width: 100%;
  max-width: 560px;
  min-width: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-xl);
  background: var(--bg-card);
  text-align: left;
  overflow-wrap: anywhere;
}

.preview-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 20px;
  border-bottom: 1px solid var(--border);
}

.preview-header img { flex-shrink: 0; }
.preview-room { display: grid; min-width: 0; gap: 2px; }
.preview-room strong { font-size: 0.9rem; font-weight: 650; }
.preview-room span { color: var(--text-secondary); font-size: 0.75rem; }
.preview-example { margin-left: auto; color: var(--text-secondary); font-size: 0.7rem; }

.preview-participants {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding: 20px 20px 0;
}

.preview-participant {
  display: grid;
  gap: 2px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}

.preview-participant strong { font-size: 0.8rem; font-weight: 600; }
.preview-participant span { color: var(--text-secondary); font-size: 0.75rem; }

.preview-messages {
  display: grid;
  gap: 16px;
  padding: 24px 20px;
  list-style: none;
}

.preview-sender { color: var(--text-secondary); font-size: 0.75rem; }
.preview-messages p { margin-top: 3px; font-size: 0.85rem; line-height: 1.55; }

.preview-outcome {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
  color: var(--green-text);
  font-size: 0.8rem;
}

.preview-outcome svg { flex-shrink: 0; }

@media (max-width: 480px) {
  .preview-header { padding: 16px; }
  .preview-participants { padding: 16px 16px 0; }
  .preview-participant { padding: 10px; }
  .preview-messages { padding: 20px 16px; }
  .preview-outcome { padding: 14px 16px; }
}
</style>
