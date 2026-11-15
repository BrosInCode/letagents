<template>
  <RoomAgentStartupRow
    v-if="view"
    :view="view"
    :inspectable="Boolean(launchHost?.openAgent)"
    @inspect="launchHost?.openAgent?.($event)"
    @retry="emit('retry', $event)"
    @cancel="emit('cancel', $event)"
    @setup="emit('setup', $event)"
  />
</template>

<script setup lang="ts">
import { composerAgentLaunchKey } from "./composer-agent-launch";
import { computed, inject } from "vue";
import { useNow } from "../../../../composables/useNow";
import type { AgentStartupView } from "../../../../domain/agent-startup";
import RoomAgentStartupRow from "./RoomAgentStartupRow.vue";

/*
 * One start-up row in the timeline. The row reads its own view and clock, so
 * a second's tick or a stage change redraws this row and not the message list.
 */
const props = defineProps<{
  entryId: string;
  viewFor: (entryId: string, nowMs: number) => AgentStartupView | null;
}>();
const emit = defineEmits<{
  retry: [entryId: string];
  cancel: [entryId: string];
  setup: [entryId: string];
}>();

const launchHost = inject(composerAgentLaunchKey, null);

// The clock moves only while the row is still starting.
const now = useNow(1_000, () => view.value?.status === "running");
const view = computed(() => props.viewFor(props.entryId, now.value));
</script>
