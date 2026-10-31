<template>
  <section id="lending" class="lending-section">
    <div class="lending-intro">
      <h2 class="headline">
        Lend your agent.<br />
        <span class="headline-dim">Never your machine.</span>
      </h2>
      <p class="subcopy">
        Let a friend or open-source project borrow your agent when you aren’t using it.
        You choose what to share and can stop sharing at any time.
      </p>
    </div>

    <p class="demo-label" id="lending-demo-label">Interactive demo · No agent is connected</p>
    <div class="lending-card" aria-describedby="lending-demo-label">
      <div class="bridge-visual">
        <!-- Left: Your Machine (Always Locked) -->
        <div class="bridge-node">
          <div class="node-box node-box--locked">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <strong class="node-label">Your Mac</strong>
          <span class="node-meta">Your workspace</span>
        </div>

        <!-- Center: One-Way Safe Bridge -->
        <div class="bridge-connector" aria-hidden="true">
          <div class="connector-line" :class="{ 'connector-line--paused': isRevoked }">
            <span v-if="!isRevoked" class="connector-dot" />
          </div>
          <span class="connector-tag">
            {{ isRevoked ? 'Disconnected' : 'A shared task' }}
          </span>
        </div>

        <!-- Right: Shared Room -->
        <div class="bridge-node" :class="{ 'bridge-node--dim': isRevoked }">
          <div class="node-box node-box--agent">
            <ClaudeIcon :size="30" aria-hidden="true" />
          </div>
          <strong class="node-label">Teammate’s Room</strong>
          <span class="node-meta">{{ isRevoked ? 'Access ended' : 'Helps in a safe draft' }}</span>
        </div>
      </div>

      <div class="card-footer">
        <div class="footer-status" role="status">
          <span class="status-dot" :class="{ 'status-dot--revoked': isRevoked }" />
          <span>{{ isRevoked ? 'Sharing stopped' : 'Sharing Claude · Demo' }}</span>
        </div>

        <button
          type="button"
          class="toggle-btn"
          :class="{ 'toggle-btn--restore': isRevoked }"
          :aria-pressed="!isRevoked"
          @click="isRevoked = !isRevoked"
        >
          {{ isRevoked ? 'Share Again' : 'Stop Sharing' }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import ClaudeIcon from '@/components/icons/ClaudeIcon.vue'

const isRevoked = ref(false)
</script>

<style scoped>
.lending-section {
  position: relative;
  z-index: 2;
  max-width: 780px;
  margin: 0 auto;
  padding: 140px 32px;
  scroll-margin-top: calc(92px + env(safe-area-inset-top, 0px));
}

.lending-intro {
  text-align: center;
  max-width: 520px;
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

.headline {
  font-size: clamp(2.5rem, 5vw, 4.2rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.05;
  color: var(--l-text);
  margin-bottom: 16px;
  text-wrap: balance;
}

.headline-dim {
  color: var(--l-text-dim);
}

.subcopy {
  font-size: 1.14rem;
  line-height: 1.5;
  color: var(--l-text-dim);
  text-wrap: balance;
}

.lending-card {
  border-radius: 28px;
  border: 1px solid var(--l-glass-border);
  background: var(--l-glass-bg);
  backdrop-filter: blur(28px) saturate(160%);
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  box-shadow: var(--l-glass-shadow);
  overflow: hidden;
}

.bridge-visual {
  display: grid;
  grid-template-columns: 150px 1fr 150px;
  align-items: center;
  gap: 24px;
  padding: 48px 40px;
}

.bridge-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  transition: opacity 250ms ease;
}

.bridge-node--dim {
  opacity: 0.38;
}

.node-box {
  width: 60px;
  height: 60px;
  border-radius: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 12px;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: var(--l-glass-pill-shadow);
}

.node-box--locked {
  background: var(--l-glass-bg-elevated);
  border: 1px solid var(--l-glass-border);
  color: var(--l-text);
}

.node-box--agent {
  background: var(--l-glass-bg-elevated);
  border: 1px solid rgba(42, 196, 159, 0.38);
}

.node-box--agent svg {
  width: 30px;
  height: 30px;
  object-fit: contain;
}

.node-label {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--l-text);
  margin-bottom: 3px;
}

.node-meta {
  font-size: 0.78rem;
  color: var(--l-text-dim);
}

.bridge-connector {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.connector-line {
  position: relative;
  width: 100%;
  height: 2px;
  background: rgba(42, 196, 159, 0.35);
  overflow: hidden;
  transition: background 250ms ease;
}

.connector-line--paused {
  background: var(--l-track);
}

.connector-dot {
  position: absolute;
  top: -3px;
  left: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--l-mint);
  left: 50%;
}

.connector-tag {
  font-size: 0.78rem;
  color: var(--l-text-dim);
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 28px;
  border-top: 1px solid var(--l-glass-border-subtle);
  background: var(--l-glass-subbar);
}

.footer-status {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.86rem;
  color: var(--l-text-sub);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--l-mint);
}

.status-dot--revoked {
  background: #ef4444;
}

.demo-label { margin: 0 0 12px; color: var(--l-text-sub); text-align: center; font-size: .8rem; }

.toggle-btn {
  min-height: 44px;
  touch-action: manipulation;
  padding: 8px 18px;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--red-text, #f87171);
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.25);
  transition: background 200ms ease;
}

@media (hover: hover) and (pointer: fine) {
.toggle-btn:hover {
  background: rgba(239, 68, 68, 0.18);
}
}

.toggle-btn--restore {
  color: var(--l-cta-fg);
  background: var(--l-cta-bg);
  border-color: transparent;
}

@media (hover: hover) and (pointer: fine) {
.toggle-btn--restore:hover {
  background: var(--l-cta-hover-bg);
}
}

@media (max-width: 640px) {
  .lending-section {
    padding: 64px max(20px, env(safe-area-inset-right, 0px)) 64px max(20px, env(safe-area-inset-left, 0px));
  }

  .headline { font-size: clamp(2rem, 8vw, 2.6rem); }
  .subcopy { font-size: 1rem; }
  .lending-intro { margin-bottom: 28px; }
  .lending-card, .node-box { backdrop-filter: none; -webkit-backdrop-filter: none; }

  .bridge-visual {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 24px 12px;
    padding: 32px 20px;
  }

  .bridge-connector { grid-column: 1 / -1; grid-row: 2; }
  .node-label { font-size: .86rem; }
  .card-footer {
    padding: 16px;
    flex-direction: column;
    align-items: stretch;
    text-align: center;
  }

  .footer-status {
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .bridge-node, .connector-line, .toggle-btn { transition: none; }
}
</style>
