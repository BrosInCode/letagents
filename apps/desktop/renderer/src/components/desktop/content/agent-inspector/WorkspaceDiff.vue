<template>
<section class="workspace-diff" aria-label="Changed files and code">
          <div v-if="snapshot.state !== 'ready'" class="workspace-empty"><FileDiff :size="28" aria-hidden="true" /><h3>{{ snapshot.state === 'not_git' ? 'No Git workspace' : 'Changes could not be captured' }}</h3><p>{{ snapshot.state === 'not_git' ? 'This agent’s workspace is not a Git repository.' : 'The workspace was unavailable at the end of this turn. Its changes may still be present.' }}</p></div>
          <div v-else-if="!(snapshot.files.length + snapshot.hidden_files)" class="workspace-empty"><Check :size="28" aria-hidden="true" /><h3>No changes to review</h3><p>No file changes were recorded for this view.</p></div>
          <div v-else class="workspace-review-layout">
            <div class="workspace-file-sidebar"><nav ref="fileNav" class="workspace-file-nav" aria-label="Changed files">
              <div class="workspace-files-heading">Files <span>{{ snapshot.files.length }}</span></div>
              <button v-for="file in visibleFiles" :key="file.path" type="button" class="workspace-file-button" :aria-current="selectedPath === file.path ? 'true' : undefined" :title="file.previous_path ? `${file.previous_path} → ${file.path}` : file.path" @click="selectedPath = file.path">
                <span class="workspace-file-status" :data-status="file.status" :aria-label="fileStatus(file.status)">{{ statusLetter(file.status) }}</span>
                <span class="workspace-file-name"><strong>{{ basename(file.path) }}</strong><small v-if="dirname(file.path)">{{ dirname(file.path) }}</small></span>
                <span v-if="!file.binary" class="workspace-file-counts"><span class="workspace-added">+{{ file.additions }}</span><span class="workspace-deleted">−{{ file.deletions }}</span></span>
              </button>
              <p v-if="snapshot.hidden_files" class="workspace-hidden-note">{{ snapshot.hidden_files }} more files omitted</p>
            </nav>
            <nav v-if="snapshot.files.length > 100" class="workspace-file-pages" aria-label="File pages">
              <button type="button" :disabled="fileOffset === 0" aria-label="Previous files" @click="fileOffset -= 100">←</button>
              <span>{{ fileOffset + 1 }}–{{ Math.min(fileOffset + 100, snapshot.files.length) }} of {{ snapshot.files.length.toLocaleString() }}</span>
              <button type="button" :disabled="fileOffset + 100 >= snapshot.files.length" aria-label="Next files" @click="fileOffset += 100">→</button>
            </nav></div>
            <section v-if="selectedFile" class="workspace-file-review" :aria-label="selectedFile.path">
              <header class="workspace-file-toolbar"><FileCode :size="15" aria-hidden="true" /><span :title="selectedFile.path">{{ selectedFile.path }}</span><small>{{ fileStatus(selectedFile.status) }}</small></header>
              <p v-if="selectedFile.previous_path" class="workspace-rename-note">Renamed from {{ selectedFile.previous_path }}</p>
              <div v-if="pageLoading || pageError" class="workspace-page-status" role="status"><span>{{ pageError ? 'Couldn’t load these lines.' : 'Loading lines…' }}</span><button v-if="pageError" type="button" @click="retryPage++">Try again</button></div>
              <div v-if="longLine !== null" class="workspace-long-line-heading"><button type="button" ref="backToDiff" @click="leaveLongLine">← Back to diff</button><span v-if="page">Long line · characters {{ (page?.lines[0]?.textOffset ?? 0) + 1 }}–{{ (page?.lines[0]?.textOffset ?? 0) + (page?.lines[0]?.text.length ?? 0) }}</span></div>
              <div v-if="diffLines.length" :key="`${selectedPath}:${lineOffset}:${longLine}:${textOffset}`" ref="codeScroll" class="workspace-code-scroll" tabindex="0" aria-label="Code diff">
                <pre class="workspace-patch"><code><span v-for="(line, index) in visibleLines" :key="index" class="workspace-diff-line" :data-kind="line.kind"><span class="workspace-line-number" aria-hidden="true">{{ line.before }}</span><span class="workspace-line-number" aria-hidden="true">{{ line.after }}</span><span class="workspace-line-sign">{{ line.kind === 'added' ? '+' : line.kind === 'deleted' ? '−' : ' ' }}</span><span class="workspace-line-content">{{ line.text || ' ' }}<button v-if="longLine === null && line.nextTextOffset !== null" type="button" class="workspace-long-line" :data-line-offset="lineOffset + index" @click="openLongLine(lineOffset + index)">Read full line ({{ line.textLength.toLocaleString() }} characters)</button></span></span></code></pre>

              </div>
              <div v-else-if="!pageLoading && !pageError" class="workspace-empty workspace-file-empty"><FileCode :size="26" aria-hidden="true" /><h3>{{ selectedFile.binary ? 'Binary file changed' : page?.included ? 'No text changes' : 'Diff not included' }}</h3><p>{{ selectedFile.binary ? 'A text preview is not available for this file.' : page?.included ? 'Only the file name, permissions, or other file metadata changed.' : 'This file is listed in the snapshot, but its code diff was not captured.' }}</p></div>
              <nav v-if="longLine !== null" class="workspace-line-pages" aria-label="Long line parts">
                <button type="button" :disabled="textOffset === 0 || pageLoading" @click="textOffset = textHistory.pop() ?? 0">Previous part</button>
                <span>Full captured text</span>
                <button type="button" :disabled="page?.lines[0]?.nextTextOffset == null || pageLoading" @click="textHistory.push(textOffset); textOffset = page!.lines[0].nextTextOffset!">Next part</button>
              </nav>
              <nav v-else-if="lineOffset || page?.nextOffset != null" class="workspace-line-pages" aria-label="Diff pages">
                <button type="button" :disabled="!lineOffset || pageLoading" @click="lineOffset = pageHistory.pop() ?? 0">Previous lines</button>
                <span aria-live="polite">{{ pageLoading ? 'Loading…' : `${lineOffset + 1}–${lineOffset + diffLines.length}` }}</span>
                <button type="button" :disabled="page?.nextOffset == null || pageLoading" @click="pageHistory.push(lineOffset); lineOffset = page!.nextOffset!">Next lines</button>
              </nav>
            </section>
          </div>
          <footer class="workspace-review-footer"><span v-if="snapshot.patch_truncated || snapshot.hidden_files" class="workspace-partial"><Info :size="13" aria-hidden="true" />Partial snapshot · some content or line counts omitted</span><span v-else>Snapshot after the agent’s turn</span></footer>
</section>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { Check, FileCode, FileDiff, Info } from '@lucide/vue';
import type { WorkspaceChangeSummary } from '../../../../../../../../shared/workspace-change-summary.mjs';
import { createWorkspaceDiffIndex, readWorkspaceDiffPage, type WorkspaceDiffPage, type WorkspaceDiffPageOptions } from '../../../../domain/workspace-diff';
const props = defineProps<{ snapshot: WorkspaceChangeSummary; viewKey?: string; loadPage?: (path: string, options: WorkspaceDiffPageOptions) => Promise<WorkspaceDiffPage> }>();
const selectedPath = ref('');
const fileOffset = ref(0);
const fileNav = ref<HTMLElement | null>(null);
watch(fileOffset, () => { fileNav.value?.scrollTo({ top: 0, left: 0 }); }, { flush: 'post' });
const visibleFiles = computed(() => props.snapshot.files.slice(fileOffset.value, fileOffset.value + 100));
watch(() => props.snapshot, value => {
  if (!value.files.some(file => file.path === selectedPath.value)) selectedPath.value = value.files[0]?.path ?? '';
  fileOffset.value = Math.floor(Math.max(0, value.files.findIndex(file => file.path === selectedPath.value)) / 100) * 100;
}, { immediate: true });
const selectedFile = computed(() => props.snapshot.files.find(file => file.path === selectedPath.value));
const lineOffset = ref(0), longLine = ref<number | null>(null), textOffset = ref(0);
const pageHistory = ref<number[]>([]), textHistory = ref<number[]>([]);
const backToDiff = ref<HTMLButtonElement | null>(null), codeScroll = ref<HTMLElement | null>(null);
let returnFocus: number | null = null, returnSource: Element | null = null;
function cancelReturnFocus() { returnFocus = null; document.removeEventListener('focusin', cancelReturnFocus); }
async function openLongLine(offset: number) {
  cancelReturnFocus(); const source = document.activeElement;
  longLine.value = offset; textOffset.value = 0; textHistory.value = [];
  await nextTick();
  if (document.activeElement === document.body || document.activeElement === source) backToDiff.value?.focus();
}
function leaveLongLine() {
  cancelReturnFocus(); returnFocus = longLine.value; returnSource = document.activeElement;
  document.addEventListener('focusin', cancelReturnFocus, { once: true });
  longLine.value = null; textOffset.value = 0;
}
onBeforeUnmount(cancelReturnFocus);
const index = computed(() => props.loadPage ? null : createWorkspaceDiffIndex(props.snapshot.patch, props.snapshot.files));
const page = shallowRef<WorkspaceDiffPage | null>(null);
watch(page, value => {
  if (!value || returnFocus === null) return;
  const target = codeScroll.value?.querySelector<HTMLButtonElement>(`[data-line-offset="${returnFocus}"]`);
  const restore = document.activeElement === document.body || document.activeElement === returnSource;
  cancelReturnFocus();
  if (restore) target?.focus();
}, { flush: 'post' });
const pageLoading = ref(false), pageError = ref(false), retryPage = ref(0);
watch([selectedPath, () => props.viewKey, () => props.snapshot.captured_at, () => props.snapshot.base_revision], () => {
  cancelReturnFocus(); lineOffset.value = 0; longLine.value = null; textOffset.value = 0; pageHistory.value = []; textHistory.value = [];
}, { flush: 'sync' });
watch([selectedPath, lineOffset, longLine, textOffset, retryPage, () => props.viewKey, () => props.snapshot, () => props.loadPage], async (_, __, onCleanup) => {
  let cancelled = false; onCleanup(() => { cancelled = true; });
  page.value = null; pageError.value = false; pageLoading.value = Boolean(props.loadPage);
  if (!selectedFile.value) { pageLoading.value = false; return; }
  const options = { offset: longLine.value ?? lineOffset.value, textOffset: textOffset.value, singleLine: longLine.value !== null };
  try {
    const result = props.loadPage ? await props.loadPage(selectedPath.value, options) : readWorkspaceDiffPage(index.value!, selectedPath.value, options);
    if (!cancelled) page.value = result;
  } catch { if (!cancelled) pageError.value = true; }
  finally { if (!cancelled) pageLoading.value = false; }
}, { immediate: true });
const diffLines = computed(() => page.value?.lines ?? []);
const visibleLines = diffLines;
const basename = (path: string) => path.split('/').at(-1);
const dirname = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const fileStatus = (status: string) => ({ untracked: 'New file', added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed', copied: 'Copied', typechange: 'Type changed', unknown: 'Changed' }[status] ?? 'Changed');
const statusLetter = (status: string) => status === 'untracked' ? 'A' : status === 'unknown' ? '·' : status[0].toUpperCase();
</script>
<style>
.workspace-review-layout { display: grid; grid-template-columns: 250px minmax(0, 1fr); flex: 1; min-height: 0; }
.workspace-file-nav { overflow: auto; padding: 14px 8px; background: var(--bg-card); border-right: 1px solid var(--border); scrollbar-width: thin; }
.workspace-files-heading { display: flex; justify-content: space-between; align-items: center; margin: 0 10px 10px; font-size: 11px; color: var(--text-secondary); }
.workspace-files-heading span { font-variant-numeric: tabular-nums; }
.workspace-file-button { display: flex; align-items: center; gap: 9px; padding: 10px; width: 100%; border: 1px solid transparent; border-radius: 7px; color: var(--text); background: transparent; text-align: left; cursor: pointer; }
.workspace-file-button + .workspace-file-button { margin-top: 2px; }
.workspace-file-button[aria-current='true'] { background: var(--accent-active); border-color: var(--border); }
.workspace-file-status { width: 14px; flex-shrink: 0; color: var(--text-secondary); font: 10px ui-monospace, monospace; text-align: center; }
.workspace-file-status[data-status='added'], .workspace-file-status[data-status='untracked'] { color: var(--workspace-positive); }
.workspace-file-status[data-status='deleted'] { color: var(--workspace-negative); }
.workspace-file-name { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
.workspace-file-name strong { font-size: 12px; font-weight: 500; }
.workspace-file-name small { font-size: 10px; color: var(--text-secondary); }
.workspace-file-name strong, .workspace-file-name small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-file-counts { display: flex; gap: 5px; font-size: 10px; font-variant-numeric: tabular-nums; }
.workspace-file-review { min-height: 0; display: flex; flex-direction: column; min-width: 0; }
.workspace-file-toolbar { display: flex; align-items: center; gap: 9px; padding: 15px 20px; min-height: 49px; border-bottom: 1px solid var(--border); font-size: 12px; }
.workspace-file-toolbar svg { color: var(--text-secondary); flex-shrink: 0; }
.workspace-file-toolbar > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, 'SFMono-Regular', monospace; font-size: 11px; }
.workspace-file-toolbar small { color: var(--text-secondary); font-size: 10px; }
.workspace-code-scroll { overflow: auto; flex: 1; min-height: 0; padding-block: 12px 24px; scrollbar-width: thin; }
.workspace-patch { margin: 0; font: 12px/22px ui-monospace, 'SFMono-Regular', Menlo, monospace; tab-size: 4; }
.workspace-patch code { display: block; min-width: max-content; }
.workspace-diff-line { display: flex; width: 100%; min-height: 22px; white-space: pre; }
.workspace-line-number { flex: 0 0 38px; width: 38px; padding-right: 9px; text-align: right; color: var(--text-secondary); opacity: .7; user-select: none; font-size: 10px; }
.workspace-line-sign { flex: 0 0 22px; text-align: center; user-select: none; }
.workspace-line-content { flex: 1; padding-right: 24px; }
.workspace-diff-line[data-kind='added'] { background: light-dark(#edf8ef, #15251b); }
.workspace-diff-line[data-kind='deleted'] { background: light-dark(#fceef0, #301c20); }
.workspace-diff-line[data-kind='added'] .workspace-line-sign { color: var(--workspace-positive); }
.workspace-diff-line[data-kind='deleted'] .workspace-line-sign { color: var(--workspace-negative); }
.workspace-diff-line[data-kind='hunk'] { color: var(--text-secondary); background: var(--bg-card); margin-bottom: 4px; font-size: 10px; }
.workspace-diff-line[data-kind='hunk']:not(:first-child) { margin-top: 12px; }
.workspace-diff-line[data-kind='metadata'] { color: var(--text-secondary); font-style: italic; }
.workspace-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px; color: var(--text-secondary); text-align: center; }
.workspace-empty h3 { margin: 16px 0 7px; color: var(--text); font-size: 14px; font-weight: 550; }
.workspace-empty p { margin: 0; max-width: 330px; font-size: 12px; line-height: 1.7; text-wrap: pretty; }
.workspace-rename-note, .workspace-hidden-note { padding: 8px 12px; margin: 0; color: var(--text-secondary); font-size: 11px; overflow-wrap: anywhere; }
.workspace-review-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 20px; border-top: 1px solid var(--border); font-size: 10px; color: var(--text-secondary); }
.workspace-partial, .workspace-escape-hint { display: inline-flex; align-items: center; gap: 6px; }
.workspace-partial svg { flex-shrink: 0; }
.workspace-escape-hint kbd { font: inherit; padding: 1px 4px; border: 1px solid var(--border); border-radius: 4px; }

.workspace-diff { --workspace-positive: light-dark(#167544, #88d9a2); --workspace-negative: light-dark(#bd3548, #ef9ba5); display: flex; flex-direction: column; min-height: 320px; flex: 1; overflow: hidden; border: 1px solid var(--border); border-radius: 12px; }
.workspace-diff .workspace-review-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(220px, 1fr); min-height: 0; }
.workspace-diff .workspace-file-nav { display: flex; gap: 4px; max-height: 110px; padding: 8px; border-right: 0; border-bottom: 1px solid var(--border); overflow: auto; }
.workspace-diff .workspace-files-heading { display: none; }
.workspace-diff .workspace-file-button { flex: 0 0 175px; margin: 0; }
.workspace-diff .workspace-file-counts { display: none; }
.workspace-diff .workspace-file-toolbar { padding: 12px; }
.workspace-diff .workspace-added { color: var(--workspace-positive); }
.workspace-diff .workspace-deleted { color: var(--workspace-negative); }
.workspace-file-button:focus-visible, .workspace-code-scroll:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
@media (hover: hover) { .workspace-file-button:hover { background: var(--accent-hover); } }

.workspace-diff { container-type: inline-size; }
@container (min-width: 560px) {
  .workspace-diff .workspace-review-layout { grid-template-columns: 190px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
  .workspace-diff .workspace-file-nav { display: block; max-height: none; border-right: 1px solid var(--border); border-bottom: 0; }
  .workspace-diff .workspace-file-button { width: 100%; margin-bottom: 4px; }
  .workspace-diff .workspace-files-heading { display: flex; }
}

.workspace-line-pages { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); font-size: 11px; color: var(--text-secondary); }
.workspace-line-pages button { padding: 6px; background: none; border: 0; color: var(--text); font: inherit; cursor: pointer; }
.workspace-line-pages button:disabled { opacity: .4; cursor: default; }
.workspace-line-pages button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.workspace-file-sidebar { display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; }
.workspace-file-sidebar .workspace-file-nav { flex: 1; min-height: 0; }
.workspace-file-pages { display: flex; align-items: center; justify-content: space-between; gap: 4px; padding: 6px 8px; border-top: 1px solid var(--border); font-size: 10px; color: var(--text-secondary); }
.workspace-file-pages button, .workspace-page-status button, .workspace-long-line-heading button { background: none; border: 0; padding: 6px; color: var(--text); cursor: pointer; font: inherit; }
.workspace-file-pages button:disabled { opacity: .4; cursor: default; }
.workspace-file-pages button:focus-visible, .workspace-long-line:focus-visible, .workspace-long-line-heading button:focus-visible, .workspace-page-status button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.workspace-page-status, .workspace-long-line-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; color: var(--text-secondary); font-size: 11px; }
.workspace-long-line { display: block; margin: 6px 0; border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; color: var(--text); background: var(--bg-card); font: 11px/1.5 system-ui; cursor: pointer; }
</style>
