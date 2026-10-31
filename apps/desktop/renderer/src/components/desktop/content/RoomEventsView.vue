<template>
  <div class="room-tab-page desktop-activity-panel" data-testid="room-events-view">
    <ActivityFeed :events="events" :room-identifier="roomIdentifier" :loading="loading" :loading-older="loadingOlder" :has-more="eventsPage?.hasMore" :error="error" :available="githubConnected || githubLoading || Boolean(repository)" :selected-event-id="selectedEventId" @refresh="emit('refresh')" @load-older="emit('loadOlder')" @open-task="emit('openTask', $event)" @close-selected-event="emit('closeSelectedEvent')">
      <template #notice><div v-if="linkedTaskId" class="activity-notice" data-testid="room-events-task-filter">Linked to {{ linkedTaskId }} <button type="button" @click="emit('clearTaskFilter')">Clear</button></div></template>
      <template #setup><button type="button" :disabled="githubBusy || githubLoading" @click="emit('installGithub')">{{ githubBusy ? 'Opening…' : 'Set up GitHub' }}</button><p v-if="githubError">{{ githubError }}</p></template>
      <template #actions="{ group }"><PullRequestChangesButton v-if="group.kind === 'pr'" :url="group.url" /></template>
    </ActivityFeed>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { DesktopGitHubEventsPage } from '../../../../../electron/ipc-types';
import ActivityFeed from '../../../../../../../shared/ui/activity/ActivityFeed.vue';
import PullRequestChangesButton from './room-events/PullRequestChangesButton.vue';
const props = defineProps<{
  roomIdentifier: string;
  eventsPage: DesktopGitHubEventsPage | null;
  repository: string | null;
  currentBranch: string | null;
  githubConnected: boolean;
  githubLoading: boolean;
  githubBusy: boolean;
  githubError: string | null;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
  linkedTaskId: string | null;
  selectedEventId: string | null;
  loadedOlderWithoutMatches: boolean;
}>();

const emit = defineEmits<{
  refresh: [];
  loadOlder: [];
  installGithub: [];
  clearTaskFilter: [];
  openTask: [taskId: string];
  closeSelectedEvent: [];
}>();

const events = computed(() => (props.eventsPage?.events || []).filter(event => !props.linkedTaskId || event.linkedTaskId === props.linkedTaskId).map(event => ({
  id: event.id, event_type: event.eventType, action: event.action, github_object_id: event.githubObjectId,
  github_object_url: event.githubObjectUrl, title: event.title, state: event.state, actor_login: event.actorLogin,
  metadata: event.metadata, linked_task_id: event.linkedTaskId, created_at: event.createdAt,
  provider_event_at: event.providerEventAt, provider_object_updated_at: event.providerObjectUpdatedAt,
  event_order_at: event.eventOrderAt, head_sha: event.headSha,
})));
</script>
<style scoped>
.desktop-activity-panel { height: 100%; overflow-y: auto; background: var(--bg, #0a0a0a); }
</style>
