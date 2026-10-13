<template>
  <section id="lending" class="lending-section" @pointerleave="setHemisphereFocus('fused')">
    <div class="lending-intro">
      <p class="eyebrow">Share Your Agent</p>
      <h2 class="headline">
        Lend your agent.<br />
        <span class="headline-dim">Never your machine.</span>
      </h2>
      <p class="subcopy">
        Let a friend or open-source project borrow your agent when you aren’t using it.
        They get the help they need; your computer and private files stay untouched.
      </p>
    </div>

    <div class="lending-widget">
      <div class="widget-top">
        <div class="lender-identity">
          <span class="status-dot" :class="{ 'status-dot--revoked': isRevoked }" />
          <div>
            <strong>Sharing Claude with alex/payments</strong>
            <span>{{ isRevoked ? 'Stopped immediately' : 'Active · 45 minutes left' }}</span>
          </div>
        </div>

        <button
          type="button"
          class="revoke-btn"
          :class="{ 'revoke-btn--restore': isRevoked }"
          @click="isRevoked = !isRevoked"
        >
          {{ isRevoked ? 'Share Again' : 'Stop Sharing' }}
        </button>
      </div>

      <div class="widget-body" :class="{ 'widget-body--dimmed': isRevoked }">
        <div class="scope-picker">
          <span class="picker-label">Choose what your agent can do</span>
          <div class="scope-pills" role="tablist" aria-label="Allowed actions">
            <button
              v-for="scope in scopes"
              :key="scope.id"
              type="button"
              role="tab"
              :aria-selected="selectedScope === scope.id"
              class="scope-pill"
              :class="{ 'scope-pill--active': selectedScope === scope.id }"
              @click="selectedScope = scope.id"
            >
              <strong>{{ scope.title }}</strong>
              <small>{{ scope.subtitle }}</small>
            </button>
          </div>
        </div>

        <div class="scope-details" v-if="activeScope">
          <div
            class="detail-col detail-col--agent"
            @pointerenter="setHemisphereFocus('agent')"
          >
            <div class="detail-header">
              <span class="detail-dot detail-dot--agent" />
              <span class="detail-heading">For the Borrowed Agent · Allowed</span>
            </div>
            <ul class="detail-list">
              <li v-for="item in activeScope.allowed" :key="item">
                <span class="check-icon">✓</span>
                <span>{{ item }}</span>
              </li>
            </ul>
          </div>

          <div
            class="detail-col detail-col--human"
            @pointerenter="setHemisphereFocus('human')"
          >
            <div class="detail-header">
              <span class="detail-dot detail-dot--human" />
              <span class="detail-heading">For You (The Human) · Always Private</span>
            </div>
            <ul class="detail-list detail-list--locked">
              <li v-for="item in activeScope.protected" :key="item">
                <span class="lock-icon">—</span>
                <span>{{ item }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { setHemisphereFocus } from './symbiosisData'

const isRevoked = ref(false)
const selectedScope = ref<'draft_pr' | 'review_comment' | 'research_note'>('draft_pr')

const scopes = [
  {
    id: 'draft_pr' as const,
    title: 'Propose Code',
    subtitle: 'Safe draft only',
    allowed: [
      'Read the shared project files',
      'Write code in a separate draft',
      'Submit changes for approval',
    ],
    protected: [
      'Never touches your personal files',
      'Cannot change live production code',
      'Automatically checks for accidental secrets',
    ],
  },
  {
    id: 'review_comment' as const,
    title: 'Review Code',
    subtitle: 'Read and give feedback',
    allowed: [
      'Read new code changes',
      'Leave helpful review notes',
      'Approve or flag issues',
    ],
    protected: [
      'Cannot edit or push any files',
      'Your passwords and keys stay hidden',
      'Disconnects as soon as the review is done',
    ],
  },
  {
    id: 'research_note' as const,
    title: 'Answer Questions',
    subtitle: 'Explore and explain',
    allowed: [
      'Read and understand the project',
      'Answer questions in the room',
      'Share a clear summary note',
    ],
    protected: [
      'Zero file changes of any kind',
      'No access to your computer',
      'Stop sharing with one click anytime',
    ],
  },
]

const activeScope = computed(() => scopes.find((s) => s.id === selectedScope.value) ?? scopes[0])
</script>

<style scoped>
.lending-section {
  position: relative;
  z-index: 2;
  max-width: 920px;
  margin: 0 auto;
  padding: 140px 32px;
  scroll-margin-top: 92px;
}

.lending-intro {
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

.headline {
  font-size: clamp(2.5rem, 5vw, 4.2rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.05;
  color: #f5f5f7;
  margin-bottom: 18px;
  text-wrap: balance;
}

.headline-dim {
  color: #86868b;
}

.subcopy {
  font-size: 1.18rem;
  line-height: 1.55;
  color: #86868b;
  text-wrap: balance;
}

.lending-widget {
  border-radius: 28px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(18, 18, 20, 0.78);
  backdrop-filter: blur(28px);
  box-shadow: 0 32px 80px rgba(0, 0, 0, 0.52);
  overflow: hidden;
}

.widget-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 22px 28px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.lender-identity {
  display: flex;
  align-items: center;
  gap: 14px;
}

.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #2ac49f;
  box-shadow: 0 0 12px rgba(42, 196, 159, 0.8);
  flex-shrink: 0;
}

.status-dot--revoked {
  background: #ef4444;
  box-shadow: 0 0 12px rgba(239, 68, 68, 0.7);
}

.lender-identity strong {
  display: block;
  font-size: 0.94rem;
  font-weight: 600;
  color: #f5f5f7;
}

.lender-identity span {
  display: block;
  font-size: 0.8rem;
  color: #86868b;
  margin-top: 2px;
}

.revoke-btn {
  padding: 8px 18px;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  color: #f87171;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.25);
  transition: background 200ms ease, transform 200ms ease;
}

.revoke-btn:hover {
  background: rgba(239, 68, 68, 0.18);
  transform: scale(1.02);
}

.revoke-btn--restore {
  color: #000000;
  background: #f5f5f7;
  border-color: transparent;
}

.revoke-btn--restore:hover {
  background: #ffffff;
}

.widget-body {
  padding: 28px;
  transition: opacity 250ms ease;
}

.widget-body--dimmed {
  opacity: 0.4;
}

.picker-label {
  display: block;
  font-size: 0.76rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #86868b;
  margin-bottom: 12px;
}

.scope-pills {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 24px;
}

.scope-pill {
  text-align: left;
  padding: 16px 18px;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.025);
  transition: border-color 200ms ease, background 200ms ease;
}

.scope-pill strong {
  display: block;
  font-size: 0.92rem;
  font-weight: 600;
  color: #f5f5f7;
}

.scope-pill small {
  display: block;
  font-size: 0.8rem;
  color: #86868b;
  margin-top: 3px;
}

.scope-pill:hover {
  border-color: rgba(255, 255, 255, 0.18);
}

.scope-pill--active {
  border-color: rgba(42, 196, 159, 0.5);
  background: rgba(42, 196, 159, 0.07);
}

.scope-details {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 18px;
}

.detail-col {
  padding: 22px;
  border-radius: 20px;
  transition: border-color 250ms ease, transform 250ms ease;
}

.detail-col--agent {
  background: rgba(42, 196, 159, 0.045);
  border: 1px solid rgba(42, 196, 159, 0.16);
}

.detail-col--agent:hover {
  border-color: rgba(42, 196, 159, 0.42);
  transform: translateY(-2px);
}

.detail-col--human {
  background: rgba(245, 245, 247, 0.035);
  border: 1px solid rgba(245, 245, 247, 0.11);
}

.detail-col--human:hover {
  border-color: rgba(245, 245, 247, 0.32);
  transform: translateY(-2px);
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}

.detail-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.detail-dot--agent {
  background: #2ac49f;
}

.detail-dot--human {
  background: #f5f5f7;
}

.detail-heading {
  font-size: 0.78rem;
  font-weight: 600;
  color: #f5f5f7;
}

.detail-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.detail-list li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 0.9rem;
  line-height: 1.5;
  color: #d4d4d8;
}

.check-icon {
  color: #2ac49f;
  font-weight: 700;
}

.lock-icon {
  color: #86868b;
}

@media (max-width: 768px) {
  .lending-section {
    padding: 96px 20px;
  }

  .widget-top {
    flex-direction: column;
    align-items: flex-start;
  }

  .scope-pills,
  .scope-details {
    grid-template-columns: 1fr;
  }
}
</style>
