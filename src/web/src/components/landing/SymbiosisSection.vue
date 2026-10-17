<template>
  <section id="symbiosis" ref="sectionEl" class="symbiosis-section">
    <div class="symbiosis-header">
      <h2 class="headline">
        You lead.<br />
        <span class="headline-dim">They build.</span>
      </h2>
      <p class="subcopy">
        Say what you want once. Your agents divide the work, check each other’s code,
        and hand you the finished result.
      </p>
    </div>

    <div
      class="motion-stage"
      @pointerleave="resumeLoop"
    >
      <!-- Spacious 5-Node Choreographed Canvas (Zero Gradients) -->
      <div class="canvas-area">
        <svg
          class="paths-svg"
          viewBox="0 0 960 360"
          fill="none"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <!-- Base solid tracks -->
          <path d="M 160 180 C 290 180, 330 72, 460 72" class="path-track" />
          <path d="M 160 180 L 460 180" class="path-track" />
          <path d="M 160 180 C 290 180, 330 288, 460 288" class="path-track" />

          <path d="M 500 72 C 630 72, 670 180, 800 180" class="path-track" />
          <path d="M 500 180 L 800 180" class="path-track" />
          <path d="M 500 288 C 630 288, 670 180, 800 180" class="path-track" />

          <!-- Vertical peer-check line between agents -->
          <line
            x1="480"
            y1="96"
            x2="480"
            y2="264"
            class="peer-line"
            :class="{ 'peer-line--active': activePhaseIndex === 2 }"
          />

          <!-- Active solid split paths -->
          <path
            d="M 160 180 C 290 180, 330 72, 460 72"
            class="path-lit path-lit--white"
            :style="{ strokeDashoffset: splitDashOffset }"
          />
          <path
            d="M 160 180 L 460 180"
            class="path-lit path-lit--white"
            :style="{ strokeDashoffset: splitDashOffset }"
          />
          <path
            d="M 160 180 C 290 180, 330 288, 460 288"
            class="path-lit path-lit--white"
            :style="{ strokeDashoffset: splitDashOffset }"
          />

          <!-- Active solid merge paths -->
          <path
            d="M 500 72 C 630 72, 670 180, 800 180"
            class="path-lit path-lit--mint"
            :style="{ strokeDashoffset: mergeDashOffset }"
          />
          <path
            d="M 500 180 L 800 180"
            class="path-lit path-lit--mint"
            :style="{ strokeDashoffset: mergeDashOffset }"
          />
          <path
            d="M 500 288 C 630 288, 670 180, 800 180"
            class="path-lit path-lit--mint"
            :style="{ strokeDashoffset: mergeDashOffset }"
          />

          <!-- 60fps Solid Traveling Dots: Left Split -->
          <g v-if="splitPulseT > 0 && splitPulseT < 1">
            <circle :cx="pulsePosLeft(0).x" :cy="pulsePosLeft(0).y" r="4" fill="var(--l-text)" />
            <circle :cx="pulsePosLeft(1).x" :cy="pulsePosLeft(1).y" r="4" fill="var(--l-text)" />
            <circle :cx="pulsePosLeft(2).x" :cy="pulsePosLeft(2).y" r="4" fill="var(--l-text)" />
          </g>

          <!-- 60fps Solid Traveling Dots: Peer Verification -->
          <g v-if="reviewPulseT > 0 && reviewPulseT < 1">
            <circle :cx="480" :cy="104 + reviewPulseT * 152" r="4.5" fill="var(--l-mint)" />
            <circle :cx="480" :cy="256 - reviewPulseT * 152" r="4.5" fill="var(--l-text)" />
          </g>

          <!-- 60fps Solid Traveling Dots: Right Merge -->
          <g v-if="mergePulseT > 0 && mergePulseT < 1">
            <circle :cx="pulsePosRight(0).x" :cy="pulsePosRight(0).y" r="4" fill="var(--l-mint)" />
            <circle :cx="pulsePosRight(1).x" :cy="pulsePosRight(1).y" r="4" fill="var(--l-mint)" />
            <circle :cx="pulsePosRight(2).x" :cy="pulsePosRight(2).y" r="4" fill="var(--l-mint)" />
          </g>
        </svg>

        <!-- Node 1: You (Left) -->
        <div
          class="endpoint-node endpoint-node--left"
          :class="{ 'endpoint-node--lit': activePhaseIndex === 0 }"
        >
          <div class="orb orb--human">
            <span>You</span>
          </div>
          <span class="node-title">You</span>
          <span class="node-sub">Ask once</span>
        </div>

        <!-- Center 3 Agent Nodes -->
        <div class="agent-nodes-col">
          <div
            v-for="(agent, idx) in agents"
            :key="agent.name"
            class="agent-node"
            :class="{
              'agent-node--active': activePhaseIndex === 1 || activePhaseIndex === 2,
              'agent-node--done': activePhaseIndex === 3,
            }"
          >
            <div class="squircle-wrap">
              <svg class="ring-svg" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
                <rect
                  x="2"
                  y="2"
                  width="52"
                  height="52"
                  rx="15"
                  class="ring-track"
                />
                <rect
                  x="2"
                  y="2"
                  width="52"
                  height="52"
                  rx="15"
                  class="ring-progress"
                  :style="{ strokeDashoffset: ringDashOffset(idx) }"
                />
              </svg>
              <img :src="agent.icon" :alt="agent.name" width="26" height="26" class="agent-icon" />
            </div>

            <div class="agent-meta">
              <strong class="agent-name">{{ agent.name }}</strong>
              <span class="agent-state" :class="{ 'agent-state--mint': activePhaseIndex >= 2 }">
                {{ agent.states[activePhaseIndex] }}
              </span>
            </div>
          </div>
        </div>

        <!-- Node 5: Shipped (Right) -->
        <div
          class="endpoint-node endpoint-node--right"
          :class="{ 'endpoint-node--shipped': activePhaseIndex === 3 }"
        >
          <div class="orb orb--ship">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <span class="node-title">Shipped</span>
          <span class="node-sub">Verified</span>
        </div>
      </div>

      <!-- Single Live Narrative Line -->
      <div class="live-caption-bar">
        <p class="live-caption-text">{{ currentPhase.sentence }}</p>
      </div>

      <!-- Clean 4-Step Scrubber -->
      <div class="scrubber-row" role="tablist" aria-label="Collaboration steps">
        <button
          v-for="(phase, idx) in phases"
          :key="phase.label"
          type="button"
          role="tab"
          :aria-selected="activePhaseIndex === idx"
          class="scrubber-tab"
          :class="{ 'scrubber-tab--active': activePhaseIndex === idx }"
          @pointerenter="lockPhase(idx)"
          @click="lockPhase(idx)"
        >
          <div class="tab-line-track">
            <div class="tab-line-fill" :style="{ width: `${stepFillPercent(idx)}%` }" />
          </div>
          <span class="tab-label">{{ phase.label }}</span>
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
const timelineProgress = ref(0.08)
const isPausedOnStep = ref<number | null>(null)

let rafId: number | null = null
let lastFrameMs = 0
let isVisible = true
let prefersReducedMotion = false

const CYCLE_DURATION_MS = 8800

const phases = [
  {
    label: '1. You ask',
    sentence: '“Let’s add dark mode and save the preference across devices.”',
    hemi: 'human' as const,
  },
  {
    label: '2. They split the work',
    sentence: 'Each agent claims its own piece so nobody overwrites the same file.',
    hemi: 'agent' as const,
  },
  {
    label: '3. They check each other',
    sentence: 'No agent grades its own homework—ChatGPT and Claude review each other’s code.',
    hemi: 'agent' as const,
  },
  {
    label: '4. Ready to ship',
    sentence: 'Every part is built, checked, and handed back to you for the final word.',
    hemi: 'fused' as const,
  },
]

const agents = [
  {
    name: 'Claude Code',
    icon: claudeIcon,
    states: ['Ready', 'Theme toggle', 'Checking ChatGPT', 'Approved ✓'],
  },
  {
    name: 'ChatGPT',
    icon: codexIcon,
    states: ['Ready', 'Device sync', 'Checking Claude', 'Approved ✓'],
  },
  {
    name: 'Cursor',
    icon: cursorIcon,
    states: ['Ready', 'Mobile tests', '14/14 passed', 'Approved ✓'],
  },
]

const activePhaseIndex = computed(() => {
  if (isPausedOnStep.value !== null) return isPausedOnStep.value
  return Math.min(3, Math.floor(timelineProgress.value * 4))
})

const currentPhase = computed(() => phases[activePhaseIndex.value] ?? phases[0])

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
  if (p > 0.28) return 0
  return Math.max(0, Math.min(1, p / 0.25))
})

const reviewPulseT = computed(() => {
  const p = timelineProgress.value
  if (p < 0.5 || p > 0.75) return 0
  return (p - 0.5) / 0.24
})

const mergePulseT = computed(() => {
  const p = timelineProgress.value
  if (p < 0.74) return 0
  return Math.max(0, Math.min(1, (p - 0.74) / 0.22))
})

const splitDashOffset = computed(() => {
  const p = Math.min(1, timelineProgress.value / 0.24)
  return Math.round((1 - p) * 340)
})

const mergeDashOffset = computed(() => {
  const p = Math.max(0, Math.min(1, (timelineProgress.value - 0.72) / 0.2))
  return Math.round((1 - p) * 340)
})

function pulsePosLeft(laneIdx: number) {
  const t = splitPulseT.value
  const endY = laneIdx === 0 ? 72 : laneIdx === 1 ? 180 : 288
  return cubicBezier(t, [160, 180], [290, 180], [330, endY], [460, endY])
}

function pulsePosRight(laneIdx: number) {
  const t = mergePulseT.value
  const startY = laneIdx === 0 ? 72 : laneIdx === 1 ? 180 : 288
  return cubicBezier(t, [500, startY], [630, startY], [670, 180], [800, 180])
}

function ringDashOffset(laneIdx: number) {
  const p = timelineProgress.value
  const start = 0.2 + laneIdx * 0.03
  if (p <= start) return 196
  if (p >= 0.7) return 0
  const frac = Math.min(1, (p - start) / 0.45)
  return Math.round((1 - frac) * 196)
}

function stepFillPercent(stepIdx: number) {
  if (isPausedOnStep.value !== null) {
    return stepIdx <= isPausedOnStep.value ? 100 : 0
  }
  const start = stepIdx * 0.25
  const end = start + 0.25
  if (timelineProgress.value <= start) return 0
  if (timelineProgress.value >= end) return 100
  return Math.round(((timelineProgress.value - start) / 0.25) * 100)
}

function lockPhase(idx: number) {
  isPausedOnStep.value = idx
  timelineProgress.value = idx * 0.25 + 0.16
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
    const current = phases[activePhaseIndex.value]
    if (current && sectionEl.value) {
      const rect = sectionEl.value.getBoundingClientRect()
      if (rect.top < window.innerHeight * 0.7 && rect.bottom > window.innerHeight * 0.25) {
        setHemisphereFocus(current.hemi)
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
  prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
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
  max-width: 980px;
  margin: 0 auto;
  padding: 140px 32px;
  scroll-margin-top: 92px;
}

.symbiosis-header {
  text-align: center;
  max-width: 560px;
  margin: 0 auto 52px;
}

.eyebrow {
  font-size: 0.82rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--l-mint);
  margin-bottom: 14px;
}

.headline {
  font-size: clamp(2.6rem, 5.2vw, 4.2rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.05;
  color: var(--l-text);
  margin-bottom: 18px;
}

.headline-dim {
  color: var(--l-text-dim);
}

.subcopy {
  font-size: 1.16rem;
  line-height: 1.55;
  color: var(--l-text-dim);
  text-wrap: balance;
}

/* ─── TRANSLUCENT FROSTED GLASS 5-NODE STAGE ─── */
.motion-stage {
  border-radius: 28px;
  border: 1px solid var(--l-glass-border);
  background: var(--l-glass-bg);
  backdrop-filter: blur(28px) saturate(160%);
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  box-shadow: var(--l-glass-shadow);
  overflow: hidden;
}

.canvas-area {
  position: relative;
  height: 360px;
  padding: 0 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.paths-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.path-track {
  stroke: var(--l-track);
  stroke-width: 1.5;
}

.path-lit {
  stroke-width: 1.5;
  stroke-dasharray: 340;
  transition: stroke-dashoffset 80ms linear;
}

.path-lit--white {
  stroke: var(--l-lit-primary);
}

.path-lit--mint {
  stroke: var(--l-mint);
}

.peer-line {
  stroke: var(--l-mint);
  stroke-width: 1.5;
  stroke-dasharray: 4 4;
  opacity: 0;
  transition: opacity 250ms ease;
}

.peer-line--active {
  opacity: 0.7;
}

/* ─── ENDPOINT NODES (YOU & SHIPPED) ─── */
.endpoint-node {
  position: relative;
  z-index: 2;
  width: 96px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  transition: transform 350ms cubic-bezier(0.16, 1, 0.3, 1);
}

.endpoint-node--lit,
.endpoint-node--shipped {
  transform: scale(1.05);
}

.orb {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.86rem;
  font-weight: 700;
  margin-bottom: 10px;
}

.orb--human {
  background: var(--l-human-orb-bg);
  color: var(--l-human-orb-fg);
}

.orb--ship {
  background: var(--l-glass-bg-elevated);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1.5px solid var(--l-glass-border);
  color: var(--l-text-dim);
  transition: background 300ms ease, border-color 300ms ease, color 300ms ease;
}

.endpoint-node--shipped .orb--ship {
  background: var(--l-mint);
  border-color: var(--l-mint);
  color: #ffffff;
}

.node-title {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--l-text);
}

.node-sub {
  font-size: 0.75rem;
  color: var(--l-text-dim);
  margin-top: 2px;
}

/* ─── CENTER 3 AGENT NODES ─── */
.agent-nodes-col {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.agent-node {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 16px 6px 6px;
  border-radius: 18px;
  background: var(--l-glass-bg-elevated);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--l-glass-border);
  box-shadow: var(--l-glass-pill-shadow);
  min-width: 210px;
  transition: transform 300ms cubic-bezier(0.16, 1, 0.3, 1), border-color 300ms ease, background 300ms ease;
}

.agent-node--active {
  transform: translateY(-2px);
  background: var(--l-glass-bg-hover);
  border-color: var(--l-glass-border-strong);
}

.agent-node--done {
  border-color: var(--l-mint-border);
}

.squircle-wrap {
  position: relative;
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.ring-svg {
  position: absolute;
  inset: 0;
}

.ring-track {
  fill: var(--l-glass-bg);
  stroke: var(--l-glass-border);
  stroke-width: 1.5;
}

.ring-progress {
  fill: none;
  stroke: var(--l-mint);
  stroke-width: 2;
  stroke-dasharray: 196;
  transition: stroke-dashoffset 80ms linear;
}

.agent-icon {
  position: relative;
  z-index: 1;
  width: 26px;
  height: 26px;
  object-fit: contain;
}

.agent-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
}

.agent-name {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--l-text);
}

.agent-state {
  font-size: 0.76rem;
  color: var(--l-text-dim);
  transition: color 250ms ease;
}

.agent-state--mint {
  color: var(--l-mint);
}

/* ─── LIVE CAPTION BAR ─── */
.live-caption-bar {
  padding: 18px 28px;
  border-top: 1px solid var(--l-glass-border-subtle);
  text-align: center;
  background: var(--l-glass-subbar);
}

.live-caption-text {
  font-size: 0.98rem;
  font-weight: 500;
  color: var(--l-text);
}

/* ─── 4-STEP SCRUBBER ─── */
.scrubber-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border-top: 1px solid var(--l-glass-border-subtle);
  background: var(--l-glass-subbar);
}

.scrubber-tab {
  padding: 16px 20px;
  text-align: left;
  border-right: 1px solid var(--l-glass-border-subtle);
}

.scrubber-tab:last-child {
  border-right: none;
}

.tab-line-track {
  height: 2px;
  background: var(--l-track);
  margin-bottom: 10px;
  overflow: hidden;
}

.tab-line-fill {
  height: 100%;
  background: var(--l-text);
  transition: width 80ms linear;
}

.scrubber-tab--active .tab-line-fill {
  background: var(--l-mint);
}

.tab-label {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--l-text-dim);
  transition: color 200ms ease;
}

.scrubber-tab--active .tab-label,
.scrubber-tab:hover .tab-label {
  color: var(--l-text);
}

@media (max-width: 768px) {
  .symbiosis-section {
    padding: 96px 20px;
  }

  .canvas-area {
    height: auto;
    flex-direction: column;
    gap: 24px;
    padding: 32px 20px;
  }

  .paths-svg {
    display: none;
  }

  .scrubber-row {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
