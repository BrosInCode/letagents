<template>
  <section class="agent-live-history" aria-label="Recent requests and results">
    <header><h3>Recent work</h3><span v-if="trace.refreshing" role="status">Refreshing…</span></header>
    <p v-if="trace.state === 'loading'" role="status">Loading recent work…</p>
    <p v-else-if="trace.state === 'unavailable'">Recent work is unavailable in this desktop session.</p>
    <div v-else-if="trace.state === 'error'" role="alert">
      <p>{{ trace.cards.length ? 'Couldn’t refresh recent work.' : 'Couldn’t load recent work.' }}</p>
      <button type="button" @click="emit('retry')">Try again</button>
    </div>
    <p v-else-if="trace.state === 'pruned'">Older details have expired from local history.</p>
    <p v-else-if="trace.state === 'empty'">No requests have been recorded for this agent yet.</p>

    <article v-for="card in trace.cards" :key="card.id" :data-selected="card.selected" class="agent-live-card">
      <header>
        <strong>{{ card.sender }}</strong>
        <time :datetime="card.createdAt || undefined" :title="formatFullTimestamp(card.createdAt)">{{ formatRelativeTime(card.createdAt) }}</time>
      </header>
      <p class="agent-live-request" :data-expanded="card.selected">{{ card.request }}</p>
      <div class="agent-live-result">
        <header><strong>{{ card.outcome }}</strong><time :datetime="card.updatedAt" :title="formatFullTimestamp(card.updatedAt)">{{ formatRelativeTime(card.updatedAt) }}</time></header>
        <p v-if="card.result" :data-expanded="card.selected">{{ card.result }}</p>
        <p v-else-if="card.error">{{ card.error }}</p>
      </div>
      <div class="agent-live-card-actions">
        <button v-if="card.requestMessageId" type="button" @click="emit('reveal', card.requestMessageId)">Open request in Chat</button>
        <button v-if="card.replyMessageId" type="button" @click="emit('reveal', card.replyMessageId)">Open reply in Chat</button>
        <button v-if="!card.selected" type="button" @click="emit('select-source', card.id)">Show details</button>
      </div>
      <details v-if="card.selected" class="agent-live-recorded">
        <summary>Recorded actions</summary>
        <p v-if="trace.state === 'pruned'">These details have expired.</p>
        <p v-else-if="trace.executionState === 'loading'" role="status">Loading recorded actions…</p>
        <template v-else-if="trace.executionState === 'available'">
          <p v-if="trace.incomplete">Some action evidence is missing.</p>
          <p v-if="trace.truncated">Showing the saved selection of actions.</p>
          <p v-if="!trace.turns.length">No individual actions could be verified.</p>
          <div v-for="turn in trace.turns" :key="turn.id">
            <strong>{{ turn.label }}</strong>
            <ol v-if="turn.operations.length"><li v-for="operation in turn.operations" :key="operation.id"><strong>{{ operation.title }}</strong><span v-if="operation.detail">{{ operation.detail }}</span></li></ol>
            <p v-else>No individual actions are included for this turn.</p>
          </div>
        </template>
        <div v-else-if="trace.executionState === 'unavailable'"><p>Recorded actions couldn’t be loaded.</p><button type="button" @click="emit('retry')">Try again</button></div>
        <p v-else-if="trace.executionState === 'not_captured'">No actions were captured. This does not mean the agent did no work.</p>
        <p v-else-if="trace.executionState === 'not_loaded'">No saved actions are available for this request.</p>
        <p v-else>This agent has no recorded action detail.</p>
      </details>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { AgentInspectorWorkResource } from "../../../../domain/agent-inspector-work";
import { agentLiveTrace } from "../../../../domain/agent-inspector-live-trace";
import { formatFullTimestamp, formatRelativeTime } from "../../../../domain/time";
const props = defineProps<{ resource: AgentInspectorWorkResource; selectedSourceMessageId: string | null }>();
const emit = defineEmits<{ retry: []; 'select-source': [sourceMessageId: string]; reveal: [messageId: string] }>();
const trace = computed(() => agentLiveTrace(props.resource, props.selectedSourceMessageId));
</script>

<style scoped>
.agent-live-history { display: grid; gap: 12px; color: var(--text-secondary, #a1a1aa); font-size: 12px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; }
h3, p { margin: 0; }
h3 { color: var(--text, #fafafa); font-size: 13px; }
time, header > span { font-size: 11px; }
.agent-live-card { border: 1px solid rgba(255,255,255,.09); border-radius: 12px; padding: 12px; display: grid; gap: 10px; min-width: 0; }
.agent-live-card[data-selected="true"] { border-color: rgba(96,165,250,.3); }
.agent-live-card strong { font-weight: 600; color: var(--text, #fafafa); }
.agent-live-request, .agent-live-result p { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
[data-expanded="true"] { -webkit-line-clamp: unset !important; max-height: 260px; overflow-y: auto !important; }
.agent-live-result { border-left: 2px solid rgba(96,165,250,.3); padding-left: 10px; display: grid; gap: 6px; }
.agent-live-card-actions { display: flex; flex-wrap: wrap; gap: 8px; }
button { border: 1px solid rgba(255,255,255,.12); border-radius: 6px; background: transparent; color: var(--text, #fafafa); padding: 6px 8px; min-height: 44px; font: inherit; cursor: pointer; }
button:active { background: rgba(255,255,255,.12); }
button:focus-visible, summary:focus-visible { outline: 2px solid #60a5fa; outline-offset: 3px; }
summary { cursor: pointer; padding: 12px 0; min-height: 44px; box-sizing: border-box; }
.agent-live-recorded > p, .agent-live-recorded > div { margin-top: 10px; }
ol { padding-left: 18px; display: grid; gap: 8px; }
li span { display: block; margin-top: 3px; }
@media (hover:hover) and (pointer:fine) { button:hover { background: rgba(255,255,255,.07); } }
</style>
