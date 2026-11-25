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
      <DesktopInlineHtmlDemo
        v-else-if="inlineDemosAvailable && isHtmlDemoAttachment(attachment)"
        :href="attachmentHref(attachment)"
        :file-name="attachmentName(attachment)"
        :sender-label="senderLabel"
        :room-identifier="roomIdentifier"
        :message-id="messageId"
        :attachment-id="attachment.id"
        :thread-root-id="threadRootId"
      />
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
      <button
        v-else-if="textReaderAvailable && attachmentPreviewType(attachment)"
        class="room-text-attachment"
        type="button"
        :title="attachmentName(attachment)"
        :aria-label="`Preview ${attachmentName(attachment)}`"
        @click="openTextPreview(attachment, $event)"
      >
        <FileText class="room-text-attachment-icon" :size="18" aria-hidden="true" />
        <span class="room-text-attachment-label">
          <strong>{{ attachmentName(attachment) }}</strong>
          <small>{{ [attachmentPreviewType(attachment), formatDisplayBytes(attachment.sizeBytes ?? 0)].filter(Boolean).join(" · ") }}</small>
        </span>
        <span class="room-text-attachment-action">Preview <ChevronRight :size="15" aria-hidden="true" /></span>
      </button>
      <button
        v-else-if="desktopIpc.room?.downloadAttachment && isDesktopAttachmentHref(attachment.href)"
        class="room-message-attachment"
        type="button"
        :aria-label="`Download ${attachmentName(attachment)}`"
        @click="downloadManagedAttachment(attachment)"
      >
        <span>
          <strong>{{ attachmentName(attachment) }}</strong>
          <small>{{ attachmentDisplayMeta(attachment) }}</small>
          <small v-if="failedDownloadKey === attachmentKey(attachment)" role="status">Couldn’t download. Try again.</small>
        </span>
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
    <AttachmentTextReader
      v-if="textPreview"
      :attachment="textPreview.attachment"
      :opener="textPreview.opener"
      @close="textPreview = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ChevronRight, FileText } from "@lucide/vue";
import { ref, shallowRef, watch } from "vue";
import { isDesktopAttachmentHref } from "../../../../../../../../shared/message-attachments.mjs";
import type {
  DesktopManagedAgentPublicChangeSummary,
  DesktopRoomMessageAttachment,
} from "../../../../../../electron/ipc-types";
import {
  attachmentHref,
  attachmentDisplayMeta,
  attachmentKey,
  formatDisplayBytes,
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
import { attachmentPreviewType } from "../../../../domain/attachment-preview";
import AttachmentTextReader from "./AttachmentTextReader.vue";
import ManagedAgentChangeSummaryCard from "../ManagedAgentChangeSummaryCard.vue";
import DesktopInlineHtmlDemo from "./DesktopInlineHtmlDemo.vue";

const props = defineProps<{
  messageId: string;
  attachments: DesktopRoomMessageAttachment[];
  senderLabel?: string | null;
  roomIdentifier?: string | null;
  /** The thread a demo's picture is sent to: the thread this message belongs to, or its own. */
  threadRootId?: string | null;
}>();

defineEmits<{
  "open-image": [imageId: string];
}>();

// An older main process cannot lease a demo to the chat, so its cards keep the window.
const inlineDemosAvailable = typeof desktopIpc.room?.prepareInlineHtmlDemo === "function";

const textReaderAvailable = typeof desktopIpc.room?.readAttachmentText === "function";
const textPreview = shallowRef<{ attachment: DesktopRoomMessageAttachment; opener: HTMLElement | null } | null>(null);
const failedDownloadKey = ref("");

function openTextPreview(attachment: DesktopRoomMessageAttachment, event: MouseEvent): void {
  textPreview.value = { attachment, opener: event.currentTarget as HTMLElement | null };
}

async function downloadManagedAttachment(attachment: DesktopRoomMessageAttachment): Promise<void> {
  if (!attachment.href) return;
  failedDownloadKey.value = "";
  try {
    await desktopIpc.room?.downloadAttachment?.(attachment.href);
  } catch {
    failedDownloadKey.value = attachmentKey(attachment);
  }
}

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
  () => props.attachments.map(attachment => [attachmentKey(attachment), attachment.href]),
  () => {
    const selected = textPreview.value?.attachment;
    if (selected && !props.attachments.some(attachment => attachmentKey(attachment) === attachmentKey(selected) && attachment.href === selected.href)) {
      textPreview.value = null;
    }
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
