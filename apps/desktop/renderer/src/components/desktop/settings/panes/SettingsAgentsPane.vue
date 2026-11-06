<template>
  <section class="settings-panel agents-portal" data-testid="settings-agents-panel" :aria-busy="busy">
    <div class="agents-portal-heading">
      <DesktopSegmentedControl v-model="tab" :options="tabs" label="Agent management" mode="tabs" tab-panel-id-prefix="agents" />
      <button v-if="supervisedAgentsSupported" type="button" class="primary-button" :disabled="!agentRooms.length" @click="addAgent">
        <Plus :size="16" aria-hidden="true" /> Add agent
      </button>
    </div>
    <Transition name="agents-reveal">
      <form v-if="choosingRoom" class="agents-add-room" @submit.prevent="openSetup">
        <DesktopSelectField v-model="addRoomId" :options="roomOptions.slice(1)" label="Add an agent to" placeholder="Choose a room" />
        <button type="submit" class="primary-button" :disabled="!addRoomId">Continue</button>
        <button type="button" class="ghost-button" @click="choosingRoom = false">Cancel</button>
      </form>
    </Transition>
    <div v-if="errors.length" class="settings-feedback" data-state="error" role="status">
      <p v-for="error in errors" :key="error">{{ error }}</p>
    </div>
    <section v-show="tab === 'roster'" id="agents-panel-roster" role="tabpanel" aria-labelledby="agents-tab-roster" class="agents-roster">
      <div class="agents-toolbar">
        <label class="agents-search"><Search :size="18" aria-hidden="true" /><input v-model="query" type="search" aria-label="Find an agent, provider, room, or task" placeholder="Find an agent, provider, room, or task…" /></label>
        <DesktopSelectField v-model="roomId" :options="roomOptions" label="Room" label-hidden test-id="agents-room-filter" />
      </div>
      <DesktopSegmentedControl :model-value="filter" :options="filters" label="Filter agents" class="agents-filters" @update:model-value="filter = $event as SettingsAgentFilter" />
      <p class="agents-count" role="status">{{ !loaded && busy ? 'Loading room agents…' : `${visibleRows.length} ${visibleRows.length === 1 ? 'agent' : 'agents'}` }}</p>
      <TransitionGroup name="agent-row" tag="ul" class="agents-list" aria-label="Room agents">
        <li v-for="agent in visibleRows" :key="agent.id" :data-testid="`settings-agent-${agent.id}`">
          <button type="button" class="agents-row" @click="emit('open-agent', { roomIdentifier: agent.roomId, agentInspector: agent.request })">
            <span class="agents-provider-mark"><ProviderBadge :label="agent.provider" :agent-key="agent.request.target.agentKey" /></span>
            <span class="agents-row-copy"><strong>{{ agent.name }}</strong><span>{{ agent.provider }} · {{ agent.roomName }}<template v-if="agent.external"> · External</template></span><span class="agents-row-summary">{{ agent.summary }}</span></span>
            <span class="agents-state" :data-attention="agent.attention" :data-stale="agent.stale"><span class="agents-state-dot" />{{ agent.status }}</span>
            <ChevronRight :size="16" aria-hidden="true" />
          </button>
          <button v-if="agent.approvals" type="button" class="ghost-button agents-approval" @click="emit('open-agent', { roomIdentifier: agent.roomId, approvals: true })">Review {{ agent.approvals }} {{ agent.approvals === 1 ? 'approval' : 'approvals' }}</button>
        </li>
      </TransitionGroup>
      <div v-if="!visibleRows.length && !busy" class="agents-empty">
        <Bot :size="28" aria-hidden="true" />
        <strong>{{ rows.length ? 'No matching agents.' : errors.length ? 'Agent list unavailable.' : 'No agents yet.' }}</strong>
        <p>{{ rows.length ? 'Try another room or filter, or clear your search.' : agentRooms.length ? 'Add an agent to a room to get started.' : 'Join a room to manage its agents here.' }}</p>
        <button v-if="rows.length" type="button" class="ghost-button" @click="query = ''; roomId = ''; filter = 'all'">Clear filters</button>
      </div>
      <p class="settings-muted-note agents-inspector-note">Open an agent for its room inspector, context window, usage limits, and available controls.</p>
    </section>
    <section v-show="tab === 'providers'" id="agents-panel-providers" role="tabpanel" aria-labelledby="agents-tab-providers" class="agents-providers">
      <p class="settings-muted-note">Manage agents on this computer through their room inspector. External agents are controlled by their own host. Availability and sign-in are checked in agent setup.</p>
      <ul class="agents-list" aria-label="Agent providers">
        <li v-for="provider in providers" :key="provider.id" class="agents-provider-row">
          <ProviderBadge :label="provider.name" />
          <div><strong>{{ provider.name }}</strong><p>{{ provider.description }}</p><p class="agents-capabilities">{{ providerAccess(provider) }}</p></div>
        </li>
      </ul>
      <p v-if="!providers.length && !busy" class="settings-muted-note">Provider information is unavailable. Try Refresh.</p>
      <button type="button" class="ghost-button" @click="emit('open-connectors')">Manage agent app connections <ArrowUpRight :size="15" aria-hidden="true" /></button>
    </section>
    <div class="agents-defaults">
    <SupervisedAgentsUnavailableNotice v-if="!supervisedAgentsSupported" />
    <div v-else class="settings-control-list">
      <SettingsRow
        title="Commit as your GitHub account"
        :description="commitIdentityDescription"
        description-id="settings-agent-commit-identity-description"
      >
        <template #action>
          <DesktopSwitch
            label="Commit as your GitHub account"
            describedby="settings-agent-commit-identity-description"
            test-id="settings-agent-commit-identity"
            :checked="commitIdentity ? !commitIdentity.useHostGitIdentity : false"
            :busy="commitIdentityBusy"
            :disabled="!commitIdentity"
            @toggle="toggleCommitIdentity"
          />
        </template>
      </SettingsRow>
    </div>

    <p
      v-if="supervisedAgentsSupported && commitIdentityError"
      class="settings-feedback"
      data-state="error"
      data-testid="settings-agent-commit-identity-feedback"
    >
      {{ commitIdentityError }}
    </p>

    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ArrowUpRight, Bot, ChevronRight, Plus, Search } from "@lucide/vue";
import { useSettingsAgents } from "../../../../composables/useSettingsAgents";
import { filterSettingsAgents, type SettingsAgentFilter } from "../../../../domain/settings-agents";
import type { AttentionNavigationIntent } from "../../content/room-shell/types";
import DesktopSelectField from "../../controls/DesktopSelectField.vue";
import DesktopSegmentedControl from "../../controls/DesktopSegmentedControl.vue";
import ProviderBadge from "../../content/desktop-chat-message/ProviderBadge.vue";
import { desktopIpc } from "../../../../ipc/index.js";
import type {
  DesktopAccountRoomEntry,
  DesktopAgentCommitIdentitySettings,
  DesktopAgentProvider,
} from "../../../../../../electron/ipc-types";
import DesktopSwitch from "../../controls/DesktopSwitch.vue";
import { agentCommitIdentityDescription } from "../presentation";
import SettingsRow from "../SettingsRow.vue";
import SupervisedAgentsUnavailableNotice from "../../content/SupervisedAgentsUnavailableNotice.vue";
import { supervisedAgentsSupported } from "../../../../domain/supervised-agents-support";

const props = defineProps<{
  rooms?: DesktopAccountRoomEntry[];
}>();

const emit = defineEmits<{ "open-agent": [intent: AttentionNavigationIntent]; "open-connectors": [] }>();
const { rooms: agentRooms, rows, providers, busy, loaded, errors, refresh } = useSettingsAgents(() => props.rooms ?? []);
const tab = ref("roster");
const query = ref("");
const roomId = ref("");
const filter = ref<SettingsAgentFilter>("all");
const choosingRoom = ref(false);
const addRoomId = ref("");
const tabs = computed(() => [{ id: "roster", label: "Room agents", count: rows.value.filter(row => !row.retired).length }, { id: "providers", label: "Providers & access" }]);
const roomOptions = computed(() => [{ value: "", label: "All joined rooms" }, ...agentRooms.value.map(room => ({ value: room.id, label: room.name }))]);
const filters = computed(() => [
  { id: "all", label: "All agents" },
  { id: "attention", label: "Needs attention", count: rows.value.filter(row => row.attention && (!roomId.value || row.roomId === roomId.value)).length },
  { id: "active", label: "Active" }, { id: "paused", label: "Paused" },
  { id: "external", label: "External" }, { id: "retired", label: "Retired" },
]);
const visibleRows = computed(() => filterSettingsAgents(rows.value, filter.value, roomId.value, query.value));
watch(agentRooms, rooms => {
  if (!rooms.some(room => room.id === roomId.value)) roomId.value = "";
  if (!rooms.some(room => room.id === addRoomId.value)) addRoomId.value = "";
});
function addAgent(): void {
  addRoomId.value = roomId.value || (agentRooms.value.length === 1 ? agentRooms.value[0]!.id : "");
  if (addRoomId.value) openSetup();
  else choosingRoom.value = true;
}
function openSetup(): void {
  if (!supervisedAgentsSupported.value || !agentRooms.value.some(room => room.id === addRoomId.value)) return;
  choosingRoom.value = false;
  emit("open-agent", { roomIdentifier: addRoomId.value, addAgent: true });
}
function providerAccess(provider: DesktopAgentProvider): string {
  const labels = [];
  if (supervisedAgentsSupported.value && provider.capabilities.includes("supervised_runtime")) labels.push("Managed in rooms");
  if (provider.capabilities.includes("external_mcp")) labels.push("Connect through MCP");
  if (provider.capabilities.includes("turn_control")) labels.push("Turn controls");
  if (provider.capabilities.includes("reasoning_stream")) labels.push("Live activity");
  return labels.join(" · ") || "See agent setup for available access";
}
defineExpose({ refresh, busy });

const commitIdentity = ref<DesktopAgentCommitIdentitySettings | null>(null);
const commitIdentityBusy = ref(false);
const commitIdentityError = ref<string | null>(null);

const commitIdentityDescription = computed(() => agentCommitIdentityDescription(commitIdentity.value));

// How agents commit matters only where this app runs agents.
onMounted(() => { if (supervisedAgentsSupported.value) void loadCommitIdentity(); });

async function loadCommitIdentity(): Promise<void> {
  try {
    const bridge = desktopIpc.agentCommitIdentity;
    if (!bridge?.getSettings) throw new Error("Restart LetAgents Desktop to change how agents commit.");
    commitIdentity.value = await bridge.getSettings();
    commitIdentityError.value = null;
  } catch (cause) {
    commitIdentityError.value = cause instanceof Error ? cause.message : "Could not load how agents commit.";
  }
}

async function toggleCommitIdentity(): Promise<void> {
  const current = commitIdentity.value;
  const bridge = desktopIpc.agentCommitIdentity;
  if (!current || !bridge?.setUseHostGitIdentity || commitIdentityBusy.value) return;
  commitIdentityBusy.value = true;
  commitIdentityError.value = null;
  try {
    commitIdentity.value = await bridge.setUseHostGitIdentity(!current.useHostGitIdentity);
  } catch (cause) {
    commitIdentityError.value = cause instanceof Error ? cause.message : "Could not save how agents commit.";
  } finally {
    commitIdentityBusy.value = false;
  }
}

</script>

<style scoped>
.agents-portal { display: grid; gap: 24px; max-width: 1120px; }
.agents-portal-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.agents-portal-heading .primary-button { white-space: nowrap; }
.agents-roster, .agents-providers { min-width: 0; }
.agents-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 240px); gap: 12px; margin-bottom: 14px; }
.agents-search { display: flex; align-items: center; gap: 10px; padding: 0 14px; min-height: 42px; border: 1px solid var(--border); border-radius: 12px; color: var(--text-tertiary); }
.agents-search:focus-within { outline: 2px solid var(--blue); outline-offset: 2px; }
.agents-search input { min-width: 0; width: 100%; border: 0; outline: 0; color: var(--text); background: transparent; font: inherit; font-size: .85rem; }
.agents-toolbar :deep(.desktop-select-control select) { min-height: 42px; }
.agents-filters { width: fit-content; max-width: 100%; overflow-x: auto; }
.agents-filters :deep(button) { white-space: nowrap; }
.agents-count { margin: 22px 0 10px; color: var(--text-tertiary); font-size: .78rem; }
.agents-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.agents-list:empty { display: none; }
.agents-list li + li { border-top: 1px solid var(--border); }
.agents-row { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto 16px; align-items: center; gap: 16px; width: 100%; padding: 20px; border: 0; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; transition: background 160ms ease-out; }
.agents-row:hover { background: var(--accent-hover); }
.agents-row:focus-visible { outline: 2px solid var(--blue); outline-offset: -3px; }
.agents-provider-mark { display: grid; place-items: center; width: 40px; height: 40px; border: 1px solid var(--border); border-radius: 12px; }
.agents-provider-mark :deep(.room-provider-badge) { width: 26px; height: 26px; background: transparent; }
.agents-provider-mark :deep(img) { width: 24px; height: 24px; }
.agents-row-copy { display: grid; gap: 6px; min-width: 0; }
.agents-row-copy strong { font-size: .94rem; font-weight: 600; }
.agents-row-copy > span { color: var(--text-tertiary); font-size: .78rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agents-row-copy .agents-row-summary { color: var(--text-secondary); margin-top: 3px; }
.agents-state { display: inline-flex; gap: 7px; align-items: center; color: var(--text-secondary); font-size: .77rem; }
.agents-state[data-attention="true"] { color: var(--amber-text); }
.agents-state[data-stale="true"] { color: var(--text-tertiary); }
.agents-state-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
.agents-approval { margin: 0 20px 14px 76px; }
.agents-empty { display: grid; justify-items: center; gap: 12px; padding: 48px 20px; text-align: center; color: var(--text-secondary); }
.agents-empty p { margin: 0; font-size: .85rem; }
.agents-inspector-note { margin-top: 16px; }
.agents-providers { display: grid; gap: 18px; }
.agents-provider-row { display: flex; gap: 14px; padding: 20px; }
.agents-provider-row p { margin: 6px 0 0; color: var(--text-secondary); font-size: .82rem; line-height: 1.5; }
.agents-provider-row .agents-capabilities { color: var(--text-tertiary); font-size: .76rem; }
.agents-providers > button { justify-self: start; }
.agents-defaults { padding-top: 20px; border-top: 1px solid var(--border); }
.agents-add-room { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; }
.agents-add-room > label { flex: 1; min-width: 180px; }
.agent-row-enter-active, .agents-reveal-enter-active { transition: opacity 180ms ease-out, transform 180ms ease-out; }
.agent-row-enter-from, .agents-reveal-enter-from { opacity: 0; transform: translateY(4px); }
.agent-row-move { transition: transform 180ms ease-out; }
@media (max-width: 700px) {
  .agents-toolbar { grid-template-columns: minmax(0, 1fr); }
  .agents-row { grid-template-columns: 32px minmax(0, 1fr) 16px; gap: 12px; padding: 16px; }
  .agents-provider-mark { width: 32px; height: 32px; }
  .agents-state { grid-column: 2; grid-row: 2; }
  .agents-row > svg { grid-column: 3; grid-row: 1 / 3; }
  .agents-approval { margin-left: 60px; }
  .agents-portal-heading :deep(.desktop-segmented-control) { max-width: 100%; overflow-x: auto; }
  .agents-portal-heading :deep(button) { white-space: nowrap; }
}
@media (prefers-reduced-motion: reduce) {
  .agents-portal *, .agent-row-enter-active, .agent-row-move, .agents-reveal-enter-active { transition: none !important; transform: none !important; }
}
</style>
