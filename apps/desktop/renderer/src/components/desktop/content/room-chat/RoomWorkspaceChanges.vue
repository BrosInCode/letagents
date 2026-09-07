<template>
  <section v-if="latest.length" class="room-workspace-changes" aria-label="Agent workspace changes">
    <div class="workspace-strip-heading"><span>Workspace changes</span><span v-if="status !== 'ready'">Updates unavailable · saved snapshots</span><span v-else-if="truncated">Showing recent snapshots</span></div>
    <button v-for="entry in latest" :key="entry.agentKey" type="button" class="workspace-card" aria-haspopup="dialog" @click="openReview(entry)">
      <span class="workspace-card-icon"><FileDiff :size="17" aria-hidden="true" /></span>
      <span class="workspace-card-identity"><strong>{{ agentLabel(entry.agentKey) }}</strong><span>{{ workspace(entry)?.branch || 'Workspace' }}</span></span>
      <span v-if="workspace(entry)?.state === 'ready'" class="workspace-card-summary">
        <span>{{ fileCount(entry) }} {{ fileCount(entry) === 1 ? 'file' : 'files' }}</span>
        <span v-if="fileCount(entry)" class="workspace-stats"><b class="workspace-added">+{{ workspace(entry)!.additions }}</b><b class="workspace-deleted">−{{ workspace(entry)!.deletions }}</b></span>
      </span>
      <span v-else class="workspace-card-summary">Unavailable</span>
      <time :datetime="workspace(entry)?.captured_at" :title="formatFullTimestamp(workspace(entry)?.captured_at)">{{ formatShortDateTime(workspace(entry)?.captured_at) }}</time>
      <span class="workspace-review-action">Review <ChevronRight :size="14" aria-hidden="true" /></span>
    </button>
    <Teleport to="body">
      <DesktopDialogShell :open="Boolean(selected)" aria-label="Workspace changes" panel-class="workspace-review-dialog" backdrop-class="desktop-task-modal-backdrop workspace-review-backdrop" close-class="workspace-review-close" @close="selected = null">
        <template v-if="selected && selectedWorkspace">
          <header class="workspace-review-header">
            <div class="workspace-review-title"><span class="workspace-agent-mark" aria-hidden="true">{{ agentLabel(selected.agentKey).slice(0, 1).toUpperCase() }}</span><div><h2>{{ agentLabel(selected.agentKey) }}<span>Workspace changes</span></h2><p><GitBranch :size="13" aria-hidden="true" /><span>{{ selectedWorkspace.branch || 'Detached workspace' }}</span></p></div></div>
            <div class="workspace-review-totals" v-if="selectedWorkspace.state === 'ready'"><span>{{ fileCount(selected) }} {{ fileCount(selected) === 1 ? 'file' : 'files' }} changed</span><span class="workspace-stats"><b class="workspace-added">+{{ selectedWorkspace.additions }}</b><b class="workspace-deleted">−{{ selectedWorkspace.deletions }}</b></span></div>
          </header>
          <div class="workspace-review-context"><span>Since workspace started <span class="workspace-context-detail">· includes committed changes</span></span><time :datetime="selectedWorkspace.captured_at" :title="formatFullTimestamp(selectedWorkspace.captured_at)">Captured {{ formatShortDateTime(selectedWorkspace.captured_at) }}</time></div>
          <div v-if="selectedWorkspace.state !== 'ready'" class="workspace-empty"><FileDiff :size="28" aria-hidden="true" /><h3>{{ selectedWorkspace.state === 'not_git' ? 'No Git workspace' : 'Changes could not be captured' }}</h3><p>{{ selectedWorkspace.state === 'not_git' ? 'This agent’s workspace is not a Git repository.' : 'The workspace was unavailable at the end of this turn. Its changes may still be present.' }}</p></div>
          <div v-else-if="!fileCount(selected)" class="workspace-empty"><Check :size="28" aria-hidden="true" /><h3>No changes to review</h3><p>This workspace matches its starting revision.</p></div>
          <div v-else class="workspace-review-layout">
            <nav class="workspace-file-nav" aria-label="Changed files">
              <div class="workspace-files-heading">Files <span>{{ selectedWorkspace.files.length }}</span></div>
              <button v-for="file in selectedWorkspace.files" :key="file.path" type="button" class="workspace-file-button" :aria-current="selectedPath === file.path ? 'true' : undefined" :title="file.previous_path ? `${file.previous_path} → ${file.path}` : file.path" @click="selectedPath = file.path">
                <span class="workspace-file-status" :data-status="file.status" :aria-label="fileStatus(file.status)">{{ statusLetter(file.status) }}</span>
                <span class="workspace-file-name"><strong>{{ basename(file.path) }}</strong><small v-if="dirname(file.path)">{{ dirname(file.path) }}</small></span>
                <span v-if="!file.binary" class="workspace-file-counts"><span class="workspace-added">+{{ file.additions }}</span><span class="workspace-deleted">−{{ file.deletions }}</span></span>
              </button>
              <p v-if="selectedWorkspace.hidden_files" class="workspace-hidden-note">{{ selectedWorkspace.hidden_files }} more files omitted</p>
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
          <footer class="workspace-review-footer"><span v-if="selectedWorkspace.patch_truncated || selectedWorkspace.hidden_files" class="workspace-partial"><Info :size="13" aria-hidden="true" />Partial snapshot · some content or line counts omitted</span><span v-else>Snapshot after the agent’s turn</span><span class="workspace-escape-hint"><kbd>esc</kbd> Close</span></footer>
        </template>
      </DesktopDialogShell>
    </Teleport>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Check, ChevronRight, FileCode, FileDiff, GitBranch, Info } from '@lucide/vue';
import type { DesktopRoomAgentWork, DesktopParticipantSummary } from '../../../../../../electron/ipc-types';
import { formatFullTimestamp, formatShortDateTime } from '../../../../domain/time';
import { workspaceFilePatches } from '../../../../domain/workspace-diff';
import DesktopDialogShell from '../DesktopDialogShell.vue';
const props = defineProps<{ work: DesktopRoomAgentWork[]; participants: DesktopParticipantSummary[]; status: string; truncated?: boolean; roomIdentifier: string | null }>();
const selected = ref<DesktopRoomAgentWork | null>(null);
const selectedPath = ref('');
const workspace = (entry: DesktopRoomAgentWork) => 'workspace' in entry.summary ? entry.summary.workspace : undefined;
const fileCount = (entry: DesktopRoomAgentWork) => (workspace(entry)?.files.length ?? 0) + (workspace(entry)?.hidden_files ?? 0);
const latest = computed(() => {
  const byAgent = new Map<string, DesktopRoomAgentWork>();
  for (const entry of props.work) {
    const snapshot = workspace(entry);
    if (!snapshot) continue;
    const previous = byAgent.get(entry.agentKey);
    if (!previous || Date.parse(snapshot.captured_at) > Date.parse(workspace(previous)!.captured_at)) byAgent.set(entry.agentKey, entry);
  }
  return [...byAgent.values()].sort((a, b) => a.agentKey.localeCompare(b.agentKey));
});
const selectedWorkspace = computed(() => selected.value ? workspace(selected.value) : undefined);
const selectedFile = computed(() => selectedWorkspace.value?.files.find(file => file.path === selectedPath.value));
const patches = computed(() => workspaceFilePatches(selectedWorkspace.value?.patch ?? '', selectedWorkspace.value?.files ?? []));
const diffLines = computed(() => patches.value.get(selectedPath.value) ?? []);
const agentLabel = (key: string) => props.participants.find(participant => participant.agentKey === key)?.displayName || key.split('/').at(-1) || key;
const basename = (path: string) => path.split('/').at(-1);
const dirname = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const fileStatus = (status: string) => ({ untracked: 'New file', added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed', copied: 'Copied', typechange: 'Type changed', unknown: 'Changed' }[status] ?? 'Changed');
const statusLetter = (status: string) => status === 'untracked' ? 'A' : status === 'unknown' ? '·' : status[0].toUpperCase();
function openReview(entry: DesktopRoomAgentWork) { selected.value = entry; selectedPath.value = workspace(entry)?.files[0]?.path ?? ''; }
watch(() => props.roomIdentifier, () => { selected.value = null; });
watch(() => props.work, work => {
  if (selected.value && !work.some(entry => entry.attemptId === selected.value?.attemptId && workspace(entry))) selected.value = null;
});
// Freeze the selected snapshot while newer turns arrive so code never moves under the reader.
</script>
<style>
.room-workspace-changes, .workspace-review-dialog { --workspace-positive: light-dark(#167544, #88d9a2); --workspace-negative: light-dark(#bd3548, #ef9ba5); }
.room-workspace-changes { flex: 0 0 auto; max-height: 184px; overflow: auto; margin: 0 16px 10px; scrollbar-width: thin; }
.workspace-strip-heading { display: flex; justify-content: space-between; gap: 12px; margin: 0 2px 7px; color: var(--text-secondary); font-size: 11px; line-height: 16px; }
.workspace-card { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 58px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-card); color: var(--text); cursor: pointer; font-size: 12px; text-align: left; transition: background-color 140ms ease, border-color 140ms ease; }
.workspace-card + .workspace-card { margin-top: 5px; }
.workspace-card-icon { display: grid; place-items: center; width: 30px; height: 32px; flex: 0 0 auto; color: var(--text-secondary); }
.workspace-card-identity { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 3px; }
.workspace-card-identity strong { font-size: 12px; font-weight: 600; }
.workspace-card-identity > span { color: var(--text-secondary); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-card-summary { display: flex; align-items: center; gap: 12px; white-space: nowrap; }
.workspace-stats { display: inline-flex; gap: 7px; font-variant-numeric: tabular-nums; }
.workspace-stats b { font-weight: 550; }
.workspace-added { color: var(--workspace-positive); }
.workspace-deleted { color: var(--workspace-negative); }
.workspace-card time { color: var(--text-secondary); font-size: 11px; white-space: nowrap; margin-left: 8px; }
.workspace-review-action { display: inline-flex; align-items: center; gap: 3px; padding-left: 12px; margin-left: 4px; border-left: 1px solid var(--border); font-weight: 550; }
.workspace-review-dialog { position: relative; display: flex; flex-direction: column; width: min(1160px, calc(100vw - 64px)); height: min(760px, calc(100dvh - 80px)); border: 1px solid var(--border-strong); border-radius: 16px; background: var(--bg); color: var(--text); overflow: hidden; box-shadow: 0 32px 100px #0006, 0 0 0 1px #0001; font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif); }
.workspace-review-close { position: absolute; top: 20px; right: 20px; z-index: 1; display: grid; place-items: center; width: 30px; height: 30px; padding: 7px; border: 0; border-radius: 7px; background: transparent; color: var(--text-secondary); cursor: pointer; transition: background-color 120ms ease, color 120ms ease; }
.workspace-review-close svg { width: 15px; height: 15px; }
.workspace-review-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 22px 68px 20px 24px; }
.workspace-review-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
.workspace-agent-mark { display: grid; place-items: center; width: 38px; height: 38px; flex-shrink: 0; border-radius: 11px; border: 1px solid var(--border); background: var(--bg-card); font-size: 18px; font-weight: 550; color: var(--text-secondary); }
.workspace-review-title > div { min-width: 0; }
.workspace-review-title h2 { display: flex; flex-wrap: wrap; column-gap: 10px; row-gap: 3px; margin: 0; font-size: 14px; font-weight: 600; line-height: 20px; letter-spacing: -.015em; }
.workspace-review-title h2 > span { color: var(--text-secondary); font-weight: 400; }
.workspace-review-title p { display: flex; align-items: center; gap: 5px; margin: 5px 0 0; font-size: 11px; color: var(--text-secondary); }
.workspace-review-title p span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-review-title p svg { flex-shrink: 0; }
.workspace-review-totals { display: flex; align-items: center; gap: 14px; font-size: 12px; white-space: nowrap; }
.workspace-review-totals > span:first-child { color: var(--text-secondary); }
.workspace-review-context { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 24px; border-block: 1px solid var(--border); font-size: 11px; color: var(--text-secondary); }
.workspace-review-context time { white-space: nowrap; }
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
.workspace-card:focus-visible, .workspace-file-button:focus-visible, .workspace-review-close:focus-visible, .workspace-code-scroll:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
.workspace-card:active, .workspace-review-close:active { background: var(--accent-active); }
@media (hover: hover) and (pointer: fine) {
  .workspace-card:hover { background: var(--bg-elevated); border-color: var(--border-strong); }
  .workspace-file-button:hover:not([aria-current='true']), .workspace-review-close:hover { background: var(--accent-hover); }
  .workspace-review-close:hover { color: var(--text); }
}
@media (max-width: 760px) {
  .workspace-review-dialog { width: calc(100vw - 24px); height: calc(100dvh - 32px); border-radius: 12px; }
  .workspace-review-layout { grid-template-columns: 190px minmax(0, 1fr); }
  .workspace-review-header { padding: 18px 52px 16px 18px; }
  .workspace-review-close { top: 16px; right: 12px; }
  .workspace-review-title h2 { flex-direction: column; }
  .workspace-review-title h2 > span { font-size: 11px; }
  .workspace-context-detail, .workspace-card time, .workspace-review-totals > span:first-child { display: none; }
  .workspace-review-context { padding: 10px 18px; }
  .workspace-file-counts { display: none; }
}
@media (max-width: 640px) {
  .workspace-card { gap: 8px; padding-inline: 8px; }
  .workspace-card-icon { display: none; }
  .workspace-card-summary { gap: 6px; font-size: 11px; }
  .workspace-review-action { padding-left: 7px; font-size: 11px; }
  .workspace-review-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .workspace-file-nav { display: flex; gap: 4px; padding: 8px; border-right: 0; border-bottom: 1px solid var(--border); }
  .workspace-files-heading { display: none; }
  .workspace-file-button { flex: 0 0 170px; padding: 8px; }
  .workspace-file-button + .workspace-file-button { margin-top: 0; }
  .workspace-review-context { font-size: 10px; gap: 8px; }
  .workspace-review-footer { padding-inline: 12px; }
  .workspace-escape-hint { display: none; }
}
@media (prefers-reduced-motion: reduce) { .workspace-card, .workspace-review-close { transition: none; } }
</style>
