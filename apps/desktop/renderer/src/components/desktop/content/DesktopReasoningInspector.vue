<template>
  <Teleport to="body">
    <div
      v-if="open && activeSession"
      class="desktop-reasoning-inspector-backdrop"
      @click.self="emit('close')"
    >
      <section
        ref="dialogElement"
        class="desktop-reasoning-inspector"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        @keydown.esc.prevent="emit('close')"
      >
        <header class="desktop-reasoning-inspector-header">
          <div>
            <span class="desktop-reasoning-inspector-eyebrow">Agent reasoning</span>
            <h3 :id="titleId">{{ heading }}</h3>
            <p>{{ subtitle }}</p>
          </div>
          <div class="desktop-reasoning-inspector-actions">
            <span class="desktop-reasoning-freshness" :data-state="streamState" :title="streamDescription">
              {{ streamLabel }}
            </span>
            <button type="button" @click="emit('close')">Close</button>
          </div>
        </header>

        <div class="desktop-reasoning-inspector-body">
          <section class="desktop-reasoning-summary">
            <span>Current summary</span>
            <p>{{ currentSummary }}</p>
          </section>

          <dl v-if="structuredFields.length" class="desktop-reasoning-field-grid">
            <div
              v-for="field in structuredFields"
              :key="field.label"
              class="desktop-reasoning-field"
              :data-kind="field.kind"
            >
              <dt>{{ field.label }}</dt>
              <dd>{{ field.value }}</dd>
            </div>
          </dl>

          <section class="desktop-reasoning-timeline-section">
            <header>
              <div>
                <span>Timeline</span>
                <h4>{{ timelineEntries.length }} updates</h4>
              </div>
              <p v-if="detailError">{{ detailError }}</p>
              <p v-else-if="isLoadingDetail">Loading reasoning updates...</p>
            </header>

            <ol v-if="timelineEntries.length" class="desktop-reasoning-timeline">
              <li v-for="entry in timelineEntries" :key="entry.id" class="desktop-reasoning-timeline-entry">
                <div>
                  <strong>{{ entry.label }}</strong>
                  <time>{{ formatTimestamp(entry.timestamp) }}</time>
                </div>
                <p>{{ entry.text }}</p>
              </li>
            </ol>
            <p v-else-if="!isLoadingDetail" class="desktop-reasoning-empty">
              No detailed reasoning updates have been exposed for this stream yet.
            </p>
          </section>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type {
  DesktopReasoningSession,
  DesktopReasoningSnapshot,
  DesktopReasoningUpdate,
} from "../../../../../electron/ipc-types";
import { displayNameFromActor } from "../../../domain/agents";
import { timestampValue } from "../../../domain/time";

interface ReasoningField {
  label: string;
  value: string;
  kind: "normal" | "blocker" | "confidence" | "status";
}

interface ReasoningTimelineEntry {
  id: string;
  label: string;
  text: string;
  timestamp: string | null;
}

const props = defineProps<{
  open: boolean;
  roomIdentifier: string;
  session: DesktopReasoningSession | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

const dialogElement = ref<HTMLElement | null>(null);
const detailSession = ref<DesktopReasoningSession | null>(null);
const detailUpdates = ref<DesktopReasoningUpdate[]>([]);
const isLoadingDetail = ref(false);
const detailError = ref<string | null>(null);
let fetchSerial = 0;

const activeSession = computed(() => detailSession.value || props.session);
const titleId = computed(() => `desktop-reasoning-${sanitizeId(activeSession.value?.id || "stream")}`);
const actorName = computed(() => displayNameFromActor(activeSession.value?.actorLabel || ""));
const heading = computed(() =>
  activeSession.value?.title
  || activeSession.value?.latestPayload?.goal
  || activeSession.value?.summary
  || `${actorName.value} reasoning`
);
const subtitle = computed(() => {
  const parts = [actorName.value];
  if (activeSession.value?.taskId) parts.push(activeSession.value.taskId);
  const updatedAt = formatTimestamp(activeSession.value?.updatedAt || activeSession.value?.createdAt || null);
  if (updatedAt !== "unknown") parts.push(`Updated ${updatedAt}`);
  return parts.join(" · ");
});

const currentSnapshot = computed<DesktopReasoningSnapshot | null>(() => {
  const session = activeSession.value;
  if (!session) return null;
  if (session.latestPayload) return session.latestPayload;
  if (
    session.goal ||
    session.checking ||
    session.hypothesis ||
    session.blocker ||
    session.nextAction ||
    session.milestone ||
    typeof session.confidence === "number" ||
    session.status
  ) {
    return {
      summary: session.summary || "",
      goal: session.goal,
      checking: session.checking,
      hypothesis: session.hypothesis,
      blocker: session.blocker,
      next_action: session.nextAction,
      milestone: session.milestone,
      confidence: session.confidence,
      status: session.status,
    };
  }
  return session.summary ? { summary: session.summary } : null;
});

const currentSummary = computed(() =>
  currentSnapshot.value?.summary
  || activeSession.value?.summary
  || "No summary exposed yet."
);

const structuredFields = computed<ReasoningField[]>(() => {
  const snapshot = currentSnapshot.value;
  if (!snapshot) return [];
  const fields: ReasoningField[] = [];
  pushField(fields, "Goal", snapshot.goal);
  pushField(fields, "Checking", snapshot.checking);
  pushField(fields, "Hypothesis", snapshot.hypothesis);
  pushField(fields, "Blocker", snapshot.blocker, "blocker");
  pushField(fields, "Next action", snapshot.next_action);
  pushField(fields, "Milestone", snapshot.milestone);
  pushField(fields, "Status", snapshot.status, "status");
  if (typeof snapshot.confidence === "number") {
    pushField(fields, "Confidence", `${Math.round(snapshot.confidence * 100)}%`, "confidence");
  }
  return fields;
});

const timelineEntries = computed<ReasoningTimelineEntry[]>(() => {
  const updateEntries = detailUpdates.value
    .map((update) => ({
      id: update.id,
      label: update.milestone ? "Milestone" : labelFromStatus(update.status),
      text: update.summary || update.payload?.summary || update.milestone || "",
      timestamp: update.createdAt,
    }))
    .filter((entry) => entry.text.trim());
  if (updateEntries.length) return sortTimeline(updateEntries);

  const session = activeSession.value;
  const snapshot = currentSnapshot.value;
  if (!session || !snapshot) return [];
  const timestamp = session.updatedAt || session.createdAt;
  return sortTimeline([
    { id: `${session.id}-summary`, label: "Summary", text: snapshot.summary || session.summary || "", timestamp },
    { id: `${session.id}-goal`, label: "Goal", text: snapshot.goal || "", timestamp },
    { id: `${session.id}-checking`, label: "Checking", text: snapshot.checking || "", timestamp },
    { id: `${session.id}-hypothesis`, label: "Hypothesis", text: snapshot.hypothesis || "", timestamp },
    { id: `${session.id}-blocker`, label: "Blocker", text: snapshot.blocker || "", timestamp },
    { id: `${session.id}-next`, label: "Next action", text: snapshot.next_action || "", timestamp },
    { id: `${session.id}-milestone`, label: "Milestone", text: snapshot.milestone || "", timestamp },
  ].filter((entry) => entry.text.trim()));
});

const streamState = computed(() => {
  const status = String(currentSnapshot.value?.status || activeSession.value?.status || "").toLowerCase();
  if (isCodexReasoningSummary.value) return "live";
  if (isCodexSnapshot.value) return "snapshot";
  if (status === "working" || status === "reviewing") return "live";
  if (status === "blocked") return "blocked";
  return "recent";
});
const isCodexReasoningSummary = computed(() => {
  const snapshot = currentSnapshot.value;
  const text = [
    snapshot?.summary,
    snapshot?.checking,
    snapshot?.next_action,
  ].join(" ").toLowerCase();
  return text.includes("readable reasoning") || text.includes("reasoning summary");
});
const isCodexSnapshot = computed(() => {
  if (isCodexReasoningSummary.value) return false;
  const snapshot = currentSnapshot.value;
  const text = [
    snapshot?.summary,
    snapshot?.checking,
    snapshot?.next_action,
  ].join(" ").toLowerCase();
  return text.includes("codex_app_server") || text.includes("app-server snapshot") || text.includes("snapshot-derived");
});
const streamLabel = computed(() => {
  if (isCodexReasoningSummary.value) return "Live thinking";
  if (isCodexSnapshot.value) return "Snapshot";
  const status = String(currentSnapshot.value?.status || activeSession.value?.status || "").trim();
  return status ? labelFromStatus(status) : "Reasoning";
});
const streamDescription = computed(() =>
  isCodexReasoningSummary.value
    ? "Readable Codex reasoning summary stream"
    : isCodexSnapshot.value
      ? "Codex app-server snapshot"
      : streamLabel.value
);

watch(() => props.open, (next) => {
  if (!next) {
    detailSession.value = null;
    detailUpdates.value = [];
    detailError.value = null;
    isLoadingDetail.value = false;
    return;
  }
  void nextTick(() => dialogElement.value?.focus());
});

watch(
  () => props.session,
  (nextSession) => {
    if (!nextSession || !props.open) return;
    if (detailSession.value?.id === nextSession.id) {
      detailSession.value = { ...detailSession.value, ...nextSession };
    }
  }
);

watch(
  () => [props.open, props.roomIdentifier, props.session?.id] as const,
  async ([isOpen, roomIdentifier, sessionId]) => {
    if (!isOpen || !roomIdentifier || !sessionId) return;
    const serial = ++fetchSerial;
    isLoadingDetail.value = true;
    detailError.value = null;
    const previousSessionId = detailSession.value?.id || props.session?.id || null;
    if (!detailSession.value) {
      detailSession.value = props.session;
    }
    if (previousSessionId !== sessionId) {
      detailUpdates.value = [];
    }
    if (sessionId.startsWith("pending-agent-reasoning:")) {
      isLoadingDetail.value = false;
      return;
    }
    try {
      const result = await window.letagentsDesktop.room.getReasoningSession(roomIdentifier, sessionId);
      if (serial !== fetchSerial) return;
      detailSession.value = result.session;
      detailUpdates.value = [...result.updates].sort((left, right) =>
        timestampValue(left.createdAt) - timestampValue(right.createdAt)
        || left.id.localeCompare(right.id)
      );
    } catch (error) {
      if (serial !== fetchSerial) return;
      detailSession.value = props.session;
      detailError.value = error instanceof Error ? error.message : "Could not load reasoning details.";
    } finally {
      if (serial === fetchSerial) isLoadingDetail.value = false;
    }
  },
  { immediate: true }
);

function pushField(
  fields: ReasoningField[],
  label: string,
  value: string | null | undefined,
  kind: ReasoningField["kind"] = "normal"
): void {
  const normalized = String(value || "").trim();
  if (!normalized) return;
  fields.push({ label, value: normalized, kind });
}

function sortTimeline(entries: ReasoningTimelineEntry[]): ReasoningTimelineEntry[] {
  return [...entries].sort((left, right) =>
    timestampValue(left.timestamp) - timestampValue(right.timestamp)
    || left.id.localeCompare(right.id)
  );
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-") || "stream";
}

function labelFromStatus(value: string | null): string {
  const normalized = String(value || "").trim();
  if (!normalized) return "Update";
  return normalized.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTimestamp(value: string | null | undefined): string {
  const parsed = new Date(String(value || ""));
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
</script>
