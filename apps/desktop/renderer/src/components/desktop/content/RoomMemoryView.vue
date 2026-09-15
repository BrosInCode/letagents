<template>
  <section class="room-tab-page knowledge-page memory-page" aria-labelledby="room-memory-title" data-testid="room-memory-view" :data-motion="motionEnabled" @pointerdown.capture="motionEnabled = true" @keydown.capture="motionEnabled = false">
    <header class="knowledge-header">
      <div class="knowledge-title"><BookOpen :size="20" aria-hidden="true" /><div><h2 id="room-memory-title">Room memory</h2><p>The context your agents work from.</p></div></div>
      <div class="knowledge-header-actions">
        <button class="knowledge-icon-button" :disabled="loading" aria-label="Refresh memory" title="Refresh memory" @click="refresh"><RefreshCw :size="16" :class="{ 'knowledge-spin': loading }" aria-hidden="true" /></button>
        <button ref="addMemoryButton" class="knowledge-button knowledge-primary" :disabled="saving" @click="startNew()"><Plus :size="15" aria-hidden="true" />Add memory</button>
      </div>
    </header>
    <p v-if="error" class="knowledge-notice" role="alert">{{ error }} <button @click="refresh">Retry</button></p>
    <p v-if="page.truncated" class="knowledge-notice">Showing the 200 most recently updated entries, with active entries first.</p>
    <p v-if="notice" class="knowledge-success" role="status"><CircleCheck :size="15" aria-hidden="true" />{{ notice }}</p>
    <div class="memory-library">
      <nav class="memory-categories" aria-label="Memory category">
        <span class="knowledge-eyebrow">Library</span>
        <button :aria-pressed="!category" @click="category = ''"><Layers3 :size="15" aria-hidden="true" /><span>All memories</span><small>{{ visibleCount }}</small></button>
        <button v-for="kind in MEMORY_CATEGORIES" :key="kind" :aria-pressed="category === kind" @click="category = kind"><component :is="categoryIcons[kind]" :size="15" aria-hidden="true" /><span>{{ labels[kind] }}</span><small>{{ categoryCount(kind) }}</small></button>
        <div class="memory-library-note"><Users :size="15" aria-hidden="true" /><p>Shared with every agent in this room.</p></div>
      </nav>
      <div class="memory-content">
        <div class="memory-toolbar">
          <label class="knowledge-search"><Search :size="15" aria-hidden="true" /><input ref="searchInput" v-model="search" aria-label="Search room memory" placeholder="Search memories…" /><button v-if="search" class="knowledge-icon-button" aria-label="Clear search" @click="clearSearch"><X :size="13" aria-hidden="true" /></button></label>
          <button class="knowledge-button" :aria-pressed="showArchived" @click="showArchived = !showArchived"><Archive :size="14" aria-hidden="true" />{{ showArchived ? 'Archived' : 'Archive' }}</button>
        </div>
        <div class="memory-workspace" :data-editing="Boolean(editor)">
          <div class="memory-main">
            <div v-if="loading && !page.records.length" class="knowledge-empty" role="status"><LoaderCircle class="knowledge-spin" :size="24" aria-hidden="true" /><h3>Loading shared context</h3></div>
            <div v-else-if="error && !page.records.length" class="knowledge-empty" role="status"><h3>Shared context is unavailable</h3><p>Retry when the room connection is available to see your saved memories.</p></div>
            <div v-else-if="!filtered.length" class="memory-empty">
              <span class="memory-empty-icon"><BookOpen :size="24" aria-hidden="true" /></span>
              <h3>{{ search || category || showArchived ? 'No matching memories' : 'Give your agents a starting point' }}</h3>
              <p>{{ search || category || showArchived ? 'Try another category, or clear your filters.' : 'Save a goal, a decision, or a constraint once. Your agents can return to it as the work moves forward.' }}</p>
              <button v-if="search || category || showArchived" class="knowledge-button" @click="clearFilters">Clear filters</button>
              <div v-else class="memory-starters">
                <button v-for="starter in starters" :key="starter.kind" :disabled="saving" @click="startNew(starter.kind)"><component :is="categoryIcons[starter.kind]" :size="17" aria-hidden="true" /><span><strong>{{ starter.title }}</strong><small>{{ starter.description }}</small></span><Plus :size="14" aria-hidden="true" /></button>
              </div>
            </div>
            <TransitionGroup v-else name="knowledge-list" tag="div" class="memory-grid">
              <article v-for="record in filtered" :key="record.id" class="memory-card" :data-archived="record.archived">
                <div class="memory-card-heading"><span class="knowledge-category"><component :is="categoryIcons[record.category as MemoryCategory]" :size="13" aria-hidden="true" />{{ labels[record.category as MemoryCategory] }}</span><span class="memory-version">v{{ record.version }}{{ record.archived ? ' · Archived' : '' }}</span></div>
                <h3>{{ record.title }}</h3><p class="knowledge-prose">{{ record.body }}</p>
                <div v-if="record.source_url || record.source_message_id" class="memory-sources"><button v-if="record.source_url" class="knowledge-text-button" @click="openSource(record.source_url)"><Link2 :size="13" aria-hidden="true" />{{ sourceLabel(record.source_url) }}<ArrowUpRight :size="12" aria-hidden="true" /></button><button v-if="record.source_message_id" class="knowledge-text-button" @click="emit('openMessage', record.source_message_id)"><MessageSquare :size="13" aria-hidden="true" />Original message</button></div>
                <footer><span :title="new Date(record.updated_at).toLocaleString()">{{ record.updated_by.label }} · {{ date(record.updated_at) }}</span><div><button class="knowledge-icon-button" :aria-label="`History of ${record.title}`" title="Version history" :disabled="saving" @click="showHistory(record)"><History :size="14" aria-hidden="true" /></button><button class="knowledge-icon-button" :aria-label="`Edit ${record.title}`" title="Edit memory" :disabled="saving" @click="edit(record)"><Pencil :size="14" aria-hidden="true" /></button></div></footer>
              </article>
            </TransitionGroup>
          </div>
          <aside v-if="editor" class="memory-editor knowledge-enter" aria-labelledby="memory-editor-title">
            <div class="memory-editor-heading"><h3 id="memory-editor-title" ref="editorHeading" tabindex="-1">{{ historyMode ? 'Version history' : editor.record ? 'Edit memory' : 'New memory' }}</h3><button class="knowledge-icon-button" aria-label="Close memory editor" :disabled="saving" @click="closeEditor"><X :size="16" aria-hidden="true" /></button></div>
            <div v-if="historyMode" class="memory-history"><h4>{{ editor.record?.title }}</h4><p v-if="historyLoading" role="status">Loading history…</p><p v-if="historyTruncated" class="knowledge-notice">Showing the latest 100 versions.</p><article v-for="revision in history" :key="revision.version"><span class="knowledge-category">v{{ revision.version }} · {{ revision.version === editor.record?.version ? 'Current' : 'Superseded' }}{{ revision.archived ? ' · Archived' : '' }}</span><h4>{{ revision.title }}</h4><p class="knowledge-prose">{{ revision.body }}</p><small>{{ revision.updated_by.label }} · {{ new Date(revision.updated_at).toLocaleString() }}</small><button v-if="revision.source_url" class="knowledge-text-button" @click="openSource(revision.source_url)">Source <ArrowUpRight :size="13" aria-hidden="true" /></button></article></div>
            <form v-else class="memory-form" @submit.prevent="save()">
              <label>Category<select v-model="editor.input.category" :disabled="saving"><option v-for="kind in MEMORY_CATEGORIES" :key="kind" :value="kind">{{ labels[kind] }}</option></select></label>
              <label>Title<input v-model="editor.input.title" maxlength="160" required placeholder="What should the room remember?" :disabled="saving" /></label>
              <label>Details<textarea v-model="editor.input.body" rows="6" maxlength="8000" required placeholder="Include the context and the reason." :disabled="saving"></textarea></label>
              <details class="memory-source-fields"><summary>Add a source <span>Optional</span><ChevronDown :size="14" aria-hidden="true" /></summary><label>Source link<input v-model="editor.input.source_url" type="url" placeholder="https://…" maxlength="2048" :disabled="saving" /></label><label>Room message<input v-model="editor.input.source_message_id" placeholder="msg_123" maxlength="40" :disabled="saving" /></label></details>
              <p class="memory-form-note">{{ editor.record ? 'A new version is saved. Previous versions stay in history.' : 'Saved with your name and available to the room’s agents.' }}</p>
              <div class="memory-form-actions"><button class="knowledge-button" type="button" :disabled="saving" @click="closeEditor">Cancel</button><button class="knowledge-button knowledge-primary" :disabled="saving || !editor.input.title.trim() || !editor.input.body.trim()"><LoaderCircle v-if="saving" :size="14" class="knowledge-spin" aria-hidden="true" />{{ saving ? 'Saving…' : 'Save memory' }}</button></div>
              <button v-if="editor.record" type="button" class="knowledge-text-button memory-archive-action" :disabled="saving" @click="archive"><Archive :size="14" aria-hidden="true" />{{ editor.record.archived ? 'Restore this memory' : 'Archive this memory' }}</button>
            </form>
            <p v-if="editError" class="knowledge-inline-error" role="alert">{{ editError }}</p>
          </aside>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { Archive, ArrowUpRight, BookOpen, ChevronDown, CircleCheck, Flag, History, Layers3, Link2, LoaderCircle, MessageSquare, Pencil, Plus, RefreshCw, Search, Shield, Type, Users, X } from '@lucide/vue';
import { MEMORY_CATEGORIES, type KnowledgeInput, type KnowledgePage, type KnowledgeRecord, type MemoryCategory } from '../../../../../../../shared/room-knowledge.mjs';
import { desktopBridgeUpgradeMessage, desktopIpc } from '../../../ipc/index.js';
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
const editorHeading = ref<HTMLElement | null>(null);
const addMemoryButton = ref<HTMLButtonElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
let editorTrigger: HTMLElement | null = null;
const categoryIcons = { goal: Flag, decision: CircleCheck, constraint: Shield, term: Type, reference: Link2 };
const starters: { kind: MemoryCategory; title: string; description: string }[] = [
  { kind: 'goal', title: 'Set a goal', description: 'What are we working toward?' },
  { kind: 'decision', title: 'Record a decision', description: 'What did we choose, and why?' },
  { kind: 'constraint', title: 'Add a constraint', description: 'What should every agent respect?' },
];
const visibleCount = computed(() => page.value.records.filter(record => record.archived === showArchived.value).length);
function categoryCount(kind: MemoryCategory) { return page.value.records.filter(record => record.archived === showArchived.value && record.category === kind).length; }
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
watch(() => props.roomIdentifier, () => { editor.value = null; page.value = { records: [], truncated: false }; notice.value = ''; historyEpoch++; void refresh(); }, { immediate: true });
onBeforeUnmount(() => { epoch++; historyEpoch++; });
function startNew(kind: MemoryCategory = 'decision') { if (saving.value) return; editorTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null; historyEpoch++; historyMode.value = false; editError.value = ''; editor.value = { record: null, clientId: crypto.randomUUID(), input: { category: kind, title: '', body: '', source_url: '', source_message_id: '' } }; void nextTick(() => editorHeading.value?.focus()); }
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
    if (roomId === props.roomIdentifier) { editor.value = null; notice.value = archived === true ? 'Memory archived. Its history is preserved.' : 'Memory saved for the room.'; await refresh(); completed = true; }
  } catch (cause) { if (roomId === props.roomIdentifier) editError.value = cause instanceof Error ? cause.message : 'Unable to save memory.'; }
  finally { saving.value = false; if (completed && roomId === props.roomIdentifier) restoreEditorFocus(true); }
}
function archive() { if (editor.value?.record) void save(!editor.value.record.archived); }
async function openSource(url: string) { try { await desktopIpc.app.openExternalUrl(url); } catch (cause) { error.value = String(cause); } }
</script>
