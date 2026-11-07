<template>
  <Teleport to="body">
    <Transition name="person-work" appear :css="animatePanel" @before-leave="disableLeavingPanel">
      <PersonWorkPanel v-if="target" :key="scopeKey" class="web-person-work" :data-theme="theme"
        :target="target" :room-id="roomIdentifier" :viewer-login="viewerLogin"
        :tasks="workTasks" :services="services" @close="close"
        @open-task="openTask" />
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import PersonWorkPanel from '../../../../../apps/desktop/renderer/src/components/desktop/content/PersonWorkPanel.vue'
import type { PersonTarget } from '../../../../../apps/desktop/renderer/src/domain/person-target'
import type { RoomTask } from '../../composables/room/types'
import { createPersonWorkServices, personWorkTask } from './personWork'

const props = defineProps<{
  roomIdentifier: string
  viewerLogin: string | null
  sessionId: string | null
  theme: string
  tasks: readonly RoomTask[]
}>()
const emit = defineEmits<{ 'open-task': [id: string] }>()
const target = ref<PersonTarget | null>(null)
const animatePanel = ref(false)
const workTasks = computed(() => props.tasks.map(personWorkTask))
const scopeKey = computed(() => `${props.sessionId || ''}:${props.roomIdentifier}`)
const services = createPersonWorkServices()
let keyboardInput = true
function recordClick(event: MouseEvent) { keyboardInput = event.detail === 0 }
function recordKey() { keyboardInput = true }
onMounted(() => {
  document.addEventListener('click', recordClick, true)
  document.addEventListener('keydown', recordKey, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', recordClick, true)
  document.removeEventListener('keydown', recordKey, true)
})
function open(person: PersonTarget, event: MouseEvent) {
  if (!props.sessionId || !props.roomIdentifier) return
  animatePanel.value = event.detail > 0
  target.value = person
}
function close(instant = keyboardInput) {
  animatePanel.value = !instant
  target.value = null
}
function disableLeavingPanel(element: Element) { (element as HTMLElement).inert = true }
function openTask(id: string) {
  close()
  emit('open-task', id)
}
watch(scopeKey, () => close(true), { flush: 'sync' })
onDeactivated(() => close(true))
defineExpose({ open, close, isOpen: computed(() => target.value !== null) })
</script>

<style scoped>
.web-person-work { --overlay-scrim: light-dark(#00000029, #00000066); }
</style>
