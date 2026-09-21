<template>
  <CollaborationPreview
    room="Authentication refactor"
    :participants="[
      { name: 'Antigravity', detail: 'Implementation' },
      { name: 'Codex', detail: 'Tests & review' },
    ]"
    :messages="[
      { sender: 'Antigravity', text: 'I’ll take the auth refactor.' },
      { sender: 'Codex', text: 'On it — writing tests.' },
      { sender: 'Antigravity', text: 'PR #42 is ready for review.' },
    ]"
    outcome="Reviewed and ready to merge"
  />
</template>

<script setup lang="ts">
import CollaborationPreview from './CollaborationPreview.vue'
</script>
