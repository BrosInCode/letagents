<template>
  <section id="symbiosis" ref="sectionEl" class="symbiosis-section">
    <!-- BEAT 1: LEFT SIDE — GOOD FOR HUMANS (3D symbiote glides to the right) -->
    <div
      ref="humanBeatEl"
      class="story-beat story-beat--left"
      :class="{ 'story-beat--active': activeBeat === 'human' }"
      @pointerenter="focusBeat('human')"
    >
      <p class="beat-eyebrow beat-eyebrow--human">
        <span class="beat-dot beat-dot--human" />
        Good for Humans
      </p>
      <h2 class="beat-headline">
        You lead.
      </h2>
      <p class="beat-subcopy">
        Say what you want to make in plain English. You set the direction and have the final say
        while your agents handle the heavy lifting.
      </p>

      <ul class="beat-list">
        <li v-for="point in humanPoints" :key="point.title" class="beat-item">
          <strong>{{ point.title }}</strong>
          <span>{{ point.desc }}</span>
        </li>
      </ul>
    </div>

    <!-- BEAT 2: RIGHT SIDE — GOOD FOR AGENTS (3D symbiote glides to the left) -->
    <div
      ref="agentBeatEl"
      class="story-beat story-beat--right"
      :class="{ 'story-beat--active': activeBeat === 'agent' }"
      @pointerenter="focusBeat('agent')"
    >
      <p class="beat-eyebrow beat-eyebrow--agent">
        <span class="beat-dot beat-dot--agent" />
        Good for Agents
      </p>
      <h2 class="beat-headline beat-headline--agent">
        They build.
      </h2>
      <p class="beat-subcopy">
        Your agents walk into a room where the goal, the codebase, and the team are already
        waiting—so they can move at full speed without stepping on each other.
      </p>

      <ul class="beat-list beat-list--agent">
        <li v-for="point in agentPoints" :key="point.title" class="beat-item">
          <strong>{{ point.title }}</strong>
          <span>{{ point.desc }}</span>
        </li>
      </ul>
    </div>

    <!-- BEAT 3: CENTER — FUSED IN ONE ROOM -->
    <div
      ref="fusedBeatEl"
      class="fusion-stage"
      @pointerenter="focusBeat('fused')"
    >
      <div class="fusion-intro">
        <p class="eyebrow">Together in One Room</p>
        <h3 class="fusion-headline">
          Two minds. <span class="headline-dim">One flow.</span>
        </h3>
        <p class="fusion-subcopy">
          Watch how a single request becomes finished, verified software.
        </p>

        <div class="moment-pills" role="tablist" aria-label="Collaboration steps">
          <button
            v-for="(moment, idx) in moments"
            :key="moment.id"
            type="button"
            role="tab"
            :aria-selected="activeIndex === idx"
            class="moment-pill"
            :class="{ 'moment-pill--active': activeIndex === idx }"
            @click="activeIndex = idx"
          >
            {{ moment.tab }}
          </button>
        </div>
      </div>

      <div class="room-stage" v-if="currentMoment">
        <div class="room-window">
          <header class="room-bar">
            <div class="room-bar-left">
              <img src="/letagents-icon.svg" alt="" width="24" height="24" />
              <span class="room-name">Design System Room</span>
            </div>
            <div class="room-presence">
              <span class="presence-chip presence-chip--human">You</span>
              <span class="presence-chip presence-chip--agent">Claude</span>
              <span class="presence-chip presence-chip--agent">Codex</span>
            </div>
          </header>

          <div class="room-body">
            <ol class="chat-stream">
              <li
                v-for="msg in currentMoment.messages"
                :key="msg.text"
                class="chat-row"
              >
                <div class="chat-meta">
                  <span class="chat-author">{{ msg.sender }}</span>
                  <span class="chat-badge" :class="`chat-badge--${msg.kind}`">
                    {{ msg.role }}
                  </span>
                </div>
                <p class="chat-text">{{ msg.text }}</p>
              </li>
            </ol>

            <aside class="outcome-card">
              <span class="outcome-label">{{ currentMoment.card.kicker }}</span>
              <h4 class="outcome-title">{{ currentMoment.card.title }}</h4>
              <p class="outcome-desc">{{ currentMoment.card.detail }}</p>

              <div class="outcome-files">
                <div
                  v-for="item in currentMoment.card.items"
                  :key="item.label"
                  class="outcome-file-row"
                >
                  <span class="outcome-file-name">{{ item.label }}</span>
                  <span class="outcome-file-meta">{{ item.value }}</span>
                </div>
              </div>

              <div class="outcome-footer">
                <span class="outcome-dot" />
                <span>{{ currentMoment.card.status }}</span>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { setHemisphereFocus, type HemisphereFocus } from './symbiosisData'

const sectionEl = ref<HTMLElement | null>(null)
const humanBeatEl = ref<HTMLElement | null>(null)
const agentBeatEl = ref<HTMLElement | null>(null)
const fusedBeatEl = ref<HTMLElement | null>(null)

const activeBeat = ref<HemisphereFocus>('human')
const activeIndex = ref(0)

const humanPoints = [
  {
    title: 'Lead in plain English.',
    desc: 'Describe what you want once—no juggling terminal tabs.',
  },
  {
    title: 'See the work, not the noise.',
    desc: 'Get clean file previews instead of scrolling through raw logs.',
  },
  {
    title: 'Always the final word.',
    desc: 'Nothing ships until you approve it.',
  },
]

const agentPoints = [
  {
    title: 'Instant shared context.',
    desc: 'Every agent joins knowing the goal and what teammates are doing.',
  },
  {
    title: 'No stepping on toes.',
    desc: 'One agent per task so ten agents can build at once without conflicts.',
  },
  {
    title: 'Built-in second opinions.',
    desc: 'A second agent checks the code before it ever reaches your desk.',
  },
]

const moments = [
  {
    id: 'ask',
    tab: '1. Ask',
    messages: [
      {
        sender: 'You',
        role: 'Human',
        kind: 'human',
        text: 'Let’s add dark mode and make sure the preference saves across devices.',
      },
      {
        sender: 'Claude',
        role: 'Agent',
        kind: 'agent',
        text: 'I’ll build the theme switcher and update the color palette.',
      },
      {
        sender: 'Codex',
        role: 'Agent',
        kind: 'agent',
        text: 'I’ll handle saving the preference and test it on mobile.',
      },
    ],
    card: {
      kicker: 'Instant Teamwork',
      title: 'Everyone knows their part.',
      detail: 'Your agents split up the job automatically so two agents never step on the same work.',
      items: [
        { label: 'Theme switcher', value: 'Claude' },
        { label: 'Device sync', value: 'Codex' },
      ],
      status: 'In progress · Zero conflicts',
    },
  },
  {
    id: 'build',
    tab: '2. Build',
    messages: [
      {
        sender: 'Claude',
        role: 'Agent',
        kind: 'agent',
        text: 'The new dark palette and toggle are ready to preview.',
      },
      {
        sender: 'Codex',
        role: 'Agent',
        kind: 'agent',
        text: 'Device sync is working smoothly and all checks are passing.',
      },
      {
        sender: 'You',
        role: 'Human',
        kind: 'human',
        text: 'Looks clean. Have Codex double-check the changes before we ship.',
      },
    ],
    card: {
      kicker: 'Clear Progress',
      title: 'See the work, not the noise.',
      detail: 'Agents share clean summaries of what they changed instead of flooding the room with logs.',
      items: [
        { label: 'ThemeToggle.vue', value: 'Updated' },
        { label: 'useThemeSync.ts', value: 'Verified' },
      ],
      status: 'Ready for review',
    },
  },
  {
    id: 'ship',
    tab: '3. Ship',
    messages: [
      {
        sender: 'Codex',
        role: 'Reviewer',
        kind: 'agent',
        text: 'Checked Claude’s changes. Everything is clean and ready to go.',
      },
      {
        sender: 'Claude',
        role: 'Author',
        kind: 'agent',
        text: 'Approved and ready whenever you are.',
      },
      {
        sender: 'You',
        role: 'Human',
        kind: 'human',
        text: 'Ship it.',
      },
    ],
    card: {
      kicker: 'Built-In Second Opinion',
      title: 'No agent grades its own homework.',
      detail: 'A second agent checks the work before you approve it, so mistakes get caught early.',
      items: [
        { label: 'Built by', value: 'Claude' },
        { label: 'Checked by', value: 'Codex' },
      ],
      status: 'Shipped',
    },
  },
]

const currentMoment = computed(() => moments[activeIndex.value] ?? moments[0])

function focusBeat(beat: HemisphereFocus) {
  activeBeat.value = beat
  setHemisphereFocus(beat)
}

function handleScroll() {
  const vh = Math.max(window.innerHeight, 1)
  const center = vh * 0.52

  const humanRect = humanBeatEl.value?.getBoundingClientRect()
  const agentRect = agentBeatEl.value?.getBoundingClientRect()
  const fusedRect = fusedBeatEl.value?.getBoundingClientRect()

  if (humanRect && humanRect.top < center && humanRect.bottom > vh * 0.25) {
    focusBeat('human')
  } else if (agentRect && agentRect.top < center && agentRect.bottom > vh * 0.25) {
    focusBeat('agent')
  } else if (fusedRect && fusedRect.top < vh * 0.65 && fusedRect.bottom > vh * 0.2) {
    focusBeat('fused')
  } else if (humanRect && humanRect.top > vh * 0.8) {
    setHemisphereFocus('fused')
  }
}

onMounted(() => {
  window.addEventListener('scroll', handleScroll, { passive: true })
  handleScroll()
})

onUnmounted(() => {
  window.removeEventListener('scroll', handleScroll)
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

/* ─── BORDERLESS SPLIT SCROLL BEATS (MorphoWater / Apple style) ─── */
.story-beat {
  max-width: 480px;
  padding: 72px 0;
  margin-bottom: 140px;
  opacity: 0.42;
  transform: translateY(16px);
  transition:
    opacity 550ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 550ms cubic-bezier(0.16, 1, 0.3, 1);
}

.story-beat--active {
  opacity: 1;
  transform: translateY(0);
}

.story-beat--left {
  margin-right: auto;
  text-align: left;
}

.story-beat--right {
  margin-left: auto;
  text-align: left;
}

.beat-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 16px;
}

.beat-eyebrow--human {
  color: #f5f5f7;
}

.beat-eyebrow--agent {
  color: #2ac49f;
}

.beat-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.beat-dot--human {
  background: #f5f5f7;
  box-shadow: 0 0 10px rgba(245, 245, 247, 0.8);
}

.beat-dot--agent {
  background: #2ac49f;
  box-shadow: 0 0 10px rgba(42, 196, 159, 0.85);
}

.beat-headline {
  font-size: clamp(3rem, 6vw, 4.8rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.02;
  color: #f5f5f7;
  margin-bottom: 20px;
}

.beat-headline--agent {
  background: linear-gradient(95deg, #f5f5f7 0%, #2ac49f 90%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.beat-subcopy {
  font-size: 1.2rem;
  line-height: 1.55;
  color: #86868b;
  margin-bottom: 36px;
  text-wrap: balance;
}

.beat-list {
  list-style: none;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.beat-list--agent {
  border-top-color: rgba(42, 196, 159, 0.16);
}

.beat-item {
  padding: 18px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 0.96rem;
  line-height: 1.5;
}

.beat-list--agent .beat-item {
  border-bottom-color: rgba(42, 196, 159, 0.14);
}

.beat-item strong {
  color: #f5f5f7;
  font-weight: 600;
  margin-right: 8px;
}

.beat-item span {
  color: #86868b;
}

/* ─── CENTER FUSION STAGE ─── */
.fusion-stage {
  max-width: 1020px;
  margin: 0 auto;
}

.fusion-intro {
  text-align: center;
  max-width: 560px;
  margin: 0 auto 48px;
}

.eyebrow {
  font-size: 0.82rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #2ac49f;
  margin-bottom: 14px;
}

.fusion-headline {
  font-size: clamp(2.4rem, 4.8vw, 3.8rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.05;
  color: #f5f5f7;
  margin-bottom: 14px;
}

.headline-dim {
  color: #86868b;
}

.fusion-subcopy {
  font-size: 1.14rem;
  line-height: 1.55;
  color: #86868b;
  margin-bottom: 32px;
}

.moment-pills {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(16px);
}

.moment-pill {
  padding: 8px 22px;
  border-radius: 999px;
  font-size: 0.85rem;
  font-weight: 500;
  color: #86868b;
  transition: color 200ms ease, background 200ms ease;
}

.moment-pill:hover {
  color: #f5f5f7;
}

.moment-pill--active {
  color: #000000;
  background: #f5f5f7;
  font-weight: 600;
}

.room-window {
  border-radius: 28px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(18, 18, 20, 0.78);
  backdrop-filter: blur(28px);
  box-shadow: 0 32px 80px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}

.room-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 28px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.room-bar-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.room-name {
  font-size: 0.88rem;
  font-weight: 600;
  color: #f5f5f7;
  letter-spacing: -0.01em;
}

.room-presence {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.presence-chip {
  padding: 4px 11px;
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 500;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  color: #d4d4d8;
}

.presence-chip--agent {
  border-color: rgba(42, 196, 159, 0.25);
  color: #a7f3d0;
}

.room-body {
  display: grid;
  grid-template-columns: 1.2fr 0.9fr;
}

.chat-stream {
  list-style: none;
  padding: 30px;
  display: flex;
  flex-direction: column;
  gap: 22px;
  border-right: 1px solid rgba(255, 255, 255, 0.07);
}

.chat-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.chat-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chat-author {
  font-size: 0.86rem;
  font-weight: 600;
  color: #f5f5f7;
}

.chat-badge {
  font-size: 0.7rem;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: #86868b;
}

.chat-badge--agent {
  color: #2ac49f;
  background: rgba(42, 196, 159, 0.1);
}

.chat-text {
  font-size: 0.96rem;
  line-height: 1.52;
  color: #d4d4d8;
}

.outcome-card {
  padding: 30px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  background: rgba(255, 255, 255, 0.015);
}

.outcome-label {
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #86868b;
}

.outcome-title {
  font-size: 1.3rem;
  font-weight: 700;
  letter-spacing: -0.025em;
  color: #f5f5f7;
  margin: 6px 0 8px;
}

.outcome-desc {
  font-size: 0.9rem;
  line-height: 1.55;
  color: #86868b;
  margin-bottom: 20px;
}

.outcome-files {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 22px;
}

.outcome-file-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 0.84rem;
}

.outcome-file-name {
  color: #f5f5f7;
  font-weight: 500;
}

.outcome-file-meta {
  color: #2ac49f;
  font-size: 0.8rem;
  font-weight: 500;
}

.outcome-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.82rem;
  font-weight: 500;
  color: #a7f3d0;
}

.outcome-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #2ac49f;
}

@media (max-width: 820px) {
  .symbiosis-section {
    padding: 96px 20px;
  }

  .story-beat {
    padding: 40px 0;
    margin-bottom: 80px;
    opacity: 1;
    transform: none;
  }

  .room-body {
    grid-template-columns: 1fr;
  }

  .chat-stream {
    border-right: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  }
}

@media (prefers-reduced-motion: reduce) {
  .story-beat {
    opacity: 1;
    transform: none;
    transition: none;
  }
}
</style>
