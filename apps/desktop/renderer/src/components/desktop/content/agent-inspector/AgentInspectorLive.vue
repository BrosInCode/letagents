<template>
  <div class="agent-inspector-live">
    <p class="agent-inspector-settings-note">
      A live tail of this agent's reasoning, replies, and tool calls while it works. Ephemeral — it starts when you open this tab and is not a saved transcript.
    </p>

    <ol v-if="transcript.items.length" class="agent-inspector-live-items">
      <li
        v-for="item in transcript.items"
        :key="`${item.kind}:${item.id}`"
        class="agent-inspector-live-item"
        :data-kind="item.kind"
      >
        <template v-if="item.kind === 'reasoning'">
          <span class="agent-inspector-live-label">Thinking</span>
          <p class="agent-inspector-live-reasoning">{{ item.text }}</p>
        </template>
        <template v-else-if="item.kind === 'message'">
          <span class="agent-inspector-live-label">Response</span>
          <p class="agent-inspector-live-message">{{ item.text }}</p>
        </template>
        <template v-else>
          <div class="agent-inspector-live-tool-head">
            <span class="agent-inspector-live-label">Tool</span>
            <strong>{{ item.tool }}</strong>
            <span class="agent-inspector-live-tool-status" :data-status="item.status">{{ item.status }}</span>
          </div>
          <pre v-if="formatInput(item.input)" class="agent-inspector-live-tool-io">{{ formatInput(item.input) }}</pre>
          <pre v-if="item.output" class="agent-inspector-live-tool-io">{{ item.output }}</pre>
          <p v-if="item.error" class="agent-inspector-live-tool-error">{{ item.error }}</p>
        </template>
      </li>
    </ol>

    <p v-else class="agent-inspector-live-empty">
      {{ transcript.ended ? "The agent's runtime is not currently streaming." : "Waiting for the agent's next activity…" }}
    </p>

    <p class="agent-inspector-live-footer" :data-ended="transcript.ended">
      <span aria-hidden="true"></span>{{ transcript.ended ? "Live feed closed" : "Live" }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { foldAgentStreamEvents } from "../../../../domain/agent-inspector-live";
import type { DesktopAgentStreamEvent } from "../../../../../../electron/ipc-types";

const props = defineProps<{
  feed: { events: readonly DesktopAgentStreamEvent[]; ended: boolean };
}>();

const transcript = computed(() => foldAgentStreamEvents(props.feed.events, props.feed.ended));

function formatInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  try {
    const text = JSON.stringify(input, null, 2);
    return text === "{}" ? "" : text;
  } catch {
    return "";
  }
}
</script>
