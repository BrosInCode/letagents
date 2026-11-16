<template>
  <div ref="root" class="invite-bot" data-testid="invite-bot-section">
    <!-- A Git Room's GitHub roles decide who is in it: no invites here. -->
    <p v-if="gitRoom" class="invite-bot-hint" data-testid="invite-bot-git-room">{{ INVITE_BOT_GIT_ROOM_LINE }} {{ gitRoomHint }}</p>

    <!-- Closed: one line and one quiet button, like the panels around it. -->
    <div v-else-if="collapsible && !open" class="invite-bot-closed">
      <p class="invite-bot-hint">{{ closedLine }}</p>
      <button
        ref="openButton"
        type="button"
        class="invite-bot-button"
        data-testid="invite-bot-open"
        @click="openSection"
      >
        Create
      </button>
    </div>

    <div v-else class="invite-bot-open" data-testid="invite-bot-open-section">
      <p class="invite-bot-hint" data-testid="invite-bot-summary">{{ summary }}</p>
      <InviteBotPicker :model-value="invite.platform.value" @update:model-value="pick" />

      <div class="invite-bot-message" data-testid="invite-bot-message">
        <div class="invite-bot-text" :data-copied="invite.copied.value || undefined" data-testid="invite-bot-text">
          <InviteBotMessage :platform="invite.platform.value" :code="invite.created.value?.code ?? null" :connector-url="room.connectorUrl" />
        </div>
        <div class="invite-bot-actions">
          <button
            type="button"
            class="invite-bot-button"
            data-variant="primary"
            data-testid="invite-bot-copy"
            :data-copied="invite.copied.value"
            :aria-disabled="invite.busy.value || undefined"
            @click="copy"
          >
            <!-- Once the bot is in, the used code is history: the button makes a new one. -->
            <CopyStateLabel :state="invite.busy.value ? 'busy' : invite.copied.value ? 'done' : 'idle'" :idle="joined ? 'New invite' : 'Copy'" />
          </button>
          <Transition name="invite-bot-fade">
            <button
              v-if="invite.created.value && cancelInvite && !joined"
              type="button"
              class="invite-bot-button"
              data-testid="invite-bot-cancel"
              :aria-disabled="cancelling || undefined"
              @click="cancel"
            >
              Cancel invite
            </button>
          </Transition>
          <button v-if="collapsible" type="button" class="invite-bot-button invite-bot-done" @click="done">Done</button>
        </div>
        <p v-if="invite.error.value || cancelError" class="invite-bot-error" role="alert">{{ invite.error.value || cancelError }}</p>
        <!-- One status line that answers in place: the hint, then waiting, joined, or cancelled. -->
        <Transition name="invite-bot-fade" mode="out-in">
          <p v-if="invite.created.value && joined" key="joined" class="invite-bot-hint invite-bot-status" data-testid="invite-bot-joined">
            <svg class="invite-bot-joined-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17 19 7" /></svg>{{ joinedText }}
          </p>
          <p v-else-if="invite.created.value" key="waiting" class="invite-bot-hint invite-bot-status" data-testid="invite-bot-waiting">
            <span class="invite-bot-live" aria-hidden="true"></span>Waiting for {{ botName }} to join. The invite works one time and ends in 7 days.
          </p>
          <p v-else-if="cancelled" key="cancelled" class="invite-bot-hint" data-testid="invite-bot-cancelled">The invite was cancelled. Copy makes a new one.</p>
          <p v-else key="hint" class="invite-bot-hint">{{ INVITE_BOT_HINT }}</p>
        </Transition>
        <!-- Spoken once, for screen readers: the visible words change inside the button. -->
        <span class="invite-bot-sr" role="status">{{ spoken }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from "vue";

import CopyStateLabel from "./CopyStateLabel.vue";
import InviteBotMessage from "./InviteBotMessage.vue";
import InviteBotPicker from "./InviteBotPicker.vue";
import {
  INVITE_BOT_GIT_ROOM_LINE,
  INVITE_BOT_HINT,
  INVITE_BOT_PLATFORMS,
  inviteBotCodeSummary,
  useInviteBotCode,
  type InviteBotCreated,
  type InviteBotPlatform,
} from "./invite-bot";

const props = withDefaults(defineProps<{
  /** The room the bot joins, and this server's `/mcp` address. */
  room: { roomId: string; roomName?: string | null; connectorUrl?: string | null };
  /** An admin's invite lets the bot in at once; a member's asks the admins. */
  admin?: boolean;
  /** A Git Room takes no invites; the section says where to go instead. */
  gitRoom?: boolean;
  /** Where to invite a bot from a Git Room, in this app. */
  gitRoomHint?: string;
  /** Makes the invite on the server. Throws an Error whose message is shown. */
  createInvite: (platform: InviteBotPlatform) => Promise<InviteBotCreated>;
  /** Ends the invite Copy made; resolves a sentence when it could not. */
  cancelInvite?: ((inviteId: string) => Promise<string | null>) | null;
  /** Show an "Invite a bot" button first, and Done to close (the web drawer). */
  collapsible?: boolean;
  /**
   * What became of the invite Copy made, when the host hears it (the desktop
   * reads its invite store): "used" shows that the bot joined, or asked.
   */
  inviteState?: { state: "open" | "used" | "cancelled" | "expired"; outcome: "admitted" | "requested" | null } | null;
  /** Start with this bot picked (tests). */
  initialPlatform?: InviteBotPlatform | null;
}>(), { admin: false, gitRoom: false, gitRoomHint: "", cancelInvite: null, collapsible: true, initialPlatform: null, inviteState: null });
const emit = defineEmits<{
  /** Copy made an invite; the host may follow it. */
  made: [inviteId: string];
}>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const cancelling = ref(false);
const cancelled = ref(false);
const cancelError = ref<string | null>(null);
const invite = useInviteBotCode({
  room: computed(() => props.room),
  createInvite: async (platform) => {
    cancelled.value = false;
    cancelError.value = null;
    const made = await props.createInvite(platform);
    emit("made", made.invite.id);
    return made;
  },
  initialPlatform: props.initialPlatform,
});

const closedLine = computed(() => props.admin
  ? "A one-use code that lets a bot into this room."
  : "A one-use code that asks an admin to let a bot in.");
const summary = computed(() => inviteBotCodeSummary(props.room.roomName || props.room.roomId, props.admin));
const botName = computed(() => {
  const label = INVITE_BOT_PLATFORMS.find((choice) => choice.id === invite.platform.value)?.label ?? "the bot";
  return label === "Other" ? "your bot" : label;
});

const joined = computed(() => props.inviteState?.state === "used");
const joinedText = computed(() => props.inviteState?.outcome === "requested"
  ? `${capital(botName.value)} asked to join. A room admin decides.`
  : `${capital(botName.value)} joined.`);
const spoken = computed(() => joined.value ? joinedText.value : invite.copied.value ? "Invite copied. The code works one time." : "");

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function copy(): Promise<void> {
  if (joined.value) invite.reset();
  await invite.copy();
}

async function cancel(): Promise<void> {
  const made = invite.created.value;
  if (!made || !props.cancelInvite || cancelling.value) return;
  cancelling.value = true;
  cancelError.value = await props.cancelInvite(made.invite.id);
  cancelling.value = false;
  if (!cancelError.value) {
    invite.reset();
    cancelled.value = true;
  }
}

function pick(platform: InviteBotPlatform): void {
  cancelled.value = false;
  invite.pick(platform);
}

/** Opens the invite and puts focus on the picked bot (its own button, or a host's "+" menu). */
function openSection(): void {
  open.value = true;
  void nextTick(() => root.value?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus({ preventScroll: true }));
}
defineExpose({ openSection });

const openButton = ref<HTMLButtonElement | null>(null);

function done(): void {
  open.value = false;
  // Focus goes back to the button that opened it.
  void nextTick(() => openButton.value?.focus({ preventScroll: true }));
  cancelled.value = false;
  cancelError.value = null;
  invite.reset();
}
</script>

<style src="./invite-bot.css"></style>
