<template>
  <article class="room-contribution" v-if="changes" :data-chat-role="senderRole" :aria-label="changes.state === 'ready' ? 'Agent contribution' : 'Workspace snapshot'">
    <div class="room-contribution-byline">
      <span>{{ identity.displayName }}</span>
      <span v-if="identity.ownerAttribution">{{ identity.ownerAttribution }}</span>
      <time :datetime="snapshotTimestamp" :title="formatFullTimestamp(snapshotTimestamp)">{{ formatShortDateTime(snapshotTimestamp) }}</time>
    </div>
    <div class="room-contribution-body">
      <button class="room-contribution-review" type="button" @click="openReview()">
        <FileDiff :size="17" aria-hidden="true" />
        <span>{{ changes.state === 'ready' ? `${count} ${count === 1 ? 'file' : 'files'} changed` : 'View workspace' }}</span>
        <span v-if="changes.state === 'ready'" class="room-contribution-counts"><b>+{{ changes.additions }}</b><b>−{{ changes.deletions }}</b></span>
        <ChevronRight :size="14" aria-hidden="true" />
      </button>
      <p v-if="changes.state !== 'ready'" class="room-contribution-unavailable">Changes from this turn are unavailable.</p>
      <ContributionDescription :work="work" file-reviews @review-file="openReview" />
    </div>
    <span v-if="status !== 'ready'" class="room-contribution-unavailable">Updates unavailable</span>
  </article>
</template>
<script setup lang="ts">
import { computed, inject } from 'vue';
import ContributionDescription from './ContributionDescription.vue';
import { FileDiff, ChevronRight } from '@lucide/vue';
import type { DesktopRoomAgentWork, DesktopParticipantSummary, DesktopRoomMessage } from '../../../../../../electron/ipc-types';
import { chatSenderRole } from '../../../../../../../../shared/chat-appearance';
import { useMessageViewer } from '../../../../composables/useRoomMessageReactions';
import { isOwnedLocalRoomAgent, supervisorEntriesKey } from '../add-agent/supervisor-entries-context';
import type { AgentModalTarget } from '../desktop-chat-message/types';
import { contributionChanges, workspaceAgentTarget } from '../../../../domain/room-contributions';
import { formatFullTimestamp, formatShortDateTime } from '../../../../domain/time';
const props = defineProps<{ work: DesktopRoomAgentWork; sourceMessage?: DesktopRoomMessage; participants: readonly DesktopParticipantSummary[]; status: string }>();
const emit = defineEmits<{ 'open-workspace': [target: AgentModalTarget] }>();
const changes = computed(() => contributionChanges(props.work));
const snapshotTimestamp = computed(() => changes.value?.state === 'ready'
  ? changes.value.captured_at
  : ('workspace' in props.work.summary ? props.work.summary.workspace?.captured_at : null) ?? changes.value!.captured_at);
const count = computed(() => (changes.value?.files.length ?? 0) + (changes.value?.hidden_files ?? 0));
const identity = computed(() => workspaceAgentTarget(props.work, props.participants, props.sourceMessage));
const viewer = useMessageViewer();
const supervisorEntries = inject(supervisorEntriesKey, null);
const senderRole = computed(() => chatSenderRole({
  human: false,
  agent: true,
  agentKey: props.work.agentKey,
  viewerLogin: viewer.value?.login,
  ownedLocalAgent: isOwnedLocalRoomAgent(props.work.roomId, props.work.agentKey, supervisorEntries?.entries.value),
}));
function openReview(path?: string) {
  emit('open-workspace', { ...identity.value, workspaceFilePath: path });
}
</script>
<style scoped>
.room-contribution {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  justify-items: start;
  gap: 7px;
  box-sizing: border-box;
  width: min(100%, var(--room-chat-content-max, 100%));
  margin: 12px auto 20px;
  padding-inline-start: var(--room-message-avatar-space);
  color: var(--text);
}
.room-contribution[data-chat-role="own-agent"] {
  justify-items: end;
  padding-inline-start: 0;
  padding-inline-end: var(--room-message-avatar-space);
}
.room-contribution > :is(.room-contribution-byline, .room-contribution-body) {
  box-sizing: border-box;
  width: min(100%, var(--room-message-bubble-max));
  min-width: 0;
}
.room-contribution-body { border: 1px solid var(--border); border-radius: 12px; background: var(--bg-card); }
.room-contribution-byline { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 9px; color: var(--text-secondary); font-size: .6875rem; }
.room-contribution-byline > span:first-child { color: var(--text); font-size: .75rem; font-weight: 600; }
.room-contribution-byline time { margin-inline-start: auto; }
.room-contribution-review {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 44px;
  padding: 8px 16px;
  border: 0;
  border-radius: 11px 11px 0 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: .8125rem;
  font-weight: 550;
  text-align: start;
  cursor: pointer;
}
.room-contribution-review svg { flex: none; color: var(--text-secondary); }
.room-contribution-counts { display: inline-flex; gap: 7px; margin-inline-start: auto; font-size: .75rem; font-variant-numeric: tabular-nums; }
.room-contribution-counts b { font-weight: 500; color: light-dark(#167544, #88d9a2); }
.room-contribution-counts b + b { color: light-dark(#bd3548, #ef9ba5); }
.room-contribution-unavailable { margin: 6px 16px 10px; font-size: .75rem; color: var(--text-secondary); }
button:focus-visible { outline: 2px solid var(--blue-text); outline-offset: -2px; }
button:active { background: var(--accent-active); }
@media (hover: hover) and (pointer: fine) { button:hover { background: var(--accent-hover); } }
</style>
