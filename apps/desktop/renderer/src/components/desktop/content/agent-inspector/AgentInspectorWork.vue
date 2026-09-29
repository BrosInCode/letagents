<template>
  <div ref="workElement" tabindex="-1" class="agent-inspector-work message-outcome" data-testid="message-outcome-inspector">
    <div v-if="resource.status === 'loading' && !resource.detail" class="outcome-loading" aria-busy="true" role="status">
      <span>Loading message activity…</span>
      <div v-for="row in 4" :key="row" class="outcome-skeleton" aria-hidden="true"><i /><div><b /><b /></div></div>
    </div>
    <section v-else-if="resource.status === 'unavailable'" class="agent-inspector-work-note">
      <strong>Work history is unavailable in this desktop session.</strong>
      <p>Update LetAgents to view this agent’s work history.</p>
    </section>
    <section v-else-if="resource.status === 'error' && !resource.detail" class="agent-inspector-work-note" role="alert">
      <strong>Couldn’t load message activity.</strong><p>{{ resource.error || 'Check the connection and try again.' }}</p>
      <button type="button" @click="emit('retry')">Retry</button>
    </section>
    <template v-else>
      <div class="outcome-heading"><div><p class="outcome-eyebrow">Message activity</p><h3>From message to outcome</h3></div><span v-if="duration" class="outcome-duration" title="Recorded work duration"><Clock3 :size="13" aria-hidden="true" />{{ duration }}</span></div>
      <details v-if="detail?.items.length" class="outcome-history">
        <summary>Recent messages <span>{{ detail.items.length }}</span><ChevronDown :size="14" aria-hidden="true" /></summary>
        <nav class="outcome-history-list" aria-label="Recent agent work">
          <button v-for="item in detail.items" :key="item.source_message_id" type="button"
            :aria-current="selectedSourceMessageId === item.source_message_id ? 'true' : undefined"
            @click="emit('select-source', item.source_message_id)">
            <span class="outcome-dot" :data-tone="messageOutcomeTone(item.state)" aria-hidden="true" />
            <span><strong>{{ item.text_preview || 'Message content is unavailable.' }}</strong><small>{{ humanizeAgentInspectorReceiptState(item.state, item.terminal_reason) }} · {{ formatRelativeTime(item.updated_at) }}</small></span>
          </button>
        </nav>
      </details>
      <p v-if="resource.status === 'refreshing'" class="outcome-refresh" role="status">Updating activity…</p>
      <section v-if="resource.status === 'error'" class="agent-inspector-work-note" role="status"><strong>Couldn’t refresh activity.</strong><p>{{ resource.error || 'Showing the last recorded activity.' }}</p><button type="button" @click="emit('retry')">Retry</button></section>
      <section v-if="detail?.availability === 'pruned'" class="agent-inspector-work-note"><strong>Older history has been removed.</strong><p>This message is no longer in the saved work history.</p></section>
      <section v-else-if="detail?.availability === 'not_loaded'" class="agent-inspector-work-note"><strong>No work history is available for this message.</strong><p>The agent may not have acted on this message, or its work history may be unavailable.</p></section>
      <template v-else-if="detail?.availability === 'available'">
        <ol :key="detail.inbox_item_id ?? selectedSourceMessageId ?? 'work'" class="outcome-trajectory" aria-label="Message to outcome">
          <li class="outcome-stage" data-tone="active">
            <span class="outcome-marker" aria-hidden="true"><MessageSquare :size="15" /></span>
            <div class="outcome-stage-body">
              <div class="outcome-stage-heading"><h4>Trigger</h4><time v-if="detail.source_message?.created_at" :datetime="detail.source_message.created_at" :title="formatFullTimestamp(detail.source_message.created_at)">{{ timeLabel(detail.source_message.created_at) }}</time></div>
              <p class="outcome-stage-description">{{ messageTriggerLabel(detail.source_message?.activation) }}</p>
              <blockquote class="outcome-message"><strong>{{ detail.source_message?.sender || 'Room message' }}</strong><p>{{ detail.source_message?.text || 'The original message is unavailable.' }}</p></blockquote>
              <button v-if="originalMessageId" type="button" class="outcome-text-button" @click="emit('reveal', originalMessageId)">View original message <ArrowUpRight :size="13" aria-hidden="true" /></button>
            </div>
          </li>
          <li class="outcome-stage" :data-tone="detail.prepared_context ? 'active' : 'neutral'">
            <span class="outcome-marker" aria-hidden="true"><Layers :size="15" /></span>
            <div class="outcome-stage-body">
              <div class="outcome-stage-heading"><h4>Room context</h4><time v-if="detail.prepared_context" :datetime="detail.prepared_context.preparedAt" :title="formatFullTimestamp(detail.prepared_context.preparedAt)">{{ timeLabel(detail.prepared_context.preparedAt) }}</time></div>
              <template v-if="detail.prepared_context">
                <p class="outcome-stage-description">{{ detail.prepared_context.totalMessages }} {{ detail.prepared_context.totalMessages === 1 ? 'message' : 'messages' }} selected when preparing this turn.</p>
                <details v-if="detail.prepared_context.messages.length" class="outcome-evidence">
                  <summary>View captured context <ChevronDown :size="14" aria-hidden="true" /></summary>
                  <ol class="outcome-context-list">
                    <li v-for="(message, index) in detail.prepared_context.messages" :key="index">
                      <div><strong>{{ message.sender || 'Sender unavailable' }}</strong><code v-if="message.id">{{ message.id }}</code></div>
                      <p>{{ message.text ?? 'Message text was not available.' }}</p><small v-if="message.truncated">Text shortened in this snapshot.</small>
                    </li>
                  </ol>
                </details>
                <p v-if="detail.prepared_context.omittedMessages" class="outcome-footnote">{{ detail.prepared_context.omittedMessages }} messages exceed the snapshot limit.</p>
                <p class="outcome-footnote">Text captured before dispatch. Provider prompts, attachment contents, and additional provider context are not included.</p>
              </template>
              <p v-else class="outcome-missing">Context wasn’t captured for this work. Today’s room history cannot establish what the agent received then.</p>
            </div>
          </li>
          <li class="outcome-stage" :data-tone="recordedTurns.length ? 'active' : 'neutral'">
            <span class="outcome-marker" aria-hidden="true"><Activity :size="15" /></span>
            <div class="outcome-stage-body">
              <div class="outcome-stage-heading"><h4>Activity</h4><span v-if="recordedTurns.length" class="outcome-count">{{ operationCount }} operations shown</span></div>
              <template v-if="execution?.availability === 'available'">
                <p class="outcome-footnote">Saved activity for this request. See the result below for its outcome.</p>
                <p v-if="execution.evidenceIncomplete" class="outcome-missing" role="status">Some activity is missing or could not be confirmed. This history may be incomplete.</p>
                <p v-if="execution.truncated" class="outcome-footnote">Showing part of the saved activity.</p>
                <p v-if="!recordedTurns.length" class="outcome-missing">Detailed activity could not be confirmed.</p>
                <details v-for="(turn, index) in recordedTurns" :key="turn.turnId" :open="index === 0" class="outcome-evidence outcome-turn">
                  <summary><span>{{ humanizeRecordedTurn(turn) }}<small>{{ turn.operations.length }} {{ turn.operations.length === 1 ? 'operation' : 'operations' }} shown</small></span><ChevronDown :size="14" aria-hidden="true" /></summary>
                  <ol v-if="turn.operations.length" class="outcome-operations">
                    <li v-for="operation in turn.operations" :key="operation.executionId" :data-failed="operation.outcome === 'failed'">
                      <span class="outcome-dot" aria-hidden="true" /><div><strong>{{ operation.presentation.title }}</strong><p v-if="operation.presentation.detail">{{ operation.presentation.detail }}</p></div>
                    </li>
                  </ol>
                  <p v-else class="outcome-missing">No individual operations are included for this turn.</p>
                </details>
              </template>
              <template v-else-if="execution?.availability === 'unavailable'"><p class="outcome-missing">Work details could not be loaded. The result is still available below.</p><button type="button" class="outcome-text-button" @click="emit('retry')">Retry</button></template>
              <p v-else-if="execution?.availability === 'not_captured'" class="outcome-missing">No activity was saved for this message. The agent may still have worked on it.</p>
              <p v-else class="outcome-missing">Work details are unavailable in this version of LetAgents.</p>
              <details v-if="detail.timeline.length" class="outcome-evidence">
                <summary>Delivery timeline <ChevronDown :size="14" aria-hidden="true" /></summary>
                <ol class="outcome-delivery-events"><li v-for="event in detail.timeline" :key="event.sequence"><time :datetime="event.observedAt" :title="formatFullTimestamp(event.observedAt)">{{ timeLabel(event.observedAt) }}</time><div><strong>{{ humanizeAgentInspectorTimeline(event) }}</strong><p v-if="event.detail">{{ event.detail }}</p></div></li></ol>
              </details>
            </div>
          </li>
          <li v-if="detail.latest_intervention" class="outcome-stage" data-tone="active">
            <span class="outcome-marker" aria-hidden="true"><CornerDownRight :size="15" /></span>
            <div class="outcome-stage-body">
              <div class="outcome-stage-heading"><h4>{{ detail.latest_intervention.hasCorrection ? 'Correction' : 'Stop request' }}</h4><time :datetime="detail.latest_intervention.recordedAt" :title="formatFullTimestamp(detail.latest_intervention.recordedAt)">{{ timeLabel(detail.latest_intervention.recordedAt) }}</time></div>
              <p class="outcome-stage-description">{{ messageInterventionLabel(detail.latest_intervention) }}</p>
              <blockquote v-if="detail.latest_intervention.correctionText" class="outcome-message"><p>{{ detail.latest_intervention.correctionText }}</p></blockquote>
              <p v-if="detail.latest_intervention.strategy" class="outcome-footnote">{{ detail.latest_intervention.strategy === 'native' ? 'Native steering' : 'Stop and resend' }}</p>
              <p class="outcome-footnote">Latest retained intervention for this message. Earlier interventions may no longer be available.</p>
            </div>
          </li>
          <li class="outcome-stage" :data-tone="messageOutcomeTone(detail.receipt?.state)">
            <span class="outcome-marker" aria-hidden="true"><Check v-if="messageOutcomeTone(detail.receipt?.state) === 'positive'" :size="15" /><CircleDashed v-else :size="15" /></span>
            <div class="outcome-stage-body">
              <div class="outcome-stage-heading"><h4>Outcome</h4></div>
              <div class="outcome-result" :data-tone="messageOutcomeTone(detail.receipt?.state)">
                <strong>{{ detail.receipt ? humanizeAgentInspectorReceiptState(detail.receipt.state, detail.receipt.terminal_reason) : 'No result saved' }}</strong>
                <p v-if="detail.terminal?.normalized_text">{{ detail.terminal.normalized_text }}</p>
                <p v-else-if="detail.receipt?.outcome?.text">{{ detail.receipt.outcome.text }}</p>
                <p v-else>{{ outcomeDescription }}</p>
                <button v-if="detail.publication?.canonical_message_id" type="button" class="outcome-text-button" @click="emit('reveal', detail.publication.canonical_message_id)">Open reply in Chat <ArrowUpRight :size="13" aria-hidden="true" /></button>
              </div>
              <p v-if="detail.publication && !detail.publication.canonical_message_id" class="outcome-footnote">The reply was recorded, but its room message is unavailable.</p>
            </div>
          </li>
        </ol>
        <details class="outcome-evidence outcome-identifiers"><summary>Record details <ChevronDown :size="14" aria-hidden="true" /></summary><dl><dt>Message</dt><dd>{{ detail.source_message?.id || 'Unavailable' }}</dd><dt>Provider turn</dt><dd>{{ detail.receipt?.provider_turn_id || 'No turn recorded' }}</dd><dt>Dispatch attempts</dt><dd>{{ detail.receipt?.attempt_count ?? 'Unavailable' }}</dd></dl><p v-if="!detail.latest_intervention" class="outcome-footnote">No correction or stop record is retained for this message. This is not a complete intervention history.</p></details>
      </template>
      <p v-else class="outcome-missing">An agent’s recorded work appears here after a message asks it to respond.</p>
      <section v-if="detail?.uncertain_effects.length" class="agent-inspector-work-note" role="status"><strong>Some other changes by this agent could not be confirmed. Review them before trying again.</strong><p v-for="effect in detail.uncertain_effects" :key="effect.effect_id">{{ describeAgentInspectorUncertainEffect(effect.tool_name) }}</p></section>
      <details v-if="tasks.length || artifacts.length" class="outcome-evidence outcome-related">
        <summary>Related tasks and artifacts <ChevronDown :size="14" aria-hidden="true" /></summary>
        <p class="outcome-footnote">Linked to this agent’s current tasks. These are not verified outcomes of the selected message.</p>
        <p v-for="task in tasks" :key="task.id"><strong>{{ task.title }}</strong> · {{ task.status }}</p>
        <p v-for="item in artifacts" :key="item.artifact.identityKey"><strong>{{ item.title }}</strong><span v-if="item.metaLabel"> · {{ item.metaLabel }}</span></p>
      </details>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Activity, ArrowUpRight, Check, ChevronDown, CircleDashed, Clock3, CornerDownRight, Layers, MessageSquare } from "@lucide/vue";
import type { DesktopTaskSummary } from "../../../../../../electron/ipc-types";
import type { RoomArtifactTimelineItem } from "../../../../domain/room-artifacts";
import { formatFullTimestamp, formatRelativeTime } from "../../../../domain/time";
import { messageInterventionLabel, messageOutcomeDuration, messageOutcomeTone, messageTriggerLabel } from "../../../../domain/message-outcome";
import { describeAgentInspectorUncertainEffect, describeRecordedOperation, humanizeRecordedTurn, humanizeAgentInspectorReceiptState, humanizeAgentInspectorTimeline, type AgentInspectorWorkResource } from "../../../../domain/agent-inspector-work";
import "./message-outcome.css";

const props = defineProps<{ resource: AgentInspectorWorkResource; selectedSourceMessageId: string | null; tasks: readonly Pick<DesktopTaskSummary, 'id' | 'title' | 'status'>[]; artifacts: readonly RoomArtifactTimelineItem[] }>();
const emit = defineEmits<{ retry: []; 'select-source': [sourceMessageId: string]; reveal: [canonicalMessageId: string] }>();
const workElement = ref<HTMLElement | null>(null);
watch(() => [props.resource.status, props.resource.sourceMessageId], async () => {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !workElement.value?.contains(focused)) return;
  await nextTick();
  // Retry and source changes may remove the focused control. Keep keyboard
  // users in this panel without stealing focus from another control.
  if (!focused.isConnected && document.activeElement === document.body) workElement.value?.focus({ preventScroll: true });
});
const detail = computed(() => props.resource.detail);
const originalMessageId = computed(() => {
  const id = detail.value?.source_message?.id;
  // These retained inputs originate locally and have no message to reveal in Chat.
  return id && !/^(correction:|task-continuation:|desktop-initial-message:)/.test(id) ? id : null;
});
const execution = computed(() => detail.value?.recorded_execution);
const duration = computed(() => detail.value ? messageOutcomeDuration(detail.value) : null);
const recordedTurns = computed(() => execution.value?.availability === "available"
  ? execution.value.turns.map((turn) => ({ ...turn, operations: turn.operations.map((row) => ({ ...row, presentation: describeRecordedOperation(row) })) })) : []);
const operationCount = computed(() => recordedTurns.value.reduce((count, turn) => count + turn.operations.length, 0));
function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Time unavailable';
}
const outcomeDescription = computed(() => {
  const receipt = detail.value?.receipt;
  if (receipt?.terminal_reason === 'upgrade_authority_unavailable') return 'An update ended this work because LetAgents could not safely reconnect to it. The result is unknown. The work was not repeated.';
  if (receipt?.failure_code === 'provider_continuation_missing') return 'The saved agent conversation is unavailable. The agent did not start this request.';
  if (receipt?.last_error) return receipt.last_error;
  if (receipt?.state === 'acknowledged_no_reply') return 'The agent finished without publishing a room reply.';
  if (receipt?.state === 'pending') return 'This message is queued. No provider turn has started.';
  if (receipt?.state === 'publishing') return 'The provider finished. Its reply is being published to the room.';
  if (receipt?.state === 'awaiting_result' || receipt?.state === 'dispatching') return 'Work is in progress. The outcome will appear when it is recorded.';
  return 'No final result is available for this message.';
});
</script>
