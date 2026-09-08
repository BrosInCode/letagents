<template>
  <div class="contribution-description">
    <div v-if="summary" class="contribution-prose" @click="openInlineFile" v-html="formatted" />
    <ul v-if="unmentionedFiles.length" class="contribution-files" aria-label="Changed files">
      <li v-for="file in unmentionedFiles" :key="file.path">
        <span class="file-action">{{ action(file.status) }}</span>
        <button v-if="links[file.path]" type="button" :disabled="opening === file.path" :title="links[file.path] === 'local' ? 'Open in your default editor' : 'Open published file on GitHub'" @click="open(file.path)">
          <FileCode :size="13" aria-hidden="true" /><span>{{ filename(file.path) }}</span><ArrowUpRight :size="12" aria-hidden="true" />
        </button>
        <code v-else>{{ filename(file.path) }}</code>
      </li>
    </ul>
    <p v-if="remaining" class="remaining">{{ remaining }} more {{ remaining === 1 ? 'file' : 'files' }} in the diff</p>
    <p v-if="error" ref="fileError" tabindex="-1" role="status" class="file-error">{{ error }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
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
// Remove only generic workspace labels; meaningful headings remain content.
const prose = computed(() => renderDesktopMarkdown((summary.value ?? '').replace(/^#{1,6}[ \t]+workspace(?: file)?(?: qa| changes| update)?[ \t]*\n+/i, ''), { block: true, mentions: false }));
const proseTemplate = computed(() => {
  const template = document.createElement('template');
  template.innerHTML = prose.value;
  return template;
});
const inlineCodes = (content: DocumentFragment) => Array.from(content.querySelectorAll('code')).filter(code => !code.closest('pre, a'));
const mentionedFiles = computed(() => files.value.filter(file =>
  inlineCodes(proseTemplate.value.content).some(code => code.textContent === filename(file.path))
  && changes.value?.files.filter(other => filename(other.path) === filename(file.path)).length === 1
));
const unmentionedFiles = computed(() => files.value.filter(file => !mentionedFiles.value.includes(file)));
const formatted = computed(() => {
  const template = proseTemplate.value.cloneNode(true) as HTMLTemplateElement;
  for (const code of inlineCodes(template.content)) {
    const file = mentionedFiles.value.find(file => filename(file.path) === code.textContent);
    if (!file || !links.value[file.path]) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'contribution-inline-file';
    button.dataset.fileIndex = String(files.value.indexOf(file));
    button.title = links.value[file.path] === 'local' ? 'Open in your default editor' : 'Open published file on GitHub';
    const arrow = document.createElement('span');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '↗';
    code.replaceWith(button);
    button.append(code, arrow);
  }
  return template.innerHTML;
});
const links = ref<Record<string, 'local' | 'github'>>({});
const opening = ref<string | null>(null);
const error = ref('');
const fileError = ref<HTMLElement | null>(null);
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
async function openInlineFile(event: MouseEvent) {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-file-index]') : null;
  if (!button || !(event.currentTarget instanceof Element) || !event.currentTarget.contains(button)) return;
  const index = Number(button.dataset.fileIndex);
  const file = Number.isInteger(index) ? files.value[index] : undefined;
  if (!file || !links.value[file.path] || opening.value) return;
  const focused = document.activeElement === button;
  button.setAttribute('aria-busy', 'true');
  await open(file.path);
  await nextTick();
  button.removeAttribute('aria-busy');
  if (focused && !button.isConnected) fileError.value?.focus();
}
async function open(path: string) {
  if (opening.value) return;
  opening.value = path; error.value = '';
  try { await window.letagentsDesktop?.app.openWorkspaceFile?.({ ...request(), paths: [path] }); }
  catch { error.value = 'File no longer available'; delete links.value[path]; }
  finally { opening.value = null; }
}
</script>
<style scoped>
.contribution-description { margin: 12px 0; font-size: 13px; line-height: 1.65; }
.contribution-prose { overflow-wrap: anywhere; }
.contribution-prose :deep(p) { margin: 0 0 8px; }
.contribution-prose :deep(ul), .contribution-prose :deep(ol) { margin: 8px 0; padding-left: 20px; }
.contribution-prose :deep(h1), .contribution-prose :deep(h2), .contribution-prose :deep(h3) { font-size: 13px; margin: 12px 0 6px; }
.contribution-prose :deep(pre) { overflow: auto; padding: 10px; border-radius: 6px; background: var(--bg-card); }
.contribution-prose :deep(code) { font: 12px/1.55 ui-monospace, monospace; color: var(--text); padding: 2px 5px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-card); box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.contribution-prose :deep(pre code) { padding: 0; border: 0; background: none; }
.contribution-prose :deep(.contribution-inline-file) { display: inline; padding: 0; border: 0; background: none; color: var(--blue); font: inherit; cursor: pointer; text-align: left; overflow-wrap: anywhere; }
.contribution-prose :deep(.contribution-inline-file code) { color: inherit; }
.contribution-prose :deep(.contribution-inline-file span) { margin-left: 3px; font-size: 11px; }
.contribution-prose :deep(.contribution-inline-file:focus-visible) { outline: 2px solid var(--blue); outline-offset: 3px; border-radius: 4px; }
.contribution-prose :deep(.contribution-inline-file[aria-busy="true"]) { opacity: .6; cursor: progress; }
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
@media (hover: hover) { .contribution-files button:hover, .contribution-prose :deep(.contribution-inline-file:hover code) { background: var(--accent-hover); } }
</style>
