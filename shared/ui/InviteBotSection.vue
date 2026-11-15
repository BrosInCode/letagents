<template>
  <div class="invite-bot" data-testid="invite-bot-section">
    <!-- A Git Room's GitHub roles decide who is in it: no invites here. -->
    <p v-if="gitRoom" class="invite-bot-hint" data-testid="invite-bot-git-room">{{ INVITE_BOT_GIT_ROOM_LINE }} {{ gitRoomHint }}</p>

    <button
      v-else-if="collapsible && !open"
      type="button"
      class="invite-bot-button"
      data-variant="primary"
      data-testid="invite-bot-open"
      @click="open = true"
    >
      Invite a bot
    </button>

    <template v-else>
      <p class="invite-bot-hint" data-testid="invite-bot-summary">{{ summary }}</p>
      <div class="invite-bot-picker" role="group" aria-label="Which bot" data-testid="invite-bot-picker">
        <button
          v-for="choice in INVITE_BOT_PLATFORMS"
          :key="choice.id"
          type="button"
          class="invite-bot-button"
          :data-platform="choice.id"
          :aria-pressed="invite.platform.value === choice.id ? 'true' : 'false'"
          @click="invite.pick(choice.id)"
        >
          {{ choice.label }}
        </button>
      </div>

      <div class="invite-bot-message" data-testid="invite-bot-message">
        <div class="invite-bot-text" data-testid="invite-bot-text">
          <p class="invite-bot-lead">{{ invite.message.value.lead }}</p>
          <p class="invite-bot-body"><template v-for="(part, index) in invite.message.value.parts" :key="index"><span
            v-if="part.kind === 'connector'"
            class="invite-bot-address"
          >{{ part.text }}</span><span
            v-else-if="part.kind === 'code'"
            class="invite-bot-code"
            :data-placeholder="part.placeholder || undefined"
            :title="part.placeholder ? 'Copy makes a one-time code' : undefined"
          >{{ part.text }}</span><template v-else>{{ part.text }}</template></template></p>
        </div>
        <div class="invite-bot-actions">
          <button
            type="button"
            class="invite-bot-button"
            data-variant="primary"
            data-testid="invite-bot-copy"
            :data-copied="invite.copied.value"
            :aria-disabled="invite.busy.value || undefined"
            @click="invite.copy()"
          >
            {{ invite.busy.value ? "Making…" : invite.copied.value ? "Copied" : "Copy" }}
          </button>
          <button
            v-if="invite.created.value && cancelInvite"
            type="button"
            class="invite-bot-button"
            data-testid="invite-bot-cancel"
            :aria-disabled="cancelling || undefined"
            @click="cancel"
          >
            Cancel invite
          </button>
          <button v-if="collapsible" type="button" class="invite-bot-button" @click="done">Done</button>
        </div>
        <p v-if="invite.error.value || cancelError" class="invite-bot-error" role="alert">{{ invite.error.value || cancelError }}</p>
        <p v-if="invite.created.value" class="invite-bot-hint" data-testid="invite-bot-waiting">
          Waiting for {{ botName }} to join. The invite works one time and ends in 7 days.
        </p>
        <p v-else-if="cancelled" class="invite-bot-hint" data-testid="invite-bot-cancelled">The invite was cancelled. Copy makes a new one.</p>
        <p v-else class="invite-bot-hint">{{ INVITE_BOT_HINT }}</p>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

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
  /** Start with this bot picked (tests). */
  initialPlatform?: InviteBotPlatform | null;
}>(), { admin: false, gitRoom: false, gitRoomHint: "", cancelInvite: null, collapsible: true, initialPlatform: null });

const open = ref(false);
const cancelling = ref(false);
const cancelled = ref(false);
const cancelError = ref<string | null>(null);
const invite = useInviteBotCode({
  room: computed(() => props.room),
  createInvite: async (platform) => {
    cancelled.value = false;
    cancelError.value = null;
    return props.createInvite(platform);
  },
  initialPlatform: props.initialPlatform,
});

const summary = computed(() => inviteBotCodeSummary(props.room.roomName || props.room.roomId, props.admin));
const botName = computed(() => {
  const label = INVITE_BOT_PLATFORMS.find((choice) => choice.id === invite.platform.value)?.label ?? "the bot";
  return label === "Other" ? "your bot" : label;
});

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

function done(): void {
  open.value = false;
  cancelled.value = false;
  cancelError.value = null;
  invite.reset();
}
</script>

<style src="./invite-bot.css"></style>
