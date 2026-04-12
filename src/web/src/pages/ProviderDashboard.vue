<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import ComputeUnitMeter from '../components/rental/ComputeUnitMeter.vue'
import RentalStatusBadge from '../components/rental/RentalStatusBadge.vue'

const router = useRouter()
const { isSignedIn, checkSession } = useAuth()

const stats = ref<any>(null)
const myListings = ref<any[]>([])
const mySessions = ref<any[]>([])
const isLoading = ref(true)

const modelDisplayNames: Record<string, string> = {
  'claude-haiku-3-5': 'Haiku 3.5',
  'claude-sonnet-4': 'Sonnet 4',
  'claude-opus-4': 'Opus 4',
  'claude-opus-4-6': 'Opus 4.6',
  'gpt-4o': 'GPT-4o',
  'gpt-4-1': 'GPT-4.1',
  'o3': 'o3',
  'gemini-2-5-pro': 'Gemini 2.5 Pro',
}

function formatCU(cu: number): string {
  if (cu >= 1_000_000) return `${(cu / 1_000_000).toFixed(1)}M`
  if (cu >= 1_000) return `${(cu / 1_000).toFixed(0)}K`
  return String(cu)
}

async function fetchAll() {
  isLoading.value = true
  try {
    const [statsRes, listingsRes, sessionsRes] = await Promise.all([
      fetch('/api/rental/stats', { credentials: 'include' }),
      fetch('/api/rental/listings/mine', { credentials: 'include' }),
      fetch('/api/rental/sessions/mine', { credentials: 'include' }),
    ])
    if (statsRes.ok) stats.value = await statsRes.json()
    if (listingsRes.ok) {
      const data = await listingsRes.json()
      myListings.value = data.listings
    }
    if (sessionsRes.ok) {
      const data = await sessionsRes.json()
      // Provider sessions only (where I'm the provider)
      mySessions.value = data.sessions.filter(
        (s: any) => s.provider_account_id && ['requested', 'accepted', 'active', 'paused'].includes(s.status)
      )
    }
  } finally {
    isLoading.value = false
  }
}

async function handleAction(sessionId: string, action: string) {
  const res = await fetch(`/api/rental/sessions/${sessionId}/${action}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  })
  if (res.ok) await fetchAll()
}

onMounted(async () => {
  await checkSession()
  if (isSignedIn.value) await fetchAll()
})
</script>

<template>
  <div class="dashboard-page">
    <div class="dashboard-container">
      <div class="dashboard-header">
        <div>
          <h1>Provider Dashboard</h1>
          <p class="subtitle">Manage your agent listings and active rental sessions.</p>
        </div>
        <div class="header-actions">
          <button class="btn-create" @click="router.push({ name: 'listing-create' })">+ New Listing</button>
          <router-link to="/provider/notifications" class="btn-link">🔔 Notifications</router-link>
          <router-link to="/marketplace" class="btn-link">← Marketplace</router-link>
        </div>
      </div>

      <div v-if="!isSignedIn" class="auth-warning">Sign in to access your dashboard.</div>

      <div v-else-if="isLoading" class="loading-state">
        <div class="spinner"></div>
      </div>

      <template v-else>
        <!-- Stats Cards -->
        <div v-if="stats" class="stats-grid">
          <div class="stat-card">
            <span class="stat-label">Listings</span>
            <span class="stat-value">{{ stats.listings.total }}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">Active Sessions</span>
            <span class="stat-value">{{ stats.sessions.active }}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">Completed</span>
            <span class="stat-value">{{ stats.sessions.completed }}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">Total CU Used</span>
            <span class="stat-value">{{ formatCU(stats.listings.cu_budget_used) }}</span>
          </div>
        </div>

        <!-- Overall CU Meter -->
        <div v-if="stats && stats.listings.cu_budget_total > 0" class="overall-meter">
          <h3>Overall Compute Budget</h3>
          <ComputeUnitMeter
            :used="stats.listings.cu_budget_used"
            :budget="stats.listings.cu_budget_total"
            size="lg"
          />
        </div>

        <!-- Pending Session Requests -->
        <div v-if="mySessions.length > 0" class="section">
          <h2>Active & Pending Sessions</h2>
          <div class="sessions-list">
            <div v-for="s in mySessions" :key="s.id" class="session-item">
              <div class="session-info">
                <div class="session-title">
                  <strong>{{ s.task_title }}</strong>
                  <RentalStatusBadge :status="s.status" />
                </div>
                <span class="session-repo">{{ s.repo_scope }} → {{ s.target_branch }}</span>
                <ComputeUnitMeter v-if="s.status === 'active'" :used="s.cu_used" :budget="s.cu_budget" size="sm" />
              </div>
              <div class="session-actions">
                <button v-if="s.status === 'requested'" class="btn-sm accept" @click="handleAction(s.id, 'accept')">Accept</button>
                <button v-if="s.status === 'requested'" class="btn-sm reject" @click="handleAction(s.id, 'reject')">Reject</button>
                <button v-if="s.status === 'accepted'" class="btn-sm start" @click="handleAction(s.id, 'start')">Start</button>
                <button v-if="s.status === 'active'" class="btn-sm complete" @click="handleAction(s.id, 'complete')">Complete</button>
                <button v-if="s.status === 'paused'" class="btn-sm resume" @click="handleAction(s.id, 'resume')">Resume</button>
              </div>
            </div>
          </div>
        </div>

        <!-- My Listings -->
        <div class="section">
          <h2>My Listings</h2>
          <div v-if="myListings.length === 0" class="empty-msg">
            <p>No listings yet. Create one to start renting out your agent.</p>
          </div>
          <div v-else class="listings-grid">
            <div v-for="listing in myListings" :key="listing.id" class="listing-mini-card">
              <div class="listing-mini-header">
                <strong>{{ listing.agent_display_name }}</strong>
                <RentalStatusBadge :status="listing.status" />
              </div>
              <span class="listing-mini-model">{{ modelDisplayNames[listing.agent_model] || listing.agent_model }}</span>
              <ComputeUnitMeter :used="listing.cu_budget_used" :budget="listing.cu_budget_total" size="sm" />
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.dashboard-page { min-height: 100vh; background: linear-gradient(135deg, #0a0a1a 0%, #1a1a3e 50%, #0a0a1a 100%); color: #e0e0e0; font-family: 'Inter', system-ui, sans-serif; }
.dashboard-container { max-width: 900px; margin: 0 auto; padding: 2rem; }
.dashboard-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 2rem; }
.dashboard-header h1 { font-size: 1.8rem; background: linear-gradient(135deg, #a78bfa, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin: 0 0 0.3rem; }
.subtitle { color: rgba(255, 255, 255, 0.4); margin: 0; }
.header-actions { display: flex; gap: 0.75rem; }
.btn-create { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; border: none; padding: 0.6rem 1.25rem; border-radius: 10px; font-size: 0.85rem; font-weight: 600; cursor: pointer; }
.btn-link { color: rgba(255, 255, 255, 0.5); text-decoration: none; font-size: 0.85rem; padding: 0.6rem 0; }
.btn-link:hover { color: #a78bfa; }

.stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1.5rem; }
.stat-card { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 1rem; text-align: center; }
.stat-label { display: block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(255, 255, 255, 0.3); margin-bottom: 0.3rem; }
.stat-value { font-size: 1.5rem; font-weight: 700; color: #c0c0e0; }

.overall-meter { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px; padding: 1.25rem; margin-bottom: 1.5rem; }
.overall-meter h3 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(255, 255, 255, 0.35); margin: 0 0 0.75rem; }

.section { margin-bottom: 2rem; }
.section h2 { font-size: 1rem; color: #c0c0e0; margin: 0 0 1rem; }

.sessions-list { display: flex; flex-direction: column; gap: 0.75rem; }
.session-item { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 1rem; display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.session-info { flex: 1; min-width: 0; }
.session-title { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; }
.session-repo { font-family: monospace; font-size: 0.78rem; color: rgba(255, 255, 255, 0.3); display: block; margin-bottom: 0.5rem; }
.session-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }

.btn-sm { border: none; padding: 0.4rem 0.8rem; border-radius: 8px; font-size: 0.75rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }
.btn-sm.accept { background: rgba(52, 211, 153, 0.15); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.3); }
.btn-sm.reject { background: rgba(239, 68, 68, 0.1); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
.btn-sm.start { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; }
.btn-sm.complete { background: rgba(99, 102, 241, 0.15); color: #a78bfa; border: 1px solid rgba(99, 102, 241, 0.3); }
.btn-sm.resume { background: rgba(249, 115, 22, 0.15); color: #f97316; border: 1px solid rgba(249, 115, 22, 0.3); }

.listings-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 1rem; }
.listing-mini-card { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 1rem; }
.listing-mini-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.3rem; }
.listing-mini-model { font-size: 0.78rem; color: rgba(255, 255, 255, 0.35); display: block; margin-bottom: 0.5rem; }

.empty-msg { text-align: center; padding: 2rem; color: rgba(255, 255, 255, 0.3); }
.auth-warning { background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.3); padding: 1rem; border-radius: 10px; color: #fbbf24; text-align: center; }
.loading-state { text-align: center; padding: 4rem; }
.spinner { width: 36px; height: 36px; border: 3px solid rgba(99, 102, 241, 0.2); border-top-color: #6366f1; border-radius: 50%; margin: 0 auto; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 640px) { .stats-grid { grid-template-columns: 1fr 1fr; } .dashboard-header { flex-direction: column; align-items: flex-start; } }
</style>
