<template>
  <div class="room-message-attachments">
    <template v-for="attachment in attachments" :key="attachmentKey(attachment)">
      <ManagedAgentChangeSummaryCard
        v-if="isManagedAgentChangeSummaryAttachment(attachment)"
        class="room-message-change-attachment"
        :summary="changeSummary(attachment)"
        :loading="Boolean(loadingChangeSummaryKeys[attachmentKey(attachment)])"
        :expanded="Boolean(expandedChangeSummaryKeys[attachmentKey(attachment)])"
        :fallback-text="changeSummaryFallbackText(attachment)"
        :open-href="changeSummaryOpenHref(attachment)"
        :retry-visible="changeSummaryRetryVisible(attachment)"
        :unavailable="changeSummaryUnavailable(attachment)"
        @toggle-expanded="toggleExpandedChangeSummary(attachment)"
        @retry="retryChangeSummaryAttachment(attachment)"
      />
      <button
        v-else-if="isImageAttachment(attachment)"
        class="room-message-attachment is-image"
        type="button"
        @click="$emit('open-image', imageAttachmentId(messageId, attachment))"
      >
        <img :src="attachmentHref(attachment)" :alt="attachmentName(attachment)">
        <span>
          <strong>{{ attachmentName(attachment) }}</strong>
          <small>{{ attachmentDisplayMeta(attachment) }}</small>
        </span>
      </button>
      <button
        v-else-if="isHtmlDemoAttachment(attachment)"
        class="room-message-attachment is-demo"
        type="button"
        :aria-describedby="demoErrors[attachmentKey(attachment)] ? `demo-error-${attachmentKey(attachment)}` : undefined"
        @click="openHtmlDemo(attachment)"
      >
        <span>
          <strong>{{ attachmentName(attachment) }}</strong>
          <small title="Opens in its own locked window. It cannot load web pages or reach your LetAgents data.">Interactive demo · locked window</small>
          <small
            v-if="demoErrors[attachmentKey(attachment)]"
            :id="`demo-error-${attachmentKey(attachment)}`"
            class="room-message-attachment-error"
            role="alert"
          >{{ demoErrors[attachmentKey(attachment)] }}</small>
        </span>
        <em>{{ openingDemoKeys[attachmentKey(attachment)] ? "Opening…" : "Open demo" }}</em>
      </button>
      <a
        v-else
        class="room-message-attachment"
        :href="attachmentHref(attachment)"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span>
          <strong>{{ attachmentName(attachment) }}</strong>
          <small>{{ attachmentDisplayMeta(attachment) }}</small>
        </span>
      </a>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import type {
  DesktopManagedAgentPublicChangeSummary,
  DesktopRoomMessageAttachment,
} from "../../../../../../electron/ipc-types";
import {
  attachmentHref,
  attachmentDisplayMeta,
  attachmentKey,
  attachmentName,
  htmlDemoErrorText,
  imageAttachmentId,
  isHtmlDemoAttachment,
  isImageAttachment,
} from "./attachments";
import { desktopIpc } from "../../../../ipc/index.js";
import {
  decodeManagedAgentChangeSummaryAttachment,
  fetchManagedAgentChangeSummaryAttachment,
  isManagedAgentChangeSummaryAttachment,
} from "../../../../domain/managed-agent-changes";
import ManagedAgentChangeSummaryCard from "../ManagedAgentChangeSummaryCard.vue";

const props = defineProps<{
  messageId: string;
  attachments: DesktopRoomMessageAttachment[];
  senderLabel?: string | null;
}>();

defineEmits<{
  "open-image": [imageId: string];
}>();

const remoteChangeSummaries = ref<Record<string, DesktopManagedAgentPublicChangeSummary | null>>({});
const loadingChangeSummaryKeys = ref<Record<string, boolean>>({});
const failedChangeSummaryKeys = ref<Record<string, boolean>>({});
const expandedChangeSummaryKeys = ref<Record<string, boolean>>({});
const openingDemoKeys = ref<Record<string, boolean>>({});
const demoErrors = ref<Record<string, string>>({});

async function openHtmlDemo(attachment: DesktopRoomMessageAttachment): Promise<void> {
  const key = attachmentKey(attachment);
  if (openingDemoKeys.value[key]) return;
  const { [key]: _previous, ...otherErrors } = demoErrors.value;
  demoErrors.value = otherErrors;
  openingDemoKeys.value = { ...openingDemoKeys.value, [key]: true };
  try {
    const open = desktopIpc.room?.openHtmlDemo;
    if (!open) throw new Error("Update LetAgents to open demos.");
    await open(attachmentHref(attachment), attachmentName(attachment), props.senderLabel ?? null);
  } catch (error) {
    demoErrors.value = {
      ...demoErrors.value,
      [key]: htmlDemoErrorText(error),
    };
  } finally {
    const { [key]: _done, ...stillOpening } = openingDemoKeys.value;
    openingDemoKeys.value = stillOpening;
  }
}

watch(
  () => props.attachments.map(attachmentKey).join("|"),
  () => {
    pruneChangeSummaryState();
    void loadRemoteChangeSummaryAttachments();
  },
  { immediate: true },
);

function changeSummary(attachment: DesktopRoomMessageAttachment): DesktopManagedAgentPublicChangeSummary | null {
  return decodeManagedAgentChangeSummaryAttachment(attachment)
    ?? remoteChangeSummaries.value[attachmentKey(attachment)]
    ?? null;
}

function changeSummaryFallbackText(attachment: DesktopRoomMessageAttachment): string {
  const key = attachmentKey(attachment);
  const summary = changeSummary(attachment);
  if (summary?.error) return summary.error;
  if (summary) return "No changes in this agent's working tree.";
  if (loadingChangeSummaryKeys.value[key]) return "Loading file changes...";
  return "The attached change summary could not be loaded.";
}

function changeSummaryOpenHref(attachment: DesktopRoomMessageAttachment): string | null {
  const href = attachmentHref(attachment);
  return href === "#" ? null : href;
}

function changeSummaryRetryVisible(attachment: DesktopRoomMessageAttachment): boolean {
  return !changeSummary(attachment) && Boolean(failedChangeSummaryKeys.value[attachmentKey(attachment)]);
}

function changeSummaryUnavailable(attachment: DesktopRoomMessageAttachment): boolean {
  return !changeSummary(attachment) && !loadingChangeSummaryKeys.value[attachmentKey(attachment)];
}

function toggleExpandedChangeSummary(attachment: DesktopRoomMessageAttachment): void {
  const key = attachmentKey(attachment);
  expandedChangeSummaryKeys.value = {
    ...expandedChangeSummaryKeys.value,
    [key]: !expandedChangeSummaryKeys.value[key],
  };
}

async function loadRemoteChangeSummaryAttachments(): Promise<void> {
  await Promise.all(
    props.attachments.map((attachment) => loadRemoteChangeSummaryAttachment(attachment)),
  );
}

async function retryChangeSummaryAttachment(attachment: DesktopRoomMessageAttachment): Promise<void> {
  const key = attachmentKey(attachment);
  const { [key]: _failed, ...remainingFailures } = failedChangeSummaryKeys.value;
  const { [key]: _summary, ...remainingSummaries } = remoteChangeSummaries.value;
  failedChangeSummaryKeys.value = remainingFailures;
  remoteChangeSummaries.value = remainingSummaries;
  await loadRemoteChangeSummaryAttachment(attachment);
}

async function loadRemoteChangeSummaryAttachment(attachment: DesktopRoomMessageAttachment): Promise<void> {
  if (!isManagedAgentChangeSummaryAttachment(attachment)) return;
  const key = attachmentKey(attachment);
  if (decodeManagedAgentChangeSummaryAttachment(attachment)) {
    clearChangeSummaryLoadState(key);
    return;
  }
  if (
    loadingChangeSummaryKeys.value[key] ||
    Object.prototype.hasOwnProperty.call(remoteChangeSummaries.value, key) ||
    failedChangeSummaryKeys.value[key]
  ) {
    return;
  }

  loadingChangeSummaryKeys.value = {
    ...loadingChangeSummaryKeys.value,
    [key]: true,
  };
  try {
    const summary = await fetchManagedAgentChangeSummaryAttachment(attachment);
    remoteChangeSummaries.value = {
      ...remoteChangeSummaries.value,
      [key]: summary,
    };
    if (!summary) {
      failedChangeSummaryKeys.value = {
        ...failedChangeSummaryKeys.value,
        [key]: true,
      };
    }
  } catch {
    failedChangeSummaryKeys.value = {
      ...failedChangeSummaryKeys.value,
      [key]: true,
    };
  } finally {
    const { [key]: _ignored, ...remaining } = loadingChangeSummaryKeys.value;
    loadingChangeSummaryKeys.value = remaining;
  }
}

function clearChangeSummaryLoadState(key: string): void {
  const { [key]: _failed, ...remainingFailures } = failedChangeSummaryKeys.value;
  const { [key]: _loading, ...remainingLoading } = loadingChangeSummaryKeys.value;
  const { [key]: _summary, ...remainingSummaries } = remoteChangeSummaries.value;
  failedChangeSummaryKeys.value = remainingFailures;
  loadingChangeSummaryKeys.value = remainingLoading;
  remoteChangeSummaries.value = remainingSummaries;
}

function pruneChangeSummaryState(): void {
  const activeKeys = new Set(props.attachments.map(attachmentKey));
  remoteChangeSummaries.value = pruneRecord(remoteChangeSummaries.value, activeKeys);
  loadingChangeSummaryKeys.value = pruneRecord(loadingChangeSummaryKeys.value, activeKeys);
  failedChangeSummaryKeys.value = pruneRecord(failedChangeSummaryKeys.value, activeKeys);
  expandedChangeSummaryKeys.value = pruneRecord(expandedChangeSummaryKeys.value, activeKeys);
}

function pruneRecord<T>(record: Record<string, T>, activeKeys: Set<string>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => activeKeys.has(key)),
  );
}
</script>
