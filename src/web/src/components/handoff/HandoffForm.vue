<script setup lang="ts">
import { ref } from 'vue';

const title = ref('');
const acceptanceCriteria = ref('');
const targetBranch = ref('main');
const expectedOutcome = ref('draft_pr');

const isSubmitting = ref(false);

const emit = defineEmits<{
  (e: 'submit', payload: { title: string, acceptanceCriteria: string, targetBranch: string, expectedOutcome: string }): void
}>();

async function handleSubmit() {
  const cleanTitle = title.value.trim();
  const cleanAC = acceptanceCriteria.value.trim();
  const cleanBranch = targetBranch.value.trim();

  if (!cleanTitle || !cleanAC || !cleanBranch) {
    alert("Title, Acceptance Criteria, and Target Branch cannot be blank.");
    return;
  }
  
  isSubmitting.value = true;
  
  try {
    const res = await fetch('/api/handoff/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: cleanTitle,
        acceptanceCriteria: cleanAC,
        targetBranch: cleanBranch,
        expectedOutcome: expectedOutcome.value
      })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("Policy Engine rejected:", data);
      alert("Handoff rejected by Policy Engine: " + (data.error || "Unknown Error"));
    } else {
      emit('submit', data);
      alert("Handoff successfully issued!");
    }
  } catch (error) {
    console.error("Fetch failed", error);
  } finally {
    isSubmitting.value = false;
  }
}
</script>

<template>
  <div class="handoff-form-container">
    <h2>Delegate Task (Handoff v1)</h2>
    <form @submit.prevent="handleSubmit">
      
      <div class="form-group">
        <label for="title">Task Title</label>
        <input id="title" v-model="title" type="text" placeholder="e.g. Migrate login flow to useAuth" required />
      </div>

      <div class="form-group">
        <label for="ac">Acceptance Criteria</label>
        <textarea id="ac" v-model="acceptanceCriteria" rows="4" placeholder="What must be true for this to be considered done?..." required></textarea>
      </div>

      <div class="form-group">
        <label for="branch">Target Branch</label>
        <input id="branch" v-model="targetBranch" type="text" required />
      </div>

      <div class="form-group">
        <label for="outcome">Expected Outcome</label>
        <select id="outcome" v-model="expectedOutcome">
          <option value="research_note">Research Note (Read-Only Access)</option>
          <option value="comment">Review / Comment (Repo Read + Issue Comment)</option>
          <option value="draft_pr">Draft PR (Branch Write Access)</option>
        </select>
        <p class="outcome-hint">Wait times and access levels are automatically scoped based on this selection.</p>
      </div>

      <AppButton type="submit" :loading="isSubmitting" :disabled="isSubmitting">
        Issue Handoff Grant
      </AppButton>
    </form>
  </div>
</template>

<style scoped>
.handoff-form-container {
  padding: 1.5rem;
  background: var(--bg-surface);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
}
.form-group {
  margin-bottom: 1.2rem;
}
.form-group label {
  display: block;
  font-weight: 600;
  margin-bottom: 0.5rem;
}
.form-group input, .form-group textarea, .form-group select {
  width: 100%;
  padding: 0.5rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-color);
  background: var(--bg-input);
  color: var(--text-base);
}
.outcome-hint {
  font-size: 0.85rem;
  color: var(--text-muted);
  margin-top: 0.3rem;
}
</style>
