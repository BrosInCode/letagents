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
            <dt>Updates</dt>
            <dd>{{ parentVisibilityLabel(currentSettings.parent_visibility) }}</dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd>{{ activityScopeLabel(currentSettings.activity_scope) }}</dd>
          </div>
          <div>
            <dt>Code</dt>
            <dd>{{ githubRoutingLabel(currentSettings.github_event_routing) }}</dd>
          </div>
        </dl>
      </div>

      <form class="focus-room-form" data-testid="focus-room-settings-form" @submit.prevent="saveSettings">
        <div class="focus-room-section-heading">
          <h4>Parent updates</h4>
          <span v-if="settingsChanged">Unsaved</span>
        </div>
        <div class="focus-room-select-grid">
          <DesktopSelectField
            v-model="settingsDraft.parent_visibility"
            label="Visibility"
            :options="parentVisibilityOptions"
            :disabled="savingSettings"
          />
          <DesktopSelectField
            v-model="settingsDraft.activity_scope"
            label="Scope"
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
          <h4>Share result</h4>
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
          {{ sharingResult ? "Sharing..." : "Share result" }}
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
          placeholder="New focus room"
          aria-label="New focus room title"
          :disabled="creatingAdHoc"
        />
        <button type="submit" :disabled="!adHocTitle.trim() || creatingAdHoc">
          {{ creatingAdHoc ? "Opening..." : "Open" }}
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
                    label="Parent updates"
                    :options="parentVisibilityOptions"
                    :disabled="savingSettings"
                  />
                  <DesktopSelectField
                    v-model="settingsDraft.activity_scope"
                    label="Activity scope"
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
                  {{ closingFocusKey === focusKeyFor(selectedFocusRoom) ? "Closing..." : "Close" }}
                </button>
                <button
                  v-if="canArchiveFocusRooms"
                  class="focus-room-danger"
                  type="button"
                  :disabled="archivingFocusKey === focusKeyFor(selectedFocusRoom)"
                  @click="archiveFocusRoom(selectedFocusRoom)"
                >
                  <Archive :size="15" aria-hidden="true" />
                  {{ archivingFocusKey === focusKeyFor(selectedFocusRoom) ? "Archiving..." : "Archive" }}
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
        Close room
      </button>
      <button v-if="canArchiveFocusRooms" type="button" role="menuitem" class="danger" @click="archiveContextFocusRoom">
        <Archive :size="15" aria-hidden="true" />
        Archive room
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Archive, ArrowRight, CheckCircle2, Copy, ExternalLink, Plus, RefreshCw, Search } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import DesktopSegmentedControl from "../controls/DesktopSegmentedControl.vue";
import DesktopSelectField from "../controls/DesktopSelectField.vue";
import { encodeRoomPathIdentifier } from "./room-shell/messages";
import type {
  DesktopFocusActivityScope,
  DesktopFocusRoomBlockerState,
  DesktopFocusGitHubEventRouting,
  DesktopFocusParentVisibility,
  DesktopFocusRoomConclusionDetails,
  DesktopFocusRoomInfo,
  DesktopFocusRoomParentTaskNextAction,
  DesktopFocusRoomReviewState,
  DesktopFocusRoomSettings,
  DesktopRoomInfo,
  DesktopTaskSummary,
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

const reviewStateOptions: Array<Option<DesktopFocusRoomReviewState>> = [
  { value: "reviewed", label: "Reviewed" },
  { value: "needs_review", label: "Needs review" },
  { value: "not_required", label: "Not required" },
];

const blockerStateOptions: Array<Option<DesktopFocusRoomBlockerState>> = [
  { value: "none", label: "None" },
  { value: "resolved", label: "Resolved" },
  { value: "blocked", label: "Blocked" },
];

const parentTaskNextOptions: Array<Option<DesktopFocusRoomParentTaskNextAction>> = [
  { value: "keep_open", label: "Keep open" },
  { value: "move_to_review", label: "Move to review" },
  { value: "mark_blocked", label: "Mark blocked" },
  { value: "mark_done", label: "Mark done" },
  { value: "follow_up", label: "Follow-up" },
];

const props = defineProps<{
  room: DesktopRoomInfo;
  focusRooms: DesktopFocusRoomInfo[];
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
const closeoutDetails = reactive<DesktopFocusRoomConclusionDetails>({
  artifact: "",
  review_state: "needs_review",
  blocker_state: "none",
  parent_task_next: "keep_open",
  next_owner: "",
});

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
  if (!resultSummary.value.trim()) return false;
  if (!props.room.sourceTaskId) return true;
  return Boolean(closeoutDetails.artifact.trim() && closeoutDetails.next_owner.trim());
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
  if (props.room.kind === "focus") {
    return [
      statusLabel(props.room.focusStatus || "active"),
      props.room.sourceTaskId || props.room.focusKey || props.room.identifier,
    ].filter(Boolean).join(" · ");
  }
  return `${openFocusRooms.value.length} open · ${concludedFocusRooms.value.length} closed · ${candidateTasks.value.length} task candidates`;
});

watch(
  () => [props.focusRooms, props.tasks, props.room.kind] as const,
  () => {
    if (props.room.kind === "focus") return;
    const selectedFocusStillExists =
      selectedFocusRoomId.value && props.focusRooms.some((focusRoom) => focusRoom.roomId === selectedFocusRoomId.value);
    const selectedTaskStillExists =
      selectedTaskId.value && props.tasks.some((task) => task.id === selectedTaskId.value);
    if (selectedFocusStillExists || selectedTaskStillExists) return;

    const firstFocusRoom = openFocusRooms.value[0] || concludedFocusRooms.value[0] || null;
    if (firstFocusRoom) {
      selectedFocusRoomId.value = firstFocusRoom.roomId;
      selectedTaskId.value = null;
      activeTab.value = firstFocusRoom.focusStatus === "concluded" ? "concluded" : "open";
      return;
    }
    const firstTask = candidateTasks.value[0] || null;
    selectedTaskId.value = firstTask?.id || null;
    selectedFocusRoomId.value = null;
    if (firstTask) activeTab.value = "tasks";
  },
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
}

function openFocusRoom(roomIdentifier: string): void {
  emit("open-focus-room", roomIdentifier);
}

function focusKeyFor(focusRoom: DesktopFocusRoomInfo | null): string | null {
  return focusRoom?.focusKey || focusRoom?.sourceTaskId || null;
}

function focusRoomUrl(focusRoom: DesktopFocusRoomInfo): string {
  const focusKey = focusRoom.focusKey || focusRoom.sourceTaskId;
  const parentRoomId =
    focusRoom.parentRoomId ||
    (props.room.kind === "focus" ? props.room.parentRoomId : props.room.identifier);
  if (parentRoomId && focusKey) {
    return `https://letagents.chat/in/${encodeRoomPathIdentifier(parentRoomId)}/focus/${
      encodeURIComponent(focusKey)
    }`;
  }
  const roomIdentifier = focusRoom.roomId || focusRoom.identifier;
  return `https://letagents.chat/in/${encodeRoomPathIdentifier(roomIdentifier)}`;
}

async function copyFocusRoomUrl(focusRoom: DesktopFocusRoomInfo): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard is unavailable.");
    }
    await navigator.clipboard.writeText(focusRoomUrl(focusRoom));
    setFeedback("Room URL copied.", "success");
  } catch {
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
    const result = await window.letagentsDesktop.room.createAdHocFocusRoom(props.room.identifier, title);
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
    const result = await window.letagentsDesktop.room.createTaskFocusRoom(props.room.identifier, task.id);
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
    const result = await window.letagentsDesktop.room.updateFocusRoomSettings(
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

  const summary = window.prompt(
    `Close ${focusRoom.displayName} with a short result summary:`,
    focusRoom.conclusionSummary || "Closed manually.",
  )?.trim();
  if (!summary) return;

  closingFocusKey.value = focusKey;
  setFeedback(null);
  try {
    await window.letagentsDesktop.room.concludeFocusRoom(
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
    setFeedback("Focus room closed.", "success");
  } catch (error) {
    setFeedback(errorMessage(error, "Focus room could not be closed."), "error");
  } finally {
    closingFocusKey.value = null;
  }
}

async function archiveFocusRoom(focusRoom: DesktopFocusRoomInfo): Promise<void> {
  const focusKey = focusKeyFor(focusRoom);
  const parentRoomId = focusRoom.parentRoomId || props.room.identifier;
  if (!focusKey || !parentRoomId || archivingFocusKey.value) return;

  const confirmed = window.confirm(
    `Archive ${focusRoom.displayName}? It will be removed from the focus room manager, but the room history is preserved.`,
  );
  if (!confirmed) return;

  archivingFocusKey.value = focusKey;
  setFeedback(null);
  try {
    await window.letagentsDesktop.room.archiveFocusRoom(parentRoomId, focusKey);
    if (selectedFocusRoomId.value === focusRoom.roomId) {
      selectedFocusRoomId.value = null;
    }
    emit("refresh-room");
    setFeedback("Focus room archived.", "success");
  } catch (error) {
    setFeedback(errorMessage(error, "Focus room could not be archived."), "error");
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
    await window.letagentsDesktop.room.concludeFocusRoom(
      parentRoomId,
      focusKey,
      resultSummary.value.trim(),
      props.room.sourceTaskId
        ? {
            ...closeoutDetails,
            artifact: closeoutDetails.artifact.trim(),
            next_owner: closeoutDetails.next_owner.trim(),
          }
        : null,
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
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
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

<style scoped>
.focus-room-manager {
  display: grid;
  align-content: start;
  gap: 16px;
  height: 100%;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 26px 32px 32px;
  scrollbar-color: var(--scrollbar-thumb) transparent;
  scrollbar-gutter: auto;
  scrollbar-width: thin;
  color: var(--text);
  overscroll-behavior: contain;
}

@keyframes focus-room-surface-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.995);
  }

  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes focus-room-feedback-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.focus-room-manager::-webkit-scrollbar {
  width: var(--scrollbar-size);
  height: var(--scrollbar-size);
}

.focus-room-manager::-webkit-scrollbar-track,
.focus-room-manager::-webkit-scrollbar-track-piece {
  background: transparent;
  border: 0;
  box-shadow: none;
}

.focus-room-manager::-webkit-scrollbar-button {
  display: none;
  width: 0;
  height: 0;
}

.focus-room-manager::-webkit-scrollbar-thumb {
  min-height: 44px;
  border: 3px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
  background-color: var(--scrollbar-thumb);
}

.focus-room-manager::-webkit-scrollbar-thumb:hover {
  background-color: var(--scrollbar-thumb-hover);
}

.focus-room-manager::-webkit-scrollbar-corner {
  background: transparent;
}

.focus-room-header,
.focus-room-toolbar,
.focus-room-layout,
.focus-room-current,
.focus-room-current-main,
.focus-room-form,
.focus-room-detail,
.focus-room-list-pane {
  min-width: 0;
}

.focus-room-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  animation: focus-room-surface-in 240ms var(--ease-out) both;
}

.focus-room-kicker,
.focus-room-header h2,
.focus-room-header p,
.focus-room-detail h3,
.focus-room-detail p,
.focus-room-current h3,
.focus-room-current p,
.focus-room-outcome h4,
.focus-room-outcome p,
.focus-room-section-heading h4 {
  margin: 0;
}

.focus-room-kicker {
  color: var(--text-tertiary);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0;
}

.focus-room-header h2 {
  margin-top: 4px;
  font-size: 1.35rem;
  line-height: 1.2;
  letter-spacing: 0;
}

.focus-room-muted,
.focus-room-row-copy span,
.focus-room-row-meta small,
.focus-room-current p,
.focus-room-empty p,
.focus-room-task-description,
.focus-room-outcome p {
  color: var(--text-secondary);
}

.focus-room-muted {
  margin-top: 6px;
  font-size: 0.92rem;
}

.focus-room-icon-button,
.focus-room-primary,
.focus-room-secondary,
.focus-room-danger,
.focus-room-create button {
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
  font: inherit;
}

.focus-room-icon-button {
  display: inline-grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  cursor: pointer;
  transition:
    transform 150ms var(--ease-out),
    border-color 150ms var(--ease-out),
    background 150ms var(--ease-out),
    color 150ms var(--ease-out);
}

.focus-room-icon-button:hover {
  transform: translateY(-1px);
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
}

.focus-room-icon-button:hover svg {
  transform: rotate(18deg);
}

.focus-room-icon-button:active {
  transform: translateY(0) scale(0.97);
}

.focus-room-icon-button:focus-visible,
.focus-room-row:focus-visible,
.focus-room-primary:focus-visible,
.focus-room-secondary:focus-visible,
.focus-room-create button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.075);
}

.focus-room-icon-button svg {
  transition: transform 180ms var(--ease-out);
}

.focus-room-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  animation: focus-room-surface-in 260ms var(--ease-out) 35ms both;
}

.focus-room-search {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 260px;
  max-width: 420px;
  flex: 1;
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-tertiary);
  transition:
    border-color 150ms var(--ease-out),
    background 150ms var(--ease-out),
    box-shadow 150ms var(--ease-out),
    color 150ms var(--ease-out);
}

.focus-room-search:focus-within {
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-secondary);
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.055);
}

.focus-room-search input,
.focus-room-create input,
.focus-room-form input,
.focus-room-form textarea {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text);
  font: inherit;
}

.focus-room-search input::placeholder,
.focus-room-create input::placeholder,
.focus-room-form input::placeholder,
.focus-room-form textarea::placeholder {
  color: var(--text-tertiary);
}

.focus-room-tabs {
  flex: 0 0 auto;
}

.focus-room-create {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 0 10px 0 13px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.035);
  color: var(--text-tertiary);
  animation: focus-room-surface-in 260ms var(--ease-out) 55ms both;
  transition:
    border-color 150ms var(--ease-out),
    background 150ms var(--ease-out),
    box-shadow 150ms var(--ease-out);
}

.focus-room-create:focus-within {
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.055);
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.055);
}

.focus-room-create button,
.focus-room-primary,
.focus-room-secondary,
.focus-room-danger {
  min-height: 32px;
  padding: 0 13px;
  border-radius: 999px;
  font-weight: 700;
  cursor: pointer;
  transition:
    transform 150ms var(--ease-out),
    border-color 150ms var(--ease-out),
    background 150ms var(--ease-out),
    color 150ms var(--ease-out),
    box-shadow 150ms var(--ease-out),
    opacity 150ms var(--ease-out);
}

.focus-room-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: #f4f4f5;
  color: #0a0a0b;
}

.focus-room-secondary,
.focus-room-danger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
}

.focus-room-primary:not(:disabled):hover,
.focus-room-create button:not(:disabled):hover {
  transform: translateY(-1px);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.22);
}

.focus-room-primary:not(:disabled):hover svg {
  transform: translateX(2px);
}

.focus-room-primary svg {
  transition: transform 150ms var(--ease-out);
}

.focus-room-secondary {
  justify-self: start;
}

.focus-room-danger {
  color: #fca5a5;
  background: rgba(248, 113, 113, 0.08);
  border-color: rgba(248, 113, 113, 0.16);
}

.focus-room-secondary:not(:disabled):hover,
.focus-room-danger:not(:disabled):hover {
  transform: translateY(-1px);
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
}

.focus-room-danger:not(:disabled):hover {
  border-color: rgba(248, 113, 113, 0.28);
  background: rgba(248, 113, 113, 0.12);
}

.focus-room-primary:not(:disabled):active,
.focus-room-secondary:not(:disabled):active,
.focus-room-danger:not(:disabled):active,
.focus-room-create button:not(:disabled):active {
  transform: translateY(0) scale(0.98);
}

.focus-room-primary.wide {
  width: 100%;
  min-height: 40px;
}

.focus-room-primary:disabled,
.focus-room-secondary:disabled,
.focus-room-danger:disabled,
.focus-room-create button:disabled {
  cursor: default;
  opacity: 0.48;
}

.focus-room-layout {
  display: grid;
  grid-template-columns: minmax(360px, 1fr) minmax(340px, 440px);
  gap: 16px;
  min-height: 0;
}

.focus-room-list-pane,
.focus-room-detail,
.focus-room-current {
  border: 1px solid var(--border);
  border-radius: 22px;
  background: rgba(16, 16, 16, 0.72);
  animation: focus-room-surface-in 280ms var(--ease-out) 65ms both;
  transition:
    border-color 180ms var(--ease-out),
    background 180ms var(--ease-out),
    box-shadow 180ms var(--ease-out);
}

.focus-room-list-pane:hover,
.focus-room-detail:hover,
.focus-room-current:hover {
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(18, 18, 18, 0.78);
}

.focus-room-list-pane {
  display: grid;
  align-content: start;
  padding: 10px;
}

.focus-room-list-set,
.focus-room-row-list {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
}

.focus-room-row-list {
  position: relative;
}

.focus-room-filter-enter-active,
.focus-room-filter-leave-active {
  transition:
    opacity 170ms var(--ease-out),
    transform 170ms var(--ease-out);
}

.focus-room-filter-enter-from,
.focus-room-filter-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.992);
}

.focus-room-row-motion-enter-active,
.focus-room-row-motion-leave-active {
  transition:
    opacity 170ms var(--ease-out),
    transform 170ms var(--ease-out);
}

.focus-room-row-motion-move {
  transition: transform 190ms var(--ease-out);
}

.focus-room-row-motion-enter-from,
.focus-room-row-motion-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.992);
}

.focus-room-row-motion-leave-active {
  position: absolute;
  right: 0;
  left: 0;
}

.focus-room-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  width: 100%;
  min-height: 72px;
  padding: 12px 14px;
  border: 1px solid transparent;
  border-radius: 16px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transform-origin: center;
  transition:
    transform 150ms var(--ease-out),
    border-color 150ms var(--ease-out),
    background 150ms var(--ease-out),
    box-shadow 150ms var(--ease-out);
}

.focus-room-row:hover {
  transform: translateY(-1px);
  background: rgba(255, 255, 255, 0.035);
  border-color: var(--border);
}

.focus-room-row[data-selected="true"] {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.16);
  box-shadow: inset 3px 0 0 rgba(147, 197, 253, 0.45);
}

.focus-room-row:active {
  transform: translateY(0) scale(0.995);
}

.focus-room-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: #8b5cf6;
  box-shadow: 0 0 0 6px rgba(139, 92, 246, 0.12);
  transition:
    background 180ms var(--ease-out),
    box-shadow 180ms var(--ease-out),
    transform 180ms var(--ease-out);
}

.focus-room-row:hover .focus-room-dot,
.focus-room-title-line:hover .focus-room-dot {
  transform: scale(1.12);
}

.focus-room-dot[data-state="active"] {
  background: #34d399;
  box-shadow: 0 0 0 6px rgba(52, 211, 153, 0.12);
}

.focus-room-dot[data-state="concluded"] {
  background: #a1a1aa;
  box-shadow: 0 0 0 6px rgba(161, 161, 170, 0.12);
}

.focus-room-task-mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.07);
  color: #f4f4f5;
  font-weight: 750;
  transition:
    background 150ms var(--ease-out),
    transform 150ms var(--ease-out);
}

.focus-room-row:hover .focus-room-task-mark {
  transform: translateY(-1px);
  background: rgba(255, 255, 255, 0.1);
}

.focus-room-row-copy,
.focus-room-row-meta {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.focus-room-row-copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.98rem;
  line-height: 1.22;
  transition: color 150ms var(--ease-out);
}

.focus-room-row:hover .focus-room-row-copy strong {
  color: var(--text);
}

.focus-room-row-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.84rem;
}

.focus-room-row-meta {
  justify-items: end;
}

.focus-room-state {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
  color: var(--text);
  font-size: 0.8rem;
  font-weight: 750;
  text-transform: capitalize;
  white-space: nowrap;
  transition:
    background 150ms var(--ease-out),
    color 150ms var(--ease-out),
    transform 150ms var(--ease-out);
}

.focus-room-row:hover .focus-room-state,
.focus-room-title-line:hover .focus-room-state {
  transform: translateY(-1px);
}

.focus-room-state[data-state="active"] {
  background: rgba(34, 197, 94, 0.12);
  color: #86efac;
}

.focus-room-state[data-state="concluded"] {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-secondary);
}

.focus-room-detail {
  display: grid;
  align-content: start;
  padding: 22px;
}

.focus-room-detail-content {
  display: grid;
  align-content: start;
  gap: 18px;
  min-width: 0;
}

.focus-room-actions {
  display: grid;
  gap: 8px;
  padding-top: 2px;
}

.focus-room-actions .focus-room-secondary,
.focus-room-actions .focus-room-danger {
  width: 100%;
  min-height: 40px;
  padding: 0 14px;
  justify-self: stretch;
}

.focus-room-detail-motion-enter-active,
.focus-room-detail-motion-leave-active {
  transition:
    opacity 170ms var(--ease-out),
    transform 170ms var(--ease-out);
}

.focus-room-detail-motion-enter-from {
  opacity: 0;
  transform: translateX(10px) scale(0.992);
}

.focus-room-detail-motion-leave-to {
  opacity: 0;
  transform: translateX(-8px) scale(0.992);
}

.focus-room-detail-header,
.focus-room-title-line,
.focus-room-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.focus-room-detail h3,
.focus-room-current h3 {
  margin: 4px 0 0;
  font-size: 1.15rem;
  line-height: 1.25;
  letter-spacing: 0;
}

.focus-room-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 13px 18px;
  margin: 0;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.focus-room-facts div,
.focus-room-closeout-grid label {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.focus-room-facts dt,
.focus-room-section-heading span {
  color: var(--text-tertiary);
  font-size: 0.78rem;
  font-weight: 750;
}

.focus-room-facts dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--text);
  font-size: 0.92rem;
  line-height: 1.35;
}

.focus-room-outcome,
.focus-room-task-description {
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.focus-room-outcome h4,
.focus-room-section-heading h4 {
  font-size: 0.95rem;
  line-height: 1.25;
}

.focus-room-outcome p,
.focus-room-task-description {
  margin-top: 8px;
  font-size: 0.92rem;
  line-height: 1.5;
}

.focus-room-form {
  display: grid;
  gap: 14px;
}

.focus-room-form.compact {
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.focus-room-select-grid,
.focus-room-closeout-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.focus-room-select-grid.single,
.focus-room-closeout-grid {
  grid-template-columns: 1fr;
}

.focus-room-form input,
.focus-room-form textarea {
  min-height: 38px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  transition:
    border-color 150ms var(--ease-out),
    background 150ms var(--ease-out),
    box-shadow 150ms var(--ease-out);
}

.focus-room-form input:focus,
.focus-room-form textarea:focus {
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.065);
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.055);
}

.focus-room-form textarea {
  min-height: 96px;
  padding: 11px 12px;
  resize: vertical;
}

.focus-room-current {
  display: grid;
  gap: 22px;
  padding: 22px;
}

.focus-room-current-main {
  display: grid;
  gap: 16px;
}

.focus-room-empty {
  display: grid;
  gap: 6px;
  padding: 28px 18px;
  animation: focus-room-surface-in 220ms var(--ease-out) both;
}

.focus-room-empty h3 {
  margin: 0;
  font-size: 1rem;
  letter-spacing: 0;
}

.detail-empty {
  padding: 0;
}

.focus-room-toast {
  position: fixed;
  top: 18px;
  left: 50%;
  z-index: 120;
  display: inline-flex;
  align-items: center;
  min-height: 38px;
  max-width: min(420px, calc(100vw - 32px));
  margin: 0;
  padding: 0 16px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  color: var(--text);
  background: rgba(24, 24, 24, 0.92);
  box-shadow:
    0 18px 48px rgba(0, 0, 0, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
  font-size: 0.92rem;
  font-weight: 700;
  line-height: 1.2;
  text-align: center;
  transform: translateX(-50%);
  pointer-events: none;
  backdrop-filter: blur(18px);
}

.focus-room-toast[data-state="success"] {
  border-color: rgba(52, 211, 153, 0.2);
  color: #a7f3d0;
}

.focus-room-toast[data-state="error"] {
  border-color: rgba(248, 113, 113, 0.28);
  color: #fecaca;
}

.focus-room-toast-enter-active,
.focus-room-toast-leave-active {
  transition:
    opacity 180ms var(--ease-out),
    transform 180ms var(--ease-out);
}

.focus-room-toast-enter-from,
.focus-room-toast-leave-to {
  opacity: 0;
  transform: translate(-50%, -14px) scale(0.98);
}

.focus-room-context-menu {
  position: fixed;
  z-index: 80;
  width: 224px;
  padding: 7px;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 14px;
  background: rgba(22, 22, 22, 0.96);
  box-shadow:
    0 24px 70px rgba(0, 0, 0, 0.42),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(18px);
  animation: focus-room-feedback-in 120ms var(--ease-out) both;
}

.focus-room-context-title {
  margin: 0 0 5px;
  padding: 7px 9px 5px;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 750;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.focus-room-context-menu button {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 34px;
  padding: 0 9px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 0.88rem;
  font-weight: 650;
  text-align: left;
  cursor: pointer;
  transition:
    background 130ms var(--ease-out),
    color 130ms var(--ease-out),
    transform 130ms var(--ease-out);
}

.focus-room-context-menu button:hover {
  background: rgba(255, 255, 255, 0.075);
  transform: translateY(-1px);
}

.focus-room-context-menu button:active {
  transform: translateY(0) scale(0.99);
}

.focus-room-context-menu button.danger {
  color: #fca5a5;
}

.focus-room-context-menu button.danger:hover {
  background: rgba(248, 113, 113, 0.11);
}

@media (max-width: 1180px) {
  .focus-room-layout {
    grid-template-columns: 1fr;
  }

  .focus-room-detail {
    order: -1;
  }
}

@media (max-width: 760px) {
  .focus-room-manager {
    padding: 18px;
  }

  .focus-room-toolbar,
  .focus-room-header {
    align-items: stretch;
    flex-direction: column;
  }

  .focus-room-search {
    max-width: none;
    min-width: 0;
  }

  .focus-room-tabs {
    width: 100%;
    overflow-x: auto;
  }

  .focus-room-facts,
  .focus-room-select-grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .focus-room-manager *,
  .focus-room-manager *::before,
  .focus-room-manager *::after {
    animation-duration: 1ms !important;
    animation-delay: 0ms !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }

  .focus-room-icon-button:hover,
  .focus-room-icon-button:hover svg,
  .focus-room-primary:not(:disabled):hover,
  .focus-room-primary:not(:disabled):hover svg,
  .focus-room-secondary:not(:disabled):hover,
  .focus-room-danger:not(:disabled):hover,
  .focus-room-create button:not(:disabled):hover,
  .focus-room-row:hover,
  .focus-room-row:active,
  .focus-room-row:hover .focus-room-dot,
  .focus-room-title-line:hover .focus-room-dot,
  .focus-room-row:hover .focus-room-task-mark,
  .focus-room-row:hover .focus-room-state,
  .focus-room-title-line:hover .focus-room-state,
  .focus-room-context-menu button:hover,
  .focus-room-context-menu button:active {
    transform: none;
  }
}
</style>
