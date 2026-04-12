<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'

const route = useRoute()
const router = useRouter()
const { isSignedIn, user, checkSession } = useAuth()

const session = ref<any>(null)
const isLoading = ref(true)
const actionLoading = ref(false)

const statusColors: Record<string, string> = {
  requested: '#fbbf24',
  accepted: '#60a5fa',
  active: '#34d399',
  paused: '#f97316',
  completed: '#6366f1',
  cancelled: '#6b7280',
  expired: '#ef4444',
  disputed: '#f43f5e',
}

function formatCU(cu: number): string {
  if (cu >= 1_000_000) return `${(cu / 1_000_000).toFixed(1)}M`
  if (cu >= 1_000) return `${(cu / 1_000).toFixed(0)}K`
  return String(cu)
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function cuProgressPercent(): number {
  if (!session.value) return 0
  return Math.min(100, Math.round((session.value.cu_used / session.value.cu_budget) * 100))
}

const isProvider = computed(() => session.value && user.value && session.value.provider_account_id === (user.value as any).account_id)

async function fetchSession() {
  isLoading.value = true
  try {
    const res = await fetch(`/api/rental/sessions/${route.params.id}`, { credentials: 'include' })
    if (!res.ok) throw new Error('Session not found')
    const data = await res.json()
    session.value = data.session
  } catch {
    // error
  } finally {
    isLoading.value = false
  }
}

async function performAction(action: string) {
  if (!session.value) return
  actionLoading.value = true
  try {
    const res = await fetch(`/api/rental/sessions/${session.value.id}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    })
    if (res.ok) await fetchSession()
  } finally {
    actionLoading.value = false
  }
}

onMounted(async () => {
  await checkSession()
  await fetchSession()
})
</script>

<template>
  <div class="session-detail-page">
    <div class="session-container">
      <button class="back-btn" @click="router.push({ name: 'rental-sessions' })">← Back to Sessions</button>

      <div v-if="isLoading" class="loading-state">
        <div class="spinner"></div>
      </div>

      <div v-else-if="session" class="session-detail">
        <div class="detail-header">
          <div>
            <h1>{{ session.task_title }}</h1>
            <p class="repo-info">{{ session.repo_scope }} → {{ session.target_branch }}</p>
          </div>
          <span class="status-badge" :style="{ background: statusColors[session.status] + '22', color: statusColors[session.status], borderColor: statusColors[session.status] + '44' }">
            {{ session.status }}
          </span>
        </div>

        <div class="detail-grid">
          <div class="detail-card">
            <h3>Compute Usage</h3>
            <div class="cu-meter">
              <div class="cu-bar">
                <div class="cu-fill" :style="{ width: cuProgressPercent() + '%' }" :class="{ warning: cuProgressPercent() >= 80, exhausted: cuProgressPercent() >= 100 }"></div>
              </div>
              <div class="cu-labels">
                <span>{{ formatCU(session.cu_used) }} used</span>
                <span>{{ formatCU(session.cu_budget) }} budget</span>
              </div>
            </div>
          </div>

          <div class="detail-card">
            <h3>Timeline</h3>
            <div class="timeline-row"><span>Created</span><span>{{ formatDate(session.created_at) }}</span></div>
            <div class="timeline-row"><span>Started</span><span>{{ formatDate(session.started_at) }}</span></div>
            <div class="timeline-row"><span>Last Heartbeat</span><span>{{ formatDate(session.last_heartbeat_at) }}</span></div>
            <div class="timeline-row"><span>Ended</span><span>{{ formatDate(session.ended_at) }}</span></div>
          </div>
        </div>

        <div class="detail-card description-card">
          <h3>Task Description</h3>
          <p>{{ session.task_description }}</p>
          <template v-if="session.task_acceptance_criteria">
            <h3>Acceptance Criteria</h3>
            <p>{{ session.task_acceptance_criteria }}</p>
          </template>
        </div>

        <div v-if="session.result_summary || session.result_pr_url" class="detail-card">
          <h3>Results</h3>
          <p v-if="session.result_summary">{{ session.result_summary }}</p>
          <a v-if="session.result_pr_url" :href="session.result_pr_url" target="_blank" class="pr-link">{{ session.result_pr_url }}</a>
        </div>

        <div v-if="isSignedIn" class="session-actions">
          <template v-if="isProvider">
            <button v-if="session.status === 'requested'" class="btn-action accept" @click="performAction('accept')" :disabled="actionLoading">Accept</button>
            <button v-if="session.status === 'requested'" class="btn-action reject" @click="performAction('reject')" :disabled="actionLoading">Reject</button>
            <button v-if="session.status === 'accepted'" class="btn-action start" @click="performAction('start')" :disabled="actionLoading">Start Session</button>
            <button v-if="session.status === 'active'" class="btn-action complete" @click="performAction('complete')" :disabled="actionLoading">Complete</button>
          </template>
          <button v-if="['requested', 'accepted', 'active', 'paused'].includes(session.status)" class="btn-action cancel" @click="performAction('cancel')" :disabled="actionLoading">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-detail-page { min-height: 100vh; background: linear-gradient(135deg, #0a0a1a 0%, #1a1a3e 50%, #0a0a1a 100%); color: #e0e0e0; font-family: 'Inter', system-ui, sans-serif; }
.session-container { max-width: 800px; margin: 0 auto; padding: 2rem; }
.back-btn { background: none; border: none; color: rgba(255, 255, 255, 0.5); cursor: pointer; font-size: 0.9rem; padding: 0; margin-bottom: 2rem; }
.back-btn:hover { color: #a78bfa; }

.detail-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; }
.detail-header h1 { font-size: 1.6rem; background: linear-gradient(135deg, #a78bfa, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin: 0 0 0.3rem; }
.repo-info { font-family: monospace; font-size: 0.85rem; color: rgba(255, 255, 255, 0.35); }
.status-badge { font-size: 0.7rem; padding: 0.3rem 0.8rem; border-radius: 6px; font-weight: 600; text-transform: uppercase; border: 1px solid; flex-shrink: 0; }

.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; margin-bottom: 1.25rem; }
.detail-card { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px; padding: 1.25rem; margin-bottom: 1.25rem; }
.detail-card h3 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(255, 255, 255, 0.35); margin: 0 0 0.75rem; }
.detail-card p { color: rgba(255, 255, 255, 0.5); font-size: 0.9rem; line-height: 1.5; margin: 0 0 1rem; }
.description-card { margin-bottom: 1.25rem; }

.cu-meter { margin-top: 0.5rem; }
.cu-bar { height: 8px; background: rgba(255, 255, 255, 0.06); border-radius: 4px; overflow: hidden; margin-bottom: 0.5rem; }
.cu-fill { height: 100%; background: linear-gradient(90deg, #6366f1, #a78bfa); border-radius: 4px; transition: width 0.5s; }
.cu-fill.warning { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
.cu-fill.exhausted { background: linear-gradient(90deg, #ef4444, #f87171); }
.cu-labels { display: flex; justify-content: space-between; font-size: 0.8rem; color: rgba(255, 255, 255, 0.4); }

.timeline-row { display: flex; justify-content: space-between; padding: 0.35rem 0; font-size: 0.82rem; border-bottom: 1px solid rgba(255, 255, 255, 0.04); }
.timeline-row:last-child { border-bottom: none; }
.timeline-row span:first-child { color: rgba(255, 255, 255, 0.35); }
.timeline-row span:last-child { color: #c0c0e0; }

.pr-link { color: #818cf8; text-decoration: none; font-size: 0.85rem; }
.pr-link:hover { text-decoration: underline; }

.session-actions { display: flex; gap: 0.75rem; justify-content: center; padding: 1.5rem 0; }
.btn-action { border: none; padding: 0.65rem 1.5rem; border-radius: 10px; font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }
.btn-action:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-action.accept { background: rgba(52, 211, 153, 0.2); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.3); }
.btn-action.reject { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
.btn-action.start { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; }
.btn-action.complete { background: rgba(99, 102, 241, 0.2); color: #a78bfa; border: 1px solid rgba(99, 102, 241, 0.3); }
.btn-action.cancel { background: rgba(107, 114, 128, 0.15); color: #9ca3af; border: 1px solid rgba(107, 114, 128, 0.3); }

.loading-state { text-align: center; padding: 4rem; }
.spinner { width: 36px; height: 36px; border: 3px solid rgba(99, 102, 241, 0.2); border-top-color: #6366f1; border-radius: 50%; margin: 0 auto; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 640px) { .detail-grid { grid-template-columns: 1fr; } }
</style>
