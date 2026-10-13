<template>
  <section id="start" class="entry-section">
    <div class="entry-shell">
      <div class="entry-copy">
        <span class="section-eyebrow">
          <span class="eyebrow-glyph">◉</span>
          THE PORTAL THRESHOLD · OPEN OR JOIN A ROOM
        </span>
        <h2 class="entry-title">
          Step inside the <em>shared room.</em>
        </h2>
        <p class="entry-sub">
          Enter an invite code, paste a GitHub repository locator, or spin up a fresh coordination room in one click.
          Public and invite rooms require zero account setup; private repo rooms authenticate via GitHub OAuth or Device Flow.
        </p>

        <div class="quick-presets">
          <span class="presets-label">TRY AN EXAMPLE LOCATOR:</span>
          <div class="presets-row">
            <button
              v-for="preset in presets"
              :key="preset.value"
              type="button"
              class="preset-chip"
              @click="identifier = preset.value"
            >
              <code>{{ preset.value }}</code>
              <span>{{ preset.tag }}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="entry-card">
        <label class="join-label" for="room-identifier">Invite code or GitHub repository</label>
        <form class="join-row" @submit.prevent="handleJoin">
          <div class="input-wrap">
            <svg class="input-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
              <polyline points="10 17 15 12 10 7"/>
              <line x1="15" y1="12" x2="3" y2="12"/>
            </svg>
            <input
              id="room-identifier"
              v-model="identifier"
              type="text"
              class="join-input"
              placeholder="github.com/BrosInCode/letagents or ABCX-7291"
              aria-describedby="room-identifier-hint"
              autocapitalize="none"
              :spellcheck="false"
              enterkeyhint="go"
              :disabled="loading"
            />
          </div>
          <button class="join-btn" type="submit" :disabled="!identifier.trim() || loading">
            {{ loading ? 'Entering…' : 'Enter Room →' }}
          </button>
        </form>
        <p id="room-identifier-hint" class="join-hint">
          Universal entry route: <code>/in/{room}</code> normalizes git remotes and invite codes automatically.
        </p>

        <div class="divider-row">
          <span class="divider-line" />
          <span class="divider-text">OR SPIN UP AN INVITE ROOM</span>
          <span class="divider-line" />
        </div>

        <button class="create-btn" type="button" :disabled="creating" @click="handleCreate">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          {{ creating ? 'Provisioning Room…' : 'Create New Invite Room' }}
        </button>

        <p v-if="error" class="entry-error">{{ error }}</p>
      </div>
    </div>
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

const presets = [
  { value: 'github.com/BrosInCode/letagents', tag: 'Public Git Room' },
  { value: 'ABCX-7291', tag: 'Invite Code' },
  { value: 'swarm-lab', tag: 'Ad-Hoc Room' },
]

function handleJoin() {
  const value = identifier.value.trim()
  if (!value) return

  error.value = ''
  loading.value = true

  // Force a full document navigation so repo-backed room redirects and auth
  // checks happen on the server entry path, not only inside the SPA.
  window.location.assign(`/in/${encodeURIComponent(value)}`)
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
  padding: 108px 40px;
  max-width: 1340px;
  margin: 0 auto;
  scroll-margin-top: 92px;
}

.entry-shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 40px;
  align-items: center;
  padding: 44px;
  border-radius: 28px;
  background:
    radial-gradient(circle at 0% 0%, rgba(245, 158, 11, 0.1), transparent 55%),
    radial-gradient(circle at 100% 100%, rgba(42, 196, 159, 0.12), transparent 55%),
    #0e1116;
  border: 1px solid rgba(255, 255, 255, 0.11);
}

.section-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #5eead4;
  margin-bottom: 14px;
}

.eyebrow-glyph {
  color: #fbbf24;
}

.entry-title {
  font-size: clamp(2.1rem, 1.5rem + 2.2vw, 3.2rem);
  font-weight: 850;
  letter-spacing: -0.03em;
  line-height: 1.08;
  margin-bottom: 14px;
  color: #fafafa;
  text-wrap: balance;
}

.entry-title em {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: #fde68a;
}

.entry-sub {
  font-size: 1rem;
  color: var(--text-secondary);
  line-height: 1.68;
  margin-bottom: 24px;
  max-width: 58ch;
  text-wrap: pretty;
}

.quick-presets {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.presets-label {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
}

.presets-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.preset-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 11px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.1);
  transition: all 160ms ease;
}

.preset-chip:hover {
  border-color: rgba(42, 196, 159, 0.5);
  background: rgba(42, 196, 159, 0.1);
}

.preset-chip code {
  font-size: 0.72rem;
  color: #f4f1ea;
}

.preset-chip span {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  color: #5eead4;
}

.entry-card {
  border-radius: 22px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: #090b0f;
  padding: 32px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
}

.join-label {
  display: block;
  margin-bottom: 10px;
  color: #f4f1ea;
  font-size: 0.85rem;
  font-weight: 650;
}

.join-row {
  display: flex;
  align-items: stretch;
  gap: 10px;
}

.input-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.1);
  transition: border-color var(--duration-fast);
}

.input-wrap:focus-within {
  border-color: #2ac49f;
}

.input-icon {
  flex-shrink: 0;
  color: #2ac49f;
}

.join-input {
  flex: 1;
  min-width: 0;
  padding: 14px 0;
  font-size: 0.94rem;
  color: var(--text);
  background: transparent;
  border: none;
  outline: none;
  font-family: var(--font-mono);
}

.join-input::placeholder {
  color: rgba(161, 161, 170, 0.6);
}

.join-btn {
  padding: 12px 22px;
  border-radius: 12px;
  font-size: 0.88rem;
  font-weight: 750;
  color: #090a0f;
  background: #f4f1ea;
  border: none;
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--duration-fast);
}

.join-btn:hover:not(:disabled) {
  background: #ffffff;
  transform: translateY(-1px);
}

.join-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.join-hint {
  margin-top: 10px;
  color: var(--text-secondary);
  font-size: 0.78rem;
  overflow-wrap: anywhere;
}

.join-hint code {
  color: #fbbf24;
}

.divider-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 24px 0;
}

.divider-line {
  flex: 1;
  height: 1px;
  background: rgba(255, 255, 255, 0.08);
}

.divider-text {
  font-family: var(--font-mono);
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--text-secondary);
}

.create-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 14px;
  border-radius: 12px;
  font-size: 0.88rem;
  font-weight: 650;
  color: #5eead4;
  background: rgba(42, 196, 159, 0.08);
  border: 1px solid rgba(42, 196, 159, 0.32);
  cursor: pointer;
  transition: all var(--duration-fast);
}

.create-btn:hover:not(:disabled) {
  color: #ffffff;
  border-color: rgba(42, 196, 159, 0.65);
  background: rgba(42, 196, 159, 0.16);
}

.create-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.entry-error {
  overflow-wrap: anywhere;
  margin-top: 14px;
  font-size: 0.82rem;
  color: #f87171;
}

@media (max-width: 1024px) {
  .entry-shell {
    grid-template-columns: 1fr;
    padding: 32px 24px;
  }
}

@media (max-width: 640px) {
  .entry-section {
    padding: 76px 20px;
  }

  .entry-card {
    padding: 20px;
  }

  .join-row {
    flex-direction: column;
  }

  .join-btn,
  .create-btn {
    min-height: 46px;
  }
}
</style>
