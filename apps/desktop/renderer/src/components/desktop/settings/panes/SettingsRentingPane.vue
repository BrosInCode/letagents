<template>
  <section class="settings-panel settings-renting-panel" data-testid="settings-renting-pane">
    <article class="settings-renting-profile">
      <img v-if="authStatus?.account?.avatarUrl" :src="authStatus.account.avatarUrl" alt="" />
      <span v-else class="settings-renting-avatar">{{ initials }}</span>
      <div><p>Renting out as</p><strong>{{ authStatus?.account?.displayName || authStatus?.account?.login || 'Connect GitHub' }}</strong><small v-if="authStatus?.account?.login">@{{ authStatus.account.login }}</small></div>
      <span class="state-pill" :data-state="settings?.enabled ? 'active' : 'offline'">{{ settings?.enabled ? 'discoverable' : 'not listed' }}</span>
    </article>

    <article v-if="error" class="settings-control-row" data-emphasis="warning" role="alert"><div><strong>Renting settings unavailable</strong><p class="settings-control-description">{{ error }}</p></div><button class="ghost-button" type="button" @click="load">Retry</button></article>
    <template v-else-if="settings">
      <article class="settings-control-row">
        <div><strong>Available on this Mac</strong><p class="settings-control-description">Accept new requests only while this desktop and at least one local runtime are ready.</p></div>
        <button class="settings-renting-switch" type="button" role="switch" :aria-checked="settings.enabled" :data-on="settings.enabled" :disabled="saving || (!settings.enabled && Boolean(settings.blockers.length))" @click="save({ enabled: !settings.enabled })"><span></span></button>
      </article>

      <article class="settings-renting-status"><div><span class="settings-renting-live-dot" :data-state="settings.daemonState"></span><strong>Daemon {{ settings.daemonState }}</strong><small>{{ settings.hostId || 'This desktop has not registered a host yet.' }}</small></div><span>{{ settings.blockers.length ? `${settings.blockers.length} setup item${settings.blockers.length === 1 ? '' : 's'}` : 'Ready for requests' }}</span></article>
      <article v-for="blocker in settings.blockers" :key="blocker" class="settings-control-row" data-emphasis="warning"><div><strong>Setup needed</strong><p class="settings-control-description">{{ blocker }}</p></div></article>

      <section class="settings-renting-section"><header><div><p class="settings-nav-heading">Local runtimes</p><span>Only authenticated runtimes with a verified rental sandbox can be listed.</span></div></header><div class="settings-control-list"><p v-if="settings.runtimes.length === 0" class="settings-renting-loading">No supported local runtime was found on this Mac.</p><article v-for="runtime in settings.runtimes" :key="runtime.providerId" class="settings-control-row"><div><strong>{{ runtime.label }}</strong><p class="settings-control-description">{{ runtime.authenticated ? runtime.detail : 'Sign in locally before listing this runtime.' }}</p></div><button class="settings-renting-switch" type="button" role="switch" :aria-checked="runtime.enabled" :data-on="runtime.enabled" :disabled="saving || (!runtime.enabled && (!runtime.authenticated || runtime.status !== 'ready' || !runtime.permissionProfileIds.length))" @click="toggleRuntime(runtime.providerId, !runtime.enabled)"><span></span></button></article></div></section>

      <section class="settings-renting-section"><header><div><p class="settings-nav-heading">Defaults</p><span>Every request is still manually reviewed before launch.</span></div></header><div class="settings-renting-limits"><DesktopSelectField v-model="concurrentSelection" class="settings-renting-limit-select" label="Concurrent rentals" :options="concurrentOptions" /><DesktopSelectField v-model="defaultDurationSelection" class="settings-renting-limit-select" label="Default duration" :options="defaultDurationOptions" /><button class="primary-button" :disabled="saving" type="button" @click="save(draft)">{{ saving ? 'Saving…' : 'Save defaults' }}</button></div></section>

      <article class="settings-renting-capabilities"><strong>Available now</strong><p>The daemon creates and removes a private room-only workspace, while the selected runtime sandbox enforces the file and process boundary. Raw desktop and GitHub token environment variables are not passed to rental workers. Repository access stays unavailable until the scoped repository bridge is connected.</p></article>
    </template>
    <div v-else class="settings-renting-loading">Checking this desktop…</div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import type { DesktopAuthStatus, DesktopRentalProviderSettings, DesktopRentalProviderSettingsInput, DesktopRentalRuntimeId } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc/index.js";
import DesktopSelectField from "../../controls/DesktopSelectField.vue";
const props = defineProps<{ authStatus: DesktopAuthStatus | null }>();
const settings = ref<DesktopRentalProviderSettings | null>(null);
const error = ref<string | null>(null); const saving = ref(false);
const draft = reactive<Required<Pick<DesktopRentalProviderSettingsInput, "maxConcurrentSessions" | "defaultTimeLimitMinutes">>>({ maxConcurrentSessions: 1, defaultTimeLimitMinutes: 30 });
const initials = computed(() => (props.authStatus?.account?.displayName || props.authStatus?.account?.login || 'LA').slice(0, 2).toUpperCase());
const concurrentOptions = [{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }];
const defaultDurationOptions = [{ value: '30', label: '30 minutes' }, { value: '60', label: '1 hour' }, { value: '120', label: '2 hours' }];
const concurrentSelection = computed({ get: () => String(draft.maxConcurrentSessions), set: (value: string) => { draft.maxConcurrentSessions = Number(value); } });
const defaultDurationSelection = computed({ get: () => String(draft.defaultTimeLimitMinutes), set: (value: string) => { draft.defaultTimeLimitMinutes = Number(value); } });
watch(settings, (next) => { if (!next) return; draft.maxConcurrentSessions = next.maxConcurrentSessions; draft.defaultTimeLimitMinutes = next.defaultTimeLimitMinutes; }, { immediate: true });
onMounted(() => { void load(); });
async function load(): Promise<void> { error.value = null; try { const bridge = desktopIpc.rental; if (!bridge?.getProviderSettings) throw new Error('Restart LetAgents Desktop to load renting settings.'); settings.value = await bridge.getProviderSettings(); } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not load renting settings.'; } }
async function save(input: DesktopRentalProviderSettingsInput): Promise<void> { if (!desktopIpc.rental?.updateProviderSettings) return; saving.value = true; error.value = null; try { settings.value = await desktopIpc.rental.updateProviderSettings(input); } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not save renting settings.'; } finally { saving.value = false; } }
function toggleRuntime(providerId: DesktopRentalRuntimeId, enabled: boolean): void { const runtimes = (settings.value?.runtimes || []).map((runtime) => ({ providerId: runtime.providerId, enabled: runtime.providerId === providerId ? enabled : runtime.enabled })); void save({ runtimes }); }
</script>

<style scoped src="./settings-renting.css"></style>
