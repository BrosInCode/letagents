<template>
  <section id="lending" class="lending-section">
    <div class="lending-header">
      <span class="section-eyebrow">
        <span class="eyebrow-glyph">⬡</span>
        COMPUTE DEMOCRATIZATION · HANDOFF V1 &amp; RENTAL ENGINE
      </span>
      <h2 class="lending-title">
        Lend your idle agent.<br />
        <em>They get the repo job you share,</em> <span class="title-teal">not your computer.</span>
      </h2>
      <p class="lending-sub">
        Most paid <strong>Claude Max</strong>, <strong>ChatGPT Pro (Codex)</strong>, and <strong>Cursor</strong>
        subscriptions sit idle for hours while open-source maintainers and teammates hit rate-limit walls
        (<code>renter_lane_exhausted</code>). LetAgents turns unused local quota into bounded, metered room workers
        governed by a six-pillar cryptographic trust contract.
      </p>
    </div>

    <div class="lending-workbench">
      <!-- Left: Interactive Handoff & Quota Lease Builder -->
      <div class="lease-builder-card">
        <div class="builder-group">
          <div class="builder-label-row">
            <span class="builder-step">01</span>
            <span class="builder-label">CHOOSE IDLE SUBSCRIPTION LANE TO LEND</span>
          </div>
          <div class="provider-grid">
            <button
              v-for="p in providers"
              :key="p.id"
              type="button"
              class="provider-option"
              :class="{ 'provider-option--active': selectedProviderId === p.id }"
              @click="selectedProviderId = p.id"
            >
              <div class="provider-top">
                <strong>{{ p.name }}</strong>
                <span class="confidence-pill">{{ p.meterConfidence }}</span>
              </div>
              <span class="provider-owner">{{ p.owner }}</span>
              <span class="provider-model">{{ p.modelLabel }}</span>
            </button>
          </div>
        </div>

        <div class="builder-group">
          <div class="builder-label-row">
            <span class="builder-step">02</span>
            <span class="builder-label">SELECT OUTPUT-BOUND PERMISSION PROFILE (PILLAR 2)</span>
          </div>
          <div class="profile-tabs" role="tablist" aria-label="Output-bound permission profiles">
            <button
              v-for="prof in profiles"
              :key="prof.id"
              type="button"
              role="tab"
              :aria-selected="selectedProfileId === prof.id"
              class="profile-tab"
              :class="{ 'profile-tab--active': selectedProfileId === prof.id }"
              @click="selectedProfileId = prof.id"
            >
              <code>{{ prof.label }}</code>
              <span>{{ prof.badge }}</span>
            </button>
          </div>
        </div>

        <div class="builder-group">
          <div class="builder-label-row">
            <span class="builder-step">03</span>
            <span class="builder-label">SET LRT QUOTA LEASE CAP &amp; START TRIGGER</span>
          </div>
          <div class="quota-controls">
            <div class="lrt-selector">
              <button
                v-for="cap in [250, 500, 900]"
                :key="cap"
                type="button"
                class="lrt-btn"
                :class="{ 'lrt-btn--active': selectedLrtCap === cap }"
                @click="selectedLrtCap = cap"
              >
                {{ cap }} LRT Cap
              </button>
            </div>

            <div class="trigger-selector">
              <button
                v-for="trig in triggers"
                :key="trig.id"
                type="button"
                class="trig-btn"
                :class="{ 'trig-btn--active': selectedTrigger === trig.id }"
                @click="selectedTrigger = trig.id"
              >
                {{ trig.label }}
              </button>
            </div>
          </div>
        </div>

        <!-- Capabilities vs Hard Denials Comparison -->
        <div class="permissions-split">
          <div class="perm-col perm-col--allowed">
            <h4>✓ Granted by Output Profile</h4>
            <ul>
              <li v-for="item in currentProfile.capabilities" :key="item">{{ item }}</li>
            </ul>
          </div>
          <div class="perm-col perm-col--denied">
            <h4>✕ Sealed by Host Fence</h4>
            <ul>
              <li v-for="item in currentProfile.denied" :key="item">{{ item }}</li>
            </ul>
          </div>
        </div>
      </div>

      <!-- Right: Live Rental Session & Sovereign Telemetry Console -->
      <div class="lease-console-card" :class="{ 'lease-console-card--revoked': isRevoked }">
        <header class="console-header">
          <div class="console-title-wrap">
            <span class="console-status-dot" :class="{ 'console-status-dot--revoked': isRevoked }" />
            <div>
              <strong>{{ isRevoked ? 'LEASE_REVOKED (HARD CUT)' : 'RENTAL_SESSION · ACTIVE LEASE' }}</strong>
              <span class="console-sub">rental_sessions + rental_usage_meters</span>
            </div>
          </div>

          <button
            type="button"
            class="revoke-toggle-btn"
            :class="{ 'revoke-toggle-btn--restore': isRevoked }"
            @click="isRevoked = !isRevoked"
          >
            {{ isRevoked ? '↺ Restore Lease' : '⚡ Simulate Instant Revoke' }}
          </button>
        </header>

        <!-- Meter Gauge -->
        <div class="meter-box">
          <div class="meter-top">
            <div>
              <span class="meter-kicker">LIVE LRT QUOTA METER ({{ currentProvider.quotaUnit.toUpperCase() }})</span>
              <div class="meter-readout">
                <strong>{{ isRevoked ? simulatedUsedLrt : simulatedUsedLrt }} LRT</strong>
                <span>/ {{ selectedLrtCap }} LRT reserved · stop threshold 0.95</span>
              </div>
            </div>
            <span class="meter-badge">{{ currentProvider.meterConfidence }}</span>
          </div>

          <div class="meter-bar-track" role="progressbar" :aria-valuenow="meterPercent" aria-valuemin="0" aria-valuemax="100">
            <div
              class="meter-bar-fill"
              :class="{ 'meter-bar-fill--revoked': isRevoked }"
              :style="{ width: `${meterPercent}%` }"
            />
          </div>

          <div class="meter-caption">
            <span>{{ currentProvider.statusSummary }}</span>
            <code>idempotency_key: meter_{{ currentProvider.runtimeKind }}_04</code>
          </div>
        </div>

        <!-- Deterministic Manifest Readout -->
        <div class="manifest-grid">
          <div class="manifest-row">
            <span class="manifest-key">PROVIDER_HOST</span>
            <code class="manifest-val">{{ currentProvider.owner }} ({{ currentProvider.runtimeKind }})</code>
          </div>
          <div class="manifest-row">
            <span class="manifest-key">START_TRIGGER</span>
            <code class="manifest-val">{{ selectedTrigger }} · continuity: smart_handoff</code>
          </div>
          <div class="manifest-row">
            <span class="manifest-key">BRANCH_NAMESPACE</span>
            <code class="manifest-val manifest-val--teal">{{ currentProfile.branchRule }}</code>
          </div>
          <div class="manifest-row">
            <span class="manifest-key">SECRET_SCAN_GATE</span>
            <code class="manifest-val manifest-val--amber">{{ currentProfile.secretPolicy }}</code>
          </div>
          <div class="manifest-row">
            <span class="manifest-key">GITHUB_ENFORCEMENT</span>
            <code class="manifest-val">{{ currentProfile.githubCheck }}</code>
          </div>
          <div class="manifest-row">
            <span class="manifest-key">SIDE_EFFECT_STATE</span>
            <code class="manifest-val" :class="isRevoked ? 'manifest-val--red' : 'manifest-val--teal'">
              {{ isRevoked ? 'HARD_FAILED · Fetch/Push/Comment credentials invalidated' : 'AUTHORIZED · Heartbeat verified (30s interval)' }}
            </code>
          </div>
        </div>

        <footer class="console-footer">
          <p v-if="!isRevoked">
            <strong>Pillar 4 (Sovereign Platform Policy):</strong> Repository markdown, prompts, or scripts can never self-escalate beyond this capability manifest.
          </p>
          <p v-else class="revoked-notice">
            <strong>Pillar 5 (Instant Revocation):</strong> Stopping a handoff is a hard permission cut. Audit recorded who stopped the task, timestamp, and last verified side effect.
          </p>
        </footer>
      </div>
    </div>

    <!-- Six Pillars of Handoff v1 Strip -->
    <div class="pillars-grid">
      <div v-for="pillar in sixPillars" :key="pillar.num" class="pillar-card">
        <span class="pillar-num">{{ pillar.num }}</span>
        <h3>{{ pillar.title }}</h3>
        <p>{{ pillar.desc }}</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  HANDOFF_OUTPUT_PROFILES,
  RENTAL_PROVIDERS,
  type HandoffOutputProfile,
} from './symbiosisData'

const providers = RENTAL_PROVIDERS
const profiles = HANDOFF_OUTPUT_PROFILES

const selectedProviderId = ref(providers[0].id)
const selectedProfileId = ref<HandoffOutputProfile['id']>('draft_pr')
const selectedLrtCap = ref(500)
const selectedTrigger = ref<'quota_exhausted' | 'task_handoff' | 'user_initiated'>('quota_exhausted')
const isRevoked = ref(false)

const triggers = [
  { id: 'quota_exhausted' as const, label: 'Auto-Failover (quota_exhausted)' },
  { id: 'task_handoff' as const, label: 'Task Handoff' },
  { id: 'user_initiated' as const, label: 'Manual Lend' },
]

const currentProvider = computed(() => {
  return providers.find(p => p.id === selectedProviderId.value) ?? providers[0]
})

const currentProfile = computed(() => {
  return profiles.find(p => p.id === selectedProfileId.value) ?? profiles[0]
})

const simulatedUsedLrt = computed(() => {
  return Math.round(selectedLrtCap.value * 0.42)
})

const meterPercent = computed(() => {
  return Math.min(100, Math.round((simulatedUsedLrt.value / selectedLrtCap.value) * 100))
})

const sixPillars = [
  {
    num: 'PILLAR 01',
    title: 'Single Safe Lane',
    desc: 'Isolated execution with zero host shell access, zero host environment leakage, and strict workspace fencing.',
  },
  {
    num: 'PILLAR 02',
    title: 'Output-Bound Permissions',
    desc: 'Grants derive directly from the artifact: research_note (read), review_comment (PR verdict), or draft_pr (scoped branch).',
  },
  {
    num: 'PILLAR 03',
    title: 'Strict Lifecycle Boundaries',
    desc: 'One repo-scoped task per handoff with mandatory liveness heartbeats and automatic expiration on timeout.',
  },
  {
    num: 'PILLAR 04',
    title: 'Sovereign Platform Policy',
    desc: 'Repository prompts or scripts are untrusted task input—they can never expand scope or self-escalate permissions.',
  },
  {
    num: 'PILLAR 05',
    title: 'Instant Hard Revocation',
    desc: 'Revoking a lease immediately invalidates fetch, push, and comment capabilities and logs the final side effect.',
  },
  {
    num: 'PILLAR 06',
    title: 'No Silent Sub-Delegation',
    desc: 'Workers cannot recursively spawn child grants underneath you; every handoff requires explicit approval.',
  },
]
</script>

<style scoped>
.lending-section {
  padding: 108px 40px;
  max-width: 1340px;
  margin: 0 auto;
  scroll-margin-top: 92px;
}

.lending-header {
  max-width: 820px;
  margin-bottom: 44px;
}

.section-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #5eead4;
  margin-bottom: 14px;
}

.eyebrow-glyph {
  color: #fbbf24;
}

.lending-title {
  font-size: clamp(2.1rem, 1.4rem + 2.4vw, 3.4rem);
  font-weight: 850;
  letter-spacing: -0.03em;
  line-height: 1.08;
  color: #fafafa;
  margin-bottom: 16px;
  text-wrap: balance;
}

.lending-title em {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: #fde68a;
}

.title-teal {
  color: #2ac49f;
}

.lending-sub {
  font-size: 1.04rem;
  color: var(--text-secondary);
  line-height: 1.68;
  max-width: 70ch;
  text-wrap: pretty;
}

.lending-sub strong {
  color: #f4f1ea;
}

.lending-sub code {
  font-size: 0.86em;
  padding: 2px 6px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.06);
  color: #fbbf24;
}

/* Workbench Grid */
.lending-workbench {
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(0, 0.92fr);
  gap: 24px;
  align-items: stretch;
  margin-bottom: 28px;
}

.lease-builder-card,
.lease-console-card {
  border-radius: 24px;
  padding: 28px;
  background: #101217;
  border: 1px solid rgba(255, 255, 255, 0.09);
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.lease-console-card {
  background:
    radial-gradient(circle at 100% 0%, rgba(42, 196, 159, 0.12), transparent 58%),
    #0b0e13;
  border-color: rgba(42, 196, 159, 0.28);
  transition: border-color 220ms ease, background 220ms ease;
}

.lease-console-card--revoked {
  background:
    radial-gradient(circle at 100% 0%, rgba(239, 68, 68, 0.14), transparent 58%),
    #120b0d;
  border-color: rgba(239, 68, 68, 0.45);
}

.builder-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.builder-label-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.builder-step {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  font-weight: 800;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
}

.builder-label {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
}

.provider-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.provider-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(255, 255, 255, 0.08);
  text-align: left;
  transition: all 180ms ease;
}

.provider-option:hover {
  border-color: rgba(255, 255, 255, 0.2);
}

.provider-option--active {
  background: rgba(42, 196, 159, 0.1);
  border-color: rgba(42, 196, 159, 0.5);
}

.provider-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 8px;
}

.provider-top strong {
  font-size: 0.88rem;
  color: #fafafa;
}

.confidence-pill {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: #5eead4;
}

.provider-owner {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: #fbbf24;
}

.provider-model {
  font-size: 0.73rem;
  color: var(--text-secondary);
}

.profile-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.profile-tab {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 11px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(255, 255, 255, 0.08);
  text-align: left;
  transition: all 180ms ease;
}

.profile-tab code {
  font-size: 0.8rem;
  font-weight: 700;
  color: #fafafa;
}

.profile-tab span {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  color: var(--text-secondary);
}

.profile-tab--active {
  background: rgba(245, 158, 11, 0.12);
  border-color: rgba(245, 158, 11, 0.48);
}

.profile-tab--active code {
  color: #fde68a;
}

.quota-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: space-between;
}

.lrt-selector,
.trigger-selector {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.lrt-btn,
.trig-btn {
  padding: 7px 11px;
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  transition: all 160ms ease;
}

.lrt-btn--active,
.trig-btn--active {
  color: #fafafa;
  background: rgba(42, 196, 159, 0.14);
  border-color: rgba(42, 196, 159, 0.45);
}

.permissions-split {
  margin-top: auto;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.perm-col {
  padding: 14px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.07);
}

.perm-col h4 {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.05em;
  margin-bottom: 8px;
}

.perm-col--allowed h4 {
  color: #5eead4;
}

.perm-col--denied h4 {
  color: #fca5a5;
}

.perm-col ul {
  list-style: none;
  display: grid;
  gap: 6px;
}

.perm-col li {
  font-size: 0.76rem;
  color: var(--text-secondary);
  line-height: 1.45;
}

/* Console Right Side */
.console-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.console-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

.console-status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #2ac49f;
  box-shadow: 0 0 12px #2ac49f;
}

.console-status-dot--revoked {
  background: #ef4444;
  box-shadow: 0 0 12px #ef4444;
}

.console-title-wrap strong {
  display: block;
  font-family: var(--font-mono);
  font-size: 0.82rem;
  color: #fafafa;
}

.console-sub {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--text-secondary);
}

.revoke-toggle-btn {
  padding: 8px 13px;
  border-radius: 9px;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 700;
  background: rgba(239, 68, 68, 0.14);
  color: #fca5a5;
  border: 1px solid rgba(239, 68, 68, 0.38);
  transition: all 180ms ease;
}

.revoke-toggle-btn:hover {
  background: rgba(239, 68, 68, 0.24);
}

.revoke-toggle-btn--restore {
  background: rgba(42, 196, 159, 0.16);
  color: #5eead4;
  border-color: rgba(42, 196, 159, 0.45);
}

.meter-box {
  padding: 16px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.meter-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.meter-kicker {
  font-family: var(--font-mono);
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
}

.meter-readout {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 2px;
}

.meter-readout strong {
  font-family: var(--font-mono);
  font-size: 1.25rem;
  color: #f4f1ea;
}

.meter-readout span {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--text-secondary);
}

.meter-badge {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(42, 196, 159, 0.14);
  color: #5eead4;
}

.meter-bar-track {
  height: 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
}

.meter-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #f59e0b, #2ac49f);
  transition: width 260ms ease;
}

.meter-bar-fill--revoked {
  background: #ef4444;
}

.meter-caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 0.73rem;
  color: var(--text-secondary);
}

.meter-caption code {
  font-size: 0.68rem;
  color: #94a3b8;
}

.manifest-grid {
  display: grid;
  gap: 8px;
}

.manifest-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.manifest-key {
  font-family: var(--font-mono);
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.manifest-val {
  font-size: 0.74rem;
  color: #e2e8f0;
  text-align: right;
  overflow-wrap: anywhere;
}

.manifest-val--teal {
  color: #5eead4;
}

.manifest-val--amber {
  color: #fde68a;
}

.manifest-val--red {
  color: #f87171;
  font-weight: 700;
}

.console-footer {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 0.8rem;
  color: var(--text-secondary);
  line-height: 1.55;
}

.console-footer strong {
  color: #f4f1ea;
}

.revoked-notice {
  color: #fca5a5;
}

/* Six Pillars Grid */
.pillars-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.pillar-card {
  padding: 20px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.07);
  transition: border-color 180ms ease;
}

.pillar-card:hover {
  border-color: rgba(255, 255, 255, 0.16);
}

.pillar-num {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 800;
  letter-spacing: 0.09em;
  color: #fbbf24;
  margin-bottom: 6px;
}

.pillar-card h3 {
  font-size: 0.98rem;
  font-weight: 750;
  color: #fafafa;
  margin-bottom: 6px;
}

.pillar-card p {
  font-size: 0.82rem;
  color: var(--text-secondary);
  line-height: 1.58;
  text-wrap: pretty;
}

@media (max-width: 1080px) {
  .lending-workbench {
    grid-template-columns: 1fr;
  }

  .pillars-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 768px) {
  .lending-section {
    padding: 76px 20px;
  }

  .provider-grid,
  .profile-tabs,
  .permissions-split,
  .pillars-grid {
    grid-template-columns: 1fr;
  }
}
</style>
