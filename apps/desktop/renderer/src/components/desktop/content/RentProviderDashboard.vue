<template>
  <section class="rent-provider" data-testid="rent-provider-dashboard">
    <header class="rent-provider-hero">
      <div><p>Provider desk</p><h2>{{ settings?.enabled ? 'Your capacity is visible.' : 'Your capacity is paused.' }}</h2><span>{{ statusCopy }}</span></div>
      <button class="rent-button rent-button-secondary" type="button" :disabled="loading" @click="refresh()">{{ loading ? 'Refreshing…' : 'Refresh' }}</button>
    </header>
    <p v-if="error" class="rent-request-error" role="alert">{{ error }}</p>

    <div class="rent-provider-overview">
      <article><span class="rent-provider-health" :data-state="settings?.daemonState || 'offline'"></span><div><small>Local daemon</small><strong>{{ settings?.daemonState || 'Checking' }}</strong></div></article>
      <article><small>Available slots</small><strong>{{ availableSlots }}</strong></article>
      <article><small>Working now</small><strong>{{ workingSessions.length }}</strong></article>
    </div>

    <section class="rent-provider-section"><header><div><p>Incoming requests</p><span>Review the exact room, scope, and limits before launch.</span></div><strong>{{ dashboard.pendingRequests.length }}</strong></header>
      <div v-if="loading" class="rent-provider-empty">Loading requests…</div>
      <div v-else-if="dashboard.pendingRequests.length === 0" class="rent-provider-empty">No requests waiting. Keep this desktop available to receive one.</div>
      <div v-else class="rent-provider-queue">
        <button v-for="request in dashboard.pendingRequests" :key="request.id" class="rent-provider-request" type="button" :data-selected="reviewingRequest?.id === request.id" @click="openReview(request)">
          <span class="rent-provider-request-mark">{{ initials(request.renterDisplayName || 'Renter') }}</span><span><strong>{{ request.taskTitle }}</strong><small>{{ request.renterDisplayName || 'Unknown renter' }} · {{ request.requestedTimeLimitMinutes || '—' }} min</small></span><span class="rent-provider-review-label">Review</span>
        </button>
      </div>
    </section>

    <section class="rent-provider-section"><header><div><p>Rental activity</p><span>Every session using a slot, including work that is preparing or needs attention.</span></div><strong>{{ dashboard.capacitySessions.length }}</strong></header>
      <div v-if="dashboard.capacitySessions.length === 0" class="rent-provider-empty">No rental is using capacity on this desktop.</div>
      <div v-else class="rent-provider-active"><article v-for="session in dashboard.capacitySessions" :key="session.id"><span class="rent-provider-health" :data-state="sessionIndicator(session)"></span><div><strong>{{ session.taskTitle }}</strong><small>{{ session.roomIdentifier || 'Preparing room' }} · {{ session.timeLimitMinutes || '—' }} min</small></div><span class="rent-provider-session-state" :data-state="sessionIndicator(session)">{{ sessionStateLabel(session) }}</span></article></div>
    </section>

    <RentRequestReviewSheet :open="Boolean(reviewingRequest)" :request="reviewingRequest" :session="reviewSession" :runtimes="settings?.runtimes || []" :busy="launching" :error="reviewError" @close="closeReview" @launch="launch" @decline="decline" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { DesktopRentalLaunchConfiguration, DesktopRentalProviderDashboard, DesktopRentalProviderSettings, DesktopRentalRequest, DesktopRentalSession } from "../../../../../electron/ipc-types";
import { desktopIpc } from "../../../ipc/index.js";
import { loadRentalProviderDashboard, useRentalProviderEvents } from "../../../composables/useRentalProviderEvents";
import RentRequestReviewSheet from "./RentRequestReviewSheet.vue";

const dashboard = ref<DesktopRentalProviderDashboard>(emptyDashboard()); const settings = ref<DesktopRentalProviderSettings | null>(null); const loading = ref(true); const error = ref<string | null>(null); const reviewingRequest = ref<DesktopRentalRequest | null>(null); const reviewSession = ref<DesktopRentalSession | null>(null); const reviewError = ref<string | null>(null); const launching = ref(false);
let reviewRequestToken = 0;
const workingSessions = computed(() => dashboard.value.capacitySessions.filter((session) => session.status === 'active' && session.launchState === 'active'));
const availableSlots = computed(() => Math.max(0, (settings.value?.maxConcurrentSessions || 0) - dashboard.value.capacitySessions.length));
const statusCopy = computed(() => settings.value?.blockers.length ? settings.value.blockers[0] : settings.value?.enabled ? `${availableSlots.value} slot${availableSlots.value === 1 ? '' : 's'} available from this Mac.` : 'Turn on availability in Settings → Renting when you are ready.');
onMounted(() => { void refresh(); });
useRentalProviderEvents(() => { void refresh(false); });
async function refresh(showLoading = true): Promise<void> { if (showLoading) loading.value = true; error.value = null; try { const bridge = desktopIpc.rental; if (!bridge) throw new Error('Restart LetAgents Desktop to use renting.'); const [nextDashboard, nextSettings] = await Promise.all([loadRentalProviderDashboard(), bridge.getProviderSettings()]); dashboard.value = nextDashboard; settings.value = nextSettings; } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not load provider availability.'; } finally { if (showLoading) loading.value = false; } }
async function openReview(request: DesktopRentalRequest): Promise<void> {
  const token = ++reviewRequestToken;
  reviewingRequest.value = request;
  reviewSession.value = null;
  reviewError.value = null;
  try {
    const session = await desktopIpc.rental?.getSession(request.sessionId);
    if (token !== reviewRequestToken || reviewingRequest.value?.id !== request.id) return;
    if (!session || session.id !== request.sessionId) throw new Error('Could not load this request.');
    reviewSession.value = session;
  } catch (cause) {
    if (token !== reviewRequestToken || reviewingRequest.value?.id !== request.id) return;
    reviewError.value = cause instanceof Error ? cause.message : 'Could not inspect this request.';
  }
}
function closeReview(): void { reviewRequestToken += 1; reviewingRequest.value = null; reviewSession.value = null; reviewError.value = null; }
async function launch(configuration: DesktopRentalLaunchConfiguration): Promise<void> {
  const request = reviewingRequest.value;
  const token = reviewRequestToken;
  if (!request || reviewSession.value?.id !== request.sessionId) { reviewError.value = 'Review details are still loading.'; return; }
  launching.value = true;
  reviewError.value = null;
  try {
    await desktopIpc.rental!.acceptRequest(request.sessionId, configuration);
    if (token === reviewRequestToken && reviewingRequest.value?.id === request.id) closeReview();
    await refresh();
  } catch (cause) {
    if (token === reviewRequestToken && reviewingRequest.value?.id === request.id) reviewError.value = cause instanceof Error ? cause.message : 'Could not launch this rental.';
  } finally { launching.value = false; }
}
async function decline(): Promise<void> {
  const request = reviewingRequest.value;
  const token = reviewRequestToken;
  if (!request || reviewSession.value?.id !== request.sessionId) { reviewError.value = 'Review details are still loading.'; return; }
  launching.value = true;
  try {
    await desktopIpc.rental!.declineRequest(request.sessionId);
    if (token === reviewRequestToken && reviewingRequest.value?.id === request.id) closeReview();
    await refresh();
  } catch (cause) {
    if (token === reviewRequestToken && reviewingRequest.value?.id === request.id) reviewError.value = cause instanceof Error ? cause.message : 'Could not decline this request.';
  } finally { launching.value = false; }
}
function initials(value: string): string { return value.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase(); }
function sessionIndicator(session: DesktopRentalSession): 'online' | 'starting' | 'error' | 'offline' { if (session.status === 'active' && session.launchState === 'active') return 'online'; if (session.launchState === 'launch_failed' || session.status === 'blocked' || session.status === 'budget_exhausted') return 'error'; if (session.status === 'stale') return 'offline'; return 'starting'; }
function sessionStateLabel(session: DesktopRentalSession): string { if (session.status === 'active' && session.launchState === 'active') return 'Working'; if (session.launchState === 'launch_failed') return 'Launch failed'; if (session.status === 'blocked') return 'Needs attention'; if (session.status === 'budget_exhausted') return 'Budget exhausted'; if (session.status === 'patch_review') return 'Patch review'; if (session.status === 'pr_opened') return 'PR open'; if (session.status === 'stale') return 'Offline'; if (session.launchState === 'provisioning' || session.status === 'provisioning') return 'Preparing'; return 'Awaiting launch'; }
function emptyDashboard(): DesktopRentalProviderDashboard { return { listings: [], capacitySessions: [], pendingRequests: [], readiness: { status: 'unknown', summary: null, blockers: [], warnings: [], badges: [], checks: [], lastCheckedAt: null }, quotaSnapshots: [], updatedAt: null }; }
</script>
