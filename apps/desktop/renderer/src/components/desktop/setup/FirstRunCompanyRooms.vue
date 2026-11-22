<template>
  <section class="company-rooms" :aria-label="companyName ? `${companyName} rooms` : 'Your rooms'" data-testid="first-run-company-rooms">
    <div v-if="rooms.length" class="company-rooms-group">
      <label class="company-room-search"><Search aria-hidden="true" /><input v-model="query" type="search" placeholder="Find a room…" aria-label="Search rooms"></label>
      <div class="company-room-results">
        <button
          v-for="room in filteredRooms"
          :key="room.room_id"
          class="company-rooms-row"
          type="button"
          :aria-pressed="isSelected(room)"
          :data-room-id="room.room_id"
          :disabled="busy"
          :data-testid="`first-run-company-room-${room.room_id}`"
          @click="chooseRoom(room.room_id, $event)"
        >
          <span class="company-rooms-icon" aria-hidden="true">
            <BookMarked v-if="room.kind === 'repo'" />
            <Hash v-else />
          </span>
          <strong>
            {{ roomName(room) }}
            <span>{{ room.local ? "On this device" : room.kind === "repo" ? room.full_name || "Repository" : "Shared room" }}</span>
          </strong>
          <span v-if="room.visibility" class="company-rooms-visibility">{{ room.visibility === "private" ? "Private" : "Public" }}</span>
          <span v-else />
          <span class="company-rooms-trailing" aria-hidden="true">
            <ArrowRight class="company-rooms-arrow" />
            <Check class="company-rooms-check" />
          </span>
        </button>
        <p v-if="!filteredRooms.length" class="company-rooms-empty" role="status">No rooms match your search.</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { ArrowRight, BookMarked, Check, Hash, Search } from "@lucide/vue";
import type { FirstRunRoomChoice } from "./types";

const props = defineProps<{
  companyName: string | null;
  rooms: FirstRunRoomChoice[];
  selectedRoomIdentifier: string | null;
  busy: boolean;
}>();

const query = ref("");
const filteredRooms = computed(() => props.rooms.filter(room => `${roomName(room)} ${room.full_name ?? ""}`.toLowerCase().includes(query.value.trim().toLowerCase())));

const emit = defineEmits<{ "choose-room": [roomId: string, icon?: HTMLElement] }>();

function chooseRoom(roomId: string, event: MouseEvent): void {
  const row = event.currentTarget as HTMLButtonElement | null;
  emit("choose-room", roomId, row?.querySelector<HTMLElement>(".company-rooms-icon") ?? undefined);
}

function isSelected(room: FirstRunRoomChoice): boolean {
  return room.room_id.toLowerCase() === props.selectedRoomIdentifier?.toLowerCase();
}

function roomName(room: FirstRunRoomChoice): string {
  return room.full_name?.split("/")[1] || room.display_name;
}
</script>

<style scoped>
.company-rooms {
  width: 100%;
  margin: 0 auto;
  text-align: left;
}

.company-rooms-group {
  overflow: hidden;
  border: 0;
  background: transparent;
}

.company-room-results { max-height: min(36vh, 360px); overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }

.company-rooms-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  gap: 12px;
  align-items: center;
  width: 100%;
  min-height: 72px;
  padding: 12px;
  border-radius: 10px;
  border: 0;
  border-top: 0;
  background: transparent;
  color: var(--setup-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 150ms ease, transform 210ms cubic-bezier(.22,.84,.32,1.22);
}

.company-rooms-row[aria-pressed="true"] {
  background: var(--setup-surface-muted);
}

.company-rooms-row:disabled {
  cursor: default;
  opacity: 0.6;
}

.company-rooms-row:has([data-first-room-departure]) {
  background: var(--setup-surface-muted);
  opacity: 1;
}

.company-rooms-row:focus-visible {
  outline: 2px solid var(--setup-accent);
  outline-offset: -2px;
}

.company-rooms-row strong {
  overflow: hidden;
  font-size: 14px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.company-rooms-row strong span {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--setup-muted);
  font-weight: 500;
}

.company-rooms-icon {
  display: block;
  width: 16px;
  height: 16px;
  color: var(--setup-muted-strong);
}
.company-rooms-icon svg { display: block; width: 100%; height: 100%; }

.company-rooms-visibility {
  padding: 0;
  color: var(--setup-muted);
  font-size: 11.5px;
}

.company-rooms-trailing { display: grid; color: var(--workspace-accent, var(--setup-accent)); }
.company-rooms-trailing svg {
  grid-area: 1 / 1;
  width: 18px;
  height: 18px;
  transition: opacity 170ms ease, transform 240ms cubic-bezier(.22,.84,.32,1.22);
}
.company-rooms-check {
  opacity: 0;
  transform: scale(.75);
}

.company-rooms-row[aria-pressed="true"] .company-rooms-check {
  opacity: 1;
  transform: none;
}
.company-rooms-arrow { opacity: .45; }
.company-rooms-row[aria-pressed="true"] .company-rooms-arrow { opacity: 0; transform: translateX(3px); }
.company-rooms-row:enabled:not([aria-pressed="true"]):is(:hover, :focus-visible) .company-rooms-arrow { opacity: 1; transform: translateX(3px); }
.company-rooms-row:enabled:active { transform: scale(.988); transition-duration: 80ms; }

.company-rooms-empty {
  margin: 0;
  padding: 14px 16px;
  border: 1px dashed var(--setup-border-strong);
  border-radius: 14px;
  color: var(--setup-muted);
  font-size: 13px;
  line-height: 1.5;
}

.company-rooms-or {
  display: flex;
  gap: 12px;
  align-items: center;
  margin: 20px 0 14px;
  color: var(--setup-muted);
  font-size: 12px;
}

.company-rooms-or::before,
.company-rooms-or::after {
  flex: 1;
  height: 1px;
  background: var(--setup-border);
  content: "";
}

@media (hover: hover) and (pointer: fine) {
  .company-rooms-row:hover:not(:disabled) {
    background: var(--setup-surface-muted);
  }
}
.company-room-search { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; padding: 10px 12px; border: 1px solid var(--setup-border); border-radius: 9px; color: var(--setup-muted); }
.company-room-search svg { width: 17px; height: 17px; }
.company-room-search input { min-width: 0; width: 100%; border: 0; background: transparent; color: var(--setup-text); font: inherit; font-size: 14px; }
.company-room-search:focus-within { outline: 2px solid var(--setup-accent); outline-offset: 2px; }
.company-room-search input:focus { outline: none; }
@media (prefers-reduced-motion: reduce) {
  .company-rooms-row, .company-rooms-trailing svg { transform: none !important; transition: none; }
}
</style>
