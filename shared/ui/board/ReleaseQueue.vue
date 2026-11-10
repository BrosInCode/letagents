<template>
  <section class="release-queue" aria-label="Work waiting for release">
    <p v-if="unavailable" class="release-notice" role="status">Some ticket data is unavailable. This list may be incomplete. Check the tracker connection in Connectors.</p>
    <p class="release-context">{{ description }}</p>
    <p v-if="!items.length" class="release-empty">{{ unavailable ? 'Release status is unavailable.' : 'Nothing waiting for release.' }}</p>
    <ul v-else class="release-list">
      <li v-for="item in items" :key="item.taskId" class="release-item">
        <div class="release-item-main"><button type="button" class="release-title" @click="emit('select', item.taskId)">{{ item.title }}</button>
          <div class="release-prs"><a v-for="pr in item.pullRequests.filter(pr => safeWorkUrl(pr.url))" :key="pr.url" :href="safeWorkUrl(pr.url)!" target="_blank" rel="noopener noreferrer" :aria-label="`Open pull request ${pr.number || prNumber(pr.url)}`" @click.prevent="emit('external', pr.url)"><BoardIcon name="pr" />#{{ pr.number || prNumber(pr.url) }}<BoardIcon name="external" /></a></div>
        </div>
        <div class="release-item-meta"><a v-if="item.ticketKey && safeWorkUrl(item.ticketUrl)" :href="safeWorkUrl(item.ticketUrl)!" target="_blank" rel="noopener noreferrer" @click.prevent="emit('external', item.ticketUrl!)">{{ item.ticketKey }}<BoardIcon name="external" /></a><button v-else type="button" @click="emit('select', item.taskId)">{{ item.taskId.replace('task_', 'T') }}</button><span v-if="item.owner">{{ item.owner }}</span></div>
        <div v-if="exceptions(item).length" class="release-exceptions"><span v-for="note in exceptions(item)" :key="note">{{ note }}</span></div>
      </li>
    </ul>
    <p v-if="oldestCheck" class="release-freshness">Tracker data checked {{ oldestCheck }}. PR details reflect recorded GitHub activity.</p>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { BoardReleaseItem } from '../../board-planning.mjs';
import { safeWorkUrl } from '../my-work/model';
import BoardIcon from './BoardIcon.vue';
import './release-queue.css';
const props = defineProps<{ items: BoardReleaseItem[]; unavailable: number; description: string }>();
const emit = defineEmits<{ select: [id: string]; external: [url: string] }>();
function prNumber(url: string) { return /\/pull\/(\d+)/.exec(url)?.[1] || 'PR'; }
function exceptions(item: BoardReleaseItem) {
  const prs = item.pullRequests.filter(pr => safeWorkUrl(pr.url));
  if (!prs.length) return ['No PR linked'];
  return [...new Set(prs.flatMap(pr => [
    ...(pr.check_summary?.failure ? ['Checks failed'] : []),
    ...(pr.merged || pr.state === 'merged' ? [] : pr.draft || pr.state === 'draft' ? ['Draft PR'] : pr.state === 'open' ? ['PR still open'] : pr.state === 'closed' ? ['PR closed without merging'] : ['PR status unavailable']),
  ]))];
}
const oldestCheck = computed(() => {
  const dates = props.items.map(i => Date.parse(i.checkedAt || '')).filter(Number.isFinite);
  return dates.length ? new Date(Math.min(...dates)).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
});
</script>
