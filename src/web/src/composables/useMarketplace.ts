/**
 * Composable for marketplace API operations.
 * Centralizes fetch logic and provides reactive state.
 */
import { ref } from 'vue'

interface Listing {
  id: string
  provider_account_id: string
  agent_display_name: string
  agent_model: string
  agent_ide: string
  agent_description: string | null
  cu_budget_total: number
  cu_budget_used: number
  cu_budget_per_session: number | null
  status: string
  max_concurrent_sessions: number
  price_per_1k_cu: number
  currency: string
  supported_output_types: string[]
  created_at: string
  updated_at: string
}

interface Session {
  id: string
  listing_id: string
  provider_account_id: string
  renter_account_id: string
  task_title: string
  task_description: string
  repo_scope: string
  target_branch: string
  expected_outcome: string
  status: string
  cu_budget: number
  cu_used: number
  started_at: string | null
  ended_at: string | null
  last_heartbeat_at: string | null
  created_at: string
}

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'claude-haiku-3-5': 'Haiku 3.5',
  'claude-sonnet-4': 'Sonnet 4',
  'claude-opus-4': 'Opus 4',
  'claude-opus-4-6': 'Opus 4.6',
  'gpt-4o': 'GPT-4o',
  'gpt-4-1': 'GPT-4.1',
  'o3': 'o3',
  'gemini-2-5-pro': 'Gemini 2.5 Pro',
}

const IDE_DISPLAY_NAMES: Record<string, string> = {
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  windsurf: 'Windsurf',
}

export function useMarketplace() {
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  function getModelDisplayName(model: string): string {
    return MODEL_DISPLAY_NAMES[model] || model
  }

  function getIdeDisplayName(ide: string): string {
    return IDE_DISPLAY_NAMES[ide] || ide
  }

  function formatCU(cu: number): string {
    if (cu >= 1_000_000) return `${(cu / 1_000_000).toFixed(1)}M`
    if (cu >= 1_000) return `${(cu / 1_000).toFixed(0)}K`
    return String(cu)
  }

  async function fetchListings(params?: {
    model?: string
    ide?: string
    page?: number
    limit?: number
  }): Promise<{ listings: Listing[]; total: number }> {
    isLoading.value = true
    error.value = null
    try {
      const query = new URLSearchParams()
      if (params?.model) query.set('model', params.model)
      if (params?.ide) query.set('ide', params.ide)
      if (params?.page) query.set('page', String(params.page))
      if (params?.limit) query.set('limit', String(params.limit))
      const qs = query.toString()

      const res = await fetch(`/api/rental/listings${qs ? `?${qs}` : ''}`)
      if (!res.ok) throw new Error('Failed to fetch listings')
      const data = await res.json()
      return { listings: data.listings, total: data.pagination?.total ?? 0 }
    } catch (e: any) {
      error.value = e.message
      return { listings: [], total: 0 }
    } finally {
      isLoading.value = false
    }
  }

  async function fetchListing(id: string): Promise<Listing | null> {
    isLoading.value = true
    error.value = null
    try {
      const res = await fetch(`/api/rental/listings/${id}`)
      if (!res.ok) throw new Error('Listing not found')
      const data = await res.json()
      return data.listing
    } catch (e: any) {
      error.value = e.message
      return null
    } finally {
      isLoading.value = false
    }
  }

  async function fetchMySessions(): Promise<Session[]> {
    isLoading.value = true
    error.value = null
    try {
      const res = await fetch('/api/rental/sessions/mine', { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to fetch sessions')
      const data = await res.json()
      return data.sessions
    } catch (e: any) {
      error.value = e.message
      return []
    } finally {
      isLoading.value = false
    }
  }

  async function sessionAction(sessionId: string, action: string, body?: object): Promise<boolean> {
    try {
      const res = await fetch(`/api/rental/sessions/${sessionId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: body ? JSON.stringify(body) : undefined,
      })
      return res.ok
    } catch {
      return false
    }
  }

  return {
    isLoading,
    error,
    fetchListings,
    fetchListing,
    fetchMySessions,
    sessionAction,
    getModelDisplayName,
    getIdeDisplayName,
    formatCU,
    MODEL_DISPLAY_NAMES,
    IDE_DISPLAY_NAMES,
  }
}

export type { Listing, Session }
