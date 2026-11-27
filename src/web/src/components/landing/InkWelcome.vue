<template>
  <section ref="root" class="welcome" :data-skipped="skipped" :data-fallback="fallback" :style="markStyle"
    aria-labelledby="welcome-title" @pointerdown="onPress" @keydown="onPress" @focusin="ink.skip()" @pointermove="ink.stir">
    <canvas v-if="!fallback" ref="sceneCanvas" class="welcome-scene" :data-veiled="veiled" aria-hidden="true" />
    <div v-else class="welcome-mark" aria-hidden="true">
      <svg viewBox="-12 -12 152 152">
        <defs>
          <linearGradient id="welcome-marble" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stop-color="#bf6026" />
            <stop offset=".45" stop-color="#a8774a" />
            <stop offset="1" stop-color="#32b381" />
          </linearGradient>
        </defs>
        <g fill="none" stroke="url(#welcome-marble)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
          <path d="M35 0H93C112.33 0 128 15.67 128 35V47" />
          <path d="M128 81V93C128 112.33 112.33 128 93 128H35C15.67 128 0 112.33 0 93V35C0 15.67 15.67 0 35 0" />
          <path d="M34 95L64 27L94 95" />
          <path d="M46 68H82" />
        </g>
        <circle cx="128" cy="64" r="5" fill="#7fe0bd" />
      </svg>
    </div>
    <div class="welcome-grain" :style="{ backgroundImage: grain }" aria-hidden="true" />

    <div ref="copy" class="welcome-copy">
      <h1 id="welcome-title">
        <span class="line"><span>Humans and agents,</span></span>
        <span class="line line-muted"><span>working as one.</span></span>
      </h1>

      <div id="download-mac" class="downloads reveal" role="group" aria-label="Download the desktop app">
        <a v-for="(link, index) in downloadLinks" :key="link.href" class="download" :data-primary="index === 0"
          :href="link.href" :aria-label="`Download for ${link.label}`" @click="onDownload($event)">
          <span v-if="index === 0" class="download-glow" aria-hidden="true" />
          <span class="download-ring" aria-hidden="true"><span class="download-spin" /></span>
          <span class="download-face">
            <span class="download-icon" aria-hidden="true">
              <DesktopPlatformIcon v-if="link.icon" :icon="link.icon" />
              <svg v-else viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
            </span>
            <span class="download-text">
              <span class="download-name">{{ link.name }}</span>
            </span>
            <span class="download-arrow" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M12 4v13m0 0-5.5-5.5M12 17l5.5-5.5M5 20.5h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </span>
          </span>
        </a>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import DesktopPlatformIcon from './DesktopPlatformIcon.vue'
import { useInkScene, type InkMarkPlacement } from '../../../../../shared/ui/ink/useInkScene'
import {
  desktopDownloadOffer,
  detectDesktopVisitorPlatform,
  fetchCurrentMacDesktopBeta,
  MAC_DESKTOP_BETA,
} from '@/domain/desktopRelease'

// ---- Desktop downloads: the main action, and the site's download anchor (`/#download-mac`).
// The visitor's own platform comes first and is the lit button.
const macDesktopBeta = ref(MAC_DESKTOP_BETA)
const visitorPlatform = detectDesktopVisitorPlatform(typeof navigator === 'undefined' ? undefined : navigator)
const downloadLinks = computed(() => {
  const offer = desktopDownloadOffer(macDesktopBeta.value, visitorPlatform)
  return [offer.primary, ...offer.others].map((link) => {
    // The visible name is short ("Mac"); the full label stays in the link's accessible name.
    return { ...link, name: link.label.split(' · ')[0] }
  })
})

// ---- The ink scene (shared with the desktop onboarding): plays the opening once, then rests.
// It wakes only when the visitor stirs it with the pointer or presses a download, so an idle
// page does no GPU work. The shared driver holds the performance guards.
const root = ref<HTMLElement | null>(null)
const copy = ref<HTMLElement | null>(null)
const sceneCanvas = ref<HTMLCanvasElement | null>(null)
const grain = ref('')
const markStyle = ref<Record<string, string>>({})

// The mark forms in the free space between the navigation bar and the copy.
function placeMark(): InkMarkPlacement {
  const section = root.value?.getBoundingClientRect()
  const copyTop = copy.value?.getBoundingClientRect().top
  if (!section || copyTop === undefined || !section.height) return { center: [.5, .66], height: .3 }
  const navBottom = (document.querySelector('.navbar')?.getBoundingClientRect().bottom ?? 64) - section.top
  const free = Math.max(80, copyTop - section.top - navBottom)
  const middle = navBottom + free / 2
  const height = Math.min(.3, Math.max(.12, (free * .74) / section.height))
  const size = Math.min(height * section.height, section.width * .55)
  markStyle.value = { '--mark-top': `${middle}px`, '--mark-size': `${size}px` }
  return { center: [.5, 1 - middle / section.height], height }
}

const ink = useInkScene({ canvas: sceneCanvas, placeMark })
const { fallback, veiled, skipped } = ink

// The static mark has no scene to make again, so it follows the layout here.
function onFallbackResize() {
  if (fallback.value) placeMark()
}

// A first look should never hold anyone up: a press anywhere but a link finishes the scene.
// Keyboard focus on a download (still faded out early in the opening) finishes it too.
function onPress(event: Event) {
  if ((event.target as HTMLElement).closest('button, a')) return
  ink.skip()
}

// The agent answers a download press: a ring from the dot, and mint ink streams toward the button.
function onDownload(event: MouseEvent) {
  ink.pulseToward(event.currentTarget as HTMLElement)
}

function makeGrain() {
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
}


onMounted(() => {
  void fetchCurrentMacDesktopBeta()
    .then((release) => { macDesktopBeta.value = release })
    .catch(() => { /* Keep the bundled fallback. */ })
  makeGrain()
  window.addEventListener('resize', onFallbackResize)
})

onUnmounted(() => window.removeEventListener('resize', onFallbackResize))
</script>

<style scoped>
.welcome {
  --ink: #efeee6;
  --ink-2: rgba(239, 238, 230, .56);
  --ink-3: rgba(239, 238, 230, .32);
  --mint: #7fe0bd;
  --reveal: cubic-bezier(.19, 1, .22, 1);
  position: relative;
  isolation: isolate;
  overflow: hidden;
  display: grid;
  grid-template-rows: 1fr auto;
  width: 100%;
  height: 100vh;
  height: 100dvh;
  min-height: 620px;
  box-sizing: border-box;
  padding: 0 max(20px, env(safe-area-inset-right, 0px)) max(24px, env(safe-area-inset-bottom, 0px)) max(20px, env(safe-area-inset-left, 0px));
  background: #0a0b0a;
  color: var(--ink);
  text-align: center;
  -webkit-font-smoothing: antialiased;
}
.welcome-grain { position: absolute; inset: 0; z-index: -1; opacity: .045; pointer-events: none; }
/* The shader is the whole page, behind the type. */
.welcome-scene { position: absolute; inset: 0; z-index: -3; width: 100%; height: 100%; transition: opacity 450ms ease; }
/* Hidden at once while the ink is simulated again; it fades back in when ready. */
.welcome-scene[data-veiled="true"] { opacity: 0; transition: none; }
.welcome::after {
  content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background: radial-gradient(120% 90% at 50% 36%, transparent 50%, rgba(0, 0, 0, .6));
}

/* Static mark where WebGL2 half-float rendering is missing: the place and size the ink would form. */
.welcome-mark {
  position: absolute; z-index: -3; left: 50%; top: var(--mark-top, 34%);
  width: var(--mark-size, 30vh); height: var(--mark-size, 30vh); transform: translate(-50%, -50%);
  filter: drop-shadow(0 0 28px rgba(127, 224, 189, .16)) drop-shadow(0 0 48px rgba(191, 96, 38, .14));
  animation: fade 1.6s ease .2s both;
}
.welcome-mark svg { display: block; width: 100%; height: 100%; }

.welcome-copy {
  grid-row: 2;
  display: grid; justify-items: center;
  padding-bottom: clamp(20px, 5vh, 56px);
}
.welcome h1 {
  margin: 0; font-family: "Iowan Old Style", "New York", ui-serif, Georgia, serif;
  font-size: clamp(36px, 4.8vw, 68px); font-weight: 400; line-height: 1; letter-spacing: -.035em;
  font-feature-settings: "kern", "liga";
  color: var(--ink);
}
.line { display: block; overflow: hidden; padding-bottom: .08em; margin-bottom: -.08em; }
.line > span { display: inline-block; white-space: nowrap; animation: line-up 1.15s var(--reveal) both; }
.line:first-child > span { animation-delay: 3.15s; }
.line-muted > span { color: rgba(239, 238, 230, .3); animation-delay: 3.25s; }
.reveal { animation: fade-up 1s var(--reveal) both; }
.downloads.reveal { animation-delay: 3.45s; }
/* No shader: there is nothing to wait for, so the copy arrives at once. */
.welcome[data-fallback="true"] .line:first-child > span { animation-delay: .2s; }
.welcome[data-fallback="true"] .line-muted > span { animation-delay: .3s; }
.welcome[data-fallback="true"] .downloads.reveal { animation-delay: .52s; }

/* ---- The downloads: the main characters. */
.downloads {
  display: flex; flex-wrap: wrap; justify-content: center; gap: 12px;
  margin-top: clamp(30px, 5vh, 48px);
  scroll-margin-top: calc(92px + env(safe-area-inset-top, 0px));
}
/* Each button is an ink-edged slab: a slowly turning warm-and-mint edge (a transform, so the
   compositor turns it without repainting), a face above it, and a download arrow. The visitor's
   own platform is the lit slab with a coloured glow beneath it. */
.download {
  position: relative; isolation: isolate;
  display: block; width: 232px; height: 80px;
  border-radius: 22px; text-decoration: none; color: var(--ink);
  transition: transform 260ms cubic-bezier(.23, 1, .32, 1);
  touch-action: manipulation;
}
/* No fill: the ink shows only on the edge. The mask cuts the middle out of the ring. */
.download-ring {
  position: absolute; inset: 0; z-index: -1; overflow: hidden; border-radius: inherit;
  padding: 1.5px;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
  opacity: .55; transition: opacity 260ms ease;
}
.download[data-primary="true"] .download-ring { padding: 2px; opacity: 1; }
.download-spin {
  position: absolute; left: 50%; top: 50%; width: 400px; aspect-ratio: 1;
  background: conic-gradient(from 0deg, #f08a4b, rgba(240, 138, 75, 0) 22%, rgba(127, 224, 189, 0) 40%, #7fe0bd 52%, rgba(127, 224, 189, 0) 70%, rgba(240, 138, 75, 0) 82%, #f08a4b);
  transform: translate(-50%, -50%) rotate(0deg);
  animation: ink-turn 7s linear infinite;
  will-change: transform;
}
.download[data-primary="false"] .download-spin { animation-duration: 11s; }
/* A pool of both inks under the main button, outside its clear face. */
.download-glow {
  position: absolute; left: 18px; right: 18px; bottom: -22px; height: 22px; z-index: -2; border-radius: 50%;
  background: linear-gradient(90deg, rgba(240, 138, 75, .7), rgba(127, 224, 189, .75));
  filter: blur(18px); opacity: .7;
  transition: opacity 260ms ease, transform 260ms cubic-bezier(.23, 1, .32, 1);
}
.download-face {
  position: absolute; inset: 1.5px; border-radius: 20.5px;
  display: flex; align-items: center; justify-content: center; gap: 14px; padding: 0 20px;
  background: none;
  text-align: left;
}
.download[data-primary="true"] .download-face { inset: 2px; border-radius: 20px; }
.download-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: 0 0 30px; }
.download-icon :deep(svg), .download-icon > svg { width: 28px; height: 28px; }
.download-text { display: grid; flex: 0 0 auto; }
.download-name { font: 650 21px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: -.025em; white-space: nowrap; }
.download-arrow {
  display: grid; place-items: center; flex: 0 0 38px; width: 38px; height: 38px; border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(239, 238, 230, .16);
  transition: box-shadow 260ms ease;
}
.download[data-primary="true"] .download-arrow { box-shadow: inset 0 0 0 1px rgba(127, 224, 189, .55); color: #a8f0d4; }
.download-arrow svg { width: 17px; height: 17px; transition: transform 320ms cubic-bezier(.23, 1, .32, 1); }
@media (hover: hover) and (pointer: fine) {
  .download:hover { transform: translateY(-3px); }
  .download:hover .download-ring { opacity: 1; }
  .download:hover .download-glow { opacity: 1; transform: translateY(4px) scale(1.05); }
  .download:hover .download-arrow { box-shadow: inset 0 0 0 1px rgba(239, 238, 230, .4); }
  .download[data-primary="true"]:hover .download-arrow { box-shadow: inset 0 0 0 1px rgba(127, 224, 189, .9); }
  .download:hover .download-arrow svg { transform: translateY(2px); }
}
.download:active { transform: translateY(0) scale(.975); transition-duration: 120ms; }
.download:focus-visible { outline: 2px solid rgba(127, 224, 189, .85); outline-offset: 4px; }
@keyframes ink-turn { to { transform: translate(-50%, -50%) rotate(360deg); } }


/* Pressed during the scene: show everything at once, without the stagger. */
.welcome[data-skipped="true"] :is(.line > span, .reveal) { animation-delay: 0s !important; animation-duration: .45s !important; }

@keyframes line-up { from { transform: translateY(105%); } }
@keyframes fade-up { from { opacity: 0; transform: translateY(10px); } }
@keyframes fade { from { opacity: 0; } }

@media (prefers-reduced-motion: reduce) {
  .line > span, .reveal, .welcome-mark { animation: fade 400ms ease both !important; }
  .download, .download-ring, .download-glow, .download-arrow svg { transition: none; }
  .download-spin { animation: none; }
}

@media (max-width: 760px) {
  .welcome h1 { font-size: clamp(32px, 9.6vw, 44px); }
  .downloads { display: grid; grid-template-columns: 1fr 1fr; width: 100%; max-width: 420px; gap: 10px; }
  .download { width: auto; min-width: 0; height: 64px; border-radius: 18px; }
  .download[data-primary="true"] { grid-column: 1 / -1; height: 72px; }
  .download[data-primary="false"]:nth-child(2):last-child { grid-column: 1 / -1; }
  .download-face { gap: 10px; padding: 0 12px; border-radius: 16.5px; }
  .download[data-primary="true"] .download-face { gap: 14px; padding: 0 16px; border-radius: 16px; }
  .download[data-primary="false"] .download-arrow { display: none; }
  .download-icon { width: 24px; height: 24px; flex-basis: 24px; }
  .download-icon :deep(svg), .download-icon > svg { width: 22px; height: 22px; }
  .download-name { font-size: 16px; }
  .download[data-primary="true"] .download-name { font-size: 19px; }
}
</style>
