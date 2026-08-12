<template>
  <section class="settings-panel settings-rooms-panel" data-testid="settings-rooms-panel">
    <template v-if="selectedRoomDetail">
      <button class="settings-back-button settings-detail-back" type="button" @click="selectedRoomDetailIdentifier = null">
        <ArrowRight aria-hidden="true" />
        <span>Back to rooms</span>
      </button>

      <article class="settings-room-detail" data-testid="settings-room-detail">
        <header class="settings-room-detail-header">
          <button
            class="settings-pin-button"
            type="button"
            :disabled="isBusy(selectedRoomDetail)"
            :aria-label="selectedRoomDetail.pinned ? `Unpin ${selectedRoomDetail.displayName}` : `Pin ${selectedRoomDetail.displayName}`"
            :title="selectedRoomDetail.pinned ? 'Unpin room' : 'Pin room'"
            :data-active="selectedRoomDetail.pinned"
            @click="$emit('toggle-pin-room', selectedRoomDetail)"
          >
            <Pin aria-hidden="true" />
          </button>
          <div class="settings-room-copy">
            <div class="settings-room-title-line">
              <h2>{{ selectedRoomDetail.displayName }}</h2>
              <span v-if="selectedRoomDetail.archived" class="state-pill" data-state="offline">left</span>
              <span v-else-if="selectedRoomDetail.pinned" class="state-pill" data-state="installed">pinned</span>
            </div>
            <p>{{ roomUrl(selectedRoomDetail) }}</p>
          </div>
          <div class="settings-room-actions">
            <button
              class="ghost-button settings-compact-button"
              type="button"
              :disabled="isBusy(selectedRoomDetail)"
              @click="copyRoomUrl(selectedRoomDetail)"
            >
              {{ copiedRoomUrl === roomUrl(selectedRoomDetail) ? "Copied" : "Copy URL" }}
            </button>
            <button
              v-if="!selectedRoomDetail.archived"
              class="ghost-button settings-compact-button"
              type="button"
              :disabled="isBusy(selectedRoomDetail)"
              @click="$emit('open-room', selectedRoomDetail)"
            >
              Open room
            </button>
          </div>
        </header>

        <dl class="settings-room-detail-grid">
          <div>
            <dt>Role</dt>
            <dd>{{ roleSourceLabel(selectedRoomDetail) }}</dd>
          </div>
          <div>
            <dt>Last opened</dt>
            <dd>{{ lastOpenedLabel(selectedRoomDetail) }}</dd>
          </div>
          <div>
            <dt>Focus rooms</dt>
            <dd>{{ selectedRoomDetail.focusRooms.length }}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{{ selectedRoomDetail.canDelete ? "By you" : "Joined" }}</dd>
          </div>
        </dl>

        <section class="settings-room-detail-section">
          <h3>Focus rooms</h3>
          <div v-if="selectedRoomDetail.focusRooms.length" class="settings-focus-list">
            <span v-for="focusRoom in selectedRoomDetail.focusRooms" :key="focusRoom.roomIdentifier">
              {{ focusRoom.displayName }}
            </span>
          </div>
          <p v-else class="settings-muted-note">No focus rooms yet.</p>
        </section>

        <footer class="settings-room-footer settings-room-detail-actions">
          <button
            v-if="selectedRoomDetail.archived"
            class="primary-button"
            type="button"
            :disabled="isBusy(selectedRoomDetail)"
            :data-testid="`settings-restore-room-${slugify(selectedRoomDetail.roomIdentifier)}`"
            @click="$emit('restore-room', selectedRoomDetail)"
          >
            {{ busyLabel(selectedRoomDetail, "restore", "Restore") }}
          </button>
          <button
            v-else-if="selectedRoomDetail.canLeave"
            class="ghost-button"
            type="button"
            :disabled="isBusy(selectedRoomDetail)"
            :data-testid="`settings-leave-room-${slugify(selectedRoomDetail.roomIdentifier)}`"
            @click="$emit('leave-room', selectedRoomDetail)"
          >
            {{ busyLabel(selectedRoomDetail, "leave", "Leave room") }}
          </button>
          <button
            v-if="selectedRoomDetail.canDelete"
            class="ghost-button settings-danger-button"
            type="button"
            :disabled="isBusy(selectedRoomDetail)"
            :data-testid="`settings-delete-room-${slugify(selectedRoomDetail.roomIdentifier)}`"
            @click="$emit('delete-room', selectedRoomDetail)"
          >
            {{ busyLabel(selectedRoomDetail, "delete", "Delete room permanently") }}
          </button>
          <span v-else-if="selectedRoomDetail.deleteReason" class="settings-muted-note" :title="selectedRoomDetail.deleteReason">
            Protected
          </span>
        </footer>
      </article>
    </template>

    <template v-else>
      <div class="settings-room-toolbar" data-testid="settings-room-toolbar">
        <label class="settings-search">
          <span>Search rooms</span>
          <input v-model="roomSearch" type="search" placeholder="Search room, URL, or source" />
        </label>
        <div v-if="activePane === 'rooms:defaults'" class="settings-filter-group" role="tablist" aria-label="Room filters">
          <button
            v-for="filter in roomFilters"
            :key="filter.id"
            class="settings-filter"
            type="button"
            :data-active="roomFilter === filter.id"
            :data-testid="`settings-filter-${filter.id}`"
            @click="roomFilter = filter.id"
          >
            {{ filter.label }}
          </button>
        </div>
        <span class="state-pill settings-room-count-pill" data-state="connected">{{ roomCountLabel }}</span>
      </div>

      <p
        v-if="feedback"
        class="settings-feedback"
        :data-state="feedback.state"
        data-testid="settings-feedback"
      >
        {{ feedback.message }}
      </p>

      <div class="surface-list settings-room-list" data-testid="settings-room-list">
        <article
          v-for="room in filteredRooms"
          :key="room.roomIdentifier"
          class="settings-room-row"
          role="button"
          tabindex="0"
          :data-archived="room.archived"
          :data-selected="room.roomIdentifier === selectedRoomDetailIdentifier"
          :data-testid="`settings-room-${slugify(room.roomIdentifier)}`"
          @click="showRoomDetail(room)"
          @keydown.enter.prevent="showRoomDetail(room)"
          @keydown.space.prevent="showRoomDetail(room)"
        >
          <button
            class="settings-pin-button"
            type="button"
            :disabled="isBusy(room)"
            :aria-label="room.pinned ? `Unpin ${room.displayName}` : `Pin ${room.displayName}`"
            :title="room.pinned ? 'Unpin room' : 'Pin room'"
            :data-active="room.pinned"
            @click.stop="$emit('toggle-pin-room', room)"
          >
            <Pin aria-hidden="true" />
          </button>
          <div class="settings-room-copy">
            <div class="settings-room-title-line">
              <p class="surface-title">{{ room.displayName }}</p>
              <span v-if="room.archived" class="state-pill" data-state="offline">left</span>
              <span v-else-if="room.pinned" class="state-pill" data-state="installed">pinned</span>
            </div>
            <p class="surface-subtitle">{{ room.roomIdentifier }}</p>
          </div>
          <div class="settings-room-meta">
            <span>{{ roleSourceLabel(room) }}</span>
            <span>{{ lastOpenedLabel(room) }}</span>
            <span>{{ room.focusRooms.length }} focus {{ room.focusRooms.length === 1 ? "room" : "rooms" }}</span>
          </div>
          <div class="settings-room-actions">
            <button
              class="ghost-button settings-compact-button"
              type="button"
              :disabled="isBusy(room)"
              @click.stop="copyRoomUrl(room)"
            >
              {{ copiedRoomUrl === roomUrl(room) ? "Copied" : "Copy URL" }}
            </button>
            <button
              class="ghost-button settings-icon-button"
              type="button"
              :disabled="isBusy(room)"
              :aria-label="`View ${room.displayName} details`"
              title="View room details"
              @click.stop="showRoomDetail(room)"
            >
              <ArrowRight aria-hidden="true" />
            </button>
          </div>
        </article>

        <article v-if="!filteredRooms.length" class="surface-row single-line" data-testid="settings-rooms-empty">
          <p class="surface-title">{{ emptyRoomsLabel }}</p>
        </article>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { ArrowRight, Pin } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import type { DesktopAccountRoomEntry } from "../../../../../../electron/ipc-types";
import { useCopyValueIndicator } from "../../../../composables/useCopyIndicator";
import { buildLetAgentsRoomCopyValue } from "../../../../domain/room-urls";
import { lastOpenedLabel, roleSourceLabel, slugify } from "../presentation";
import type { SettingsFeedback, SettingsPaneId } from "../types";

type RoomFilter = "active" | "pinned" | "created" | "joined";

const props = defineProps<{
  accountRooms: DesktopAccountRoomEntry[];
  activePane: SettingsPaneId;
  busy: boolean;
  feedback: SettingsFeedback | null;
  roomActionBusyKey: string | null;
}>();

defineEmits<{
  "delete-room": [room: DesktopAccountRoomEntry];
  "leave-room": [room: DesktopAccountRoomEntry];
  "open-room": [room: DesktopAccountRoomEntry];
  "restore-room": [room: DesktopAccountRoomEntry];
  "toggle-pin-room": [room: DesktopAccountRoomEntry];
}>();

const { copiedValue: copiedRoomUrl, copy: copyRoomUrlToClipboard } = useCopyValueIndicator(1400);
const roomFilter = ref<RoomFilter>("active");
const roomSearch = ref("");
const selectedRoomDetailIdentifier = ref<string | null>(null);

// Leaving the rooms panes (or switching between them) always returns to the
// list view, matching the previous SettingsView-level reset.
watch(
  () => props.activePane,
  () => {
    selectedRoomDetailIdentifier.value = null;
  },
);

const roomFilters: Array<{ id: RoomFilter; label: string }> = [
  { id: "active", label: "Active" },
  { id: "pinned", label: "Pinned" },
  { id: "created", label: "Created" },
  { id: "joined", label: "Joined" },
];

const archivedRoomCount = computed(() => props.accountRooms.filter((room) => room.archived).length);
const createdRoomCount = computed(() => props.accountRooms.filter((room) => room.canDelete && !room.archived).length);

const filteredRooms = computed(() => {
  const search = roomSearch.value.trim().toLowerCase();
  const effectiveFilter = props.activePane === "rooms:left"
    ? "left"
    : props.activePane === "rooms:danger"
      ? "danger"
      : roomFilter.value;

  return props.accountRooms
    .filter((room) => {
      if (effectiveFilter === "danger" && !room.canLeave && !room.canDelete && !room.archived) return false;
      if (effectiveFilter === "active" && room.archived) return false;
      if (effectiveFilter === "pinned" && (!room.pinned || room.archived)) return false;
      if (effectiveFilter === "created" && (!room.canDelete || room.archived)) return false;
      if (effectiveFilter === "joined" && (room.canDelete || room.archived)) return false;
      if (effectiveFilter === "left" && !room.archived) return false;
      if (!search) return true;
      const searchable = [
        room.displayName,
        room.roomIdentifier,
        room.source || "",
        ...room.focusRooms.flatMap((focusRoom) => [
          focusRoom.displayName,
          focusRoom.roomIdentifier,
          focusRoom.sourceTaskId || "",
          focusRoom.focusKey || "",
        ]),
      ].join(" ").toLowerCase();
      return searchable.includes(search);
    })
    .sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.lastOpenedAt || "").localeCompare(a.lastOpenedAt || "");
    });
});

const selectedRoomDetail = computed(() => {
  if (!selectedRoomDetailIdentifier.value) return null;
  return props.accountRooms.find((room) => room.roomIdentifier === selectedRoomDetailIdentifier.value) || null;
});

const roomCountLabel = computed(() => {
  if (props.activePane === "rooms:left") return `${archivedRoomCount.value} left`;
  if (props.activePane === "rooms:danger") return `${filteredRooms.value.length} actionable`;
  if (roomFilter.value === "created") return `${createdRoomCount.value} created`;
  return `${filteredRooms.value.length} ${roomFilter.value}`;
});

const emptyRoomsLabel = computed(() => {
  if (roomSearch.value.trim()) return "No rooms match that search.";
  if (props.activePane === "rooms:left") return "No left rooms.";
  if (props.activePane === "rooms:danger") return "No room actions are available.";
  if (roomFilter.value === "pinned") return "No pinned rooms yet.";
  if (roomFilter.value === "created") return "No rooms created by you.";
  if (roomFilter.value === "joined") return "No joined rooms yet.";
  return "No account rooms found.";
});

function actionKey(action: "delete" | "leave" | "pin" | "restore", room: DesktopAccountRoomEntry): string {
  return `${action}:${room.roomIdentifier}`;
}

function busyLabel(room: DesktopAccountRoomEntry, action: "delete" | "leave" | "restore", fallback: string): string {
  return props.roomActionBusyKey === actionKey(action, room)
    ? action === "delete" ? "Deleting" : action === "restore" ? "Restoring" : "Leaving"
    : fallback;
}

function isBusy(room: DesktopAccountRoomEntry): boolean {
  return props.busy
    || props.roomActionBusyKey === actionKey("leave", room)
    || props.roomActionBusyKey === actionKey("delete", room)
    || props.roomActionBusyKey === actionKey("pin", room)
    || props.roomActionBusyKey === actionKey("restore", room);
}

function roomUrl(room: DesktopAccountRoomEntry): string {
  return buildLetAgentsRoomCopyValue(room.roomIdentifier);
}

function showRoomDetail(room: DesktopAccountRoomEntry): void {
  selectedRoomDetailIdentifier.value = room.roomIdentifier;
}

async function copyRoomUrl(room: DesktopAccountRoomEntry): Promise<void> {
  const value = roomUrl(room);
  if (!value) return;
  await copyRoomUrlToClipboard(value);
}
</script>
