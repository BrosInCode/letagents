<template>
  <section id="symbiosis" ref="sectionEl" class="symbiosis-section">
    <div class="symbiosis-header">
      <div class="duality-badges">
        <span class="duality-badge duality-badge--human">
          <span class="badge-dot badge-dot--human" />
          Good for Humans
        </span>
        <span class="duality-sep" aria-hidden="true">×</span>
        <span class="duality-badge duality-badge--agent">
          <span class="badge-dot badge-dot--agent" />
          Good for Agents
        </span>
      </div>

      <h2 class="headline">
        You lead. <span class="headline-mint">They build.</span>
      </h2>
      <p class="subcopy">
        Say what you want once. Watch your agents split the work, check each other’s code,
        and hand you the finished result.
      </p>
    </div>

    <!-- HIGH-CRAFT 60FPS CHOREOGRAPHED MOTION STAGE -->
    <div
      class="motion-theatre"
      :data-phase="activePhaseIndex"
      @pointerleave="resumeLoop"
    >
      <!-- Ambient dynamic glow that shifts from Left (Human Pearl) -> Center (Agent Mint) -> Right (Shipped) -->
      <div
        class="theatre-ambient"
        :style="{
          '--glow-x': `${18 + timelineProgress * 64}%`,
          '--glow-mint': activePhaseIndex === 1 || activePhaseIndex === 2 ? '0.16' : '0.08',
        }"
      />

      <div class="theatre-canvas">
        <!-- SVG Bezier Circuit & Traveling 60fps Light Pulses -->
        <svg
          class="circuit-svg"
          viewBox="0 0 1000 420"
          fill="none"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="grad-human-split" x1="160" y1="210" x2="430" y2="210" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#f5f5f7" stop-opacity="0.65" />
              <stop offset="100%" stop-color="#2ac49f" stop-opacity="0.55" />
            </linearGradient>
            <linearGradient id="grad-agent-merge" x1="570" y1="210" x2="840" y2="210" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#2ac49f" stop-opacity="0.55" />
              <stop offset="100%" stop-color="#f5f5f7" stop-opacity="0.7" />
            </linearGradient>
            <linearGradient id="grad-review-arc" x1="500" y1="95" x2="500" y2="325" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#6ee7b7" />
              <stop offset="50%" stop-color="#2ac49f" />
              <stop offset="100%" stop-color="#6ee7b7" />
            </linearGradient>
            <filter id="pulse-glow" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <!-- Base architectural tracks -->
          <path d="M 185 210 C 285 210, 315 86, 415 86" class="track-base" />
          <path d="M 185 210 C 280 210, 320 210, 415 210" class="track-base" />
          <path d="M 185 210 C 285 210, 315 334, 415 334" class="track-base" />

          <path d="M 585 86 C 685 86, 715 210, 815 210" class="track-base" />
          <path d="M 585 210 C 680 210, 720 210, 815 210" class="track-base" />
          <path d="M 585 334 C 685 334, 715 210, 815 210" class="track-base" />

          <!-- Active illuminated split streams (Human -> 3 Agents) -->
          <path
            d="M 185 210 C 285 210, 315 86, 415 86"
            stroke="url(#grad-human-split)"
            class="track-active"
            :style="{ strokeDashoffset: splitDashOffset }"
          />
          <path
            d="M 185 210 C 280 210, 320 210, 415 210"
            stroke="url(#grad-human-split)"
            class="track-active"
            :style="{ strokeDashoffset: splitDashOffset }"
          />
          <path
            d="M 185 210 C 285 210, 315 334, 415 334"
            stroke="url(#grad-human-split)"
            class="track-active"
            :style="{ strokeDashoffset: splitDashOffset }"
          />

          <!-- Peer-Review Cross-Verification Bridge between Agents (Phase 2) -->
          <path
            d="M 500 118 L 500 302"
            stroke="url(#grad-review-arc)"
            class="review-bridge-line"
            :class="{ 'review-bridge-line--active': activePhaseIndex >= 2 }"
          />

          <!-- Active illuminated merge streams (3 Agents -> Shipped Result) -->
          <path
            d="M 585 86 C 685 86, 715 210, 815 210"
            stroke="url(#grad-agent-merge)"
            class="track-active"
            :style="{ strokeDashoffset: mergeDashOffset }"
          />
          <path
            d="M 585 210 C 680 210, 720 210, 815 210"
            stroke="url(#grad-agent-merge)"
            class="track-active"
            :style="{ strokeDashoffset: mergeDashOffset }"
          />
          <path
            d="M 585 334 C 685 334, 715 210, 815 210"
            stroke="url(#grad-agent-merge)"
            class="track-active"
            :style="{ strokeDashoffset: mergeDashOffset }"
          />

          <!-- 60fps Traveling Photon Pulses on the Left Split Curves -->
          <g v-if="splitPulseT > 0 && splitPulseT < 1" filter="url(#pulse-glow)">
            <circle :cx=" pulsePosLeft(0).x " :cy=" pulsePosLeft(0).y " r="4.5" fill="#f5f5f7" />
            <circle :cx=" pulsePosLeft(1).x " :cy=" pulsePosLeft(1).y " r="4.5" fill="#a7f3d0" />
            <circle :cx=" pulsePosLeft(2).x " :cy=" pulsePosLeft(2).y " r="4.5" fill="#2ac49f" />
          </g>

          <!-- 60fps Traveling Photon Pulses on the Peer-Review Bridge -->
          <g v-if="reviewPulseT > 0 && reviewPulseT < 1" filter="url(#pulse-glow)">
            <circle :cx="500" :cy="118 + reviewPulseT * 184" r="5" fill="#2ac49f" />
            <circle :cx="500" :cy="302 - reviewPulseT * 184" r="5" fill="#f5f5f7" />
          </g>

          <!-- 60fps Traveling Photon Pulses on the Right Merge Curves -->
          <g v-if="mergePulseT > 0 && mergePulseT < 1" filter="url(#pulse-glow)">
            <circle :cx=" pulsePosRight(0).x " :cy=" pulsePosRight(0).y " r="4.5" fill="#2ac49f" />
            <circle :cx=" pulsePosRight(1).x " :cy=" pulsePosRight(1).y " r="4.5" fill="#a7f3d0" />
            <circle :cx=" pulsePosRight(2).x " :cy=" pulsePosRight(2).y " r="4.5" fill="#f5f5f7" />
          </g>
        </svg>

        <!-- 3-COLUMN STAGE NODES -->
        <div class="stage-columns">
          <!-- COLUMN 1: HUMAN INTENT NODE (LEFT) -->
          <div
            class="node-human"
            :class="{ 'node-human--active': activePhaseIndex === 0 }"
          >
            <div class="human-orb-wrap">
              <div class="human-orb-halo" />
              <div class="human-orb">
                <span>You</span>
              </div>
              <span class="node-kicker">Human</span>
            </div>

            <div class="intent-bubble">
              <span class="bubble-label">Your Request</span>
              <p class="bubble-text">
                “Add dark mode and sync it across devices.”
              </p>
              <div class="bubble-meta">
                <span class="meta-dot" />
                <span>{{ humanStatusText }}</span>
              </div>
            </div>
          </div>

          <!-- COLUMN 2: PARALLEL AGENT SWARM NODES (CENTER) -->
          <div class="nodes-agents">
            <div
              v-for="(agent, idx) in agentLanes"
              :key="agent.name"
              class="agent-lane-card"
              :class="{
                'agent-lane-card--working': activePhaseIndex === 1,
                'agent-lane-card--reviewing': activePhaseIndex === 2,
                'agent-lane-card--done': activePhaseIndex === 3,
              }"
            >
              <div class="lane-header">
                <div class="lane-identity">
                  <img :src="agent.icon" :alt="agent.name" width="22" height="22" class="lane-icon" />
                  <strong>{{ agent.name }}</strong>
                </div>
                <span class="lane-badge" :class="`lane-badge--p${activePhaseIndex}`">
                  {{ agent.phaseLabels[activePhaseIndex] }}
                </span>
              </div>

              <div class="lane-task-row">
                <span class="lane-file">{{ agent.file }}</span>
                <span class="lane-delta">{{ agent.delta }}</span>
              </div>

              <!-- Animated 60fps progress / verification meter -->
              <div class="lane-meter-track">
                <div
                  class="lane-meter-fill"
                  :style="{ width: `${laneFillPercent(idx)}%` }"
                />
              </div>
            </div>

            <!-- Floating Cross-Review Pill during Phase 2 -->
            <div
              class="cross-review-pill"
              :class="{ 'cross-review-pill--visible': activePhaseIndex === 2 }"
            >
              <span class="review-spark" />
              <span>Codex &amp; Claude cross-checking each other</span>
            </div>
          </div>

          <!-- COLUMN 3: SHIPPED OUTCOME NODE (RIGHT) -->
          <div
            class="node-ship"
            :class="{ 'node-ship--active': activePhaseIndex === 3 }"
          >
            <div class="ship-orb-wrap">
              <div class="ship-orb-halo" />
              <div class="ship-orb">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <span class="node-kicker node-kicker--mint">Result</span>
            </div>

            <div class="ship-card">
              <span class="bubble-label bubble-label--mint">Verified &amp; Ready</span>
              <strong class="ship-title">Dark Mode Shipped</strong>
              <p class="ship-sub">
                Built in parallel. Checked by a second agent before reaching your desk.
              </p>
              <div class="ship-checks">
                <span>✓ Zero conflicts</span>
                <span>✓ Peer-reviewed</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Bottom Interactive Phase Scrubber with Continuous Progress Fill -->
      <div class="phase-scrubber" role="tablist" aria-label="Animation phases">
        <button
          v-for="(phase, idx) in phases"
          :key="phase.title"
          type="button"
          role="tab"
          :aria-selected="activePhaseIndex === idx"
          class="scrubber-step"
          :class="{ 'scrubber-step--active': activePhaseIndex === idx }"
          @pointerenter="lockPhase(idx)"
          @click="lockPhase(idx)"
        >
          <div class="scrubber-bar-track">
            <div
              class="scrubber-bar-fill"
              :style="{ width: `${stepFillPercent(idx)}%` }"
            />
          </div>
          <div class="scrubber-copy">
            <span class="scrubber-num">0{{ idx + 1 }}</span>
            <strong class="scrubber-title">{{ phase.title }}</strong>
            <span class="scrubber-desc">{{ phase.caption }}</span>
          </div>
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { setHemisphereFocus } from './symbiosisData'
import claudeIcon from '../../../../../apps/desktop/renderer/src/assets/harness-icons/claude-code.png'
import codexIcon from '../../../../../apps/desktop/renderer/src/assets/harness-icons/codex.png'
import cursorIcon from '../../../../../apps/desktop/renderer/src/assets/harness-icons/cursor.png'

const sectionEl = ref<HTMLElement | null>(null)

// Continuous 0..1 timeline progress over a 9.6-second cycle
const timelineProgress = ref(0.12)
const isPausedOnStep = ref<number | null>(null)

let rafId: number | null = null
let lastFrameMs = 0
let isVisible = true
let prefersReducedMotion = false
let motionMedia: MediaQueryList | null = null

const CYCLE_DURATION_MS = 9600

const phases = [
  {
    title: 'You ask once',
    caption: 'Plain English, zero micromanaging',
    hemi: 'human' as const,
  },
  {
    title: 'Agents split the work',
    caption: 'Parallel lanes, no stepping on toes',
    hemi: 'agent' as const,
  },
  {
    title: 'Agents check each other',
    caption: 'No agent grades its own homework',
    hemi: 'agent' as const,
  },
  {
    title: 'You approve & ship',
    caption: 'Clean result, your final word',
    hemi: 'fused' as const,
  },
]

const agentLanes = [
  {
    name: 'Claude Code',
    icon: claudeIcon,
    file: 'ThemeToggle.vue',
    delta: '+48 lines',
    phaseLabels: ['Assigned', 'Building UI…', 'Checking Codex…', 'Verified ✓'],
  },
  {
    name: 'Codex',
    icon: codexIcon,
    file: 'useThemeSync.ts',
    delta: '+34 lines',
    phaseLabels: ['Assigned', 'Syncing state…', 'Checking Claude…', 'Verified ✓'],
  },
  {
    name: 'Cursor',
    icon: cursorIcon,
    file: 'theme.spec.ts',
    delta: '14/14 tests',
    phaseLabels: ['Standby', 'Running checks…', 'All passing', 'Verified ✓'],
  },
]

const activePhaseIndex = computed(() => {
  if (isPausedOnStep.value !== null) return isPausedOnStep.value
  return Math.min(3, Math.floor(timelineProgress.value * 4))
})

const humanStatusText = computed(() => {
  const idx = activePhaseIndex.value
  if (idx === 0) return 'Broadcasting to room…'
  if (idx === 1) return '3 agents working in parallel'
  if (idx === 2) return 'Agents cross-checking code'
  return 'Approved & shipped'
})

// Cubic bezier math for 60fps photon coordinates along the SVG paths
function cubicBezier(
  t: number,
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
) {
  const u = 1 - t
  const tt = t * t
  const uu = u * u
  const uuu = uu * u
  const ttt = tt * t
  return {
    x: uuu * p0[0] + 3 * uu * t * p1[0] + 3 * u * tt * p2[0] + ttt * p3[0],
    y: uuu * p0[1] + 3 * uu * t * p1[1] + 3 * u * tt * p2[1] + ttt * p3[1],
  }
}

const splitPulseT = computed(() => {
  const p = timelineProgress.value
  if (p > 0.32) return 0
  return Math.max(0, Math.min(1, p / 0.28))
})

const reviewPulseT = computed(() => {
  const p = timelineProgress.value
  if (p < 0.48 || p > 0.76) return 0
  return (p - 0.48) / 0.26
})

const mergePulseT = computed(() => {
  const p = timelineProgress.value
  if (p < 0.72) return 0
  return Math.max(0, Math.min(1, (p - 0.72) / 0.24))
})

const splitDashOffset = computed(() => {
  const p = Math.min(1, timelineProgress.value / 0.26)
  return Math.round((1 - p) * 320)
})

const mergeDashOffset = computed(() => {
  const p = Math.max(0, Math.min(1, (timelineProgress.value - 0.68) / 0.22))
  return Math.round((1 - p) * 320)
})

function pulsePosLeft(laneIdx: number) {
  const t = splitPulseT.value
  const endY = laneIdx === 0 ? 86 : laneIdx === 1 ? 210 : 334
  return cubicBezier(t, [185, 210], [285, 210], [315, endY], [415, endY])
}

function pulsePosRight(laneIdx: number) {
  const t = mergePulseT.value
  const startY = laneIdx === 0 ? 86 : laneIdx === 1 ? 210 : 334
  return cubicBezier(t, [585, startY], [685, startY], [715, 210], [815, 210])
}

function laneFillPercent(laneIdx: number) {
  const p = timelineProgress.value
  const offset = laneIdx * 0.04
  if (p < 0.18 + offset) return 8
  if (p >= 0.68) return 100
  return Math.min(100, Math.round(((p - (0.18 + offset)) / 0.45) * 92 + 8))
}

function stepFillPercent(stepIdx: number) {
  if (isPausedOnStep.value !== null) {
    return stepIdx === isPausedOnStep.value ? 100 : stepIdx < isPausedOnStep.value ? 100 : 0
  }
  const start = stepIdx * 0.25
  const end = start + 0.25
  if (timelineProgress.value <= start) return 0
  if (timelineProgress.value >= end) return 100
  return Math.round(((timelineProgress.value - start) / 0.25) * 100)
}

function lockPhase(idx: number) {
  isPausedOnStep.value = idx
  timelineProgress.value = idx * 0.25 + 0.18
  const phase = phases[idx]
  if (phase) setHemisphereFocus(phase.hemi)
}

function resumeLoop() {
  isPausedOnStep.value = null
  lastFrameMs = performance.now()
}

function tick(nowMs: number) {
  rafId = null
  if (!isVisible || document.hidden || prefersReducedMotion) return

  if (lastFrameMs === 0) lastFrameMs = nowMs
  const dt = Math.min(64, nowMs - lastFrameMs)
  lastFrameMs = nowMs

  if (isPausedOnStep.value === null) {
    timelineProgress.value = (timelineProgress.value + dt / CYCLE_DURATION_MS) % 1
    const currentPhase = phases[activePhaseIndex.value]
    if (currentPhase && sectionEl.value) {
      const rect = sectionEl.value.getBoundingClientRect()
      if (rect.top < window.innerHeight * 0.7 && rect.bottom > window.innerHeight * 0.25) {
        setHemisphereFocus(currentPhase.hemi)
      }
    }
  }

  rafId = window.requestAnimationFrame(tick)
}

function syncLoop() {
  if (isVisible && !document.hidden && !prefersReducedMotion) {
    if (rafId === null) {
      lastFrameMs = performance.now()
      rafId = window.requestAnimationFrame(tick)
    }
  } else if (rafId !== null) {
    window.cancelAnimationFrame(rafId)
    rafId = null
  }
}

let observer: IntersectionObserver | null = null

onMounted(() => {
  motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)')
  prefersReducedMotion = motionMedia.matches
  if (prefersReducedMotion) {
    timelineProgress.value = 0.88
  }

  if (sectionEl.value && typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(
      (entries) => {
        isVisible = entries[0]?.isIntersecting ?? true
        syncLoop()
      },
      { threshold: 0.08 },
    )
    observer.observe(sectionEl.value)
  }

  document.addEventListener('visibilitychange', syncLoop)
  syncLoop()
})

onUnmounted(() => {
  if (rafId !== null) window.cancelAnimationFrame(rafId)
  observer?.disconnect()
  document.removeEventListener('visibilitychange', syncLoop)
})
</script>

<style scoped>
.symbiosis-section {
  position: relative;
  z-index: 2;
  max-width: 1120px;
  margin: 0 auto;
  padding: 140px 32px;
  scroll-margin-top: 92px;
}

.symbiosis-header {
  text-align: center;
  max-width: 620px;
  margin: 0 auto 56px;
}

.duality-badges {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
}

.duality-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 13px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.duality-badge--human {
  background: rgba(245, 245, 247, 0.07);
  border: 1px solid rgba(245, 245, 247, 0.14);
  color: #f5f5f7;
}

.duality-badge--agent {
  background: rgba(42, 196, 159, 0.1);
  border: 1px solid rgba(42, 196, 159, 0.24);
  color: #6ee7b7;
}

.duality-sep {
  color: #52525b;
  font-size: 0.82rem;
}

.badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.badge-dot--human {
  background: #f5f5f7;
}

.badge-dot--agent {
  background: #2ac49f;
  box-shadow: 0 0 8px rgba(42, 196, 159, 0.9);
}

.headline {
  font-size: clamp(2.8rem, 5.5vw, 4.4rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.04;
  color: #f5f5f7;
  margin-bottom: 16px;
}

.headline-mint {
  background: linear-gradient(95deg, #f5f5f7 0%, #2ac49f 90%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.subcopy {
  font-size: 1.16rem;
  line-height: 1.55;
  color: #86868b;
  text-wrap: balance;
}

/* ─── 60FPS CHOREOGRAPHED MOTION THEATRE ─── */
.motion-theatre {
  position: relative;
  border-radius: 32px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  background: rgba(14, 14, 16, 0.78);
  backdrop-filter: blur(32px);
  box-shadow: 0 40px 100px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}

.theatre-ambient {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(
    460px circle at var(--glow-x, 50%) 45%,
    rgba(42, 196, 159, var(--glow-mint, 0.12)),
    transparent 70%
  );
  transition: background 120ms linear;
}

.theatre-canvas {
  position: relative;
  min-height: 420px;
  padding: 40px 36px;
  display: flex;
  align-items: center;
}

.circuit-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.track-base {
  stroke: rgba(255, 255, 255, 0.06);
  stroke-width: 1.5;
}

.track-active {
  stroke-width: 2;
  stroke-dasharray: 320;
  transition: stroke-dashoffset 80ms linear;
}

.review-bridge-line {
  stroke-width: 2;
  stroke-dasharray: 6 6;
  opacity: 0.12;
  transition: opacity 350ms ease;
}

.review-bridge-line--active {
  opacity: 0.85;
}

.stage-columns {
  position: relative;
  z-index: 2;
  width: 100%;
  display: grid;
  grid-template-columns: 230px minmax(0, 320px) 230px;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
}

/* ─── LEFT: HUMAN NODE ─── */
.node-human,
.node-ship {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 16px;
  transition: transform 400ms cubic-bezier(0.16, 1, 0.3, 1);
}

.node-human--active,
.node-ship--active {
  transform: scale(1.03);
}

.human-orb-wrap,
.ship-orb-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.human-orb,
.ship-orb {
  position: relative;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.88rem;
  font-weight: 700;
}

.human-orb {
  background: #f5f5f7;
  color: #09090b;
  box-shadow: 0 0 32px rgba(245, 245, 247, 0.35);
}

.ship-orb {
  background: rgba(42, 196, 159, 0.16);
  border: 1.5px solid rgba(42, 196, 159, 0.55);
  color: #2ac49f;
  transition: background 350ms ease, color 350ms ease, box-shadow 350ms ease;
}

.node-ship--active .ship-orb {
  background: #2ac49f;
  color: #04130f;
  box-shadow: 0 0 36px rgba(42, 196, 159, 0.6);
}

.node-kicker {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #86868b;
}

.node-kicker--mint {
  color: #2ac49f;
}

.intent-bubble,
.ship-card {
  width: 100%;
  padding: 18px;
  border-radius: 20px;
  background: rgba(24, 24, 27, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.09);
  text-align: left;
  transition: border-color 350ms ease, box-shadow 350ms ease;
}

.node-human--active .intent-bubble {
  border-color: rgba(245, 245, 247, 0.32);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
}

.node-ship--active .ship-card {
  border-color: rgba(42, 196, 159, 0.45);
  box-shadow: 0 18px 44px rgba(42, 196, 159, 0.14);
}

.bubble-label {
  display: block;
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #86868b;
  margin-bottom: 6px;
}

.bubble-label--mint {
  color: #2ac49f;
}

.bubble-text {
  font-size: 0.92rem;
  font-weight: 600;
  line-height: 1.42;
  color: #f5f5f7;
  margin-bottom: 12px;
}

.bubble-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 0.75rem;
  color: #a1a1a6;
}

.meta-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #2ac49f;
}

/* ─── CENTER: 3 PARALLEL AGENT LANES ─── */
.nodes-agents {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.agent-lane-card {
  padding: 15px 18px;
  border-radius: 18px;
  background: rgba(22, 22, 25, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.08);
  transition:
    transform 320ms cubic-bezier(0.16, 1, 0.3, 1),
    border-color 320ms ease,
    box-shadow 320ms ease;
}

.agent-lane-card--working {
  border-color: rgba(42, 196, 159, 0.32);
}

.agent-lane-card--reviewing {
  border-color: rgba(110, 231, 183, 0.48);
  box-shadow: 0 0 28px rgba(42, 196, 159, 0.12);
}

.agent-lane-card--done {
  border-color: rgba(42, 196, 159, 0.25);
}

.lane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.lane-identity {
  display: flex;
  align-items: center;
  gap: 9px;
}

.lane-icon {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  object-fit: contain;
}

.lane-identity strong {
  font-size: 0.88rem;
  font-weight: 600;
  color: #f5f5f7;
}

.lane-badge {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: #a1a1a6;
  transition: color 250ms ease, background 250ms ease;
}

.lane-badge--p1,
.lane-badge--p2 {
  background: rgba(42, 196, 159, 0.14);
  color: #6ee7b7;
}

.lane-badge--p3 {
  background: rgba(42, 196, 159, 0.22);
  color: #2ac49f;
}

.lane-task-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.78rem;
  margin-bottom: 8px;
}

.lane-file {
  font-family: var(--font-mono);
  color: #d4d4d8;
}

.lane-delta {
  color: #2ac49f;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.lane-meter-track {
  height: 3px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
}

.lane-meter-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #2ac49f 0%, #a7f3d0 100%);
  transition: width 90ms linear;
}

.cross-review-pill {
  position: absolute;
  left: 50%;
  bottom: -34px;
  transform: translateX(-50%) translateY(6px);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 13px;
  border-radius: 999px;
  background: rgba(12, 24, 20, 0.92);
  border: 1px solid rgba(42, 196, 159, 0.4);
  color: #a7f3d0;
  font-size: 0.73rem;
  font-weight: 600;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 280ms ease, transform 280ms ease;
}

.cross-review-pill--visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.review-spark {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #2ac49f;
  box-shadow: 0 0 8px #2ac49f;
}

/* ─── RIGHT: SHIP CARD ─── */
.ship-title {
  display: block;
  font-size: 0.98rem;
  font-weight: 700;
  color: #f5f5f7;
  margin-bottom: 6px;
}

.ship-sub {
  font-size: 0.8rem;
  line-height: 1.45;
  color: #86868b;
  margin-bottom: 12px;
}

.ship-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 0.73rem;
  font-weight: 600;
  color: #6ee7b7;
}

/* ─── BOTTOM 4-STEP PHASE SCRUBBER ─── */
.phase-scrubber {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(10, 10, 12, 0.55);
}

.scrubber-step {
  text-align: left;
  padding: 20px 22px 22px;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  transition: background 200ms ease;
}

.scrubber-step:last-child {
  border-right: none;
}

.scrubber-step:hover,
.scrubber-step--active {
  background: rgba(255, 255, 255, 0.025);
}

.scrubber-bar-track {
  height: 2px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
  margin-bottom: 12px;
}

.scrubber-bar-fill {
  height: 100%;
  background: #f5f5f7;
  transition: width 90ms linear;
}

.scrubber-step--active .scrubber-bar-fill {
  background: #2ac49f;
}

.scrubber-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.scrubber-num {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: #6e6e73;
}

.scrubber-title {
  font-size: 0.88rem;
  font-weight: 600;
  color: #f5f5f7;
}

.scrubber-desc {
  font-size: 0.76rem;
  color: #86868b;
}

@media (max-width: 920px) {
  .symbiosis-section {
    padding: 96px 20px;
  }

  .circuit-svg {
    display: none;
  }

  .stage-columns {
    grid-template-columns: 1fr;
    gap: 24px;
  }

  .phase-scrubber {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 560px) {
  .phase-scrubber {
    grid-template-columns: 1fr;
  }
}
</style>
