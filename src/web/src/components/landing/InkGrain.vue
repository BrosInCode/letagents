<template>
  <div class="ink-grain" :style="{ backgroundImage: grain }" aria-hidden="true" />
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

// A film grain over the dark ground: one 160 px tile of random grey, made once on mount and
// repeated by the browser. The landing page and the docs share it.
const grain = ref('')

onMounted(() => {
  const tile = document.createElement('canvas')
  tile.width = tile.height = 160
  const context = tile.getContext('2d')
  if (!context) return
  const image = context.createImageData(160, 160)
  for (let i = 0; i < image.data.length; i += 4) {
    const value = Math.random() * 255
    image.data[i] = image.data[i + 1] = image.data[i + 2] = value
    image.data[i + 3] = 255
  }
  context.putImageData(image, 0, 0)
  grain.value = `url(${tile.toDataURL()})`
})
</script>

<style scoped>
.ink-grain { position: absolute; inset: 0; z-index: -1; opacity: .045; pointer-events: none; }
</style>
