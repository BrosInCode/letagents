<template>
  <form
    :class="['focus-settings-form', { compact }]"
    @submit.prevent="emit('submit')"
  >
    <div :class="compact ? 'focus-settings-heading' : 'focus-panel-header'">
      <div>
        <p class="focus-eyebrow">Sharing</p>
        <h4>{{ title }}</h4>
      </div>
      <button
        class="focus-secondary"
        type="submit"
        :disabled="!canSubmit"
      >
        {{ submitLabel }}
      </button>
    </div>
    <div :class="['focus-settings-grid', { compact }]">
      <label>
        <span>Parent room</span>
        <AppSelect v-model="settings.parent_visibility" :disabled="disabled">
          <option
            v-for="option in parentVisibilityOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </AppSelect>
        <small>{{ parentVisibilityDescription }}</small>
      </label>
      <label>
        <span>What counts</span>
        <AppSelect v-model="settings.activity_scope" :disabled="disabled">
          <option
            v-for="option in activityScopeOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </AppSelect>
        <small>{{ activityScopeDescription }}</small>
      </label>
      <label>
        <span>Code updates</span>
        <AppSelect v-model="settings.github_event_routing" :disabled="disabled">
          <option
            v-for="option in githubEventRoutingOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </AppSelect>
        <small>{{ githubEventRoutingDescription }}</small>
      </label>
    </div>
  </form>
</template>

<script setup lang="ts">
import { AppSelect } from '@/components/ui'
import type { FocusRoomSettings } from '@/composables/useRoom'
import {
  activityScopeOptions,
  githubEventRoutingOptions,
  parentVisibilityOptions,
} from './options'

defineProps<{
  title: string
  submitLabel: string
  canSubmit: boolean
  disabled: boolean
  parentVisibilityDescription: string
  activityScopeDescription: string
  githubEventRoutingDescription: string
  compact?: boolean
}>()

const emit = defineEmits<{
  submit: []
}>()

const settings = defineModel<FocusRoomSettings>('settings', { required: true })
</script>
