<template>
  <TaskMarkdownEditor v-model="model" v-bind="$attrs" :icons="icons" />
</template>

<script setup lang="ts">
import { Bold, Italic, Strikethrough, Heading2, List, ListOrdered, ListTodo, Quote, SquareCode, Link } from '@lucide/vue'
import TaskMarkdownEditor from '../../../../../../../../shared/ui/TaskMarkdownEditor.vue'

// The desktop board shows Lucide icons in the shared editor's toolbar.
defineOptions({ inheritAttrs: false })
const model = defineModel<string>({ required: true })
const icons = { bold: Bold, italic: Italic, strike: Strikethrough, heading: Heading2, bullet: List, number: ListOrdered, check: ListTodo, quote: Quote, code: SquareCode, link: Link }
</script>
