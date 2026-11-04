<template>
  <div v-if="agents.length" class="drawer-section drawer-panel wake-webhook-panel" data-testid="wake-webhook-panel">
    <div class="drawer-section-title">
      <h2>Wake a bot by webhook</h2>
    </div>
    <WakeWebhookSection
      :room-id="room.identifier"
      :agents="agents"
      :rules="rules"
      :api="roomWakeWebhookApi"
      :loading="loading"
      :error="error"
      @changed="refreshRules"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import WakeWebhookSection from '../../../../../../shared/ui/WakeWebhookSection.vue'
import type { WakeRule, WakeRulePage, WakeWebhookAgent } from '../../../../../../shared/wake-rules.mjs'
import type { RoomInfo } from '@/composables/useRoom'
import { lastWakeRuleInvalidation } from '@/composables/roomWakeRuleInvalidation'
import { fetchRoomWakeRules, RoomWakeRuleHttpError } from '@/composables/roomWakeRules'
import { fetchOwnedWakeAgents, roomWakeWebhookApi } from '@/composables/roomWakeWebhooks'

const props = defineProps<{ open: boolean; room: RoomInfo }>()

const agents = ref<WakeWebhookAgent[]>([])
const page = ref<WakeRulePage | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
let generation = 0

const rules = computed<readonly WakeRule[]>(() => [...(page.value?.active ?? []), ...(page.value?.recent ?? [])])

/** A refusal (not signed in, no access, an older server) means nothing to show, not an error. */
function concealed(cause: unknown): boolean {
  return cause instanceof RoomWakeRuleHttpError && [401, 403, 404].includes(cause.status)
}

async function refreshRules(): Promise<void> {
  const version = generation
  const roomId = props.room.identifier
  try {
    const next = await fetchRoomWakeRules(roomId)
    if (version === generation) page.value = next
  } catch {
    // Keep the last known rules; the next change re-reads them.
  }
}

async function load(): Promise<void> {
  const version = ++generation
  const roomId = props.room.identifier
  loading.value = true
  error.value = null
  try {
    const list = await fetchOwnedWakeAgents(roomId)
    if (version !== generation) return
    agents.value = list
    if (list.length) await refreshRules()
  } catch (cause) {
    if (version !== generation) return
    agents.value = []
    if (!concealed(cause)) error.value = cause instanceof Error ? cause.message : 'Your agents in this room could not be loaded.'
  } finally {
    if (version === generation) loading.value = false
  }
}

watch(() => [props.open, props.room.identifier, props.room.authenticated] as const, ([open, , authenticated], previous) => {
  if (previous && previous[1] !== props.room.identifier) {
    agents.value = []
    page.value = null
  }
  if (open && authenticated) void load()
}, { immediate: true })

watch(lastWakeRuleInvalidation, (invalidation) => {
  if (invalidation && invalidation.roomId === props.room.identifier && agents.value.length) void refreshRules()
})
</script>
