<template>
  <div class="contribution-description">
    <div v-if="summary" class="contribution-prose" @click="openInlineFile" v-html="formatted" />
    <ul v-if="shownRows.length" class="contribution-files" aria-label="Changed files">
      <li v-for="row in shownRows" :key="row.path">
        <span class="file-action">{{ row.label }}</span>
        <button v-if="links[row.path]" type="button" :disabled="opening === row.path" :title="links[row.path] === 'local' ? 'Open in your default editor' : 'Open published file on GitHub'" @click="open(row.path)">
          <FileCode :size="13" aria-hidden="true" /><span>{{ filename(row.path) }}</span><ArrowUpRight :size="12" aria-hidden="true" />
        </button>
        <code v-else>{{ filename(row.path) }}</code>
        <button v-if="row.edit" type="button" class="edit-toggle" :aria-expanded="openPath === row.path" :aria-controls="editId" :aria-label="openPath === row.path ? 'Hide the edit' : `Show the edit${row.counts ? `, ${countText(row.counts)} lines` : ''}`" @click="toggle(row.path)">
          <template v-if="row.counts"><b v-if="row.counts.additions || !row.counts.deletions">+{{ row.counts.additions }}</b><b v-if="row.counts.deletions" class="edit-toggle-deleted">−{{ row.counts.deletions }}</b></template><ChevronDown :size="12" aria-hidden="true" />
        </button>
        <span v-else-if="row.counts && card?.mode !== 'plain'" class="cmd-count">{{ countText(row.counts) }}</span>
      </li>
    </ul>
    <div :id="editId" class="edit-diff" :hidden="!openRow">
      <template v-if="openRow && preview">
        <div class="edit-diff-path">{{ openRow.path }}</div>
        <ol v-if="preview.lines.length" aria-label="Lines of this edit">
          <li v-for="(line, index) in preview.lines" :key="index" :data-kind="line.kind"><i aria-hidden="true">{{ line.after ?? line.before }}</i><span><span class="sr-only">{{ line.kind === 'added' ? 'Added: ' : line.kind === 'deleted' ? 'Removed: ' : '' }}</span>{{ line.text }}</span></li>
        </ol>
        <p v-if="preview.truncated" class="edit-diff-more">The rest of this edit is in the review.</p>
        <p v-else-if="preview.more" class="edit-diff-more">{{ preview.more }} more {{ preview.more === 1 ? 'line' : 'lines' }} in this edit</p>
      </template>
    </div>
    <p v-if="card?.remaining" class="remaining">{{ card.remaining }}</p>
    <p v-if="error" ref="fileError" tabindex="-1" role="status" class="file-error">{{ error }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { FileCode, ArrowUpRight, ChevronDown } from '@lucide/vue';
import type { DesktopRoomAgentWork } from '../../../../../../electron/ipc-types';
import { readableContributionText } from '../../../../../../../../shared/contribution-text.mjs';
import { contributionChanges } from '../../../../domain/room-contributions';
import { contributionCard, editPreview, type ContributionCardCounts } from '../../../../domain/room-contribution-card';
import { renderDesktopMarkdown } from '../formatting/markdown';
const props = defineProps<{ work: DesktopRoomAgentWork }>();
const changes = computed(() => contributionChanges(props.work));
const card = computed(() => contributionCard(props.work, new Date()));
const files = computed(() => card.value?.rows ?? []);
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
  && new Set([...(changes.value?.files ?? []), ...files.value].map(other => other.path).filter(path => filename(path) === filename(file.path))).size === 1
));
// Only the plain card leaves a file named in the prose out of the list; the other cards list every row.
const shownRows = computed(() => card.value?.mode === 'plain' ? files.value.filter(file => !mentionedFiles.value.includes(file)) : files.value);
const editId = `contribution-edit-${useId()}`;
const openPath = ref<string | null>(null);
const openRow = computed(() => files.value.find(row => row.path === openPath.value && row.edit) ?? null);
const preview = computed(() => openRow.value?.edit ? editPreview(openRow.value.edit) : null);
watch(() => props.work.attemptId, () => { openPath.value = null; });
const toggle = (path: string) => { openPath.value = openPath.value === path ? null : path; };
// A zero side is left out, as in the rows of the review: `+3`, `−1`, `+3 −1`.
const countText = (counts: ContributionCardCounts) => [counts.additions || !counts.deletions ? `+${counts.additions}` : '', counts.deletions ? `−${counts.deletions}` : ''].filter(Boolean).join(' ');
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
  button.setAttribute('aria-busy', 'true');
  await open(file.path, button);
  await nextTick();
  button.removeAttribute('aria-busy');
}
async function open(path: string, sourceButton?: HTMLButtonElement) {
  if (opening.value) return;
  opening.value = path; error.value = '';
  try { await window.letagentsDesktop?.app.openWorkspaceFile?.({ ...request(), paths: [path] }); }
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
.contribution-files .edit-toggle { gap: 3px; padding: 3px 2px; border: 0; background: none; color: var(--diff-added-text); font-variant-numeric: tabular-nums; }
.edit-toggle b { font-weight: 500; }
.edit-toggle .edit-toggle-deleted { color: var(--diff-deleted-text); }
.edit-toggle b + .edit-toggle-deleted { margin-left: 4px; }
.contribution-files .edit-toggle svg { color: var(--text-secondary); transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1); }
.contribution-files .edit-toggle[aria-expanded="true"] svg { transform: rotate(180deg); }
.cmd-count { color: var(--text-secondary); font: 11px/1.6 var(--font-mono); font-variant-numeric: tabular-nums; }
.edit-diff { margin-top: 10px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--bg-card); }
.edit-diff[hidden] { display: none; }
.edit-diff-path { padding: 6px 10px; border-bottom: 1px solid var(--border); color: var(--text-secondary); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.edit-diff ol { margin: 0; padding: 4px 0; list-style: none; overflow-x: auto; font: 11px/1.7 var(--font-mono); }
.edit-diff li { display: grid; grid-template-columns: 44px 1fr; min-width: max-content; white-space: pre; }
.edit-diff li i { padding-right: 12px; color: var(--text-secondary); font-style: normal; text-align: right; opacity: .7; user-select: none; }
.edit-diff li[data-kind="added"] { background: color-mix(in srgb, var(--diff-added-text) 12%, transparent); box-shadow: inset 2px 0 0 var(--diff-added-text); }
.edit-diff li[data-kind="deleted"] { background: color-mix(in srgb, var(--diff-deleted-text) 12%, transparent); box-shadow: inset 2px 0 0 var(--diff-deleted-text); }
.edit-diff li[data-kind="metadata"] { color: var(--text-secondary); font-style: italic; }
.edit-diff-more { margin: 0; padding: 6px 10px; color: var(--text-secondary); font-size: 11px; line-height: 1.5; }
.edit-diff ol + .edit-diff-more { border-top: 1px solid var(--border); }
@media (prefers-reduced-motion: reduce) { .contribution-files .edit-toggle svg { transition: none; } }
</style>
