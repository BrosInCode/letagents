<template>
  <div class="rent-provider-dashboard" data-testid="rent-provider-dashboard">
    <article class="surface-row single-line">
      <div>
        <p class="surface-title">Provider dashboard</p>
        <p class="surface-subtitle">{{ summaryLine }}</p>
      </div>
      <div class="surface-meta">
        <button
          type="button"
          class="rent-refresh-button"
          data-testid="rent-provider-refresh"
          :disabled="state === 'loading'"
          @click="refresh"
        >
          {{ state === "loading" ? "Refreshing..." : "Refresh" }}
        </button>
      </div>
    </article>

    <article
      v-if="state === 'error'"
      class="surface-row single-line"
      data-testid="rent-provider-error"
      role="alert"
    >
      <div>
        <p class="surface-title">Dashboard temporarily unavailable.</p>
        <p class="surface-subtitle">{{ errorMessage || "Try Refresh in a moment." }}</p>
      </div>
      <div class="surface-meta">
        <span class="state-pill" data-state="failed">error</span>
      </div>
    </article>

    <article
      v-else-if="state === 'disabled'"
      class="surface-row single-line"
      data-testid="rent-provider-disabled"
    >
      <div>
        <p class="surface-title">Rent an Agent is turned off in this desktop app.</p>
        <p class="surface-subtitle">Enable the rental marketplace for this app, then restart LetAgents Desktop.</p>
      </div>
      <div class="surface-meta">
        <span class="state-pill" data-state="offline">disabled</span>
      </div>
    </article>

    <template v-else>
      <section class="rent-provider-section">
        <header class="rent-provider-section-header">
          <p class="surface-title">Pending requests</p>
          <span class="rent-provider-count">{{ dashboard.pendingRequests.length }}</span>
        </header>

        <article
          v-if="dashboard.pendingRequests.length === 0"
          class="surface-row single-line"
          data-testid="rent-provider-no-requests"
        >
          <p class="surface-title">No pending requests.</p>
        </article>

        <article
          v-for="request in dashboard.pendingRequests"
          :key="request.id"
          class="surface-row"
          :data-testid="`rent-provider-request-${request.id}`"
        >
          <div>
            <p class="surface-title">{{ request.taskTitle }}</p>
            <p class="surface-subtitle">
              {{ request.renterDisplayName || "Unknown renter" }} ·
              {{ rentalModeLabel(request.mode) }} · {{ rentalContinuityLabel(request.continuityMode) }}
            </p>
          </div>
          <div class="surface-meta">
            <span class="state-pill" :data-state="requestState(request.status)">
              {{ humanizeToken(request.status) }}
            </span>
            <button
              type="button"
              class="rent-refresh-button rent-action-decline"
              :data-testid="`rent-provider-decline-${request.id}`"
              :disabled="actionBusyFor === request.id || request.status !== 'pending'"
              @click="decline(request.id)"
            >
              {{ actionBusyFor === request.id && actionKind === "decline" ? "Declining..." : "Decline" }}
            </button>
            <button
              type="button"
              class="rent-refresh-button rent-action-accept"
              :data-testid="`rent-provider-accept-${request.id}`"
              :disabled="actionBusyFor === request.id || request.status !== 'pending'"
              @click="accept(request.id)"
            >
              {{ actionBusyFor === request.id && actionKind === "accept" ? "Accepting..." : "Accept" }}
            </button>
          </div>
        </article>
      </section>

      <section class="rent-provider-section">
        <header class="rent-provider-section-header">
          <p class="surface-title">Active sessions</p>
          <span class="rent-provider-count">{{ dashboard.activeSessions.length }}</span>
        </header>

        <article
          v-if="dashboard.activeSessions.length === 0"
          class="surface-row single-line"
          data-testid="rent-provider-no-active"
        >
          <p class="surface-title">No active rentals.</p>
        </article>

        <article
          v-for="session in dashboard.activeSessions"
          :key="session.id"
          class="surface-row"
          :data-testid="`rent-provider-session-${session.id}`"
        >
          <div>
            <p class="surface-title">{{ session.taskTitle }}</p>
            <p class="surface-subtitle">
              <code>{{ session.id }}</code> · {{ rentalModeLabel(session.mode) }} ·
              <span v-if="session.lrtLimit !== null">
                {{ session.lrtUsed }}/{{ session.lrtLimit }} rental credits
              </span>
              <span v-else>{{ session.lrtUsed }} rental credits</span>
            </p>
          </div>
          <div class="surface-meta">
            <span class="state-pill" :data-state="sessionStateFor(session.status)">
              {{ humanizeToken(session.status) }}
            </span>
            <button
              type="button"
              class="rent-refresh-button"
              :data-testid="`rent-provider-open-session-${session.id}`"
              @click="emit('open-session', session)"
            >
              Open
            </button>
          </div>
        </article>
      </section>

      <section class="rent-provider-section">
        <header class="rent-provider-section-header">
          <p class="surface-title">My listings</p>
          <div class="rent-provider-header-actions">
            <span class="rent-provider-count">{{ dashboard.listings.length }}</span>
            <button
              type="button"
              class="rent-refresh-button rent-action-accept"
              data-testid="rent-provider-new-listing"
              @click="openListingForm(null)"
            >
              New listing
            </button>
          </div>
        </header>

        <article
          v-if="dashboard.listings.length === 0"
          class="surface-row single-line"
          data-testid="rent-provider-no-listings"
        >
          <p class="surface-title">No listings yet.</p>
          <p class="surface-subtitle">
            Create a listing to make this machine's agent rentable.
          </p>
        </article>

        <article
          v-for="listing in dashboard.listings"
          :key="listing.id"
          class="surface-row"
          :data-testid="`rent-provider-listing-${listing.id}`"
        >
          <div>
            <p class="surface-title">{{ listing.displayName }}</p>
            <p class="surface-subtitle">
              {{ listing.ideKind }}
              <span v-if="listing.modelLabel"> · {{ listing.modelLabel }}</span>
              · {{ listing.activeSessionCount }}/{{ listing.maxConcurrentSessions }} active
              <span v-if="listing.manualAcceptRequired"> · manual accept</span>
            </p>
          </div>
          <div class="surface-meta">
            <span class="state-pill" :data-state="listingState(listing.status)">
              {{ humanizeToken(listing.status) }}
            </span>
            <button
              type="button"
              class="rent-refresh-button"
              :data-testid="`rent-provider-edit-listing-${listing.id}`"
              :disabled="listingBusyFor === listing.id"
              @click="openListingForm(listing)"
            >
              Edit
            </button>
            <button
              v-if="canPauseListing(listing.status)"
              type="button"
              class="rent-refresh-button"
              :data-testid="`rent-provider-pause-listing-${listing.id}`"
              :disabled="listingBusyFor === listing.id"
              @click="pauseListing(listing.id)"
            >
              {{ listingBusyFor === listing.id ? "Working..." : "Pause" }}
            </button>
            <button
              v-else-if="canResumeListing(listing.status)"
              type="button"
              class="rent-refresh-button"
              :class="{ 'rent-action-accept': listing.status === 'setup_required' }"
              :data-testid="`rent-provider-resume-listing-${listing.id}`"
              :disabled="listingBusyFor === listing.id"
              @click="resumeListing(listing.id)"
            >
              {{ listingBusyFor === listing.id ? "Working..." : resumeListingLabel(listing.status) }}
            </button>
          </div>
        </article>
      </section>

      <section class="rent-provider-section" data-testid="rent-provider-readiness">
        <header class="rent-provider-section-header">
          <p class="surface-title">Readiness</p>
          <button
            type="button"
            class="rent-refresh-button"
            data-testid="rent-provider-run-preflight"
            :disabled="preflightBusy"
            @click="runPreflight"
          >
            {{ preflightBusy ? "Checking..." : "Run checks" }}
          </button>
        </header>

        <article class="surface-row">
          <div>
            <p class="surface-title">
              {{ readiness.summary || readinessSummaryFallback(readiness.status) }}
            </p>
            <p v-if="readiness.lastCheckedAt" class="surface-subtitle">
              Last checked {{ formatTime(readiness.lastCheckedAt) }}
            </p>
          </div>
          <div class="surface-meta">
            <span class="state-pill" :data-state="readinessState(readiness.status)">
              {{ humanizeToken(readiness.status) }}
            </span>
          </div>
        </article>

        <article
          v-for="blocker in readiness.blockers"
          :key="`blocker-${blocker}`"
          class="surface-row single-line rent-provider-blocker"
        >
          <p class="surface-title">{{ blocker }}</p>
          <span class="state-pill" data-state="failed">blocker</span>
        </article>

        <article
          v-for="warning in readiness.warnings"
          :key="`warning-${warning}`"
          class="surface-row single-line"
        >
          <p class="surface-title">{{ warning }}</p>
          <span class="state-pill" data-state="starting">warning</span>
        </article>

        <article
          v-for="check in readiness.checks"
          :key="check.id"
          class="surface-row single-line"
          :data-testid="`rent-provider-readiness-check-${check.id}`"
        >
          <div>
            <p class="surface-title">{{ check.label }}</p>
            <p v-if="check.detail" class="surface-subtitle">{{ check.detail }}</p>
          </div>
          <span class="state-pill" :data-state="readinessCheckState(check.status)">
            {{ humanizeToken(check.status) }}
          </span>
        </article>
      </section>
    </template>

    <RentListingFormModal
      :open="listingFormOpen"
      :listing="listingBeingEdited"
      @close="listingFormOpen = false"
      @saved="onListingSaved"
    />

    <p v-if="actionError" class="rent-provider-action-error" role="alert" data-testid="rent-provider-action-error">
      {{ actionError }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type {
  DesktopRentalListing,
  DesktopRentalProviderDashboard,
  DesktopRentalProviderReadiness,
  DesktopRentalSession,
} from "../../../../../electron/ipc-types";
import RentListingFormModal from "./RentListingFormModal.vue";
import { desktopIpc } from "../../../ipc/index.js";
import {
  canPauseListing,
  canResumeListing,
  resumeListingLabel,
} from "./rent-listing-form";
import {
  formatTime,
  humanizeToken,
  rentalContinuityLabel,
  rentalModeLabel,
} from "./rent-session-detail/presentation";

const emit = defineEmits<{
  "open-session": [session: DesktopRentalSession];
}>();

type ViewState = "loading" | "ready" | "error" | "disabled";

const state = ref<ViewState>("loading");
const errorMessage = ref<string | null>(null);
const dashboard = ref<DesktopRentalProviderDashboard>(emptyDashboard());
const actionBusyFor = ref<string | null>(null);
const actionKind = ref<"accept" | "decline" | null>(null);
const actionError = ref<string | null>(null);
const listingFormOpen = ref(false);
const listingBeingEdited = ref<DesktopRentalListing | null>(null);
const listingBusyFor = ref<string | null>(null);
const preflightBusy = ref(false);
const preflightReadiness = ref<DesktopRentalProviderReadiness | null>(null);

const readiness = computed<DesktopRentalProviderReadiness>(
  () => preflightReadiness.value ?? dashboard.value.readiness,
);

const summaryLine = computed(() => {
  if (state.value === "loading") return "Loading dashboard...";
  if (state.value === "error") return "Could not load dashboard.";
  if (state.value === "disabled") return "Rent an Agent disabled.";
  const requests = dashboard.value.pendingRequests.length;
  const sessions = dashboard.value.activeSessions.length;
  const listings = dashboard.value.listings.length;
  return `${requests} pending · ${sessions} active · ${listings} listing${listings === 1 ? "" : "s"}.`;
});

onMounted(() => {
  void refresh();
});

async function refresh(): Promise<void> {
  const bridge = desktopIpc.rental;
  if (!bridge?.getProviderDashboard) {
    state.value = "disabled";
    return;
  }

  state.value = "loading";
  errorMessage.value = null;
  try {
    const result = await bridge.getProviderDashboard();
    if (isDisabledResult(result)) {
      state.value = "disabled";
      dashboard.value = emptyDashboard();
      return;
    }
    dashboard.value = normalizeDashboard(result);
    state.value = "ready";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Unknown error.";
    state.value = "error";
  }
}

async function accept(requestId: string): Promise<void> {
  const bridge = desktopIpc.rental;
  if (!bridge?.acceptRequest) return;
  actionBusyFor.value = requestId;
  actionKind.value = "accept";
  actionError.value = null;
  try {
    const result = await bridge.acceptRequest(requestId);
    if (isDisabledResult(result)) {
      actionError.value = "Rent an Agent is disabled.";
      return;
    }
    await refresh();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : "Could not accept request.";
  } finally {
    actionBusyFor.value = null;
    actionKind.value = null;
  }
}

async function decline(requestId: string): Promise<void> {
  const bridge = desktopIpc.rental;
  if (!bridge?.declineRequest) return;
  actionBusyFor.value = requestId;
  actionKind.value = "decline";
  actionError.value = null;
  try {
    const result = await bridge.declineRequest(requestId);
    if (isDisabledResult(result)) {
      actionError.value = "Rent an Agent is disabled.";
      return;
    }
    await refresh();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : "Could not decline request.";
  } finally {
    actionBusyFor.value = null;
    actionKind.value = null;
  }
}

function emptyDashboard(): DesktopRentalProviderDashboard {
  return {
    listings: [],
    activeSessions: [],
    pendingRequests: [],
    readiness: {
      status: "unknown",
      summary: null,
      blockers: [],
      warnings: [],
      badges: [],
      checks: [],
      lastCheckedAt: null,
    },
    quotaSnapshots: [],
    updatedAt: null,
  };
}

function normalizeDashboard(value: unknown): DesktopRentalProviderDashboard {
  if (!value || typeof value !== "object") return emptyDashboard();
  const candidate = value as Partial<DesktopRentalProviderDashboard>;
  const fallback = emptyDashboard();
  return {
    listings: Array.isArray(candidate.listings) ? candidate.listings : fallback.listings,
    activeSessions: Array.isArray(candidate.activeSessions) ? candidate.activeSessions : fallback.activeSessions,
    pendingRequests: Array.isArray(candidate.pendingRequests) ? candidate.pendingRequests : fallback.pendingRequests,
    readiness: candidate.readiness ?? fallback.readiness,
    quotaSnapshots: Array.isArray(candidate.quotaSnapshots) ? candidate.quotaSnapshots : fallback.quotaSnapshots,
    updatedAt: candidate.updatedAt ?? fallback.updatedAt,
  };
}

function isDisabledResult(value: unknown): boolean {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { enabled?: unknown }).enabled === false
  );
}

function openListingForm(listing: DesktopRentalListing | null): void {
  listingBeingEdited.value = listing;
  listingFormOpen.value = true;
}

function onListingSaved(): void {
  listingFormOpen.value = false;
  listingBeingEdited.value = null;
  void refresh();
}

async function pauseListing(listingId: string): Promise<void> {
  await runListingAction(listingId, (bridge) => bridge.pauseListing(listingId), "Could not pause the listing.");
}

async function resumeListing(listingId: string): Promise<void> {
  await runListingAction(listingId, (bridge) => bridge.resumeListing(listingId), "Could not resume the listing.");
}

type RentalBridge = NonNullable<NonNullable<typeof desktopIpc>["rental"]>;

async function runListingAction(
  listingId: string,
  action: (bridge: RentalBridge) => Promise<unknown>,
  failureMessage: string,
): Promise<void> {
  const bridge = desktopIpc.rental;
  if (!bridge) return;
  listingBusyFor.value = listingId;
  actionError.value = null;
  try {
    const result = await action(bridge);
    if (isDisabledResult(result)) {
      actionError.value = "Rent an Agent is disabled.";
      return;
    }
    await refresh();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : failureMessage;
  } finally {
    listingBusyFor.value = null;
  }
}

async function runPreflight(): Promise<void> {
  const bridge = desktopIpc.rental;
  if (!bridge?.runPreflight) return;
  preflightBusy.value = true;
  actionError.value = null;
  try {
    const result = await bridge.runPreflight();
    if (isDisabledResult(result)) {
      actionError.value = "Rent an Agent is disabled.";
      return;
    }
    preflightReadiness.value = result.readiness;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : "Could not run readiness checks.";
  } finally {
    preflightBusy.value = false;
  }
}

function readinessState(status: string): string {
  if (status === "ready") return "active";
  if (status === "degraded") return "starting";
  if (status === "blocked") return "failed";
  return "offline";
}

function readinessCheckState(status: string): string {
  if (status === "passed") return "connected";
  if (status === "warning") return "starting";
  if (status === "failed") return "failed";
  return "offline";
}

function readinessSummaryFallback(status: string): string {
  if (status === "ready") return "This machine is ready to serve rentals.";
  if (status === "degraded") return "Rentals can run, but some checks need attention.";
  if (status === "blocked") return "Rentals are blocked until the issues below are fixed.";
  return "Run checks to see whether this machine can serve rentals.";
}

function listingState(status: string): string {
  if (status === "active") return "active";
  if (status === "paused") return "away";
  return "offline";
}

function sessionStateFor(status: string): string {
  if (status === "active" || status === "in_progress" || status === "running") return "active";
  if (status === "queued" || status === "pending" || status === "starting") return "starting";
  return "offline";
}

function requestState(status: string): string {
  if (status === "pending") return "starting";
  if (status === "accepted") return "connected";
  return "offline";
}

</script>

<style scoped>
.rent-provider-dashboard {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.rent-provider-section {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.rent-provider-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4rem 0.2rem 0;
}
.rent-provider-header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.rent-provider-blocker .surface-title {
  color: var(--color-danger, #ff8a80);
}
.rent-provider-count {
  font-variant-numeric: tabular-nums;
  font-size: 0.85rem;
  background: var(--color-surface-2, rgba(255, 255, 255, 0.06));
  border-radius: 999px;
  padding: 0.1rem 0.55rem;
}
.rent-action-accept {
  background: var(--color-accent, #4f7cff);
  color: white;
  border-color: transparent;
}
.rent-action-decline {
  background: transparent;
}
.rent-provider-action-error {
  color: var(--color-danger, #ff8a80);
  font-size: 0.85rem;
  margin: 0.4rem 0 0;
}
</style>
