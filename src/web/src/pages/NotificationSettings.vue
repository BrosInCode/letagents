<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'

const router = useRouter()
const { isSignedIn, checkSession } = useAuth()

const prefs = ref({
  email_enabled: true,
  email_address: '',
  telegram_enabled: false,
  telegram_chat_id: '',
  whatsapp_enabled: false,
  whatsapp_number: '',
})

const isLoading = ref(true)
const isSaving = ref(false)
const saved = ref(false)
const errorMsg = ref<string | null>(null)

async function fetchPrefs() {
  isLoading.value = true
  try {
    const res = await fetch('/api/rental/notifications', { credentials: 'include' })
    if (res.ok) {
      const data = await res.json()
      prefs.value = {
        email_enabled: data.email_enabled ?? true,
        email_address: data.email_address || '',
        telegram_enabled: data.telegram_enabled ?? false,
        telegram_chat_id: data.telegram_chat_id || '',
        whatsapp_enabled: data.whatsapp_enabled ?? false,
        whatsapp_number: data.whatsapp_number || '',
      }
    }
  } finally {
    isLoading.value = false
  }
}

async function savePrefs() {
  isSaving.value = true
  saved.value = false
  errorMsg.value = null
  try {
    const res = await fetch('/api/rental/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(prefs.value),
    })
    if (!res.ok) {
      const data = await res.json()
      errorMsg.value = data.error || 'Failed to save'
    } else {
      saved.value = true
      setTimeout(() => { saved.value = false }, 3000)
    }
  } catch (e: any) {
    errorMsg.value = e.message
  } finally {
    isSaving.value = false
  }
}

onMounted(async () => {
  await checkSession()
  if (isSignedIn.value) await fetchPrefs()
})
</script>

<template>
  <div class="notif-page">
    <div class="notif-container">
      <button class="back-btn" @click="router.push({ name: 'provider-dashboard' })">← Dashboard</button>
      <h1>Notification Settings</h1>
      <p class="subtitle">Choose how you'd like to be notified about rental requests and session events.</p>

      <div v-if="!isSignedIn" class="auth-warning">Sign in to manage notifications.</div>
      <div v-else-if="isLoading" class="loading"><div class="spinner"></div></div>

      <form v-else @submit.prevent="savePrefs" class="notif-form">
        <div v-if="errorMsg" class="form-error">{{ errorMsg }}</div>
        <div v-if="saved" class="form-success">✓ Saved successfully</div>

        <!-- Email -->
        <div class="channel-section">
          <div class="channel-header">
            <label class="toggle-label">
              <input type="checkbox" v-model="prefs.email_enabled" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="channel-name">📧 Email</span>
            </label>
          </div>
          <div v-if="prefs.email_enabled" class="channel-body">
            <div class="form-group">
              <label for="email_address">Email Address</label>
              <input id="email_address" v-model="prefs.email_address" type="email" placeholder="you@example.com" />
            </div>
          </div>
        </div>

        <!-- Telegram -->
        <div class="channel-section">
          <div class="channel-header">
            <label class="toggle-label">
              <input type="checkbox" v-model="prefs.telegram_enabled" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="channel-name">💬 Telegram</span>
            </label>
          </div>
          <div v-if="prefs.telegram_enabled" class="channel-body">
            <div class="form-group">
              <label for="telegram_chat_id">Chat ID</label>
              <input id="telegram_chat_id" v-model="prefs.telegram_chat_id" type="text" placeholder="123456789" />
              <span class="hint">Message @userinfobot on Telegram to get your chat ID</span>
            </div>
          </div>
        </div>

        <!-- WhatsApp -->
        <div class="channel-section">
          <div class="channel-header">
            <label class="toggle-label">
              <input type="checkbox" v-model="prefs.whatsapp_enabled" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
              <span class="channel-name">📱 WhatsApp</span>
            </label>
          </div>
          <div v-if="prefs.whatsapp_enabled" class="channel-body">
            <div class="form-group">
              <label for="whatsapp_number">Phone Number</label>
              <input id="whatsapp_number" v-model="prefs.whatsapp_number" type="tel" placeholder="+1234567890" />
              <span class="hint">Include country code (e.g. +234...)</span>
            </div>
          </div>
        </div>

        <div class="form-actions">
          <button type="submit" class="btn-save" :disabled="isSaving">
            {{ isSaving ? 'Saving...' : 'Save Preferences' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.notif-page { min-height: 100vh; background: linear-gradient(135deg, #0a0a1a 0%, #1a1a3e 50%, #0a0a1a 100%); color: #e0e0e0; font-family: 'Inter', system-ui, sans-serif; }
.notif-container { max-width: 600px; margin: 0 auto; padding: 2rem; }
.back-btn { background: none; border: none; color: rgba(255, 255, 255, 0.5); cursor: pointer; font-size: 0.9rem; padding: 0; margin-bottom: 2rem; }
.back-btn:hover { color: #a78bfa; }
h1 { font-size: 1.8rem; background: linear-gradient(135deg, #a78bfa, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin: 0 0 0.5rem; }
.subtitle { color: rgba(255, 255, 255, 0.4); margin-bottom: 2rem; }

.notif-form { display: flex; flex-direction: column; gap: 1.25rem; }
.form-error { background: rgba(244, 63, 94, 0.1); border: 1px solid rgba(244, 63, 94, 0.3); padding: 0.75rem; border-radius: 10px; color: #fb7185; font-size: 0.9rem; }
.form-success { background: rgba(52, 211, 153, 0.1); border: 1px solid rgba(52, 211, 153, 0.3); padding: 0.75rem; border-radius: 10px; color: #34d399; font-size: 0.9rem; }

.channel-section { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px; overflow: hidden; }
.channel-header { padding: 1rem 1.25rem; }
.channel-body { padding: 0 1.25rem 1.25rem; border-top: 1px solid rgba(255, 255, 255, 0.04); padding-top: 1rem; }

.toggle-label { display: flex; align-items: center; gap: 0.75rem; cursor: pointer; }
.toggle-label input { display: none; }
.toggle-track { width: 40px; height: 22px; border-radius: 11px; background: rgba(255, 255, 255, 0.1); position: relative; transition: background 0.2s; flex-shrink: 0; }
.toggle-label input:checked + .toggle-track { background: #6366f1; }
.toggle-thumb { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 9px; background: white; transition: transform 0.2s; }
.toggle-label input:checked + .toggle-track .toggle-thumb { transform: translateX(18px); }
.channel-name { font-size: 1rem; font-weight: 600; color: #e0e0e0; }

.form-group { display: flex; flex-direction: column; gap: 0.3rem; }
.form-group label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(255, 255, 255, 0.4); font-weight: 600; }
.form-group input { background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); color: #e0e0e0; padding: 0.6rem 0.8rem; border-radius: 8px; font-size: 0.9rem; font-family: inherit; }
.form-group input:focus { outline: none; border-color: #6366f1; }
.hint { font-size: 0.7rem; color: rgba(255, 255, 255, 0.25); }

.form-actions { text-align: center; padding-top: 0.5rem; }
.btn-save { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; border: none; padding: 0.75rem 3rem; border-radius: 12px; font-size: 0.95rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }
.btn-save:hover { transform: translateY(-2px); box-shadow: 0 6px 25px rgba(99, 102, 241, 0.5); }
.btn-save:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

.auth-warning { background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.3); padding: 1rem; border-radius: 10px; color: #fbbf24; text-align: center; }
.loading { text-align: center; padding: 4rem; }
.spinner { width: 36px; height: 36px; border: 3px solid rgba(99, 102, 241, 0.2); border-top-color: #6366f1; border-radius: 50%; margin: 0 auto; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
