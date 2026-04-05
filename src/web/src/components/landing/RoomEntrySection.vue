<template>
  <section id="start" class="section entry-section">
    <span class="section-label">Open a Room</span>
    <h2 class="entry-title">Jump straight in.</h2>
    <p class="entry-sub">
      Enter a room name, invite code, or GitHub repo path — or spin up a fresh room instantly.
    </p>

    <div class="entry-card">
      <form class="join-row" @submit.prevent="handleJoin">
        <div class="input-wrap">
          <svg class="input-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
            <polyline points="10 17 15 12 10 7"/>
            <line x1="15" y1="12" x2="3" y2="12"/>
          </svg>
          <input
            v-model="identifier"
            type="text"
            class="join-input"
            placeholder="github.com/owner/repo, ABCX-7291, or my-room.."
            :disabled="loading"
          />
        </div>
        <button class="join-btn" type="submit" :disabled="!identifier.trim() || loading">
          {{ loading ? 'Joining…' : 'Join →' }}
        </button>
      </form>

      <div class="divider-row">
        <span class="divider-line" />
        <span class="divider-text">OR</span>
        <span class="divider-line" />
      </div>

      <button class="create-btn" :disabled="creating" @click="handleCreate">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        {{ creating ? 'Creating…' : 'Create New Room' }}
      </button>
    </div>

    <p class="entry-hint">
      Rooms are created on-the-fly. No account needed — type any name to join or create it.
    </p>

    <p v-if="error" class="entry-error">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const identifier = ref('')
const loading = ref(false)
const creating = ref(false)
const error = ref('')

function handleJoin() {
  const value = identifier.value.trim()
  if (!value) return

  error.value = ''
  loading.value = true

  // Invite code pattern (e.g. ABCX-7291)
  if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(value)) {
    router.push(`/in/${encodeURIComponent(value)}`)
    return
  }

  // Room name or repo path — navigate directly
  router.push(`/in/${encodeURIComponent(value)}`)
}

async function handleCreate() {
  error.value = ''
  creating.value = true
  try {
    const res = await fetch('/projects', { method: 'POST' })
    if (!res.ok) throw new Error('Failed to create room')
    const data = await res.json()
    const roomId = data.project?.id || data.id
    if (!roomId) throw new Error('No room ID returned')
    router.push(`/in/${encodeURIComponent(roomId)}`)
  } catch (e: any) {
    error.value = e.message || 'Something went wrong'
  } finally {
    creating.value = false
  }
}
</script>

<style scoped>
.entry-section {
  padding: 120px 40px;
  max-width: var(--max-width);
  margin: 0 auto;
}

.entry-title {
  font-size: 3rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.15;
  margin-bottom: var(--space-md);
  color: var(--text);
}

.entry-sub {
  font-size: 1.08rem;
  color: var(--text-secondary);
  max-width: 560px;
  line-height: 1.7;
  margin-bottom: var(--space-2xl);
}

.entry-card {
  border-radius: 28px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: #161616;
  padding: 32px 36px;
}

.join-row {
  display: flex;
  align-items: stretch;
  gap: var(--space-sm);
}

.input-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 0 var(--space-md);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  transition: border-color var(--duration-fast);
}

.input-wrap:focus-within {
  border-color: var(--border-accent);
}

.input-icon {
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.join-input {
  flex: 1;
  padding: 14px 0;
  font-size: 0.88rem;
  color: var(--text);
  background: transparent;
  border: none;
  outline: none;
  font-family: inherit;
}

.join-input::placeholder {
  color: var(--text-tertiary);
}

.join-btn {
  padding: 12px 20px;
  border-radius: var(--radius-md);
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--bg);
  background: var(--text);
  border: none;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity var(--duration-fast);
}

.join-btn:hover:not(:disabled) {
  opacity: 0.9;
}

.join-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.divider-row {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  margin: var(--space-xl) 0;
}

.divider-line {
  flex: 1;
  height: 1px;
  background: var(--border);
}

.divider-text {
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--text-tertiary);
}

.create-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  padding: 14px;
  border-radius: var(--radius-md);
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border);
  cursor: pointer;
  transition: all var(--duration-fast);
}

.create-btn:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border-strong);
  background: rgba(255, 255, 255, 0.03);
}

.create-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.entry-hint {
  margin-top: var(--space-lg);
  font-size: 0.88rem;
  color: var(--text-tertiary);
}

.entry-error {
  margin-top: var(--space-md);
  font-size: 0.82rem;
  color: #ef4444;
}

@media (max-width: 768px) {
  .entry-section { padding: 80px 20px; }
  .entry-title { font-size: 2.2rem; }
  .entry-card { border-radius: 20px; padding: 16px 18px; }
}

@media (max-width: 480px) {
  .entry-section { padding: 64px 16px; }
  .entry-card { border-radius: 16px; padding: 14px 16px; }
  .join-row { flex-direction: column; }
}
</style>
