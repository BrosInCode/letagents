<template>
<section class="workspace-diff" aria-label="Changed files and code">
          <div v-if="snapshot.state !== 'ready'" class="workspace-empty"><FileDiff :size="28" aria-hidden="true" /><h3>{{ snapshot.state === 'not_git' ? 'No Git workspace' : 'Changes could not be captured' }}</h3><p>{{ snapshot.state === 'not_git' ? 'This agent’s workspace is not a Git repository.' : 'The workspace was unavailable at the end of this turn. Its changes may still be present.' }}</p></div>
          <div v-else-if="!(snapshot.files.length + snapshot.hidden_files)" class="workspace-empty"><Check :size="28" aria-hidden="true" /><h3>No changes to review</h3><p>No file changes were recorded for this view.</p></div>
          <div v-else class="workspace-review-layout">
            <nav class="workspace-file-nav" aria-label="Changed files">
              <div class="workspace-files-heading">Files <span>{{ snapshot.files.length }}</span></div>
              <button v-for="file in snapshot.files" :key="file.path" type="button" class="workspace-file-button" :aria-current="selectedPath === file.path ? 'true' : undefined" :title="file.previous_path ? `${file.previous_path} → ${file.path}` : file.path" @click="selectedPath = file.path">
                <span class="workspace-file-status" :data-status="file.status" :aria-label="fileStatus(file.status)">{{ statusLetter(file.status) }}</span>
                <span class="workspace-file-name"><strong>{{ basename(file.path) }}</strong><small v-if="dirname(file.path)">{{ dirname(file.path) }}</small></span>
                <span v-if="!file.binary" class="workspace-file-counts"><span class="workspace-added">+{{ file.additions }}</span><span class="workspace-deleted">−{{ file.deletions }}</span></span>
              </button>
              <p v-if="snapshot.hidden_files" class="workspace-hidden-note">{{ snapshot.hidden_files }} more files omitted</p>
            </nav>
            <section v-if="selectedFile" class="workspace-file-review" :aria-label="selectedFile.path">
              <header class="workspace-file-toolbar"><FileCode :size="15" aria-hidden="true" /><span :title="selectedFile.path">{{ selectedFile.path }}</span><small>{{ fileStatus(selectedFile.status) }}</small></header>
              <p v-if="selectedFile.previous_path" class="workspace-rename-note">Renamed from {{ selectedFile.previous_path }}</p>
              <div v-if="diffLines.length" :key="selectedPath" class="workspace-code-scroll" tabindex="0" aria-label="Code diff">
                <pre class="workspace-patch"><code><span v-for="(line, index) in diffLines" :key="index" class="workspace-diff-line" :data-kind="line.kind"><span class="workspace-line-number" aria-hidden="true">{{ line.before }}</span><span class="workspace-line-number" aria-hidden="true">{{ line.after }}</span><span class="workspace-line-sign">{{ line.kind === 'added' ? '+' : line.kind === 'deleted' ? '−' : ' ' }}</span><span class="workspace-line-content">{{ line.text || ' ' }}</span></span></code></pre>
              </div>
              <div v-else class="workspace-empty workspace-file-empty"><FileCode :size="26" aria-hidden="true" /><h3>{{ selectedFile.binary ? 'Binary file changed' : patches.has(selectedFile.path) ? 'No text changes' : 'Diff not included' }}</h3><p>{{ selectedFile.binary ? 'A text preview is not available for this file.' : patches.has(selectedFile.path) ? 'Only the file name, permissions, or other file metadata changed.' : 'This file is listed in the snapshot, but its code diff was not captured.' }}</p></div>
            </section>
          </div>
          <footer class="workspace-review-footer"><span v-if="snapshot.patch_truncated || snapshot.hidden_files" class="workspace-partial"><Info :size="13" aria-hidden="true" />Partial snapshot · some content or line counts omitted</span><span v-else>Snapshot after the agent’s turn</span></footer>
</section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Check, FileCode, FileDiff, Info } from '@lucide/vue';
import type { WorkspaceChangeSummary } from '../../../../../../../../shared/workspace-change-summary.mjs';
import { workspaceFilePatches } from '../../../../domain/workspace-diff';
const props = defineProps<{ snapshot: WorkspaceChangeSummary }>();
const selectedPath = ref('');
watch(() => props.snapshot, value => { selectedPath.value = value.files[0]?.path ?? ''; }, { immediate: true });
const selectedFile = computed(() => props.snapshot.files.find(file => file.path === selectedPath.value));
const patches = computed(() => workspaceFilePatches(props.snapshot.patch, props.snapshot.files));
const diffLines = computed(() => patches.value.get(selectedPath.value) ?? []);
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
</style>
