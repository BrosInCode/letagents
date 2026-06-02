<template>
  <DesktopSurfacePage data-testid="diagnostics-view">
    <DesktopSurfaceIntro
      kicker="Diagnostics"
      title="Keep the app easy to trust."
      description="Connection details, setup status, and helpful recovery notes belong here, not scattered through the rest of the app."
    />

    <DesktopSurfaceList data-testid="diagnostics-list">
      <DesktopSurfaceRow
        v-for="note in notes"
        :key="note"
        single-line
        :data-testid="`diagnostic-note-${slugify(note)}`"
      >
        <p class="surface-title">{{ note }}</p>
      </DesktopSurfaceRow>
    </DesktopSurfaceList>
  </DesktopSurfacePage>
</template>

<script setup lang="ts">
import DesktopSurfaceIntro from "./ui/DesktopSurfaceIntro.vue";
import DesktopSurfaceList from "./ui/DesktopSurfaceList.vue";
import DesktopSurfacePage from "./ui/DesktopSurfacePage.vue";
import DesktopSurfaceRow from "./ui/DesktopSurfaceRow.vue";

defineProps<{
  notes: string[];
}>();

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
</script>
