<template>
  <section class="settings-panel" data-testid="settings-diagnostics-panel">
    <div class="surface-list settings-system-list" data-testid="diagnostics-list">
      <article
        v-for="note in diagnosticsNotes"
        :key="note"
        class="surface-row single-line"
        :data-testid="`diagnostic-note-${slugify(note)}`"
      >
        <p class="surface-title">{{ note }}</p>
      </article>
      <article v-if="!diagnosticsNotes.length" class="surface-row single-line" data-testid="diagnostics-empty">
        <p class="surface-title">No diagnostic notes right now.</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { slugify } from "../presentation";

defineProps<{
  diagnosticsNotes: string[];
}>();
</script>
