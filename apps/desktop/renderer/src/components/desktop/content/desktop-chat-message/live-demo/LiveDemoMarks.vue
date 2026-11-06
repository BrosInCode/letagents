<template>
  <div class="live-demo-marks">
    <div class="live-demo-pop-title">
      <span>Marks</span>
      <button v-if="ownCount > 0" type="button" :disabled="busy" @click="$emit('clear-mine')">Clear mine</button>
    </div>
    <p v-if="rows.length === 0" class="live-demo-marks-empty">No marks yet. Click Pin or Draw to add one.</p>
    <ul v-else aria-label="Marks on this demo">
      <li
        v-for="row in rows"
        :key="row.key"
        class="live-demo-mark-row"
        :class="{ 'is-pending': row.pending }"
        :style="{ '--live-color': row.color }"
        @mouseenter="row.markId && $emit('highlight', row.markId)"
        @mouseleave="$emit('highlight', null)"
        @focusin="row.markId && $emit('highlight', row.markId)"
        @focusout="$emit('highlight', null)"
      >
        <i aria-hidden="true"></i>
        <div class="live-demo-mark-text">
          <strong>{{ row.author }}</strong>
          <span>{{ row.what }}</span>
        </div>
        <button
          v-if="row.own"
          class="live-demo-mark-delete"
          type="button"
          :aria-label="`Delete ${row.what}`"
          :disabled="busy"
          @click="row.pending ? $emit('cancel-pending', row.pendingKey!) : $emit('delete', row.markId!)"
        >
          <Trash2 :size="14" aria-hidden="true" />
        </button>
        <time v-else :datetime="row.createdAt">{{ row.age }}</time>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Trash2 } from "@lucide/vue";
import { describeMark, markAge } from "./marks";
import type { PendingMark } from "./pending-marks";
import type { DemoMark } from "./protocol";

const props = defineProps<{
  marks: readonly DemoMark[];
  pending: readonly PendingMark[];
  isOwn: (mark: DemoMark) => boolean;
  selfColor: string;
  /** A delete or a clear is on its way. */
  busy: boolean;
  now: number;
}>();

defineEmits<{
  delete: [id: string];
  "cancel-pending": [key: number];
  "clear-mine": [];
  highlight: [id: string | null];
}>();

interface Row {
  key: string;
  markId: string | null;
  pendingKey: number | null;
  pending: boolean;
  own: boolean;
  author: string;
  color: string;
  what: string;
  createdAt: string;
  age: string;
}

const ownCount = computed(() => props.pending.length + props.marks.filter((mark) => props.isOwn(mark)).length);

// Newest first. Pins carry the number they have on the demo.
const rows = computed<Row[]>(() => {
  let pinNumber = 0;
  const saved = props.marks.map((mark): Row => {
    const own = props.isOwn(mark);
    const what = mark.kind === "pin" ? `Pin ${++pinNumber}: ${describeMark(mark)}` : "Drawing";
    return {
      key: mark.id, markId: mark.id, pendingKey: null, pending: false, own,
      author: own ? "You" : mark.author.name, color: mark.author.color, what,
      createdAt: mark.createdAt, age: markAge(mark.createdAt, props.now),
    };
  });
  const waiting = props.pending.map((entry): Row => ({
    key: `pending-${entry.key}`, markId: null, pendingKey: entry.key, pending: true, own: true,
    author: "You", color: props.selfColor,
    what: `${entry.body.kind === "pin" ? `Pin ${++pinNumber}` : "Drawing"} · ${entry.waiting ? "not saved yet" : "saving"}`,
    createdAt: "", age: "",
  }));
  return [...saved, ...waiting].reverse();
});
</script>
