<template>
  <section class="surface-page" data-testid="diagnostics-view">
    <article class="surface-intro">
      <p class="sidebar-label">Diagnostics</p>
      <h3>Keep the app easy to trust.</h3>
      <p>
        Connection details, setup status, and helpful recovery notes belong here, not scattered through the
        rest of the app.
      </p>
    </article>

    <div class="surface-list" data-testid="diagnostics-list">
      <article
        v-for="note in notes"
        :key="note"
        class="surface-row single-line"
        :data-testid="`diagnostic-note-${slugify(note)}`"
      >
        <p class="surface-title">{{ note }}</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  notes: string[];
}>();

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
</script>
