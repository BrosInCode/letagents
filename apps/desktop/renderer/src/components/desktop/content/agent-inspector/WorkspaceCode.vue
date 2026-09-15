<template>
  <div class="workspace-code">
    <div class="workspace-code-tools">
      <span><LockKeyhole :size="12" aria-hidden="true" />Read only</span>
      <button type="button" :disabled="!ready" @click="find"><Search :size="13" aria-hidden="true" />Find</button>
      <div class="workspace-code-font" role="group" aria-label="Code font size">
        <button type="button" aria-label="Decrease code font size" :disabled="fontSize <= 12" @click="fontSize--">A−</button>
        <output aria-live="polite">{{ fontSize }}px</output>
        <button type="button" aria-label="Increase code font size" :disabled="fontSize >= 22" @click="fontSize++">A+</button>
      </div>
    </div>
    <div ref="host" class="workspace-monaco" />
    <div v-if="!ready" class="workspace-code-status" role="status">
      <span>{{ failed ? 'Couldn’t open the code reader.' : 'Opening code…' }}</span>
      <button v-if="failed" type="button" @click="mountEditor">Try again</button>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { LockKeyhole, Search } from '@lucide/vue';
import type { editor } from 'monaco-editor/editor/editor.api';
import type { WorkspaceDiffPage } from '../../../../domain/workspace-diff';
import { workspaceCodeLineNumber, workspaceCodeText } from '../../../../domain/workspace-code-reader';

const props = defineProps<{ path: string; lines: WorkspaceDiffPage['lines'] }>();
const emit = defineEmits<{ escape: [] }>();
const host = ref<HTMLElement | null>(null);
const ready = ref(false), failed = ref(false), fontSize = ref(15);
const lineNumberWidth = computed(() => props.lines.reduce((width, line) => Math.max(width, String(line.before ?? '').length, String(line.after ?? '').length), 2));
let instance: editor.IStandaloneCodeEditor | undefined;
let model: editor.ITextModel | undefined;
let disposed = false;
let themeObserver: MutationObserver | undefined;
let updateCode: (() => void) | undefined;

function find() { void instance?.getAction('actions.find')?.run(); }
async function mountEditor() {
  failed.value = false;
  try {
    const { monaco, workspaceLanguage } = await import('../../../../domain/workspace-monaco');
    if (disposed || !host.value) return;
    const applyTheme = () => {
      if (!host.value) return;
      const style = getComputedStyle(host.value);
      const hex = (color: string) => '#' + (color.match(/\d+/g) ?? ['10', '10', '10']).slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('');
      monaco.editor.defineTheme('letagents-workspace', {
        base: style.colorScheme === 'light' ? 'vs' : 'vs-dark', inherit: true, rules: [],
        colors: { 'editor.background': hex(style.backgroundColor), 'editor.foreground': hex(style.color), 'editorGutter.background': hex(style.backgroundColor) },
      });
      monaco.editor.setTheme('letagents-workspace');
    };
    applyTheme();
    model = monaco.editor.createModel(workspaceCodeText(props.lines), workspaceLanguage(props.path));
    instance = monaco.editor.create(host.value, {
      model, readOnly: true, domReadOnly: true, readOnlyMessage: { value: 'This is a captured workspace. Code is read only.' },
      ariaLabel: `Captured code changes in ${props.path}. Read only. Line numbers show before and after the change.`,
      fontFamily: '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace', fontSize: fontSize.value, lineHeight: fontSize.value + 11,
      fontLigatures: false, automaticLayout: true, minimap: { enabled: false }, stickyScroll: { enabled: false },
      wordWrap: 'on', wrappingIndent: 'same', scrollBeyondLastLine: false, renderLineHighlight: 'none',
      lineNumbers: number => props.lines[number - 1] ? workspaceCodeLineNumber(props.lines[number - 1], lineNumberWidth.value) : '',
      lineNumbersMinChars: lineNumberWidth.value * 2 + 3, lineDecorationsWidth: 8, folding: false, contextmenu: false,
      tabFocusMode: true, links: false, quickSuggestions: false, padding: { top: 18, bottom: 24 },
      scrollbar: { alwaysConsumeMouseWheel: false }, renderValidationDecorations: 'off',
    });
    instance.addAction({ id: 'letagents.close-workspace-reader', label: 'Close workspace reader', keybindings: [monaco.KeyCode.Escape], precondition: '!findWidgetVisible', run: () => emit('escape') });
    const decorations = instance.createDecorationsCollection();
    updateCode = () => {
      if (!model || !instance) return;
      model.setValue(workspaceCodeText(props.lines));
      monaco.editor.setModelLanguage(model, workspaceLanguage(props.path));
      instance.updateOptions({ lineNumbersMinChars: lineNumberWidth.value * 2 + 3, ariaLabel: `Captured code changes in ${props.path}. Read only. Line numbers show before and after the change.` });
      decorations.set(props.lines.flatMap((line, index) => line.kind === 'context' ? [] : [{
        range: new monaco.Range(index + 1, 1, index + 1, 1),
        options: { isWholeLine: true, className: `workspace-monaco-${line.kind}` },
      }]));
      instance.setScrollTop(0); instance.setScrollLeft(0);
    };
    updateCode();
    themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    ready.value = true;
  } catch {
    instance?.dispose(); model?.dispose(); themeObserver?.disconnect();
    instance = undefined; model = undefined;
    if (!disposed) failed.value = true;
  }
}
watch(fontSize, value => instance?.updateOptions({ fontSize: value, lineHeight: value + 11 }));
watch([() => props.path, () => props.lines], () => updateCode?.());
onMounted(mountEditor);
onBeforeUnmount(() => { disposed = true; themeObserver?.disconnect(); instance?.dispose(); model?.dispose(); });
</script>
<style>
.workspace-code { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 180px; position: relative; }
.workspace-code-tools { display: flex; align-items: center; gap: 14px; padding: 5px 12px; border-bottom: 1px solid var(--border); color: var(--text-secondary); font-size: 11px; }
.workspace-code-tools > span, .workspace-code-tools > button { display: inline-flex; align-items: center; gap: 6px; }
.workspace-code-tools > span { margin-right: auto; }
.workspace-code button { background: transparent; color: var(--text-secondary); border-radius: 5px; padding: 6px; font: inherit; cursor: pointer; min-height: 28px; }
.workspace-code button:disabled { opacity: .4; cursor: default; }
.workspace-code button:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
.workspace-code-font { display: flex; align-items: center; gap: 5px; }
.workspace-code-font output { min-width: 30px; text-align: center; font-variant-numeric: tabular-nums; }
.workspace-monaco { flex: 1; min-height: 140px; background: var(--bg); color: var(--text); }
.workspace-code-status { position: absolute; inset: 42px 0 0; display: flex; align-items: center; justify-content: center; gap: 8px; background: var(--bg); color: var(--text-secondary); font-size: 12px; }
.workspace-monaco-added { background: light-dark(#edf8ef, #15251b); }
.workspace-monaco-deleted { background: light-dark(#fceef0, #301c20); }
.workspace-monaco-hunk, .workspace-monaco-metadata { background: var(--bg-card); }
@media (hover: hover) { .workspace-code button:not(:disabled):hover { color: var(--text); background: var(--accent-hover); } }
</style>
