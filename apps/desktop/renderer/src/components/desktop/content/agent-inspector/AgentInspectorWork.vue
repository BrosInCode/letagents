<template>
  <div class="agent-inspector-work">
    <p v-if="resource.status === 'loading' && !resource.detail" class="agent-inspector-work-note" role="status">Loading retained work…</p>
    <section v-else-if="resource.status === 'unavailable'" class="agent-inspector-work-note">
      <strong>Work history is unavailable in this desktop session.</strong>
      <p>This supervisor does not support retained agent work detail yet. Update the desktop supervisor and try again.</p>
    </section>
    <section v-else-if="resource.status === 'error' && !resource.detail" class="agent-inspector-work-note" role="alert">
      <strong>Couldn’t load retained work.</strong><p>{{ resource.error || 'Try again when the supervisor is reachable.' }}</p>
      <button type="button" @click="emit('retry')">Retry</button>
    </section>

    <template v-else>
      <div v-if="resource.status === 'refreshing'" class="agent-inspector-work-refresh" role="status">Refreshing retained work…</div>
      <section v-if="resource.status === 'error'" class="agent-inspector-work-note" role="status"><strong>Couldn’t refresh retained work.</strong><p>{{ resource.error || 'Showing the last retained work detail.' }}</p><button type="button" @click="emit('retry')">Retry</button></section>
      <div class="agent-inspector-work-layout">
        <nav class="agent-inspector-work-list" aria-label="Recent agent work">
          <p class="agent-inspector-work-list-label">Recent work</p>
          <button
            v-for="item in detail?.items || []" :key="item.source_message_id" type="button"
            :class="{ selected: selectedSourceMessageId === item.source_message_id }"
            :aria-current="selectedSourceMessageId === item.source_message_id ? 'true' : undefined"
            @click="emit('select-source', item.source_message_id)"
          >
            <span class="agent-inspector-work-item-state" :data-state="item.state" aria-hidden="true"></span>
            <span><strong>{{ humanizeAgentInspectorReceiptState(item.state, item.terminal_reason) }}</strong><small>{{ item.text_preview || 'Message content is unavailable.' }} · {{ formatRelativeTime(item.updated_at) }}</small></span>
          </button>
          <p v-if="!detail?.items.length" class="agent-inspector-work-empty">No retained activated work is available for this agent in this room.</p>
        </nav>

        <div class="agent-inspector-work-detail">
          <section v-if="detail?.uncertain_effects.length" class="agent-inspector-work-note" role="status">
            <strong>Some mutating tool outcomes need verification.</strong>
            <p v-for="effect in detail.uncertain_effects" :key="effect.effect_id">{{ describeAgentInspectorUncertainEffect(effect.tool_name) }}</p>
          </section>
          <section v-if="detail?.availability === 'pruned'" class="agent-inspector-work-note"><strong>Older detail was removed by local retention.</strong><p>This item is outside the retained local work history.</p></section>
          <section v-else-if="detail?.availability === 'not_loaded'" class="agent-inspector-work-note"><strong>No retained activated work for this message.</strong><p>This message was observed but did not create retained activated work, or no exact evidence is loaded.</p></section>
          <template v-else-if="detail?.availability === 'available'">
            <section class="agent-inspector-work-section">
              <p class="agent-inspector-work-eyebrow">Activated by</p>
              <strong>{{ detail.source_message?.sender || 'Room message' }}</strong>
              <p>{{ detail.source_message?.text || 'The retained message text is unavailable.' }}</p>
              <small>{{ formatFullTimestamp(detail.source_message?.created_at) }}<template v-if="detail.source_message?.thread_root_id"> · In a message thread</template></small>
            </section>
            <section class="agent-inspector-work-section">
              <p class="agent-inspector-work-eyebrow">Receipt and outcome</p>
              <strong>{{ detail.receipt ? humanizeAgentInspectorReceiptState(detail.receipt.state, detail.receipt.terminal_reason) : 'No receipt retained' }}</strong>
              <p v-if="detail.terminal?.normalized_text">{{ detail.terminal.normalized_text }}</p>
              <p v-else-if="detail.receipt?.outcome?.text">{{ detail.receipt.outcome.text }}</p>
              <p v-else>{{ detail.receipt?.terminal_reason === 'upgrade_authority_unavailable'
                ? 'A safety upgrade retired this legacy turn because its exact authority could not be reconstructed. The outcome is unknown, and LetAgents did not replay provider work.'
                : detail.receipt?.failure_code === 'provider_continuation_missing'
                ? 'The saved Codex conversation is unavailable. No model turn was started.'
                : detail.receipt?.last_error || 'No terminal outcome is retained.' }}</p>
            </section>
            <section class="agent-inspector-work-section">
              <p class="agent-inspector-work-eyebrow">Recorded execution</p>
              <template v-if="execution?.availability === 'available'">
                <p>Saved observations, not live status. The receipt above describes the overall work outcome.</p>
                <p v-if="execution.evidenceIncomplete" role="status">Some execution evidence is missing or could not be verified. This is not a complete account of the work.</p>
                <p v-if="execution.truncated" role="status">Showing a bounded selection of recorded turns and operations.</p>
                <p v-if="!recordedTurns.length">No individual turns could be verified from the retained evidence.</p>
                <details v-for="(turn, index) in recordedTurns" :key="turn.turnId" :open="index === 0" class="agent-inspector-work-execution">
                  <summary>{{ humanizeRecordedTurn(turn) }} · {{ turn.operations.length }} {{ turn.operations.length === 1 ? 'operation' : 'operations' }} shown</summary>
                  <ol v-if="turn.operations.length" class="agent-inspector-work-timeline">
                    <li v-for="operation in turn.operations" :key="operation.executionId">
                      <strong>{{ operation.presentation.title }}</strong>
                      <span v-if="operation.presentation.detail">{{ operation.presentation.detail }}</span>
                    </li>
                  </ol>
                  <p v-else class="agent-inspector-work-empty">No individual operations are included for this turn.</p>
                </details>
              </template>
              <template v-else-if="execution?.availability === 'unavailable'">
                <p>Recorded execution could not be loaded. Delivery receipts are still available above.</p>
                <button type="button" @click="emit('retry')">Retry</button>
              </template>
              <p v-else-if="execution?.availability === 'not_captured'">No execution evidence was captured for this message. This does not mean the agent did no work.</p>
              <p v-else>This supervisor does not provide recorded execution detail.</p>
            </section>
            <section v-if="detail.publication" class="agent-inspector-work-section">
              <p class="agent-inspector-work-eyebrow">Published reply</p>
              <p>{{ detail.publication.canonical_message_id ? 'A room reply was published.' : 'Publication was recorded, but no canonical room message is available.' }}</p>
              <button v-if="detail.publication.canonical_message_id" type="button" @click="emit('reveal', detail.publication.canonical_message_id)">Open reply in Chat</button>
            </section>
            <section class="agent-inspector-work-section">
              <p class="agent-inspector-work-eyebrow">Current task{{ tasks.length === 1 ? '' : 's' }}</p>
              <p v-if="tasks.length" v-for="task in tasks" :key="task.id"><strong>{{ task.title }}</strong> · {{ task.status }}</p>
              <p v-else>No task is currently linked to this agent.</p>
            </section>
            <section v-if="artifacts.length" class="agent-inspector-work-section">
              <p class="agent-inspector-work-eyebrow">Task-linked artifacts</p>
              <p v-for="item in artifacts" :key="item.artifact.identityKey"><strong>{{ item.title }}</strong><span v-if="item.metaLabel"> · {{ item.metaLabel }}</span></p>
            </section>
            <section class="agent-inspector-work-section">
              <p class="agent-inspector-work-eyebrow">Causal timeline</p>
              <ol class="agent-inspector-work-timeline"><li v-for="event in detail.timeline" :key="`${event.observedAt}-${event.phase}`"><strong>{{ humanizeAgentInspectorTimeline(event) }}</strong><span>{{ event.detail || formatFullTimestamp(event.observedAt) }}</span></li></ol>
            </section>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopTaskSummary } from "../../../../../../electron/ipc-types";
import type { RoomArtifactTimelineItem } from "../../../../domain/room-artifacts";
import { formatFullTimestamp, formatRelativeTime } from "../../../../domain/time";
import { describeAgentInspectorUncertainEffect, describeRecordedOperation, humanizeRecordedTurn, humanizeAgentInspectorReceiptState, humanizeAgentInspectorTimeline, type AgentInspectorWorkResource } from "../../../../domain/agent-inspector-work";

const props = defineProps<{ resource: AgentInspectorWorkResource; selectedSourceMessageId: string | null; tasks: readonly Pick<DesktopTaskSummary, 'id' | 'title' | 'status'>[]; artifacts: readonly RoomArtifactTimelineItem[] }>();
const emit = defineEmits<{ retry: []; 'select-source': [sourceMessageId: string]; reveal: [canonicalMessageId: string] }>();
const detail = computed(() => props.resource.detail);
const execution = computed(() => detail.value?.recorded_execution);
const recordedTurns = computed(() => execution.value?.availability === "available"
  ? execution.value.turns.map((turn) => ({ ...turn, operations: turn.operations.map((row) => ({ ...row, presentation: describeRecordedOperation(row) })) }))
  : []);
</script>
