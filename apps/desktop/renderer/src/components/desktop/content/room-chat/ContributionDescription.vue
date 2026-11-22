<template>
  <div class="contribution-description">
    <div v-if="summary && !fileReviews" class="contribution-prose" @click="openInlineFile" v-html="formatted" />
    <ul v-if="files.length" class="contribution-files" aria-label="Changed files">
      <li v-for="file in files" :key="file.path">
        <button v-if="fileReviews" class="contribution-file" type="button" :title="file.path"
          :aria-label="`Review changes to ${file.path}`" @click="emit('review-file', file.path)">
          <FileCode :size="15" aria-hidden="true" />
          <span class="file-name">
            <span>{{ filename(file.path) }}</span>
            <small v-if="directory(file.path)">{{ directory(file.path) }}</small>
          </span>
          <span class="file-action">{{ action(file.status) }}</span>
          <ChevronRight :size="13" aria-hidden="true" />
        </button>
        <span v-else class="contribution-file" :title="file.path">
          <FileCode :size="15" aria-hidden="true" />
          <span class="file-name">{{ filename(file.path) }}</span>
          <span class="file-action">{{ action(file.status) }}</span>
        </span>
        <button v-if="links[file.path]" class="contribution-source" type="button" :disabled="opening === file.path"
          :title="sourceLabel(file.path)" :aria-label="`${sourceLabel(file.path)}: ${file.path}`" @click="open(file.path, $event.currentTarget)">
          <ArrowUpRight :size="14" aria-hidden="true" />
        </button>
      </li>
    </ul>
    <details v-if="summary && fileReviews" class="contribution-note">
      <summary>Agent note</summary>
      <div class="contribution-prose" @click="openInlineFile" v-html="formatted" />
    </details>
    <p v-if="error" ref="fileError" tabindex="-1" role="status" class="file-error">{{ error }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ArrowUpRight, ChevronRight, FileCode } from '@lucide/vue';
import type { DesktopRoomAgentWork } from '../../../../../../electron/ipc-types';
import { readableContributionText } from '../../../../../../../../shared/contribution-text.mjs';
import { contributionChanges } from '../../../../domain/room-contributions';
import { renderMarkdown } from '../../../../../../../../shared/ui/markdown/markdown';
const props = defineProps<{ work: DesktopRoomAgentWork; fileReviews?: boolean }>();
const emit = defineEmits<{ 'review-file': [path: string] }>();
const changes = computed(() => contributionChanges(props.work));
const capturedFiles = computed(() => changes.value?.files ?? []);
const files = computed(() => capturedFiles.value.slice(0, 3));
const summary = computed(() => readableContributionText('contribution' in props.work.summary ? props.work.summary.contribution?.summary : null)
  ?.replace(/^#{1,6}[ \t]+workspace(?: file)?(?: qa| changes| update)?[ \t]*\n+/i, '')
  .replace(/(?:^|\n)[ \t]*(?:\d+[.)]|[-*+])[ \t]*$/, '')
  .trim());
const prose = computed(() => renderMarkdown(summary.value ?? '', { block: true, mentions: false }));
const proseTemplate = computed(() => {
  const template = document.createElement('template');
  template.innerHTML = prose.value;
  return template;
});
const inlineCodes = (content: DocumentFragment) => Array.from(content.querySelectorAll('code')).filter(code => !code.closest('pre, a'));
const formatted = computed(() => {
  const template = proseTemplate.value.cloneNode(true) as HTMLTemplateElement;
  for (const code of inlineCodes(template.content)) {
    const name = code.textContent?.trim();
    const candidates = capturedFiles.value.filter(file => filename(file.path) === name);
    const match = capturedFiles.value.find(file => file.path === name) ?? (candidates.length === 1 ? candidates[0] : null);
    if (!match || (!props.fileReviews && !links.value[match.path])) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'contribution-inline-file';
    button.dataset.fileIndex = String(capturedFiles.value.indexOf(match));
    button.title = props.fileReviews ? `Review changes to ${match.path}` : sourceLabel(match.path);
    code.replaceWith(button);
    button.append(code);
  }
  return template.innerHTML;
});
const links = ref<Record<string, 'local' | 'github'>>({});
const opening = ref<string | null>(null);
const error = ref('');
const fileError = ref<HTMLElement | null>(null);
const filename = (path: string) => path.split('/').at(-1) || path;
const directory = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const action = (status: string) => (({ added: 'Added', untracked: 'Added', deleted: 'Deleted', renamed: 'Renamed' } as Record<string, string>)[status] ?? 'Updated');
const sourceLabel = (path: string) => links.value[path] === 'local' ? 'Open in editor' : 'Open on GitHub';
const request = (paths: string[]) => ({ roomId: props.work.roomId, agentKey: props.work.agentKey, sourceMessageId: props.work.sourceMessageId, paths });
watch(() => [props.work.roomId, props.work.agentKey, props.work.sourceMessageId, props.work.revision], async (_work, _old, cleanup) => {
  let current = true;
  cleanup(() => { current = false; });
  links.value = {}; error.value = '';
  try {
    const paths = files.value.map(file => file.path);
    if (!paths.length) return;
    const result = await window.letagentsDesktop?.app.resolveWorkspaceFiles?.(request(paths));
    if (current) links.value = Object.fromEntries((result ?? []).map(link => [link.path, link.kind]));
  } catch { /* A filename remains useful without a destination. */ }
}, { immediate: true });
async function openInlineFile(event: MouseEvent) {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-file-index]') : null;
  if (!button || !(event.currentTarget instanceof Element) || !event.currentTarget.contains(button)) return;
  const index = Number(button.dataset.fileIndex);
  const file = Number.isInteger(index) ? capturedFiles.value[index] : undefined;
  if (!file) return;
  if (props.fileReviews) { emit('review-file', file.path); return; }
  if (!links.value[file.path] || opening.value) return;
  await open(file.path, button);
}
async function open(path: string, sourceButton: EventTarget | null) {
  if (opening.value) return;
  opening.value = path; error.value = '';
  try { await window.letagentsDesktop?.app.openWorkspaceFile?.(request([path])); }
  catch {
    const focused = sourceButton && document.activeElement === sourceButton;
    error.value = 'File no longer available';
    delete links.value[path];
    await nextTick();
    if (focused) fileError.value?.focus();
  }
  finally { opening.value = null; }
}
</script>
<style scoped>
.contribution-description { font-size: .8125rem; line-height: 1.65; }
.contribution-prose { overflow-wrap: anywhere; }
.contribution-prose :deep(p) { margin: 0 0 8px; }
.contribution-prose :deep(ul), .contribution-prose :deep(ol) { margin: 8px 0; padding-left: 20px; }
.contribution-prose :deep(h1), .contribution-prose :deep(h2), .contribution-prose :deep(h3) { font-size: 13px; margin: 12px 0 6px; }
.contribution-prose :deep(pre) { overflow: auto; padding: 10px; border-radius: 6px; background: var(--bg-card); }
.contribution-prose :deep(code) { font: 12px/1.55 ui-monospace, monospace; color: var(--text); padding: 2px 5px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-card); box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.contribution-prose :deep(pre code) { padding: 0; border: 0; background: none; }
.contribution-prose :deep(.contribution-inline-file) { display: inline; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; text-align: left; text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; }
.contribution-prose :deep(.contribution-inline-file code) { padding: 0; border: 0; background: transparent; color: inherit; }
.contribution-prose :deep(.contribution-inline-file:focus-visible) { outline: 2px solid var(--blue-text); outline-offset: 3px; border-radius: 4px; }
.contribution-prose :deep(a) { color: var(--blue); text-underline-offset: 3px; }
.contribution-files { margin: 0; padding: 0 8px; list-style: none; }
.contribution-files li { display: flex; align-items: center; min-width: 0; border-top: 1px solid var(--border); }
.contribution-file, .contribution-source {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  text-align: start;
}
.contribution-file { flex: 1; min-height: 42px; }
.contribution-file svg, .contribution-source { flex: none; }
.file-name { display: grid; flex: 1; min-width: 0; color: var(--text); line-height: 1.4; overflow-wrap: anywhere; }
.file-name small { overflow: hidden; color: var(--text-secondary); font-size: .6875rem; text-overflow: ellipsis; white-space: nowrap; }
.file-action { color: var(--text-secondary); font-size: .6875rem; }
.contribution-files button { cursor: pointer; }
.contribution-source { justify-content: center; width: 34px; height: 34px; margin-left: 2px; }
.contribution-files button:focus-visible, .contribution-note summary:focus-visible { outline: 2px solid var(--blue-text); outline-offset: -2px; }
.contribution-source:disabled { opacity: .6; cursor: progress; }
.contribution-note { padding: 4px 16px 8px; border-top: 1px solid var(--border); }
.contribution-note summary { width: fit-content; padding-block: 6px; color: var(--text-secondary); cursor: pointer; font-size: .75rem; }
.contribution-note .contribution-prose { margin-top: 6px; }
.file-error { margin: 8px 16px; color: var(--text-secondary); font-size: .75rem; }
@media (hover: hover) and (pointer: fine) {
  .contribution-files button:hover { background: var(--accent-hover); }
  .contribution-note summary:hover { color: var(--text); }
}
</style>
