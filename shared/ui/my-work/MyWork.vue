<template>
  <section
    ref="surface"
    class="my-work"
    aria-label="My work"
    data-testid="my-work-view"
  >
    <div class="work-content">
      <header class="work-heading">
        <div>
          <h1>My work</h1>
          <p>Your tasks and your agents’ work, across every room.</p>
        </div>
        <button
          type="button"
          class="work-secondary"
          @click="emit('open-trackers')"
        >
          <WorkIcon name="link" />Ticket trackers
        </button>
      </header>
      <div
        class="work-tabs"
        role="tablist"
        aria-label="Work view"
        @keydown="tabKey"
      >
        <button
          v-for="item in views"
          :id="`${prefix}-${item.id}`"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="view === item.id"
          :aria-controls="`${prefix}-list`"
          :tabindex="view === item.id ? 0 : -1"
          @click="changeView(item.id)"
        >
          {{ item.label
          }}<span
            v-if="
              counts[item.id] && (!filters.needsMe || item.id === 'attention')
            "
            :class="{ 'work-attention-count': item.id === 'attention' }"
            :title="
              nextCursor ? 'Count in loaded work; more available' : undefined
            "
            >{{ counts[item.id] }}{{ nextCursor ? "+" : "" }}</span
          >
        </button>
      </div>
      <div class="work-filter-bar">
        <div class="work-filter-controls">
          <FilterDropdown
            v-model="filters.roomId"
            label="Filter by room"
            :options="[{ id: '', label: 'All rooms' }, ...roomOptions]"
            searchable
            data-testid="my-work-filter-room"
            ><template #icon
              ><WorkIcon name="folder" /></template></FilterDropdown
          ><FilterDropdown
            v-if="trackerOptions.length"
            :model-value="filters.tracker"
            label="Filter by source"
            :options="trackerOptions"
            data-testid="my-work-filter-tracker"
            @update:model-value="
              filters.tracker = $event as MyWorkTrackerFilter
            "
          /><button
            v-if="filters.roomId || filters.tracker || search"
            type="button"
            class="work-text-button"
            @click="clearFilters"
          >
            Clear filters
          </button>
        </div>
        <label class="work-search"
          ><WorkIcon name="search" /><input
            ref="searchInput"
            v-model="search"
            type="search"
            placeholder="Find work…"
            aria-label="Find work in loaded items"
          /><kbd>/</kbd></label
        >
      </div>
      <div class="work-sync-line">
        <span role="status">{{
          loading
            ? "Refreshing work…"
            : nextCursor
              ? "Loaded work · more available below"
              : ""
        }}</span
        ><button
          v-if="pendingMoves"
          type="button"
          class="work-text-button"
          @click="applyGroups"
        >
          Show updates ↑</button
        ><button
          type="button"
          class="work-text-button"
          :disabled="loading"
          data-testid="my-work-refresh"
          @click="refresh"
        >
          Refresh
        </button>
      </div>
      <div v-if="error" class="work-error" role="alert">
        {{ error }} <button type="button" @click="reload()">Retry</button>
      </div>
      <div
        :id="`${prefix}-list`"
        role="tabpanel"
        :aria-labelledby="`${prefix}-${view}`"
      >
        <section
          v-for="group in visibleGroups"
          :key="group.id"
          class="work-section"
          :data-group="group.id"
        >
          <DisclosurePanel
            :open="!collapsed.has(group.id)"
            instant
            @toggle="toggleGroup(group.id)"
            ><template #summary
              ><span class="work-section-heading"
                ><span>{{ group.label }}</span
                ><span class="work-section-count">{{ group.cards.length }}</span
                ><span class="work-section-caption">{{
                  group.caption
                }}</span></span
              ></template
            >
            <div class="work-lines">
              <button
                v-for="card in group.cards"
                :key="myWorkCardKey(card)"
                type="button"
                class="work-row"
                :data-work-id="myWorkCardKey(card)"
                :data-tone="workTone(card)"
                :aria-expanded="selectedKey === myWorkCardKey(card)"
                aria-haspopup="dialog"
                data-testid="my-work-row"
                @click="openDetails(card, $event)"
              >
                <span class="work-symbol"><WorkIcon :name="group.icon" /></span
                ><span class="work-row-content"
                  ><strong class="work-title">{{ card.title }}</strong
                  ><span class="work-meta"
                    ><span>{{ card.room_name }}</span
                    ><span aria-hidden="true">·</span
                    ><span
                      v-if="card.provider"
                      class="work-provider"
                      :data-provider="card.provider"
                      :title="card.provider"
                    /><span class="work-key">{{ workKey(card) }}</span
                    ><span v-if="card.threads.count"
                      >· {{ card.threads.count }} linked
                      {{
                        card.threads.count === 1 ? "message" : "messages"
                      }}</span
                    ><span class="work-compact-owner"
                      >· {{ workOwner(card) }}</span
                    ></span
                  ></span
                ><span class="work-row-owner"
                  ><ChatAvatar
                    :name="workOwner(card)"
                    :agent="Boolean(card.agent?.agent_key)"
                    :agent-key="card.agent?.agent_key"
                  /><span>{{ workOwner(card) }}</span></span
                ><span class="work-row-progress"
                  ><span class="work-signal"><i />{{ workSignal(card) }}</span
                  ><small v-if="primaryPullRequest(card)"
                    ><WorkIcon name="branch" />{{
                      pullRequestLabel(primaryPullRequest(card)!)
                    }}
                    ·
                    {{
                      checkSummaryLabel(primaryPullRequest(card)!) ||
                      pullRequestStateLabel(primaryPullRequest(card)!)
                    }}</small
                  ><small
                    v-else
                    :title="card.agent?.status_text || undefined"
                    >{{
                      card.agent?.status_text || workDate(card.updated_at)
                    }}</small
                  ></span
                ><WorkIcon name="right" class="work-row-chevron" />
              </button>
            </div>
          </DisclosurePanel>
        </section>
        <div
          v-if="!visibleGroups.length && !error"
          class="work-empty"
          data-testid="my-work-empty"
        >
          <WorkIcon :name="loading ? 'progress' : 'search'" />
          <h2>
            {{
              loading
                ? "Loading your work…"
                : nextCursor
                  ? "No matches in the work loaded so far"
                  : view === "attention"
                    ? "Nothing needs you here"
                    : "No matching work"
            }}
          </h2>
          <p>
            {{
              nextCursor
                ? "Load more to look further, or try another filter."
                : "Tasks assigned to you and your agents appear here."
            }}
          </p>
          <button
            v-if="
              !loading &&
              (search || filters.roomId || filters.tracker || view !== 'all')
            "
            type="button"
            class="work-secondary"
            @click="showAll"
          >
            Show all work
          </button>
        </div>
      </div>
      <footer class="work-list-footer">
        <span
          >{{ visibleCards.length }}
          {{ visibleCards.length === 1 ? "item" : "items" }} across
          {{ visibleRoomCount }} {{ visibleRoomCount === 1 ? "room" : "rooms"
          }}{{ nextCursor ? " · more available" : "" }}</span
        ><button
          v-if="nextCursor"
          type="button"
          class="work-secondary"
          :disabled="loading"
          data-testid="my-work-more"
          @click="showMore"
        >
          {{ loading ? "Loading…" : "Load more" }}
        </button>
      </footer>
    </div>
    <dialog
      ref="dialog"
      class="work-detail-dialog"
      :aria-labelledby="`${prefix}-detail-title`"
      @cancel.prevent="closeDetails"
      @click="backdrop"
    >
      <WorkDetail
        v-if="selected"
        :card="selected"
        :api="api"
        :has-connections="Boolean(page?.has_connections)"
        :title-id="`${prefix}-detail-title`"
        @close="closeDetails"
        @open-card="openCard"
        @open-thread="openThread"
      />
    </dialog>
  </section>
</template>
<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch,
} from "vue";
import type { MyWorkCard } from "../../ticket-connectors.mjs";
import ChatAvatar from "../ChatAvatar.vue";
import DisclosurePanel from "../DisclosurePanel.vue";
import FilterDropdown from "../FilterDropdown.vue";
import WorkDetail from "./WorkDetail.vue";
import WorkIcon from "./WorkIcon.vue";
import type { MyWorkApi } from "./types";
import { useMyWork } from "./useMyWork";
import {
  checkSummaryLabel,
  myWorkCardKey,
  myWorkTrackerOptions,
  primaryPullRequest,
  pullRequestLabel,
  pullRequestStateLabel,
  workDate,
  workGroup,
  workGroups,
  workKey,
  workMatches,
  workOwner,
  workSignal,
  workTone,
  type MyWorkTrackerFilter,
  type WorkGroup,
  type WorkView,
} from "./model";
const props = defineProps<{
  api: MyWorkApi;
  tasksChangedAt?: Readonly<Record<string, string | null>>;
  connected?: boolean;
}>();
const emit = defineEmits<{
  "open-card": [roomId: string, taskId: string];
  "open-thread": [roomId: string, threadRootId: string];
  "open-trackers": [];
}>();
const {
  cards,
  page,
  nextCursor,
  loading,
  error,
  filters,
  roomOptions,
  reload,
  loadMore,
} = useMyWork(props);
const prefix = `my-work-${useId()}`;
const surface = ref<HTMLElement>(),
  searchInput = ref<HTMLInputElement>(),
  dialog = ref<HTMLDialogElement>();
const view = ref<WorkView>("all"),
  search = ref(""),
  collapsed = ref(new Set<WorkGroup>()),
  selectedKey = ref<string | null>(null);
const groupPositions = ref(new Map<string, WorkGroup>());
const revealedKeys = ref(new Set<string>());
const selected = computed(() =>
  cards.value.find((card) => myWorkCardKey(card) === selectedKey.value),
);
const views: { id: WorkView; label: string }[] = [
  { id: "all", label: "All work" },
  { id: "attention", label: "Needs you" },
  { id: "active", label: "In progress" },
  { id: "done", label: "Completed" },
];
const trackerOptions = computed(() => myWorkTrackerOptions(page.value));
const counts = computed(() => ({
  all: cards.value.length,
  attention: cards.value.filter((card) => workGroup(card) === "attention")
    .length,
  active: cards.value.filter((card) => workGroup(card) === "active").length,
  done: cards.value.filter((card) => workGroup(card) === "done").length,
}));
const visibleCards = computed(() =>
  cards.value.filter(
    (card) =>
      revealedKeys.value.has(myWorkCardKey(card)) &&
      workMatches(card, search.value) &&
      (view.value === "all" ||
        groupPositions.value.get(myWorkCardKey(card)) === view.value),
  ),
);
const visibleRoomCount = computed(
  () => new Set(visibleCards.value.map((card) => card.room_id)).size,
);
const visibleGroups = computed(() =>
  workGroups
    .map((group) => ({
      ...group,
      cards: visibleCards.value.filter(
        (card) => groupPositions.value.get(myWorkCardKey(card)) === group.id,
      ),
    }))
    .filter((group) => group.cards.length),
);
const pendingMoves = computed(() =>
  cards.value.some(
    (card) =>
      !revealedKeys.value.has(myWorkCardKey(card)) ||
      groupPositions.value.get(myWorkCardKey(card)) !== workGroup(card),
  ),
);
watch(cards, (next, previous) => {
  if (!previous?.length) revealedKeys.value = new Set(next.map(myWorkCardKey));
  const positions = new Map(groupPositions.value);
  for (const card of next)
    if (!positions.has(myWorkCardKey(card)))
      positions.set(myWorkCardKey(card), workGroup(card));
  for (const key of positions.keys())
    if (!next.some((card) => myWorkCardKey(card) === key))
      positions.delete(key);
  groupPositions.value = positions;
  if (selectedKey.value && !selected.value) closeDetails();
});
function applyGroups() {
  revealedKeys.value = new Set(cards.value.map(myWorkCardKey));
  groupPositions.value = new Map(
    cards.value.map((card) => [myWorkCardKey(card), workGroup(card)]),
  );
}
async function showMore() {
  await loadMore();
  revealedKeys.value = new Set(cards.value.map(myWorkCardKey));
}
async function refresh() {
  await reload(true);
  applyGroups();
}
function toggleGroup(id: WorkGroup) {
  const next = new Set(collapsed.value);
  next.has(id) ? next.delete(id) : next.add(id);
  collapsed.value = next;
}
function changeView(id: WorkView) {
  view.value = id;
  applyGroups();
  filters.needsMe = id === "attention";
}
function clearFilters() {
  filters.roomId = "";
  filters.tracker = "";
  search.value = "";
}
function showAll() {
  changeView("all");
  clearFilters();
}
let returnFocus: HTMLElement | null = null;
async function openDetails(card: MyWorkCard, event: MouseEvent) {
  returnFocus = event.currentTarget as HTMLElement;
  const key = myWorkCardKey(card);
  selectedKey.value = key;
  await nextTick();
  if (
    selectedKey.value !== key ||
    !selected.value ||
    !dialog.value?.isConnected
  )
    return;
  dialog.value.showModal();
  dialog.value
    ?.querySelector<HTMLElement>('[aria-label="Close work details"]')
    ?.focus({ preventScroll: true });
}
function closeDetails() {
  dialog.value?.close();
  selectedKey.value = null;
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}
function openCard(card: MyWorkCard) {
  closeDetails();
  emit("open-card", card.room_id, card.task_id);
}
function openThread(card: MyWorkCard, id: string) {
  closeDetails();
  emit("open-thread", card.room_id, id);
}
function backdrop(event: MouseEvent) {
  if (event.target !== dialog.value) return;
  const box = dialog.value.getBoundingClientRect();
  if (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  )
    closeDetails();
}
function tabKey(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const at = views.findIndex((item) => item.id === view.value);
  const index =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? views.length - 1
        : (at + (event.key === "ArrowLeft" ? -1 : 1) + views.length) %
          views.length;
  changeView(views[index]!.id);
  (event.currentTarget as HTMLElement)
    .querySelector<HTMLElement>(`#${CSS.escape(`${prefix}-${view.value}`)}`)
    ?.focus({ preventScroll: true });
}
function shortcut(event: KeyboardEvent) {
  if (
    event.key === "/" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !dialog.value?.open &&
    !(
      event.target instanceof HTMLElement &&
      (event.target.closest("input,textarea,select,[contenteditable=true]") ||
        document.querySelector(":popover-open"))
    )
  ) {
    event.preventDefault();
    searchInput.value?.focus();
  }
}
onMounted(() => document.addEventListener("keydown", shortcut));
onBeforeUnmount(() => {
  document.removeEventListener("keydown", shortcut);
  dialog.value?.close();
});
</script>
<style src="./my-work.css"></style>
