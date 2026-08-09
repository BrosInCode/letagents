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

    <ol v-if="presented.length" class="agent-inspector-live-items">
      <li
        v-for="entry in presented"
        :key="`${entry.item.kind}:${entry.item.id}`"
        class="agent-inspector-live-item"
        :data-kind="entry.item.kind"
      >
        <template v-if="entry.item.kind === 'reasoning'">
          <span class="agent-inspector-live-label">Thinking</span>
          <p class="agent-inspector-live-reasoning">{{ entry.item.text }}</p>
        </template>
        <template v-else-if="entry.item.kind === 'message'">
          <span
            class="agent-inspector-live-label"
            title="Live narration from the model while it works. It is never published; the room reply is only what the agent records with complete_room_turn."
          >Working aloud</span>
          <p class="agent-inspector-live-message">{{ entry.item.text }}</p>
        </template>
        <template v-else-if="entry.tool">
          <div class="agent-inspector-live-tool-head">
            <span class="agent-inspector-live-label">{{ entry.tool.kind === "reply" ? "Room reply" : "Action" }}</span>
            <strong>{{ entry.tool.headline }}</strong>
            <span class="agent-inspector-live-tool-status" :data-status="entry.item.status">{{ entry.item.status }}</span>
          </div>
          <blockquote v-if="entry.tool.replyText" class="agent-inspector-live-reply">{{ entry.tool.replyText }}</blockquote>
          <p v-else-if="entry.tool.detail" class="agent-inspector-live-tool-detail">{{ entry.tool.detail }}</p>
          <p v-if="entry.item.error" class="agent-inspector-live-tool-error">{{ entry.item.error }}</p>
          <details
            v-if="formatValue(entry.item.input) || formatValue(entry.item.output)"
            class="agent-inspector-live-tool-raw"
          >
            <summary>Raw {{ entry.tool.toolName }} call</summary>
            <pre v-if="formatValue(entry.item.input)" class="agent-inspector-live-tool-io">{{ formatValue(entry.item.input) }}</pre>
            <pre v-if="formatValue(entry.item.output)" class="agent-inspector-live-tool-io">{{ formatValue(entry.item.output) }}</pre>
          </details>
        </template>
      </li>
    </ol>

    <p v-if="feed.droppedEvents > 0" class="agent-inspector-settings-note" role="status">
      {{ feed.droppedEvents }} earlier live {{ feed.droppedEvents === 1 ? "event was" : "events were" }} omitted because this turn exceeded the replay limit.
    </p>

    <p v-if="!presented.length" class="agent-inspector-live-empty">
      {{ transcript.ended ? "The agent's runtime is not currently streaming." : "Waiting for the agent's next activity…" }}
    </p>

    <p class="agent-inspector-live-footer" :data-ended="transcript.ended">
      <span aria-hidden="true"></span>{{ transcript.ended ? "Live feed closed" : "Live" }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { describeLiveToolCall, foldAgentStreamEvents } from "../../../../domain/agent-inspector-live";
import type { LiveToolPresentation, LiveTranscriptItem } from "../../../../domain/agent-inspector-live";
import type { DesktopAgentStreamEvent } from "../../../../../../electron/ipc-types";

const props = defineProps<{
  feed: { events: readonly DesktopAgentStreamEvent[]; ended: boolean; droppedEvents: number };
  supportsReasoning: boolean | null;
}>();

const transcript = computed(() => foldAgentStreamEvents(props.feed.events, props.feed.ended));

const presented = computed((): { item: LiveTranscriptItem; tool: LiveToolPresentation | null }[] =>
  transcript.value.items.map((item) => ({
    item,
    tool: item.kind === "tool" ? describeLiveToolCall(item.tool, item.input) : null,
  })));

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
</script>
