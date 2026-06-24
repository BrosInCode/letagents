<template>
  <div
    v-if="choices.length"
    class="app-agent-choices"
    data-testid="app-agent-choices"
  >
    <button
      v-for="choice in choices"
      :key="choice.choiceId"
      class="app-agent-choice"
      type="button"
      :disabled="busy"
      @click="$emit('select-action', toActionReference(choice))"
    >
      <span class="app-agent-action-icon">
        <component :is="actionIcon(choice.actionId)" aria-hidden="true" />
      </span>
      <span class="app-agent-action-copy">
        <strong>{{ choice.label }}</strong>
        <small>{{ choice.description }}</small>
      </span>
    </button>
  </div>

  <div
    v-if="pendingPlan"
    class="app-agent-confirmation app-agent-plan"
    data-testid="app-agent-plan-preview"
  >
    <div class="app-agent-confirmation-copy">
      <AlertTriangle aria-hidden="true" />
      <span class="app-agent-action-copy">
        <strong>{{ pendingPlan.title }}</strong>
        <small>{{ pendingPlan.description }}</small>
      </span>
      <em>{{ pendingPlan.risk }} risk</em>
    </div>
    <ul class="app-agent-plan-list">
      <li
        v-for="action in visiblePlanActions"
        :key="`${action.actionId}:${JSON.stringify(action.input)}`"
      >
        <span>{{ action.label }}</span>
        <small v-if="action.description">{{ action.description }}</small>
      </li>
      <li v-if="hiddenPlanActionCount > 0">
        <span>And {{ hiddenPlanActionCount }} more</span>
      </li>
    </ul>
    <div class="app-agent-confirmation-actions">
      <button
        class="ghost-button app-agent-command-button"
        type="button"
        :disabled="busy"
        @click="$emit('cancel')"
      >
        {{ pendingPlan.cancelLabel }}
      </button>
      <button
        class="primary-button app-agent-command-button"
        type="button"
        :disabled="busy"
        @click="$emit('confirm-plan', pendingPlan)"
      >
        {{ pendingPlan.confirmLabel }}
      </button>
    </div>
  </div>

  <div
    v-if="pendingAction"
    class="app-agent-confirmation"
    data-testid="app-agent-confirmation"
  >
    <div class="app-agent-confirmation-copy">
      <AlertTriangle aria-hidden="true" />
      <span class="app-agent-action-copy">
        <strong>{{ pendingAction.label }}</strong>
        <small>{{ pendingAction.description }}</small>
      </span>
      <em>{{ pendingAction.risk }} risk</em>
    </div>
    <div class="app-agent-confirmation-actions">
      <button
        class="ghost-button app-agent-command-button"
        type="button"
        :disabled="busy"
        @click="$emit('cancel')"
      >
        {{ pendingAction.cancelLabel }}
      </button>
      <button
        class="primary-button app-agent-command-button"
        type="button"
        :disabled="busy"
        @click="$emit('confirm-action', toActionReference(pendingAction))"
      >
        {{ pendingAction.confirmLabel }}
      </button>
    </div>
  </div>

  <div
    v-if="executionJournal.length"
    class="app-agent-execution-journal"
    data-testid="app-agent-execution-journal"
  >
    <div
      v-for="action in executionJournal"
      :key="`${action.actionId}:${action.label}:${action.status}`"
      class="app-agent-execution-row"
      :data-status="action.status"
    >
      <CheckCircle2 v-if="action.status === 'success'" aria-hidden="true" />
      <XCircle v-else-if="action.status === 'error'" aria-hidden="true" />
      <CircleDashed v-else aria-hidden="true" />
      <span>
        <strong>{{ action.label }}</strong>
        <small>{{ action.message }}</small>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  Pin,
  Settings,
  SlidersHorizontal,
  XCircle,
} from "@lucide/vue";
import { computed } from "vue";
import type {
  DesktopAppAgentActionChoice,
  DesktopAppAgentActionPlan,
  DesktopAppAgentActionReference,
  DesktopAppAgentPendingAction,
  DesktopAppAgentRunResult,
} from "../../../../../electron/ipc-types";
import {
  visibleAppAgentChoices,
  visibleAppAgentExecutionJournal,
  visibleAppAgentPlan,
} from "../../../domain/app-agent";

const props = defineProps<{
  busy: boolean;
  result: DesktopAppAgentRunResult | null;
}>();

defineEmits<{
  "select-action": [action: DesktopAppAgentActionReference];
  "confirm-action": [action: DesktopAppAgentActionReference];
  "confirm-plan": [plan: DesktopAppAgentActionPlan];
  cancel: [];
}>();

const choices = computed(() => visibleAppAgentChoices(props.result));
const pendingPlan = computed(() => visibleAppAgentPlan(props.result));
const pendingAction = computed(() =>
  props.result?.state === "confirmation_required" && !pendingPlan.value
    ? props.result.pendingAction || null
    : null,
);
const visiblePlanActions = computed(() => pendingPlan.value?.actions.slice(0, 5) || []);
const hiddenPlanActionCount = computed(() =>
  Math.max(0, (pendingPlan.value?.actions.length || 0) - visiblePlanActions.value.length),
);
const executionJournal = computed(() => visibleAppAgentExecutionJournal(props.result));

function toActionReference(
  action: DesktopAppAgentActionChoice | DesktopAppAgentPendingAction,
): DesktopAppAgentActionReference {
  return {
    actionId: action.actionId,
    input: action.input,
    label: action.label,
    description: action.description,
    risk: action.risk,
  };
}

function actionIcon(actionId: string) {
  if (actionId.includes("archive")) return Archive;
  if (actionId.includes("open")) return ExternalLink;
  if (actionId.includes("settings")) return Settings;
  if (actionId.includes("storage")) return SlidersHorizontal;
  return Pin;
}
</script>
