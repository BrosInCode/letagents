<template>
  <Teleport to="body">
    <div class="desktop-image-viewer-backdrop" data-testid="desktop-image-viewer" @click.self="$emit('close')">
      <section
        ref="dialogElement"
        class="desktop-image-viewer-dialog"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        @keydown="handleKeydown"
      >
        <header class="desktop-image-viewer-header">
          <div>
            <p>{{ activeIndex + 1 }} of {{ images.length }}</p>
            <h2>{{ activeImage.name }}</h2>
            <span>{{ activeImage.meta }}</span>
          </div>
          <div class="desktop-image-viewer-actions">
            <button v-if="images.length > 1" type="button" @click="$emit('previous')">Previous</button>
            <button v-if="images.length > 1" type="button" @click="$emit('next')">Next</button>
            <a :href="activeImage.href" :download="activeImage.name">Download</a>
            <a :href="activeImage.href" target="_blank" rel="noopener noreferrer">Open original</a>
            <button type="button" @click="$emit('close')">Close</button>
          </div>
        </header>
        <figure class="desktop-image-viewer-stage">
          <img :src="activeImage.href" :alt="activeImage.name">
          <figcaption>{{ activeImage.sender }} · {{ activeImage.time }}</figcaption>
        </figure>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";

export interface DesktopMessageImage {
  id: string;
  href: string;
  name: string;
  meta: string;
  sender: string;
  time: string;
}

const props = defineProps<{
  images: DesktopMessageImage[];
  activeImageId: string;
}>();

const emit = defineEmits<{
  close: [];
  previous: [];
  next: [];
}>();

const dialogElement = ref<HTMLElement | null>(null);
let previousBodyOverflow = "";

const activeIndex = computed(() => Math.max(0, props.images.findIndex((image) => image.id === props.activeImageId)));
const activeImage = computed(() => props.images[activeIndex.value] || props.images[0]);

onMounted(() => {
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  void nextTick(() => dialogElement.value?.focus());
});

onUnmounted(() => {
  document.body.style.overflow = previousBodyOverflow;
});

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    dispatch("close");
  }
  if (event.key === "ArrowLeft" && props.images.length > 1) {
    event.preventDefault();
    dispatch("previous");
  }
  if (event.key === "ArrowRight" && props.images.length > 1) {
    event.preventDefault();
    dispatch("next");
  }
}

function dispatch(name: "close" | "previous" | "next"): void {
  if (name === "close") {
    emit("close");
    return;
  }
  if (name === "previous") {
    emit("previous");
    return;
  }
  emit("next");
}
</script>
