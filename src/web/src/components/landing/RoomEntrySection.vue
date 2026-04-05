<template>
  <section id="start" class="section entry-section">
    <span class="section-label">Open a Room</span>
    <h2 class="entry-title">Jump straight in.</h2>
    <p class="entry-sub">
      Enter a room name, invite code, or GitHub repo path — or spin up a fresh room instantly.
    </p>

    <div class="entry-card">
      <form class="entry-form" @submit.prevent="handleJoin">
        <div class="entry-input-wrap" :class="{ 'entry-input-wrap--focus': inputFocused }">
          <svg class="entry-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <polyline points="10 17 15 12 10 7" />
            <line x1="15" y1="12" x2="3" y2="12" />
          </svg>
          <input
            ref="inputEl"
            v-model="roomInput"
            class="entry-input"
            type="text"
            placeholder="github.com/owner/repo, ABCX-7291, or my-room..."
            autocomplete="off"
            spellcheck="false"
            @focus="inputFocused = true"
            @blur="inputFocused = false"
          />
          <button
            class="entry-join-btn"
            type="submit"
            :disabled="!roomInput.trim() || isJoining"
          >
            <template v-if="isJoining">
              <span class="entry-spinner" />
            </template>
            <template v-else>
              Join →
            </template>
          </button>
        </div>
      </form>

      <div class="entry-divider">
        <span class="entry-divider-line" />
        <span class="entry-divider-text">or</span>
        <span class="entry-divider-line" />
      </div>

      <button
        class="entry-create-btn"
        :disabled="isCreating"
        @click="handleCreate"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <template v-if="isCreating">Creating...</template>
        <template v-else>Create New Room</template>
      </button>

      <p v-if="error" class="entry-error">{{ error }}</p>
    </div>

    <p class="entry-hint">
      Rooms are created on-the-fly. No account needed — just pick a name and go.
    </p>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

const roomInput = ref('')
const inputFocused = ref(false)
const isJoining = ref(false)
const isCreating = ref(false)
const error = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

function encodeRoomPath(identifier: string): string {
  return String(identifier)
    .trim()
    .split('/')
    .map(s => encodeURIComponent(s))
    .join('/')
}

async function handleJoin() {
  const value = roomInput.value.trim()
  if (!value) return

  error.value = ''
  isJoining.value = true

  try {
    // Navigate to /in/<identifier> — the Room page handles the join API call
    const encoded = encodeRoomPath(value)
    await router.push(`/in/${encoded}`)
  } catch (err: any) {
    error.value = err.message || 'Could not navigate to room.'
  } finally {
    isJoining.value = false
  }
}

async function handleCreate() {
  error.value = ''
  isCreating.value = true

  try {
    const res = await fetch('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(body || `Failed to create room (${res.status})`)
    }

    const data = await res.json()
    const roomId = data.room_id || data.id || data.code
    if (!roomId) throw new Error('No room ID returned')

    await router.push(`/in/${encodeRoomPath(roomId)}`)
  } catch (err: any) {
    error.value = err.message || 'Could not create room.'
  } finally {
    isCreating.value = false
  }
}
</script>

<style scoped>
.entry-section {
  padding: 80px 40px 100px;
  text-align: center;
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
  max-width: 520px;
  margin: 0 auto var(--space-2xl);
  line-height: 1.7;
}

/* ── Card ── */
.entry-card {
  max-width: 560px;
  margin: 0 auto;
  padding: 28px;
  border-radius: 24px;
  border: 1px solid var(--border);
  background: rgba(20, 20, 20, 0.6);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.03),
    0 8px 40px rgba(0, 0, 0, 0.35);
}

/* ── Input bar ── */
.entry-form {
  width: 100%;
}

.entry-input-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 6px 6px 16px;
  border-radius: 16px;
  border: 1px solid var(--border-strong);
  background: rgba(255, 255, 255, 0.03);
  transition: border-color var(--duration-normal) var(--ease-out),
              box-shadow var(--duration-normal) var(--ease-out);
}

.entry-input-wrap--focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.04),
              0 4px 20px rgba(0, 0, 0, 0.2);
}

.entry-icon {
  flex-shrink: 0;
  opacity: 0.35;
  transition: opacity var(--duration-fast);
}

.entry-input-wrap--focus .entry-icon {
  opacity: 0.6;
}

.entry-input {
  flex: 1;
  min-width: 0;
  padding: 10px 4px;
  border: none;
  background: none;
  outline: none;
  font-size: 0.92rem;
  font-family: var(--font-sans);
  color: var(--text);
  letter-spacing: -0.01em;
}

.entry-input::placeholder {
  color: var(--text-muted);
  font-weight: 400;
}

.entry-join-btn {
  flex-shrink: 0;
  padding: 10px 22px;
  border-radius: 12px;
  border: none;
  background: rgba(255, 255, 255, 0.9);
  color: #0a0a0a;
  font-weight: 700;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all var(--duration-fast);
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.entry-join-btn:hover:not(:disabled) {
  background: #fff;
  box-shadow: 0 2px 12px rgba(255, 255, 255, 0.15);
}

.entry-join-btn:active:not(:disabled) {
  transform: scale(0.97);
}

.entry-join-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

/* ── Spinner ── */
.entry-spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid rgba(10, 10, 10, 0.2);
  border-top-color: #0a0a0a;
  border-radius: 50%;
  animation: spin 600ms linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Divider ── */
.entry-divider {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 22px 0;
}

.entry-divider-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--border-strong),
    transparent
  );
}

.entry-divider-text {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

/* ── Create button ── */
.entry-create-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 12px 24px;
  border-radius: 12px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.88rem;
  cursor: pointer;
  transition: all var(--duration-fast);
}

.entry-create-btn:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border-accent);
  background: var(--accent-dim);
}

.entry-create-btn:active:not(:disabled) {
  transform: scale(0.98);
}

.entry-create-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ── Error ── */
.entry-error {
  margin-top: 14px;
  font-size: 0.8rem;
  color: var(--red);
  line-height: 1.4;
}

/* ── Hint ── */
.entry-hint {
  margin-top: var(--space-lg);
  font-size: 0.82rem;
  color: var(--text-muted);
}

/* ── Responsive ── */
@media (max-width: 768px) {
  .entry-section { padding: 64px 20px 80px; }
  .entry-title { font-size: 2.2rem; }
  .entry-card { padding: 20px; border-radius: 20px; }
  .entry-input-wrap { padding: 4px 4px 4px 12px; border-radius: 12px; }
  .entry-input { font-size: 0.85rem; }
  .entry-join-btn { padding: 8px 16px; border-radius: 10px; }
}

@media (max-width: 480px) {
  .entry-section { padding: 48px 16px 64px; }
  .entry-card { padding: 16px; border-radius: 16px; }
  .entry-input::placeholder { font-size: 0.78rem; }
}
</style>
