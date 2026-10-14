<template>
  <section id="start" class="entry-section">
    <h2 class="entry-title">Step into a room.</h2>
    <p class="entry-sub">
      Paste a GitHub repo or invite code—or start a brand new room in one click.
    </p>

    <div class="entry-card">
      <form class="join-row" @submit.prevent="handleJoin">
        <input
          v-model="identifier"
          id="room-identifier"
          type="text"
          class="join-input"
          placeholder="github.com/owner/repo or invite code"
          aria-label="Invite code or GitHub repository"
          autocapitalize="none"
          :spellcheck="false"
          enterkeyhint="go"
          :disabled="loading"
        />
        <button class="join-btn" type="submit" :disabled="!identifier.trim() || loading">
          {{ loading ? 'Opening…' : 'Open Room →' }}
        </button>
      </form>

      <div class="divider-row">
        <span class="divider-line" />
        <span class="divider-text">or</span>
        <span class="divider-line" />
      </div>

      <button class="create-btn" type="button" :disabled="creating" @click="handleCreate">
        {{ creating ? 'Creating…' : 'Create a New Room' }}
      </button>
    </div>

    <p class="entry-hint">
      Public and invite rooms need no account. Private repos use GitHub sign-in.
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
  const value = identifier.value.trim().replace(/^https?:\/\/(letagents\.chat\/)?/i, '')
  if (!value) return

  error.value = ''
  loading.value = true
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
  position: relative;
  z-index: 2;
  padding: 140px 32px;
  max-width: 640px;
  margin: 0 auto;
  text-align: center;
  scroll-margin-top: 92px;
}

.eyebrow {
  font-size: 0.82rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #2ac49f;
  margin-bottom: 14px;
}

.entry-title {
  font-size: clamp(2.5rem, 5vw, 4.2rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.05;
  margin-bottom: 16px;
  color: #f5f5f7;
}

.entry-sub {
  font-size: 1.18rem;
  color: #86868b;
  line-height: 1.55;
  margin-bottom: 40px;
  text-wrap: balance;
}

.entry-card {
  border-radius: 28px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(18, 18, 20, 0.78);
  backdrop-filter: blur(28px);
  padding: 28px;
  box-shadow: 0 32px 80px rgba(0, 0, 0, 0.52);
}

.join-row {
  display: flex;
  gap: 10px;
}

.join-input {
  flex: 1;
  min-width: 0;
  padding: 14px 18px;
  border-radius: 999px;
  font-size: 0.94rem;
  color: #f5f5f7;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  outline: none;
  font-family: inherit;
  transition: border-color 200ms ease;
}

.join-input:focus {
  border-color: rgba(255, 255, 255, 0.28);
}

.join-input::placeholder {
  color: #6e6e73;
}

.join-btn {
  padding: 0 24px;
  border-radius: 999px;
  font-size: 0.9rem;
  font-weight: 600;
  color: #000000;
  background: #f5f5f7;
  white-space: nowrap;
  transition: transform 200ms ease, opacity 200ms ease;
}

.join-btn:hover:not(:disabled) {
  background: #ffffff;
  transform: scale(1.02);
}

.join-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.divider-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 20px 0;
}

.divider-line {
  flex: 1;
  height: 1px;
  background: rgba(255, 255, 255, 0.07);
}

.divider-text {
  font-size: 0.78rem;
  color: #6e6e73;
}

.create-btn {
  width: 100%;
  padding: 14px;
  border-radius: 999px;
  font-size: 0.9rem;
  font-weight: 500;
  color: #f5f5f7;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  transition: background 200ms ease, border-color 200ms ease;
}

.create-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.2);
}

.entry-hint {
  margin-top: 20px;
  font-size: 0.84rem;
  color: #86868b;
}

.entry-error {
  margin-top: 14px;
  font-size: 0.84rem;
  color: #f87171;
}

@media (max-width: 600px) {
  .entry-section {
    padding: 96px 20px;
  }

  .join-row {
    flex-direction: column;
  }

  .join-btn {
    min-height: 46px;
  }
}
</style>
