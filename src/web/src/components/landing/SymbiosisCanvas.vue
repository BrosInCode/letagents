<template>
  <div class="handoff-stage" :data-theme-mode="theme" ref="stage">
    <canvas ref="canvas" aria-hidden="true" :class="{ unavailable: !canvasAvailable }" />
    <button v-if="canAnimate" class="handoff-motion" type="button" @click="paused = !paused"
      :aria-label="paused ? 'Play room animation' : 'Pause room animation'">
      <span v-if="paused" aria-hidden="true">▶</span><span v-else aria-hidden="true">Ⅱ</span>
    </button>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { createHandoffPainter, handoffStillTime } from './room-handoff.js'

defineProps({ theme: { type: String, default: 'dark' } })

const stage = ref(null)
const canvas = ref(null)
const paused = ref(false)
const canAnimate = ref(false)
const canvasAvailable = ref(false)
let dispose

onMounted(() => {
  const surface = canvas.value
  const context = surface?.getContext('2d')
  if (!surface || !stage.value || !context) return

  const render = createHandoffPainter(context)
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
  const compact = window.matchMedia('(max-width: 768px)')
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)')
  const preferences = [reduce, compact, fine]
  canvasAvailable.value = true
  const still = () => reduce.matches || compact.matches || !fine.matches
  let width = 0
  let height = 0
  let elapsed = 0
  let lastFrame = 0
  let frame = 0
  let inView = true

  function draw() {
    const staticFrame = still()
    if (canvasAvailable.value) render(width, height, staticFrame ? handoffStillTime : elapsed, !staticFrame)
  }

  function tick(now) {
    frame = 0
    if (lastFrame && now - lastFrame < 29) {
      frame = window.requestAnimationFrame(tick)
      return
    }
    if (lastFrame) elapsed += Math.min((now - lastFrame) / 1000, .06)
    lastFrame = now
    draw()
    frame = window.requestAnimationFrame(tick)
  }

  function updatePlayback() {
    canAnimate.value = canvasAvailable.value && !still()
    window.cancelAnimationFrame(frame)
    frame = 0
    lastFrame = 0
    if (!canvasAvailable.value) return
    if (still()) {
      if (inView && !document.hidden) draw()
    } else if (!paused.value && inView && !document.hidden && width && height) frame = window.requestAnimationFrame(tick)
  }

  function configureSurface() {
    if (!width || !height) return
    const density = Math.min(window.devicePixelRatio || 1, compact.matches ? 1.5 : 1.75, Math.sqrt(3_000_000 / (width * height)))
    surface.width = Math.round(width * density)
    surface.height = Math.round(height * density)
    context.setTransform(density, 0, 0, density, 0, 0)
  }
  const resize = new ResizeObserver(([entry]) => {
    const { width: nextWidth, height: nextHeight } = entry.contentRect
    if (width === nextWidth && height === nextHeight) return
    width = nextWidth
    height = nextHeight
    configureSurface()
    if (canAnimate.value && inView && !document.hidden) draw()
    updatePlayback()
  })
  resize.observe(stage.value)
  const visibility = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting
    updatePlayback()
  })
  visibility.observe(stage.value)
  const stopPause = watch(paused, updatePlayback)
  function onContextLost() {
    canvasAvailable.value = false
    updatePlayback()
  }
  function onContextRestored() {
    canvasAvailable.value = true
    configureSurface()
    if (paused.value && !still() && inView && !document.hidden) draw()
    updatePlayback()
  }
  surface.addEventListener('contextlost', onContextLost)
  surface.addEventListener('contextrestored', onContextRestored)
  for (const preference of preferences) preference.addEventListener('change', updatePlayback)
  document.addEventListener('visibilitychange', updatePlayback)

  dispose = () => {
    window.cancelAnimationFrame(frame)
    stopPause()
    resize.disconnect()
    visibility.disconnect()
    surface.removeEventListener('contextlost', onContextLost)
    surface.removeEventListener('contextrestored', onContextRestored)
    for (const preference of preferences) preference.removeEventListener('change', updatePlayback)
    document.removeEventListener('visibilitychange', updatePlayback)
  }
})

onUnmounted(() => dispose?.())
</script>

<style scoped>
.handoff-stage {
  position: relative;
  width: min(100%, 980px);
  height: clamp(190px, 36svh, 410px);
  flex: none;
  overflow: hidden;
  background: radial-gradient(ellipse 45% 50% at 50% 53%, #5dba9817, transparent 100%);
}

.handoff-stage canvas {
  display: block;
  pointer-events: none;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  mask-image: radial-gradient(ellipse 77% 79% at 50% 51%, #000 38%, transparent 92%);
}

.handoff-stage canvas.unavailable { visibility: hidden; }

.handoff-motion {
  position: absolute;
  inset: auto 5px 5px auto;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--l-text-sub);
  font: 600 12px/1 system-ui;
  cursor: pointer;
}
.handoff-motion:is(:hover, :focus-visible) { background: color-mix(in srgb, currentColor 10%, transparent); }
.handoff-motion:focus-visible { outline: 2px solid currentColor; }

.handoff-stage[data-theme-mode="light"] canvas {
  filter: brightness(.59) saturate(1.4);
}
</style>
