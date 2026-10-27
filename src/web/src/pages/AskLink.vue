<template>
  <main class="ask-link">
    <GiveAgentPanel handoff :request="ask" :loading="loading" :unavailable="unavailable" :error="error" @retry="load">
      <template #handoff>
        <a class="give-primary ask-open-app" :href="appLink">Open in LetAgents<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg></a>
        <p class="ask-downloads">Don’t have the app? Download for <a :href="release.downloads.arm64">Apple silicon</a> or <a :href="release.downloads.x64">Intel</a>, then open this link again.</p>
      </template>
    </GiveAgentPanel>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAuth } from '@/composables/useAuth'
import { MAC_DESKTOP_BETA } from '@/domain/desktopRelease'
import GiveAgentPanel from '../../../../shared/ui/give-agent/GiveAgentPanel.vue'
import type { GiveAgentRequest } from '../../../../shared/ui/give-agent/types'

const { isSignedIn, user, hasCheckedSession, checkSession } = useAuth()
const accountId = computed(() => isSignedIn.value ? user.value?.id ?? null : null)
onMounted(() => { if (!hasCheckedSession.value) void checkSession() })
const props = defineProps<{ token: string }>()
const loading = ref(true)
const ask = ref<GiveAgentRequest | null>(null)
const unavailable = ref<string | null>(null)
const error = ref<string | null>(null)
const release = MAC_DESKTOP_BETA
const appLink = computed(() => `letagents://ask/${encodeURIComponent(props.token)}`)
let generation = 0
onBeforeUnmount(() => { generation++ })
watch([() => props.token, accountId], () => { void load() }, { immediate: true, flush: 'sync' })
async function load() {
  const version = ++generation, viewer = accountId.value
  loading.value = true; ask.value = null; unavailable.value = null; error.value = null
  try {
    const response = await fetch(`/agent-asks/link/${encodeURIComponent(props.token)}`, { credentials: viewer ? 'same-origin' : 'omit' })
    const body = await response.json().catch(() => null)
    if (version !== generation) return
    if (!response.ok) {
      if (response.status >= 500) error.value = body?.error ?? 'Couldn’t reach LetAgents. Try again.'
      else unavailable.value = body?.error ?? "This link isn't valid."
      return
    }
    if (!body?.ask) { error.value = 'Couldn’t open this request. Try again.'; return }
    // A logout can precede cookie removal; never retain signed-in details in an anonymous preview.
    ask.value = viewer ? body.ask : {
      id: body.ask.id, asker: body.ask.asker, provider_id: body.ask.provider_id,
      model_label: body.ask.model_label, amount_percent: body.ask.amount_percent,
    }
    unavailable.value = body.unavailable?.error ?? null
  } catch {
    if (version === generation) error.value = "Couldn't reach LetAgents. Check your connection and try again."
  } finally {
    if (version === generation) loading.value = false
  }
}
</script>

<style scoped>
.ask-link { min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg, light-dark(#f7f6f5,#0c0c0e)); box-sizing: border-box; }
.ask-link > .give-agent-panel { width: min(600px, 100%); max-height: calc(100dvh - 48px); box-shadow: 0 24px 80px light-dark(#33252d14,#0006); }
.ask-open-app { width: 100%; }
.ask-downloads { margin-top: 16px; font-size: 11px; color: var(--give-muted); line-height: 1.7; }
.ask-downloads a { color: var(--give-text); text-decoration: underline; text-underline-offset: 3px; }
@media(max-width:480px) { .ask-link { padding: 12px 10px; }.ask-link > .give-agent-panel { max-height: calc(100dvh - 24px); } }

@media (max-width: 600px) {
  .ask-link { padding: max(12px, env(safe-area-inset-top, 0px)) 12px max(12px, env(safe-area-inset-bottom, 0px)); }
  .ask-link > .give-agent-panel { max-height: none; overflow: visible; }
  .ask-link :deep(.give-body) { overflow: visible; }
  .ask-link :deep(.give-primary) { min-height: 44px; }
  .ask-downloads { font-size: 13px; }
  .ask-downloads a { display: inline-block; padding-block: 10px; }
}
</style>
