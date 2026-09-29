<template>
  <section
    class="room-tab-page focus-room-manager"
    data-testid="room-details-view"
  >
    <header v-if="room.kind === 'focus'" class="focus-room-header">
      <div>
        <p class="focus-room-kicker">Room details</p>
        <h2>{{ roomDisplayTitle(room.displayName) }}</h2>
        <p class="focus-room-muted">{{ headerMeta }}</p>
      </div>
      <button
        class="focus-room-icon-button"
        type="button"
        aria-label="Refresh rooms"
        @click="emit('refresh-room')"
      >
        <RefreshCw :size="16" aria-hidden="true" />
      </button>
    </header>

    <section
      v-if="room.kind === 'focus'"
      class="focus-room-current"
      data-testid="current-focus-room"
    >
      <div class="focus-room-current-main">
        <div class="focus-room-title-line">
          <span
            class="focus-room-dot"
            :data-state="room.focusStatus || 'active'"
          ></span>
          <div>
            <h3>
              {{
                room.focusStatus === "concluded"
                  ? "This room is closed"
                  : "Work together, then share the outcome"
              }}
            </h3>
            <p>
              {{
                room.sourceTaskId
                  ? "Linked to a task in the main room."
                  : "A separate conversation, connected to the main room."
              }}
            </p>
          </div>
          <span
            class="focus-room-state"
            :data-state="room.focusStatus || 'active'"
          >
            {{ statusLabel(room.focusStatus || "active") }}
          </span>
        </div>

        <dl class="focus-room-facts">
          <div>
            <dt>Main room</dt>
            <dd>{{ room.parentRoomId || "No parent room" }}</dd>
          </div>
          <div>
            <dt>Share with main room</dt>
            <dd>
              {{ parentVisibilityLabel(currentSettings.parent_visibility) }}
            </dd>
          </div>
          <div>
            <dt>Activity shown</dt>
            <dd>{{ activityScopeLabel(currentSettings.activity_scope) }}</dd>
          </div>
          <div>
            <dt>GitHub</dt>
            <dd>
              {{ githubRoutingLabel(currentSettings.github_event_routing) }}
            </dd>
          </div>
        </dl>
      </div>

      <details class="rooms-settings">
        <summary>
          Room settings<span v-if="settingsChanged"> · Unsaved changes</span>
        </summary>
        <form
          class="focus-room-form"
          data-testid="focus-room-settings-form"
          @submit.prevent="saveSettings"
        >
          <div class="focus-room-section-heading">
            <h4>Updates shared with the main room</h4>
            <span v-if="settingsChanged">Unsaved</span>
          </div>
          <div class="focus-room-select-grid">
            <DesktopSelectField
              v-model="settingsDraft.parent_visibility"
              label="Share with main room"
              :options="parentVisibilityOptions"
              :disabled="savingSettings"
            />
            <DesktopSelectField
              v-model="settingsDraft.activity_scope"
              label="Activity shown"
              :options="activityScopeOptions"
              :disabled="savingSettings"
            />
            <DesktopSelectField
              v-model="settingsDraft.github_event_routing"
              label="GitHub"
              :options="githubRoutingOptions"
              :disabled="savingSettings"
            />
          </div>
          <button
            class="focus-room-secondary"
            type="submit"
            :disabled="!settingsChanged || savingSettings"
          >
            {{ savingSettings ? "Saving..." : "Save changes" }}
          </button>
        </form>
      </details>

      <form
        v-if="room.focusStatus !== 'concluded' && !resultSubmitted"
        class="focus-room-form"
        data-testid="focus-room-closeout-form"
        @submit.prevent="shareFocusRoomResult"
      >
        <div class="focus-room-section-heading">
          <h4>{{ quickClose ? "Close room" : "Finish this conversation" }}</h4>
        </div>

        <FocusRoomQuickCloseOption
          v-model="quickClose"
          :task-linked="Boolean(room.sourceTaskId)"
          :disabled="sharingResult"
          test-id="focus-room-quick-close"
        />

        <textarea
          v-if="!quickClose"
          v-model="resultSummary"
          rows="4"
          placeholder="What changed, what was decided, and what happens next?"
          aria-label="Outcome summary"
          :disabled="sharingResult"
        ></textarea>

        <div
          v-if="room.sourceTaskId && !quickClose"
          class="focus-room-closeout-grid"
        >
          <label>
            <span>Artifact</span>
            <input
              v-model="closeoutDetails.artifact"
              type="text"
              placeholder="PR, branch, doc, or decision"
              :disabled="sharingResult"
            />
          </label>
          <label>
            <span>Next owner</span>
            <input
              v-model="closeoutDetails.next_owner"
              type="text"
              placeholder="Owner"
              :disabled="sharingResult"
            />
          </label>
          <DesktopSelectField
            v-model="closeoutDetails.review_state"
            label="Review"
            :options="reviewStateOptions"
            :disabled="sharingResult"
          />
          <DesktopSelectField
            v-model="closeoutDetails.blocker_state"
            label="Blockers"
            :options="blockerStateOptions"
            :disabled="sharingResult"
          />
          <DesktopSelectField
            v-model="closeoutDetails.parent_task_next"
            label="Suggested task next step"
            :options="parentTaskNextOptions"
            :disabled="sharingResult"
          />
        </div>

        <p class="focus-room-muted">
          {{
            quickClose
              ? "Closes the room without a new outcome. Its history stays available."
              : currentSettings.parent_visibility === "silent"
                ? "Closes this room and saves the outcome here without posting it to the main room."
                : "Closes this room and shares the outcome with the main room."
          }}<template v-if="room.sourceTaskId && !quickClose">
            The task next step is a recommendation; its status will not change
            automatically.</template
          >
        </p>
        <button
          class="focus-room-primary"
          type="submit"
          :disabled="!canShareResult || sharingResult"
        >
          {{ closeoutSubmitLabel }}
        </button>
      </form>

      <section
        v-else
        class="focus-room-outcome"
        data-testid="focus-room-conclusion"
      >
        <h4>Outcome</h4>
        <p>{{ sharedResultSummary }}</p>
      </section>
    </section>

    <RoomsDirectory
      v-else
      :key="room.identifier"
      :rooms="directoryRooms"
      :tasks="directoryTasks"
      :parent-label="room.displayName"
      :busy="creatingAdHoc || creatingTaskFocus"
      :error="creationError"
      can-refresh
      @refresh="emit('refresh-room')"
      @open="openDirectoryRoom"
      @select="selectedFocusRoomId = $event"
      @create-topic="createAdHocFocusRoom"
      @create-task="createTaskRoom"
    >
      <template #details>
        <template v-if="selectedFocusRoom">
          <div class="rooms-detail-meta">
            <span>Created {{ formatDate(selectedFocusRoom.createdAt) }}</span>
            <span v-if="selectedFocusRoom.concludedAt"
              >Closed {{ formatDate(selectedFocusRoom.concludedAt) }}</span
            >
            <span v-if="selectedFocusRoom.gitRoom"
              >{{ selectedFocusRoom.gitRoom.repository.fullName }} ·
              {{ gitRoomRefLabel(selectedFocusRoom.gitRoom) }}</span
            >
          </div>
          <section
            v-if="
              selectedFocusRoom.focusStatus === 'concluded' ||
              selectedFocusRoom.conclusionSummary
            "
            class="rooms-detail-outcome"
          >
            <h3>Outcome</h3>
            <p>
              {{
                selectedFocusRoom.conclusionSummary ||
                "No outcome was recorded. You can still open the conversation."
              }}
            </p>
            <p v-if="selectedFocusRoom.conclusionDetails">
              <strong>Result:</strong>
              {{ selectedFocusRoom.conclusionDetails.artifact }}<br /><strong
                >Next owner:</strong
              >
              {{ selectedFocusRoom.conclusionDetails.next_owner }}
            </p>
          </section>
          <div class="rooms-detail-actions">
            <button
              class="rooms-button rooms-button-primary"
              type="button"
              @click="openFocusRoom(selectedFocusRoom.identifier)"
            >
              Open room <ArrowRight :size="15" aria-hidden="true" />
            </button>
            <button
              class="rooms-button"
              type="button"
              @click="copyFocusRoomUrl(selectedFocusRoom)"
            >
              <Copy :size="14" aria-hidden="true" /> Copy link
            </button>
            <button
              v-if="selectedFocusRoom.focusStatus !== 'concluded'"
              class="rooms-button"
              type="button"
              @click="closeFocusRoom(selectedFocusRoom)"
            >
              Close room…
            </button>
            <button
              v-if="canArchiveFocusRooms"
              class="rooms-button"
              type="button"
              :disabled="Boolean(archivingFocusKey)"
              @click="archiveFocusRoom(selectedFocusRoom)"
            >
              {{ archivingFocusKey ? "Hiding…" : "Hide room…" }}
            </button>
          </div>
          <details
            v-if="settingsTarget?.focusKey"
            class="rooms-settings desktop-room-settings"
          >
            <summary>
              Room settings<span v-if="settingsChanged">
                · Unsaved changes</span
              >
            </summary>
            <form class="focus-room-form" @submit.prevent="saveSettings">
              <p class="focus-room-muted">
                Choose which updates are shared with the main room.
              </p>
              <div class="focus-room-select-grid">
                <DesktopSelectField
                  v-model="settingsDraft.parent_visibility"
                  label="Share with main room"
                  :options="parentVisibilityOptions"
                  :disabled="savingSettings"
                />
                <DesktopSelectField
                  v-model="settingsDraft.activity_scope"
                  label="Related work"
                  :options="activityScopeOptions"
                  :disabled="savingSettings"
                />
                <DesktopSelectField
                  v-model="settingsDraft.github_event_routing"
                  label="GitHub updates"
                  :options="githubRoutingOptions"
                  :disabled="savingSettings"
                />
              </div>
              <button
                class="rooms-button"
                type="submit"
                :disabled="!settingsChanged || savingSettings"
              >
                {{ savingSettings ? "Saving…" : "Save settings" }}
              </button>
            </form>
          </details>
        </template>
      </template>
    </RoomsDirectory>

    <Teleport to="body">
      <Transition name="focus-room-toast">
        <p
          v-if="actionFeedback"
          class="focus-room-toast"
          :data-state="actionFeedbackState"
          role="status"
          aria-live="polite"
        >
          {{ actionFeedback }}
        </p>
      </Transition>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import { ArrowRight, Copy, RefreshCw } from "@lucide/vue";
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { copyTextToClipboard } from "../../../domain/clipboard";
import {
  buildFocusRoomConclusionInput,
  canSubmitFocusRoomConclusion,
  createDefaultFocusRoomConclusionDetails,
  focusRoomBlockerStateOptions as blockerStateOptions,
  focusRoomParentTaskNextOptions as parentTaskNextOptions,
  focusRoomReviewStateOptions as reviewStateOptions,
  type FocusRoomConcludedEvent,
} from "../../../domain/focus-room-conclusion";
import { buildLetAgentsFocusRoomUrl } from "../../../domain/room-urls";
import { formatShortDateTime } from "../../../domain/time";
import { safeUserVisibleErrorDetail } from "../../../domain/user-visible-error";
import DesktopSelectField from "../controls/DesktopSelectField.vue";
import FocusRoomQuickCloseOption from "../controls/FocusRoomQuickCloseOption.vue";
import RoomsDirectory from "../../../../../../../shared/rooms/RoomsDirectory.vue";
import {
  roomDisplayTitle,
  type DirectoryRoom,
  type DirectoryTask,
} from "../../../../../../../shared/rooms/directory";
import { desktopIpc } from "../../../ipc/index.js";
import type {
  DesktopFocusActivityScope,
  DesktopGitRoomInfo,
  DesktopFocusGitHubEventRouting,
  DesktopFocusParentVisibility,
  DesktopFocusRoomInfo,
  DesktopFocusRoomSettings,
  DesktopRoomInfo,
  DesktopTaskSummary,
} from "../../../../../electron/ipc-types";

type FeedbackState = "info" | "error" | "success";

interface Option<T extends string> {
  value: T;
  label: string;
}

const DEFAULT_SETTINGS: DesktopFocusRoomSettings = {
  parent_visibility: "summary_only",
  activity_scope: "task_and_branch",
  github_event_routing: "task_and_branch",
};

const parentVisibilityOptions: Array<Option<DesktopFocusParentVisibility>> = [
  { value: "summary_only", label: "Final note only" },
  { value: "major_activity", label: "Important updates" },
  { value: "all_activity", label: "Every update" },
  { value: "silent", label: "Nothing automatic" },
];

const activityScopeOptions: Array<Option<DesktopFocusActivityScope>> = [
  { value: "task_and_branch", label: "Task and linked code" },
  { value: "task_only", label: "Task only" },
  { value: "room", label: "Whole room" },
];

const githubRoutingOptions: Array<Option<DesktopFocusGitHubEventRouting>> = [
  { value: "task_and_branch", label: "Related code" },
  { value: "focus_owned_only", label: "Keep related code here" },
  { value: "task_only", label: "Only task mentions" },
  { value: "all_parent_repo", label: "All repo activity" },
  { value: "off", label: "Off" },
];

const props = defineProps<{
  room: DesktopRoomInfo;
  focusRooms: DesktopFocusRoomInfo[];
  tasks: DesktopTaskSummary[];
  onFocusRoomConcluded?: (event: FocusRoomConcludedEvent) => Promise<void>;
}>();

const emit = defineEmits<{
  "open-focus-room": [roomIdentifier: string];
  "refresh-room": [];
  "request-focus-room-conclusion": [focusRoom: DesktopFocusRoomInfo];
}>();

const selectedFocusRoomId = ref<string | null>(null);
const creationError = ref<string | null>(null);
let createdTopic: { parent: string; title: string; identifier: string } | null =
  null;
const creatingAdHoc = ref(false);
const creatingTaskFocus = ref(false);
const savingSettings = ref(false);
const sharingResult = ref(false);
const resultSubmitted = ref(false);
const archivingFocusKey = ref<string | null>(null);
const actionFeedback = ref<string | null>(null);
const actionFeedbackState = ref<FeedbackState>("info");
let feedbackTimer: number | null = null;
let roomGeneration = 0;
const resultSummary = ref("");
const quickClose = ref(false);
const settingsDraft = reactive<DesktopFocusRoomSettings>({
  ...DEFAULT_SETTINGS,
});
const closeoutDetails = reactive(createDefaultFocusRoomConclusionDetails());

const candidateTasks = computed(() =>
  props.tasks.filter((task) => !["done", "cancelled"].includes(task.status)),
);

const focusRoomByTaskId = computed(() => {
  const rooms = new Map<string, DesktopFocusRoomInfo>();
  for (const item of props.focusRooms) {
    if (!item.sourceTaskId) continue;
    const existing = rooms.get(item.sourceTaskId);
    if (
      !existing ||
      (existing.focusStatus === "concluded" && item.focusStatus !== "concluded")
    )
      rooms.set(item.sourceTaskId, item);
  }
  return rooms;
});

const selectedFocusRoom = computed(() =>
  selectedFocusRoomId.value
    ? (props.focusRooms.find(
        (focusRoom) => focusRoom.roomId === selectedFocusRoomId.value,
      ) ?? null)
    : null,
);

const selectedFocusRoomSettings = computed(
  () => selectedFocusRoom.value?.focusSettings || DEFAULT_SETTINGS,
);

const currentSettings = computed(
  () => props.room.focusSettings || DEFAULT_SETTINGS,
);

const settingsTarget = computed(() => {
  if (props.room.kind === "focus") {
    return {
      parentRoomId: props.room.parentRoomId,
      focusKey: props.room.focusKey || props.room.sourceTaskId,
      settings: currentSettings.value,
    };
  }
  if (!selectedFocusRoom.value) return null;
  return {
    parentRoomId: props.room.identifier,
    focusKey:
      selectedFocusRoom.value.focusKey || selectedFocusRoom.value.sourceTaskId,
    settings: selectedFocusRoomSettings.value,
  };
});

const settingsChanged = computed(() => {
  const current = settingsTarget.value?.settings || DEFAULT_SETTINGS;
  return (
    settingsDraft.parent_visibility !== current.parent_visibility ||
    settingsDraft.activity_scope !== current.activity_scope ||
    settingsDraft.github_event_routing !== current.github_event_routing
  );
});

const canShareResult = computed(() => {
  if (
    props.room.kind !== "focus" ||
    props.room.focusStatus === "concluded" ||
    resultSubmitted.value
  )
    return false;
  return canSubmitFocusRoomConclusion(
    resultSummary.value,
    props.room.sourceTaskId,
    closeoutDetails,
    quickClose.value,
  );
});

const closeoutSubmitLabel = computed(() => {
  if (sharingResult.value)
    return quickClose.value ? "Closing..." : "Sharing...";
  return quickClose.value
    ? "Close room"
    : currentSettings.value.parent_visibility === "silent"
      ? "Save outcome and close"
      : "Share outcome and close";
});

const sharedResultSummary = computed(
  () =>
    props.room.conclusionSummary ||
    (resultSubmitted.value ? resultSummary.value.trim() : "") ||
    "No result summary was recorded.",
);

const canArchiveFocusRooms = computed(() => props.room.role === "admin");

const directoryRooms = computed<DirectoryRoom[]>(() =>
  props.focusRooms.map((item) => ({
    id: item.roomId,
    title: roomDisplayTitle(item.displayName),
    kind: item.gitRoom ? "branch" : item.sourceTaskId ? "task" : "topic",
    kindLabel: item.gitRoom ? gitRoomRefTypeLabel(item.gitRoom) : undefined,
    closed: item.focusStatus === "concluded",
    description:
      item.focusStatus === "concluded"
        ? item.conclusionSummary || ""
        : item.gitRoom
          ? gitRoomRefLabel(item.gitRoom)
          : props.tasks.find((task) => task.id === item.sourceTaskId)?.title ||
            "",
    createdAt: item.createdAt,
    closedAt: item.concludedAt,
    searchText: `${item.sourceTaskId || ""} ${item.gitRoom?.repository.fullName || ""}`,
  })),
);
const directoryTasks = computed<DirectoryTask[]>(() =>
  candidateTasks.value.map((task) => {
    const existing = focusRoomByTaskId.value.get(task.id);
    return {
      id: task.id,
      title: task.title,
      description: task.description || "",
      status: task.status,
      roomId: existing?.roomId,
      roomClosed: existing?.focusStatus === "concluded",
    };
  }),
);
const headerMeta = computed(() =>
  props.room.gitRoom
    ? `${gitRoomRefTypeLabel(props.room.gitRoom)} · ${gitRoomRefLabel(props.room.gitRoom)} · ${props.room.gitRoom.repository.fullName}`
    : "Keep the work here. Record the outcome when it is ready.",
);

function gitRoomRefTypeLabel(gitRoom: DesktopGitRoomInfo): string {
  switch (gitRoom.ref.type) {
    case "default_branch":
      return "Default branch";
    case "branch":
      return "Branch";
    case "tag":
      return "Tag";
    case "pull_request":
      return "Pull request";
    default:
      return "Git ref";
  }
}

function gitRoomRefLabel(gitRoom: DesktopGitRoomInfo): string {
  const ref = gitRoom.ref;
  if (
    ref.name &&
    ref.headRepository?.fullName &&
    ref.headRepository.fullName !== gitRoom.repository.fullName
  ) {
    return `${ref.headRepository.owner}:${ref.name}`;
  }
  return ref.name || ref.defaultBranch || ref.type.replace("_", " ");
}

watch(
  () =>
    [
      settingsTarget.value?.parentRoomId,
      settingsTarget.value?.focusKey,
      JSON.stringify(settingsTarget.value?.settings || DEFAULT_SETTINGS),
    ] as const,
  ([parent, key, settings], previous) => {
    if (
      !previous ||
      parent !== previous[0] ||
      key !== previous[1] ||
      JSON.stringify(settingsDraft) === previous[2]
    ) {
      Object.assign(settingsDraft, JSON.parse(settings));
    }
  },
  { immediate: true },
);
watch(
  () => [props.room.identifier, props.room.conclusionSummary || ""] as const,
  ([id, summary], previous) => {
    if (!previous || id !== previous[0] || resultSummary.value === previous[1])
      resultSummary.value = summary;
  },
  { immediate: true },
);
watch(
  () => props.room.identifier,
  () => {
    roomGeneration++;
    createdTopic = null;
    resultSubmitted.value = false;
    quickClose.value = false;
    selectedFocusRoomId.value = null;
    creationError.value = null;
  },
  { flush: "sync" },
);
watch(
  () =>
    [
      props.room.identifier,
      JSON.stringify(
        props.room.conclusionDetails ||
          createDefaultFocusRoomConclusionDetails(),
      ),
    ] as const,
  ([id, details], previous) => {
    if (
      !previous ||
      id !== previous[0] ||
      JSON.stringify(closeoutDetails) === previous[1]
    )
      Object.assign(closeoutDetails, JSON.parse(details));
  },
  { immediate: true },
);
function openDirectoryRoom(id: string): void {
  const target = props.focusRooms.find((item) => item.roomId === id);
  if (target) openFocusRoom(target.identifier);
}
function createTaskRoom(id: string): void {
  const task = candidateTasks.value.find((item) => item.id === id);
  if (task) void openOrCreateTaskFocusRoom(task);
}

function openFocusRoom(roomIdentifier: string): void {
  emit("open-focus-room", roomIdentifier);
}

function focusKeyFor(focusRoom: DesktopFocusRoomInfo | null): string | null {
  return focusRoom?.focusKey || focusRoom?.sourceTaskId || null;
}

function focusRoomUrl(focusRoom: DesktopFocusRoomInfo): string {
  const parentRoomId =
    focusRoom.parentRoomId ||
    (props.room.kind === "focus"
      ? props.room.parentRoomId
      : props.room.identifier);
  return buildLetAgentsFocusRoomUrl({
    roomIdentifier: focusRoom.roomId || focusRoom.identifier,
    parentRoomId,
    focusKey: focusRoom.focusKey,
    sourceTaskId: focusRoom.sourceTaskId,
  });
}

async function copyFocusRoomUrl(
  focusRoom: DesktopFocusRoomInfo,
): Promise<void> {
  const copied = await copyTextToClipboard(focusRoomUrl(focusRoom));
  if (copied) {
    setFeedback("Room URL copied.", "success");
  } else {
    setFeedback("Room URL could not be copied.", "error");
  }
}

async function createAdHocFocusRoom(title: string): Promise<void> {
  title = title.trim();
  if (
    !title ||
    creatingAdHoc.value ||
    creatingTaskFocus.value ||
    props.room.kind === "focus"
  )
    return;
  const parent = props.room.identifier;
  const version = roomGeneration;
  if (createdTopic?.parent === parent && createdTopic.title === title) {
    openFocusRoom(createdTopic.identifier);
    return;
  }
  creatingAdHoc.value = true;
  creationError.value = null;
  try {
    const result = await desktopIpc.room.createAdHocFocusRoom(parent, title);
    if (roomGeneration !== version || props.room.identifier !== parent) return;
    createdTopic = { parent, title, identifier: result.focusRoom.identifier };
    emit("refresh-room");
    openFocusRoom(result.focusRoom.identifier);
  } catch (error) {
    if (roomGeneration === version && props.room.identifier === parent)
      creationError.value = errorMessage(
        error,
        "Could not create the room. Your name is still here; try again.",
      );
  } finally {
    creatingAdHoc.value = false;
  }
}

async function openOrCreateTaskFocusRoom(
  task: DesktopTaskSummary,
): Promise<void> {
  const existing = focusRoomByTaskId.value.get(task.id);
  if (existing) {
    openFocusRoom(existing.identifier);
    return;
  }
  if (
    creatingTaskFocus.value ||
    creatingAdHoc.value ||
    props.room.kind === "focus"
  )
    return;
  const parent = props.room.identifier;
  const version = roomGeneration;
  creatingTaskFocus.value = true;
  creationError.value = null;
  try {
    const result = await desktopIpc.room.createTaskFocusRoom(parent, task.id);
    if (roomGeneration !== version || props.room.identifier !== parent) return;
    emit("refresh-room");
    openFocusRoom(result.focusRoom.identifier);
  } catch (error) {
    if (roomGeneration === version && props.room.identifier === parent)
      creationError.value = errorMessage(
        error,
        "Could not open the task room. Try again.",
      );
  } finally {
    creatingTaskFocus.value = false;
  }
}

async function saveSettings(): Promise<void> {
  const target = settingsTarget.value;
  if (
    !target?.parentRoomId ||
    !target.focusKey ||
    !settingsChanged.value ||
    savingSettings.value
  )
    return;
  const origin = props.room.identifier;
  const version = roomGeneration;
  savingSettings.value = true;
  setFeedback(null);
  try {
    await desktopIpc.room.updateFocusRoomSettings(
      target.parentRoomId,
      target.focusKey,
      { ...settingsDraft },
    );
    if (roomGeneration !== version || props.room.identifier !== origin) return;
    emit("refresh-room");
    setFeedback("Room settings saved.", "success");
  } catch (error) {
    if (roomGeneration === version && props.room.identifier === origin)
      setFeedback(
        errorMessage(error, "Room settings could not be saved."),
        "error",
      );
  } finally {
    savingSettings.value = false;
  }
}

function closeFocusRoom(focusRoom: DesktopFocusRoomInfo): void {
  const focusKey = focusKeyFor(focusRoom);
  const parentRoomId = focusRoom.parentRoomId || props.room.identifier;
  if (!focusKey || !parentRoomId) return;
  emit("request-focus-room-conclusion", focusRoom);
}

async function archiveFocusRoom(
  focusRoom: DesktopFocusRoomInfo,
): Promise<void> {
  const focusKey = focusKeyFor(focusRoom);
  const parentRoomId = focusRoom.parentRoomId || props.room.identifier;
  if (
    !focusKey ||
    !parentRoomId ||
    archivingFocusKey.value ||
    !canArchiveFocusRooms.value
  )
    return;
  const origin = props.room.identifier;
  const version = roomGeneration;

  const confirmed = window.confirm(
    `Hide ${roomDisplayTitle(focusRoom.displayName)}? It will be removed from this list, but the room history is preserved.`,
  );
  if (!confirmed) return;

  archivingFocusKey.value = focusKey;
  setFeedback(null);
  try {
    await desktopIpc.room.archiveFocusRoom(parentRoomId, focusKey);
    if (roomGeneration !== version || props.room.identifier !== origin) return;
    if (selectedFocusRoomId.value === focusRoom.roomId) {
      selectedFocusRoomId.value = null;
    }
    emit("refresh-room");
    setFeedback("Room hidden.", "success");
  } catch (error) {
    if (roomGeneration === version)
      setFeedback(errorMessage(error, "Room could not be hidden."), "error");
  } finally {
    archivingFocusKey.value = null;
  }
}

async function shareFocusRoomResult(): Promise<void> {
  if (!canShareResult.value || sharingResult.value) return;
  const parentRoomId = props.room.parentRoomId;
  const focusKey = props.room.focusKey || props.room.sourceTaskId;
  if (!parentRoomId || !focusKey) {
    setFeedback("This focus room is missing its parent link.", "error");
    return;
  }
  const origin = {
    identifier: props.room.identifier,
    displayName: props.room.displayName,
  };
  const version = roomGeneration;
  sharingResult.value = true;
  setFeedback(null);
  const input = buildFocusRoomConclusionInput(
    resultSummary.value,
    props.room.sourceTaskId,
    closeoutDetails,
    quickClose.value,
  );
  try {
    await desktopIpc.room.concludeFocusRoom(
      parentRoomId,
      focusKey,
      input.summary,
      input.details,
      input.quickClose,
    );
  } catch (error) {
    sharingResult.value = false;
    if (roomGeneration === version)
      setFeedback(errorMessage(error, "Result could not be shared."), "error");
    return;
  }

  if (
    roomGeneration !== version ||
    props.room.identifier !== origin.identifier
  ) {
    sharingResult.value = false;
    return;
  }
  resultSubmitted.value = true;
  try {
    await props.onFocusRoomConcluded?.({
      focusRoomIdentifier: origin.identifier,
      parentRoomIdentifier: parentRoomId,
      displayName: origin.displayName,
    });
  } catch (error) {
    setFeedback(
      errorMessage(
        error,
        "Result was shared, but the room list could not be refreshed.",
      ),
      "error",
    );
  } finally {
    sharingResult.value = false;
  }
}

function statusLabel(value: string): string {
  return value === "active"
    ? "Open"
    : value === "concluded"
      ? "Closed"
      : value.replace(/_/g, " ");
}

function parentVisibilityLabel(value: DesktopFocusParentVisibility): string {
  return (
    parentVisibilityOptions.find((option) => option.value === value)?.label ||
    "Final note only"
  );
}

function activityScopeLabel(value: DesktopFocusActivityScope): string {
  return (
    activityScopeOptions.find((option) => option.value === value)?.label ||
    "Task and linked code"
  );
}

function githubRoutingLabel(value: DesktopFocusGitHubEventRouting): string {
  return (
    githubRoutingOptions.find((option) => option.value === value)?.label ||
    "Related code"
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Unknown";
  return formatShortDateTime(value, { hourStyle: "numeric" }) ?? value;
}

function setFeedback(
  message: string | null,
  state: FeedbackState = "info",
): void {
  if (feedbackTimer !== null) {
    window.clearTimeout(feedbackTimer);
    feedbackTimer = null;
  }
  actionFeedback.value = message;
  actionFeedbackState.value = state;
  if (message) {
    feedbackTimer = window.setTimeout(() => {
      actionFeedback.value = null;
      feedbackTimer = null;
    }, 2400);
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return safeUserVisibleErrorDetail(error, fallback);
}

onBeforeUnmount(() => {
  roomGeneration++;
  if (feedbackTimer !== null) {
    window.clearTimeout(feedbackTimer);
    feedbackTimer = null;
  }
});
</script>
