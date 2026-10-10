<template>
  <Transition :css="false" @enter="enter" @leave="leave" @enter-cancelled="interrupt" @leave-cancelled="interrupt" @after-leave="interrupt">
    <slot />
  </Transition>
</template>

<script setup lang="ts">
import { onBeforeUnmount } from 'vue'

// An inline disclosure must move the following room messages with it. Measure
// once, then animate only this bounded container; never scale the reply text.
let running: { element: HTMLElement; animation: Animation; fromHeight: number; toHeight: number; fromOpacity: number; toOpacity: number } | null = null
let observer: ResizeObserver | null = null
let interrupted: { height: number; opacity: string } | null = null

function interrupt(target?: Element) {
  if (!running || (target && running.element !== target)) return
  observer?.disconnect()
  observer = null
  const { element, animation } = running
  // Vue may finish a v-if leave early and detach its node when it reopens.
  // Preserve the current visual progress before canceling that old animation.
  const progress = Number(animation.effect?.getComputedTiming().progress ?? 0)
  interrupted = {
    height: running.fromHeight + (running.toHeight - running.fromHeight) * progress,
    opacity: String(running.fromOpacity + (running.toOpacity - running.fromOpacity) * progress),
  }
  animation.cancel()
  element.style.height = `${interrupted.height}px`
  element.style.opacity = interrupted.opacity
  running = null
}

function animate(element: HTMLElement, open: boolean, done: () => void, duration = open ? 240 : 180) {
  const previous = interrupted
  interrupted = null
  const fromHeight = open ? previous?.height ?? 0 : element.getBoundingClientRect().height
  const fromOpacity = open ? previous?.opacity ?? '0' : getComputedStyle(element).opacity
  element.style.height = 'auto'
  const toHeight = open ? element.getBoundingClientRect().height : 0
  element.style.overflow = 'hidden'
  element.inert = !open

  const finish = () => {
    observer?.disconnect()
    observer = null
    running = null
    element.style.height = ''
    element.style.opacity = ''
    element.style.overflow = ''
    element.inert = false
    done()
  }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return }

  const animation = element.animate([
    { height: `${fromHeight}px`, opacity: fromOpacity },
    { height: `${toHeight}px`, opacity: open ? '1' : '0' },
  ], { duration, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both' })
  running = { element, animation, fromHeight, toHeight, fromOpacity: Number(fromOpacity), toOpacity: open ? 1 : 0 }
  // Replies can arrive while an empty/loading thread is still opening.
  // Observe its content, not the animated wrapper, and continue from the
  // current frame if that content grows or shrinks.
  const content = element.firstElementChild
  if (open && content && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      if (running?.animation !== animation) return
      const style = getComputedStyle(content)
      const height = content.getBoundingClientRect().height + parseFloat(style.marginTop || '0') + parseFloat(style.marginBottom || '0')
      if (Math.abs(height - toHeight) < 1) return
      const remaining = Math.max(80, duration - Number(animation.currentTime ?? 0))
      interrupt(element)
      animate(element, true, done, remaining)
    })
    observer.observe(content)
  }
  animation.onfinish = () => {
    if (running?.animation !== animation) return
    animation.cancel()
    finish()
  }
}
function enter(element: Element, done: () => void) { animate(element as HTMLElement, true, done) }
function leave(element: Element, done: () => void) { animate(element as HTMLElement, false, done) }
onBeforeUnmount(() => { observer?.disconnect(); running?.animation.cancel(); running = null })
</script>

<style>
.room-inline-thread, .web-thread-disclosure { display: flow-root; min-width: 0; }
</style>
