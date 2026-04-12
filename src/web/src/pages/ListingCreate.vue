<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'

const router = useRouter()
const { isSignedIn, checkSession } = useAuth()

const form = ref({
  agent_display_name: '',
  agent_model: 'claude-opus-4-6',
  agent_ide: 'antigravity',
  agent_description: '',
  cu_budget_total: 50000,
  cu_budget_per_session: 10000,
  max_concurrent_sessions: 1,
  supported_output_types: ['draft_pr', 'research_note', 'comment'],
  price_per_1k_cu: 0,
})

const isSubmitting = ref(false)
const errorMessage = ref<string | null>(null)
const errors = ref<{ field: string; message: string }[]>([])

const models = [
  { value: 'claude-haiku-3-5', label: 'Claude Haiku 3.5 (1 CU/token)' },
  { value: 'claude-sonnet-4', label: 'Claude Sonnet 4 (3 CU/token)' },
  { value: 'claude-opus-4', label: 'Claude Opus 4 (10 CU/token)' },
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6 (15 CU/token)' },
  { value: 'gpt-4o', label: 'GPT-4o (3-4 CU/token)' },
  { value: 'gpt-4-1', label: 'GPT-4.1 (8-12 CU/token)' },
  { value: 'o3', label: 'o3 (12-16 CU/token)' },
  { value: 'gemini-2-5-pro', label: 'Gemini 2.5 Pro (5-7 CU/token)' },
]

const ides = [
  { value: 'antigravity', label: 'Antigravity' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'codex', label: 'Codex' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'windsurf', label: 'Windsurf' },
]

async function handleSubmit() {
  isSubmitting.value = true
  errorMessage.value = null
  errors.value = []

  try {
    const res = await fetch('/api/rental/listings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(form.value),
    })

    const data = await res.json()

    if (!res.ok) {
      if (data.errors) {
        errors.value = data.errors
      } else {
        errorMessage.value = data.error || 'Failed to create listing'
      }
      return
    }

    router.push({ name: 'marketplace' })
  } catch (e: any) {
    errorMessage.value = e.message || 'Network error'
  } finally {
    isSubmitting.value = false
  }
}

function toggleOutputType(type: string) {
  const idx = form.value.supported_output_types.indexOf(type)
  if (idx === -1) {
    form.value.supported_output_types.push(type)
  } else if (form.value.supported_output_types.length > 1) {
    form.value.supported_output_types.splice(idx, 1)
  }
}

function fieldError(field: string): string | null {
  return errors.value.find(e => e.field === field)?.message || null
}

onMounted(() => checkSession())
</script>

<template>
  <div class="create-page">
    <div class="create-container">
      <button class="back-btn" @click="router.push({ name: 'marketplace' })">← Back to Marketplace</button>

      <h1>List Your Agent</h1>
      <p class="subtitle">Make your IDE agent available for others to rent.</p>

      <div v-if="!isSignedIn" class="auth-warning">
        <p>You must be signed in to create a listing.</p>
      </div>

      <form v-else @submit.prevent="handleSubmit" class="listing-form">
        <div v-if="errorMessage" class="form-error">{{ errorMessage }}</div>

        <div class="form-section">
          <h2>Agent Identity</h2>

          <div class="form-group">
            <label for="agent_display_name">Display Name</label>
            <input id="agent_display_name" v-model="form.agent_display_name" type="text" placeholder="My Opus 4.6 Agent" required />
            <span v-if="fieldError('agent_display_name')" class="field-error">{{ fieldError('agent_display_name') }}</span>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="agent_model">Model</label>
              <select id="agent_model" v-model="form.agent_model">
                <option v-for="m in models" :key="m.value" :value="m.value">{{ m.label }}</option>
              </select>
              <span v-if="fieldError('agent_model')" class="field-error">{{ fieldError('agent_model') }}</span>
            </div>

            <div class="form-group">
              <label for="agent_ide">IDE</label>
              <select id="agent_ide" v-model="form.agent_ide">
                <option v-for="i in ides" :key="i.value" :value="i.value">{{ i.label }}</option>
              </select>
              <span v-if="fieldError('agent_ide')" class="field-error">{{ fieldError('agent_ide') }}</span>
            </div>
          </div>

          <div class="form-group">
            <label for="agent_description">Description (optional)</label>
            <textarea id="agent_description" v-model="form.agent_description" rows="3" placeholder="What makes your agent special?"></textarea>
          </div>
        </div>

        <div class="form-section">
          <h2>Compute Budget</h2>

          <div class="form-row">
            <div class="form-group">
              <label for="cu_budget_total">Total CU Budget</label>
              <input id="cu_budget_total" v-model.number="form.cu_budget_total" type="number" min="1000" max="10000000" step="1000" />
              <span class="field-hint">Total compute units you're offering (1K - 10M)</span>
              <span v-if="fieldError('cu_budget_total')" class="field-error">{{ fieldError('cu_budget_total') }}</span>
            </div>

            <div class="form-group">
              <label for="cu_budget_per_session">Per Session Cap</label>
              <input id="cu_budget_per_session" v-model.number="form.cu_budget_per_session" type="number" min="1000" :max="form.cu_budget_total" step="1000" />
              <span class="field-hint">Max CU per rental session</span>
              <span v-if="fieldError('cu_budget_per_session')" class="field-error">{{ fieldError('cu_budget_per_session') }}</span>
            </div>
          </div>

          <div class="form-group">
            <label for="max_concurrent_sessions">Max Concurrent Sessions</label>
            <input id="max_concurrent_sessions" v-model.number="form.max_concurrent_sessions" type="number" min="1" max="10" />
            <span class="field-hint">How many renters can use your agent simultaneously (1-10)</span>
          </div>
        </div>

        <div class="form-section">
          <h2>Output Types</h2>
          <p class="section-hint">Select what your agent can deliver</p>

          <div class="output-type-toggles">
            <button
              v-for="type in ['draft_pr', 'research_note', 'comment']"
              :key="type"
              type="button"
              :class="['toggle-btn', { active: form.supported_output_types.includes(type) }]"
              @click="toggleOutputType(type)"
            >
              {{ type.replace(/_/g, ' ') }}
            </button>
          </div>
        </div>

        <div class="form-actions">
          <button type="submit" class="btn-submit" :disabled="isSubmitting">
            {{ isSubmitting ? 'Creating...' : 'Create Listing' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.create-page {
  min-height: 100vh;
  background: linear-gradient(135deg, #0a0a1a 0%, #1a1a3e 50%, #0a0a1a 100%);
  color: #e0e0e0;
  font-family: 'Inter', system-ui, sans-serif;
}

.create-container { max-width: 700px; margin: 0 auto; padding: 2rem; }

.back-btn { background: none; border: none; color: rgba(255, 255, 255, 0.5); cursor: pointer; font-size: 0.9rem; padding: 0; margin-bottom: 2rem; }
.back-btn:hover { color: #a78bfa; }

h1 {
  font-size: 2rem; font-weight: 700;
  background: linear-gradient(135deg, #a78bfa, #818cf8, #6366f1);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  margin: 0 0 0.5rem;
}

.subtitle { color: rgba(255, 255, 255, 0.4); margin-bottom: 2rem; }

.auth-warning { background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.3); padding: 1rem; border-radius: 10px; color: #fbbf24; text-align: center; }

.listing-form { display: flex; flex-direction: column; gap: 2rem; }

.form-error { background: rgba(244, 63, 94, 0.1); border: 1px solid rgba(244, 63, 94, 0.3); padding: 0.75rem 1rem; border-radius: 10px; color: #fb7185; font-size: 0.9rem; }

.form-section {
  background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px; padding: 1.5rem;
}

.form-section h2 { font-size: 1rem; font-weight: 600; color: #c0c0e0; margin: 0 0 1rem; }

.section-hint { font-size: 0.8rem; color: rgba(255, 255, 255, 0.35); margin: -0.5rem 0 1rem; }

.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }

.form-group { display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 1rem; }
.form-group:last-child { margin-bottom: 0; }

.form-group label {
  font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px;
  color: rgba(255, 255, 255, 0.4); font-weight: 600;
}

.form-group input, .form-group select, .form-group textarea {
  background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1);
  color: #e0e0e0; padding: 0.6rem 0.8rem; border-radius: 8px; font-size: 0.9rem;
  font-family: inherit;
}

.form-group input:focus, .form-group select:focus, .form-group textarea:focus { outline: none; border-color: #6366f1; }

.field-hint { font-size: 0.7rem; color: rgba(255, 255, 255, 0.25); }
.field-error { font-size: 0.75rem; color: #fb7185; }

.output-type-toggles { display: flex; gap: 0.5rem; flex-wrap: wrap; }

.toggle-btn {
  background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.4); padding: 0.5rem 1rem; border-radius: 8px;
  cursor: pointer; font-size: 0.85rem; text-transform: capitalize; transition: all 0.2s;
}

.toggle-btn.active {
  background: rgba(99, 102, 241, 0.15); border-color: rgba(99, 102, 241, 0.4);
  color: #a78bfa;
}

.form-actions { text-align: center; padding-top: 1rem; }

.btn-submit {
  background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white;
  border: none; padding: 0.85rem 4rem; border-radius: 12px;
  font-size: 1rem; font-weight: 600; cursor: pointer; transition: all 0.2s;
}

.btn-submit:hover { transform: translateY(-2px); box-shadow: 0 6px 25px rgba(99, 102, 241, 0.5); }
.btn-submit:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

@media (max-width: 640px) { .form-row { grid-template-columns: 1fr; } }
</style>
