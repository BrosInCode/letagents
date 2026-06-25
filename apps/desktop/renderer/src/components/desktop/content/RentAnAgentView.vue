<template>
  <section class="surface-page" data-testid="rent-an-agent-view">
    <article class="surface-intro">
      <p class="sidebar-label">Rent an Agent</p>
      <h3>Borrow an idle IDE agent when your own quota runs out.</h3>
      <p>
        Browse listings from other LetAgents users. When your local IDE agent hits its
        quota, you can rent a verified agent for a single task while your own session refreshes.
      </p>
    </article>

    <div class="rent-mode-toggle" role="tablist" aria-label="Rent an Agent role" data-testid="rent-mode-toggle">
      <button
        type="button"
        role="tab"
        :data-active="role === 'renter'"
        data-testid="rent-mode-renter"
        @click="role = 'renter'"
      >
        I want to rent
      </button>
      <button
        type="button"
        role="tab"
        :data-active="role === 'provider'"
        data-testid="rent-mode-provider"
        @click="role = 'provider'"
      >
        I'm renting out
      </button>
    </div>

    <article
      v-if="lastCreatedSession && role === 'renter'"
      class="surface-row single-line rent-session-banner"
      data-testid="rent-an-agent-session-created"
    >
      <div>
        <p class="surface-title">Session started: {{ lastCreatedSession.taskTitle }}</p>
        <p class="surface-subtitle">
          <code>{{ lastCreatedSession.id }}</code> · {{ humanizeToken(lastCreatedSession.mode) }} ·
          {{ humanizeToken(lastCreatedSession.status) }}
        </p>
      </div>
      <div class="surface-meta">
        <button
          type="button"
          class="rent-refresh-button"
          data-testid="rent-an-agent-open-session"
          @click="openSessionDetail(lastCreatedSession)"
        >
          Open
        </button>
        <button
          type="button"
          class="rent-refresh-button"
          data-testid="rent-an-agent-dismiss-banner"
          @click="lastCreatedSession = null"
        >
          Dismiss
        </button>
      </div>
    </article>

    <RentProviderDashboard v-if="role === 'provider'" @open-session="openSessionDetail" />
    <template v-else>

    <div v-if="state === 'disabled'" class="surface-list" data-testid="rent-an-agent-disabled">
      <article class="surface-row single-line">
        <div>
          <p class="surface-title">Rent an Agent is not enabled in this build.</p>
          <p class="surface-subtitle">
            This workspace cannot use the marketplace yet. Restart after enabling the feature for this desktop build.
          </p>
        </div>
        <div class="surface-meta">
          <span class="state-pill" data-state="offline">disabled</span>
        </div>
      </article>
    </div>

    <div v-else class="surface-list" data-testid="rent-an-agent-listings">
      <article class="surface-row single-line">
        <div>
          <p class="surface-title">Available agents</p>
          <p class="surface-subtitle">
            {{ listingsSummary }}
          </p>
        </div>
        <div class="surface-meta">
          <button
            type="button"
            class="rent-refresh-button"
            data-testid="rent-an-agent-refresh"
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
        data-testid="rent-an-agent-error"
        role="alert"
      >
        <div>
          <p class="surface-title">We couldn't reach the marketplace.</p>
          <p class="surface-subtitle">{{ errorMessage || "Try Refresh in a moment." }}</p>
        </div>
        <div class="surface-meta">
          <span class="state-pill" data-state="failed">error</span>
        </div>
      </article>

      <article
        v-if="state === 'ready' && listings.length === 0"
        class="surface-row single-line"
        data-testid="rent-an-agent-empty"
      >
        <div>
          <p class="surface-title">No agents available right now.</p>
          <p class="surface-subtitle">Check back when a provider goes online.</p>
        </div>
      </article>

      <article
        v-for="listing in listings"
        :key="listing.id"
        class="surface-row"
        :data-testid="`rent-an-agent-listing-${listing.id}`"
      >
        <div>
          <p class="surface-title">{{ listing.displayName }}</p>
          <p class="surface-subtitle">{{ listingSubtitle(listing) }}</p>
        </div>
        <div class="surface-meta">
          <span
            v-for="badge in listing.readinessBadges"
            :key="badge"
            class="state-pill"
            :data-state="badgeState(badge)"
          >{{ badge }}</span>
          <span class="state-pill" :data-state="statusState(listing.status)">
            {{ humanizeToken(listing.status) }}
          </span>
          <button
            type="button"
            class="rent-refresh-button rent-start-button"
            :data-testid="`rent-start-${listing.id}`"
            :disabled="!canStart(listing)"
            @click="openSessionModal(listing)"
          >
            Start rental
          </button>
        </div>
      </article>
    </div>

    <RentSessionCreateModal
      :open="sessionModalOpen"
      :listing="selectedListing"
      :room-identifier="roomIdentifier"
      @close="closeSessionModal"
      @created="onSessionCreated"
    />
    </template>

    <RentSessionDetailModal
      :open="sessionDetailOpen"
      :session="detailSession"
      @close="closeSessionDetail"
      @session-updated="onSessionUpdated"
    />
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import type { DesktopRentalListing, DesktopRentalSession } from "../../../../../electron/ipc-types";
import RentSessionCreateModal from "./RentSessionCreateModal.vue";
import RentSessionDetailModal from "./RentSessionDetailModal.vue";
import RentProviderDashboard from "./RentProviderDashboard.vue";

defineProps<{
  roomIdentifier: string;
}>();

type ViewState = "loading" | "ready" | "error" | "disabled";
type Role = "renter" | "provider";

const role = ref<Role>("renter");

const listings = ref<DesktopRentalListing[]>([]);
const state = ref<ViewState>("loading");
const errorMessage = ref<string | null>(null);
const sessionModalOpen = ref(false);
const selectedListing = ref<DesktopRentalListing | null>(null);
const lastCreatedSession = ref<DesktopRentalSession | null>(null);
const sessionDetailOpen = ref(false);
const detailSession = ref<DesktopRentalSession | null>(null);

const listingsSummary = computed(() => {
  if (state.value === "loading") return "Loading listings...";
  if (state.value === "error") return "Marketplace temporarily unavailable.";
  if (listings.value.length === 0) return "No active listings right now.";
  if (listings.value.length === 1) return "1 agent available.";
  return `${listings.value.length} agents available.`;
});

onMounted(() => {
  void refresh();
});

async function refresh(): Promise<void> {
  const bridge = getRentalBridge();
  if (!bridge?.listListings) {
    state.value = "disabled";
    return;
  }

  state.value = "loading";
  errorMessage.value = null;
  try {
    const result = await bridge.listListings();
    if (isDisabledResult(result)) {
      state.value = "disabled";
      listings.value = [];
      return;
    }
    listings.value = Array.isArray(result) ? result : [];
    state.value = "ready";
  } catch (error) {
    listings.value = [];
    errorMessage.value = error instanceof Error ? error.message : "Unknown error.";
    state.value = "error";
  }
}

function getRentalBridge(): typeof window.letagentsDesktop.rental | undefined {
  return window.letagentsDesktop?.rental;
}

function isDisabledResult(value: unknown): boolean {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { enabled?: unknown }).enabled === false
  );
}

function listingSubtitle(listing: DesktopRentalListing): string {
  const parts: string[] = [];
  if (listing.providerDisplayName) parts.push(listing.providerDisplayName);
  parts.push(humanizeToken(listing.ideKind));
  if (listing.modelLabel) parts.push(listing.modelLabel);
  if (listing.activeSessionCount > 0) {
    parts.push(`${listing.activeSessionCount}/${listing.maxConcurrentSessions} active`);
  }
  return parts.join(" • ");
}

function humanizeToken(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function badgeState(badge: string): string {
  const normalized = badge.toLowerCase();
  if (/(verified|ready|live|active)/.test(normalized)) return "connected";
  if (/(pending|starting|warming)/.test(normalized)) return "starting";
  if (/(offline|unavailable|paused|failed|error)/.test(normalized)) return "offline";
  return "active";
}

function statusState(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "active") return "active";
  if (normalized === "paused") return "away";
  return "offline";
}

function canStart(listing: DesktopRentalListing): boolean {
  if (listing.status !== "active") return false;
  if (listing.maxConcurrentSessions > 0 && listing.activeSessionCount >= listing.maxConcurrentSessions) return false;
  return true;
}

function openSessionModal(listing: DesktopRentalListing): void {
  selectedListing.value = listing;
  sessionModalOpen.value = true;
}

function closeSessionModal(): void {
  sessionModalOpen.value = false;
  selectedListing.value = null;
}

function onSessionCreated(session: DesktopRentalSession): void {
  lastCreatedSession.value = session;
  void refresh();
}

function openSessionDetail(session: DesktopRentalSession): void {
  detailSession.value = session;
  sessionDetailOpen.value = true;
}

function closeSessionDetail(): void {
  sessionDetailOpen.value = false;
  detailSession.value = null;
}

function onSessionUpdated(session: DesktopRentalSession): void {
  if (lastCreatedSession.value && lastCreatedSession.value.id === session.id) {
    lastCreatedSession.value = session;
  }
  void refresh();
}
</script>

<style scoped>
.rent-refresh-button {
  appearance: none;
  background: var(--color-surface-2, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  color: inherit;
  padding: 0.35rem 0.85rem;
  border-radius: 999px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.rent-refresh-button:disabled {
  cursor: progress;
  opacity: 0.6;
}
.rent-refresh-button:not(:disabled):hover {
  background: var(--color-surface-3, rgba(255, 255, 255, 0.1));
}
.rent-start-button {
  background: var(--color-accent, #4f7cff);
  color: white;
  border-color: transparent;
}
.rent-session-banner {
  background: color-mix(in srgb, var(--color-accent, #4f7cff) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-accent, #4f7cff) 30%, transparent);
}
.rent-mode-toggle {
  display: inline-flex;
  gap: 0.25rem;
  padding: 0.25rem;
  background: var(--color-surface-2, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  border-radius: 999px;
  margin: 0.5rem 0 0.25rem;
  align-self: flex-start;
}
.rent-mode-toggle button {
  appearance: none;
  background: transparent;
  color: inherit;
  border: none;
  padding: 0.4rem 0.95rem;
  border-radius: 999px;
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}
.rent-mode-toggle button[data-active="true"] {
  background: var(--color-accent, #4f7cff);
  color: white;
}
</style>
