<template>
  <section v-if="visible" class="history-search" aria-label="Matches in this room">
    <p v-if="status === 'loading'" class="history-search-note" role="status">Searching earlier messages…</p>
    <p v-else-if="status === 'invalid'" class="history-search-note" role="status">{{ invalidText }}</p>
    <p v-else-if="status === 'error'" class="history-search-note history-search-error" role="alert">{{ error }}</p>
    <p v-else-if="!hits.length && !hasMore" class="history-search-note" role="status">No messages in this room match.</p>
    <template v-else>
      <h3 class="history-search-heading">
        <span>All matches in this room</span>
        <span class="history-search-count">{{ hits.length }}{{ hasMore ? "+" : "" }}</span>
      </h3>
      <ul class="history-search-list">
        <li v-for="hit in hits" :key="hit.id" class="history-search-hit" :data-expanded="expanded.has(hit.id)">
          <button
            class="history-search-hit-toggle"
            type="button"
            :aria-expanded="expanded.has(hit.id)"
            @click="toggle(hit.id)"
          >
            <span class="history-search-hit-meta">
              <strong>{{ hit.sender }}</strong>
              <time :datetime="hit.timestamp">{{ formatTime(hit.timestamp) }}</time>
            </span>
            <span class="history-search-hit-text">
              <template v-for="(segment, index) in segments(hit)" :key="index">
                <mark v-if="segment.match">{{ segment.text }}</mark>
                <template v-else>{{ segment.text }}</template>
              </template>
            </span>
          </button>
          <button class="history-search-hit-show" type="button" @click="emit('show', hit.id)">Show in room</button>
        </li>
      </ul>
      <p v-if="error" class="history-search-note history-search-error" role="alert">{{ error }}</p>
      <button v-if="hasMore" class="history-search-more" type="button" :disabled="loadingMore" @click="emit('more')">
        {{ loadingMore ? "Loading…" : "Show more" }}
      </button>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  MESSAGE_SEARCH_MAX_QUERY_CHARS,
  MESSAGE_SEARCH_MAX_TERMS,
  highlightMessageSearchText,
  messageSearchSnippet,
  type MessageSearchSegment,
} from "../message-search.mjs";

export interface MessageSearchHit {
  id: string;
  /** The name people see for the sender. */
  sender: string;
  timestamp: string;
  /** The text people read; rendered as plain text. */
  text: string;
}

const props = defineProps<{
  status: "idle" | "invalid" | "loading" | "ready" | "error";
  /** Every match in the room's history, newest first. */
  hits: readonly MessageSearchHit[];
  terms: readonly string[];
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
  /**
   * How many matches the open timeline's own find already shows. It also
   * matches sender and attachment names, so it can find what this list cannot;
   * the list then stays quiet instead of claiming there is nothing.
   */
  loadedMatchCount: number;
  formatTime: (timestamp: string) => string;
}>();

const emit = defineEmits<{
  /** Bring this message into view in the room. */
  show: [messageId: string];
  more: [];
}>();

const expanded = ref(new Set<string>());
// A new search starts with every result collapsed.
watch(() => props.terms.join("\n"), () => { expanded.value = new Set(); });

function toggle(messageId: string): void {
  const next = new Set(expanded.value);
  if (!next.delete(messageId)) next.add(messageId);
  expanded.value = next;
}

function segments(hit: MessageSearchHit): MessageSearchSegment[] {
  const text = expanded.value.has(hit.id) ? hit.text : messageSearchSnippet(hit.text, props.terms);
  return highlightMessageSearchText(text, props.terms);
}

const invalidText = computed(() => props.error === "too_many_terms"
  ? `Search for at most ${MESSAGE_SEARCH_MAX_TERMS} words or quoted phrases.`
  : `Search for at most ${MESSAGE_SEARCH_MAX_QUERY_CHARS} characters.`);
const visible = computed(() => props.status !== "idle"
  && !(props.status === "ready" && !props.hits.length && !props.hasMore && props.loadedMatchCount > 0));
</script>

<style src="./message-search.css"></style>
