<template>
  <main class="company-link">
    <CompanyInvitePanel :view="view" :busy="busy" :error="error" :viewer-login="viewerLogin" :viewer-avatar-url="isSignedIn ? user?.avatar_url : null" standalone @action="run">
      <template #footer="{ actions }">
        <div v-if="opensInApp" class="company-link-app">
          <a class="invite-primary company-link-open" :href="appLink" data-testid="company-link-open-app">
            Open in LetAgents<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>
          </a>
          <p v-if="view.kind === 'signed_out'" class="company-link-note">
            Don’t have the app? Download for <a :href="release.downloads.arm64">Apple silicon</a> or <a :href="release.downloads.x64">Intel</a>, then open this link again.
            <button type="button" class="company-link-text" :disabled="isSigningIn" @click="run('sign_in')">Use LetAgents in the browser instead</button>
          </p>
          <p v-else-if="view.kind === 'join' || view.kind === 'setup'" class="company-link-note">
            <button type="button" class="company-link-text" :disabled="busy" data-testid="company-link-join-here" @click="run(view.kind)">{{ view.kind === 'setup' ? 'Set up' : 'Join' }} in your browser</button>
          </p>
          <p v-else-if="view.kind === 'joined'" class="company-link-note">Your company rooms are in the Rooms list of the app.</p>
        </div>
        <div v-else class="company-link-actions">
          <button
            v-for="action in actions"
            :key="action.id"
            type="button"
            :class="action.primary ? 'invite-primary' : 'invite-secondary'"
            :disabled="busy"
            @click="run(action.id)"
          >{{ action.label }}</button>
        </div>
      </template>
    </CompanyInvitePanel>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from '@/composables/useAuth'
import { MAC_DESKTOP_BETA } from '@/domain/desktopRelease'
import CompanyInvitePanel from '../../../../shared/ui/company-invite/CompanyInvitePanel.vue'
import type { CompanyInviteAction, CompanyInviteView } from '../../../../shared/ui/company-invite/types'
import { companyInviteView, isCompanyLinkId } from '../../../../shared/ui/company-invite/view'

interface Organization { github_org_id: string; login: string; avatar_url: string | null; role: 'owner' | 'member'; setup: boolean; joined: boolean }
interface Invitation { github_org_id: string; login: string; avatar_url: string | null }
interface SsoBlock { github_org_id: string; login: string | null }
type Status = 'idle' | 'loading' | 'ready' | 'github_access_required' | 'unavailable'

const route = useRoute()
const { isSignedIn, isSigningIn, hasCheckedSession, user, checkSession, signIn } = useAuth()
const release = MAC_DESKTOP_BETA
const organizationId = computed(() => String(route.params.organizationId ?? ''))
const appLink = computed(() => `letagents://company/${organizationId.value}`)
const viewerLogin = computed(() => isSignedIn.value ? user.value?.login ?? null : null)

const status = ref<Status>('idle')
const accessReason = ref<'scope' | 'signin' | null>(null)
const organizations = ref<Organization[]>([])
const invitations = ref<Invitation[]>([])
const ssoRequired = ref<SsoBlock[]>([])
const justJoined = ref(false)
const roomCount = ref<number | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
let version = 0
let identityVersion = 0

const view = computed<CompanyInviteView>(() => {
  if (!isCompanyLinkId(organizationId.value)) return { kind: 'invalid' }
  if (!hasCheckedSession.value) return { kind: 'loading' }
  if (!isSignedIn.value) return { kind: 'signed_out' }
  return companyInviteView({
    id: organizationId.value, status: status.value, accessReason: accessReason.value,
    organizations: organizations.value, invitations: invitations.value, ssoRequired: ssoRequired.value,
    viewerLogin: viewerLogin.value, justJoined: justJoined.value, roomCount: roomCount.value,
  })
})

/** The app is the main way in: these views lead with "Open in LetAgents". */
const opensInApp = computed(() => ['signed_out', 'join', 'setup', 'joined'].includes(view.value.kind))

async function load(): Promise<void> {
  const current = ++version
  error.value = null
  if (!isSignedIn.value || !isCompanyLinkId(organizationId.value)) { status.value = 'idle'; return }
  if (status.value !== 'ready') status.value = 'loading'
  try {
    const response = await fetch('/account/organizations', { credentials: 'include', headers: { Accept: 'application/json' } })
    const body = await response.json().catch(() => null)
    if (current !== version) return
    if (!response.ok) {
      const code = body?.error
      if (code === 'github_scope_required' || code === 'github_signin_required') {
        status.value = 'github_access_required'
        accessReason.value = code === 'github_scope_required' ? 'scope' : 'signin'
      } else {
        status.value = 'unavailable'
      }
      return
    }
    organizations.value = body?.organizations ?? []
    invitations.value = body?.invitations ?? []
    ssoRequired.value = body?.sso_required ?? []
    accessReason.value = null
    status.value = 'ready'
    if (organizations.value.some((org) => org.github_org_id === organizationId.value && org.joined)) await loadRoomCount(current)
  } catch {
    if (current === version) status.value = 'unavailable'
  }
}

async function loadRoomCount(current: number): Promise<void> {
  try {
    const response = await fetch(`/organizations/${organizationId.value}/rooms`, { credentials: 'include', headers: { Accept: 'application/json' } })
    const body = await response.json().catch(() => null)
    if (current === version) roomCount.value = response.ok && Array.isArray(body?.rooms) ? body.rooms.length : null
  } catch {
    if (current === version) roomCount.value = null
  }
}

async function join(setup: boolean): Promise<void> {
  if (busy.value) return
  // A pre-join refresh must not restore access that this write just refused.
  version += 1
  const currentIdentity = identityVersion
  const id = organizationId.value
  busy.value = true
  error.value = null
  try {
    const response = await fetch(`/organizations/${id}/${setup ? 'setup' : 'join'}`, {
      method: 'POST', credentials: 'include', headers: { Accept: 'application/json' },
    })
    const body = await response.json().catch(() => null)
    if (currentIdentity !== identityVersion) return
    if (!response.ok) {
      const code = body?.error
      if (code === 'github_scope_required' || code === 'github_signin_required') {
        status.value = 'github_access_required'
        accessReason.value = code === 'github_scope_required' ? 'scope' : 'signin'
      } else if (code === 'organization_sso_required') {
        const org = organizations.value.find(item => item.github_org_id === id)
        ssoRequired.value = [{ github_org_id: id, login: org?.login ?? null }]
        organizations.value = organizations.value.filter(item => item.github_org_id !== id)
      } else if (code === 'organization_membership_required') {
        organizations.value = organizations.value.filter(item => item.github_org_id !== id)
        invitations.value = invitations.value.filter(item => item.github_org_id !== id)
      } else if (code === 'organization_owner_required' || code === 'organization_setup_required') {
        organizations.value = organizations.value.map(item => item.github_org_id === id
          ? { ...item, setup: false, role: code === 'organization_owner_required' ? 'member' : item.role } : item)
      } else {
        error.value = 'Couldn’t complete this request. Try again in a moment.'
      }
      return
    }
    justJoined.value = true
    await load()
  } catch {
    if (currentIdentity === identityVersion) error.value = 'Couldn’t reach LetAgents. Check your connection and try again.'
  } finally {
    if (currentIdentity === identityVersion) busy.value = false
  }
}

/** GitHub pages open in a new tab; this page checks again when the person comes back. */
function openGitHub(url: string): void {
  window.open(url, '_blank', 'noopener')
}

function run(action: CompanyInviteAction): void {
  const current = view.value
  const login = 'organization' in current && current.organization ? current.organization.login : null
  switch (action) {
    case 'join': void join(false); return
    case 'setup': void join(true); return
    case 'retry': void load(); return
    case 'sign_in': void signIn(`/company/${organizationId.value}`); return
    case 'allow': {
      const url = new URL('/auth/github/organizations', window.location.origin)
      if (viewerLogin.value) url.searchParams.set('login', viewerLogin.value)
      openGitHub(url.toString())
      return
    }
    case 'open_invitation': if (login) openGitHub(`https://github.com/orgs/${encodeURIComponent(login)}/invitation`); return
    case 'authorize_sso': openGitHub(login ? `https://github.com/orgs/${encodeURIComponent(login)}/sso` : '/auth/github/organizations'); return
    default: return
  }
}

function recheck(): void {
  if (document.visibilityState === 'visible' && isSignedIn.value && !busy.value && status.value !== 'loading') void load()
}

watch([organizationId, isSignedIn, () => user.value?.id], () => {
  identityVersion += 1
  busy.value = false
  organizations.value = []
  invitations.value = []
  ssoRequired.value = []
  accessReason.value = null
  status.value = 'idle'
  justJoined.value = false
  roomCount.value = null
  void load()
}, { flush: 'sync' })
onMounted(async () => {
  window.addEventListener('focus', recheck)
  if (!hasCheckedSession.value) await checkSession()
  if (status.value === 'idle') await load()
})
onBeforeUnmount(() => {
  identityVersion += 1
  version += 1
  window.removeEventListener('focus', recheck)
})
</script>

<style scoped>
.company-link { display: grid; place-items: center; box-sizing: border-box; min-height: 100dvh; padding: 40px 16px; background: var(--bg, light-dark(#fafafa, #0a0a0a)); }
.company-link > .company-invite-panel { width: min(560px, 100%); max-height: calc(100dvh - 80px); }
.company-link-app { display: grid; width: 100%; }
.company-link-open { width: 100%; min-height: 44px; }
.company-link-open svg { width: 15px; height: 15px; }
.company-link-note { margin-top: 14px !important; color: var(--invite-muted); font-size: 14px; line-height: 1.7; text-align: center; }
.company-link-note a, .company-link-text { color: var(--invite-text); text-decoration: underline; text-underline-offset: 3px; }
.company-link-text { display: inline; padding: 0; border: 0; background: none; font: inherit; }
.company-link-note > .company-link-text { display: block; margin: 8px auto 0; }
.company-link-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; width: 100%; }
@media (max-width: 600px) {
  .company-link { padding: max(12px, env(safe-area-inset-top, 0px)) 12px max(12px, env(safe-area-inset-bottom, 0px)); }
  .company-link > .company-invite-panel { max-height: none; overflow: visible; }
  .company-link :deep(.invite-body) { overflow: visible; }
  .company-link-note { font-size: 13px; }
  .company-link-note a { display: inline-block; padding-block: 8px; }
}
</style>
