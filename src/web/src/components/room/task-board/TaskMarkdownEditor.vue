<template>
  <div class="task-markdown">
    <label :for="inputId">{{ label }}</label>
    <div class="task-markdown-surface">
      <div class="task-markdown-toolbar" role="group" aria-label="Markdown formatting">
        <button v-for="tool in markdownTools" :key="tool.id" type="button" class="task-markdown-tool" :data-tool="tool.id"
          :aria-label="tool.label" :title="tool.label" :disabled="disabled || preview" @mousedown.prevent @click="format(tool.id)">
          <span aria-hidden="true">{{ tool.symbol }}</span>
        </button>
        <div class="task-markdown-tabs" role="group" aria-label="Editor mode">
          <button type="button" :aria-pressed="!preview" @click="preview = false">Write</button>
          <button type="button" :aria-pressed="preview" @click="preview = true">Preview</button>
        </div>
      </div>
      <div v-if="preview" class="task-markdown-preview" role="region" aria-label="Description preview" tabindex="0" v-html="rendered || '<p>No description yet.</p>'"></div>
      <textarea v-show="!preview" :id="inputId" ref="textarea" :value="modelValue" :disabled="disabled" rows="10" @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)" @keydown="onKeydown"></textarea>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import { applyMarkdownTool, markdownTools, type MarkdownTool } from '../../../../../../shared/task-markdown-editing.mjs'
import { renderMessageContent } from '../chat-message/formatting'
const props = withDefaults(defineProps<{ modelValue: string; disabled?: boolean; id?: string; label?: string }>(), { disabled: false, label: 'Description' })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const textarea = ref<HTMLTextAreaElement | null>(null)
const preview = ref(false)
const generatedId = useId()
const inputId = computed(() => props.id || 'task-markdown-' + generatedId)
const rendered = computed(() => renderMessageContent(props.modelValue))
async function format(tool: MarkdownTool) {
  const input = textarea.value
  if (!input || props.disabled || preview.value) return
  const next = applyMarkdownTool(props.modelValue, input.selectionStart, input.selectionEnd, tool)
  input.focus()
  // Native insertion keeps toolbar edits in the textarea's undo history.
  input.setSelectionRange(0, input.value.length)
  if (!document.execCommand('insertText', false, next.value)) emit('update:modelValue', next.value)
  await nextTick()
  input.setSelectionRange(next.start, next.end)
}
function onKeydown(event: KeyboardEvent) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return
  const tool = ({ b: 'bold', i: 'italic', k: 'link' } as const)[event.key.toLowerCase() as 'b' | 'i' | 'k']
  if (tool) { event.preventDefault(); void format(tool) }
}
</script>

<style src="../../../../../../shared/task-markdown.css"></style>
