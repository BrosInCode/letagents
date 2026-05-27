<template>
  <div class="focus-section-card adhoc-card">
    <form class="focus-adhoc" @submit.prevent="emit('submit')">
      <div>
        <p class="focus-eyebrow">Branch from an idea</p>
        <h4>Start with a room, not a task.</h4>
        <p>Give the work a short intent. A task can be linked when execution starts.</p>
      </div>
      <div class="focus-adhoc-controls">
        <label class="sr-only" for="adhoc-focus-title">Focus Room intent</label>
        <input
          id="adhoc-focus-title"
          v-model="title"
          :disabled="isCreating"
          placeholder="Investigate Focus Room flow"
        />
        <button
          class="focus-primary"
          type="submit"
          :disabled="!canSubmit"
        >
          {{ submitLabel }}
        </button>
      </div>
      <p v-if="attempted && !title.trim()" class="focus-adhoc-error">
        Name the room first.
      </p>
    </form>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  attempted: boolean
  isCreating: boolean
  canSubmit: boolean
  submitLabel: string
}>()

const emit = defineEmits<{
  submit: []
}>()

const title = defineModel<string>('title', { required: true })
</script>
