<template>
  <section class="company-join">
    <p class="eyebrow">LetAgents · Company invitation</p>
    <h1>{{ organization?.login || 'Join your company' }}</h1>
    <p>Your GitHub account connects you to your company’s repo rooms.</p>
    <p v-if="!validId" role="alert">This company link is invalid.</p>
    <p v-else-if="auth.isCheckingSession.value || busy" role="status">Checking your GitHub access…</p>
    <button v-else-if="!auth.isSignedIn.value" :disabled="auth.isSigningIn.value" @click="auth.signIn(`/join/${organizationId}`)">Sign in with GitHub</button>
    <template v-else>
      <p v-if="error" role="alert">{{ error }}</p>
      <template v-else-if="organization">
        <p v-if="!organization.setup && organization.role !== 'owner'">An organization owner needs to set up this company in LetAgents first.</p>
        <button v-else-if="!joined" @click="join">{{ organization.setup ? 'Join company' : 'Set up company' }}</button>
        <template v-else>
          <p role="status">You’re connected to {{ organization.login }}.</p>
          <a :href="`letagents://join/${organizationId}`" class="company-open">Open in LetAgents Desktop</a>
          <p v-if="!rooms.length">No connected repo rooms yet. You can open a repository from LetAgents.</p>
          <ul><li v-for="room in rooms" :key="room.room_id"><a :href="`/in/${room.room_id}`">{{ room.full_name }}</a></li></ul>
        </template>
      </template>
      <button class="secondary" @click="load">Refresh access</button>
      <button class="secondary" @click="auth.signOut">Use another GitHub account</button>
    </template>
    <a href="/" class="personal">Continue with personal or shared rooms</a>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from '../composables/useAuth'

interface Organization { github_org_id: string; login: string; role: 'owner' | 'member'; setup: boolean; joined: boolean }
interface Room { room_id: string; full_name: string }
const route = useRoute()
const auth = useAuth()
const organizationId = computed(() => String(route.params.organizationId))
const validId = computed(() => /^[1-9][0-9]*$/.test(organizationId.value))
const organization = ref<Organization | null>(null)
const rooms = ref<Room[]>([])
const joined = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
let version = 0

async function request(path: string, method = 'GET') {
  const response = await fetch(path, { method, credentials: 'include', headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error('Couldn’t verify company access. Refresh or sign in again with the account your company added.')
  return response.json()
}

async function load() {
  const current = ++version
  organization.value = null
  rooms.value = []
  joined.value = false
  error.value = null
  if (!auth.isSignedIn.value || !validId.value) { busy.value = false; return }
  busy.value = true
  const id = organizationId.value
  try {
    const data = await request('/account/organizations')
    if (current !== version) return
    organization.value = data.organizations.find((org: Organization) => org.github_org_id === id) || null
    if (!organization.value) { error.value = 'This GitHub account is not an active member of the invited organization.'; return }
    joined.value = organization.value.joined
    if (joined.value) {
      const result = await request(`/organizations/${id}/rooms`)
      if (current === version) rooms.value = result.rooms
    }
  } catch (cause) { if (current === version) error.value = (cause as Error).message }
  finally { if (current === version) busy.value = false }
}

async function join() {
  if (busy.value || !organization.value) return
  const current = ++version
  busy.value = true
  error.value = null
  try {
    await request(`/organizations/${organizationId.value}/${organization.value.setup ? 'join' : 'setup'}`, 'POST')
    if (current !== version) return
    await load()
  } catch (cause) { if (current === version) { error.value = (cause as Error).message; busy.value = false } }
}

watch([organizationId, auth.isSignedIn, () => auth.user.value?.login], load, { flush: 'sync' })
onMounted(async () => { await auth.checkSession(); if (!busy.value) await load() })
</script>

<style scoped>
.company-join { max-width: 560px; margin: 130px auto 70px; padding: 28px; }
.company-join h1 { font-size: 36px; letter-spacing: -.03em; }
.company-join p { line-height: 1.6; }
.eyebrow { opacity: .6; font-size: 13px; }
.company-join button, .company-open { display: inline-block; background: var(--text-primary, #eee); color: var(--bg-primary, #171717); padding: 12px 18px; border-radius: 8px; border: 1px solid currentColor; cursor: pointer; font: inherit; margin: 8px 8px 8px 0; }
.company-join .secondary { background: transparent; color: inherit; font-size: 14px; }
.company-join :focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
.company-join .personal { display: block; margin-top: 24px; }
.company-join li { margin: 12px 0; }
</style>
