<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'

const route = useRoute()
const router = useRouter()
const { isSignedIn, checkSession } = useAuth()

const listing = ref<any>(null)
const isLoading = ref(true)
const error = ref<string | null>(null)

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

const ideDisplayNames: Record<string, string> = {
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  windsurf: 'Windsurf',
}

async function fetchListing() {
  isLoading.value = true
  try {
    const res = await fetch(`/api/rental/listings/${route.params.id}`)
    if (!res.ok) throw new Error('Listing not found')
    const data = await res.json()
    listing.value = data.listing
  } catch (e: any) {
    error.value = e.message
  } finally {
    isLoading.value = false
  }
}

function formatCU(cu: number): string {
  if (cu >= 1_000_000) return `${(cu / 1_000_000).toFixed(1)}M`
  if (cu >= 1_000) return `${(cu / 1_000).toFixed(0)}K`
  return String(cu)
}

function getProgressPercent(): number {
  if (!listing.value) return 0
  return Math.round((listing.value.cu_budget_used / listing.value.cu_budget_total) * 100)
}

onMounted(async () => {
  await checkSession()
  await fetchListing()
})
</script>

<template>
  <div class="detail-page">
    <div class="detail-container">
      <button class="back-btn" @click="router.push({ name: 'marketplace' })">← Back to Marketplace</button>

      <div v-if="isLoading" class="loading-state">
        <div class="spinner"></div>
        <p>Loading listing...</p>
      </div>

      <div v-else-if="error" class="error-state">
        <p>{{ error }}</p>
      </div>

      <div v-else-if="listing" class="listing-detail">
        <div class="detail-header">
          <div>
            <h1>{{ listing.agent_display_name }}</h1>
            <p v-if="listing.agent_description" class="description">{{ listing.agent_description }}</p>
          </div>
          <div class="detail-badges">
            <span class="badge model">{{ modelDisplayNames[listing.agent_model] || listing.agent_model }}</span>
            <span class="badge ide">{{ ideDisplayNames[listing.agent_ide] || listing.agent_ide }}</span>
            <span v-if="listing.price_per_1k_cu === 0" class="badge free">FREE</span>
          </div>
        </div>

        <div class="detail-grid">
          <div class="detail-card">
            <h3>Compute Budget</h3>
            <div class="budget-bar">
              <div class="budget-fill" :style="{ width: getProgressPercent() + '%' }"></div>
            </div>
            <div class="budget-labels">
              <span>{{ formatCU(listing.cu_budget_used) }} used</span>
              <span>{{ formatCU(listing.cu_budget_total - listing.cu_budget_used) }} available</span>
            </div>
          </div>

          <div class="detail-card">
            <h3>Configuration</h3>
            <div class="config-row"><span>Per Session Cap</span><span>{{ listing.cu_budget_per_session ? formatCU(listing.cu_budget_per_session) + ' CU' : 'No cap' }}</span></div>
            <div class="config-row"><span>Max Concurrent</span><span>{{ listing.max_concurrent_sessions }} session{{ listing.max_concurrent_sessions > 1 ? 's' : '' }}</span></div>
            <div class="config-row"><span>Output Types</span><span>{{ (listing.supported_output_types || []).join(', ') }}</span></div>
          </div>

          <div class="detail-card">
            <h3>Verification</h3>
            <div class="config-row">
              <span>Model Verified</span>
              <span :class="listing.agent_model_verified ? 'verified' : 'unverified'">
                {{ listing.agent_model_verified ? '✓ Yes' : '✗ Pending' }}
              </span>
            </div>
            <div class="config-row">
              <span>IDE Verified</span>
              <span :class="listing.agent_ide_verified ? 'verified' : 'unverified'">
                {{ listing.agent_ide_verified ? '✓ Yes' : '✗ Pending' }}
              </span>
            </div>
          </div>
        </div>

        <div v-if="isSignedIn" class="rent-action">
          <button class="btn-rent" @click="router.push({ name: 'listing-create' })">
            Rent This Agent
          </button>
        </div>
        <div v-else class="rent-action">
          <p class="sign-in-hint">Sign in to rent this agent</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail-page {
  min-height: 100vh;
  background: linear-gradient(135deg, #0a0a1a 0%, #1a1a3e 50%, #0a0a1a 100%);
  color: #e0e0e0;
  font-family: 'Inter', system-ui, sans-serif;
}

.detail-container {
  max-width: 900px;
  margin: 0 auto;
  padding: 2rem;
}

.back-btn {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  font-size: 0.9rem;
  padding: 0;
  margin-bottom: 2rem;
}

.back-btn:hover { color: #a78bfa; }

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 2rem;
}

.detail-header h1 {
  font-size: 1.8rem;
  background: linear-gradient(135deg, #a78bfa, #818cf8);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin: 0 0 0.5rem;
}

.description { color: rgba(255, 255, 255, 0.4); max-width: 500px; }

.detail-badges { display: flex; gap: 0.5rem; flex-wrap: wrap; }

.badge {
  font-size: 0.7rem; padding: 0.3rem 0.7rem; border-radius: 6px;
  font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
}

.badge.model { background: rgba(168, 85, 247, 0.2); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); }
.badge.ide { background: rgba(255, 255, 255, 0.06); color: rgba(255, 255, 255, 0.5); border: 1px solid rgba(255, 255, 255, 0.1); }
.badge.free { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }

.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1.25rem;
  margin-bottom: 2rem;
}

.detail-card {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 1.25rem;
}

.detail-card h3 {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: rgba(255, 255, 255, 0.35);
  margin: 0 0 1rem;
}

.budget-bar {
  height: 6px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 0.5rem;
}

.budget-fill {
  height: 100%;
  background: linear-gradient(90deg, #6366f1, #a78bfa);
  border-radius: 3px;
  transition: width 0.5s ease;
}

.budget-labels {
  display: flex;
  justify-content: space-between;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.4);
}

.config-row {
  display: flex;
  justify-content: space-between;
  padding: 0.4rem 0;
  font-size: 0.85rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.config-row:last-child { border-bottom: none; }
.config-row span:first-child { color: rgba(255, 255, 255, 0.4); }
.config-row span:last-child { color: #c0c0e0; font-weight: 500; }

.verified { color: #34d399; }
.unverified { color: rgba(255, 255, 255, 0.3); }

.rent-action { text-align: center; padding: 2rem 0; }

.btn-rent {
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: white;
  border: none;
  padding: 0.85rem 3rem;
  border-radius: 12px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-rent:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 25px rgba(99, 102, 241, 0.5);
}

.sign-in-hint {
  color: rgba(255, 255, 255, 0.3);
}

.loading-state, .error-state { text-align: center; padding: 4rem; }
.spinner {
  width: 36px; height: 36px; border: 3px solid rgba(99, 102, 241, 0.2);
  border-top-color: #6366f1; border-radius: 50%; margin: 0 auto 1rem;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
