<template>
  <section
    v-if="timeline.length || result?.message"
    class="app-agent-progress"
    data-testid="app-agent-progress"
  >
    <div
      v-if="currentPhase"
      class="app-agent-live-status"
      :data-state="currentPhase.state"
    >
      <AppAgentOrb
        :label="currentPhase.label"
        root-class="app-agent-liquid-orb"
        :show-icon="false"
        :state="liveOrbState"
        decorative
        variant="live"
      />
      <span class="app-agent-live-copy">
        <strong>{{ currentPhase.label }}</strong>
        <small v-if="currentPhase.detail">{{ currentPhase.detail }}</small>
      </span>
    </div>

    <ol
      v-if="timeline.length"
      class="app-agent-timeline"
      aria-label="App Agent progress"
      data-testid="app-agent-timeline"
    >
      <li
        v-for="item in timeline"
        :key="item.id"
        :data-state="item.state"
        :title="item.detail || item.label"
      >
        <span class="app-agent-timeline-dot" aria-hidden="true">
          <Check v-if="item.state === 'done'" />
          <X v-else-if="item.state === 'error'" />
          <LoaderCircle v-else-if="item.state === 'active'" />
        </span>
        <span class="app-agent-timeline-copy sr-only">
          <strong>{{ item.label }}</strong>
          <small v-if="item.detail">{{ item.detail }}</small>
        </span>
      </li>
    </ol>

    <p
      v-if="showMessage"
      class="app-agent-message"
      :data-state="messageState"
      data-testid="app-agent-message"
    >
      {{ messageText }}
    </p>
  </section>

  <details
    v-if="result?.trace?.length"
    class="app-agent-trace"
    data-testid="app-agent-trace"
  >
    <summary>Activity</summary>
    <ol>
      <li
        v-for="entry in displayTrace"
        :key="entry.id"
        :data-state="entry.status"
      >
        <span>{{ entry.label }}</span>
        <small v-if="entry.detail">{{ entry.detail }}</small>
      </li>
    </ol>
  </details>
</template>

<script setup lang="ts">
import { Check, LoaderCircle, X } from "@lucide/vue";
import { computed } from "vue";
import type { DesktopAppAgentRunResult } from "../../../../../electron/ipc-types";
import {
  appAgentCurrentPhase,
  appAgentSurfaceState,
  appAgentTimeline,
  appAgentTraceDisplayEntry,
} from "../../../domain/app-agent";
import AppAgentOrb from "./AppAgentOrb.vue";

const props = defineProps<{
  busy: boolean;
  result: DesktopAppAgentRunResult | null;
}>();

const timeline = computed(() =>
  appAgentTimeline({
    busy: props.busy,
    result: props.result,
  }),
);
const displayTrace = computed(() =>
  (props.result?.trace || []).map((entry) => appAgentTraceDisplayEntry(entry)),
);
const currentPhase = computed(() =>
  appAgentCurrentPhase({
    busy: props.busy,
    result: props.result,
  }),
);
const liveOrbState = computed(() =>
  appAgentSurfaceState({
    busy: props.busy,
    result: props.result,
  }),
);
const showMessage = computed(() =>
  Boolean(props.result?.message && props.result.state !== "success"),
);
const messageState = computed(() => props.result?.state || "error");
const messageText = computed(() => props.result?.message || "");
</script>
