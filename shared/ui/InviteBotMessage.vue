<template>
  <!--
    Every bot's message sits in the same grid cell, so the box keeps the
    height of the longest one: picking another bot cross-fades the text and
    never moves the panel. Only the picked one is read by screen readers.
  -->
  <div class="invite-bot-msg" data-testid="invite-bot-message-text" aria-live="polite">
    <div
      v-for="choice in INVITE_BOT_PLATFORMS"
      :key="choice.id"
      class="invite-bot-msg-layer"
      :data-active="choice.id === platform || undefined"
      :aria-hidden="choice.id === platform ? undefined : 'true'"
      :data-platform="choice.id"
    >
      <p class="invite-bot-msg-lead">{{ messages[choice.id].lead }}</p>
      <p class="invite-bot-msg-body"><template v-for="(part, index) in messages[choice.id].parts" :key="index"><span
        v-if="part.kind === 'connector'"
        class="invite-bot-msg-address"
      >{{ part.text }}</span><span
        v-else-if="part.kind === 'code'"
        class="invite-bot-msg-code"
        :data-placeholder="part.placeholder || undefined"
        :title="part.placeholder ? 'Copy makes a one-time code' : undefined"
      ><!-- A new code resolves out of the dots, one letter after another. --><span
        :key="part.text"
        class="invite-bot-msg-code-chars"
        :data-reveal="(!part.placeholder && choice.id === platform) || undefined"
      ><span
        v-for="(char, at) in part.text"
        :key="at"
        class="invite-bot-msg-char"
        :style="{ '--invite-char': at }"
      >{{ char }}</span></span></span><template v-else>{{ part.text }}</template></template></p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import {
  INVITE_BOT_PLATFORMS,
  buildInviteBotCodeMessage,
  type InviteBotCodeMessage,
  type InviteBotPlatform,
} from "./invite-bot";
import "./invite-bot-parts.css";

const props = defineProps<{
  platform: InviteBotPlatform;
  /** The code made for the picked bot, or null (the placeholder shows). */
  code: string | null;
  connectorUrl?: string | null;
}>();

const messages = computed(() => Object.fromEntries(INVITE_BOT_PLATFORMS.map((choice) => [
  choice.id,
  buildInviteBotCodeMessage(choice.id, {
    code: choice.id === props.platform ? props.code : null,
    connectorUrl: props.connectorUrl,
  }),
])) as Record<InviteBotPlatform, InviteBotCodeMessage>);
</script>
