<template>
  <form
    class="room-settings-row room-settings-guidelines"
    data-testid="room-agent-guidelines"
    :aria-busy="saving"
    @submit.prevent="save"
  >
    <div class="room-settings-row-copy">
      <label class="room-settings-row-title" for="room-settings-guidelines-text">Agent guidelines</label>
      <p id="room-settings-guidelines-description" class="room-settings-row-description">{{ description }}</p>
    </div>
    <div class="room-settings-row-action">
      <button v-if="loadError" class="room-settings-button" type="button" @click="load">Try again</button>
      <button
        v-else-if="canManage"
        class="room-settings-button"
        type="button"
        data-testid="room-agent-guidelines-import"
        :aria-disabled="saving"
        @click="!saving && fileInput?.click()"
      >
        <Upload aria-hidden="true" />
        Import file
      </button>
      <input
        ref="fileInput"
        class="sr-only"
        type="file"
        accept=".md,.markdown,.mdc,.txt,text/plain,text/markdown"
        tabindex="-1"
        aria-hidden="true"
        @change="importFromInput"
      >
    </div>

    <template v-if="loaded">
      <div
        class="room-settings-guidelines-field"
        :data-drop="dropping"
        @dragenter="handleDragEnter"
        @dragover="handleDragOver"
        @dragleave="handleDragLeave"
        @drop="handleDrop"
      >
        <textarea
          id="room-settings-guidelines-text"
          v-model="draft"
          class="room-settings-textarea"
          data-testid="room-agent-guidelines-text"
          rows="9"
          spellcheck="false"
          aria-describedby="room-settings-guidelines-description room-settings-guidelines-budget room-settings-guidelines-note"
          :readonly="!canManage || saving"
          :placeholder="placeholder"
          @input="note = null"
        />
        <p class="room-settings-guidelines-drop" aria-hidden="true">Drop a text file to import it</p>
      </div>
      <div class="room-settings-guidelines-footer">
        <div class="room-settings-budget" :data-level="budget.level">
          <span class="room-settings-budget-track" aria-hidden="true">
            <span class="room-settings-budget-fill" :style="{ transform: `scaleX(${budget.fill})` }" />
          </span>
          <p id="room-settings-guidelines-budget" class="room-settings-budget-text">{{ budget.message }}</p>
        </div>
        <div class="room-settings-guidelines-actions" :data-visible="canManage && dirty">
          <button class="room-settings-button" type="button" :aria-disabled="saving" @click="discard">Discard</button>
          <button
            class="room-settings-button room-settings-guidelines-save"
            type="submit"
            data-variant="primary"
            data-testid="room-agent-guidelines-save"
            :disabled="budget.level === 'over'"
            :aria-disabled="saving"
          >{{ saving ? "Saving…" : "Save guidelines" }}</button>
        </div>
      </div>
      <p
        id="room-settings-guidelines-note"
        class="room-settings-guidelines-note"
        :data-tone="note?.tone"
        :role="note?.tone === 'error' ? 'alert' : 'status'"
      >{{ note?.text }}</p>
    </template>
  </form>
</template>

<script setup lang="ts">
import { Upload } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { normalizeRoomAgentGuidelines, type RoomAgentGuidelines } from "../../../../../../../../shared/room-settings.mjs";
import { desktopIpc } from "../../../../ipc/index";
import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";
import { forgetGuidelinesDraft, keptGuidelinesDraft, rememberGuidelinesDraft } from "./room-settings-drafts";
import { checkGuidelinesImport, checkGuidelinesImportText, describeGuidelinesBudget } from "./room-settings-presentation";

const props = defineProps<{ roomIdentifier: string }>();
const emit = defineEmits<{ summary: [text: string | null] }>();

const stored = ref<RoomAgentGuidelines | null>(null);
const draft = ref("");
const saving = ref(false);
const loadError = ref<string | null>(null);
const note = ref<{ text: string; tone?: "error" } | null>(null);
const dropping = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
let generation = 0;
let dragDepth = 0;
// The saved text a restored draft was written against, until it is saved or discarded.
let draftWrittenAgainst: string | null = null;

const placeholder = "Write the rules agents should follow here, or drop a .md or .txt file.\n\nFor example:\n- Branch from staging. Never commit to main.\n- Run the tests before asking for review.";

const loaded = computed(() => stored.value !== null);
const canManage = computed(() => Boolean(stored.value?.can_manage));
const savedText = computed(() => stored.value?.guidelines ?? "");
const dirty = computed(() => normalizeRoomAgentGuidelines(draft.value) !== savedText.value);
const budget = computed(() => describeGuidelinesBudget(draft.value));

const description = computed(() => {
  if (loadError.value) return loadError.value;
  if (!stored.value) return "Loading guidelines…";
  if (!stored.value.can_manage) return "Rules for agents working in this room. Only room admins can edit them.";
  if (stored.value.inherited_from_room_id) {
    return `Following the guidelines of ${stored.value.inherited_from_room_id}. Save a change here to give this room its own.`;
  }
  return "Rules for agents working in this room. Agents read them before they start work, so keep them short and link to longer documents.";
});

function accept(value: RoomAgentGuidelines): void {
  stored.value = value;
  draft.value = value.guidelines ?? "";
}

// A draft outlives the dialog: it is kept when the text differs from what is
// saved, and let go once it is saved or discarded.
watch([draft, stored], () => {
  if (!stored.value?.can_manage) return;
  if (dirty.value) {
    rememberGuidelinesDraft(props.roomIdentifier, draft.value, draftWrittenAgainst ?? savedText.value);
    return;
  }
  // Back to the saved text: what is written next is written against it.
  draftWrittenAgainst = null;
  forgetGuidelinesDraft(props.roomIdentifier);
});

async function load(): Promise<void> {
  const version = ++generation;
  stored.value = null;
  draft.value = "";
  loadError.value = null;
  note.value = null;
  saving.value = false;
  try {
    const value = await desktopIpc.room.getAgentGuidelines(props.roomIdentifier);
    if (generation !== version) return;
    const kept = value.can_manage ? keptGuidelinesDraft(props.roomIdentifier) : null;
    const saved = value.guidelines ?? "";
    draftWrittenAgainst = null;
    accept(value);
    if (kept && normalizeRoomAgentGuidelines(kept.draft) !== saved) {
      // Someone may have saved since the draft was written; saving the draft would replace their text.
      const savedChanged = kept.writtenAgainst !== saved;
      draftWrittenAgainst = kept.writtenAgainst;
      draft.value = kept.draft;
      note.value = savedChanged
        ? { text: "Your unsaved draft was kept, but the saved guidelines changed since you wrote it. Saving replaces them. Discard to see what is saved now.", tone: "error" }
        : { text: "Your unsaved draft was kept. Save it, or discard it to go back to what is saved." };
    }
  } catch (cause) {
    if (generation === version) loadError.value = safeUserVisibleErrorDetail(cause, "Guidelines could not be loaded.");
  }
}

async function save(): Promise<void> {
  if (!canManage.value || saving.value || !dirty.value || budget.value.level === "over") return;
  const version = generation;
  saving.value = true;
  note.value = null;
  try {
    const value = await desktopIpc.room.setAgentGuidelines(props.roomIdentifier, draft.value);
    if (generation !== version) return;
    const cleared = !normalizeRoomAgentGuidelines(draft.value);
    draftWrittenAgainst = null;
    accept(value);
    note.value = {
      text: !cleared ? "Guidelines saved."
        : value.inherited_from_room_id ? `This room has no guidelines of its own, so it follows ${value.inherited_from_room_id}.`
        : "Guidelines cleared.",
    };
  } catch (cause) {
    if (generation === version) {
      note.value = { text: safeUserVisibleErrorDetail(cause, "Guidelines could not be saved."), tone: "error" };
    }
  } finally {
    if (generation === version) saving.value = false;
  }
}

function discard(): void {
  if (saving.value) return;
  draftWrittenAgainst = null;
  draft.value = savedText.value;
  note.value = null;
}

async function importFile(file: File | undefined): Promise<void> {
  if (!file || !canManage.value || saving.value) return;
  const check = checkGuidelinesImport(file);
  if (!check.ok) {
    note.value = { text: check.reason, tone: "error" };
    return;
  }
  const version = generation;
  try {
    const raw = await file.text();
    if (generation !== version) return;
    const readable = checkGuidelinesImportText(file.name, raw);
    if (!readable.ok) {
      note.value = { text: readable.reason, tone: "error" };
      return;
    }
    const text = normalizeRoomAgentGuidelines(raw);
    draft.value = text;
    note.value = describeGuidelinesBudget(text).level === "over"
      ? { text: `Imported ${file.name}. It's over the limit, so trim it before saving.`, tone: "error" }
      : { text: `Imported ${file.name}. Review it, then save.` };
  } catch {
    if (generation === version) note.value = { text: `${file.name} could not be read.`, tone: "error" };
  }
}

function importFromInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  void importFile(input.files?.[0]);
  input.value = "";
}

function draggingFiles(event: DragEvent): boolean {
  return canManage.value && Boolean(event.dataTransfer?.types.includes("Files"));
}

function handleDragEnter(event: DragEvent): void {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  dropping.value = true;
}

function handleDragOver(event: DragEvent): void {
  if (dropping.value) event.preventDefault();
}

function handleDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropping.value = false;
}

function handleDrop(event: DragEvent): void {
  if (!dropping.value) return;
  event.preventDefault();
  dragDepth = 0;
  dropping.value = false;
  void importFile(event.dataTransfer?.files[0]);
}

watch(() => props.roomIdentifier, load, { immediate: true, flush: "sync" });
// The rail reports what is saved, not the draft.
watch(stored, (value) => {
  emit("summary", value ? describeGuidelinesBudget(value.guidelines ?? "").summary : null);
}, { immediate: true });
onBeforeUnmount(() => { generation++; });
</script>
