<template>
  <aside class="my-work-detail" aria-label="Ticket detail" data-testid="my-work-detail">
    <header class="my-work-detail-header">
      <div>
        <div class="desktop-task-detail-status-row">
          <template v-if="ticket">
            <span class="desktop-task-provider-chip" :data-provider="ticket.provider">{{ ticket.providerLabel }}</span>
            <span class="desktop-task-id">{{ ticket.key }}</span>
          </template>
          <span v-else class="desktop-task-id">{{ shortTaskId(card.task_id) }}</span>
          <span class="my-work-detail-room">{{ card.room_name }}</span>
        </div>
        <h3>{{ card.title }}</h3>
      </div>
      <button type="button" class="desktop-task-detail-button" aria-label="Close ticket detail" data-testid="my-work-detail-close" @click="emit('close')">
        <X :size="16" aria-hidden="true" />
      </button>
    </header>

    <ul v-if="card.needs_me_reasons.length" class="my-work-needs-me" aria-label="Needs you" data-testid="my-work-detail-needs-me">
      <li v-for="reason in card.needs_me_reasons" :key="reason">{{ needsMeLabel(reason) }}</li>
    </ul>

    <div v-if="canAskJev" class="my-work-jev" data-testid="my-work-detail-jev">
      <button
        type="button"
        class="desktop-task-detail-button"
        :disabled="jevBusy"
        data-testid="my-work-detail-jev-ask"
        @click="askJev"
      >{{ jevBusy ? "Asking Jev..." : "Ask Jev who this waits on" }}</button>
      <span v-if="jevAnswer" class="my-work-jev-answer" role="status" data-testid="my-work-detail-jev-answer">{{ jevAnswer }}</span>
    </div>

    <div class="my-work-detail-columns">
      <section class="desktop-task-detail-section" aria-label="Ticket" data-testid="my-work-detail-ticket">
        <h4>Ticket</h4>
        <template v-if="ticket">
          <div class="desktop-task-detail-grid">
            <span v-if="hasConnections && card.ticket_state">
              <small>Ticket state</small>
              <strong>
                <span class="desktop-task-ticket-state" :data-ticket-state="card.ticket_state">{{ ticketStateLabel(card.ticket_state) }}</span>
              </strong>
            </span>
            <span v-if="hasConnections && card.ticket_status">
              <small>{{ ticket.providerLabel }} status</small>
              <strong>{{ card.ticket_status }}</strong>
            </span>
            <span v-if="hasConnections && card.ticket_state">
              <small>Assignee</small>
              <strong>{{ card.ticket_assignee_label || "Unassigned" }}</strong>
            </span>
          </div>
          <p v-if="hasConnections && !card.ticket_state" class="desktop-task-detail-muted">
            No room filter syncs {{ ticket.key }}, so its tracker state is not shown.
          </p>
          <a v-if="card.ticket_url" class="desktop-task-detail-link" :href="card.ticket_url" target="_blank" rel="noopener noreferrer" data-testid="my-work-detail-tracker-link">
            <small>{{ ticket.providerLabel }}</small>
            <span>Open {{ ticket.key }}</span>
          </a>
        </template>
        <p v-else class="desktop-task-detail-muted">This card names no ticket.</p>
      </section>

      <section class="desktop-task-detail-section" aria-label="Agent work" data-testid="my-work-detail-agent">
        <h4>Agent work</h4>
        <div class="desktop-task-detail-grid">
          <span>
            <small>Work state</small>
            <strong><span class="desktop-task-status-badge" :data-status="card.work_state">{{ readableStatus(card.work_state) }}</span></strong>
          </span>
          <span>
            <small>Owner</small>
            <strong>{{ card.agent ? compactPerson(card.agent.label) || card.agent.label : "Unassigned" }}</strong>
          </span>
          <span v-if="card.agent?.last_heartbeat_at">
            <small>Last seen</small>
            <strong>{{ relativeTime(card.agent.last_heartbeat_at, now) }}</strong>
          </span>
        </div>
        <p v-if="card.agent?.status_text" class="my-work-status-line" data-testid="my-work-detail-status">{{ card.agent.status_text }}</p>
        <button type="button" class="desktop-task-detail-button desktop-task-events-link" data-testid="my-work-detail-open-card" @click="emit('open-card', card)">
          Open card in {{ card.room_name }}
        </button>
        <TaskLinkedThreads
          v-if="ticket"
          :room-identifier="card.room_id"
          :task-id="card.task_id"
          :ticket-key="ticket.key"
          :revision="card.updated_at"
          @open-thread="emit('open-thread', card, $event)"
        />
      </section>

      <section class="desktop-task-detail-section" aria-label="Pull requests" data-testid="my-work-detail-pr">
        <h4>PR</h4>
        <p v-if="!card.pull_requests.length" class="desktop-task-detail-muted">No pull request yet.</p>
        <div v-else class="desktop-task-detail-list">
          <a
            v-for="pr in card.pull_requests"
            :key="pr.url"
            class="desktop-task-detail-link"
            :href="pr.url"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="my-work-detail-pr-link"
          >
            <small>GitHub · {{ pullRequestLabel(pr) }} · {{ pullRequestStateLabel(pr) }}</small>
            <span>{{ pr.title || pr.url }}</span>
            <small v-if="reviewSummaryLabel(pr)">{{ reviewSummaryLabel(pr) }}</small>
            <small v-if="checkSummaryLabel(pr)">{{ checkSummaryLabel(pr) }}</small>
          </a>
        </div>
      </section>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { X } from "@lucide/vue";
import type { MyWorkCard } from "../../../../../../../../shared/ticket-connectors.mjs";
import { getRoomBridge } from "../../../../ipc/index.js";
import { useNow } from "../../../../composables/useNow";
import TaskLinkedThreads from "../room-board/TaskLinkedThreads.vue";
import { compactPerson, readableStatus, relativeTime, shortTaskId } from "../room-board/formatters";
import { ticketRefParts, ticketStateLabel } from "../room-board/ticket-ref";
import { checkSummaryLabel, jevNeedsMeLabel, needsMeLabel, pullRequestLabel, pullRequestStateLabel, reviewSummaryLabel } from "./my-work-presentation";

const props = defineProps<{
  card: MyWorkCard;
  /** False in zero-connector mode: no ticket state is shown (invariant 1). */
  hasConnections: boolean;
}>();

const emit = defineEmits<{
  close: [];
  "open-card": [card: MyWorkCard];
  "open-thread": [card: MyWorkCard, threadRootId: string];
}>();

const now = useNow(30_000);
const ticket = computed(() => ticketRefParts(props.card.external_ref));

// Ticket connectors PR6: on request, Jev reads who the card waits on. Only for
// a card whose ticket's connection has the Jev switch on.
const canAskJev = computed(() => props.card.jev_needs_me === true && typeof getRoomBridge()?.askMyWorkNeedsMe === "function");
const jevBusy = ref(false);
const jevAnswer = ref<string | null>(null);
watch(() => [props.card.room_id, props.card.task_id] as const, () => { jevAnswer.value = null; });

async function askJev(): Promise<void> {
  const ask = getRoomBridge()?.askMyWorkNeedsMe;
  if (!ask || jevBusy.value) return;
  jevBusy.value = true;
  try {
    jevAnswer.value = jevNeedsMeLabel((await ask(props.card.room_id, props.card.task_id)).state);
  } catch {
    jevAnswer.value = jevNeedsMeLabel("unavailable");
  } finally {
    jevBusy.value = false;
  }
}
</script>

<style scoped>
.my-work-jev { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.my-work-jev-answer { color: var(--text-secondary); font-size: 12px; }
.my-work-detail { display: flex; flex-direction: column; gap: 12px; padding: 16px; border-top: 1px solid var(--border-subtle, var(--border-strong)); }
.my-work-detail-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.my-work-detail-header h3 { margin: 4px 0 0; }
.my-work-detail-room { color: var(--text-secondary); font-size: 12px; }
.my-work-detail-columns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.my-work-detail-columns > section { min-width: 0; }
.my-work-needs-me { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.my-work-needs-me li { padding: 2px 8px; border-radius: 999px; background: var(--warning-surface, rgba(210, 153, 34, 0.16)); color: var(--text-primary); font-size: 12px; }
.my-work-status-line { margin: 8px 0; color: var(--text-secondary); font-size: 13px; }
@media (max-width: 900px) { .my-work-detail-columns { grid-template-columns: minmax(0, 1fr); } }
</style>
