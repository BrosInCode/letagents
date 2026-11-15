<template>
  <div class="desktop-invite-bot" data-testid="desktop-invite-bot-panel">
    <!-- A Git Room takes no bots: pick the invite room the bot joins first. -->
    <div v-if="view === 'rooms'" key="rooms" class="desktop-invite-bot-view" :data-swap="swapIn || undefined" data-testid="desktop-invite-bot-rooms">
      <div class="desktop-invite-bot-head">
        <p class="desktop-invite-bot-title">Invite a bot</p>
        <p class="desktop-invite-bot-sub">Bots join invite rooms, not Git Rooms. Pick the room the bot joins.</p>
      </div>
      <div class="desktop-invite-bot-list">
        <p v-if="roomsState === 'loading'" class="desktop-invite-bot-note" role="status">Checking your rooms…</p>
        <p v-else-if="roomsState === 'error'" class="desktop-invite-bot-error" role="alert">{{ roomsError }}</p>
        <button
          v-for="(room, index) in rooms"
          :key="room.id"
          type="button"
          class="desktop-composer-add-menu-item"
          :data-invite-autofocus="index === 0 || undefined"
          :data-testid="`desktop-invite-bot-room-${room.id}`"
          @click="pickRoom(room)"
        >
          <Hash class="desktop-composer-add-menu-icon" :size="16" aria-hidden="true" />
          <span class="desktop-composer-add-menu-label">{{ room.displayName }}</span>
          <span v-if="room.memberCount" class="desktop-composer-add-menu-end">{{ people(room.memberCount) }}</span>
        </button>
        <div v-if="rooms.length" class="desktop-composer-add-menu-separator" role="separator"></div>
        <button
          type="button"
          class="desktop-composer-add-menu-item"
          :aria-disabled="creatingRoom || undefined"
          :data-invite-autofocus="(!rooms.length && roomsState !== 'loading') || undefined"
          data-testid="desktop-invite-bot-new-room"
          @click="newRoom"
        >
          <Plus class="desktop-composer-add-menu-icon" :size="16" aria-hidden="true" />
          <span class="desktop-composer-add-menu-label">{{ creatingRoom ? "Making the room…" : "New invite room" }}</span>
        </button>
        <p v-if="newRoomError" class="desktop-invite-bot-error" role="alert">{{ newRoomError }}</p>
      </div>
    </div>

    <!-- The invite: the bot, the message, Copy. -->
    <div v-else key="invite" class="desktop-invite-bot-view" :data-swap="swapIn || undefined" data-testid="desktop-invite-bot-invite">
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
        <div
          class="desktop-invite-bot-picker"
          role="group"
          aria-label="Which bot"
          :style="{ '--invite-bot-index': platformIndex }"
          data-testid="desktop-invite-bot-picker"
        >
          <span class="desktop-invite-bot-thumb" aria-hidden="true"></span>
          <button
            v-for="(choice, index) in INVITE_BOT_PLATFORMS"
            :key="choice.id"
            type="button"
            :data-platform="choice.id"
            :aria-pressed="invite.platform.value === choice.id ? 'true' : 'false'"
            :data-invite-autofocus="index === 0 || undefined"
            @click="invite.pick(choice.id)"
          >{{ choice.label }}</button>
        </div>
        <div class="desktop-invite-bot-message" data-testid="desktop-invite-bot-message">
          <Transition name="desktop-invite-bot-swap" mode="out-in">
            <div :key="invite.platform.value" class="desktop-invite-bot-message-inner">
              <p class="desktop-invite-bot-lead">{{ invite.message.value.lead }}</p>
              <p class="desktop-invite-bot-text" data-testid="desktop-invite-bot-text"><template
                v-for="(part, index) in invite.message.value.parts"
                :key="index"
              ><span v-if="part.kind === 'connector'" class="desktop-invite-bot-address">{{ part.text }}</span><span
                v-else-if="part.kind === 'code'"
                class="desktop-invite-bot-code"
                :data-placeholder="part.placeholder || undefined"
                :title="part.placeholder ? 'Copy makes a one-time code' : undefined"
              >{{ part.text }}</span><template v-else>{{ part.text }}</template></template></p>
            </div>
          </Transition>
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
            <span class="desktop-invite-bot-copy-label" :data-state="copyState">{{ copyLabel }}</span>
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
import {
  INVITE_BOT_PLATFORMS,
  inviteBotCodeSummary,
  useInviteBotCode,
} from "../../../../../../../../shared/ui/invite-bot";
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
const swapIn = ref(false);
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
    madeHere.push(made.invite.id);
    return made;
  },
});

const summary = computed(() => inviteBotCodeSummary(target.value?.name ?? "", target.value?.admin ?? false));
const platformIndex = computed(() => Math.max(0, INVITE_BOT_PLATFORMS.findIndex((choice) => choice.id === invite.platform.value)));
const copyState = computed(() => invite.busy.value ? "busy" : invite.copied.value ? "copied" : "idle");
const copyLabel = computed(() => invite.busy.value ? "Making…" : invite.copied.value ? "Copied" : "Copy");

function people(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

function swapTo(next: "rooms" | "invite"): void {
  swapIn.value = !prefersReducedMotion();
  view.value = next;
  void nextTick(() => document.querySelector<HTMLElement>(".desktop-invite-bot [data-invite-autofocus]")?.focus({ preventScroll: true }));
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
  void nextTick(() => document.querySelector<HTMLElement>(".desktop-invite-bot [data-invite-autofocus]")?.focus({ preventScroll: true }));
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
    pickRoom({ id: created.roomIdentifier, displayName: name, role: "admin", memberCount: 1 });
  } catch (error) {
    newRoomError.value = error instanceof Error && error.message ? error.message : "The room could not be made. Try again.";
  } finally {
    creatingRoom.value = false;
  }
}

async function copy(): Promise<void> {
  const made = await invite.copy();
  if (!made || invite.error.value) return;
  // "Copied" shows for a moment; then the menu closes and the pill above the composer takes over.
  clearTimeout(sentTimer);
  sentTimer = setTimeout(() => emit("sent"), 650);
}

onMounted(() => { if (view.value === "rooms") void loadRooms(); });
onBeforeUnmount(() => {
  clearTimeout(sentTimer);
  roomInvites.reveal(madeHere);
});
</script>
