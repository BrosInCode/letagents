<template>
  <aside v-show="open" ref="sidebar" class="web-room-sidebar" aria-label="Workspace navigation" :role="compact ? 'dialog' : undefined" :aria-modal="compact ? true : undefined" @keydown="sidebarKeydown">
    <div class="web-sidebar-top">
      <span class="web-sidebar-brand">letagents.</span>
      <button type="button" aria-label="Find a room" title="Find a room (⌘/Ctrl K)" @click="openSwitcher"><svg  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3a7 7 0 1 0 0 14 7 7 0 1 0 0-14Zm5 12 6 6" /></svg></button>
      <RouterLink to="/inbox" aria-label="Inbox" title="Inbox"><svg  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16l2 11v5H2v-5L4 4ZM2 15h6l2 3h4l2-3h6" /></svg></RouterLink>
      <button type="button" aria-label="Hide sidebar" title="Hide sidebar" @click="emit('close')"><svg  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3h18v18H3V3ZM9 3v18m8-13-4 4 4 4" /></svg></button>
    </div>
    <nav class="web-sidebar-nav" aria-label="Workspace">
      <RouterLink to="/?new=blank#start"><svg  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>New room</RouterLink>
      <RouterLink to="/my-work"><svg  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 6 2 2 4-4M12 6h9M3 15l2 2 4-4m3 2h9M12 21h9" /></svg>My work</RouterLink>
      <RouterLink to="/messages"><svg  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3h18v13H8l-5 5V3Z" /></svg>Messages</RouterLink>
    </nav>
    <div class="web-sidebar-rooms">
      <p v-if="loading && !rooms.length" class="web-sidebar-note" role="status">Loading rooms…</p>
      <div v-if="error" class="web-sidebar-note" role="status">{{ error }} <button type="button" @click="loadRooms">Retry</button></div>
      <section v-for="section in sections" :key="section.label">
        <h3>{{ section.label }}</h3>
        <div v-for="project in section.rooms" :key="project.room_id" class="web-sidebar-project">
          <div class="web-sidebar-parent" :data-active="activeRoomId === project.room_id">
            <RouterLink :to="roomHref(project.room_id)" :aria-current="activeRoomId === project.room_id ? 'page' : undefined" :title="project.display_name" @click="navigated">
              <svg  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h6l2 3h10v12H3V5Z" /></svg><span>{{ project.display_name }}</span>
            </RouterLink>
            <button v-if="project.focus_rooms.length" type="button" :aria-label="`${collapsed[project.room_id] ? 'Expand' : 'Collapse'} ${project.display_name}`"
              :aria-expanded="!collapsed[project.room_id]" @click="collapsed[project.room_id] = !collapsed[project.room_id]"><svg :class="{ expanded: !collapsed[project.room_id] }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg></button>
          </div>
          <div v-if="!collapsed[project.room_id] && project.focus_rooms.length" class="web-sidebar-children">
            <RouterLink v-for="child in preview(project)" :key="child.room_id" :to="roomHref(child.room_id)" :title="child.display_name"
              :aria-current="activeRoomId === child.room_id ? 'page' : undefined" @click="navigated">
              <svg v-if="child.git_room && !child.git_room.ref.is_default" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 5v14m0-7c8 0 12-2 12-7M4 3h4v4H4zM4 17h4v4H4zM16 3h4v4h-4z" /></svg><svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3h18v13H8l-5 5V3Z" /></svg><span>{{ child.display_name.replace(/^focus:\s*/i, '') }}</span>
            </RouterLink>
            <button v-if="project.focus_rooms.length > 3" type="button" @click="expanded[project.room_id] = !expanded[project.room_id]">
              <svg  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg><span>{{ expanded[project.room_id] ? 'Show fewer' : `All ${project.focus_rooms.length} rooms` }}</span>
            </button>
          </div>
        </div>
      </section>
      <p v-if="!loading && !error && !rooms.length" class="web-sidebar-note">Your rooms will appear here.</p>
      <button class="web-sidebar-browse" type="button" @click="openSwitcher">Browse rooms <svg  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg></button>
    </div>
    <footer class="web-sidebar-footer">
      <button class="web-sidebar-focus" type="button" :disabled="!currentProject" :aria-pressed="focused" @click="focused = !focused"><svg  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0" /></svg><span>Focus this project</span><span class="web-sidebar-switch" aria-hidden="true" /></button>
      <button class="web-sidebar-account" type="button" @click="emit('settings')">
        <img v-if="auth.user.value?.avatar_url && !avatarFailed" :src="auth.user.value.avatar_url" alt="" referrerpolicy="no-referrer" @error="avatarFailed = true" />
        <span v-else class="web-sidebar-initials">{{ (auth.user.value?.login || '?').slice(0, 2).toUpperCase() }}</span>
        <span>{{ auth.user.value?.display_name || auth.user.value?.login }}<small>Settings</small></span><svg  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
      </button>
    </footer>
  </aside>
  <Teleport to="body">
    <dialog ref="switcher" class="web-room-switcher" aria-labelledby="web-room-switcher-title" @close="restoreFocus" @click="backdrop">
      <header><h2 id="web-room-switcher-title">Find a room</h2><button type="button" aria-label="Close room switcher" @click="switcher?.close()"><svg  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button></header>
      <label class="web-room-switcher-search"><svg  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3a7 7 0 1 0 0 14 7 7 0 1 0 0-14Zm5 12 6 6" /></svg><input ref="searchInput" v-model="query" type="search" placeholder="Search rooms or projects…" aria-label="Search rooms"
        role="combobox" :aria-expanded="Boolean(options.length)" aria-autocomplete="list" :aria-controls="options.length ? 'web-room-options' : undefined"
        :aria-activedescendant="options.length ? `web-room-option-${activeIndex}` : undefined" @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)" @keydown.enter.prevent="choose(options[activeIndex])" /></label>
      <div v-if="options.length" id="web-room-options" class="web-room-options" role="listbox" aria-label="Rooms">
        <div v-for="(option, index) in options" :id="`web-room-option-${index}`" :key="option.room_id" role="option" :aria-selected="index === activeIndex" @pointerenter="activeIndex = index" @click="choose(option)">
          <svg v-if="!option.parent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h6l2 3h10v12H3V5Z" /></svg><svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3h18v13H8l-5 5V3Z" /></svg><span>{{ option.display_name }}<small>{{ option.parent || 'Project room' }}</small></span><svg  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        </div>
      </div>
      <p v-else class="web-sidebar-note" role="status">{{ error || (loading ? 'Loading rooms…' : 'No matching rooms.') }}</p>
      <footer><span>↑ ↓ to move · Enter to open</span><span v-if="rooms.length >= 100">100 most recent rooms</span></footer>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useAuth } from '@/composables/useAuth'
import { apiFetch } from '@/composables/room/api'
import type { GitRoomInfo } from '@/composables/useRoom'

interface SidebarRoom { room_id: string; display_name: string; pinned?: boolean; archived?: boolean; git_room?: GitRoomInfo | null; focus_rooms: SidebarRoom[] }
type Option = SidebarRoom & { parent?: string }
const props = defineProps<{ open: boolean; compact?: boolean; activeRoomId: string }>()
const emit = defineEmits<{ close: []; settings: []; activeRoomVisible: [visible: boolean] }>()
const auth = useAuth()
const router = useRouter()
const rooms = ref<SidebarRoom[]>([])
const loading = ref(false)
const error = ref('')
const sidebar = ref<HTMLElement | null>(null)
const avatarFailed = ref(false)
watch(() => auth.user.value?.avatar_url, () => { avatarFailed.value = false })
const focused = ref(false)
const collapsed = ref<Record<string, boolean>>({})
const expanded = ref<Record<string, boolean>>({})
const currentProject = computed(() => rooms.value.find(room => room.room_id === props.activeRoomId || room.focus_rooms.some(child => child.room_id === props.activeRoomId)))
const sections = computed(() => focused.value && currentProject.value ? [{ label: 'This project', rooms: [currentProject.value] }] : [
  { label: 'Pinned', rooms: rooms.value.filter(room => room.pinned) }, { label: 'Rooms', rooms: rooms.value.filter(room => !room.pinned) },
].filter(section => section.rooms.length))
const roomHref = (id: string) => `/in/${encodeURIComponent(id)}`
function preview(project: SidebarRoom) {
  if (expanded.value[project.room_id]) return project.focus_rooms
  const rows = project.focus_rooms.slice(0, 3)
  const active = project.focus_rooms.find(child => child.room_id === props.activeRoomId)
  if (active && !rows.includes(active)) rows.splice(2, 1, active)
  return rows
}
let request: AbortController | null = null
async function loadRooms() {
  request?.abort()
  const controller = new AbortController()
  request = controller
  if (!auth.user.value) { rooms.value = []; loading.value = false; return }
  loading.value = true
  error.value = ''
  try {
    const result = await apiFetch('/account/rooms?limit=100', { signal: controller.signal }, { reportRoomRefusal: false }) as { rooms: SidebarRoom[] }
    if (controller.signal.aborted) return
    rooms.value = result.rooms.filter(room => !room.archived).map(room => ({ ...room, focus_rooms: room.focus_rooms || [] }))
  } catch { if (!controller.signal.aborted) error.value = 'Could not load rooms.' }
  finally { if (!controller.signal.aborted) loading.value = false }
}
watch(() => auth.user.value?.id, () => { rooms.value = []; focused.value = false; collapsed.value = {}; expanded.value = {}; void loadRooms() }, { immediate: true })
watch(() => props.activeRoomId, () => { void loadRooms() })
watch(() => currentProject.value?.room_id, id => { if (id) collapsed.value[id] = false })
watch(() => Boolean(currentProject.value), visible => emit('activeRoomVisible', visible), { immediate: true })
function navigated() { if (props.compact) emit('close') }
watch(() => props.open, async open => {
  if (open && props.compact) { await nextTick(); sidebar.value?.querySelector<HTMLButtonElement>('button')?.focus() }
})
function sidebarKeydown(event: KeyboardEvent) {
  if (!props.compact || !props.open) return
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); return }
  if (event.key !== 'Tab') return
  const targets = Array.from(sidebar.value?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') || []).filter(el => el.getClientRects().length)
  const first = targets[0], last = targets.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
const switcher = ref<HTMLDialogElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const query = ref('')
const activeIndex = ref(0)
let opener: HTMLElement | null = null
const options = computed<Option[]>(() => rooms.value.flatMap(room => [room, ...room.focus_rooms.map(child => ({ ...child, parent: room.display_name }))])
  .filter(room => `${room.display_name} ${'parent' in room ? room.parent : ''}`.toLowerCase().includes(query.value.toLowerCase().trim())))
watch(query, () => { activeIndex.value = 0 })
watch(options, () => { activeIndex.value = Math.min(activeIndex.value, Math.max(0, options.value.length - 1)) })
function openSwitcher() {
  if (switcher.value?.open) return
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  query.value = ''; activeIndex.value = 0
  switcher.value?.showModal()
  void nextTick(() => searchInput.value?.focus())
}
function restoreFocus() { opener?.focus({ preventScroll: true }); opener = null }
function backdrop(event: MouseEvent) {
  if (event.target !== switcher.value) return
  const bounds = switcher.value!.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) switcher.value?.close()
}
function move(delta: number) {
  if (!options.value.length) return
  activeIndex.value = (activeIndex.value + delta + options.value.length) % options.value.length
  void nextTick(() => document.getElementById(`web-room-option-${activeIndex.value}`)?.scrollIntoView({ block: 'nearest' }))
}
function choose(option?: Option) {
  if (!option) return
  switcher.value?.close()
  void router.push(roomHref(option.room_id))
  navigated()
}
function shortcut(event: KeyboardEvent) {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform)
  if (event.key.toLowerCase() !== 'k' || !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey || event.repeat || event.isComposing || event.defaultPrevented) return
  if (!switcher.value?.open && Array.from(document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')).some(el => el !== sidebar.value && el.getClientRects().length)) return
  event.preventDefault(); openSwitcher()
}
onMounted(() => window.addEventListener('keydown', shortcut))
onBeforeUnmount(() => { request?.abort(); window.removeEventListener('keydown', shortcut); switcher.value?.close() })
</script>

<style src="./RoomSidebar.css"></style>
