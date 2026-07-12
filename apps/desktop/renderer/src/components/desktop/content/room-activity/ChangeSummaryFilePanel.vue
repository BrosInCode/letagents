<template>
  <div class="desktop-activity-changes">
    <span class="desktop-activity-changes-summary">{{ headline }}</span>
    <ul :id="listId" class="desktop-activity-file-list">
      <li v-for="file in visibleFiles" :key="file.path" class="desktop-activity-file">
        <span class="desktop-activity-file-path" :title="filePathLabel(file)">{{ filePathLabel(file) }}</span>
        <span class="desktop-activity-file-counts">
          <span v-if="file.binary" class="desktop-activity-file-bin">bin</span>
          <template v-else>
            <span v-if="file.additions" class="desktop-activity-file-add">+{{ file.additions }}</span>
            <span v-if="file.deletions" class="desktop-activity-file-del">−{{ file.deletions }}</span>
          </template>
        </span>
      </li>
    </ul>
    <button
      v-if="toggleVisible"
      type="button"
      class="desktop-activity-file-toggle"
      :aria-expanded="expanded"
      :aria-controls="listId"
      :aria-label="toggleLabel"
      @click="emit('toggle')"
    >
      {{ toggleText }}
    </button>
    <small v-if="detail.hiddenFileCount > 0" class="desktop-activity-file-note">
      {{ detail.hiddenFileCount }} more not shown
    </small>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopRoomSharedArtifactChangedFile,
  DesktopRoomSharedArtifactChangeSummaryDetail,
} from "../../../../../../electron/ipc-types";
import {
  CHANGE_SUMMARY_FILE_COLLAPSED_LIMIT,
  changeSummaryHeadline,
  splitChangeSummaryFiles,
} from "../../../../domain/room-artifacts";

const props = defineProps<{
  detail: DesktopRoomSharedArtifactChangeSummaryDetail;
  expanded: boolean;
  listId: string;
  label: string;
}>();

const emit = defineEmits<{ toggle: [] }>();

const headline = computed(() => changeSummaryHeadline(props.detail));
const visibleFiles = computed(() => splitChangeSummaryFiles(props.detail.files, props.expanded).visible);
const hiddenCount = computed(
  () => splitChangeSummaryFiles(props.detail.files, props.expanded).hiddenCount,
);
const toggleVisible = computed(
  () => props.detail.files.length > CHANGE_SUMMARY_FILE_COLLAPSED_LIMIT,
);
const toggleText = computed(() =>
  props.expanded
    ? "Show fewer files"
    : `Show ${hiddenCount.value} more ${hiddenCount.value === 1 ? "file" : "files"}`,
);
const toggleLabel = computed(() =>
  props.expanded
    ? `Show fewer files for ${props.label}`
    : `${toggleText.value} for ${props.label}`,
);

function filePathLabel(file: DesktopRoomSharedArtifactChangedFile): string {
  return file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
}
</script>
