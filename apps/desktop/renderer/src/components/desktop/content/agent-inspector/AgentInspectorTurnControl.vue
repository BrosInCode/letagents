<template>
  <section
    v-if="control"
    class="agent-inspector-turn-control"
    :data-status="control.status"
    aria-labelledby="agent-inspector-turn-control-title"
  >
    <div class="agent-inspector-turn-control-heading">
      <div>
        <p id="agent-inspector-turn-control-title">{{ control.label }}</p>
        <strong>{{ control.detail }}</strong>
      </div>
      <span v-if="control.status === 'uncertain'" class="agent-inspector-turn-control-state">Needs review</span>
    </div>

    <template v-if="control.status === 'uncertain'">
      <p class="agent-inspector-turn-control-guidance">
        Use the recorded outcome—not a guess. Confirming “not applied” unlocks a new request; it never replays the old one.
      </p>
      <div class="agent-inspector-turn-control-actions">
        <button type="button" :disabled="busy || !control.canResolve" @click="emitResolution('applied')">Mark as applied</button>
        <button type="button" :disabled="busy || !control.canResolve" @click="emitResolution('not_applied')">Mark as not applied</button>
      </div>
    </template>

    <template v-else-if="control.status === 'in_progress'">
      <p class="agent-inspector-turn-control-guidance">Waiting for the durable control record to settle.</p>
    </template>

    <template v-else>
      <label class="agent-inspector-field" :for="fieldId">
        Correction for this session
        <textarea
          :id="fieldId"
          v-model="draft"
          rows="3"
          :disabled="busy || !control.canCorrect"
          placeholder="Tell the agent what to change. It will continue on this same session."
        />
      </label>
      <div class="agent-inspector-turn-control-actions">
        <button
          type="button"
          class="primary"
          :disabled="busy || !control.canCorrect || !draft.trim()"
          @click="applyCorrection"
        >
          Apply correction
        </button>
        <button type="button" :disabled="busy || !control.canStop" @click="emit('stop')">Stop current turn</button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AgentInspectorTurnControlProjection } from "../../../../domain/agent-inspector";

const props = defineProps<{
  entryId: string;
  control: AgentInspectorTurnControlProjection | null;
  busy: boolean;
}>();
const emit = defineEmits<{
  stop: [];
  correct: [correction: string];
  resolve: [resolution: "not_applied" | "applied"];
}>();

const draft = ref("");
const fieldId = computed(() => `agent-inspector-turn-correction-${props.entryId}`);

watch(() => [props.entryId, props.control?.workAttemptId, props.control?.executionGenerationId] as const, () => {
  draft.value = "";
});

function applyCorrection(): void {
  const correction = draft.value.trim();
  if (!correction || !props.control?.canCorrect || props.busy) return;
  emit("correct", correction);
}

function emitResolution(resolution: "not_applied" | "applied"): void {
  if (!props.control?.canResolve || props.busy) return;
  emit("resolve", resolution);
}
</script>
