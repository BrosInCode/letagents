<template>
  <div ref="root" class="desktop-invite-bot" data-testid="desktop-invite-bot-panel">
    <!-- Always present, so a screen reader hears each change of it. -->
    <span class="desktop-invite-bot-sr" role="status">{{ spoken }}</span>
    <!-- A Git Room takes no bots: pick the invite room the bot joins first. -->
    <div v-if="view === 'rooms'" key="rooms" class="desktop-invite-bot-view" :data-swap="swap || undefined" data-testid="desktop-invite-bot-rooms">
      <div class="desktop-invite-bot-head">
        <p class="desktop-invite-bot-title">Invite a bot</p>
        <p class="desktop-invite-bot-sub">Bots join invite rooms, not Git Rooms. Pick the room the bot joins.</p>
      </div>
      <!-- While the rooms load the list itself holds focus, so Escape and Tab act on the panel. -->
      <div
        class="desktop-invite-bot-list"
        :aria-busy="roomsState === 'loading' || undefined"
        :tabindex="roomsState === 'loading' ? -1 : undefined"
        :data-invite-autofocus="roomsState === 'loading' || undefined"
        aria-label="Invite rooms"
      >
        <!-- Two quiet rows hold the place while the rooms load, so the list does not jump. -->
        <template v-if="roomsState === 'loading'">
          <span class="desktop-invite-bot-skeleton" aria-hidden="true"></span>
          <span class="desktop-invite-bot-skeleton" aria-hidden="true"></span>
        </template>
        <p v-else-if="roomsState === 'error'" class="desktop-invite-bot-error" role="alert">{{ roomsError }}</p>
        <p v-else-if="roomsState === 'ready' && !rooms.length" class="desktop-invite-bot-note">You are in no invite room yet.</p>
        <button
          v-for="(room, index) in rooms"
          :key="room.id"
          type="button"
          class="desktop-composer-add-menu-item desktop-invite-bot-room"
          :style="{ '--invite-row': index }"
          :data-fresh="room.id === freshRoomId || undefined"
          :data-invite-autofocus="index === 0 || undefined"
          :data-testid="`desktop-invite-bot-room-${room.id}`"
          @click="pickRoom(room)"
        >
          <Hash class="desktop-composer-add-menu-icon" :size="16" aria-hidden="true" />
          <span class="desktop-composer-add-menu-label">{{ room.displayName }}</span>
          <span class="desktop-composer-add-menu-end">{{ roomMeta(room) }}</span>
        </button>
        <div v-if="roomsState !== 'loading'" class="desktop-composer-add-menu-separator" role="separator"></div>
        <button
          v-if="roomsState !== 'loading'"
          type="button"
          class="desktop-composer-add-menu-item desktop-invite-bot-new-room"
          :aria-disabled="creatingRoom || undefined"
          :data-busy="creatingRoom || undefined"
          :data-invite-autofocus="(!rooms.length) || undefined"
          data-testid="desktop-invite-bot-new-room"
          @click="newRoom"
        >
          <span class="desktop-invite-bot-new-icon" aria-hidden="true">
            <Plus class="desktop-composer-add-menu-icon" :size="16" />
            <span class="desktop-invite-bot-spinner"></span>
          </span>
          <span class="desktop-composer-add-menu-label">{{ creatingRoom ? "Making the room…" : "New invite room" }}</span>
        </button>
        <p v-if="newRoomError" class="desktop-invite-bot-error" role="alert">{{ newRoomError }}</p>
      </div>
    </div>

    <!-- The invite: the bot, the message, Copy. -->
    <div v-else key="invite" class="desktop-invite-bot-view" :data-swap="swap || undefined" data-testid="desktop-invite-bot-invite">
      <button
        v-if="context.gitRoom"
        type="button"
        class="desktop-composer-add-menu-item desktop-invite-bot-back"
        data-testid="desktop-invite-bot-back"
        @click="backToRooms"
      >
        <ChevronLeft class="desktop-composer-add-menu-icon" :size="16" aria-hidden="true" />
        <span class="desktop-composer-add-menu-label">Rooms</span>
      </button>
      <div class="desktop-invite-bot-head">
        <p class="desktop-invite-bot-title">Invite a bot</p>
        <p class="desktop-invite-bot-sub" data-testid="desktop-invite-bot-summary">{{ summary }}</p>
      </div>
      <div class="desktop-invite-bot-body">
        <InviteBotPicker :model-value="invite.platform.value" @update:model-value="invite.pick" />
        <div class="desktop-invite-bot-message" :data-copied="invite.copied.value || undefined" data-testid="desktop-invite-bot-message">
          <InviteBotMessage
            :platform="invite.platform.value"
            :code="invite.created.value?.code ?? null"
            :connector-url="context.connectorUrl"
          />
        </div>
        <div class="desktop-invite-bot-foot">
          <p class="desktop-invite-bot-hint">Send this to the bot's owner.</p>
          <button
            type="button"
            class="desktop-invite-bot-copy"
            data-variant="primary"
            :aria-disabled="invite.busy.value || undefined"
            data-testid="desktop-invite-bot-copy"
            @click="copy"
          >
            <CopyStateLabel :state="copyState" />
          </button>
        </div>
        <p v-if="invite.error.value" class="desktop-invite-bot-error" role="alert">{{ invite.error.value }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { ChevronLeft, Hash, Plus } from "@lucide/vue";
import CopyStateLabel from "../../../../../../../../shared/ui/CopyStateLabel.vue";
import InviteBotMessage from "../../../../../../../../shared/ui/InviteBotMessage.vue";
import InviteBotPicker from "../../../../../../../../shared/ui/InviteBotPicker.vue";
import { inviteBotCodeSummary, useInviteBotCode } from "../../../../../../../../shared/ui/invite-bot";
import type { DesktopBotInviteRoom } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc/index.js";
import { roomInvites } from "../../../../composables/useRoomInvites";
import { prefersReducedMotion } from "./room-gif-search";

/** The room whose composer opened the panel. */
export interface RoomInviteBotContext {
  roomId: string;
  roomName: string;
  /** A Git Room: the panel lists invite rooms first. */
  gitRoom: boolean;
  /** Whether the viewer is an admin of this room (an admin's invite lets the bot in at once). */
  admin: boolean;
  /** `https://<this server>/mcp`. */
  connectorUrl: string;
}

interface Target { id: string; name: string; admin: boolean }

const props = defineProps<{ context: RoomInviteBotContext }>();
const emit = defineEmits<{
  /** The message was copied: the host closes the menu; the pill takes over. */
  sent: [];
  /** A new invite room was made; the host may refresh its room list. */
  "room-created": [roomIdentifier: string];
}>();

const view = ref<"rooms" | "invite">(props.context.gitRoom ? "rooms" : "invite");
/** The direction a view swap comes from: forward from the right, back from the left. */
const swap = ref<"forward" | "back" | null>(null);
/** A room made here a moment ago: its row says so once, on the way back. */
const freshRoomId = ref<string | null>(null);
const target = ref<Target | null>(props.context.gitRoom ? null : {
  id: props.context.roomId,
  name: props.context.roomName,
  admin: props.context.admin,
});
const rooms = ref<DesktopBotInviteRoom[]>([]);
const roomsState = ref<"idle" | "loading" | "ready" | "error">("idle");
const roomsError = ref("");
const creatingRoom = ref(false);
const newRoomError = ref("");
let sentTimer: ReturnType<typeof setTimeout> | undefined;
/** Invites made here; their pills show when the panel closes. */
const madeHere: string[] = [];
let unmounted = false;

const invite = useInviteBotCode({
  room: computed(() => target.value
    ? { roomId: target.value.id, roomName: target.value.name, connectorUrl: props.context.connectorUrl }
    : null),
  createInvite: async (platform) => {
    const made = await roomInvites.create(
      target.value!.id,
      platform,
      // From a Git Room, the pill shows in the Git Room.
      target.value!.id === props.context.roomId ? null : props.context.roomId,
    );
    // The panel closed while the code was being made: its pill shows at once.
    if (unmounted) roomInvites.reveal([made.invite.id]);
    else madeHere.push(made.invite.id);
    return made;
  },
});

const summary = computed(() => inviteBotCodeSummary(target.value?.name ?? "", target.value?.admin ?? false));
const copyState = computed(() => invite.busy.value ? "busy" : invite.copied.value ? "done" : "idle");
const root = ref<HTMLElement | null>(null);
/** What a screen reader hears: the rooms loading, then the copy. */
const spoken = computed(() => roomsState.value === "loading"
  ? "Checking your rooms…"
  : invite.copied.value ? "Invite copied. The code works one time." : "");

/** "3 people", and what an invite there does when the viewer is not its admin. */
function roomMeta(room: DesktopBotInviteRoom): string {
  const people = room.memberCount === null ? "" : room.memberCount === 1 ? "1 person" : `${room.memberCount} people`;
  return room.role === "admin" ? people : people ? `${people} · asks admin` : "asks admin";
}

function swapTo(next: "rooms" | "invite"): void {
  swap.value = prefersReducedMotion() ? null : next === "invite" ? "forward" : "back";
  view.value = next;
  void nextTick(() => root.value?.querySelector<HTMLElement>("[data-invite-autofocus]")?.focus({ preventScroll: true }));
}

async function loadRooms(): Promise<void> {
  roomsState.value = "loading";
  const result = await desktopIpc.roomInvites?.listRooms().catch(() => null);
  if (!result?.ok) {
    roomsState.value = "error";
    roomsError.value = result && !result.ok ? result.message : "Your rooms could not be read. Try again.";
    return;
  }
  rooms.value = result.rooms;
  roomsState.value = "ready";
  // Focus moves to the first room only if it is still in the panel (the person did not leave meanwhile).
  void nextTick(() => {
    const active = document.activeElement;
    if (active && active !== document.body && !root.value?.contains(active)) return;
    root.value?.querySelector<HTMLElement>("[data-invite-autofocus]")?.focus({ preventScroll: true });
  });
}

function pickRoom(room: DesktopBotInviteRoom): void {
  target.value = { id: room.id, name: room.displayName, admin: room.role === "admin" };
  invite.reset();
  swapTo("invite");
}

function backToRooms(): void {
  invite.reset();
  swapTo("rooms");
}

/** Makes a room on press, with a name made up like any new room's, and shows its invite. */
async function newRoom(): Promise<void> {
  if (creatingRoom.value) return;
  creatingRoom.value = true;
  newRoomError.value = "";
  try {
    const created = await desktopIpc.room.createInviteRoom();
    const name = created.snapshot.room?.displayName || created.snapshot.room?.name || created.code;
    emit("room-created", created.roomIdentifier);
    const room: DesktopBotInviteRoom = { id: created.roomIdentifier, displayName: name, role: "admin", memberCount: 1 };
    // Back to Rooms lists it, so a second press does not make another room.
    rooms.value = [room, ...rooms.value.filter((listed) => listed.id !== room.id)];
    freshRoomId.value = room.id;
    pickRoom(room);
  } catch (error) {
    newRoomError.value = error instanceof Error && error.message ? error.message : "The room could not be made. Try again.";
  } finally {
    creatingRoom.value = false;
  }
}

async function copy(): Promise<void> {
  const made = await invite.copy();
  if (!made || invite.error.value) return;
  // The code resolves and "Copied" shows for a moment; then the menu closes
  // and the pill above the composer takes over.
  clearTimeout(sentTimer);
  sentTimer = setTimeout(() => emit("sent"), 700);
}

onMounted(() => { if (view.value === "rooms") void loadRooms(); });
onBeforeUnmount(() => {
  unmounted = true;
  clearTimeout(sentTimer);
  roomInvites.reveal(madeHere);
});
</script>
