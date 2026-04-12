<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'

const router = useRouter()
const { isSignedIn, checkSession } = useAuth()

const sessions = ref<any[]>([])
const isLoading = ref(true)

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

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function formatCU(cu: number): string {
  if (cu >= 1_000_000) return `${(cu / 1_000_000).toFixed(1)}M`
  if (cu >= 1_000) return `${(cu / 1_000).toFixed(0)}K`
  return String(cu)
}

async function fetchSessions() {
  isLoading.value = true
  try {
    const res = await fetch('/api/rental/sessions/mine', { credentials: 'include' })
    if (!res.ok) throw new Error('Failed to fetch sessions')
    const data = await res.json()
    sessions.value = data.sessions
  } catch {
    // silent
  } finally {
    isLoading.value = false
  }
}

onMounted(async () => {
  await checkSession()
  if (isSignedIn.value) await fetchSessions()
})
</script>

<template>
  <div class="sessions-page">
    <div class="sessions-container">
      <button class="back-btn" @click="router.push({ name: 'marketplace' })">← Marketplace</button>
      <h1>My Rental Sessions</h1>

      <div v-if="isLoading" class="loading-state">
        <div class="spinner"></div>
      </div>

      <div v-else-if="sessions.length === 0" class="empty-state">
        <p>No sessions yet. Browse the marketplace to rent an agent.</p>
      </div>

      <div v-else class="sessions-list">
        <div
          v-for="session in sessions"
          :key="session.id"
          class="session-card"
          @click="router.push({ name: 'rental-session-detail', params: { id: session.id } })"
        >
          <div class="session-header">
            <h3>{{ session.task_title }}</h3>
            <span class="status-badge" :style="{ background: statusColors[session.status] + '22', color: statusColors[session.status], borderColor: statusColors[session.status] + '44' }">
              {{ session.status }}
            </span>
          </div>
          <p class="session-repo">{{ session.repo_scope }} → {{ session.target_branch }}</p>
          <div class="session-meta">
            <span>{{ formatCU(session.cu_used) }} / {{ formatCU(session.cu_budget) }} CU</span>
            <span>{{ formatDate(session.created_at) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sessions-page { min-height: 100vh; background: linear-gradient(135deg, #0a0a1a 0%, #1a1a3e 50%, #0a0a1a 100%); color: #e0e0e0; font-family: 'Inter', system-ui, sans-serif; }
.sessions-container { max-width: 800px; margin: 0 auto; padding: 2rem; }
.back-btn { background: none; border: none; color: rgba(255, 255, 255, 0.5); cursor: pointer; font-size: 0.9rem; padding: 0; margin-bottom: 2rem; }
.back-btn:hover { color: #a78bfa; }
h1 { font-size: 1.8rem; background: linear-gradient(135deg, #a78bfa, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin: 0 0 2rem; }
.sessions-list { display: flex; flex-direction: column; gap: 1rem; }
.session-card { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px; padding: 1.25rem; cursor: pointer; transition: all 0.2s; }
.session-card:hover { border-color: rgba(99, 102, 241, 0.3); transform: translateY(-1px); }
.session-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
.session-header h3 { font-size: 1rem; margin: 0; color: #f0f0f5; }
.status-badge { font-size: 0.7rem; padding: 0.2rem 0.6rem; border-radius: 6px; font-weight: 600; text-transform: uppercase; border: 1px solid; }
.session-repo { font-size: 0.82rem; color: rgba(255, 255, 255, 0.35); margin: 0 0 0.75rem; font-family: monospace; }
.session-meta { display: flex; justify-content: space-between; font-size: 0.8rem; color: rgba(255, 255, 255, 0.3); }
.loading-state, .empty-state { text-align: center; padding: 4rem; color: rgba(255, 255, 255, 0.4); }
.spinner { width: 36px; height: 36px; border: 3px solid rgba(99, 102, 241, 0.2); border-top-color: #6366f1; border-radius: 50%; margin: 0 auto; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
