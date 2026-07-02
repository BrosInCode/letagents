<template>
  <div class="room-message-attachments">
    <template v-for="attachment in attachments" :key="attachmentKey(attachment)">
      <article
        v-if="isManagedAgentChangeSummaryAttachment(attachment)"
        class="room-message-change-attachment"
        data-testid="room-message-change-attachment"
      >
        <header>
          <span class="room-message-change-attachment-icon" aria-hidden="true">
            <FileDiff />
          </span>
          <div>
            <strong>{{ changeSummaryTitle(attachment) }}</strong>
            <small>{{ changeSummarySubtitle(attachment) }}</small>
          </div>
        </header>

        <ul
          v-if="changeSummary(attachment)?.changedFileCount"
          class="room-message-change-files"
        >
          <li
            v-for="file in visibleChangeFiles(attachment)"
            :key="file.path"
          >
            <span>{{ file.path }}</span>
            <strong>
              <b v-if="file.additions">+{{ file.additions }}</b>
              <b v-if="file.deletions" class="room-message-change-deletions">-{{ file.deletions }}</b>
              <em v-if="file.binary">binary</em>
              <em v-if="!file.additions && !file.deletions && !file.binary">{{ managedAgentChangedFileStateLabel(file) }}</em>
            </strong>
          </li>
        </ul>
        <p
          v-else
          class="room-message-change-empty"
        >
          {{ changeSummaryFallbackText(attachment) }}
        </p>

        <button
          v-if="hiddenChangeFileCount(attachment) > 0"
          type="button"
          class="room-message-change-show-files"
          @click="toggleExpandedChangeSummary(attachment)"
        >
          {{ expandedChangeSummaryKeys[attachmentKey(attachment)] ? "Show fewer files" : `Show ${hiddenChangeFileCount(attachment)} more files` }}
        </button>
        <p
          v-if="expandedChangeSummaryKeys[attachmentKey(attachment)] && backendHiddenChangeFileCount(attachment) > 0"
          class="room-message-change-empty"
        >
          {{ backendHiddenChangeFileCount(attachment) }} more files are not shown here.
        </p>
      </article>
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
import { FileDiff } from "@lucide/vue";
import type {
  DesktopManagedAgentChangeSummary,
  DesktopRoomMessageAttachment,
} from "../../../../../../electron/ipc-types";
import {
  attachmentHref,
  attachmentDisplayMeta,
  attachmentKey,
  attachmentName,
  imageAttachmentId,
  isImageAttachment,
} from "./attachments";
import {
  decodeManagedAgentChangeSummaryAttachment,
  fetchManagedAgentChangeSummaryAttachment,
  hiddenManagedAgentChangedFileCount,
  isManagedAgentChangeSummaryAttachment,
  managedAgentChangedFileStateLabel,
  managedAgentChangeSummarySubtitle,
  managedAgentChangeSummaryTitle,
  visibleManagedAgentChangedFiles,
} from "../../../../domain/managed-agent-changes";

const props = defineProps<{
  messageId: string;
  attachments: DesktopRoomMessageAttachment[];
}>();

defineEmits<{
  "open-image": [imageId: string];
}>();

const remoteChangeSummaries = ref<Record<string, DesktopManagedAgentChangeSummary | null>>({});
const loadingChangeSummaryKeys = ref<Record<string, boolean>>({});
const failedChangeSummaryKeys = ref<Record<string, boolean>>({});
const expandedChangeSummaryKeys = ref<Record<string, boolean>>({});

watch(
  () => props.attachments,
  () => {
    void loadRemoteChangeSummaryAttachments();
  },
  { immediate: true },
);

function changeSummary(attachment: DesktopRoomMessageAttachment): DesktopManagedAgentChangeSummary | null {
  return decodeManagedAgentChangeSummaryAttachment(attachment)
    ?? remoteChangeSummaries.value[attachmentKey(attachment)]
    ?? null;
}

function changeSummaryTitle(attachment: DesktopRoomMessageAttachment): string {
  return managedAgentChangeSummaryTitle(
    changeSummary(attachment),
    Boolean(loadingChangeSummaryKeys.value[attachmentKey(attachment)]),
  );
}

function changeSummarySubtitle(attachment: DesktopRoomMessageAttachment): string {
  return managedAgentChangeSummarySubtitle(
    changeSummary(attachment),
    Boolean(loadingChangeSummaryKeys.value[attachmentKey(attachment)]),
  );
}

function visibleChangeFiles(attachment: DesktopRoomMessageAttachment) {
  return visibleManagedAgentChangedFiles(
    changeSummary(attachment),
    Boolean(expandedChangeSummaryKeys.value[attachmentKey(attachment)]),
  );
}

function hiddenChangeFileCount(attachment: DesktopRoomMessageAttachment): number {
  return hiddenManagedAgentChangedFileCount(
    changeSummary(attachment),
    Boolean(expandedChangeSummaryKeys.value[attachmentKey(attachment)]),
  );
}

function backendHiddenChangeFileCount(attachment: DesktopRoomMessageAttachment): number {
  return changeSummary(attachment)?.hiddenFileCount ?? 0;
}

function changeSummaryFallbackText(attachment: DesktopRoomMessageAttachment): string {
  const key = attachmentKey(attachment);
  if (loadingChangeSummaryKeys.value[key]) return "Loading file changes...";
  if (failedChangeSummaryKeys.value[key]) return "Change summary could not be loaded.";
  const summary = changeSummary(attachment);
  if (summary?.error) return summary.error;
  return "No file changes in this Codex working tree.";
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
    props.attachments.map(async (attachment) => {
      if (!isManagedAgentChangeSummaryAttachment(attachment)) return;
      if (decodeManagedAgentChangeSummaryAttachment(attachment)) return;
      const key = attachmentKey(attachment);
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
    }),
  );
}
</script>
