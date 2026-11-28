<template>
  <div class="work-detail" data-testid="my-work-session-detail">
    <header class="work-detail-top">
      <span><WorkIcon name="folder" />{{ sessionRoomLabel(session) }}</span
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
        {{ sessionProviderLabel(session.provider) }} session <span>·</span> Not
        on a board
      </div>
      <h2 :id="titleId">{{ sessionTitle(session) }}</h2>
      <div class="work-detail-state" :data-tone="sessionTone(session, now)">
        <span class="work-session-dot" aria-hidden="true" />{{
          sessionStateLabel(session, now)
        }}
      </div>
      <section
        class="work-detail-section"
        aria-label="Session"
        data-testid="my-work-session-facts"
      >
        <h3>Session</h3>
        <div class="work-agent-detail">
          <ChatAvatar
            :name="sessionProviderLabel(session.provider)"
            agent
            :provider="session.provider"
          />
          <div>
            <strong>{{ sessionProviderLabel(session.provider) }}</strong
            ><small>On this computer · last change {{ workDate(session.lastActivityAt) }}</small>
          </div>
        </div>
        <dl class="work-details-grid work-session-grid">
          <div v-if="session.branch">
            <dt>Branch</dt>
            <dd>{{ session.branch }}</dd>
          </div>
          <div>
            <dt>Folder</dt>
            <dd :title="session.projectRoot">{{ session.projectRoot }}</dd>
          </div>
        </dl>
        <p class="work-detail-muted">
          Read from this computer. LetAgents does not send it to the room.
        </p>
      </section>
      <section
        v-if="session.pullRequests.length"
        class="work-detail-section"
        aria-label="Pull requests"
        data-testid="my-work-session-prs"
      >
        <h3>Pull requests</h3>
        <a
          v-for="pr in sortedPullRequests"
          :key="pr.url"
          class="work-session-pr"
          :href="safeWorkUrl(pr.url)"
          target="_blank"
          rel="noopener noreferrer"
          :data-state="(pr.state || '').toLowerCase()"
          ><WorkIcon name="branch" /><span>#{{ pr.number }}</span
          ><small>{{ sessionPullRequestState(pr.state) }}</small
          ><WorkIcon name="external"
        /></a>
      </section>
      <p v-else class="work-detail-section work-detail-muted">
        This session has no pull request yet.
      </p>
    </div>
    <footer class="work-detail-footer">
      <button
        v-if="canOpen"
        type="button"
        class="work-primary"
        data-testid="my-work-open-session"
        :disabled="opening"
        @click="emit('open-session', session)"
      >
        Open in {{ sessionProviderLabel(session.provider) }}
        <WorkIcon name="external" />
      </button>
      <p v-if="openError" class="work-session-error" role="alert">
        {{ openError }}
      </p>
    </footer>
  </div>
</template>
<script setup lang="ts">
import { computed } from "vue";
import type { MyWorkLocalSession } from "../../ticket-connectors.mjs";
import ChatAvatar from "../ChatAvatar.vue";
import WorkIcon from "./WorkIcon.vue";
import {
  safeWorkUrl,
  sessionPullRequestsByState,
  sessionProviderLabel,
  sessionRoomLabel,
  sessionStateLabel,
  sessionTitle,
  sessionTone,
  workDate,
} from "./model";
const props = defineProps<{
  session: MyWorkLocalSession;
  titleId: string;
  now: number;
  canOpen: boolean;
  opening: boolean;
  openError: string;
}>();
const emit = defineEmits<{
  close: [];
  "open-session": [session: MyWorkLocalSession];
}>();
const sortedPullRequests = computed(() =>
  sessionPullRequestsByState(props.session.pullRequests),
);
function sessionPullRequestState(state: string | null): string {
  if (!state) return "Linked";
  return state.charAt(0) + state.slice(1).toLowerCase();
}
</script>
