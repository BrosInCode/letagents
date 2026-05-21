<template>
  <Teleport to="body">
    <Transition name="room-panel">
      <div
        v-if="open && session"
        class="desktop-rules-backdrop"
        data-testid="rent-session-detail-modal"
        @click.self="$emit('close')"
      >
        <section
          class="desktop-rules-dialog rent-detail-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rent-detail-title"
        >
          <header class="desktop-rules-header">
            <div>
              <p>Rental session</p>
              <h2 id="rent-detail-title">{{ session.taskTitle }}</h2>
            </div>
            <button type="button" aria-label="Close" @click="$emit('close')">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
            </button>
          </header>

          <div class="rent-detail-summary">
            <div>
              <p class="rent-detail-label">Session ID</p>
              <code>{{ session.id }}</code>
            </div>
            <div>
              <p class="rent-detail-label">Status</p>
              <span class="state-pill" :data-state="statusState(session.status)">{{ session.status }}</span>
            </div>
            <div>
              <p class="rent-detail-label">Mode</p>
              <span>{{ session.mode }}</span>
            </div>
            <div>
              <p class="rent-detail-label">LRT</p>
              <span v-if="usage && usage.lrtLimit !== null">
                {{ usage.lrtUsed }}/{{ usage.lrtLimit }}
              </span>
              <span v-else-if="usage">{{ usage.lrtUsed }}</span>
              <span v-else>—</span>
            </div>
          </div>

          <nav class="rent-detail-tabs" role="tablist" aria-label="Session sections">
            <button
              v-for="tab in tabs"
              :key="tab.id"
              type="button"
              role="tab"
              :data-active="activeTab === tab.id"
              :data-testid="`rent-detail-tab-${tab.id}`"
              @click="activeTab = tab.id"
            >
              {{ tab.label }}
            </button>
          </nav>

          <div class="rent-detail-body">
            <p v-if="errorMessage" class="rent-detail-error" role="alert" data-testid="rent-detail-error">
              {{ errorMessage }}
            </p>

            <section v-if="activeTab === 'usage'" data-testid="rent-detail-usage">
              <p v-if="!usage" class="rent-detail-empty">Loading usage...</p>
              <dl v-else class="rent-detail-dl">
                <div>
                  <dt>LRT used</dt>
                  <dd>{{ usage.lrtUsed }}</dd>
                </div>
                <div>
                  <dt>LRT reserved</dt>
                  <dd>{{ usage.lrtReserved }}</dd>
                </div>
                <div>
                  <dt>LRT limit</dt>
                  <dd>{{ usage.lrtLimit ?? "—" }}</dd>
                </div>
                <div>
                  <dt>LRT remaining</dt>
                  <dd>{{ usage.lrtRemaining ?? "—" }}</dd>
                </div>
                <div>
                  <dt>Budget stop</dt>
                  <dd>{{ usage.budgetStopThreshold ?? "—" }}</dd>
                </div>
                <div>
                  <dt>Time limit (min)</dt>
                  <dd>{{ usage.timeLimitMinutes ?? "—" }}</dd>
                </div>
                <div>
                  <dt>Started</dt>
                  <dd>{{ formatTime(usage.startedAt) }}</dd>
                </div>
                <div>
                  <dt>Ends</dt>
                  <dd>{{ formatTime(usage.endsAt) }}</dd>
                </div>
              </dl>
            </section>

            <section v-if="activeTab === 'activity'" data-testid="rent-detail-activity">
              <p v-if="loadingActivity" class="rent-detail-empty">Loading activity...</p>
              <p v-else-if="activity.length === 0" class="rent-detail-empty">No activity yet.</p>
              <ol v-else class="rent-detail-events">
                <li
                  v-for="event in activity"
                  :key="event.id"
                  :data-testid="`rent-detail-event-${event.id}`"
                >
                  <div>
                    <strong>{{ event.eventType }}</strong>
                    <span class="rent-detail-event-meta">
                      · {{ event.source }} · {{ event.visibility }}
                      <span v-if="!event.verified" class="state-pill" data-state="failed">unverified</span>
                    </span>
                  </div>
                  <time>{{ formatTime(event.createdAt) }}</time>
                </li>
              </ol>
            </section>

            <section v-if="activeTab === 'patches'" data-testid="rent-detail-patches">
              <p v-if="loadingPatches" class="rent-detail-empty">Loading patches...</p>
              <p v-else-if="patches.length === 0" class="rent-detail-empty">No patches yet.</p>
              <article
                v-for="patch in patches"
                v-else
                :key="patch.id"
                class="rent-detail-patch"
                :data-testid="`rent-detail-patch-${patch.id}`"
              >
                <header>
                  <strong>{{ patch.summary || "(no summary)" }}</strong>
                  <span class="state-pill" :data-state="patchState(patch.gateStatus)">
                    {{ patch.gateStatus }}
                  </span>
                </header>
                <p v-if="patch.warnings.length" class="rent-detail-warnings">
                  <span v-for="warning in patch.warnings" :key="warning">{{ warning }}</span>
                </p>
                <pre v-if="patch.diffPreview">{{ patch.diffPreview }}</pre>
                <p v-else-if="patch.diffRef" class="rent-detail-diff-ref">
                  {{ patch.diffRef }}
                </p>
                <ul v-if="patch.checkResults.length" class="rent-detail-checks">
                  <li v-for="check in patch.checkResults" :key="check.id">
                    <span class="state-pill" :data-state="patchCheckState(check.status)">
                      {{ check.status }}
                    </span>
                    <span>{{ check.label }}</span>
                    <small v-if="check.detail">{{ check.detail }}</small>
                  </li>
                </ul>
                <a
                  v-if="patch.prUrl"
                  class="rent-detail-pr-link"
                  :href="patch.prUrl"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open PR
                </a>
                <footer
                  v-if="canRequestPatchChanges(patch) || canApprovePatch(patch)"
                  class="rent-detail-patch-actions"
                >
                  <button
                    v-if="canRequestPatchChanges(patch)"
                    type="button"
                    class="rent-create-secondary"
                    :data-testid="`rent-detail-patch-request-changes-${patch.id}`"
                    :disabled="patchActionBusyFor === patch.id"
                    @click="requestPatchChanges(patch.id)"
                  >
                    {{ patchActionBusyFor === patch.id && patchActionKind === "changes" ? "Requesting..." : "Request changes" }}
                  </button>
                  <button
                    v-if="canApprovePatch(patch)"
                    type="button"
                    class="rent-create-primary"
                    :data-testid="`rent-detail-patch-approve-${patch.id}`"
                    :disabled="patchActionBusyFor === patch.id"
                    @click="approvePatch(patch.id)"
                  >
                    {{ patchActionBusyFor === patch.id && patchActionKind === "approve" ? "Approving..." : "Approve patch" }}
                  </button>
                </footer>
              </article>
            </section>
          </div>

          <footer class="rent-detail-footer">
            <button
              v-if="canCancel"
              type="button"
              class="rent-create-secondary rent-detail-cancel"
              data-testid="rent-detail-cancel-session"
              :disabled="cancelBusy"
              @click="cancelSession"
            >
              {{ cancelBusy ? "Cancelling..." : "Cancel session" }}
            </button>
            <button type="button" class="rent-create-secondary" @click="refresh" :disabled="anyLoading">
              {{ anyLoading ? "Refreshing..." : "Refresh" }}
            </button>
            <button type="button" class="rent-create-secondary" @click="$emit('close')">Close</button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type {
  DesktopRentalActivityEvent,
  DesktopRentalPatch,
  DesktopRentalSession,
  DesktopRentalUsageSnapshot,
} from "../../../../../electron/ipc-types";

type DetailTab = "usage" | "activity" | "patches";

const props = defineProps<{
  open: boolean;
  session: DesktopRentalSession | null;
}>();

const emit = defineEmits<{
  close: [];
  "session-updated": [session: DesktopRentalSession];
}>();

const tabs: Array<{ id: DetailTab; label: string }> = [
  { id: "usage", label: "Usage" },
  { id: "activity", label: "Activity" },
  { id: "patches", label: "Patches" },
];

const activeTab = ref<DetailTab>("usage");
const usage = ref<DesktopRentalUsageSnapshot | null>(null);
const activity = ref<DesktopRentalActivityEvent[]>([]);
const patches = ref<DesktopRentalPatch[]>([]);
const loadingUsage = ref(false);
const loadingActivity = ref(false);
const loadingPatches = ref(false);
const cancelBusy = ref(false);
const patchActionBusyFor = ref<string | null>(null);
const patchActionKind = ref<"approve" | "changes" | null>(null);
const errorMessage = ref<string | null>(null);

const anyLoading = computed(
  () => loadingUsage.value || loadingActivity.value || loadingPatches.value,
);

const canCancel = computed(() => {
  const status = props.session?.status;
  if (!status) return false;
  return [
    "requested",
    "accepted",
    "provisioning",
    "active",
    "blocked",
    "patch_review",
    "pr_opened",
    "stale",
    // Backward-compatible aliases from early desktop mocks/API drafts.
    "pending",
    "queued",
    "starting",
    "running",
    "in_progress",
  ].includes(status);
});

watch(
  () => [props.open, props.session?.id] as const,
  ([nowOpen, sessionId]) => {
    if (!nowOpen || !sessionId) return;
    activeTab.value = "usage";
    usage.value = null;
    activity.value = [];
    patches.value = [];
    errorMessage.value = null;
    void refresh();
  },
);

async function refresh(): Promise<void> {
  if (!props.session) return;
  const sessionId = props.session.id;
  const bridge = window.letagentsDesktop?.rental;
  if (!bridge) {
    errorMessage.value = "Rent an Agent is not enabled.";
    return;
  }
  errorMessage.value = null;
  await Promise.all([
    loadUsage(sessionId, bridge),
    loadActivity(sessionId, bridge),
    loadPatches(sessionId, bridge),
  ]);
}

async function loadUsage(sessionId: string, bridge: NonNullable<typeof window.letagentsDesktop.rental>): Promise<void> {
  if (!bridge.getUsage) return;
  loadingUsage.value = true;
  try {
    const result = await bridge.getUsage(sessionId);
    if (!isDisabledResult(result)) usage.value = result;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Could not load usage.";
  } finally {
    loadingUsage.value = false;
  }
}

async function loadActivity(sessionId: string, bridge: NonNullable<typeof window.letagentsDesktop.rental>): Promise<void> {
  if (!bridge.getActivity) return;
  loadingActivity.value = true;
  try {
    const result = await bridge.getActivity(sessionId);
    if (isDisabledResult(result)) return;
    activity.value = Array.isArray(result) ? result : [];
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Could not load activity.";
  } finally {
    loadingActivity.value = false;
  }
}

async function loadPatches(sessionId: string, bridge: NonNullable<typeof window.letagentsDesktop.rental>): Promise<void> {
  if (!bridge.getPatches) return;
  loadingPatches.value = true;
  try {
    const result = await bridge.getPatches(sessionId);
    if (isDisabledResult(result)) return;
    patches.value = Array.isArray(result) ? result : [];
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Could not load patches.";
  } finally {
    loadingPatches.value = false;
  }
}

function isDisabledResult(value: unknown): boolean {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { enabled?: unknown }).enabled === false
  );
}

function statusState(status: string): string {
  if (status === "active" || status === "patch_review" || status === "pr_opened") return "active";
  if (status === "requested" || status === "accepted" || status === "provisioning") return "starting";
  if (status === "blocked") return "failed";
  if (status === "completed" || status === "cancelled") return "offline";
  return "offline";
}

function patchState(status: string): string {
  if (status === "passed") return "connected";
  if (status === "passed_with_warnings" || status === "needs_renter_approval") return "starting";
  if (status === "needs_revision" || status === "rejected") return "failed";
  return "offline";
}

function patchCheckState(status: string): string {
  if (status === "passed") return "connected";
  if (status === "warning" || status === "running" || status === "pending") return "starting";
  if (status === "failed") return "failed";
  return "offline";
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function canApprovePatch(patch: DesktopRentalPatch): boolean {
  if (patch.prUrl) return false;
  return ["passed", "passed_with_warnings", "needs_renter_approval"].includes(patch.gateStatus);
}

function canRequestPatchChanges(patch: DesktopRentalPatch): boolean {
  if (patch.prUrl) return false;
  return ["pending", "passed", "passed_with_warnings", "needs_renter_approval"].includes(patch.gateStatus);
}

async function approvePatch(patchId: string): Promise<void> {
  if (!props.session) return;
  const bridge = window.letagentsDesktop?.rental;
  if (!bridge?.approvePatch) return;
  patchActionBusyFor.value = patchId;
  patchActionKind.value = "approve";
  errorMessage.value = null;
  try {
    const result = await bridge.approvePatch(props.session.id, patchId);
    if (isDisabledResult(result)) {
      errorMessage.value = "Rent an Agent is disabled.";
      return;
    }
    await loadPatches(props.session.id, bridge);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Could not approve the patch.";
  } finally {
    patchActionBusyFor.value = null;
    patchActionKind.value = null;
  }
}

async function requestPatchChanges(patchId: string): Promise<void> {
  if (!props.session) return;
  const bridge = window.letagentsDesktop?.rental;
  if (!bridge?.requestPatchChanges) return;
  const note = window.prompt("Why does this patch need changes?", "");
  if (note === null) return;
  patchActionBusyFor.value = patchId;
  patchActionKind.value = "changes";
  errorMessage.value = null;
  try {
    const result = await bridge.requestPatchChanges(props.session.id, patchId, note.trim() || "Changes requested.");
    if (isDisabledResult(result)) {
      errorMessage.value = "Rent an Agent is disabled.";
      return;
    }
    await loadPatches(props.session.id, bridge);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Could not request changes.";
  } finally {
    patchActionBusyFor.value = null;
    patchActionKind.value = null;
  }
}

async function cancelSession(): Promise<void> {
  if (!props.session) return;
  const bridge = window.letagentsDesktop?.rental;
  if (!bridge?.cancelSession) return;
  const confirmed = window.confirm("Cancel this rental session? The remaining LRT budget will be released.");
  if (!confirmed) return;
  cancelBusy.value = true;
  errorMessage.value = null;
  try {
    const result = await bridge.cancelSession(props.session.id);
    if (isDisabledResult(result)) {
      errorMessage.value = "Rent an Agent is disabled.";
      return;
    }
    emit("session-updated", result);
    emit("close");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Could not cancel the session.";
  } finally {
    cancelBusy.value = false;
  }
}
</script>

<style scoped>
.rent-detail-dialog {
  max-width: 40rem;
}
.rent-detail-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
  gap: 0.75rem;
  padding: 0 1.25rem 0.75rem;
}
.rent-detail-summary > div {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
}
.rent-detail-label {
  opacity: 0.65;
  margin: 0;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.rent-detail-tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0 1.25rem 0.5rem;
}
.rent-detail-tabs button {
  appearance: none;
  background: transparent;
  color: inherit;
  border: none;
  padding: 0.4rem 0.85rem;
  font: inherit;
  font-size: 0.85rem;
  border-radius: 999px;
  cursor: pointer;
}
.rent-detail-tabs button[data-active="true"] {
  background: var(--color-accent, #4f7cff);
  color: white;
}
.rent-detail-body {
  padding: 0 1.25rem 1rem;
  max-height: 60vh;
  overflow-y: auto;
}
.rent-detail-error {
  color: var(--color-danger, #ff8a80);
  font-size: 0.85rem;
}
.rent-detail-empty {
  opacity: 0.65;
  font-size: 0.9rem;
}
.rent-detail-dl {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.75rem 1.25rem;
  margin: 0;
}
.rent-detail-dl > div {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.rent-detail-dl dt {
  opacity: 0.65;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.rent-detail-dl dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.rent-detail-events {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.rent-detail-events li {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  border-radius: 0.5rem;
}
.rent-detail-event-meta {
  opacity: 0.65;
  font-size: 0.8rem;
}
.rent-detail-events time {
  font-size: 0.8rem;
  opacity: 0.65;
}
.rent-detail-patch {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  border-radius: 0.5rem;
  margin-bottom: 0.5rem;
}
.rent-detail-patch header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
}
.rent-detail-patch pre {
  margin: 0;
  font-size: 0.78rem;
  background: var(--color-surface-2, rgba(255, 255, 255, 0.04));
  padding: 0.6rem;
  border-radius: 0.4rem;
  max-height: 18rem;
  overflow: auto;
}
.rent-detail-diff-ref {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.78rem;
  color: var(--color-muted, rgba(255, 255, 255, 0.68));
  overflow-wrap: anywhere;
}
.rent-detail-checks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.35rem;
}
.rent-detail-checks li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 0.35rem 0.55rem;
  font-size: 0.82rem;
}
.rent-detail-checks small {
  grid-column: 2;
  color: var(--color-muted, rgba(255, 255, 255, 0.62));
  overflow-wrap: anywhere;
}
.rent-detail-pr-link {
  width: fit-content;
  font-size: 0.85rem;
  color: var(--color-accent, #4f7cff);
}
.rent-detail-warnings {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0;
}
.rent-detail-warnings span {
  background: color-mix(in srgb, var(--color-warning, #f7c948) 18%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-warning, #f7c948) 30%, transparent);
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-size: 0.75rem;
}
.rent-detail-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
  padding: 0 1.25rem 1.25rem;
}
.rent-create-secondary {
  appearance: none;
  padding: 0.5rem 1rem;
  border-radius: 999px;
  font: inherit;
  cursor: pointer;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  background: transparent;
  color: inherit;
}
.rent-create-secondary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.rent-create-primary {
  appearance: none;
  padding: 0.5rem 1rem;
  border-radius: 999px;
  font: inherit;
  cursor: pointer;
  border: 1px solid transparent;
  background: var(--color-accent, #4f7cff);
  color: white;
}
.rent-create-primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.rent-detail-patch-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.4rem;
}
.rent-detail-cancel {
  margin-right: auto;
  border-color: color-mix(in srgb, var(--color-danger, #ff8a80) 50%, transparent);
  color: var(--color-danger, #ff8a80);
}
</style>
