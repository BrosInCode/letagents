<template>
  <div class="work-detail" data-testid="my-work-detail">
    <header class="work-detail-top">
      <span><WorkIcon name="folder" />{{ card.room_name }}</span
      ><button
        type="button"
        class="work-icon-button"
        aria-label="Close work details"
        @click="emit('close')"
      >
        <WorkIcon name="close" />
      </button>
    </header>
    <div class="work-detail-body">
      <div class="work-source-label">
        {{
          card.provider
            ? `${trackerProviderLabel(card.provider)} ticket`
            : "Room task"
        }}
        <span>·</span> {{ workKey(card) }}
      </div>
      <h2 :id="titleId">{{ card.title }}</h2>
      <div class="work-detail-state" :data-tone="workTone(card)">
        <WorkIcon
          :name="workGroups.find((group) => group.id === workGroup(card))!.icon"
        />{{ workState(card.work_state) }}
      </div>
      <div
        class="work-detail-tabs"
        role="tablist"
        aria-label="Work details"
        @keydown="tabKey"
      >
        <button
          v-for="item in ['overview', 'updates'] as const"
          :key="item"
          type="button"
          role="tab"
          :id="`${titleId}-${item}`"
          :aria-controls="`${titleId}-content`"
          :aria-selected="tab === item"
          :tabindex="tab === item ? 0 : -1"
          @click="tab = item"
        >
          {{ item === "overview" ? "Overview" : "Updates" }}
        </button>
      </div>
      <div
        :id="`${titleId}-content`"
        role="tabpanel"
        :aria-labelledby="`${titleId}-${tab}`"
      >
        <template v-if="tab === 'overview'">
          <section
            v-if="card.needs_me_reasons.length"
            class="work-attention"
            data-testid="my-work-detail-needs-me"
          >
            <p v-for="reason in card.needs_me_reasons" :key="reason">
              <WorkIcon name="review" />{{ needsMeLabel(reason) }}
            </p>
            <a
              v-if="reviewUrl"
              :href="reviewUrl"
              target="_blank"
              rel="noopener noreferrer"
              >Review pull request <WorkIcon name="arrow" /></a
            ><button v-else type="button" @click="emit('open-card', card)">
              Open in room <WorkIcon name="arrow" />
            </button>
          </section>
          <section
            class="work-detail-section"
            aria-label="Agent work"
            data-testid="my-work-detail-agent"
          >
            <h3>{{ card.agent?.agent_key ? "Agent" : "Assigned to" }}</h3>
            <div class="work-agent-detail">
              <ChatAvatar
                :name="workOwner(card)"
                :agent="Boolean(card.agent?.agent_key)"
                :agent-key="card.agent?.agent_key"
                :provider="card.agent?.provider"
              />
              <div>
                <strong>{{ workOwner(card) }}</strong
                ><small>{{
                  card.agent?.status
                    ? workState(card.agent.status)
                    : workState(card.work_state)
                }}</small>
              </div>
            </div>
            <p v-if="card.agent?.status_text" class="work-agent-update">
              {{ card.agent.status_text }}
            </p>
            <p v-if="card.agent?.last_heartbeat_at" class="work-detail-muted">
              Last seen {{ workDate(card.agent.last_heartbeat_at) }}
            </p>
          </section>
          <section
            v-if="card.pull_requests.length"
            class="work-detail-section"
            aria-label="Pull requests"
            data-testid="my-work-detail-pr"
          >
            <h3>Pull requests</h3>
            <div
              v-for="pr in card.pull_requests"
              :key="pr.url"
              class="work-pr-block"
            >
              <div class="work-pr-header">
                <WorkIcon name="branch" /><strong>{{
                  pullRequestLabel(pr)
                }}</strong
                ><span>{{ pullRequestStateLabel(pr) }}</span>
              </div>
              <p>{{ pr.title || "Linked pull request" }}</p>
              <div class="work-pr-checks">
                <span v-if="checkSummaryLabel(pr)"
                  ><WorkIcon name="progress" />{{ checkSummaryLabel(pr) }}</span
                ><span v-if="reviewSummaryLabel(pr)"
                  ><WorkIcon name="review" />{{ reviewSummaryLabel(pr) }}</span
                >
              </div>
              <a
                v-if="safeWorkUrl(pr.url)"
                :href="safeWorkUrl(pr.url)"
                target="_blank"
                rel="noopener noreferrer"
                >View pull request <WorkIcon name="external"
              /></a>
            </div>
          </section>
          <section
            v-if="card.external_ref"
            class="work-detail-section"
            aria-label="Ticket"
            data-testid="my-work-detail-ticket"
          >
            <h3>
              {{
                card.provider ? trackerProviderLabel(card.provider) : "Linked"
              }}
              ticket
            </h3>
            <dl class="work-details-grid">
              <div>
                <dt>Ticket</dt>
                <dd>{{ workKey(card) }}</dd>
              </div>
              <template v-if="hasConnections && card.ticket_state"
                ><div>
                  <dt>Ticket state</dt>
                  <dd>{{ workState(card.ticket_state) }}</dd>
                </div>
                <div v-if="card.ticket_status">
                  <dt>Tracker status</dt>
                  <dd>{{ card.ticket_status }}</dd>
                </div>
                <div>
                  <dt>Assignee</dt>
                  <dd>{{ card.ticket_assignee_label || "Unassigned" }}</dd>
                </div></template
              >
            </dl>
            <p
              v-if="hasConnections && !card.ticket_state"
              class="work-detail-muted"
            >
              No synced tracker state is available for this ticket.
            </p>
            <a
              v-if="safeWorkUrl(card.ticket_url)"
              :href="safeWorkUrl(card.ticket_url)"
              target="_blank"
              rel="noopener noreferrer"
              >Open {{ workKey(card) }} <WorkIcon name="external"
            /></a>
          </section>
          <section
            v-if="card.jev_needs_me && api.askNeedsMe"
            class="work-detail-section"
          >
            <button
              type="button"
              class="work-secondary"
              :disabled="jevBusy"
              @click="askJev"
            >
              {{ jevBusy ? "Asking Jev…" : "Ask Jev who this waits on" }}
            </button>
            <p v-if="jevAnswer" role="status" class="work-detail-muted">
              {{ jevAnswer }}
            </p>
          </section>
          <section class="work-detail-section">
            <dl class="work-details-grid">
              <div>
                <dt>Room</dt>
                <dd>{{ card.room_name }}</dd>
              </div>
              <div>
                <dt>Last update</dt>
                <dd>{{ workDate(card.updated_at) }}</dd>
              </div>
              <div v-if="card.threads.count">
                <dt>Conversation</dt>
                <dd>
                  <button type="button" @click="tab = 'updates'">
                    {{ card.threads.count }} linked
                    {{ card.threads.count === 1 ? "message" : "messages" }} →
                  </button>
                </dd>
              </div>
            </dl>
          </section>
        </template>
        <template v-else>
          <section class="work-detail-section">
            <h3>Latest reported update</h3>
            <p>{{ card.agent?.status_text || workState(card.work_state) }}</p>
            <time>{{ workDate(card.updated_at) }}</time>
          </section>
          <section
            class="work-detail-section"
            aria-label="Linked conversations"
            data-testid="task-linked-threads"
          >
            <h3>Linked conversations</h3>
            <p v-if="mentionsError" role="alert">
              {{ mentionsError }}
              <button type="button" @click="loadMentions">Retry</button>
            </p>
            <p v-else-if="mentionsLoading && !mentions.length" role="status">
              Loading conversations…
            </p>
            <p v-else-if="!mentions.length" class="work-detail-muted">
              {{
                card.external_ref
                  ? "No room messages link to this ticket yet."
                  : "Open this task in its room to see the conversation."
              }}
            </p>
            <button
              v-for="mention in mentions"
              :key="mention.messageId"
              type="button"
              class="work-mention"
              @click="emit('open-thread', card, mention.threadRootId)"
            >
              <strong>{{
                mention.sender.split("|")[0]?.trim() || "Room message"
              }}</strong
              ><time>{{ workDate(mention.timestamp) }}</time
              ><span>{{ mention.text }}</span
              ><small>Open conversation →</small>
            </button>
          </section>
        </template>
      </div>
    </div>
    <footer class="work-detail-footer">
      <button
        type="button"
        class="work-primary"
        data-testid="my-work-detail-open-card"
        @click="emit('open-card', card)"
      >
        Open in room <WorkIcon name="arrow" />
      </button>
    </footer>
  </div>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import {
  trackerProviderLabel,
  type MyWorkCard,
} from "../../ticket-connectors.mjs";
import ChatAvatar from "../ChatAvatar.vue";
import WorkIcon from "./WorkIcon.vue";
import type { MyWorkApi, WorkMention } from "./types";
import {
  checkSummaryLabel,
  jevNeedsMeLabel,
  needsMeLabel,
  primaryPullRequest,
  pullRequestLabel,
  pullRequestStateLabel,
  reviewSummaryLabel,
  safeWorkUrl,
  workDate,
  workGroup,
  workGroups,
  workKey,
  workOwner,
  workState,
  workTone,
} from "./model";
const props = defineProps<{
  card: MyWorkCard;
  hasConnections: boolean;
  api: MyWorkApi;
  titleId: string;
}>();
const emit = defineEmits<{
  close: [];
  "open-card": [card: MyWorkCard];
  "open-thread": [card: MyWorkCard, id: string];
}>();
const tab = ref<"overview" | "updates">("overview");
const reviewUrl = computed(() =>
  props.card.needs_me_reasons.includes("review_requested")
    ? safeWorkUrl(primaryPullRequest(props.card)?.url || null)
    : undefined,
);
const mentions = ref<WorkMention[]>([]),
  mentionsLoading = ref(false),
  mentionsError = ref("");
const jevBusy = ref(false),
  jevAnswer = ref("");
let mentionsRequest = 0,
  jevRequest = 0;
async function loadMentions() {
  const request = ++mentionsRequest;
  if (!props.card.external_ref) {
    mentions.value = [];
    mentionsLoading.value = false;
    return;
  }
  mentionsLoading.value = true;
  try {
    const next = await props.api.mentions(props.card);
    if (request === mentionsRequest) {
      mentions.value = next;
      mentionsError.value = "";
    }
  } catch {
    if (request === mentionsRequest)
      mentionsError.value = "Linked conversations could not be loaded.";
  } finally {
    if (request === mentionsRequest) mentionsLoading.value = false;
  }
}
async function askJev() {
  if (!props.api.askNeedsMe || jevBusy.value) return;
  const request = ++jevRequest;
  jevBusy.value = true;
  try {
    const next = await props.api.askNeedsMe(props.card);
    if (request === jevRequest) jevAnswer.value = jevNeedsMeLabel(next.state);
  } catch {
    if (request === jevRequest)
      jevAnswer.value = jevNeedsMeLabel("unavailable");
  } finally {
    if (request === jevRequest) jevBusy.value = false;
  }
}
watch([() => props.card.room_id, () => props.card.task_id], () => {
  mentionsRequest++;
  jevRequest++;
  mentions.value = [];
  mentionsError.value = "";
  jevAnswer.value = "";
  jevBusy.value = false;
  tab.value = "overview";
});
watch(
  () => [
    tab.value,
    props.card.updated_at,
    props.card.room_id,
    props.card.task_id,
  ],
  () => {
    if (tab.value === "updates") void loadMentions();
  },
);
onScopeDispose(() => {
  mentionsRequest++;
  jevRequest++;
});
function tabKey(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  tab.value =
    event.key === "Home"
      ? "overview"
      : event.key === "End"
        ? "updates"
        : tab.value === "overview"
          ? "updates"
          : "overview";
  (event.currentTarget as HTMLElement)
    .querySelector<HTMLElement>(
      `#${CSS.escape(`${props.titleId}-${tab.value}`)}`,
    )
    ?.focus({ preventScroll: true });
}
</script>
