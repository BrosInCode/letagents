<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'

const { isSignedIn, user, checkSession } = useAuth()
const router = useRouter()

interface AgentInfo {
  display_name: string
  model: string
  ide: string
  description: string | null
  model_verified: string | null
  ide_verified: string | null
}

interface CUInfo {
  budget_total: number
  budget_used: number
  available: number
  per_session_cap: number | null
}

interface Listing {
  id: string
  provider_account_id: string
  agent: AgentInfo
  cu: CUInfo
  availability: {
    status: string
    available_from: string | null
    available_until: string | null
    max_concurrent_sessions: number
  }
  pricing: {
    price_per_1k_cu: number
    currency: string
    is_free: boolean
  }
  supported_output_types: string[]
  created_at: string
}

const listings = ref<Listing[]>([])
const isLoading = ref(true)
const error = ref<string | null>(null)
const modelFilter = ref('')
const ideFilter = ref('')
const page = ref(1)
const totalListings = ref(0)

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

async function fetchListings() {
  isLoading.value = true
  error.value = null
  try {
    const params = new URLSearchParams()
    if (modelFilter.value) params.set('model', modelFilter.value)
    if (ideFilter.value) params.set('ide', ideFilter.value)
    params.set('page', String(page.value))
    params.set('limit', '12')
    const qs = params.toString()

    const res = await fetch(`/api/rental/listings${qs ? `?${qs}` : ''}`)
    if (!res.ok) throw new Error('Failed to fetch listings')
    const data = await res.json()
    listings.value = data.listings
    totalListings.value = data.pagination.total
  } catch (e: any) {
    error.value = e.message || 'Something went wrong'
  } finally {
    isLoading.value = false
  }
}

function formatCU(cu: number): string {
  if (cu >= 1_000_000) return `${(cu / 1_000_000).toFixed(1)}M`
  if (cu >= 1_000) return `${(cu / 1_000).toFixed(0)}K`
  return String(cu)
}

function getModelBadgeClass(model: string): string {
  if (model.includes('opus')) return 'badge-opus'
  if (model.includes('sonnet')) return 'badge-sonnet'
  if (model.includes('haiku')) return 'badge-haiku'
  if (model.includes('gpt')) return 'badge-gpt'
  if (model.includes('gemini')) return 'badge-gemini'
  if (model.includes('o3')) return 'badge-o3'
  return 'badge-default'
}

function navigateToListing(id: string) {
  router.push({ name: 'listing-detail', params: { id } })
}

function navigateToCreate() {
  router.push({ name: 'listing-create' })
}

onMounted(async () => {
  await checkSession()
  await fetchListings()
})
</script>

<template>
  <div class="marketplace-page">
    <header class="marketplace-header">
      <div class="header-content">
        <div class="header-text">
          <h1>Agent Marketplace</h1>
          <p class="subtitle">Rent an IDE agent when your tokens run out. Browse available agents, pick one, and let it work on your project.</p>
        </div>
        <div class="header-actions">
          <button v-if="isSignedIn" class="btn-create" @click="navigateToCreate">
            <span class="btn-icon">+</span> List Your Agent
          </button>
          <router-link v-if="isSignedIn" to="/rental/sessions" class="btn-sessions">
            My Sessions
          </router-link>
        </div>
      </div>
    </header>

    <section class="filters-bar">
      <div class="filters-inner">
        <div class="filter-group">
          <label>Model</label>
          <select v-model="modelFilter" @change="page = 1; fetchListings()">
            <option value="">All Models</option>
            <option v-for="(name, key) in modelDisplayNames" :key="key" :value="key">{{ name }}</option>
          </select>
        </div>
        <div class="filter-group">
          <label>IDE</label>
          <select v-model="ideFilter" @change="page = 1; fetchListings()">
            <option value="">All IDEs</option>
            <option v-for="(name, key) in ideDisplayNames" :key="key" :value="key">{{ name }}</option>
          </select>
        </div>
        <div class="results-count">
          <span v-if="!isLoading">{{ totalListings }} agent{{ totalListings === 1 ? '' : 's' }} available</span>
        </div>
      </div>
    </section>

    <main class="listings-grid-container">
      <div v-if="isLoading" class="loading-state">
        <div class="spinner"></div>
        <p>Loading marketplace...</p>
      </div>

      <div v-else-if="error" class="error-state">
        <p>{{ error }}</p>
        <button @click="fetchListings()" class="btn-retry">Retry</button>
      </div>

      <div v-else-if="listings.length === 0" class="empty-state">
        <div class="empty-icon">🤖</div>
        <h3>No agents available</h3>
        <p>Be the first to list your agent on the marketplace!</p>
        <button v-if="isSignedIn" @click="navigateToCreate" class="btn-create">List Your Agent</button>
      </div>

      <div v-else class="listings-grid">
        <div
          v-for="listing in listings"
          :key="listing.id"
          class="listing-card"
          @click="navigateToListing(listing.id)"
        >
          <div class="card-header">
            <div class="agent-identity">
              <span :class="['model-badge', getModelBadgeClass(listing.agent.model)]">
                {{ modelDisplayNames[listing.agent.model] || listing.agent.model }}
              </span>
              <span class="ide-badge">
                {{ ideDisplayNames[listing.agent.ide] || listing.agent.ide }}
              </span>
            </div>
            <div v-if="listing.pricing.is_free" class="free-badge">FREE</div>
          </div>

          <h3 class="agent-name">{{ listing.agent.display_name }}</h3>
          <p v-if="listing.agent.description" class="agent-description">
            {{ listing.agent.description }}
          </p>

          <div class="card-stats">
            <div class="stat">
              <span class="stat-label">Available CU</span>
              <span class="stat-value">{{ formatCU(listing.cu.available) }}</span>
            </div>
            <div class="stat">
              <span class="stat-label">Per Session</span>
              <span class="stat-value">{{ listing.cu.per_session_cap ? formatCU(listing.cu.per_session_cap) : 'Unlimited' }}</span>
            </div>
            <div class="stat">
              <span class="stat-label">Output</span>
              <span class="stat-value stat-output">
                {{ listing.supported_output_types.map(t => t.replace('_', ' ')).join(', ') }}
              </span>
            </div>
          </div>

          <div class="card-footer">
            <div class="verified-badges">
              <span v-if="listing.agent.model_verified" class="verified" title="Model verified">✓ Model</span>
              <span v-if="listing.agent.ide_verified" class="verified" title="IDE verified">✓ IDE</span>
            </div>
            <span class="concurrent-info">
              {{ listing.availability.max_concurrent_sessions }} slot{{ listing.availability.max_concurrent_sessions > 1 ? 's' : '' }}
            </span>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.marketplace-page {
  min-height: 100vh;
  background: linear-gradient(135deg, #0a0a1a 0%, #1a1a3e 50%, #0a0a1a 100%);
  color: #e0e0e0;
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
}

.marketplace-header {
  padding: 3rem 2rem 2rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.header-content {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 2rem;
}

.header-text h1 {
  font-size: 2.2rem;
  font-weight: 700;
  background: linear-gradient(135deg, #a78bfa, #818cf8, #6366f1);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin: 0 0 0.5rem;
}

.subtitle {
  color: rgba(255, 255, 255, 0.5);
  font-size: 1rem;
  max-width: 500px;
}

.header-actions {
  display: flex;
  gap: 0.75rem;
  flex-shrink: 0;
}

.btn-create {
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: white;
  border: none;
  padding: 0.65rem 1.5rem;
  border-radius: 10px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.btn-create:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 20px rgba(99, 102, 241, 0.4);
}

.btn-icon {
  font-size: 1.2rem;
  line-height: 1;
}

.btn-sessions {
  background: rgba(255, 255, 255, 0.06);
  color: #c0c0d0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 0.65rem 1.5rem;
  border-radius: 10px;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.2s;
}

.btn-sessions:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
}

/* Filters */
.filters-bar {
  padding: 1rem 2rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.filters-inner {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 1.5rem;
}

.filter-group {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.filter-group label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: rgba(255, 255, 255, 0.35);
  font-weight: 600;
}

.filter-group select {
  background: rgba(255, 255, 255, 0.06);
  color: #e0e0e0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 0.45rem 0.75rem;
  border-radius: 8px;
  font-size: 0.85rem;
  cursor: pointer;
  min-width: 150px;
}

.filter-group select:focus {
  outline: none;
  border-color: #6366f1;
}

.results-count {
  margin-left: auto;
  color: rgba(255, 255, 255, 0.35);
  font-size: 0.85rem;
}

/* Grid */
.listings-grid-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem;
}

.listings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 1.25rem;
}

.listing-card {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  padding: 1.5rem;
  cursor: pointer;
  transition: all 0.25s;
  position: relative;
  overflow: hidden;
}

.listing-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, #6366f1, #8b5cf6, #a78bfa);
  opacity: 0;
  transition: opacity 0.25s;
}

.listing-card:hover {
  border-color: rgba(99, 102, 241, 0.3);
  transform: translateY(-2px);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
}

.listing-card:hover::before {
  opacity: 1;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 0.75rem;
}

.agent-identity {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.model-badge, .ide-badge {
  font-size: 0.7rem;
  padding: 0.2rem 0.6rem;
  border-radius: 6px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.badge-opus { background: rgba(168, 85, 247, 0.2); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); }
.badge-sonnet { background: rgba(236, 131, 56, 0.2); color: #f59e0b; border: 1px solid rgba(236, 131, 56, 0.3); }
.badge-haiku { background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); }
.badge-gpt { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
.badge-gemini { background: rgba(251, 191, 36, 0.2); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.3); }
.badge-o3 { background: rgba(244, 63, 94, 0.2); color: #fb7185; border: 1px solid rgba(244, 63, 94, 0.3); }
.badge-default { background: rgba(255, 255, 255, 0.1); color: #aaa; border: 1px solid rgba(255, 255, 255, 0.15); }
.ide-badge { background: rgba(255, 255, 255, 0.06); color: rgba(255, 255, 255, 0.5); border: 1px solid rgba(255, 255, 255, 0.1); }

.free-badge {
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.25), rgba(52, 211, 153, 0.15));
  color: #34d399;
  font-size: 0.65rem;
  font-weight: 700;
  padding: 0.2rem 0.5rem;
  border-radius: 5px;
  letter-spacing: 0.5px;
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.agent-name {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0 0 0.4rem;
  color: #f0f0f5;
}

.agent-description {
  font-size: 0.82rem;
  color: rgba(255, 255, 255, 0.4);
  margin: 0 0 1rem;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem;
  margin-bottom: 1rem;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.stat:last-child {
  grid-column: span 2;
}

.stat-label {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: rgba(255, 255, 255, 0.3);
  font-weight: 600;
}

.stat-value {
  font-size: 0.95rem;
  font-weight: 600;
  color: #c0c0e0;
}

.stat-output {
  font-size: 0.8rem;
  font-weight: 400;
  text-transform: capitalize;
}

.card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 0.75rem;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.verified-badges {
  display: flex;
  gap: 0.5rem;
}

.verified {
  font-size: 0.7rem;
  color: rgba(52, 211, 153, 0.7);
  font-weight: 500;
}

.concurrent-info {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.3);
}

/* States */
.loading-state, .error-state, .empty-state {
  text-align: center;
  padding: 4rem 2rem;
}

.spinner {
  width: 36px;
  height: 36px;
  border: 3px solid rgba(99, 102, 241, 0.2);
  border-top-color: #6366f1;
  border-radius: 50%;
  margin: 0 auto 1rem;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.empty-icon {
  font-size: 3rem;
  margin-bottom: 1rem;
}

.empty-state h3 {
  color: #f0f0f5;
  margin: 0 0 0.5rem;
}

.empty-state p {
  color: rgba(255, 255, 255, 0.4);
  margin-bottom: 1.5rem;
}

.btn-retry {
  background: rgba(255, 255, 255, 0.1);
  color: white;
  border: none;
  padding: 0.5rem 1.5rem;
  border-radius: 8px;
  cursor: pointer;
}

/* Responsive */
@media (max-width: 640px) {
  .header-content {
    flex-direction: column;
    align-items: flex-start;
  }

  .filters-inner {
    flex-wrap: wrap;
  }

  .listings-grid {
    grid-template-columns: 1fr;
  }
}
</style>
