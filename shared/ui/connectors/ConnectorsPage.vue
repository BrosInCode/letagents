<template>
  <section class="connectors-page" data-testid="connectors-page">
    <header class="connectors-header">
      <h1>Connectors</h1>
      <div class="connector-actions">
        <button
          class="connector-icon"
          type="button"
          aria-label="Refresh connectors"
          :disabled="loading"
          @click="refreshAll"
        >
          ↻</button
        ><button class="connector-secondary" @click="openCatalog('all')">
          <span aria-hidden="true">＋</span> Add connector
        </button>
      </div>
    </header>
    <div
      class="connector-tabs"
      role="tablist"
      aria-label="Connector categories"
      @keydown="tabKey($event, false)"
    >
      <button
        v-for="item in tabs"
        :id="`${id}-${item.id}`"
        :key="item.id"
        role="tab"
        :aria-selected="tab === item.id"
        :tabindex="tab === item.id ? 0 : -1"
        :aria-controls="`${id}-list`"
        @click="tab = item.id"
      >
        {{ item.label }}<span>{{ count(item.id) }}</span>
      </button>
    </div>
    <p v-if="loading && !loaded" class="connector-empty" role="status">
      Loading your connections…
    </p>
    <p v-if="trackerError" class="connector-notice" role="status">
      {{ trackerError }}
      <button class="connector-text" :disabled="loading" @click="refreshAll">
        Try again
      </button>
    </p>
    <p v-if="notConfigured" class="connector-notice">
      {{ CONNECTORS_NOT_CONFIGURED_MESSAGE }}
    </p>
    <p v-if="remoteError" class="connector-notice" role="status">
      {{ remoteError }}
      <button class="connector-text" :disabled="loading" @click="refreshAll">
        Try again
      </button>
    </p>
    <div :id="`${id}-list`" role="tabpanel" :aria-labelledby="`${id}-${tab}`">
      <template v-for="kind in kinds" :key="kind.id">
        <section
          v-if="(tab === 'all' || tab === kind.id) && rowsFor(kind.id).length"
          class="connector-section"
        >
          <div class="connector-section-heading">
            <h2>{{ kind.label }}</h2>
            <span>{{ rowsFor(kind.id).length }}</span
            ><span class="connector-section-context">{{ kind.context }}</span>
          </div>
          <p v-if="tab !== 'all'" class="connector-category-intro">
            {{ kind.intro }}
          </p>
          <div class="connector-list">
            <button
              v-for="row in rowsFor(kind.id)"
              :key="row.id"
              class="connector-row"
              @click="openRow(row)"
            >
              <ProviderLogo :provider="row.provider" /><span
                class="connector-row-content"
                ><strong>{{ row.name }}</strong
                ><small>{{ row.meta }}</small></span
              ><span class="connector-status" :data-attention="row.attention">{{
                row.status
              }}</span
              ><span class="connector-chevron" aria-hidden="true">›</span>
            </button>
          </div>
        </section>
      </template>
      <section
        v-if="
          loaded &&
          kinds.some(
            (kind) =>
              (tab === 'all' || tab === kind.id) && !rowsFor(kind.id).length,
          )
        "
        class="connector-discover"
      >
        <h2>
          {{
            tab === "all"
              ? "More ways to connect"
              : tabs.find((item) => item.id === tab)?.label
          }}
        </h2>
        <button
          v-for="kind in kinds.filter(
            (item) =>
              (tab === 'all' || tab === item.id) && !rowsFor(item.id).length,
          )"
          :key="kind.id"
          class="connector-discover-row"
          @click="openCatalog(kind.id)"
        >
          <span aria-hidden="true">{{ kind.symbol }}</span
          ><span
            ><strong>{{ kind.prompt }}</strong
            ><small>{{ kind.intro }}</small></span
          ><span aria-hidden="true">›</span>
        </button>
      </section>
    </div>
    <dialog
      ref="catalogDialog"
      class="connector-dialog connector-catalog"
      :aria-labelledby="`${id}-catalog-title`"
      @cancel.prevent="closeCatalog"
      @click="outside($event, 'catalog')"
    >
      <div class="connector-dialog-toolbar">
        <h2 :id="`${id}-catalog-title`">Add connector</h2>
        <button
          class="connector-icon"
          aria-label="Close catalog"
          @click="closeCatalog"
        >
          ×
        </button>
      </div>
      <div
        class="connector-tabs"
        role="tablist"
        aria-label="Catalog categories"
        @keydown="tabKey($event, true)"
      >
        <button
          v-for="item in tabs"
          :key="item.id"
          role="tab"
          :aria-selected="catalogTab === item.id"
          :tabindex="catalogTab === item.id ? 0 : -1"
          @click="catalogTab = item.id"
        >
          {{ item.label }}
        </button>
      </div>
      <div class="connector-catalog-body">
        <section
          v-for="kind in kinds.filter(
            (item) => catalogTab === 'all' || catalogTab === item.id,
          )"
          :key="kind.id"
        >
          <h3>{{ kind.label }}</h3>
          <button
            v-for="entry in catalog.filter((item) => item.kind === kind.id)"
            :key="entry.id"
            class="connector-catalog-option"
            :disabled="!!entry.unavailable"
            @click="chooseCatalog(entry.id)"
          >
            <ProviderLogo :provider="entry.id" /><span
              ><strong>{{ entry.name }}</strong
              ><small>{{ entry.unavailable || entry.description }}</small></span
            ><span aria-hidden="true">›</span>
          </button>
        </section>
      </div>
    </dialog>
    <dialog
      ref="detailDialog"
      class="connector-dialog connector-detail"
      :aria-labelledby="`${id}-detail-title`"
      @cancel.prevent="closeDetail"
      @click="outside($event, 'detail')"
    >
      <div class="connector-dialog-toolbar">
        <button class="connector-text" @click="closeDetail">← Back</button
        ><button
          class="connector-icon"
          aria-label="Close connector details"
          @click="closeDetail"
        >
          ×
        </button>
      </div>
      <div v-if="selection" class="connector-detail-body">
        <header class="connector-detail-heading">
          <ProviderLogo :provider="selection.provider" />
          <div>
            <h2 :id="`${id}-detail-title`">{{ selection.name }}</h2>
            <p>
              {{
                selection.kind === "tracker"
                  ? "Tracker"
                  : selection.kind === "agent"
                    ? "Agent app"
                    : "Remote connector"
              }}
            </p>
          </div>
        </header>
        <TrackerSetup
          v-if="selection.setup && selection.kind === 'tracker'"
          :key="`setup-${selection.provider}`"
          :provider="selection.provider as TrackerProvider"
          :api="api.trackers"
          :availability="providers?.[selection.provider as TrackerProvider]"
          @connected="connected"
          @cancel="closeDetail"
        />
        <TrackerDetails
          v-else-if="selectedTracker"
          :key="selectedTracker.id"
          :connection="selectedTracker"
          :api="trackerDetailsApi"
          :disclosure="disclosure"
          @updated="replaceTracker"
          @reconnect="reconnect"
        />
        <template v-else-if="selection.kind === 'agent'"
          ><div class="connector-detail-state">
            <span
              class="connector-status"
              :data-attention="selectedAgent?.status === 'needs_attention'"
              >{{
                !desktop
                  ? "Desktop setup"
                  : selectedAgent?.status === "installed"
                    ? "Configured"
                    : selectedAgent?.status === "needs_attention"
                      ? "Needs attention"
                      : "Not configured"
              }}</span
            ><button
              v-if="desktop"
              class="connector-secondary"
              @click="$emit('refresh-agents')"
            >
              Check setup
            </button>
          </div>
          <p class="connector-detail-summary">
            {{ selection.name }} can use LetAgents to join rooms, read
            conversations, and work with your team’s board.
          </p>
          <section class="connector-detail-section">
            <h3>Set up on this computer</h3>
            <p v-if="desktop">
              Configured means this app has a LetAgents configuration. It does
              not mean an agent is running. Active agents and their work live in
              your rooms.
            </p>
            <p v-else>
              Open Connectors in the LetAgents desktop app to inspect or
              configure agent apps on your computer. The web app cannot read or
              change local configuration.
            </p>
            <p v-if="selectedAgent?.configIssue" class="connector-notice">
              {{ selectedAgent.configIssue }}
            </p>
            <button
              v-if="desktop"
              class="connector-secondary"
              @click="setupAgent"
            >
              {{
                selectedAgent?.status === "installed"
                  ? "Review setup"
                  : "Set up app"
              }}
            </button>
          </section>
          <ConnectorDisclosure v-if="selectedAgent" title="Configuration"
            ><div
              v-for="path in selectedAgent.configPaths"
              :key="path.path"
              class="connector-config-path"
            >
              <strong>{{ path.label }}</strong
              ><code>{{ path.path }}</code>
              <p>
                {{
                  path.issue ||
                  (path.hasLetAgents
                    ? "LetAgents is configured here."
                    : "LetAgents is not configured here.")
                }}
              </p>
            </div>
            <code v-if="!selectedAgent.configPaths.length">{{
              selectedAgent.configPath
            }}</code></ConnectorDisclosure
          ></template
        >
        <template v-else-if="selectedRemote"
          ><div class="connector-detail-state">
            <span class="connector-status">Connected</span>
          </div>
          <p>
            This app uses LetAgents tools with your account’s existing room
            permissions.
          </p>
          <dl class="connector-facts">
            <div>
              <dt>App</dt>
              <dd>{{ selectedRemote.client_name || "Unnamed app" }}</dd>
            </div>
            <div>
              <dt>Returns to</dt>
              <dd>
                {{
                  selectedRemote.redirect_hosts.join(", ") ||
                  "No redirect host provided"
                }}
              </dd>
            </div>
            <div>
              <dt>Connected</dt>
              <dd>{{ date(selectedRemote.created_at) }}</dd>
            </div>
            <div>
              <dt>Last used</dt>
              <dd>{{ date(selectedRemote.last_used_at) }}</dd>
            </div>
          </dl>
          <section class="connector-detail-section">
            <h3>Account access</h3>
            <p>
              Can join rooms, read and send messages, and manage work through
              LetAgents tools. Your existing room access still applies.
            </p>
          </section>
          <p v-if="detailFeedback" class="connector-feedback" role="status">
            {{ detailFeedback }}
          </p>
          <div class="connector-danger">
            <p>Disconnecting ends this app’s access immediately.</p>
            <div v-if="confirmRemote" class="connector-actions">
              <button
                class="connector-danger-button"
                :disabled="remoteBusy"
                @click="disconnectRemote"
              >
                Confirm disconnect</button
              ><button
                class="connector-secondary"
                :disabled="remoteBusy"
                @click="confirmRemote = false"
              >
                Cancel
              </button>
            </div>
            <button
              v-else
              class="connector-danger-button"
              @click="confirmRemote = true"
            >
              Disconnect
            </button>
          </div></template
        >
        <template v-else-if="selection.kind === 'remote'"
          ><p class="connector-detail-summary">
            Use LetAgents from an app that supports remote MCP connectors, such
            as Claude on the web.
          </p>
          <ol class="connector-steps">
            <li>
              <strong>Add a custom connector</strong>
              <p>In your app’s connector settings, use this URL.</p>
              <div class="connector-code">
                <code>{{ remoteUrl }}</code
                ><button class="connector-secondary" @click="copyUrl">
                  Copy
                </button>
              </div>
            </li>
            <li>
              <strong>Connect your account</strong>
              <p>
                Leave OAuth client ID and secret blank. Choose Connect, sign in
                with GitHub if needed, and check the app name before approving.
              </p>
            </li>
            <li>
              <strong>Join your room</strong>
              <p>
                Ask the app to use <code>join_room</code>, then
                <code>register_agent_session</code>. Approved apps appear here
                so you can review or end their access.
              </p>
            </li>
          </ol>
          <p v-if="detailFeedback" role="status">
            {{ detailFeedback }}
          </p></template
        >
      </div>
    </dialog>
  </section>
</template>
<script setup lang="ts">
import { safeUserVisibleErrorDetail } from "../../../apps/desktop/renderer/src/domain/user-visible-error";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch,
} from "vue";
import {
  CONNECTORS_NOT_CONFIGURED_MESSAGE,
  trackerProviderLabel,
  type TrackerConnectionView,
  type TrackerProvider,
  type TrackerProviderAvailability,
} from "../../ticket-connectors.mjs";
import type { AgentTarget, ConnectorsApi, ConnectorTab } from "./types";
import ProviderLogo from "./ProviderLogo.vue";
import ConnectorDisclosure from "./ConnectorDisclosure.vue";
import TrackerDetails from "./TrackerDetails.vue";
import TrackerSetup from "./TrackerSetup.vue";
import "./connectors.css";
const props = withDefaults(
  defineProps<{
    api: ConnectorsApi;
    agentTargets?: AgentTarget[];
    desktop?: boolean;
    remoteUrl: string;
    initialTab?: ConnectorTab;
  }>(),
  { agentTargets: () => [], desktop: false, initialTab: "all" },
);
const emit = defineEmits<{
  "setup-agent": [id: AgentTarget["id"]];
  "refresh-agents": [];
}>();
type Kind = Exclude<ConnectorTab, "all">;
type Row = {
  id: string;
  provider: string;
  kind: Kind;
  name: string;
  meta: string;
  status: string;
  attention?: boolean;
  setup?: boolean;
};
const id = `connectors-${useId()}`,
  tab = ref<ConnectorTab>(props.initialTab),
  catalogTab = ref<ConnectorTab>("all");
const tabs: [
  { id: ConnectorTab; label: string },
  ...{ id: ConnectorTab; label: string }[],
] = [
  { id: "all", label: "All" },
  { id: "tracker", label: "Trackers" },
  { id: "agent", label: "Agent apps" },
  { id: "remote", label: "Remote sign-ins" },
];
const kinds: {
  id: Kind;
  label: string;
  context: string;
  intro: string;
  prompt: string;
  symbol: string;
}[] = [
  {
    id: "tracker",
    label: "Trackers",
    context: "Tickets for your boards",
    intro: "Connect once, then choose which tickets each room imports.",
    prompt: "Bring in your tickets",
    symbol: "↗",
  },
  {
    id: "agent",
    label: "Agent apps",
    context: props.desktop ? "On this computer" : "Desktop setup",
    intro: props.desktop
      ? "Apps configured on this computer. Configured does not mean an agent is running."
      : "Set up local agent apps in LetAgents desktop.",
    prompt: "Connect an agent app",
    symbol: "⌘",
  },
  {
    id: "remote",
    label: "Remote sign-ins",
    context: "Access to your account",
    intro: "Apps you have authorized to use LetAgents remotely.",
    prompt: "Use LetAgents from a remote app",
    symbol: "☁",
  },
];
const trackers = ref<TrackerConnectionView[]>([]),
  remotes = ref<
    Awaited<ReturnType<ConnectorsApi["remote"]["list"]>>["connections"]
  >([]),
  providers = ref<Record<TrackerProvider, TrackerProviderAvailability> | null>(
    null,
  ),
  disclosure = ref("");
const loading = ref(false),
  loaded = ref(false),
  notConfigured = ref(false),
  trackerError = ref(""),
  remoteError = ref("");
let live = true,
  version = 0,
  request = 0;
const catalogDialog = ref<HTMLDialogElement>(),
  detailDialog = ref<HTMLDialogElement>(),
  selection = ref<Row | null>(null);
let returnFocus: HTMLElement | null = null;
let panelRequest = 0;
const detailFeedback = ref(""),
  confirmRemote = ref(false),
  remoteBusy = ref(false);
const names: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "Antigravity",
};
const date = (value: string) => {
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "Not recorded";
};
const rows = computed<Row[]>(() => [
  ...trackers.value.map((c) => ({
    id: c.id,
    provider: c.provider,
    kind: "tracker" as const,
    name: trackerProviderLabel(c.provider),
    meta: [
      c.display_name,
      c.provider === "github" ? "Issues read access" : c.tracker_user_label,
    ]
      .filter(Boolean)
      .join(" · "),
    status:
      c.status === "active"
        ? "Connected"
        : c.status === "needs_reauth"
          ? "Reconnect"
          : "Needs attention",
    attention: c.status !== "active",
  })),
  ...props.agentTargets.map((a) => ({
    id: `agent:${a.id}`,
    provider: a.id,
    kind: "agent" as const,
    name: a.name,
    meta: "On this computer",
    status:
      a.status === "installed"
        ? "Configured"
        : a.status === "needs_attention"
          ? "Needs attention"
          : "Not configured",
    attention: a.status === "needs_attention",
  })),
  ...remotes.value.map((r) => ({
    id: `remote:${r.id}`,
    provider: "remote",
    kind: "remote" as const,
    name: r.client_name || "Unnamed app",
    meta: `${r.redirect_hosts.join(", ")} · Last used ${date(r.last_used_at)}`,
    status: "Connected",
  })),
]);
const rowsFor = (kind: ConnectorTab) =>
  kind === "all" ? rows.value : rows.value.filter((row) => row.kind === kind);
const count = (kind: ConnectorTab) => rowsFor(kind).length;
const catalog = computed(() => [
  ...(["jira", "linear", "github"] as TrackerProvider[]).map((provider) => ({
    id: provider,
    name: trackerProviderLabel(provider),
    kind: "tracker" as const,
    description:
      provider === "github"
        ? "Import issues with the LetAgents GitHub App. No token needed."
        : `Bring ${trackerProviderLabel(provider)} tickets and their status into your boards.`,
    unavailable: notConfigured.value
      ? CONNECTORS_NOT_CONFIGURED_MESSAGE
      : trackerError.value
        ? "Tracker availability could not be loaded. Refresh and try again."
        : !providers.value
          ? "Checking availability…"
          : provider === "github" && !providers.value.github.github_app
            ? "This server has no GitHub App."
            : provider !== "github" &&
                !providers.value[provider].api_token &&
                !providers.value[provider].oauth
              ? "This provider is unavailable."
              : null,
  })),
  ...Object.entries(names).map(([key, name]) => ({
    id: key,
    name,
    kind: "agent" as const,
    description: props.desktop
      ? `Use LetAgents tools from ${name} on this computer.`
      : "Configure this agent app in LetAgents desktop.",
    unavailable: null,
  })),
  {
    id: "remote",
    name: "Remote connector",
    kind: "remote" as const,
    description: "Use LetAgents from an app that supports remote connectors.",
    unavailable: null,
  },
]);
const selectedTracker = computed(() =>
  selection.value?.kind === "tracker" && !selection.value.setup
    ? trackers.value.find((c) => c.id === selection.value?.id)
    : undefined,
);
const selectedAgent = computed(() =>
  props.agentTargets.find((a) => a.id === selection.value?.provider),
);
const selectedRemote = computed(() =>
  remotes.value.find((r) => `remote:${r.id}` === selection.value?.id),
);
function errorText(error: unknown, fallback: string) {
  return safeUserVisibleErrorDetail(error, fallback);
}
async function refresh() {
  if (loading.value) return;
  loading.value = true;
  const current = ++request,
    revision = version;
  const results = await Promise.allSettled([
    props.api.trackers.list(),
    props.api.remote.list(),
  ]);
  if (!live || current !== request) return;
  loading.value = false;
  loaded.value = true;
  if (revision !== version) return;
  const [tracker, remote] = results;
  if (tracker.status === "fulfilled") {
    trackers.value = tracker.value.connections;
    providers.value = tracker.value.providers;
    disclosure.value = tracker.value.jev_linking_disclosure;
    notConfigured.value = tracker.value.not_configured === true;
    trackerError.value = "";
  } else {
    trackerError.value = errorText(
      tracker.reason,
      "Trackers could not be loaded.",
    );
  }
  if (remote.status === "fulfilled") {
    remotes.value = remote.value.connections;
    remoteError.value = "";
  } else
    remoteError.value = errorText(
      remote.reason,
      "Remote sign-ins could not be loaded.",
    );
}
watch(
  () => props.initialTab,
  (value) => {
    tab.value = value;
  },
);
onMounted(() => {
  void refresh();
  window.addEventListener("focus", onFocus);
});
onBeforeUnmount(() => {
  live = false;
  request++;
  window.removeEventListener("focus", onFocus);
  catalogDialog.value?.close();
  detailDialog.value?.close();
});
function refreshAll() {
  if (props.desktop) emit("refresh-agents");
  void refresh();
}
function onFocus() {
  void refresh();
}
watch(rows, () => {
  const current = selection.value;
  if (
    current &&
    !current.setup &&
    !rows.value.some((row) => row.id === current.id)
  )
    closeDetail();
});
function restoreFocus() {
  void nextTick(() => {
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  });
}
function openCatalog(kind: ConnectorTab) {
  returnFocus = document.activeElement as HTMLElement;
  catalogTab.value = kind;
  catalogDialog.value?.showModal();
}
function closeCatalog() {
  catalogDialog.value?.close();
  restoreFocus();
}
async function openRow(row: Row, fromCatalog = false) {
  const opening = ++panelRequest;
  if (!fromCatalog) returnFocus = document.activeElement as HTMLElement;
  selection.value = row;
  confirmRemote.value = false;
  detailFeedback.value = "";
  await nextTick();
  const dialog = detailDialog.value;
  if (
    !live ||
    opening !== panelRequest ||
    selection.value?.id !== row.id ||
    !dialog?.isConnected
  )
    return;
  dialog.showModal();
  dialog.querySelector(".connector-detail-body")?.scrollTo(0, 0);
}
function chooseCatalog(key: string) {
  const entry = catalog.value.find((c) => c.id === key);
  if (!entry || entry.unavailable) return;
  catalogDialog.value?.close();
  void openRow(
    {
      id: `setup:${key}`,
      provider: key,
      name: entry.name,
      kind: entry.kind,
      meta: "",
      status: "",
      setup: true,
    },
    true,
  );
}
function closeDetail() {
  panelRequest++;
  detailDialog.value?.close();
  selection.value = null;
  restoreFocus();
}
function outside(event: MouseEvent, kind: "catalog" | "detail") {
  const dialog = kind === "catalog" ? catalogDialog.value : detailDialog.value;
  if (event.target !== dialog || !dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  ) {
    if (kind === "catalog") closeCatalog();
    else closeDetail();
  }
}
function replaceTracker(connection: TrackerConnectionView) {
  version++;
  const index = trackers.value.findIndex((c) => c.id === connection.id);
  if (index < 0) trackers.value.push(connection);
  else trackers.value.splice(index, 1, connection);
}
function connected(connection: TrackerConnectionView) {
  replaceTracker(connection);
  selection.value = rows.value.find((r) => r.id === connection.id) || null;
}
function removeTracker(id: string) {
  version++;
  trackers.value = trackers.value.filter((c) => c.id !== id);
  if (selection.value?.id === id) closeDetail();
}
// The account page owns completion; its detail can close while the request runs.
const trackerDetailsApi = computed<ConnectorsApi["trackers"]>(() => ({
  ...props.api.trackers,
  remove: async (id) => {
    await props.api.trackers.remove(id);
    if (live) removeTracker(id);
  },
}));
function reconnect(provider: TrackerProvider) {
  selection.value = {
    id: `setup:${provider}`,
    provider,
    kind: "tracker",
    name: trackerProviderLabel(provider),
    meta: "",
    status: "",
    setup: true,
  };
}
function setupAgent() {
  const target = selection.value?.provider as AgentTarget["id"];
  closeDetail();
  emit("setup-agent", target);
}
async function disconnectRemote() {
  const remote = selectedRemote.value;
  if (!remote || remoteBusy.value) return;
  remoteBusy.value = true;
  detailFeedback.value = "";
  try {
    await props.api.remote.disconnect(remote.id);
    if (!live) return;
    version++;
    remotes.value = remotes.value.filter((r) => r.id !== remote.id);
    if (selection.value?.id === `remote:${remote.id}`) closeDetail();
  } catch (error) {
    if (live && selection.value?.id === `remote:${remote.id}`)
      detailFeedback.value = errorText(
        error,
        "Could not disconnect. Try again.",
      );
  } finally {
    if (live) remoteBusy.value = false;
  }
}
async function copyUrl() {
  try {
    await navigator.clipboard.writeText(props.remoteUrl);
    if (live) detailFeedback.value = "Connector URL copied.";
  } catch {
    if (live)
      detailFeedback.value =
        "Could not copy. Select the URL and copy it manually.";
  }
}
function tabKey(event: KeyboardEvent, catalog: boolean) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const current = catalog ? catalogTab : tab;
  const index = tabs.findIndex((item) => item.id === current.value);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
          tabs.length;
  current.value = tabs[next].id;
  (event.currentTarget as HTMLElement)
    .querySelectorAll<HTMLButtonElement>('[role="tab"]')
    [next]?.focus();
}
defineExpose({ refresh });
</script>
