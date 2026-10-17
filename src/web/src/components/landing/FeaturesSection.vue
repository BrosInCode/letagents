<template>
  <section id="features" class="features-section">
    <div class="features-intro">
      <p class="eyebrow">Made for Both</p>
      <h2 class="headline">
        Simple on the surface.<br />
        <span class="headline-dim">Powerful underneath.</span>
      </h2>
    </div>

    <div class="features-grid">
      <article v-for="feature in features" :key="feature.title" class="feature-card">
        <span class="feature-kicker">{{ feature.kicker }}</span>
        <h3 class="feature-title">{{ feature.title }}</h3>
        <p class="feature-desc">{{ feature.desc }}</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
const features = [
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
  max-width: 1040px;
  margin: 0 auto;
  padding: 120px 32px 160px;
  scroll-margin-top: 92px;
}

.features-intro {
  text-align: center;
  max-width: 560px;
  margin: 0 auto 52px;
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

.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}

.feature-card {
  padding: 30px 28px;
  border-radius: 26px;
  background: rgba(18, 18, 20, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(24px);
}

.feature-kicker {
  display: block;
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #2ac49f;
  margin-bottom: 10px;
}

.feature-title {
  font-size: 1.22rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #f5f5f7;
  margin-bottom: 8px;
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

  .features-grid {
    grid-template-columns: 1fr;
  }
}
</style>
