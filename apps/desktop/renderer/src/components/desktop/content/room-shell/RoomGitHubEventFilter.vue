<template>
  <div class="room-settings-row" data-testid="room-github-event-filter" :aria-busy="saving">
    <div class="room-settings-row-copy">
      <p class="room-settings-row-title">Events posted to this room</p>
      <p
        id="room-settings-event-filter-description"
        class="room-settings-row-description"
        :data-tone="error ? 'error' : undefined"
        :role="error ? 'alert' : undefined"
      >{{ description }}</p>
    </div>
    <div v-if="error && !filter" class="room-settings-row-action">
      <button class="room-settings-button" type="button" @click="load">Try again</button>
    </div>
    <fieldset
      v-if="filter"
      class="room-settings-checks"
      aria-describedby="room-settings-event-filter-description"
      :disabled="!filter.can_manage"
    >
      <legend class="sr-only">GitHub events posted to this room</legend>
      <label v-for="kind in kinds" :key="kind.id" class="room-settings-check">
        <input
          class="sr-only"
          type="checkbox"
          :data-testid="`room-github-event-kind-${kind.id}`"
          :checked="enabled.has(kind.id)"
          :disabled="!filter.can_manage"
          @change="toggle(kind.id, ($event.target as HTMLInputElement).checked)"
        >
        <span class="room-settings-check-box" aria-hidden="true"><Check /></span>
        <span class="room-settings-check-copy">
          <strong>{{ kind.label }}</strong>
          <small>{{ kind.hint }}</small>
        </span>
      </label>
    </fieldset>
  </div>
</template>

<script setup lang="ts">
import { Check } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { GitHubRoomChatEventFilter, GitHubRoomChatEventKind } from "../../../../../../../../shared/room-settings.mjs";
import { desktopIpc } from "../../../../ipc/index";
import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";
import { GITHUB_EVENT_KIND_LABELS } from "./room-settings-presentation";

const props = defineProps<{ roomIdentifier: string }>();
const filter = ref<GitHubRoomChatEventFilter | null>(null);
// What the person has chosen, shown at once; the server's answer replaces it.
const enabled = ref(new Set<GitHubRoomChatEventKind>());
const saving = ref(false);
const error = ref<string | null>(null);
let generation = 0;
let pendingSave: GitHubRoomChatEventKind[] | null = null;

const kinds = computed(() => (filter.value?.all_kinds ?? []).map((id) => ({ id, ...GITHUB_EVENT_KIND_LABELS[id] })));

const description = computed(() => {
  if (error.value) return error.value;
  if (!filter.value) return "Loading event settings…";
  const total = filter.value.all_kinds.length;
  const count = enabled.value.size;
  const posted = count === total ? "Every kind of GitHub event is posted as a message."
    : count === 0 ? "No GitHub events are posted as messages."
    : `${count} of ${total} kinds are posted as messages.`;
  const scope = "This applies to everyone in the room, including agents. The Events tab keeps all of them.";
  if (!filter.value.can_manage) return `${posted} Only room admins can change this.`;
  if (filter.value.inherited_from_room_id) {
    return `${posted} Following ${filter.value.inherited_from_room_id} until you change a kind here.`;
  }
  return `${posted} ${scope}`;
});

// `filter` is always what the server last confirmed, so a failed save goes
// back to what the server really has.
function accept(value: GitHubRoomChatEventFilter, options: { keepChoice?: boolean } = {}): void {
  filter.value = value;
  if (!options.keepChoice) enabled.value = new Set(value.enabled_kinds);
}

async function load(): Promise<void> {
  const version = ++generation;
  filter.value = null;
  error.value = null;
  saving.value = false;
  pendingSave = null;
  try {
    const value = await desktopIpc.room.getGitHubEventFilter(props.roomIdentifier);
    if (generation === version) accept(value);
  } catch (cause) {
    if (generation === version) error.value = safeUserVisibleErrorDetail(cause, "Event settings could not be loaded.");
  }
}

function toggle(kind: GitHubRoomChatEventKind, checked: boolean): void {
  if (!filter.value?.can_manage) return;
  const next = new Set(enabled.value);
  if (checked) next.add(kind); else next.delete(kind);
  enabled.value = next;
  pendingSave = filter.value.all_kinds.filter((id) => next.has(id));
  if (!saving.value) void save();
}

// One request at a time, always sending the latest choice, so quick clicks
// cannot land out of order.
async function save(): Promise<void> {
  const version = generation;
  saving.value = true;
  error.value = null;
  try {
    while (pendingSave && generation === version) {
      const kindsToSave = pendingSave;
      pendingSave = null;
      const value = await desktopIpc.room.setGitHubEventFilter(props.roomIdentifier, kindsToSave);
      if (generation !== version) return;
      // A newer choice is waiting to be sent, so what is shown stays the choice.
      accept(value, { keepChoice: pendingSave !== null });
    }
  } catch (cause) {
    if (generation !== version) return;
    pendingSave = null;
    error.value = safeUserVisibleErrorDetail(cause, "Event settings could not be saved.");
    if (filter.value) enabled.value = new Set(filter.value.enabled_kinds);
  } finally {
    if (generation === version) saving.value = false;
  }
}

watch(() => props.roomIdentifier, load, { immediate: true, flush: "sync" });
onBeforeUnmount(() => { generation++; });
</script>
