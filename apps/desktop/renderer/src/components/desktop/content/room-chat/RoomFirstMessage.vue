<template>
  <article class="room-first-message" :style="styling.styleFor('self')" :data-testid="`room-first-message-${agent.id}`" :aria-label="`First message to ${name}`">
    <div class="room-first-message-meta">
      <span>You</span><ArrowRight :size="12" aria-hidden="true" />
      <button v-if="launchHost?.openAgent" type="button" class="room-first-message-agent" @click="launchHost.openAgent(agent.id)">
        <AgentAvatar :avatar="agent.avatar" :name="name" :size="21" /><strong>{{ name }}</strong>
      </button>
      <span v-else class="room-first-message-agent"><AgentAvatar :avatar="agent.avatar" :name="name" :size="21" /><strong>{{ name }}</strong></span>
      <time :datetime="agent.createdAt">{{ time }}</time>
    </div>
    <div class="room-first-message-bubble">
      <p :id="textId" class="room-first-message-text" :class="{ 'is-collapsed': longMessage && !expanded }">{{ agent.charter.trim() }}</p>
      <button v-if="longMessage" type="button" class="room-first-message-more" :aria-expanded="expanded" :aria-controls="textId" @click="expanded = !expanded">
        {{ expanded ? 'Show less' : 'Read more' }}<ChevronDown :size="13" :class="{ expanded }" aria-hidden="true" />
      </button>
    </div>
    <span class="room-first-message-private" title="Sent directly to this agent. Other people in the room cannot see this message."><LockKeyhole :size="11" aria-hidden="true" />First message · Only you</span>
    <div v-if="failedReceipt" class="room-first-message-outcome" role="status" data-testid="room-first-message-failure">
      <CircleAlert :size="14" aria-hidden="true" />
      <div><strong>First message did not finish</strong><p>{{ failureDetail }}</p>
        <button v-if="launchHost?.openFirstMessageWork" type="button" data-testid="room-first-message-details" @click="launchHost.openFirstMessageWork(agent.id)">View details<ArrowRight :size="12" aria-hidden="true" /></button>
      </div>
    </div>
  </article>
</template>
<script setup lang="ts">
import { useChatStyling } from '../../../../../../../../shared/ui/chat-styling';
import { computed, inject, ref } from 'vue';
import { ArrowRight, ChevronDown, CircleAlert, LockKeyhole } from '@lucide/vue';
import AgentAvatar from '../../../../../../../../shared/ui/agent-identity/AgentAvatar.vue';
import type { DesktopSupervisorManifestEntry } from '../../../../../../electron/ipc-types';
import { formatDate } from '../../../../domain/formatters';
import { composerAgentLaunchKey } from './composer-agent-launch';
import { safeUserVisibleErrorDetail } from '../../../../domain/user-visible-error';
import { failedFirstAgentMessage } from '../../../../domain/room-message-receipts';
const props = defineProps<{ agent: DesktopSupervisorManifestEntry }>();
const styling = useChatStyling();
const launchHost = inject(composerAgentLaunchKey, null);
const expanded = ref(false);
const name = computed(() => props.agent.displayName?.trim() || 'the new agent');
const time = computed(() => formatDate('hourMinute', props.agent.createdAt));
const textId = computed(() => `first-message-text-${props.agent.id}`);
const longMessage = computed(() => props.agent.charter.trim().length > 420 || props.agent.charter.trim().split('\n').length > 6);
const failedReceipt = computed(() => failedFirstAgentMessage(props.agent));
const failureDetail = computed(() => safeUserVisibleErrorDetail(failedReceipt.value?.error, 'The agent did not complete this ask. Open its recorded outcome for details.'));
</script>
<style scoped>
.room-first-message{display:grid;gap:7px;width:fit-content;max-width:min(100%,66ch);margin:12px 0 12px auto;padding:0;border:0;border-radius:0;background:transparent}
.room-first-message-meta{display:flex;align-items:center;justify-content:flex-end;gap:6px;color:var(--text-tertiary);font-size:12px;line-height:1.4}
.room-first-message-agent{display:inline-flex;align-items:center;gap:5px;max-width:65%;padding:0;border:0;background:transparent;color:var(--text-secondary);font:inherit}
button.room-first-message-agent{cursor:pointer}.room-first-message-agent strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550}
button.room-first-message-agent:hover strong{text-decoration:underline;text-underline-offset:3px}
.room-first-message-meta time{margin-left:5px;font-variant-numeric:tabular-nums}
.room-first-message-bubble{padding:11px 16px;border-radius:22px 22px 6px 22px;background:linear-gradient(125deg,var(--chat-bubble-start),var(--chat-bubble) 48%,var(--chat-bubble-end));color:var(--chat-foreground)}
.room-first-message-text{margin:0;color:inherit;font-size:14px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}
.room-first-message-text.is-collapsed{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:6;overflow:hidden}
.room-first-message-more{display:flex;align-items:center;gap:7px;margin-top:11px;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:550;cursor:pointer}
.room-first-message-more svg{transition:transform 180ms ease}.room-first-message-more svg.expanded{transform:rotate(180deg)}
.room-first-message-private{display:flex;align-items:center;justify-content:flex-end;gap:5px;color:var(--text-tertiary);font-size:10px;line-height:1.4}.room-first-message-private::before{content:none}
.room-first-message-outcome{display:flex;align-items:flex-start;gap:8px;justify-self:end;max-width:100%;padding:5px 2px;color:var(--text-secondary);font-size:12px;line-height:1.5}
.room-first-message-outcome>svg{flex:none;margin-top:2px;color:var(--orange,#d9a66b)}
.room-first-message-outcome strong{font-weight:550;color:var(--text-primary)}
.room-first-message-outcome p{margin:3px 0 0;overflow-wrap:anywhere}
.room-first-message-outcome button{display:inline-flex;align-items:center;gap:5px;margin-top:5px;padding:0;border:0;background:none;color:var(--text-primary);font:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.room-first-message button:focus-visible{outline:2px solid var(--blue);outline-offset:4px;border-radius:4px}
@media(prefers-reduced-motion:reduce){.room-first-message-more svg{transition:none}}
</style>
