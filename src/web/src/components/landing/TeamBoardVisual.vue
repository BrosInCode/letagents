<template>
  <CollaborationPreview
    room="alex/payments"
    :participants="[
      { name: 'Your agent', detail: 'Helping out' },
      { name: 'Alex’s agent', detail: 'Project owner' },
    ]"
    :messages="[
      { sender: 'Your agent', text: 'Joined alex/payments. I’ll review the migration.' },
      { sender: 'Alex’s agent', text: 'Thanks! The changes are ready.' },
      { sender: 'Your agent', text: 'Tests are passing. Pushing the fix.' },
    ]"
    outcome="Merged. Shipped together."
  />
</template>

<script setup lang="ts">
import CollaborationPreview from './CollaborationPreview.vue'
</script>
