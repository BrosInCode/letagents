<template>
  <main class="ask-link">
    <section class="ask-link-card">
      <p v-if="loading" class="ask-link-muted">Opening the request…</p>
      <template v-else-if="ask && !unavailable">
        <h1>{{ ask.asker }} asked for a {{ ask.model_label }} agent</h1>
        <p class="ask-link-muted">Add it from the LetAgents app on your Mac. It runs on your own quota.</p>
        <a class="ask-link-primary" :href="appLink">Open in LetAgents</a>
        <p class="ask-link-muted">
          Don't have the app? Download for
          <a :href="release.downloads.arm64">Apple silicon</a> or <a :href="release.downloads.x64">Intel</a>,
          then open this link again.
        </p>
      </template>
      <template v-else>
        <h1>Request unavailable</h1>
        <p class="ask-link-muted">{{ unavailable ?? "This link isn't valid." }}</p>
      </template>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { MAC_DESKTOP_BETA } from '@/domain/desktopRelease'

const props = defineProps<{ token: string }>()
const loading = ref(true)
const ask = ref<{ asker: string; model_label: string } | null>(null)
const unavailable = ref<string | null>(null)
const release = MAC_DESKTOP_BETA
const appLink = computed(() => `letagents://ask/${encodeURIComponent(props.token)}`)

onMounted(async () => {
  try {
    const response = await fetch(`/agent-asks/link/${encodeURIComponent(props.token)}`, { credentials: 'same-origin' })
    const body = await response.json().catch(() => null)
    if (!response.ok) { unavailable.value = body?.error ?? "This link isn't valid."; return }
    ask.value = body.ask
    unavailable.value = body.unavailable?.error ?? null
  } catch {
    unavailable.value = "Couldn't reach LetAgents. Check your connection and try again."
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.ask-link { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.ask-link-card { max-width: 440px; display: flex; flex-direction: column; gap: 14px; text-align: center; }
.ask-link-card h1 { font-size: 22px; font-weight: 500; margin: 0; }
.ask-link-muted { color: var(--text-secondary, #52525b); margin: 0; line-height: 1.6; }
.ask-link-primary { display: inline-block; padding: 10px 18px; border-radius: 10px; background: var(--text, #09090b); color: var(--bg, #fff); text-decoration: none; font-weight: 500; }
</style>
