<template>
  <TransitionGroup v-if="roomIdentifier" ref="list" tag="div" name="room-invite-pill" class="room-invite-pills" data-testid="room-invite-pills">
    <div
      v-for="pill in visible"
      :key="pill.invite.id"
      class="agent-ask-pill room-invite-pill"
      :data-state="pill.state"
      role="status"
      :data-testid="`room-invite-pill-${pill.invite.id}`"
    >
      <span class="room-invite-pill-text">
        <!-- One mark that changes with the state: a link while it waits, a check when the bot is in. -->
        <span class="room-invite-pill-mark" aria-hidden="true">
          <Link2 class="room-invite-pill-link" :size="14" />
          <svg class="room-invite-pill-check" viewBox="0 0 24 24"><path d="M5 12.5 10 17 19 7" /></svg>
          <span class="room-invite-pill-dot"></span>
          <X class="room-invite-pill-x" :size="14" />
        </span>
        <Transition name="room-invite-pill-swap" mode="out-in">
          <span :key="pill.state" class="room-invite-pill-words">{{ text(pill).main }}<span class="room-invite-pill-muted">{{ text(pill).muted }}</span></span>
        </Transition>
      </span>
      <Transition name="room-invite-pill-swap" mode="out-in">
        <span :key="actionsKey(pill)" class="agent-ask-pill-actions">
          <template v-if="pill.state === 'waiting'">
            <button v-if="pill.code" type="button" data-testid="room-invite-pill-copy" @click="copy(pill)">
              <CopyStateLabel :state="copiedId === pill.invite.id ? 'done' : 'idle'" idle="Copy invite" done="Copied" />
            </button>
            <button
              type="button"
              :aria-disabled="cancelling === pill.invite.id || undefined"
              data-testid="room-invite-pill-cancel"
              @click="cancel(pill)"
            >Cancel</button>
          </template>
          <template v-else-if="pill.state === 'joined' || pill.state === 'asked'">
            <button v-if="pill.state === 'joined' && pill.elsewhere" type="button" data-testid="room-invite-pill-open" @click="open(pill)">
              Open {{ pill.invite.room_display_name || pill.invite.room_id }}
            </button>
            <button type="button" data-testid="room-invite-pill-done" @click="roomInvites.close(pill.invite.id)">Done</button>
          </template>
        </span>
      </Transition>
    </div>
    <!-- More than two invites: the rest fold into one quiet line until asked for. -->
    <button
      v-if="hiddenCount > 0"
      key="more"
      type="button"
      class="room-invite-pills-more"
      data-testid="room-invite-pills-more"
      @click="showAll"
    >Show {{ hiddenCount }} more {{ hiddenCount === 1 ? "invite" : "invites" }}</button>
    <p v-if="error" key="error" class="agent-ask-bar-error" role="alert">{{ error }}</p>
  </TransitionGroup>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Link2, X } from "@lucide/vue";
import CopyStateLabel from "../../../../../../../../shared/ui/CopyStateLabel.vue";
import { buildInviteBotCodeMessage } from "../../../../../../../../shared/ui/invite-bot";
import { roomInvitePillText, roomInvites, type RoomInvitePill } from "../../../../composables/useRoomInvites";

const props = defineProps<{
  roomIdentifier: string | null;
  /** `https://<this server>/mcp`, for the message Copy writes again. */
  connectorUrl: string;
}>();
const emit = defineEmits<{ "open-room": [roomIdentifier: string] }>();

const pills = roomInvites.pills(() => props.roomIdentifier);
/** Two pills at most until the person asks for the rest. */
const MAX_PILLS = 2;
const expanded = ref(false);
const visible = computed(() => expanded.value ? pills.value : pills.value.slice(0, MAX_PILLS));
const hiddenCount = computed(() => pills.value.length - visible.value.length);
const list = ref<{ $el?: HTMLElement } | null>(null);

/** The rest unfold; focus goes to the first one that was hidden, so a keyboard user is not dropped. */
function showAll(): void {
  const firstHidden = pills.value[MAX_PILLS]?.invite.id;
  expanded.value = true;
  void nextTick(() => {
    const host = list.value?.$el;
    host?.querySelector<HTMLElement>(`[data-testid="room-invite-pill-${firstHidden}"] button`)?.focus({ preventScroll: true });
  });
}
const copiedId = ref<string | null>(null);
const cancelling = ref<string | null>(null);
const error = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const text = roomInvitePillText;
const actionsKey = (pill: RoomInvitePill) => pill.state === "waiting" ? "waiting" : pill.state === "joined" || pill.state === "asked" ? "after" : "none";

async function copy(pill: RoomInvitePill): Promise<void> {
  if (!pill.code) return;
  error.value = null;
  const message = buildInviteBotCodeMessage(pill.invite.platform, {
    code: pill.code,
    connectorUrl: props.connectorUrl,
  });
  try {
    await navigator.clipboard.writeText(message.text);
    copiedId.value = pill.invite.id;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copiedId.value = null; }, 1600);
  } catch {
    error.value = "The invite could not be copied. Try again.";
  }
}

async function cancel(pill: RoomInvitePill): Promise<void> {
  if (cancelling.value) return;
  cancelling.value = pill.invite.id;
  error.value = await roomInvites.cancel(pill.invite);
  cancelling.value = null;
}

function open(pill: RoomInvitePill): void {
  roomInvites.close(pill.invite.id);
  emit("open-room", pill.invite.room_id);
}

watch(() => props.roomIdentifier, (room) => {
  error.value = null;
  expanded.value = false;
  if (room) void roomInvites.load(room);
}, { immediate: true });
// A change missed while the stream was down (the computer slept) is read again when the window comes back.
function reloadOnFocus(): void {
  roomInvites.tick();
  if (props.roomIdentifier) void roomInvites.load(props.roomIdentifier);
}
onMounted(() => window.addEventListener("focus", reloadOnFocus));
onBeforeUnmount(() => {
  clearTimeout(copiedTimer);
  window.removeEventListener("focus", reloadOnFocus);
});
</script>
