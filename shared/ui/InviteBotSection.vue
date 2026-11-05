<template>
  <div class="invite-bot" data-testid="invite-bot-section">
    <button
      v-if="!invite.open.value"
      type="button"
      class="invite-bot-button"
      data-variant="primary"
      data-testid="invite-bot-open"
      @click="invite.show()"
    >
      Invite a bot
    </button>

    <template v-else>
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

      <div v-if="invite.platform.value" class="invite-bot-message" data-testid="invite-bot-message">
        <pre class="invite-bot-text" data-testid="invite-bot-text">{{ invite.message.value }}</pre>
        <div class="invite-bot-actions">
          <button
            type="button"
            class="invite-bot-button"
            data-variant="primary"
            data-testid="invite-bot-copy"
            :data-copied="invite.copied.value"
            @click="invite.copy()"
          >
            {{ invite.copied.value ? "Copied" : "Copy" }}
          </button>
          <button type="button" class="invite-bot-button" @click="invite.close()">Done</button>
        </div>
        <p v-if="invite.copyError.value" class="invite-bot-error" role="alert">{{ invite.copyError.value }}</p>
        <p class="invite-bot-hint">{{ INVITE_BOT_HINT }}</p>
        <p v-if="!room.gitRoom" class="invite-bot-hint" data-testid="invite-bot-approve-hint">{{ INVITE_BOT_APPROVE_HINT }}</p>
      </div>
      <p v-else class="invite-bot-hint">Pick the bot the message is for.</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { toRef } from "vue";

import {
  INVITE_BOT_APPROVE_HINT,
  INVITE_BOT_HINT,
  INVITE_BOT_PLATFORMS,
  type InviteBotPlatform,
  type InviteBotRoom,
  useInviteBot,
} from "./invite-bot";

const props = withDefaults(defineProps<{
  room: InviteBotRoom;
  /** Start with this bot picked (deep links and tests). */
  initialPlatform?: InviteBotPlatform | null;
}>(), { initialPlatform: null });

const invite = useInviteBot({ room: toRef(props, "room"), initialPlatform: props.initialPlatform });
</script>

<style src="./invite-bot.css"></style>
