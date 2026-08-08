<template>
  <section class="room-tab-page focus-room-manager" data-testid="room-details-view">
    <header class="focus-room-header">
      <div>
        <p class="focus-room-kicker">{{ room.kind === "focus" ? "Focus room" : "Rooms" }}</p>
        <h2>{{ room.kind === "focus" ? room.displayName : "Focus rooms" }}</h2>
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

    <section v-if="room.kind === 'focus'" class="focus-room-current" data-testid="current-focus-room">
      <div class="focus-room-current-main">
        <div class="focus-room-title-line">
          <span class="focus-room-dot" :data-state="room.focusStatus || 'active'"></span>
          <div>
            <h3>{{ room.displayName }}</h3>
            <p>{{ room.sourceTaskId || room.focusKey || room.identifier }}</p>
          </div>
          <span class="focus-room-state" :data-state="room.focusStatus || 'active'">
            {{ statusLabel(room.focusStatus || "active") }}
          </span>
        </div>

        <dl class="focus-room-facts">
          <div>
            <dt>Parent</dt>
            <dd>{{ room.parentRoomId || "No parent room" }}</dd>
          </div>
          <div>
            <dt>Parent room updates</dt>
            <dd>{{ parentVisibilityLabel(currentSettings.parent_visibility) }}</dd>
          </div>
          <div>
            <dt>Activity shown</dt>
            <dd>{{ activityScopeLabel(currentSettings.activity_scope) }}</dd>
          </div>
          <div>
            <dt>GitHub</dt>
            <dd>{{ githubRoutingLabel(currentSettings.github_event_routing) }}</dd>
          </div>
        </dl>
      </div>

      <form class="focus-room-form" data-testid="focus-room-settings-form" @submit.prevent="saveSettings">
        <div class="focus-room-section-heading">
          <h4>Updates to parent room</h4>
          <span v-if="settingsChanged">Unsaved</span>
        </div>
        <div class="focus-room-select-grid">
          <DesktopSelectField
            v-model="settingsDraft.parent_visibility"
            label="Parent room updates"
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
        <button class="focus-room-secondary" type="submit" :disabled="!settingsChanged || savingSettings">
          {{ savingSettings ? "Saving..." : "Save changes" }}
        </button>
      </form>

      <form
        v-if="room.focusStatus !== 'concluded'"
        class="focus-room-form"
        data-testid="focus-room-closeout-form"
        @submit.prevent="shareFocusRoomResult"
      >
        <div class="focus-room-section-heading">
          <h4>Send result to parent room</h4>
        </div>
        <textarea
          v-model="resultSummary"
          rows="4"
          placeholder="Outcome summary"
          :disabled="sharingResult"
        ></textarea>

        <div v-if="room.sourceTaskId" class="focus-room-closeout-grid">
          <label>
            <span>Artifact</span>
            <input v-model="closeoutDetails.artifact" type="text" placeholder="PR, branch, doc, or decision" :disabled="sharingResult" />
          </label>
          <label>
            <span>Next owner</span>
            <input v-model="closeoutDetails.next_owner" type="text" placeholder="Owner" :disabled="sharingResult" />
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
            label="Parent task"
            :options="parentTaskNextOptions"
            :disabled="sharingResult"
          />
        </div>

        <button class="focus-room-primary" type="submit" :disabled="!canShareResult || sharingResult">
          {{ sharingResult ? "Sharing..." : "Send result to parent room" }}
        </button>
      </form>

      <section v-else class="focus-room-outcome" data-testid="focus-room-conclusion">
        <h4>Shared result</h4>
        <p>{{ room.conclusionSummary || "No result summary was recorded." }}</p>
      </section>
    </section>

    <template v-else>
      <div class="focus-room-toolbar">
        <label class="focus-room-search">
          <Search :size="16" aria-hidden="true" />
          <input
            v-model="searchQuery"
            type="search"
            placeholder="Search rooms and tasks"
            aria-label="Search rooms and tasks"
          />
        </label>

        <DesktopSegmentedControl
          class="focus-room-tabs"
          :model-value="activeTab"
          :options="tabOptions"
          label="Room manager view"
          mode="tabs"
          size="large"
          @update:model-value="setActiveTab"
        />
      </div>

      <form class="focus-room-create" data-testid="create-ad-hoc-focus-room" @submit.prevent="createAdHocFocusRoom">
        <Plus :size="16" aria-hidden="true" />
        <input
          v-model="adHocTitle"
          type="text"
          placeholder="Focus room goal"
          aria-label="New focus room title"
          :disabled="creatingAdHoc"
        />
        <button type="submit" :disabled="!adHocTitle.trim() || creatingAdHoc">
          {{ creatingAdHoc ? "Creating..." : "Create" }}
        </button>
      </form>

      <div class="focus-room-layout">
        <main class="focus-room-list-pane" data-testid="focus-room-list">
          <Transition name="focus-room-filter" mode="out-in">
            <div v-if="activeTab !== 'tasks'" :key="`focus-${activeTab}`" class="focus-room-list-set">
              <TransitionGroup name="focus-room-row-motion" tag="div" class="focus-room-row-list">
                <button
                  v-for="focusRoom in visibleFocusRooms"
                  :key="focusRoom.roomId"
                  class="focus-room-row"
                  type="button"
                  :data-selected="selectedFocusRoom?.roomId === focusRoom.roomId"
                  :data-testid="`room-focus-${focusRoom.roomId}`"
                  @click="selectFocusRoom(focusRoom.roomId)"
                  @contextmenu.prevent.stop="openFocusRoomContextMenu($event, focusRoom)"
                >
                  <span class="focus-room-dot" :data-state="focusRoom.focusStatus || 'active'"></span>
                  <span class="focus-room-row-copy">
                    <strong>{{ focusRoom.displayName }}</strong>
                    <span>{{ focusRoom.sourceTaskId || focusRoom.code || focusRoom.identifier }}</span>
                  </span>
                  <span class="focus-room-row-meta">
                    <span class="focus-room-state" :data-state="focusRoom.focusStatus || 'active'">
                      {{ statusLabel(focusRoom.focusStatus || "active") }}
                    </span>
                    <small>{{ formatDate(focusRoom.createdAt) }}</small>
                  </span>
                </button>
              </TransitionGroup>

              <article v-if="!visibleFocusRooms.length" class="focus-room-empty" data-testid="room-focus-empty">
                <h3>{{ activeTab === "concluded" ? "No closed focus rooms" : "No open focus rooms" }}</h3>
                <p>{{ searchQuery ? "No rooms match this search." : "No matching records in this room." }}</p>
              </article>
            </div>

            <div v-else key="tasks" class="focus-room-list-set">
              <TransitionGroup name="focus-room-row-motion" tag="div" class="focus-room-row-list">
                <button
                  v-for="task in visibleTasks"
                  :key="task.id"
                  class="focus-room-row task-row"
                  type="button"
                  :data-selected="selectedTask?.id === task.id"
                  :data-testid="`room-task-${task.id}`"
                  @click="selectTask(task.id)"
                >
                  <span class="focus-room-task-mark">{{ taskInitial(task.title) }}</span>
                  <span class="focus-room-row-copy">
                    <strong>{{ task.title }}</strong>
                    <span>{{ task.assignee || task.description || task.id }}</span>
                  </span>
                  <span class="focus-room-row-meta">
                    <span class="focus-room-state">{{ statusLabel(task.status) }}</span>
                    <small>{{ focusRoomByTaskId.get(task.id) ? "Has room" : task.id }}</small>
                  </span>
                </button>
              </TransitionGroup>

              <article v-if="!visibleTasks.length" class="focus-room-empty" data-testid="room-tasks-empty">
                <h3>No matching tasks</h3>
                <p>{{ searchQuery ? "No tasks match this search." : "Open tasks will appear here." }}</p>
              </article>
            </div>
          </Transition>
        </main>

        <aside
          id="focus-room-detail-panel"
          class="focus-room-detail"
          data-testid="focus-room-detail-panel"
          @contextmenu.prevent.stop="selectedFocusRoom && openFocusRoomContextMenu($event, selectedFocusRoom)"
        >
          <Transition name="focus-room-detail-motion" mode="out-in">
            <div v-if="selectedFocusRoom" :key="`focus-${selectedFocusRoom.roomId}`" class="focus-room-detail-content">
              <div class="focus-room-detail-header">
                <div>
                  <p class="focus-room-kicker">Focus room</p>
                  <h3>{{ selectedFocusRoom.displayName }}</h3>
                </div>
                <span class="focus-room-state" :data-state="selectedFocusRoom.focusStatus || 'active'">
                  {{ statusLabel(selectedFocusRoom.focusStatus || "active") }}
                </span>
              </div>

              <dl class="focus-room-facts">
                <div>
                  <dt>Source</dt>
                  <dd>{{ selectedFocusRoom.sourceTaskId || "Ad-hoc" }}</dd>
                </div>
                <div>
                  <dt>Room</dt>
                  <dd>{{ selectedFocusRoom.code || selectedFocusRoom.identifier }}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{{ formatDate(selectedFocusRoom.createdAt) }}</dd>
                </div>
                <div>
                  <dt>Updates</dt>
                  <dd>{{ parentVisibilityLabel(selectedFocusRoomSettings.parent_visibility) }}</dd>
                </div>
                <div>
                  <dt>Scope</dt>
                  <dd>{{ activityScopeLabel(selectedFocusRoomSettings.activity_scope) }}</dd>
                </div>
                <div>
                  <dt>GitHub</dt>
                  <dd>{{ githubRoutingLabel(selectedFocusRoomSettings.github_event_routing) }}</dd>
                </div>
              </dl>

              <section class="focus-room-outcome">
                <h4>Result</h4>
                <p>{{ selectedFocusRoom.conclusionSummary || "No result shared yet." }}</p>
              </section>

              <form
                v-if="selectedFocusRoom.focusStatus !== 'concluded' && selectedFocusKey"
                class="focus-room-form compact"
                @submit.prevent="saveSettings"
              >
                <div class="focus-room-section-heading">
                  <h4>Routing</h4>
                  <span v-if="settingsChanged">Unsaved</span>
                </div>
                <div class="focus-room-select-grid single">
                  <DesktopSelectField
                    v-model="settingsDraft.parent_visibility"
                    label="Parent room updates"
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
                    label="GitHub routing"
                    :options="githubRoutingOptions"
                    :disabled="savingSettings"
                  />
                </div>
                <button class="focus-room-secondary" type="submit" :disabled="!settingsChanged || savingSettings">
                  {{ savingSettings ? "Saving..." : "Save routing" }}
                </button>
              </form>

              <button class="focus-room-primary wide" type="button" @click="openFocusRoom(selectedFocusRoom.identifier)">
                Open room
                <ArrowRight :size="15" aria-hidden="true" />
              </button>

              <div class="focus-room-actions">
                <button
                  class="focus-room-secondary"
                  type="button"
                  @click="copyFocusRoomUrl(selectedFocusRoom)"
                >
                  <Copy :size="15" aria-hidden="true" />
                  Copy URL
                </button>
                <button
                  v-if="selectedFocusRoom.focusStatus !== 'concluded'"
                  class="focus-room-secondary"
                  type="button"
                  :disabled="closingFocusKey === focusKeyFor(selectedFocusRoom)"
                  @click="closeFocusRoom(selectedFocusRoom)"
                >
                  <CheckCircle2 :size="15" aria-hidden="true" />
                  {{ closingFocusKey === focusKeyFor(selectedFocusRoom) ? "Completing..." : "Mark complete" }}
                </button>
                <button
                  v-if="canArchiveFocusRooms"
                  class="focus-room-danger"
                  type="button"
                  :disabled="archivingFocusKey === focusKeyFor(selectedFocusRoom)"
                  @click="archiveFocusRoom(selectedFocusRoom)"
                >
                  <Archive :size="15" aria-hidden="true" />
                  {{ archivingFocusKey === focusKeyFor(selectedFocusRoom) ? "Hiding..." : "Hide focus room" }}
                </button>
              </div>
            </div>

            <div v-else-if="selectedTask" :key="`task-${selectedTask.id}`" class="focus-room-detail-content">
              <div class="focus-room-detail-header">
                <div>
                  <p class="focus-room-kicker">Task</p>
                  <h3>{{ selectedTask.title }}</h3>
                </div>
                <span class="focus-room-state">{{ statusLabel(selectedTask.status) }}</span>
              </div>

              <dl class="focus-room-facts">
                <div>
                  <dt>Task id</dt>
                  <dd>{{ selectedTask.id }}</dd>
                </div>
                <div>
                  <dt>Assignee</dt>
                  <dd>{{ selectedTask.assignee || "Unassigned" }}</dd>
                </div>
                <div>
                  <dt>Focus room</dt>
                  <dd>{{ currentTaskFocusRoom?.displayName || "Not opened" }}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{{ formatDate(selectedTask.updatedAt) }}</dd>
                </div>
              </dl>

              <p v-if="selectedTask.description" class="focus-room-task-description">
                {{ selectedTask.description }}
              </p>

              <button
                class="focus-room-primary wide"
                type="button"
                :disabled="creatingTaskFocus"
                @click="openOrCreateTaskFocusRoom(selectedTask)"
              >
                {{ currentTaskFocusRoom ? "Open focus room" : creatingTaskFocus ? "Opening..." : "Create focus room" }}
                <ArrowRight :size="15" aria-hidden="true" />
              </button>
            </div>

            <article v-else key="empty" class="focus-room-empty detail-empty">
              <h3>No selection</h3>
              <p>Nothing selected.</p>
            </article>
          </Transition>
        </aside>
      </div>

      <RepoStatusView
        v-if="showRepoStatusDetails"
        class="focus-room-repo-status"
        :repo-status="repoStatus"
      />
    </template>

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

    <div
      v-if="focusRoomContextMenu"
      class="focus-room-context-menu"
      role="menu"
      :style="{ left: `${focusRoomContextMenu.x}px`, top: `${focusRoomContextMenu.y}px` }"
      data-testid="focus-room-context-menu"
      @click.stop
      @contextmenu.prevent
    >
      <p class="focus-room-context-title">{{ focusRoomContextMenu.room.displayName }}</p>
      <button type="button" role="menuitem" @click="openContextFocusRoom">
        <ExternalLink :size="15" aria-hidden="true" />
        Open room
      </button>
      <button type="button" role="menuitem" @click="copyContextFocusRoomUrl">
        <Copy :size="15" aria-hidden="true" />
        Copy URL
      </button>
      <button
        v-if="focusRoomContextMenu.room.focusStatus !== 'concluded'"
        type="button"
        role="menuitem"
        @click="closeContextFocusRoom"
      >
        <CheckCircle2 :size="15" aria-hidden="true" />
        Mark focus room complete
      </button>
      <button v-if="canArchiveFocusRooms" type="button" role="menuitem" class="danger" @click="archiveContextFocusRoom">
        <Archive :size="15" aria-hidden="true" />
        Hide focus room
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Archive, ArrowRight, CheckCircle2, Copy, ExternalLink, Plus, RefreshCw, Search } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { copyTextToClipboard } from "../../../domain/clipboard";
import {
  buildFocusRoomConclusionInput,
  canSubmitFocusRoomConclusion,
  createDefaultFocusRoomConclusionDetails,
  focusRoomBlockerStateOptions as blockerStateOptions,
  focusRoomParentTaskNextOptions as parentTaskNextOptions,
  focusRoomReviewStateOptions as reviewStateOptions,
} from "../../../domain/focus-room-conclusion";
import { shouldShowRepoEnvironmentForRoom } from "../../../domain/repo-environment";
import { buildLetAgentsFocusRoomUrl } from "../../../domain/room-urls";
import { formatShortDateTime } from "../../../domain/time";
import DesktopSegmentedControl from "../controls/DesktopSegmentedControl.vue";
import DesktopSelectField from "../controls/DesktopSelectField.vue";
import RepoStatusView from "./RepoStatusView.vue";
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
  RepoStatus,
} from "../../../../../electron/ipc-types";

type FocusRoomTab = "open" | "concluded" | "tasks";
type FeedbackState = "info" | "error" | "success";
type FocusRoomContextMenu = {
  room: DesktopFocusRoomInfo;
  x: number;
  y: number;
};

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
  repoStatus: RepoStatus;
  gitRoomMatchesActiveRepo: boolean;
  tasks: DesktopTaskSummary[];
}>();

const emit = defineEmits<{
  "open-focus-room": [roomIdentifier: string];
  "refresh-room": [];
}>();

const activeTab = ref<FocusRoomTab>("open");
const selectedFocusRoomId = ref<string | null>(null);
const selectedTaskId = ref<string | null>(null);
const searchQuery = ref("");
const adHocTitle = ref("");
const creatingAdHoc = ref(false);
const creatingTaskFocus = ref(false);
const savingSettings = ref(false);
const sharingResult = ref(false);
const archivingFocusKey = ref<string | null>(null);
const closingFocusKey = ref<string | null>(null);
const actionFeedback = ref<string | null>(null);
const actionFeedbackState = ref<FeedbackState>("info");
const focusRoomContextMenu = ref<FocusRoomContextMenu | null>(null);
let feedbackTimer: number | null = null;
const resultSummary = ref("");
const settingsDraft = reactive<DesktopFocusRoomSettings>({ ...DEFAULT_SETTINGS });
const closeoutDetails = reactive(createDefaultFocusRoomConclusionDetails());

const showRepoStatusDetails = computed(() =>
  shouldShowRepoEnvironmentForRoom(props.room, props.repoStatus, props.gitRoomMatchesActiveRepo)
);

const openFocusRooms = computed(() =>
  props.focusRooms.filter((focusRoom) => focusRoom.focusStatus !== "concluded")
);

const concludedFocusRooms = computed(() =>
  props.focusRooms.filter((focusRoom) => focusRoom.focusStatus === "concluded")
);

const candidateTasks = computed(() =>
  props.tasks.filter((task) => !["done", "cancelled"].includes(task.status))
);

const focusRoomByTaskId = computed(() => {
  const entries = props.focusRooms
    .filter((focusRoom) => focusRoom.sourceTaskId)
    .map((focusRoom) => [focusRoom.sourceTaskId as string, focusRoom] as const);
  return new Map(entries);
});

const selectedFocusRoom = computed(() =>
  selectedFocusRoomId.value
    ? props.focusRooms.find((focusRoom) => focusRoom.roomId === selectedFocusRoomId.value) ?? null
    : null
);

const selectedTask = computed(() =>
  selectedTaskId.value
    ? props.tasks.find((task) => task.id === selectedTaskId.value) ?? null
    : null
);

const currentTaskFocusRoom = computed(() =>
  selectedTask.value ? focusRoomByTaskId.value.get(selectedTask.value.id) ?? null : null
);

const selectedFocusRoomSettings = computed(() =>
  selectedFocusRoom.value?.focusSettings || DEFAULT_SETTINGS
);

const currentSettings = computed(() => props.room.focusSettings || DEFAULT_SETTINGS);

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
    focusKey: selectedFocusRoom.value.focusKey || selectedFocusRoom.value.sourceTaskId,
    settings: selectedFocusRoomSettings.value,
  };
});

const selectedFocusKey = computed(() => settingsTarget.value?.focusKey || null);

const settingsChanged = computed(() => {
  const current = settingsTarget.value?.settings || DEFAULT_SETTINGS;
  return (
    settingsDraft.parent_visibility !== current.parent_visibility ||
    settingsDraft.activity_scope !== current.activity_scope ||
    settingsDraft.github_event_routing !== current.github_event_routing
  );
});

const canShareResult = computed(() => {
  if (props.room.kind !== "focus" || props.room.focusStatus === "concluded") return false;
  return canSubmitFocusRoomConclusion(resultSummary.value, props.room.sourceTaskId, closeoutDetails);
});

const canArchiveFocusRooms = computed(() => props.room.role === "admin");

const tabOptions = computed(() => [
  { id: "open" as const, label: "Open", count: openFocusRooms.value.length },
  { id: "concluded" as const, label: "Closed", count: concludedFocusRooms.value.length },
  { id: "tasks" as const, label: "Tasks", count: candidateTasks.value.length },
]);

const visibleFocusRooms = computed(() => {
  const rooms = activeTab.value === "concluded" ? concludedFocusRooms.value : openFocusRooms.value;
  const query = normalizedSearch.value;
  if (!query) return rooms;
  return rooms.filter((focusRoom) =>
    [
      focusRoom.displayName,
      focusRoom.sourceTaskId || "",
      focusRoom.code || "",
      focusRoom.identifier,
      focusRoom.conclusionSummary || "",
    ].some((value) => value.toLowerCase().includes(query))
  );
});

const visibleTasks = computed(() => {
  const query = normalizedSearch.value;
  if (!query) return candidateTasks.value;
  return candidateTasks.value.filter((task) =>
    [
      task.id,
      task.title,
      task.description || "",
      task.assignee || "",
      task.status,
    ].some((value) => value.toLowerCase().includes(query))
  );
});

const normalizedSearch = computed(() => searchQuery.value.trim().toLowerCase());

const headerMeta = computed(() => {
  if (props.room.gitRoom) {
    return [
      gitRoomRefTypeLabel(props.room.gitRoom),
      gitRoomRefLabel(props.room.gitRoom),
      props.room.gitRoom.repository.fullName,
    ].filter(Boolean).join(" · ");
  }
  if (props.room.kind === "focus") {
    return [
      statusLabel(props.room.focusStatus || "active"),
      props.room.sourceTaskId || props.room.focusKey || props.room.identifier,
    ].filter(Boolean).join(" · ");
  }
  return `${openFocusRooms.value.length} open · ${concludedFocusRooms.value.length} closed · ${candidateTasks.value.length} task candidates`;
});

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
    ref.name
    && ref.headRepository?.fullName
    && ref.headRepository.fullName !== gitRoom.repository.fullName
  ) {
    return `${ref.headRepository.owner}:${ref.name}`;
  }
  return ref.name || ref.defaultBranch || ref.type.replace("_", " ");
}

watch(
  () => [props.focusRooms, props.tasks, props.room.kind, activeTab.value, searchQuery.value] as const,
  () => ensureSelectionMatchesActiveTab(),
  { immediate: true },
);

watch(
  settingsTarget,
  (target) => {
    const settings = target?.settings || DEFAULT_SETTINGS;
    settingsDraft.parent_visibility = settings.parent_visibility;
    settingsDraft.activity_scope = settings.activity_scope;
    settingsDraft.github_event_routing = settings.github_event_routing;
  },
  { immediate: true },
);

watch(
  () => props.room.conclusionSummary,
  (summary) => {
    resultSummary.value = summary || "";
  },
  { immediate: true },
);

watch(
  () => props.room.conclusionDetails,
  (details) => {
    closeoutDetails.artifact = details?.artifact || "";
    closeoutDetails.review_state = details?.review_state || "needs_review";
    closeoutDetails.blocker_state = details?.blocker_state || "none";
    closeoutDetails.parent_task_next = details?.parent_task_next || "keep_open";
    closeoutDetails.next_owner = details?.next_owner || "";
  },
  { immediate: true },
);

function selectFocusRoom(roomId: string): void {
  selectedFocusRoomId.value = roomId;
  selectedTaskId.value = null;
}

function selectTask(taskId: string): void {
  selectedTaskId.value = taskId;
  selectedFocusRoomId.value = null;
}

function setActiveTab(tab: string): void {
  activeTab.value = tab as FocusRoomTab;
  ensureSelectionMatchesActiveTab();
}

function ensureSelectionMatchesActiveTab(): void {
  if (props.room.kind === "focus") return;

  if (activeTab.value === "open" && !normalizedSearch.value && !openFocusRooms.value.length) {
    const firstFallbackFocusRoom = concludedFocusRooms.value[0] || null;
    if (firstFallbackFocusRoom) {
      activeTab.value = "concluded";
      selectedFocusRoomId.value = firstFallbackFocusRoom.roomId;
      selectedTaskId.value = null;
      return;
    }
    const firstFallbackTask = candidateTasks.value[0] || null;
    if (firstFallbackTask) {
      activeTab.value = "tasks";
      selectedTaskId.value = firstFallbackTask.id;
      selectedFocusRoomId.value = null;
      return;
    }
  }

  if (activeTab.value === "tasks") {
    const selectedTaskVisible = Boolean(
      selectedTaskId.value && visibleTasks.value.some((task) => task.id === selectedTaskId.value),
    );
    if (!selectedTaskVisible) {
      selectedTaskId.value = visibleTasks.value[0]?.id || null;
    }
    selectedFocusRoomId.value = null;
    return;
  }

  const selectedFocusRoomVisible = Boolean(
    selectedFocusRoomId.value && visibleFocusRooms.value.some((focusRoom) => focusRoom.roomId === selectedFocusRoomId.value),
  );
  if (!selectedFocusRoomVisible) {
    selectedFocusRoomId.value = visibleFocusRooms.value[0]?.roomId || null;
  }
  selectedTaskId.value = null;
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
    (props.room.kind === "focus" ? props.room.parentRoomId : props.room.identifier);
  return buildLetAgentsFocusRoomUrl({
    roomIdentifier: focusRoom.roomId || focusRoom.identifier,
    parentRoomId,
    focusKey: focusRoom.focusKey,
    sourceTaskId: focusRoom.sourceTaskId,
  });
}

async function copyFocusRoomUrl(focusRoom: DesktopFocusRoomInfo): Promise<void> {
  const copied = await copyTextToClipboard(focusRoomUrl(focusRoom));
  if (copied) {
    setFeedback("Room URL copied.", "success");
  } else {
    setFeedback("Room URL could not be copied.", "error");
  }
}

function openFocusRoomContextMenu(event: MouseEvent, focusRoom: DesktopFocusRoomInfo): void {
  const menuWidth = 224;
  const menuHeight = focusRoom.focusStatus === "concluded" ? 184 : 224;
  focusRoomContextMenu.value = {
    room: focusRoom,
    x: Math.max(10, Math.min(event.clientX, window.innerWidth - menuWidth - 10)),
    y: Math.max(10, Math.min(event.clientY, window.innerHeight - menuHeight - 10)),
  };
}

function closeFocusRoomContextMenu(): void {
  focusRoomContextMenu.value = null;
}

function openContextFocusRoom(): void {
  const focusRoom = focusRoomContextMenu.value?.room;
  closeFocusRoomContextMenu();
  if (focusRoom) openFocusRoom(focusRoom.identifier);
}

async function copyContextFocusRoomUrl(): Promise<void> {
  const focusRoom = focusRoomContextMenu.value?.room;
  closeFocusRoomContextMenu();
  if (focusRoom) await copyFocusRoomUrl(focusRoom);
}

async function closeContextFocusRoom(): Promise<void> {
  const focusRoom = focusRoomContextMenu.value?.room;
  closeFocusRoomContextMenu();
  if (focusRoom) await closeFocusRoom(focusRoom);
}

async function archiveContextFocusRoom(): Promise<void> {
  const focusRoom = focusRoomContextMenu.value?.room;
  closeFocusRoomContextMenu();
  if (focusRoom) await archiveFocusRoom(focusRoom);
}

async function createAdHocFocusRoom(): Promise<void> {
  const title = adHocTitle.value.trim();
  if (!title || creatingAdHoc.value) return;
  creatingAdHoc.value = true;
  setFeedback(null);
  try {
    const result = await desktopIpc.room.createAdHocFocusRoom(props.room.identifier, title);
    adHocTitle.value = "";
    selectedFocusRoomId.value = result.focusRoom.roomId;
    selectedTaskId.value = null;
    activeTab.value = result.focusRoom.focusStatus === "concluded" ? "concluded" : "open";
    emit("refresh-room");
    setFeedback("Focus room opened.", "success");
  } catch (error) {
    setFeedback(errorMessage(error, "Focus room could not be opened."), "error");
  } finally {
    creatingAdHoc.value = false;
  }
}

async function openOrCreateTaskFocusRoom(task: DesktopTaskSummary): Promise<void> {
  const existing = focusRoomByTaskId.value.get(task.id);
  if (existing) {
    openFocusRoom(existing.identifier);
    return;
  }
  if (creatingTaskFocus.value) return;
  creatingTaskFocus.value = true;
  setFeedback(null);
  try {
    const result = await desktopIpc.room.createTaskFocusRoom(props.room.identifier, task.id);
    emit("refresh-room");
    openFocusRoom(result.focusRoom.identifier);
  } catch (error) {
    setFeedback(errorMessage(error, "Focus room could not be opened for this task."), "error");
  } finally {
    creatingTaskFocus.value = false;
  }
}

async function saveSettings(): Promise<void> {
  const target = settingsTarget.value;
  if (!target?.parentRoomId || !target.focusKey || !settingsChanged.value || savingSettings.value) return;
  savingSettings.value = true;
  setFeedback(null);
  try {
    const result = await desktopIpc.room.updateFocusRoomSettings(
      target.parentRoomId,
      target.focusKey,
      { ...settingsDraft },
    );
    selectedFocusRoomId.value = result.focusRoom.roomId;
    emit("refresh-room");
    setFeedback("Routing saved.", "success");
  } catch (error) {
    setFeedback(errorMessage(error, "Routing could not be saved."), "error");
  } finally {
    savingSettings.value = false;
  }
}

async function closeFocusRoom(focusRoom: DesktopFocusRoomInfo): Promise<void> {
  const focusKey = focusKeyFor(focusRoom);
  const parentRoomId = focusRoom.parentRoomId || props.room.identifier;
  if (!focusKey || !parentRoomId || closingFocusKey.value) return;

  if (focusRoom.sourceTaskId && props.room.kind !== "focus") {
    openFocusRoom(focusRoom.identifier);
    setFeedback("Open the focus room to add artifact, review, blocker, and owner details before marking it complete.", "info");
    return;
  }

  const summary = window.prompt(
    `Mark ${focusRoom.displayName} complete with a short result summary:`,
    focusRoom.conclusionSummary || "Closed manually.",
  )?.trim();
  if (!summary) return;

  closingFocusKey.value = focusKey;
  setFeedback(null);
  try {
    await desktopIpc.room.concludeFocusRoom(
      parentRoomId,
      focusKey,
      summary,
      focusRoom.sourceTaskId
        ? {
            artifact: "Manual close",
            review_state: "not_required",
            blocker_state: "none",
            parent_task_next: "keep_open",
            next_owner: "Unassigned",
          }
        : null,
    );
    activeTab.value = "concluded";
    selectedFocusRoomId.value = focusRoom.roomId;
    emit("refresh-room");
    setFeedback("Focus room marked complete.", "success");
  } catch (error) {
    setFeedback(errorMessage(error, "Focus room could not be marked complete."), "error");
  } finally {
    closingFocusKey.value = null;
  }
}

async function archiveFocusRoom(focusRoom: DesktopFocusRoomInfo): Promise<void> {
  const focusKey = focusKeyFor(focusRoom);
  const parentRoomId = focusRoom.parentRoomId || props.room.identifier;
  if (!focusKey || !parentRoomId || archivingFocusKey.value) return;

  const confirmed = window.confirm(
    `Hide ${focusRoom.displayName}? It will be removed from the focus room manager, but the room history is preserved.`,
  );
  if (!confirmed) return;

  archivingFocusKey.value = focusKey;
  setFeedback(null);
  try {
    await desktopIpc.room.archiveFocusRoom(parentRoomId, focusKey);
    if (selectedFocusRoomId.value === focusRoom.roomId) {
      selectedFocusRoomId.value = null;
    }
    emit("refresh-room");
    setFeedback("Focus room hidden.", "success");
  } catch (error) {
    setFeedback(errorMessage(error, "Focus room could not be hidden."), "error");
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
  sharingResult.value = true;
  setFeedback(null);
  try {
    const input = buildFocusRoomConclusionInput(
      resultSummary.value,
      props.room.sourceTaskId,
      closeoutDetails,
    );
    await desktopIpc.room.concludeFocusRoom(
      parentRoomId,
      focusKey,
      input.summary,
      input.details,
    );
    emit("refresh-room");
    setFeedback("Result shared.", "success");
  } catch (error) {
    setFeedback(errorMessage(error, "Result could not be shared."), "error");
  } finally {
    sharingResult.value = false;
  }
}

function statusLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function parentVisibilityLabel(value: DesktopFocusParentVisibility): string {
  return parentVisibilityOptions.find((option) => option.value === value)?.label || "Final note only";
}

function activityScopeLabel(value: DesktopFocusActivityScope): string {
  return activityScopeOptions.find((option) => option.value === value)?.label || "Task and linked code";
}

function githubRoutingLabel(value: DesktopFocusGitHubEventRouting): string {
  return githubRoutingOptions.find((option) => option.value === value)?.label || "Related code";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Unknown";
  return formatShortDateTime(value, { hourStyle: "numeric" }) ?? value;
}

function taskInitial(title: string): string {
  return title.trim().slice(0, 1).toUpperCase() || "T";
}

function setFeedback(message: string | null, state: FeedbackState = "info"): void {
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
  return error instanceof Error && error.message ? error.message : fallback;
}

function handleGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") closeFocusRoomContextMenu();
}

onMounted(() => {
  window.addEventListener("click", closeFocusRoomContextMenu);
  window.addEventListener("keydown", handleGlobalKeydown);
});

onBeforeUnmount(() => {
  if (feedbackTimer !== null) {
    window.clearTimeout(feedbackTimer);
    feedbackTimer = null;
  }
  window.removeEventListener("click", closeFocusRoomContextMenu);
  window.removeEventListener("keydown", handleGlobalKeydown);
});
</script>
