<template>
  <section id="lending" class="lending-section">
    <div class="lending-intro">
      <h2 class="headline">
        Lend your agent.<br />
        <span class="headline-dim">Never your machine.</span>
      </h2>
      <p class="subcopy">
        Let a friend or open-source project borrow your agent when you aren’t using it.
        Your computer and private files stay untouched.
      </p>
    </div>

    <div class="lending-card">
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
          <span class="node-meta">Files &amp; keys locked</span>
        </div>

        <!-- Center: One-Way Safe Bridge -->
        <div class="bridge-connector" aria-hidden="true">
          <div class="connector-line" :class="{ 'connector-line--paused': isRevoked }">
            <span v-if="!isRevoked" class="connector-dot" />
          </div>
          <span class="connector-tag">
            {{ isRevoked ? 'Disconnected' : 'Only the agent crosses over' }}
          </span>
        </div>

        <!-- Right: Shared Room -->
        <div class="bridge-node" :class="{ 'bridge-node--dim': isRevoked }">
          <div class="node-box node-box--agent">
            <img :src="claudeIcon" alt="Claude" width="28" height="28" />
          </div>
          <strong class="node-label">Teammate’s Room</strong>
          <span class="node-meta">{{ isRevoked ? 'Access ended' : 'Helps in a safe draft' }}</span>
        </div>
      </div>

      <div class="card-footer">
        <div class="footer-status">
          <span class="status-dot" :class="{ 'status-dot--revoked': isRevoked }" />
          <span>{{ isRevoked ? 'Sharing stopped' : 'Sharing Claude · Safe draft mode' }}</span>
        </div>

        <button
          type="button"
          class="toggle-btn"
          :class="{ 'toggle-btn--restore': isRevoked }"
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
import claudeIcon from '../../../../../apps/desktop/renderer/src/assets/harness-icons/claude-code.png'

const isRevoked = ref(false)
</script>

<style scoped>
.lending-section {
  position: relative;
  z-index: 2;
  max-width: 780px;
  margin: 0 auto;
  padding: 140px 32px;
  scroll-margin-top: 92px;
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

.lending-card {
  border-radius: 28px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(18, 18, 22, 0.38);
  backdrop-filter: blur(28px) saturate(150%);
  -webkit-backdrop-filter: blur(28px) saturate(150%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.12),
    0 24px 64px rgba(0, 0, 0, 0.45);
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
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.node-box--locked {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f5f5f7;
}

.node-box--agent {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(42, 196, 159, 0.38);
}

.node-box--agent img {
  width: 30px;
  height: 30px;
  object-fit: contain;
}

.node-label {
  font-size: 0.92rem;
  font-weight: 600;
  color: #f5f5f7;
  margin-bottom: 3px;
}

.node-meta {
  font-size: 0.78rem;
  color: #86868b;
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
  background: rgba(255, 255, 255, 0.08);
}

.connector-dot {
  position: absolute;
  top: -3px;
  left: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #2ac49f;
  animation: bridgeFlow 2.2s infinite cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes bridgeFlow {
  0% { left: 0%; opacity: 0; }
  15% { opacity: 1; }
  85% { opacity: 1; }
  100% { left: calc(100% - 8px); opacity: 0; }
}

.connector-tag {
  font-size: 0.78rem;
  color: #86868b;
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 28px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(0, 0, 0, 0.18);
}

.footer-status {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.86rem;
  color: #d4d4d8;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #2ac49f;
}

.status-dot--revoked {
  background: #ef4444;
}

.toggle-btn {
  padding: 8px 18px;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  color: #f87171;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.25);
  transition: background 200ms ease;
}

.toggle-btn:hover {
  background: rgba(239, 68, 68, 0.18);
}

.toggle-btn--restore {
  color: #000000;
  background: #f5f5f7;
  border-color: transparent;
}

.toggle-btn--restore:hover {
  background: #ffffff;
}

@media (max-width: 640px) {
  .lending-section {
    padding: 96px 20px;
  }

  .bridge-visual {
    grid-template-columns: 1fr;
    padding: 32px 20px;
  }

  .card-footer {
    flex-direction: column;
    align-items: stretch;
    text-align: center;
  }

  .footer-status {
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .connector-dot {
    animation: none;
    left: 50%;
  }
}
</style>
