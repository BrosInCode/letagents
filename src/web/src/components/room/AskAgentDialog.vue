<template>
  <dialog ref="dialogRef" class="web-ask-dialog" aria-labelledby="web-ask-title" tabindex="-1"
    @cancel.prevent="close" @click="closeOnBackdrop($event, close)">
    <AskAgentPanel :key="generation" :models="models" :rooms="rooms" :initial-room="roomIdentifier"
      :loading="loading" :busy="busy" :error="error" :created-link="createdLink" :copied="copied"
      heading-id="web-ask-title" @create="create" @retry="load" @copy="copy" @close="close">
      <template #close><button type="button" class="give-close" aria-label="Close" :disabled="busy" @click="close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></template>
    </AskAgentPanel>
  </dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AskAgentPanel from '../../../../../shared/ui/ask-agent/AskAgentPanel.vue'
import type { AskAgentInput, AskAgentModel } from '../../../../../shared/ui/ask-agent/types'
import { useAuth } from '@/composables/useAuth'
import { apiFetch, roomPath } from '@/composables/room/api'
import { useChatDialog } from './chat-message/useChatDialog'

const props = defineProps<{ roomIdentifier: string; roomLabel: string }>()
const emit = defineEmits<{ close: [] }>()
const { isSignedIn, user } = useAuth()
const accountId = computed(() => isSignedIn.value ? user.value?.id ?? null : null)
const { dialogRef, closeOnBackdrop } = useChatDialog(() => Boolean(accountId.value))
const models = ref<AskAgentModel[]>([]), rooms = ref<{ id: string; label: string }[]>([])
const loading = ref(true), busy = ref(false), copied = ref(false)
const error = ref<string | null>(null), createdLink = ref<string | null>(null)
const generation = ref(0)
let createdRoomId: string | null = null
onBeforeUnmount(() => { generation.value++ })
watch([accountId, () => props.roomIdentifier], () => {
  generation.value++
  models.value = []; rooms.value = []; createdLink.value = null; createdRoomId = null
  busy.value = false; copied.value = false; error.value = null
  if (!accountId.value) { emit('close'); return }
  void load()
}, { immediate: true, flush: 'sync' })

async function load() {
  if (busy.value || !accountId.value) return
  const version = ++generation.value
  loading.value = true; error.value = null
  try {
    const [catalog, accountRooms] = await Promise.all([apiFetch('/agent-asks/models'), apiFetch('/account/rooms?limit=200')])
    if (version !== generation.value) return
    models.value = catalog.models ?? []
    const entries: { room_id: string; display_name: string; archived?: boolean; focus_rooms?: { room_id: string; display_name: string }[] }[] = accountRooms.rooms ?? []
    rooms.value = entries.filter(room => !room.archived).flatMap(room => [
      { id: room.room_id, label: room.display_name || room.room_id },
      ...(room.focus_rooms ?? []).map(focus => ({ id: focus.room_id, label: `${room.display_name} / ${focus.display_name}` })),
    ])
    if (!rooms.value.some(room => room.id === props.roomIdentifier)) {
      rooms.value.unshift({ id: props.roomIdentifier, label: props.roomLabel || props.roomIdentifier })
    }
    if (!models.value.length) error.value = 'No agents are available to request right now. Try again.'
  } catch (cause) {
    if (version === generation.value) error.value = cause instanceof Error ? cause.message : 'Couldn’t load this form. Try again.'
  } finally {
    if (version === generation.value) loading.value = false
  }
}

async function create(input: AskAgentInput) {
  if (busy.value || loading.value || createdLink.value || !accountId.value) return
  const model = models.value.find(model => model.providerId === input.providerId && model.model === input.model)
  if (!model || (input.roomId !== '__new__' && !rooms.value.some(room => room.id === input.roomId))) return
  const version = generation.value
  const name = input.newRoomName.trim().replace(/\s+/g, ' ')
  if (input.roomId === '__new__' && name && (name.length < 2 || name.length > 64)) {
    error.value = 'Use between 2 and 64 characters for the room name.'; return
  }
  busy.value = true; error.value = null
  try {
    let roomId = input.roomId
    if (roomId === '__new__') {
      if (!createdRoomId) {
        const result = await apiFetch('/projects', { method: 'POST' })
        if (version !== generation.value) return
        const id = result.project?.id || result.id
        if (typeof id !== 'string' || !id.trim()) throw new Error('The server did not return a room. Try again.')
        createdRoomId = id
      }
      roomId = createdRoomId
      if (name) {
        await apiFetch(roomPath(roomId), { method: 'PATCH', body: JSON.stringify({ display_name: name }) })
        if (version !== generation.value) return
      }
    }
    const result = await apiFetch(`${roomPath(roomId)}/agent-asks`, {
      method: 'POST', body: JSON.stringify({ provider_id: model.providerId, model: model.model, amount_percent: input.amountPercent, note: input.note }),
    })
    if (version !== generation.value) return
    if (typeof result.link !== 'string' || !result.link) throw new Error('The server did not return a link. Try again.')
    createdLink.value = result.link
  } catch (cause) {
    if (version === generation.value) error.value = cause instanceof Error ? cause.message : 'Couldn’t create the link. Try again.'
  } finally {
    if (version === generation.value) busy.value = false
  }
}

function close() { if (!busy.value) emit('close') }
async function copy() {
  if (!createdLink.value) return
  const version = generation.value
  try {
    await navigator.clipboard.writeText(createdLink.value)
    if (version === generation.value) { copied.value = true; error.value = null }
  } catch {
    if (version === generation.value) { copied.value = false; error.value = 'Couldn’t copy the link. Select it and copy it manually.' }
  }
}
</script>

<style scoped>
.web-ask-dialog { width: min(600px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 48px); margin: auto; padding: 0; border: 0; border-radius: 17px; background: transparent; color: inherit; overflow: visible; box-shadow: 0 32px 100px #0006; }
.web-ask-dialog[open] { display: flex; }
.web-ask-dialog::backdrop { background: #0009; }
.web-ask-dialog:focus { outline: none; }
@media(max-width:480px) { .web-ask-dialog { max-height: calc(100dvh - 32px); border-radius: 13px; } }
</style>
