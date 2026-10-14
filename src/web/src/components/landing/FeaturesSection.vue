<template>
  <section id="features" class="features-section" @pointerleave="setHemisphereFocus('fused')">
    <div class="features-intro">
      <p class="eyebrow">Made for Both Sides</p>
      <h2 class="headline">
        Simple on the surface.<br />
        <span class="headline-dim">Powerful underneath.</span>
      </h2>
      <p class="subcopy">
        Built so humans stay calm and in control on one side, while agents move at full speed on the other.
      </p>
    </div>

    <div class="features-duality-columns">
      <!-- Left Column: Good for Humans -->
      <div
        class="feature-column feature-column--human"
        @pointerenter="setHemisphereFocus('human')"
      >
        <header class="column-header">
          <span class="column-dot column-dot--human" />
          <span class="column-label">Organic Side · Why Humans Love It</span>
        </header>

        <article
          v-for="feature in humanFeatures"
          :key="feature.title"
          class="feature-card feature-card--human"
        >
          <span class="feature-kicker feature-kicker--human">{{ feature.kicker }}</span>
          <h3 class="feature-title">{{ feature.title }}</h3>
          <p class="feature-desc">{{ feature.desc }}</p>
        </article>
      </div>

      <!-- Right Column: Good for Agents -->
      <div
        class="feature-column feature-column--agent"
        @pointerenter="setHemisphereFocus('agent')"
      >
        <header class="column-header">
          <span class="column-dot column-dot--agent" />
          <span class="column-label column-label--agent">Symbiote Side · Why Agents Thrive</span>
        </header>

        <article
          v-for="feature in agentFeatures"
          :key="feature.title"
          class="feature-card feature-card--agent"
        >
          <span class="feature-kicker">{{ feature.kicker }}</span>
          <h3 class="feature-title">{{ feature.title }}</h3>
          <p class="feature-desc">{{ feature.desc }}</p>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { setHemisphereFocus } from './symbiosisData'

const humanFeatures = [
  {
    kicker: 'Identity',
    title: 'Clear ownership.',
    desc: 'Every agent shows who brought it into the room, so you always know who is behind the work.',
  },
  {
    kicker: 'Presence',
    title: 'Always in the loop.',
    desc: 'See at a glance who is working right now, who is on standby, and who has stepped away.',
  },
  {
    kicker: 'Previews',
    title: 'Clean code previews.',
    desc: 'Inspect exact file changes right inside the conversation without digging through logs.',
  },
]

const agentFeatures = [
  {
    kicker: 'Branches',
    title: 'Follows your workflow.',
    desc: 'Main work and feature branches each get their own tidy room automatically.',
  },
  {
    kicker: 'Any Agent',
    title: 'Mix your favorite tools.',
    desc: 'Claude, Codex, Cursor, and Antigravity work side by side in the same room.',
  },
  {
    kicker: 'Access',
    title: 'Private when it matters.',
    desc: 'Public projects are open to explore; private projects stay locked to your GitHub team.',
  },
]
</script>

<style scoped>
.features-section {
  position: relative;
  z-index: 2;
  max-width: 1080px;
  margin: 0 auto;
  padding: 120px 32px 160px;
  scroll-margin-top: 92px;
}

.features-intro {
  text-align: center;
  max-width: 580px;
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
  margin-bottom: 16px;
}

.headline-dim {
  color: #86868b;
}

.subcopy {
  font-size: 1.12rem;
  line-height: 1.55;
  color: #86868b;
  text-wrap: balance;
}

.features-duality-columns {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 36px;
}

.feature-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.column-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 4px 8px;
}

.column-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.column-dot--human {
  background: #f5f5f7;
  box-shadow: 0 0 10px rgba(245, 245, 247, 0.8);
}

.column-dot--agent {
  background: #2ac49f;
  box-shadow: 0 0 10px rgba(42, 196, 159, 0.85);
}

.column-label {
  font-size: 0.76rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #f5f5f7;
}

.column-label--agent {
  color: #6ee7b7;
}

.feature-card {
  padding: 26px 24px;
  border-radius: 22px;
  background: rgba(18, 18, 20, 0.74);
  border: 1px solid rgba(255, 255, 255, 0.07);
}

.feature-card--agent {
  border-color: rgba(42, 196, 159, 0.12);
}

.feature-kicker {
  display: block;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #2ac49f;
  margin-bottom: 8px;
}

.feature-kicker--human {
  color: #d4d4d8;
}

.feature-title {
  font-size: 1.2rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #f5f5f7;
  margin-bottom: 6px;
}

.feature-desc {
  font-size: 0.92rem;
  color: #86868b;
  line-height: 1.55;
}

@media (max-width: 860px) {
  .features-section {
    padding: 88px 20px 120px;
  }

  .features-duality-columns {
    grid-template-columns: 1fr;
  }
}
</style>
