<template>
  <section class="rent-marketplace" data-testid="rent-marketplace-view">
    <header class="rent-marketplace-header">
      <div class="rent-marketplace-heading">
        <h1>{{ role === 'renter' ? 'Rent an agent' : 'Rent out your agents' }}</h1>
        <p>{{ role === 'renter' ? 'Bring temporary capacity into one of your rooms.' : 'Review requests and control what this Mac makes available.' }}</p>
      </div>
      <DesktopSegmentedControl
        v-model="role"
        class="rent-marketplace-role"
        label="Rental role"
        mode="tabs"
        size="compact"
        :options="roleOptions"
      />
    </header>

    <RentProviderDashboard v-if="role === 'provider'" />

    <template v-else>
      <div v-if="state === 'error'" class="rent-marketplace-notice" role="alert">
        <span class="rent-marketplace-notice-mark" aria-hidden="true">!</span>
        <span><strong>Marketplace unavailable</strong><small>{{ errorMessage }}</small></span>
        <button type="button" class="rent-button rent-button-secondary" @click="refresh">Try again</button>
      </div>

      <div v-else-if="state === 'loading'" class="rent-marketplace-loading" aria-live="polite">
        <span class="rent-marketplace-loading-mark" aria-hidden="true"></span>
        Finding available hosts…
      </div>

      <div v-else-if="providers.length === 0" class="rent-marketplace-empty">
        <span class="rent-marketplace-empty-mark" aria-hidden="true"><span></span></span>
        <h2>No one is available right now.</h2>
        <p>Providers appear here when they make an authenticated runtime available from their desktop.</p>
        <button type="button" class="rent-button rent-button-secondary" @click="refresh">Refresh availability</button>
      </div>

      <div v-else class="rent-marketplace-layout">
        <section class="rent-provider-roster" aria-label="Available providers">
          <header class="rent-section-heading">
            <div>
              <p>People available now</p>
              <span>{{ providers.length }} {{ providers.length === 1 ? 'provider has' : 'providers have' }} open capacity</span>
            </div>
            <button type="button" class="rent-text-button" @click="refresh">Refresh</button>
          </header>

          <div class="rent-provider-list">
            <button
              v-for="provider in providers"
              :key="provider.accountId"
              class="rent-provider-card"
              type="button"
              :aria-pressed="selectedProvider?.accountId === provider.accountId"
              :data-selected="selectedProvider?.accountId === provider.accountId"
              @click="selectedProviderId = provider.accountId"
            >
              <span class="rent-availability-lens" :data-state="provider.availability">
                <img v-if="provider.avatarUrl" :src="provider.avatarUrl" alt="" />
                <span v-else>{{ initials(provider.displayName) }}</span>
              </span>
              <span class="rent-provider-card-copy">
                <strong>{{ provider.displayName }}</strong>
                <small>{{ provider.login ? `@${provider.login}` : providerSummary(provider) }}</small>
              </span>
              <span class="rent-provider-card-side">
                <span class="rent-provider-status" :data-state="provider.availability">{{ availabilityLabel(provider.availability) }}</span>
                <small>{{ runtimeLabel(provider) }} · {{ provider.availableSlots }} slot{{ provider.availableSlots === 1 ? '' : 's' }}</small>
              </span>
            </button>
          </div>
        </section>

        <aside class="rent-request-panel" aria-live="polite">
          <template v-if="selectedProvider">
            <header class="rent-request-provider">
              <span class="rent-availability-lens rent-availability-lens-small" :data-state="selectedProvider.availability">
                <img v-if="selectedProvider.avatarUrl" :src="selectedProvider.avatarUrl" alt="" />
                <span v-else>{{ initials(selectedProvider.displayName) }}</span>
              </span>
              <div>
                <p>Request from</p>
                <h2>{{ selectedProvider.displayName }}</h2>
              </div>
              <span class="rent-request-runtime">{{ runtimeLabel(selectedProvider) }}</span>
            </header>

            <form class="rent-request-form" @submit.prevent="submitRequest">
              <div class="rent-field-row">
                <DesktopSelectField
                  id="rent-room-select"
                  v-model="roomIdentifier"
                  class="rent-select"
                  label="Room"
                  placeholder="Choose where the agent joins"
                  :options="roomOptions"
                />
                <DesktopSelectField
                  id="rent-duration-select"
                  v-model="durationSelection"
                  class="rent-select rent-duration-field"
                  label="Duration"
                  :options="durationOptions"
                />
              </div>
              <label class="rent-field">
                <span>Task</span>
                <input v-model="taskTitle" maxlength="120" placeholder="What should the agent take over?" required />
              </label>
              <label class="rent-field">
                <span>Brief</span>
                <textarea v-model="taskPrompt" rows="4" placeholder="Give it the goal, constraints, and definition of done." required></textarea>
              </label>

              <div class="rent-request-boundaries">
                <p>Access</p>
              <label class="rent-capability-toggle">
                <input v-model="fullHistoryAcknowledged" type="checkbox" />
                <span>
                    <strong>Full room history</strong>
                    <small>The agent joins visibly and can read the room’s existing conversation.</small>
                </span>
              </label>
              <label v-if="selectedRoom?.gitRoom && selectedProvider.supportsRepository" class="rent-capability-toggle">
                <input v-model="includeRepository" type="checkbox" />
                <span>
                  <strong>Include repository work</strong>
                  <small>LetAgents provides an isolated, scoped workspace. Your GitHub credentials are not shared.</small>
                </span>
              </label>
              </div>

              <p v-if="requestError" class="rent-request-error" role="alert">{{ requestError }}</p>
              <p v-if="requestSuccess" class="rent-request-success" role="status">Request sent. {{ selectedProvider.displayName }} will review it before anything starts.</p>
              <button class="rent-button" type="submit" :disabled="submitting || !canSubmit">
                {{ submitting ? 'Sending request…' : 'Request agent' }}
              </button>
            </form>
          </template>
        </aside>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type {
  DesktopAccountRoomEntry,
  DesktopRentalListing,
  DesktopRentalMarketplace,
  DesktopRentalMarketplaceProvider,
} from "../../../../../electron/ipc-types";
import { desktopIpc } from "../../../ipc/index.js";
import DesktopSegmentedControl from "../controls/DesktopSegmentedControl.vue";
import DesktopSelectField from "../controls/DesktopSelectField.vue";
import RentProviderDashboard from "./RentProviderDashboard.vue";

const props = defineProps<{ rooms: DesktopAccountRoomEntry[]; initialRole?: "renter" | "provider" }>();
type ViewState = "loading" | "ready" | "error";
type Role = "renter" | "provider";
const role = ref<Role>(props.initialRole || "renter");
const state = ref<ViewState>("loading");
const errorMessage = ref("Could not load rental availability.");
const providers = ref<DesktopRentalMarketplaceProvider[]>([]);
const selectedProviderId = ref<string | null>(null);
const roomIdentifier = ref("");
const taskTitle = ref("");
const taskPrompt = ref("");
const fullHistoryAcknowledged = ref(false);
const includeRepository = ref(false);
const durationMinutes = ref(30);
const submitting = ref(false);
const requestError = ref<string | null>(null);
const requestSuccess = ref(false);

const roleOptions = [{ id: "renter", label: "I want to rent" }, { id: "provider", label: "I am renting out" }];
const availableRooms = computed(() => props.rooms.filter((room) => !room.archived));
const roomOptions = computed(() => availableRooms.value.map((room) => ({ value: room.roomIdentifier, label: room.displayName })));
const durationOptions = [
  { value: "30", label: "30 min" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
];
const durationSelection = computed({
  get: () => String(durationMinutes.value),
  set: (value: string) => { durationMinutes.value = Number(value); },
});
const selectedProvider = computed(() => providers.value.find((provider) => provider.accountId === selectedProviderId.value) || providers.value[0] || null);
const selectedRoom = computed(() => availableRooms.value.find((room) => room.roomIdentifier === roomIdentifier.value) || null);
const selectedOffer = computed(() => selectedProvider.value?.offers.find((offer) => offer.status === "active") || selectedProvider.value?.offers[0] || null);
const canSubmit = computed(() => Boolean(selectedOffer.value && roomIdentifier.value && taskTitle.value.trim() && taskPrompt.value.trim() && fullHistoryAcknowledged.value));

watch(selectedProvider, () => { requestError.value = null; requestSuccess.value = false; });
watch(() => props.initialRole, (nextRole) => { if (nextRole) role.value = nextRole; });
watch(role, (nextRole, previousRole) => {
  if (nextRole === "renter" && previousRole === "provider") void refresh();
});
watch(availableRooms, (rooms) => { if (!roomIdentifier.value && rooms[0]) roomIdentifier.value = rooms[0].roomIdentifier; }, { immediate: true });
watch(selectedRoom, (room) => { if (!room?.gitRoom) includeRepository.value = false; });
onMounted(() => { void refresh(); });

async function refresh(): Promise<void> {
  state.value = "loading";
  requestError.value = null;
  try {
    const bridge = desktopIpc.rental;
    if (!bridge) throw new Error("Restart LetAgents Desktop to load the rental marketplace.");
    const result = bridge.getMarketplace ? await bridge.getMarketplace() : await fallbackMarketplace();
    providers.value = result.providers.filter((provider) => provider.availability === "available" && provider.availableSlots > 0);
    if (!providers.value.some((provider) => provider.accountId === selectedProviderId.value)) selectedProviderId.value = providers.value[0]?.accountId || null;
    state.value = "ready";
  } catch (error) {
    errorMessage.value = marketplaceErrorMessage(error);
    state.value = "error";
  }
}

async function fallbackMarketplace(): Promise<DesktopRentalMarketplace> {
  const listings = await desktopIpc.rental!.listListings();
  const grouped = new Map<string, DesktopRentalMarketplaceProvider>();
  for (const listing of listings) {
    const id = listing.providerAccountId || listing.id;
    const provider = grouped.get(id) || {
      accountId: id,
      displayName: listing.providerDisplayName || listing.displayName,
      login: null,
      avatarUrl: null,
      availability: listing.status === "active" ? "available" : "offline",
      availableSlots: Math.max(0, listing.maxConcurrentSessions - listing.activeSessionCount),
      // "scoped" is a rental policy mode, not proof that a repository
      // materializer exists on the provider host.
      supportsRepository: false,
      maxDurationMinutes: listing.defaultTimeLimitMinutes,
      offers: [],
    };
    provider.offers.push(listing);
    grouped.set(id, provider);
  }
  return { providers: [...grouped.values()], updatedAt: null };
}

async function submitRequest(): Promise<void> {
  if (!canSubmit.value || !selectedOffer.value || !selectedRoom.value) return;
  submitting.value = true;
  requestError.value = null;
  requestSuccess.value = false;
  try {
    await desktopIpc.rental!.createSession({
      listingId: selectedOffer.value.id,
      roomIdentifier: selectedRoom.value.roomIdentifier,
      taskTitle: taskTitle.value.trim(),
      taskPrompt: taskPrompt.value.trim(),
      repoProvider: includeRepository.value ? selectedRoom.value.gitRoom?.provider ?? null : null,
      repoOwner: includeRepository.value ? selectedRoom.value.gitRoom?.repository.owner ?? null : null,
      repoName: includeRepository.value ? selectedRoom.value.gitRoom?.repository.name ?? null : null,
      baseBranch: includeRepository.value ? selectedRoom.value.gitRoom?.ref.name ?? null : null,
      mode: "scoped",
      continuityMode: "full_transcript",
      approvedScope: { includePaths: [], excludePaths: [], protectedPaths: [], notes: includeRepository.value ? "Repository workspace requested." : "Room-only rental." },
      // Keep the legacy policy field on the wire until the server contract is
      // migrated. It is deliberately not presented as a metered product limit:
      // the supervised launch path cannot measure every provider consistently.
      policy: { maxLrt: selectedOffer.value.defaultLrtLimit, maxDurationMinutes: durationMinutes.value, maxPatchBytes: null, allowCommands: false, allowNetwork: false, requirePatchGate: true },
      startTrigger: "user_initiated",
      triggerConfidence: "manual",
    });
    requestSuccess.value = true;
    taskTitle.value = "";
    taskPrompt.value = "";
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : "Could not send this request.";
  } finally {
    submitting.value = false;
  }
}

function initials(value: string): string { return value.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "LA"; }
function runtimeLabel(provider: DesktopRentalMarketplaceProvider): string { return provider.offers.map((offer) => offer.ideKind === "claude_code" ? "Claude" : offer.ideKind === "codex" ? "Codex" : offer.ideKind).filter((value, index, values) => values.indexOf(value) === index).join(" + "); }
function providerSummary(provider: DesktopRentalMarketplaceProvider): string { return `${runtimeLabel(provider)} available`; }
function availabilityLabel(value: DesktopRentalMarketplaceProvider["availability"]): string { return value === "available" ? "Available" : value === "busy" ? "Busy" : "Offline"; }
function marketplaceErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("response_not_json") || message.includes("Rental marketplace failed")) {
    return "This build is not connected to a rental-enabled API.";
  }
  if (message.includes("Authentication required") || message.includes("401")) {
    return "Sign in to see available providers.";
  }
  return "Could not load rental availability. Check your connection and try again.";
}
</script>

<style src="../../../styles/surfaces/rent-marketplace.css"></style>
