<template>
  <section class="company-rooms" :aria-label="`${companyName} rooms`" data-testid="first-run-company-rooms">
    <div v-if="rooms.length" class="company-rooms-group">
      <div class="company-rooms-head">
        <CompanyAvatar :login="companyName" :avatar-url="avatarUrl" size="s" />
        <span>{{ companyName }} rooms</span>
        <small>{{ rooms.length }}</small>
      </div>
      <label class="company-room-search"><Search aria-hidden="true" /><input v-model="query" type="search" placeholder="Find a room…" aria-label="Search company rooms"></label>
      <button
        v-for="room in filteredRooms"
        :key="room.room_id"
        class="company-rooms-row"
        type="button"
        :aria-pressed="isSelected(room)"
        :disabled="busy"
        :data-testid="`first-run-company-room-${room.room_id}`"
        @click="$emit('choose-room', room.room_id)"
      >
        <BookMarked v-if="room.kind === 'repo'" class="company-rooms-icon" aria-hidden="true" />
        <Hash v-else class="company-rooms-icon" aria-hidden="true" />
        <strong>
          {{ roomName(room) }}
          <span>{{ room.kind === "repo" ? `${companyName} repository` : "Shared room · By invitation" }}</span>
        </strong>
        <span v-if="room.visibility" class="company-rooms-visibility">{{ room.visibility === "private" ? "Private" : "Public" }}</span>
        <span v-else />
        <Check class="company-rooms-check" aria-hidden="true" />
      </button>
      <p v-if="!filteredRooms.length" class="company-rooms-empty" role="status">No rooms match your search.</p>
    </div>
    <p v-else class="company-rooms-empty">
      No {{ companyName }} rooms yet. A repo appears here after a {{ companyName }} owner installs the LetAgents GitHub app on it, and you have a role on that repo.
    </p>
    <div class="company-rooms-or" aria-hidden="true">or</div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { BookMarked, Check, Hash, Search } from "@lucide/vue";
import type { DesktopOrganizationRoom } from "../../../../../electron/ipc-types/organizations.js";
import CompanyAvatar from "../company/CompanyAvatar.vue";

const props = defineProps<{
  companyName: string;
  avatarUrl: string | null;
  rooms: DesktopOrganizationRoom[];
  selectedRoomIdentifier: string | null;
  busy: boolean;
}>();

const query = ref("");
const filteredRooms = computed(() => props.rooms.filter(room => `${roomName(room)} ${room.full_name ?? ""}`.toLowerCase().includes(query.value.trim().toLowerCase())));

defineEmits<{ "choose-room": [roomId: string] }>();

function isSelected(room: DesktopOrganizationRoom): boolean {
  return room.room_id.toLowerCase() === props.selectedRoomIdentifier?.toLowerCase();
}

function roomName(room: DesktopOrganizationRoom): string {
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

.company-rooms-head {
  display: flex;
  gap: 9px;
  align-items: center;
  padding: 12px 14px;
  margin-bottom: 10px;
  color: var(--setup-text);
  font-size: 13px;
  font-weight: 600;
}

.company-rooms-head small {
  margin-left: auto;
  color: var(--setup-muted);
  font-weight: 500;
}

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
  transition: background-color 150ms ease;
}

.company-rooms-head + .company-rooms-row {
  border-top: 0;
}

.company-rooms-row[aria-pressed="true"] {
  background: var(--setup-surface-muted);
}

.company-rooms-row:disabled {
  cursor: default;
  opacity: 0.6;
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
  width: 16px;
  height: 16px;
  color: var(--setup-muted-strong);
}

.company-rooms-visibility {
  padding: 0;
  color: var(--setup-muted);
  font-size: 11.5px;
}

.company-rooms-check {
  width: 18px;
  height: 18px;
  opacity: 0;
  transition: opacity 150ms ease;
}

.company-rooms-row[aria-pressed="true"] .company-rooms-check {
  opacity: 1;
}

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
</style>
