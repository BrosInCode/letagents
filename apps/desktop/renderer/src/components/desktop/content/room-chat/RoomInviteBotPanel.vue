<template>
  <div ref="root" class="desktop-invite-bot" data-testid="desktop-invite-bot-panel">
    <!-- Always present, so a screen reader hears each change of it. -->
    <span class="desktop-invite-bot-sr" role="status">{{ spoken }}</span>
    <!-- A Git Room takes no bots: pick the invite room the bot joins first. -->
    <div
      v-if="view === 'rooms'"
      key="rooms"
      class="desktop-invite-bot-view desktop-invite-bot-rooms"
      :data-swap="swap || undefined"
      :data-searchable="picker.searchable.value || undefined"
      data-testid="desktop-invite-bot-rooms"
    >
      <div class="desktop-invite-bot-head">
        <p class="desktop-invite-bot-title">Invite a bot</p>
        <p class="desktop-invite-bot-sub">Bots join invite rooms, not Git Rooms. Pick the room the bot joins.</p>
      </div>
      <!-- A long list gets the GIF panel's search field; it takes the focus. -->
      <label v-if="picker.searchable.value" class="desktop-composer-gif-search desktop-invite-bot-search">
        <Search :size="15" aria-hidden="true" />
        <input
          type="text"
          :value="picker.query.value"
          maxlength="100"
          placeholder="Find a room"
          aria-label="Find a room"
          role="combobox"
          aria-autocomplete="list"
          :aria-expanded="picker.shown.value.length > 0"
          :aria-controls="picker.shown.value.length ? listId : undefined"
          :aria-activedescendant="activeRoomId"
          autocomplete="off"
          spellcheck="false"
          data-invite-autofocus
          data-testid="desktop-invite-bot-room-search"
          @input="findRoom(($event.target as HTMLInputElement).value)"
          @keydown="searchKey"
        />
        <kbd aria-hidden="true">↵</kbd>
      </label>
      <!-- The rooms scroll inside the GIF grid's height. While the rooms load the list itself holds focus, so Escape and Tab act on the panel. -->
      <div
        :id="listId"
        ref="list"
        class="desktop-invite-bot-list"
        :role="picker.searchable.value && picker.shown.value.length ? 'listbox' : undefined"
        :aria-busy="roomsState === 'loading' || undefined"
        :tabindex="roomsState === 'loading' ? -1 : undefined"
        :data-invite-autofocus="roomsState === 'loading' || undefined"
        :data-more-above="fades.above || undefined"
        :data-more-below="fades.below || undefined"
        :data-typed="typed || undefined"
        aria-label="Invite rooms"
        data-testid="desktop-invite-bot-room-list"
        @scroll.passive="updateFades"
        @animationend="updateFades"
      >
        <!-- Two quiet rows hold the place while the rooms load, so the list does not jump. -->
        <template v-if="roomsState === 'loading'">
          <span class="desktop-invite-bot-skeleton" aria-hidden="true"></span>
          <span class="desktop-invite-bot-skeleton" aria-hidden="true"></span>
        </template>
        <p v-else-if="roomsState === 'error'" class="desktop-invite-bot-error" role="alert">{{ roomsError }}</p>
        <p v-else-if="roomsState === 'ready' && !rooms.length" class="desktop-invite-bot-note">You are in no invite room yet.</p>
        <p v-else-if="!picker.shown.value.length" class="desktop-invite-bot-note" role="status" data-testid="desktop-invite-bot-no-match">
          No room called "{{ picker.query.value.trim() }}". Make a new one below.
        </p>
        <button
          v-for="(room, index) in picker.shown.value"
          :id="picker.searchable.value ? `${listId}-${index}` : undefined"
          :key="room.id"
          type="button"
          class="desktop-composer-add-menu-item desktop-invite-bot-room"
          :role="picker.searchable.value ? 'option' : undefined"
          :tabindex="picker.searchable.value ? -1 : undefined"
          :aria-selected="picker.searchable.value ? index === picker.active.value : undefined"
          :data-active="(picker.searchable.value && index === picker.active.value) || undefined"
          :style="{ '--invite-row': index }"
          :data-fresh="room.id === freshRoomId || undefined"
          :data-invite-autofocus="(!picker.searchable.value && index === 0) || undefined"
          :data-testid="`desktop-invite-bot-room-${room.id}`"
          @click="pickRoom(room)"
          @pointermove="picker.searchable.value && picker.setActive(index)"
        >
          <Hash class="desktop-composer-add-menu-icon" :size="16" aria-hidden="true" />
          <span class="desktop-composer-add-menu-label"><template v-for="(part, at) in picker.nameParts(room.displayName)" :key="at"><mark
            v-if="part.match" class="desktop-invite-bot-match">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
          <span class="desktop-composer-add-menu-end">{{ inviteRoomMeta(room) }}</span>
        </button>
      </div>
      <!-- "New invite room" stays below the list, however far it scrolls. -->
      <div v-if="roomsState !== 'loading'" class="desktop-invite-bot-foot-rooms">
        <div class="desktop-composer-add-menu-separator" role="separator"></div>
        <button
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
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ChevronLeft, Hash, Plus, Search } from "@lucide/vue";
import CopyStateLabel from "../../../../../../../../shared/ui/CopyStateLabel.vue";
import InviteBotMessage from "../../../../../../../../shared/ui/InviteBotMessage.vue";
import InviteBotPicker from "../../../../../../../../shared/ui/InviteBotPicker.vue";
import { inviteBotCodeSummary, useInviteBotCode } from "../../../../../../../../shared/ui/invite-bot";
import type { DesktopBotInviteRoom } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc/index.js";
import { roomInvites } from "../../../../composables/useRoomInvites";
import { inviteRoomListFades, inviteRoomMeta, inviteRoomScrollToReveal, useInviteRoomPicker } from "./invite-room-picker";
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

const list = ref<HTMLElement | null>(null);
const listId = `desktop-invite-bot-rooms-${Math.random().toString(36).slice(2, 10)}`;
const picker = useInviteRoomPicker(rooms, (room) => pickRoom(room));
const activeRoomId = computed(() => picker.shown.value.length ? `${listId}-${picker.active.value}` : undefined);
/** Rows past an edge of the list: that edge fades. */
const fades = reactive({ above: false, below: false });
/** After the first key in the search field, rows appear without motion. */
const typed = ref(false);
let listResize: ResizeObserver | null = null;

function updateFades(): void {
  const element = list.value;
  if (!element) return;
  const next = inviteRoomListFades(element);
  fades.above = next.above;
  fades.below = next.below;
}

function findRoom(text: string): void {
  typed.value = true;
  picker.setQuery(text);
}

/** Scrolls only the list, so the active row is in sight and clear of the fades. */
function revealActive(): void {
  void nextTick(() => {
    const element = list.value;
    const row = element?.querySelector?.<HTMLElement>("[data-active]");
    if (!element || !row) return;
    element.scrollTop = inviteRoomScrollToReveal(element, { top: row.offsetTop, height: row.offsetHeight });
  });
}

/** ↑ and ↓ bring the active row into sight; the pointer moving over a row never scrolls the list. */
function searchKey(event: KeyboardEvent): void {
  if (picker.handleKey(event) && (event.key === "ArrowDown" || event.key === "ArrowUp")) revealActive();
}

// The fades follow the rows shown and the list's own height (the flyout may cap it).
// Rows slide in by a few pixels, which adds to the scroll height until they land, so
// the list measures again when a row's motion ends (`animationend` in the template).
watch(() => picker.shown.value, () => void nextTick(updateFades));
watch(list, (element) => {
  listResize?.disconnect();
  listResize = null;
  if (!element) return;
  if (typeof ResizeObserver !== "undefined") {
    listResize = new ResizeObserver(updateFades);
    listResize.observe(element);
  }
  void nextTick(updateFades);
});
// A new search, or Escape clearing one, shows its first rows (its first row is active).
watch(() => picker.query.value, () => { if (list.value) list.value.scrollTop = 0; });

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
  // Back in the list, the rows come in as they did the first time; the search keeps its text
  // and its active row, which the list scrolls to.
  typed.value = false;
  swapTo("rooms");
  if (picker.searchable.value) revealActive();
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
    // Back in the list, the new room shows at the top, not hidden by a search.
    picker.setQuery("");
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
  listResize?.disconnect();
  clearTimeout(sentTimer);
  roomInvites.reveal(madeHere);
});
</script>
