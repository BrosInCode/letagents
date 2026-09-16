<template>
  <section class="room-tab-page knowledge-page memory-page" aria-labelledby="room-memory-title" data-testid="room-memory-view" :data-motion="motionEnabled" @pointerdown.capture="motionEnabled = true" @keydown.capture="motionEnabled = false">
    <div class="memory-brief" :inert="Boolean(editor)">
      <header class="knowledge-header">
        <div class="knowledge-title"><div><h2 id="room-memory-title">Room memory</h2><p>Shared context for everyone in this room<span v-if="activeCount"> · {{ activeCount }} {{ activeCount === 1 ? 'memory' : 'memories' }}</span></p></div></div>
        <div class="knowledge-header-actions">
          <button class="knowledge-icon-button" :disabled="loading" aria-label="Refresh memory" title="Refresh memory" @click="refresh"><RefreshCw :size="16" :class="{ 'knowledge-spin': loading }" aria-hidden="true" /></button>
          <button ref="addMemoryButton" class="knowledge-button knowledge-primary" :disabled="saving" @click="startNew()"><Plus :size="15" aria-hidden="true" />Add memory</button>
        </div>
      </header>
      <div v-if="page.records.length" class="memory-toolbar" role="search" aria-label="Room memory">
        <label class="knowledge-search"><Search :size="16" aria-hidden="true" /><input ref="searchInput" v-model="search" type="search" aria-label="Search memories" placeholder="Search memories" /><button v-if="search" class="knowledge-icon-button" aria-label="Clear search" @click="clearSearch"><X :size="14" aria-hidden="true" /></button></label>
        <span class="memory-select memory-filter"><select v-model="category" aria-label="Memory category"><option value="">All categories</option><option v-for="kind in MEMORY_CATEGORIES" :key="kind" :value="kind">{{ labels[kind] }}</option></select><ChevronDown :size="15" aria-hidden="true" /></span>
        <button class="knowledge-button memory-archive-toggle" :aria-pressed="showArchived" @click="showArchived = !showArchived"><Archive :size="15" aria-hidden="true" />{{ showArchived ? 'Back to active' : 'Archived' }}</button>
      </div>
      <p v-if="error" class="knowledge-notice" role="alert">{{ error }} <button @click="refresh">Retry</button></p>
      <p v-if="page.truncated" class="knowledge-notice">Showing the 200 most recently updated entries, with active entries first. Search applies to these entries.</p>
      <p v-if="notice" class="knowledge-success" role="status"><CircleCheck :size="15" aria-hidden="true" />{{ notice }}</p>
      <div v-if="loading && !page.records.length" class="knowledge-empty" role="status"><LoaderCircle class="knowledge-spin" :size="24" aria-hidden="true" /><h3>Loading shared context</h3></div>
      <div v-else-if="error && !page.records.length" class="knowledge-empty" role="status"><h3>Shared context is unavailable</h3><p>Retry when the room connection is available to see your saved memories.</p></div>
      <div v-else-if="!page.records.length" class="memory-start">
        <div class="memory-start-intro"><h3>Give this room its first memory.</h3><p>Write down what matters once, so every agent starts with the same understanding.</p></div>
        <section class="memory-start-goal">
          <span class="knowledge-category"><Flag :size="15" aria-hidden="true" />Start with a goal</span>
          <h3>What are we working toward?</h3><p>Describe the outcome you want this room to achieve.</p>
          <button class="knowledge-button knowledge-primary" :disabled="saving" @click="startNew('goal')"><Plus :size="15" aria-hidden="true" />Set the room’s goal</button>
        </section>
        <div class="memory-start-follow">
          <button v-for="starter in starters.slice(1)" :key="starter.kind" class="memory-prompt" :disabled="saving" @click="startNew(starter.kind)"><component :is="categoryIcons[starter.kind]" :size="18" aria-hidden="true" /><span><strong>{{ starter.title }}</strong><small>{{ starter.description }}</small></span><Plus :size="15" aria-hidden="true" /></button>
        </div>
        <p class="memory-shared-note"><Users :size="15" aria-hidden="true" />Saved with your name and shared with the room’s agents.</p>
      </div>
      <div v-else-if="!filtered.length" class="memory-no-results" role="status">
        <Search :size="22" aria-hidden="true" /><h3>{{ search.trim() || category ? 'No matching memories' : showArchived ? 'No archived memories' : 'No active memories' }}</h3>
        <p>{{ search.trim() || category ? 'Try another search or clear your filters.' : showArchived ? 'Memories you archive will appear here, with their history preserved.' : 'Your memories are archived. Open the archive to review or restore them.' }}</p>
        <button v-if="search.trim() || category || showArchived" class="knowledge-button" @click="clearFilters">{{ search.trim() || category ? 'Clear filters' : 'Back to active' }}</button><button v-else class="knowledge-button" @click="showArchived = true">View archived memories</button>
      </div>
      <div v-else class="memory-sections">
        <section v-for="group in groups" :key="group.kind" class="memory-section" :data-kind="group.kind" :aria-labelledby="`memory-section-${group.kind}`">
          <header class="memory-section-heading"><h3 :id="`memory-section-${group.kind}`"><component :is="categoryIcons[group.kind]" :size="16" aria-hidden="true" />{{ labels[group.kind] }}<span>{{ group.records.length }}</span></h3><button v-if="!showArchived" class="knowledge-icon-button" :aria-label="`Add ${group.kind === 'term' ? 'terminology' : group.kind}`" :disabled="saving" @click="startNew(group.kind)"><Plus :size="15" aria-hidden="true" /></button></header>
          <TransitionGroup name="knowledge-list" tag="div" class="memory-entries">
            <article v-for="record in group.records" :key="record.id" class="memory-card" :data-archived="record.archived">
              <div class="memory-card-heading"><h4>{{ record.title }}</h4><button class="knowledge-icon-button" :aria-label="`Edit ${record.title}`" title="Edit memory" :disabled="saving" @click="edit(record)"><Pencil :size="14" aria-hidden="true" /></button></div>
              <p class="knowledge-prose">{{ record.body }}</p>
              <div v-if="record.source_url || record.source_message_id" class="memory-sources"><button v-if="record.source_url" class="knowledge-text-button" @click="openSource(record.source_url)"><Link2 :size="13" aria-hidden="true" />{{ sourceLabel(record.source_url) }}<ArrowUpRight :size="12" aria-hidden="true" /></button><button v-if="record.source_message_id" class="knowledge-text-button" @click="emit('openMessage', record.source_message_id)"><MessageSquare :size="13" aria-hidden="true" />Original message</button></div>
              <footer><span :title="new Date(record.updated_at).toLocaleString()">{{ record.updated_by.label }} · {{ date(record.updated_at) }} <span class="memory-version">· v{{ record.version }}{{ record.archived ? ' · Archived' : '' }}</span></span><button class="knowledge-icon-button" :aria-label="`History of ${record.title}`" title="Version history" :disabled="saving" @click="showHistory(record)"><History :size="14" aria-hidden="true" /></button></footer>
            </article>
          </TransitionGroup>
        </section>
      </div>
    </div>
    <DesktopDialogShell :open="Boolean(editor)" aria-labelledby="memory-editor-title" backdrop-class="memory-editor-backdrop" panel-class="memory-editor" :show-close="false" :close-disabled="saving" :initial-focus="historyMode ? '[data-memory-close]' : '[data-memory-title]'" @close="closeEditor">
      <template v-if="editor">
            <div class="memory-editor-heading"><h3 id="memory-editor-title" tabindex="-1">{{ historyMode ? 'Version history' : editor.record ? 'Edit memory' : 'Add memory' }}</h3><button data-memory-close class="knowledge-icon-button" aria-label="Close memory editor" :disabled="saving" @click="closeEditor"><X :size="16" aria-hidden="true" /></button></div>
            <div v-if="historyMode" class="memory-history"><h4>{{ editor.record?.title }}</h4><p v-if="historyLoading" role="status">Loading history…</p><p v-if="historyTruncated" class="knowledge-notice">Showing the latest 100 versions.</p><article v-for="revision in history" :key="revision.version"><span class="knowledge-category">v{{ revision.version }} · {{ revision.version === editor.record?.version ? 'Current' : 'Superseded' }}{{ revision.archived ? ' · Archived' : '' }}</span><h4>{{ revision.title }}</h4><p class="knowledge-prose">{{ revision.body }}</p><small>{{ revision.updated_by.label }} · {{ new Date(revision.updated_at).toLocaleString() }}</small><button v-if="revision.source_url" class="knowledge-text-button" @click="openSource(revision.source_url)">Source <ArrowUpRight :size="13" aria-hidden="true" /></button></article></div>
            <form v-else class="memory-form" @submit.prevent="save()">
              <label>Category<span class="memory-select"><select v-model="editor.input.category" :disabled="saving"><option v-for="kind in MEMORY_CATEGORIES" :key="kind" :value="kind">{{ labels[kind] }}</option></select><ChevronDown :size="16" aria-hidden="true" /></span></label>
              <label>Title<input data-memory-title v-model="editor.input.title" maxlength="160" required placeholder="What should the room remember?" :disabled="saving" /></label>
              <label>Details<textarea v-model="editor.input.body" rows="6" maxlength="8000" required placeholder="Include the context and the reason." :disabled="saving"></textarea></label>
              <details class="memory-source-fields"><summary>Add a source <span>Optional</span><ChevronDown :size="14" aria-hidden="true" /></summary><label>Source link<input v-model="editor.input.source_url" type="url" placeholder="https://…" maxlength="2048" :disabled="saving" /></label><label>Room message<input v-model="editor.input.source_message_id" placeholder="msg_123" maxlength="40" :disabled="saving" /></label></details>
              <p class="memory-form-note">{{ editor.record ? 'A new version is saved. Previous versions stay in history.' : 'Saved with your name and available to the room’s agents.' }}</p>
              <div class="memory-form-actions"><button class="knowledge-button" type="button" :disabled="saving" @click="closeEditor">Cancel</button><button class="knowledge-button knowledge-primary" :disabled="saving || !editor.input.title.trim() || !editor.input.body.trim()"><LoaderCircle v-if="saving" :size="14" class="knowledge-spin" aria-hidden="true" />{{ saving ? 'Saving…' : 'Save memory' }}</button></div>
              <button v-if="editor.record" type="button" class="knowledge-text-button memory-archive-action" :disabled="saving" @click="archive"><Archive :size="14" aria-hidden="true" />{{ editor.record.archived ? 'Restore this memory' : 'Archive this memory' }}</button>
            </form>
            <p v-if="editError" class="knowledge-inline-error" role="alert">{{ editError }}</p>
      </template>
    </DesktopDialogShell>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { Archive, ArrowUpRight, ChevronDown, CircleCheck, Flag, History, Link2, LoaderCircle, MessageSquare, Pencil, Plus, RefreshCw, Search, Shield, Type, Users, X } from '@lucide/vue';
import { MEMORY_CATEGORIES, type KnowledgeInput, type KnowledgePage, type KnowledgeRecord, type MemoryCategory } from '../../../../../../../shared/room-knowledge.mjs';
import { desktopBridgeUpgradeMessage, desktopIpc } from '../../../ipc/index.js';
import DesktopDialogShell from './DesktopDialogShell.vue';
import './room-knowledge.css';
const props = defineProps<{ roomIdentifier: string }>();
const emit = defineEmits<{ openMessage: [id: string] }>();
const page = ref<KnowledgePage>({ records: [], truncated: false }); const loading = ref(false); const error = ref(''); const notice = ref('');
const search = ref(''); const category = ref(''); const showArchived = ref(false); const saving = ref(false); const editError = ref('');
const editor = ref<{ record: KnowledgeRecord | null; clientId: string; input: KnowledgeInput } | null>(null);
const historyMode = ref(false); const historyLoading = ref(false); const historyTruncated = ref(false); const history = ref<KnowledgeRecord[]>([]);
let epoch = 0; let historyEpoch = 0;
const labels: Record<MemoryCategory, string> = { goal: 'Goals', decision: 'Decisions', constraint: 'Constraints', term: 'Terminology', reference: 'References' };
const motionEnabled = ref(false);
const addMemoryButton = ref<HTMLButtonElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
let editorTrigger: HTMLElement | null = null;
const categoryIcons = { goal: Flag, decision: CircleCheck, constraint: Shield, term: Type, reference: Link2 };
const starters: { kind: MemoryCategory; title: string; description: string }[] = [
  { kind: 'goal', title: 'Set a goal', description: 'What are we working toward?' },
  { kind: 'decision', title: 'Record a decision', description: 'What did we choose, and why?' },
  { kind: 'constraint', title: 'Add a constraint', description: 'What should every agent respect?' },
];
const activeCount = computed(() => page.value.records.filter(record => !record.archived).length);
const groups = computed(() => MEMORY_CATEGORIES.map(kind => ({ kind, records: filtered.value.filter(record => record.category === kind) })).filter(group => group.records.length));
function clearSearch() { search.value = ''; void nextTick(() => searchInput.value?.focus()); }
function clearFilters() { category.value = ''; showArchived.value = false; clearSearch(); }
function restoreEditorFocus(onlyIfUnfocused = false) { const trigger = editorTrigger; void nextTick(() => { if (onlyIfUnfocused && document.activeElement !== document.body) return; (trigger?.isConnected ? trigger : addMemoryButton.value)?.focus({ preventScroll: true }); }); }
function closeEditor() { if (saving.value) return; historyEpoch++; editor.value = null; restoreEditorFocus(); }

const filtered = computed(() => page.value.records.filter(record => record.archived === showArchived.value && (!category.value || record.category === category.value) && (!search.value.trim() || `${record.title} ${record.body}`.toLowerCase().includes(search.value.trim().toLowerCase()))));
function date(value: string) { return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function sourceLabel(value: string) { try { return new URL(value).hostname; } catch { return 'Source'; } }
async function refresh() {
  const current = ++epoch; loading.value = true;
  try { if (!desktopIpc.room.getKnowledge) throw new Error(desktopBridgeUpgradeMessage()); const result = await desktopIpc.room.getKnowledge(props.roomIdentifier, 'memory'); if (current === epoch) { page.value = result; error.value = ''; } }
  catch (cause) { if (current === epoch) error.value = cause instanceof Error ? cause.message : 'Unable to load memory.'; }
  finally { if (current === epoch) loading.value = false; }
}
watch(() => props.roomIdentifier, () => { editor.value = null; page.value = { records: [], truncated: false }; notice.value = ''; search.value = ''; category.value = ''; showArchived.value = false; historyEpoch++; void refresh(); }, { immediate: true });
onBeforeUnmount(() => { epoch++; historyEpoch++; });
function startNew(kind: MemoryCategory = 'decision') { if (saving.value) return; editorTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null; historyEpoch++; historyMode.value = false; editError.value = ''; editor.value = { record: null, clientId: crypto.randomUUID(), input: { category: kind, title: '', body: '', source_url: '', source_message_id: '' } }; }
function edit(record: KnowledgeRecord) { if (saving.value) return; startNew(); editor.value = { record, clientId: record.id, input: { category: record.category, title: record.title, body: record.body, source_url: record.source_url, source_message_id: record.source_message_id } }; }
async function showHistory(record: KnowledgeRecord) {
  if (saving.value) return;
  edit(record); historyMode.value = true; history.value = []; historyLoading.value = true; const current = ++historyEpoch;
  try { if (!desktopIpc.room.getMemoryHistory) throw new Error(desktopBridgeUpgradeMessage()); const result = await desktopIpc.room.getMemoryHistory(props.roomIdentifier, record.id); if (current === historyEpoch) { history.value = result.records; historyTruncated.value = result.truncated; } }
  catch (cause) { if (current === historyEpoch) editError.value = String(cause); }
  finally { if (current === historyEpoch) historyLoading.value = false; }
}
async function save(archived?: boolean) {
  const draft = editor.value; const roomId = props.roomIdentifier; if (!draft || saving.value) return;
  saving.value = true; editError.value = ''; let completed = false;
  try {
    if (draft.record) { if (!desktopIpc.room.reviseKnowledge) throw new Error(desktopBridgeUpgradeMessage()); await desktopIpc.room.reviseKnowledge(roomId, 'memory', draft.record.id, { expected_version: draft.record.version, ...(archived === undefined ? draft.input : { archived }) }); }
    else { if (!desktopIpc.room.createKnowledge) throw new Error(desktopBridgeUpgradeMessage()); await desktopIpc.room.createKnowledge(roomId, 'memory', { ...draft.input, client_id: draft.clientId }); }
    if (roomId === props.roomIdentifier) { editor.value = null; search.value = ''; category.value = ''; showArchived.value = archived ?? draft.record?.archived ?? false; notice.value = archived === true ? 'Memory archived. Its history is preserved.' : 'Memory saved for the room.'; await refresh(); completed = true; }
  } catch (cause) { if (roomId === props.roomIdentifier) editError.value = cause instanceof Error ? cause.message : 'Unable to save memory.'; }
  finally { saving.value = false; if (completed && roomId === props.roomIdentifier) restoreEditorFocus(true); }
}
function archive() { if (editor.value?.record) void save(!editor.value.record.archived); }
async function openSource(url: string) {
  try { await desktopIpc.app.openExternalUrl(url); }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (editor.value) editError.value = message;
    else error.value = message;
  }
}
</script>
