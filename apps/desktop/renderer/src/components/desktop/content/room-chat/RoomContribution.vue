<template>
  <article class="room-contribution" v-if="changes" :aria-label="changes.state === 'ready' ? 'Agent contribution' : 'Workspace snapshot'">
    <span class="room-contribution-mark" aria-hidden="true"><FileDiff :size="17" /></span>
    <div class="room-contribution-body">
      <div class="room-contribution-byline">
        <div class="room-contribution-identity">
          <button type="button" @click="emit('open-workspace', work)">{{ identity.displayName }}</button>
          <span v-if="identity.ownerAttribution">{{ identity.ownerAttribution }}</span>
        </div>
        <time :datetime="snapshotTimestamp" :title="formatFullTimestamp(snapshotTimestamp)">{{ formatShortDateTime(snapshotTimestamp) }}</time>
      </div>
      <p v-if="changes.state !== 'ready'" class="room-contribution-unavailable">Workspace snapshot · Changes from this turn are unavailable.</p>
      <ContributionDescription :work="work" />
      <button v-if="card?.button" class="room-contribution-review" type="button" @click="emit('open-workspace', work, card.button.path ?? undefined)"><span>{{ card.button.label }}</span><span v-if="card.button.counts" class="room-contribution-counts"><b>+{{ card.button.counts.additions }}</b><b>−{{ card.button.counts.deletions }}</b></span><ChevronRight :size="14" aria-hidden="true" /></button>
      <div v-if="card?.comparison" class="room-contribution-scope">
        <div class="room-contribution-scope-head"><History :size="16" aria-hidden="true" /><span>{{ card.comparison.header }}</span></div>
        <p class="room-contribution-scope-title">{{ card.comparison.title }}</p>
        <p class="room-contribution-scope-line">{{ card.comparison.line }}</p>
        <p class="room-contribution-scope-line room-contribution-scope-unedited">{{ card.comparison.unedited }}</p>
        <button class="room-contribution-review" type="button" @click="emit('open-workspace', work)"><span>Review full comparison</span><span class="room-contribution-counts"><b>+{{ card.comparison.counts.additions }}</b><b>−{{ card.comparison.counts.deletions }}</b></span><ChevronRight :size="14" aria-hidden="true" /></button>
      </div>
      <span v-if="status !== 'ready'" class="room-contribution-unavailable">Updates unavailable</span>
    </div>
  </article>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import ContributionDescription from './ContributionDescription.vue';
import { FileDiff, ChevronRight, History } from '@lucide/vue';
import type { DesktopRoomAgentWork, DesktopParticipantSummary } from '../../../../../../electron/ipc-types';
import { contributionChanges, workspaceAgentTarget } from '../../../../domain/room-contributions';
import { contributionCard } from '../../../../domain/room-contribution-card';
import { formatFullTimestamp, formatShortDateTime } from '../../../../domain/time';
const props = defineProps<{ work: DesktopRoomAgentWork; participants: readonly DesktopParticipantSummary[]; status: string }>();
const emit = defineEmits<{ 'open-workspace': [work: DesktopRoomAgentWork, filePath?: string] }>();
const changes = computed(() => contributionChanges(props.work));
const snapshotTimestamp = computed(() => changes.value?.state === 'ready'
  ? changes.value.captured_at
  : ('workspace' in props.work.summary ? props.work.summary.workspace?.captured_at : null) ?? changes.value!.captured_at);
const card = computed(() => contributionCard(props.work, new Date()));
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
.room-contribution-counts b { font-weight: 500; color: var(--diff-added-text); }
.room-contribution-counts b + b { color: var(--diff-deleted-text); }
.room-contribution-scope { display: grid; gap: 4px; max-width: 520px; margin-top: 4px; padding: 12px 14px; border: 1px solid var(--border-strong); border-radius: 12px; }
.room-contribution-review + .room-contribution-scope { margin-top: 14px; }
.room-contribution-scope-head { display: flex; align-items: center; gap: 8px; color: var(--text-secondary); font-size: 12px; font-weight: 500; line-height: 1.5; }
.room-contribution-scope-head svg { flex: none; color: var(--amber-text); }
.room-contribution-scope-title { margin: 2px 0 0; font-size: 14px; font-weight: 600; line-height: 1.5; font-variant-numeric: tabular-nums; }
.room-contribution-scope-line { margin: 0; font-size: 12px; line-height: 1.55; color: var(--text-secondary); }
.room-contribution-scope-unedited { margin-top: 4px; color: var(--text); font-variant-numeric: tabular-nums; }
.room-contribution-scope .room-contribution-review { margin-top: 8px; justify-self: start; }
.room-contribution-scope .room-contribution-counts b { color: var(--text-secondary); }
.room-contribution-unavailable { display: block; margin-top: 7px; font-size: 10px; color: var(--text-secondary); }
button:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
button:active { background: var(--accent-active); }
@media (hover: hover) { button:hover { background: var(--accent-hover); } }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
