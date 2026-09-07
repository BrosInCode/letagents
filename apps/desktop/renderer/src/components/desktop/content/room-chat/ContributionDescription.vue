<template>
  <div class="contribution-description">
    <div v-if="summary" class="contribution-prose" v-html="formatted" />
    <ul v-if="files.length" class="contribution-files" aria-label="Changed files">
      <li v-for="file in files" :key="file.path">
        <span class="file-action">{{ action(file.status) }}</span>
        <button v-if="links[file.path]" type="button" :disabled="opening === file.path" :title="links[file.path] === 'local' ? 'Open in your default editor' : 'Open published file on GitHub'" @click="open(file.path)">
          <FileCode :size="13" aria-hidden="true" /><span>{{ filename(file.path) }}</span><ArrowUpRight :size="12" aria-hidden="true" />
        </button>
        <code v-else>{{ filename(file.path) }}</code>
      </li>
    </ul>
    <p v-if="remaining" class="remaining">{{ remaining }} more {{ remaining === 1 ? 'file' : 'files' }} in the diff</p>
    <p v-if="error" role="status" class="file-error">{{ error }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { FileCode, ArrowUpRight } from '@lucide/vue';
import type { DesktopRoomAgentWork } from '../../../../../../electron/ipc-types';
import { readableContributionText } from '../../../../../../../../shared/contribution-text.mjs';
import { contributionChanges } from '../../../../domain/room-contributions';
import { renderDesktopMarkdown } from '../formatting/markdown';
const props = defineProps<{ work: DesktopRoomAgentWork }>();
const changes = computed(() => contributionChanges(props.work));
const files = computed(() => changes.value?.files.slice(0, 3) ?? []);
const remaining = computed(() => (changes.value?.files.length ?? 0) + (changes.value?.hidden_files ?? 0) - files.value.length);
const summary = computed(() => readableContributionText('contribution' in props.work.summary ? props.work.summary.contribution?.summary : null));
const formatted = computed(() => renderDesktopMarkdown(summary.value ?? '', { block: true, mentions: false }));
const links = ref<Record<string, 'local' | 'github'>>({});
const opening = ref<string | null>(null);
const error = ref('');
const filename = (path: string) => path.split('/').at(-1) || path;
const action = (status: string) => (({ added: 'Added', untracked: 'Added', deleted: 'Deleted', renamed: 'Renamed' } as Record<string, string>)[status] ?? 'Updated');
const request = () => ({ roomId: props.work.roomId, agentKey: props.work.agentKey, sourceMessageId: props.work.sourceMessageId, paths: files.value.map(file => file.path) });
watch(() => JSON.stringify([props.work.roomId, props.work.agentKey, props.work.sourceMessageId, changes.value?.captured_at]), async (_work, _old, cleanup) => {
  let current = true;
  cleanup(() => { current = false; });
  links.value = {}; error.value = '';
  try {
    const result = await window.letagentsDesktop?.app.resolveWorkspaceFiles?.(request());
    if (current) links.value = Object.fromEntries((result ?? []).map(link => [link.path, link.kind]));
  } catch { /* A filename remains useful without a destination. */ }
}, { immediate: true });
async function open(path: string) {
  if (opening.value) return;
  opening.value = path; error.value = '';
  try { await window.letagentsDesktop?.app.openWorkspaceFile?.({ ...request(), paths: [path] }); }
  catch { error.value = 'This file is no longer available to open.'; delete links.value[path]; }
  finally { opening.value = null; }
}
</script>
<style scoped>
.contribution-description { margin: 9px 0 12px; font-size: 13px; line-height: 1.6; }
.contribution-prose { overflow-wrap: anywhere; }
.contribution-prose :deep(p) { margin: 0 0 8px; }
.contribution-prose :deep(ul), .contribution-prose :deep(ol) { margin: 8px 0; padding-left: 20px; }
.contribution-prose :deep(h1), .contribution-prose :deep(h2), .contribution-prose :deep(h3) { font-size: 13px; margin: 12px 0 6px; }
.contribution-prose :deep(pre) { overflow: auto; padding: 10px; border-radius: 6px; background: var(--bg-card); }
.contribution-prose :deep(code) { font-size: 11px; }
.contribution-prose :deep(a) { color: var(--blue); text-underline-offset: 3px; }
.contribution-files { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 0; margin: 10px 0 0; list-style: none; }
.contribution-files li { display: flex; align-items: baseline; gap: 6px; min-width: 0; max-width: 100%; }
.file-action { color: var(--text-secondary); font-size: 11px; }
.contribution-files button, .contribution-files code { font: 11px/1.6 ui-monospace, monospace; overflow-wrap: anywhere; }
.contribution-files button { display: inline-flex; align-items: center; gap: 4px; min-width: 0; padding: 3px 5px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 5px; color: var(--blue); cursor: pointer; text-align: left; }
.contribution-files button svg { flex-shrink: 0; }
.contribution-files button:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
.contribution-files button:disabled { opacity: .6; cursor: progress; }
.remaining, .file-error { margin: 6px 0 0; color: var(--text-secondary); font-size: 11px; }
@media (hover: hover) { .contribution-files button:hover { background: var(--accent-hover); } }
</style>
