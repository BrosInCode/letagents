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
import { createHandoffPainter, handoffStillTime } from '../../../../../shared/ui/room-handoff.mjs'

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
  let scrollIdle
  let inView = true
  let needsDraw = true

  function draw() {
    const staticFrame = still()
    if (!canvasAvailable.value || !width || !height) return
    render(width, height, staticFrame ? handoffStillTime : elapsed, !staticFrame)
    needsDraw = false
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
    canAnimate.value = inView && canvasAvailable.value && !still()
    window.cancelAnimationFrame(frame)
    frame = 0
    lastFrame = 0
    const playing = canAnimate.value && !paused.value && !document.hidden
    if (playing) {
      window.addEventListener('scroll', onScroll, { passive: true })
    } else {
      window.removeEventListener('scroll', onScroll)
      clearTimeout(scrollIdle)
      scrollIdle = undefined
    }
    if (!canvasAvailable.value || document.hidden || !width || !height) return
    if (needsDraw) draw()
    if (playing && scrollIdle === undefined) frame = window.requestAnimationFrame(tick)
  }

  function onScroll() {
    const wasScrolling = scrollIdle !== undefined
    clearTimeout(scrollIdle)
    // Leave the last frame in place and give scrolling the frame budget.
    scrollIdle = setTimeout(() => {
      scrollIdle = undefined
      updatePlayback()
    }, 180)
    if (!wasScrolling) updatePlayback()
  }

  function configureSurface() {
    if (!width || !height) return
    const density = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(1_500_000 / (width * height)))
    surface.width = Math.max(1, Math.floor(width * density))
    surface.height = Math.max(1, Math.floor(height * density))
    context.setTransform(density, 0, 0, density, 0, 0)
    needsDraw = true
  }
  const resize = new ResizeObserver(([entry]) => {
    const { width: nextWidth, height: nextHeight } = entry.contentRect
    if (width === nextWidth && height === nextHeight) return
    width = nextWidth
    height = nextHeight
    configureSurface()
    updatePlayback()
  })
  resize.observe(stage.value)
  // The fixed canvas never leaves the viewport. Stop its loop when the hero leaves.
  const hero = stage.value.closest('.hero')
  const visibility = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting
    updatePlayback()
  }, { threshold: .01 })
  if (hero) visibility.observe(hero)
  const stopPause = watch(paused, updatePlayback)
  function onContextLost() {
    canvasAvailable.value = false
    updatePlayback()
  }
  function onContextRestored() {
    canvasAvailable.value = true
    configureSurface()
    updatePlayback()
  }
  function onMotionPreference() {
    configureSurface()
    updatePlayback()
  }
  surface.addEventListener('contextlost', onContextLost)
  surface.addEventListener('contextrestored', onContextRestored)
  for (const preference of preferences) preference.addEventListener('change', onMotionPreference)
  document.addEventListener('visibilitychange', updatePlayback)

  dispose = () => {
    window.cancelAnimationFrame(frame)
    window.removeEventListener('scroll', onScroll)
    clearTimeout(scrollIdle)
    stopPause()
    resize.disconnect()
    visibility.disconnect()
    surface.removeEventListener('contextlost', onContextLost)
    surface.removeEventListener('contextrestored', onContextRestored)
    for (const preference of preferences) preference.removeEventListener('change', onMotionPreference)
    document.removeEventListener('visibilitychange', updatePlayback)
  }
})

onUnmounted(() => dispose?.())
</script>

<style scoped>
.handoff-stage {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  background: radial-gradient(ellipse at 50% 50%, #5dba9817, transparent 65%);
}

.handoff-stage canvas {
  display: block;
  pointer-events: none;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: .62;
  mask-image: radial-gradient(ellipse 70% 74% at 50% 46%, #000 30%, transparent 82%);
}

.handoff-stage canvas.unavailable { visibility: hidden; }

.handoff-motion {
  position: absolute;
  inset: auto max(24px, env(safe-area-inset-right, 0px)) max(24px, env(safe-area-inset-bottom, 0px)) auto;
  pointer-events: auto;
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
  opacity: .56;
  filter: brightness(.59) saturate(1.4);
}
</style>
