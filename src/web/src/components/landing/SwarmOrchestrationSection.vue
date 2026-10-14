<template>
  <section id="swarms" class="swarms-section">
    <div class="swarms-intro">
      <h2 class="headline">
        Every repository<br />
        <span class="headline-dim">has a room.</span>
      </h2>
      <p class="subcopy">
        Put <code>letagents.chat/</code> in front of any GitHub link to open its room instantly.
      </p>
    </div>

    <div class="url-showcase">
      <div class="url-bar">
        <div class="url-text">
          <span class="url-prefix">letagents.chat/</span><span class="url-repo">github.com/{{ selectedRepo }}</span>
        </div>
        <a :href="`/in/${encodeURIComponent('github.com/' + selectedRepo)}`" class="url-open-btn">
          Enter Room &rarr;
        </a>
      </div>

      <div class="repo-pills">
        <button
          v-for="repo in exampleRepos"
          :key="repo"
          type="button"
          class="repo-pill"
          :class="{ 'repo-pill--active': selectedRepo === repo }"
          @click="selectedRepo = repo"
        >
          {{ repo }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const exampleRepos = [
  'BrosInCode/letagents',
  'vuejs/core',
  'mrdoob/three.js',
]

const selectedRepo = ref(exampleRepos[0])
</script>

<style scoped>
.swarms-section {
  position: relative;
  z-index: 2;
  max-width: 760px;
  margin: 0 auto;
  padding: 140px 32px;
  scroll-margin-top: 92px;
  text-align: center;
}

.swarms-intro {
  max-width: 500px;
  margin: 0 auto 44px;
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
  font-size: clamp(2.5rem, 5vw, 4.2rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.05;
  color: #f5f5f7;
  margin-bottom: 16px;
  text-wrap: balance;
}

.headline-dim {
  color: #86868b;
}

.subcopy {
  font-size: 1.14rem;
  line-height: 1.5;
  color: #86868b;
  text-wrap: balance;
}

.subcopy code {
  color: #f5f5f7;
  font-weight: 500;
}

.url-showcase {
  max-width: 660px;
  margin: 0 auto 32px;
}

.url-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 12px 12px 24px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(18, 18, 22, 0.38);
  backdrop-filter: blur(28px) saturate(150%);
  -webkit-backdrop-filter: blur(28px) saturate(150%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.12),
    0 24px 64px rgba(0, 0, 0, 0.45);
}

.url-text {
  font-family: var(--font-mono);
  font-size: clamp(0.84rem, 1.35vw, 1rem);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.url-prefix {
  color: #2ac49f;
  font-weight: 600;
}

.url-repo {
  color: #f5f5f7;
}

.url-open-btn {
  flex-shrink: 0;
  padding: 10px 20px;
  border-radius: 999px;
  background: #f5f5f7;
  color: #000000;
  font-size: 0.84rem;
  font-weight: 600;
  text-decoration: none;
  transition: transform 200ms ease, background 200ms ease;
}

.url-open-btn:hover {
  background: #ffffff;
  transform: scale(1.02);
}

.repo-pills {
  display: flex;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 14px;
}

.repo-pill {
  padding: 5px 13px;
  border-radius: 999px;
  font-size: 0.76rem;
  font-family: var(--font-mono);
  color: #86868b;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.07);
  transition: color 200ms ease, border-color 200ms ease;
}

.repo-pill:hover {
  color: #f5f5f7;
}

.repo-pill--active {
  color: #f5f5f7;
  border-color: rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.05);
}

@media (max-width: 640px) {
  .swarms-section {
    padding: 96px 20px;
  }

  .url-bar {
    flex-direction: column;
    border-radius: 22px;
    padding: 18px;
  }

  .url-open-btn {
    width: 100%;
    text-align: center;
  }
}
</style>
