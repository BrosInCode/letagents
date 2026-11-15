<template>
  <TransitionGroup v-if="roomIdentifier" tag="div" name="room-invite-pill" class="room-invite-pills" data-testid="room-invite-pills">
    <div
      v-for="pill in pills"
      :key="pill.invite.id"
      class="agent-ask-pill room-invite-pill"
      :data-state="pill.state"
      role="status"
      :data-testid="`room-invite-pill-${pill.invite.id}`"
    >
      <span class="room-invite-pill-text">
        <span v-if="pill.state === 'joined'" class="room-invite-pill-dot" aria-hidden="true"></span>
        <Link2 v-else class="room-invite-pill-icon" :size="14" aria-hidden="true" />
        <span class="room-invite-pill-words">{{ text(pill).main }}<span class="room-invite-pill-muted">{{ text(pill).muted }}</span></span>
      </span>
      <span class="agent-ask-pill-actions">
        <template v-if="pill.state === 'waiting'">
          <button v-if="pill.code" type="button" data-testid="room-invite-pill-copy" @click="copy(pill)">
            {{ copiedId === pill.invite.id ? "Copied" : "Copy invite" }}
          </button>
          <button type="button" :aria-disabled="cancelling === pill.invite.id || undefined" data-testid="room-invite-pill-cancel" @click="cancel(pill)">
            Cancel
          </button>
        </template>
        <template v-else>
          <button v-if="pill.state === 'joined' && pill.elsewhere" type="button" data-testid="room-invite-pill-open" @click="open(pill)">
            Open {{ pill.invite.room_display_name || pill.invite.room_id }}
          </button>
          <button type="button" data-testid="room-invite-pill-done" @click="roomInvites.close(pill.invite.id)">Done</button>
        </template>
      </span>
    </div>
    <p v-if="error" key="error" class="agent-ask-bar-error" role="alert">{{ error }}</p>
  </TransitionGroup>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { Link2 } from "@lucide/vue";
import { buildInviteBotCodeMessage } from "../../../../../../../../shared/ui/invite-bot";
import { roomInvitePillText, roomInvites, type RoomInvitePill } from "../../../../composables/useRoomInvites";

const props = defineProps<{
  roomIdentifier: string | null;
  /** `https://<this server>/mcp`, for the message Copy writes again. */
  connectorUrl: string;
}>();
const emit = defineEmits<{ "open-room": [roomIdentifier: string] }>();

const pills = roomInvites.pills(() => props.roomIdentifier);
const copiedId = ref<string | null>(null);
const cancelling = ref<string | null>(null);
const error = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const text = roomInvitePillText;

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
  if (room) void roomInvites.load(room);
}, { immediate: true });
onBeforeUnmount(() => clearTimeout(copiedTimer));
</script>
