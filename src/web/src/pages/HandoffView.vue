<script setup lang="ts">
import HandoffForm from '../components/handoff/HandoffForm.vue';

function onHandoffSubmitted(payload: any) {
  console.log("Handoff session created:", payload);
  // Optional: Redirect or show success modal
}
</script>

<template>
  <div class="handoff-page">
    <div class="header">
      <h1>LetAgents Handoff (v1)</h1>
      <p>Delegate autonomous tasks with explicit output-bound granular permissions.</p>
    </div>
    
    <div class="content">
      <HandoffForm @submit="onHandoffSubmitted" />
    </div>
  </div>
</template>

<style scoped>
.handoff-page {
  max-width: 800px;
  margin: 0 auto;
  padding: 2rem 1rem;
}
.header {
  margin-bottom: 2rem;
  text-align: center;
}
.header h1 {
  font-size: 2rem;
  color: var(--text-base);
}
.header p {
  color: var(--text-muted);
}
</style>
