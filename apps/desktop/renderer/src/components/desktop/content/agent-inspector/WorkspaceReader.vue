<template>
  <Teleport to="body">
    <DesktopDialogShell :open="open" aria-label="Full workspace code reader" backdrop-class="workspace-reader-backdrop" panel-class="workspace-reader-dialog" :show-close="false" initial-focus=".workspace-reader-close" @close="emit('close')">
      <header class="workspace-reader-header">
        <div class="workspace-reader-title"><FolderCode :size="20" aria-hidden="true" /><div><h2>Full workspace</h2><p>Changes since workspace started</p></div></div>
        <div class="workspace-reader-context"><GitBranch :size="13" aria-hidden="true" /><span>{{ snapshot.branch || 'Workspace' }}</span><time :datetime="snapshot.captured_at">{{ formatShortDateTime(snapshot.captured_at) }}</time></div>
        <button type="button" class="workspace-reader-close" aria-label="Close workspace reader" @click="emit('close')"><X :size="18" aria-hidden="true" /></button>
      </header>
      <div v-if="reviewMessage" class="workspace-reader-notice" role="status"><span>{{ reviewMessage }}</span><button v-if="canRetry" type="button" @click="emit('retry')">Try again</button></div>
      <WorkspaceDiff reader :snapshot="snapshot" :view-key="viewKey" :load-page="loadPage" @escape="emit('close')" />
    </DesktopDialogShell>
  </Teleport>
</template>
<script setup lang="ts">
import { FolderCode, GitBranch, X } from '@lucide/vue';
import type { WorkspaceChangeSummary } from '../../../../../../../../shared/workspace-change-summary.mjs';
import type { WorkspaceDiffPage, WorkspaceDiffPageOptions } from '../../../../domain/workspace-diff';
import { formatShortDateTime } from '../../../../domain/time';
import DesktopDialogShell from '../DesktopDialogShell.vue';
import WorkspaceDiff from './WorkspaceDiff.vue';
defineProps<{ open: boolean; snapshot: WorkspaceChangeSummary; viewKey: string; reviewMessage: string; canRetry: boolean; loadPage?: (path: string, options: WorkspaceDiffPageOptions) => Promise<WorkspaceDiffPage> }>();
const emit = defineEmits<{ close: []; retry: [] }>();
</script>
<style>
.workspace-reader-backdrop { position: fixed; inset: 0; z-index: 1300; display: grid; place-items: center; padding: 32px 24px; background: var(--overlay-scrim); }
.workspace-reader-dialog { display: flex; flex-direction: column; width: min(1440px, 100%); height: 100%; min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--border-strong); border-radius: 16px; background: var(--bg); color: var(--text); box-shadow: var(--shadow-xl); outline: none; }
.workspace-reader-header { display: flex; align-items: center; gap: 24px; padding: 20px 24px; border-bottom: 1px solid var(--border); }
.workspace-reader-title { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; }
.workspace-reader-title > svg { color: var(--text-secondary); flex-shrink: 0; }
.workspace-reader-title h2 { margin: 0; font-size: 16px; letter-spacing: -.02em; font-weight: 600; }
.workspace-reader-title p { margin: 5px 0 0; color: var(--text-secondary); font-size: 12px; }
.workspace-reader-context { display: flex; align-items: center; gap: 7px; color: var(--text-secondary); font-size: 11px; min-width: 0; max-width: 45%; }
.workspace-reader-context span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-reader-context svg, .workspace-reader-context time { flex-shrink: 0; }
.workspace-reader-context time { padding-left: 12px; }
.workspace-reader-close { display: grid; place-items: center; flex-shrink: 0; width: 36px; height: 36px; border-radius: 8px; background: var(--accent-dim); color: var(--text-secondary); cursor: pointer; }
.workspace-reader-close:hover { color: var(--text); background: var(--accent-hover); }
.workspace-reader-close:focus-visible, .workspace-reader-notice button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.workspace-reader-dialog > .workspace-diff { min-height: 0; border: 0; border-radius: 0; }
.workspace-reader-notice { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 24px; background: var(--bg-card); color: var(--text-secondary); font-size: 12px; }
.workspace-reader-notice button { background: transparent; color: var(--text); font: inherit; cursor: pointer; }
@media (max-width: 600px) {
  .workspace-reader-backdrop { padding: 0; }
  .workspace-reader-dialog { border: 0; border-radius: 0; }
  .workspace-reader-header { gap: 10px; padding: 16px; }
  .workspace-reader-context { display: none; }
}
</style>
