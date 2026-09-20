<template>
  <div class="agent-inspector-work">
    <p v-if="resource.status === 'loading' && !resource.detail" class="agent-inspector-work-note" role="status">Loading work history…</p>
    <section v-else-if="resource.status === 'unavailable'" class="agent-inspector-work-note">
      <strong>Work history is unavailable in this desktop session.</strong>
      <p>Update LetAgents to view this agent’s work history.</p>
    </section>
    <section v-else-if="resource.status === 'error' && !resource.detail" class="agent-inspector-work-note" role="alert">
      <strong>Couldn’t load work history.</strong><p>{{ resource.error || 'Check the connection and try again.' }}</p>
      <button type="button" @click="emit('retry')">Retry</button>
    </section>

    <template v-else>
      <div v-if="resource.status === 'refreshing'" class="agent-inspector-work-refresh" role="status">Refreshing work history…</div>
      <section v-if="resource.status === 'error'" class="agent-inspector-work-note" role="status"><strong>Couldn’t refresh work history.</strong><p>{{ resource.error || 'Showing the last available work history.' }}</p><button type="button" @click="emit('retry')">Retry</button></section>
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
          <p v-if="!detail?.items.length" class="agent-inspector-work-empty">No work history is available for this agent in this room.</p>
        </nav>

        <div class="agent-inspector-work-detail">
          <section v-if="detail?.uncertain_effects.length" class="agent-inspector-work-note" role="status">
            <strong>Some changes could not be confirmed. Review them before trying again.</strong>
            <p v-for="effect in detail.uncertain_effects" :key="effect.effect_id">{{ describeAgentInspectorUncertainEffect(effect.tool_name) }}</p>
          </section>
          <section v-if="detail?.availability === 'pruned'" class="agent-inspector-work-note"><strong>Older history has been removed.</strong><p>This item is no longer in the saved work history.</p></section>
          <section v-else-if="detail?.availability === 'not_loaded'" class="agent-inspector-work-note"><strong>No work history is available for this message.</strong><p>The agent may not have acted on this message, or its work history may be unavailable.</p></section>
          <template v-else-if="detail?.availability === 'available'">
            <section class="agent-inspector-work-section">
              <p class="agent-inspector-work-eyebrow">Requested by</p>
              <strong>{{ detail.source_message?.sender || 'Room message' }}</strong>
              <p>{{ detail.source_message?.text || 'The original message is unavailable.' }}</p>
              <small>{{ formatFullTimestamp(detail.source_message?.created_at) }}<template v-if="detail.source_message?.thread_root_id"> · In a message thread</template></small>
            </section>
            <section class="agent-inspector-work-section">
              <p class="agent-inspector-work-eyebrow">Result</p>
              <strong>{{ detail.receipt ? humanizeAgentInspectorReceiptState(detail.receipt.state, detail.receipt.terminal_reason) : 'No result saved' }}</strong>
              <p v-if="detail.terminal?.normalized_text">{{ detail.terminal.normalized_text }}</p>
              <p v-else-if="detail.receipt?.outcome?.text">{{ detail.receipt.outcome.text }}</p>
              <p v-else>{{ detail.receipt?.terminal_reason === 'upgrade_authority_unavailable'
                ? 'An update ended this work because LetAgents could not safely reconnect to it. The result is unknown. The work was not repeated.'
                : detail.receipt?.failure_code === 'provider_continuation_missing'
                ? 'The saved Codex conversation is unavailable. The agent did not start this request.'
                : detail.receipt?.last_error || 'No final result is available.' }}</p>
            </section>
            <section class="agent-inspector-work-section">
              <p class="agent-inspector-work-eyebrow">Work details</p>
              <template v-if="execution?.availability === 'available'">
                <p>Saved activity for this request. See the result above for its outcome.</p>
                <p v-if="execution.evidenceIncomplete" role="status">Some activity is missing or could not be confirmed. This history may be incomplete.</p>
                <p v-if="execution.truncated" role="status">Showing part of the saved activity.</p>
                <p v-if="!recordedTurns.length">Detailed activity could not be confirmed.</p>
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
                <p>Work details could not be loaded. The result is still available above.</p>
                <button type="button" @click="emit('retry')">Retry</button>
              </template>
              <p v-else-if="execution?.availability === 'not_captured'">No activity was saved for this message. The agent may still have worked on it.</p>
              <p v-else>Work details are unavailable in this version of LetAgents.</p>
            </section>
            <section v-if="detail.publication" class="agent-inspector-work-section">
              <p class="agent-inspector-work-eyebrow">Published reply</p>
              <p>{{ detail.publication.canonical_message_id ? 'A room reply was published.' : 'The reply was recorded, but its room message is unavailable.' }}</p>
              <button v-if="detail.publication.canonical_message_id" type="button" @click="emit('reveal', detail.publication.canonical_message_id)">Open reply in Chat</button>
            </section>
            <section class="agent-inspector-work-section">
              <p class="agent-inspector-work-eyebrow">Current task{{ tasks.length === 1 ? '' : 's' }}</p>
              <p v-if="tasks.length" v-for="task in tasks" :key="task.id"><strong>{{ task.title }}</strong> · {{ task.status }}</p>
              <p v-else>No task is currently linked to this agent.</p>
            </section>
            <section v-if="artifacts.length" class="agent-inspector-work-section">
              <p class="agent-inspector-work-eyebrow">Related work</p>
              <p v-for="item in artifacts" :key="item.artifact.identityKey"><strong>{{ item.title }}</strong><span v-if="item.metaLabel"> · {{ item.metaLabel }}</span></p>
            </section>
            <section class="agent-inspector-work-section">
              <p class="agent-inspector-work-eyebrow">Activity timeline</p>
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
