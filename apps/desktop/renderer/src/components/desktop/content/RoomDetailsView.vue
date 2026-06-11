<template>
  <section class="focus-room-manager" data-testid="room-details-view">
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
          <label>
            <span>Visibility</span>
            <select v-model="settingsDraft.parent_visibility" :disabled="savingSettings">
              <option v-for="option in parentVisibilityOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label>
            <span>Scope</span>
            <select v-model="settingsDraft.activity_scope" :disabled="savingSettings">
              <option v-for="option in activityScopeOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label>
            <span>GitHub</span>
            <select v-model="settingsDraft.github_event_routing" :disabled="savingSettings">
              <option v-for="option in githubRoutingOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
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
          <label>
            <span>Review</span>
            <select v-model="closeoutDetails.review_state" :disabled="sharingResult">
              <option value="reviewed">Reviewed</option>
              <option value="needs_review">Needs review</option>
              <option value="not_required">Not required</option>
            </select>
          </label>
          <label>
            <span>Blockers</span>
            <select v-model="closeoutDetails.blocker_state" :disabled="sharingResult">
              <option value="none">None</option>
              <option value="resolved">Resolved</option>
              <option value="blocked">Blocked</option>
            </select>
          </label>
          <label>
            <span>Parent task</span>
            <select v-model="closeoutDetails.parent_task_next" :disabled="sharingResult">
              <option value="keep_open">Keep open</option>
              <option value="move_to_review">Move to review</option>
              <option value="mark_blocked">Mark blocked</option>
              <option value="mark_done">Mark done</option>
              <option value="follow_up">Follow-up</option>
            </select>
          </label>
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

        <div class="focus-room-tabs" role="tablist" aria-label="Room manager view">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            type="button"
            role="tab"
            :aria-selected="activeTab === tab.id"
            :data-active="activeTab === tab.id"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
            <span>{{ tab.count }}</span>
          </button>
        </div>
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
          <template v-if="activeTab !== 'tasks'">
            <button
              v-for="focusRoom in visibleFocusRooms"
              :key="focusRoom.roomId"
              class="focus-room-row"
              type="button"
              :data-selected="selectedFocusRoom?.roomId === focusRoom.roomId"
              :data-testid="`room-focus-${focusRoom.roomId}`"
              @click="selectFocusRoom(focusRoom.roomId)"
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

            <article v-if="!visibleFocusRooms.length" class="focus-room-empty" data-testid="room-focus-empty">
              <h3>{{ activeTab === "concluded" ? "No shared results" : "No open focus rooms" }}</h3>
              <p>{{ searchQuery ? "No rooms match this search." : "No matching records in this room." }}</p>
            </article>
          </template>

          <template v-else>
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

            <article v-if="!visibleTasks.length" class="focus-room-empty" data-testid="room-tasks-empty">
              <h3>No matching tasks</h3>
              <p>{{ searchQuery ? "No tasks match this search." : "Open tasks will appear here." }}</p>
            </article>
          </template>
        </main>

        <aside id="focus-room-detail-panel" class="focus-room-detail" data-testid="focus-room-detail-panel">
          <template v-if="selectedFocusRoom">
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
                <label>
                  <span>Parent updates</span>
                  <select v-model="settingsDraft.parent_visibility" :disabled="savingSettings">
                    <option v-for="option in parentVisibilityOptions" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                </label>
                <label>
                  <span>Activity scope</span>
                  <select v-model="settingsDraft.activity_scope" :disabled="savingSettings">
                    <option v-for="option in activityScopeOptions" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                </label>
                <label>
                  <span>GitHub routing</span>
                  <select v-model="settingsDraft.github_event_routing" :disabled="savingSettings">
                    <option v-for="option in githubRoutingOptions" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                </label>
              </div>
              <button class="focus-room-secondary" type="submit" :disabled="!settingsChanged || savingSettings">
                {{ savingSettings ? "Saving..." : "Save routing" }}
              </button>
            </form>

            <button class="focus-room-primary wide" type="button" @click="openFocusRoom(selectedFocusRoom.identifier)">
              Open room
              <ArrowRight :size="15" aria-hidden="true" />
            </button>
          </template>

          <template v-else-if="selectedTask">
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
          </template>

          <article v-else class="focus-room-empty detail-empty">
            <h3>No selection</h3>
            <p>Nothing selected.</p>
          </article>
        </aside>
      </div>
    </template>

    <p v-if="actionFeedback" class="focus-room-feedback" :data-state="actionFeedbackState">
      {{ actionFeedback }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { ArrowRight, Plus, RefreshCw, Search } from "@lucide/vue";
import { computed, reactive, ref, watch } from "vue";
import type {
  DesktopFocusActivityScope,
  DesktopFocusGitHubEventRouting,
  DesktopFocusParentVisibility,
  DesktopFocusRoomConclusionDetails,
  DesktopFocusRoomInfo,
  DesktopFocusRoomSettings,
  DesktopRoomInfo,
  DesktopTaskSummary,
} from "../../../../../electron/ipc-types";

type FocusRoomTab = "open" | "concluded" | "tasks";
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
const actionFeedback = ref<string | null>(null);
const actionFeedbackState = ref<FeedbackState>("info");
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

const tabs = computed(() => [
  { id: "open" as const, label: "Open", count: openFocusRooms.value.length },
  { id: "concluded" as const, label: "Shared", count: concludedFocusRooms.value.length },
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
  return `${openFocusRooms.value.length} open · ${concludedFocusRooms.value.length} shared · ${candidateTasks.value.length} task candidates`;
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

function openFocusRoom(roomIdentifier: string): void {
  emit("open-focus-room", roomIdentifier);
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
  actionFeedback.value = message;
  actionFeedbackState.value = state;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
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
.focus-room-tabs button,
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
}

.focus-room-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
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
}

.focus-room-search input,
.focus-room-create input,
.focus-room-form input,
.focus-room-form textarea,
.focus-room-form select {
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
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.03);
}

.focus-room-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 12px;
  border-radius: 10px;
  color: var(--text-secondary);
  cursor: pointer;
}

.focus-room-tabs button[data-active="true"] {
  background: rgba(255, 255, 255, 0.09);
  color: var(--text);
}

.focus-room-tabs span {
  color: var(--text-tertiary);
  font-size: 0.78rem;
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
}

.focus-room-create button,
.focus-room-primary,
.focus-room-secondary {
  min-height: 32px;
  padding: 0 13px;
  border-radius: 999px;
  font-weight: 700;
  cursor: pointer;
}

.focus-room-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: #f4f4f5;
  color: #0a0a0b;
}

.focus-room-secondary {
  justify-self: start;
}

.focus-room-primary.wide {
  width: 100%;
  min-height: 40px;
}

.focus-room-primary:disabled,
.focus-room-secondary:disabled,
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
}

.focus-room-list-pane {
  display: grid;
  align-content: start;
  gap: 8px;
  padding: 10px;
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
}

.focus-room-row:hover {
  background: rgba(255, 255, 255, 0.035);
  border-color: var(--border);
}

.focus-room-row[data-selected="true"] {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.16);
}

.focus-room-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: #8b5cf6;
  box-shadow: 0 0 0 6px rgba(139, 92, 246, 0.12);
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
  gap: 18px;
  padding: 22px;
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
.focus-room-select-grid label,
.focus-room-closeout-grid label {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.focus-room-facts dt,
.focus-room-form label > span,
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
.focus-room-form textarea,
.focus-room-form select {
  min-height: 38px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
}

.focus-room-form select {
  appearance: none;
  overflow: hidden;
  padding-right: 42px;
  background-image: url("data:image/svg+xml,%3Csvg width='16' height='16' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='m6 9 6 6 6-6' stroke='%23f4f4f5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 14px center;
  background-size: 16px 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
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
}

.focus-room-empty h3 {
  margin: 0;
  font-size: 1rem;
  letter-spacing: 0;
}

.detail-empty {
  padding: 0;
}

.focus-room-feedback {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.04);
}

.focus-room-feedback[data-state="success"] {
  border-color: rgba(34, 197, 94, 0.22);
  color: #86efac;
}

.focus-room-feedback[data-state="error"] {
  border-color: rgba(248, 113, 113, 0.26);
  color: #fca5a5;
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

  .focus-room-tabs,
  .focus-room-tabs button {
    width: 100%;
  }

  .focus-room-tabs button {
    justify-content: center;
  }

  .focus-room-facts,
  .focus-room-select-grid {
    grid-template-columns: 1fr;
  }
}
</style>
