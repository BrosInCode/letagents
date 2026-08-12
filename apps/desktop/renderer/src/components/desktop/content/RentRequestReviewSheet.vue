<template>
  <Teleport to="body">
    <Transition name="rent-review">
      <div v-if="open" class="rent-review-scrim" @click.self="close">
        <section ref="dialog" class="rent-review-sheet" role="dialog" aria-modal="true" aria-labelledby="rent-review-title" tabindex="-1" @keydown="onKeydown">
          <header><div><p>Manual review</p><h2 id="rent-review-title">{{ request?.taskTitle || 'Review request' }}</h2></div><button type="button" aria-label="Close review" @click="close">×</button></header>
          <p v-if="error" class="rent-request-error" role="alert">{{ error }}</p>
          <div v-if="!session" class="rent-review-loading">Loading the requested room and scope…</div>
          <template v-else>
            <div class="rent-review-copy"><strong>{{ request?.renterDisplayName || 'Unknown renter' }}</strong><p>{{ request?.taskPrompt }}</p><dl><div><dt>Room</dt><dd>{{ session.roomIdentifier || 'No room selected' }}</dd></div><div><dt>History</dt><dd>{{ historyAccessLabel }}</dd></div><div><dt>Workspace</dt><dd>{{ session.repoName ? `${session.repoOwner || ''}/${session.repoName} · isolated sandbox` : 'Room-only ephemeral workspace' }}</dd></div><div><dt>Duration</dt><dd>{{ session.timeLimitMinutes || request?.requestedTimeLimitMinutes || '—' }} min</dd></div></dl></div>
            <p v-if="usableRuntimes.length === 0" class="rent-review-loading">No authenticated runtime with a rental-safe sandbox is ready. Finish setup in Settings → Renting.</p>
            <label v-else>Runtime<select v-model="configuration.providerId"><option v-for="runtime in usableRuntimes" :key="runtime.providerId" :value="runtime.providerId">{{ runtime.label }}</option></select></label>
            <label>Model<input v-model.trim="configuration.model" placeholder="Use the runtime default" /></label>
            <label>Sandbox profile<select v-model="configuration.permissionProfileId"><option v-for="profile in selectedRuntime?.permissionProfileIds || []" :key="profile" :value="profile">{{ profileLabel(profile) }}</option></select></label>
            <footer><button type="button" class="rent-refresh-button" :disabled="busy" @click="emit('decline')">Decline</button><button type="button" class="rent-refresh-button" :disabled="busy" @click="close">Cancel</button><button type="button" class="rent-refresh-button rent-action-accept" :disabled="busy || !canLaunch" @click="emit('launch', configuration)">{{ busy ? 'Launching…' : 'Accept & launch' }}</button></footer>
          </template>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { DesktopRentalLaunchConfiguration, DesktopRentalProviderRuntime, DesktopRentalRequest, DesktopRentalSession } from "../../../../../electron/ipc-types";
import { currentFocusableElement, restoreFocus, trapFocusInDialog } from "./modal-focus";
const props = defineProps<{ open: boolean; request: DesktopRentalRequest | null; session: DesktopRentalSession | null; runtimes: DesktopRentalProviderRuntime[]; busy: boolean; error: string | null }>();
const emit = defineEmits<{ close: []; launch: [configuration: DesktopRentalLaunchConfiguration]; decline: [] }>();
const dialog = ref<HTMLElement | null>(null); let previousFocus: HTMLElement | null = null;
const usableRuntimes = computed(() => props.runtimes.filter((runtime) => runtime.enabled && runtime.authenticated && runtime.status === 'ready' && runtime.permissionProfileIds.length));
const configuration = ref<DesktopRentalLaunchConfiguration>({ providerId: 'cursor', model: null, permissionProfileId: 'sandboxed_write' });
const selectedRuntime = computed(() => usableRuntimes.value.find((runtime) => runtime.providerId === configuration.value.providerId) || null);
const canLaunch = computed(() => Boolean(selectedRuntime.value && configuration.value.permissionProfileId && selectedRuntime.value.permissionProfileIds.includes(configuration.value.permissionProfileId)));
const historyAccessLabel = computed(() => {
  if (props.session?.roomHistoryAccess === 'full') return 'Full room history';
  if (props.session?.roomHistoryAccess === 'filtered') return 'Filtered room history';
  return props.session?.continuityMode === 'full_transcript' ? 'Full room history' : 'Summary only';
});
watch(() => props.open, (open) => { if (open) { previousFocus = currentFocusableElement(); const runtime = usableRuntimes.value[0]; configuration.value = { providerId: runtime?.providerId || 'cursor', model: null, permissionProfileId: runtime?.permissionProfileIds[0] || null }; void nextTick(() => dialog.value?.focus({ preventScroll: true })); } else { restoreFocus(previousFocus); previousFocus = null; } });
watch(() => configuration.value.providerId, (providerId, previousProviderId) => {
  if (providerId === previousProviderId) return;
  const runtime = usableRuntimes.value.find((candidate) => candidate.providerId === providerId);
  configuration.value.model = null;
  configuration.value.permissionProfileId = runtime?.permissionProfileIds[0] || null;
});
function profileLabel(profile: string): string { return profile.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function close(): void { if (!props.busy) emit('close'); }
function onKeydown(event: KeyboardEvent): void { if (event.key === 'Escape') { event.preventDefault(); close(); return; } trapFocusInDialog(event, dialog.value); }
</script>

<style scoped src="./rent-request-review-sheet.css"></style>
