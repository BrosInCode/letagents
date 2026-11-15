<template>
<label class="desktop-add-agent-model-custom-input">
      <small>First message</small>
      <!-- An edit can arrive with only a change event, e.g. a value set through
           accessibility automation. Without this the form kept the old task, and
           the next re-render (choosing an access level re-runs setup) wrote it
           back over the typed text. -->
      <textarea
        :value="modelValue"
        rows="3"
        placeholder="What would you like to ask this agent?"
        required
        :aria-invalid="!modelValue.trim()"
        :aria-describedby="!modelValue.trim() ? 'desktop-add-agent-supervised-charter-error' : undefined"
        data-testid="desktop-add-agent-supervised-charter"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        @change="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      />
      <small
        v-if="!modelValue.trim()"
        id="desktop-add-agent-supervised-charter-error"
        class="desktop-add-agent-field-error"
      >Add the first message the agent should handle after it joins. It is sent once.</small>
    </label>
</template>
<script setup lang="ts">
defineProps<{ modelValue: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
</script>
<style scoped src="./AddAgentFormField.css"></style>
