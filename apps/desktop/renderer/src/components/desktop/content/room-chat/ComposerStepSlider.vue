<template>
  <div class="desktop-step-slider" :data-kind="kind">
    <div class="desktop-step-slider-head">
      <span :id="labelId">{{ label }}</span>
      <span class="desktop-step-slider-value" aria-hidden="true">{{ stops[shownIndex] }}</span>
    </div>
    <div
      ref="control"
      class="desktop-step-slider-control"
      role="slider"
      tabindex="0"
      :aria-labelledby="labelId"
      aria-valuemin="0"
      :aria-valuemax="Math.max(0, stops.length - 1)"
      :aria-valuenow="shownIndex"
      :aria-valuetext="stops[shownIndex]"
      :data-dragging="dragging || undefined"
      :data-testid="`desktop-composer-agent-${kind}-slider`"
      @pointerdown="startDrag"
      @pointermove="moveDrag"
      @pointerup="endDrag"
      @pointercancel="cancelDrag"
      @keydown="handleKey"
    >
      <div ref="track" class="desktop-step-slider-track">
        <div class="desktop-step-slider-fill" :style="{ width: `${percent}%` }"></div>
        <i
          v-for="(_, stop) in stops"
          :key="stop"
          :style="{ left: `${stops.length > 1 ? (stop / (stops.length - 1)) * 100 : 0}%` }"
          :data-on="stop <= shownIndex"
        ></i>
        <div class="desktop-step-slider-thumb" :style="{ left: `${percent}%` }"></div>
      </div>
    </div>
    <div class="desktop-step-slider-ends" aria-hidden="true">
      <span>{{ stops[0] }}</span><span>{{ stops[stops.length - 1] }}</span>
    </div>
    <p v-if="note" class="desktop-step-slider-note">{{ note }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
  kind: string;
  label: string;
  stops: readonly string[];
  index: number;
  note?: string | null;
}>();

const emit = defineEmits<{
  "update:index": [index: number];
}>();

const labelId = `desktop-step-slider-${Math.random().toString(36).slice(2, 10)}`;
const control = ref<HTMLElement | null>(null);
const track = ref<HTMLElement | null>(null);
// While dragging, the thumb follows the pointer 1:1; it snaps to a stop on release.
const dragPosition = ref<number | null>(null);
const dragging = computed(() => dragPosition.value !== null);
const last = computed(() => Math.max(0, props.stops.length - 1));
const clampedIndex = computed(() => Math.min(last.value, Math.max(0, props.index)));
const position = computed(() => dragPosition.value ?? clampedIndex.value);
const shownIndex = computed(() => Math.round(position.value));
const percent = computed(() => last.value > 0 ? (position.value / last.value) * 100 : 0);

function positionAt(clientX: number): number {
  const rect = track.value?.getBoundingClientRect();
  if (!rect || rect.width <= 0) return clampedIndex.value;
  return Math.min(last.value, Math.max(0, ((clientX - rect.left) / rect.width) * last.value));
}

function commit(index: number): void {
  const next = Math.min(last.value, Math.max(0, index));
  if (next !== clampedIndex.value) emit("update:index", next);
}

function startDrag(event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  control.value?.focus({ preventScroll: true });
  control.value?.setPointerCapture?.(event.pointerId);
  dragPosition.value = positionAt(event.clientX);
}

function moveDrag(event: PointerEvent): void {
  if (dragPosition.value !== null) dragPosition.value = positionAt(event.clientX);
}

function endDrag(event: PointerEvent): void {
  if (dragPosition.value === null) return;
  const index = Math.round(positionAt(event.clientX));
  dragPosition.value = null;
  commit(index);
}

function cancelDrag(): void {
  dragPosition.value = null;
}

function handleKey(event: KeyboardEvent): void {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (step === undefined && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  event.stopPropagation();
  commit(event.key === "Home" ? 0 : event.key === "End" ? last.value : clampedIndex.value + (step ?? 0));
}

defineExpose({ focus: () => control.value?.focus({ preventScroll: true }) });
</script>
