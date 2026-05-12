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
        <p class="surface-title">Rent an Agent is not enabled in this build.</p>
        <p class="surface-subtitle">Set <code>LETAGENTS_RENT_ENABLED=1</code> and restart.</p>
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
              {{ request.mode }} · {{ request.continuityMode }}
            </p>
          </div>
          <div class="surface-meta">
            <span class="state-pill" :data-state="requestState(request.status)">
              {{ request.status }}
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
              <code>{{ session.id }}</code> · {{ session.mode }} ·
              <span v-if="session.lrtLimit !== null">
                {{ session.lrtUsed }}/{{ session.lrtLimit }} LRT
              </span>
              <span v-else>{{ session.lrtUsed }} LRT</span>
            </p>
          </div>
          <div class="surface-meta">
            <span class="state-pill" :data-state="sessionStateFor(session.status)">
              {{ session.status }}
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
          <span class="rent-provider-count">{{ dashboard.listings.length }}</span>
        </header>

        <article
          v-if="dashboard.listings.length === 0"
          class="surface-row single-line"
          data-testid="rent-provider-no-listings"
        >
          <p class="surface-title">No listings yet.</p>
          <p class="surface-subtitle">
            Listing CRUD lands in a follow-up slice. For now, create listings via the MCP tools.
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
            </p>
          </div>
          <div class="surface-meta">
            <span class="state-pill" :data-state="listingState(listing.status)">
              {{ listing.status }}
            </span>
          </div>
        </article>
      </section>
    </template>

    <p v-if="actionError" class="rent-provider-action-error" role="alert" data-testid="rent-provider-action-error">
      {{ actionError }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type {
  DesktopRentalProviderDashboard,
  DesktopRentalSession,
} from "../../../../../electron/ipc-types";

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
  const bridge = window.letagentsDesktop?.rental;
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
  const bridge = window.letagentsDesktop?.rental;
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
  const bridge = window.letagentsDesktop?.rental;
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
