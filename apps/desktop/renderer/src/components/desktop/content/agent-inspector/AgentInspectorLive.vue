<template>
  <div class="agent-inspector-live">
    <p class="agent-inspector-settings-note">
      {{ supportsReasoning === true
        ? "A live tail of this agent's reasoning, response, and tool calls while it works."
        : supportsReasoning === false
          ? "A live tail of this agent's response and tool calls while it works. This provider does not expose private reasoning."
          : "A live tail of this agent's provider-exposed response and tool calls while it works." }}
      Ephemeral — opening this tab replays the bounded current feed, then follows new activity. It is not a saved transcript.
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
          <pre v-if="formatValue(item.output)" class="agent-inspector-live-tool-io">{{ formatValue(item.output) }}</pre>
          <p v-if="item.error" class="agent-inspector-live-tool-error">{{ item.error }}</p>
        </template>
      </li>
    </ol>

    <p v-if="feed.droppedEvents > 0" class="agent-inspector-settings-note" role="status">
      {{ feed.droppedEvents }} earlier live {{ feed.droppedEvents === 1 ? "event was" : "events were" }} omitted because this turn exceeded the replay limit.
    </p>

    <p v-if="!transcript.items.length" class="agent-inspector-live-empty">
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
  feed: { events: readonly DesktopAgentStreamEvent[]; ended: boolean; droppedEvents: number };
  supportsReasoning: boolean | null;
}>();

const transcript = computed(() => foldAgentStreamEvents(props.feed.events, props.feed.ended));

function formatValue(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  try {
    const text = JSON.stringify(input, null, 2);
    return text === "{}" ? "" : text;
  } catch {
    return "";
  }
}

const formatInput = formatValue;
</script>
