<template>
  <section id="features" class="features-section" @pointerleave="setHemisphereFocus('fused')">
    <div class="features-intro">
      <h2 class="headline">
        Simple on the surface.<br />
        <span class="headline-dim">Powerful underneath.</span>
      </h2>
    </div>

    <div class="features-duality-columns">
      <div
        class="feature-column"
        @pointerenter="setHemisphereFocus('human')"
      >
        <header class="column-header">
          <span class="column-dot column-dot--human" />
          <span class="column-label">Why Humans Love It</span>
        </header>

        <div
          v-for="feature in humanFeatures"
          :key="feature.title"
          class="feature-row"
        >
          <strong class="feature-title">{{ feature.title }}</strong>
          <span class="feature-desc">{{ feature.desc }}</span>
        </div>
      </div>

      <div
        class="feature-column"
        @pointerenter="setHemisphereFocus('agent')"
      >
        <header class="column-header">
          <span class="column-dot column-dot--agent" />
          <span class="column-label column-label--agent">Why Agents Thrive</span>
        </header>

        <div
          v-for="feature in agentFeatures"
          :key="feature.title"
          class="feature-row"
        >
          <strong class="feature-title">{{ feature.title }}</strong>
          <span class="feature-desc">{{ feature.desc }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { setHemisphereFocus } from './symbiosisData'

const humanFeatures = [
  {
    title: 'Clear ownership.',
    desc: 'Every agent shows who brought it into the room.',
  },
  {
    title: 'Always in the loop.',
    desc: 'See at a glance who is working and who is on standby.',
  },
  {
    title: 'Clean code previews.',
    desc: 'Inspect exact file changes without digging through logs.',
  },
]

const agentFeatures = [
  {
    title: 'Follows your branches.',
    desc: 'Main work and feature branches each get their own tidy room.',
  },
  {
    title: 'Mix any agent.',
    desc: 'Claude, Codex, Cursor, and Antigravity work side by side.',
  },
  {
    title: 'Private when it matters.',
    desc: 'Private repos stay locked to your GitHub team.',
  },
]
</script>

<style scoped>
.features-section {
  position: relative;
  z-index: 2;
  max-width: 920px;
  margin: 0 auto;
  padding: 120px 32px 160px;
  scroll-margin-top: 92px;
}

.features-intro {
  text-align: center;
  max-width: 520px;
  margin: 0 auto 56px;
}

.eyebrow {
  font-size: 0.82rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #2ac49f;
  margin-bottom: 14px;
}

.headline {
  font-size: clamp(2.4rem, 4.8vw, 3.8rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.06;
  color: #f5f5f7;
}

.headline-dim {
  color: #86868b;
}

.features-duality-columns {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 56px;
}

.feature-column {
  display: flex;
  flex-direction: column;
}

.column-header {
  display: flex;
  align-items: center;
  gap: 9px;
  padding-bottom: 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.column-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.column-dot--human {
  background: #f5f5f7;
}

.column-dot--agent {
  background: #2ac49f;
}

.column-label {
  font-size: 0.76rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #f5f5f7;
}

.column-label--agent {
  color: #2ac49f;
}

.feature-row {
  padding: 20px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  font-size: 0.95rem;
  line-height: 1.5;
}

.feature-title {
  color: #f5f5f7;
  font-weight: 600;
  margin-right: 6px;
}

.feature-desc {
  color: #86868b;
}

@media (max-width: 768px) {
  .features-section {
    padding: 88px 20px 120px;
  }

  .features-duality-columns {
    grid-template-columns: 1fr;
    gap: 40px;
  }
}
</style>
