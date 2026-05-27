<template>
  <form class="focus-share-form" @submit.prevent="emit('submit')">
    <div class="focus-panel-header">
      <div>
        <p class="focus-eyebrow">Result summary</p>
        <h4 v-if="isConcluded">Focus room concluded.</h4>
        <h4 v-else>Share task outcome.</h4>
      </div>
    </div>
    <textarea
      id="focus-result-summary"
      v-model="summary"
      aria-label="Result summary"
      :disabled="isConcluded || isSharing"
      :placeholder="placeholder"
      rows="3"
      class="focus-result-textarea"
    />
    <div v-if="showCloseoutDetails" class="focus-closeout-grid">
      <label>
        <span>Artifact or decision</span>
        <input
          v-model="details.artifact"
          :disabled="isConcluded || isSharing"
          placeholder="PR #316, commit, doc, decision, or investigation result"
        />
      </label>
      <label>
        <span>Review state</span>
        <AppSelect v-model="details.review_state" :disabled="isConcluded || isSharing">
          <option
            v-for="option in reviewStateOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </AppSelect>
      </label>
      <label>
        <span>Blockers</span>
        <AppSelect v-model="details.blocker_state" :disabled="isConcluded || isSharing">
          <option
            v-for="option in blockerStateOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </AppSelect>
      </label>
      <label>
        <span>Parent task next</span>
        <AppSelect v-model="details.parent_task_next" :disabled="isConcluded || isSharing">
          <option
            v-for="option in parentTaskNextOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </AppSelect>
      </label>
      <label>
        <span>Next owner</span>
        <input
          v-model="details.next_owner"
          :disabled="isConcluded || isSharing"
          placeholder="Agent, human, or reviewer responsible next"
        />
      </label>
    </div>
    <div class="focus-share-footer">
      <p>{{ helpText }}</p>
      <button
        class="focus-primary"
        type="submit"
        :disabled="!canSubmit"
      >
        {{ submitLabel }}
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { AppSelect } from '@/components/ui'
import type { FocusRoomConclusionDetails } from '@/composables/useRoom'
import {
  blockerStateOptions,
  parentTaskNextOptions,
  reviewStateOptions,
} from './options'

defineProps<{
  isConcluded: boolean
  isSharing: boolean
  placeholder: string
  showCloseoutDetails: boolean
  helpText: string
  submitLabel: string
  canSubmit: boolean
}>()

const emit = defineEmits<{
  submit: []
}>()

const summary = defineModel<string>('summary', { required: true })
const details = defineModel<FocusRoomConclusionDetails>('details', { required: true })
</script>
