<script setup lang="ts">
import { ref } from 'vue';

const branch = ref('main');
const expectedOutcome = ref('draft_pr');

const emit = defineEmits<{
  (e: 'update:target', payload: { branch: string, outcome: string }): void
}>();

function updateState() {
  emit('update:target', { branch: branch.value, outcome: expectedOutcome.value });
}
</script>

<template>
  <div class="target-scope-container">
    <h3>Target Scope & Granular Permissions</h3>
    <div class="form-group">
      <label for="branch">Target Branch</label>
      <input id="branch" v-model="branch" type="text" @input="updateState" />
      <span class="hint">The specific codebase branch to clone for this handoff.</span>
    </div>

    <div class="form-group">
      <label>Expected Outcome (Output-Bound Permission)</label>
      <select v-model="expectedOutcome" @change="updateState">
        <option value="research_note">Research Note</option>
        <option value="comment">Review / Comment</option>
        <option value="draft_pr">Draft PR</option>
      </select>
      
      <div v-if="expectedOutcome === 'research_note'" class="outcome-detail">
        <span class="badge badge-read-only">Read-Only</span>
        <p>Worker gets read access to the repo. Token expires after 2 hours.</p>
      </div>
      <div v-else-if="expectedOutcome === 'comment'" class="outcome-detail">
        <span class="badge badge-comment">Comment Access</span>
        <p>Worker gets read access + ability to comment on issues. Expires in 12 hours.</p>
      </div>
      <div v-else-if="expectedOutcome === 'draft_pr'" class="outcome-detail">
        <span class="badge badge-write">Branch Write Access</span>
        <p>Worker gets write access to the targeted branch ONLY. Expires in 48 hours.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.target-scope-container {
  padding: 1rem;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-sm);
  margin-top: 1rem;
}
.hint {
  display: block;
  font-size: 0.8rem;
  color: var(--text-muted);
}
.outcome-detail {
  padding: 0.75rem;
  background: var(--bg-surface-alt);
  border-left: 3px solid var(--accent);
  margin-top: 0.5rem;
}
.badge {
  display: inline-block;
  padding: 0.2rem 0.5rem;
  font-size: 0.75rem;
  border-radius: 12px;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
.badge-read-only { background: #e0f2fe; color: #0284c7; }
.badge-comment { background: #fef08a; color: #a16207; }
.badge-write { background: #fce7f3; color: #be185d; }
</style>
