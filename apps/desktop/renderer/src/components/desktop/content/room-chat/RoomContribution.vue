<template>
  <article class="room-contribution" v-if="changes" aria-label="Agent contribution">
    <span class="room-contribution-mark" aria-hidden="true"><FileDiff :size="17" /></span>
    <div class="room-contribution-body">
      <div class="room-contribution-byline">
        <div class="room-contribution-identity">
          <button type="button" @click="emit('open-workspace', work)">{{ identity.displayName }}</button>
          <span v-if="identity.ownerAttribution">{{ identity.ownerAttribution }}</span>
        </div>
        <time :datetime="changes.captured_at" :title="formatFullTimestamp(changes.captured_at)">{{ formatShortDateTime(changes.captured_at) }}</time>
      </div>
      <ContributionDescription :work="work" />
      <button class="room-contribution-review" type="button" @click="emit('open-workspace', work)"><span>{{ changes.state === 'ready' ? `Review ${count} ${count === 1 ? 'file' : 'files'}` : 'View workspace' }}</span><span v-if="changes.state === 'ready'" class="room-contribution-counts"><b>+{{ changes.additions }}</b><b>−{{ changes.deletions }}</b></span><ChevronRight :size="14" aria-hidden="true" /></button>
      <span v-if="status !== 'ready'" class="room-contribution-unavailable">Updates unavailable</span>
    </div>
  </article>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import ContributionDescription from './ContributionDescription.vue';
import { FileDiff, ChevronRight } from '@lucide/vue';
import type { DesktopRoomAgentWork, DesktopParticipantSummary } from '../../../../../../electron/ipc-types';
import { contributionChanges, workspaceAgentTarget } from '../../../../domain/room-contributions';
import { formatFullTimestamp, formatShortDateTime } from '../../../../domain/time';
const props = defineProps<{ work: DesktopRoomAgentWork; participants: readonly DesktopParticipantSummary[]; status: string }>();
const emit = defineEmits<{ 'open-workspace': [work: DesktopRoomAgentWork] }>();
const changes = computed(() => contributionChanges(props.work));
const count = computed(() => (changes.value?.files.length ?? 0) + (changes.value?.hidden_files ?? 0));
const identity = computed(() => workspaceAgentTarget(props.work, props.participants));
</script>
<style scoped>
.room-contribution { display: flex; gap: 12px; width: min(100%, 760px); margin: 18px auto 24px; padding: 0 16px; box-sizing: border-box; color: var(--text); }
.room-contribution-mark { display: grid; place-items: center; width: 30px; height: 30px; flex-shrink: 0; border: 1px solid var(--border); border-radius: 9px; color: var(--text-secondary); }
.room-contribution-body { min-width: 0; flex: 1; }
.room-contribution-byline { display: flex; align-items: flex-start; gap: 16px; color: var(--text-secondary); }
.room-contribution-identity { display: grid; gap: 2px; min-width: 0; }
.room-contribution-identity span { font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
.room-contribution-byline button { background: none; border: 0; padding: 0; color: var(--text); font: inherit; font-size: 14px; line-height: 1.4; font-weight: 650; cursor: pointer; text-align: left; overflow-wrap: anywhere; }
.room-contribution-byline time { margin-left: auto; padding-top: 2px; font-size: 10px; line-height: 1.5; flex-shrink: 0; }
.room-contribution-review { display: inline-flex; align-items: center; gap: 10px; min-height: 34px; border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; background: var(--bg-card); color: var(--text); font: inherit; font-size: 11px; cursor: pointer; transition: background 140ms ease; }
.room-contribution-counts { display: inline-flex; gap: 7px; font-variant-numeric: tabular-nums; }
.room-contribution-counts b { font-weight: 500; color: light-dark(#167544, #88d9a2); }
.room-contribution-counts b + b { color: light-dark(#bd3548, #ef9ba5); }
.room-contribution-unavailable { display: block; margin-top: 7px; font-size: 10px; color: var(--text-secondary); }
button:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
button:active { background: var(--accent-active); }
@media (hover: hover) { button:hover { background: var(--accent-hover); } }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
