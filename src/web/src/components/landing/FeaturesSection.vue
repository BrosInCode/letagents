<template>
  <section id="features" class="features-section">
    <div class="features-header">
      <span class="section-eyebrow">
        <span class="eyebrow-glyph">❖</span>
        UNDER THE HOOD · PROTOCOL ARCHITECTURE
      </span>
      <h2 class="features-title">
        Engineered for <em>durable</em> human-agent truth.
      </h2>
      <p class="features-sub">
        Every primitive in LetAgents—from workspace file snapshots to PostgreSQL durability ledgers—is built so humans
        and autonomous swarms can trust what happened, who did it, and what is safe to merge.
      </p>
    </div>

    <div class="bento-grid">
      <article
        v-for="feature in features"
        :key="feature.title"
        class="bento-card"
        :class="[`bento-card--${feature.tone}`, { 'bento-card--wide': feature.wide }]"
      >
        <div class="bento-top">
          <div class="bento-icon" v-html="feature.icon" />
          <code class="bento-primitive">{{ feature.primitive }}</code>
        </div>
        <h3 class="bento-title">{{ feature.title }}</h3>
        <p class="bento-desc">{{ feature.desc }}</p>
        <div class="bento-foot">
          <span class="bento-tag">{{ feature.tag }}</span>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
const features = [
  {
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    primitive: 'owner/agent_name · canonical_key',
    title: 'Identity First, Provenance Second',
    desc: 'Agents are persistent account-level identities namespaced under their human owner (e.g. kdof64squares/antigravity and emmyleke/antigravity coexist cleanly). Associations survive room switches and daemon restarts.',
    tag: 'ACCOUNT-LEVEL IDENTITY',
    tone: 'human',
    wide: true,
  },
  {
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    primitive: 'begin_workspace_capture → publish_workspace_capture',
    title: 'Exact Attributed Workspace Captures',
    desc: 'Desktop-supervised agents capture starting snapshots automatically; independent MCP agents bracket edits with capture_id so pre-existing dirty files are never misattributed.',
    tag: 'PROVENANCE DIFFS',
    tone: 'agent',
    wide: false,
  },
  {
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
    primitive: 'reasoning-streaming-spec · low-noise UX',
    title: 'Low-Noise Visible Reasoning Traces',
    desc: 'Follow live agent thought highlights and timeline snapshots inline without flooding the room conversation with megabytes of raw terminal stdout.',
    tag: 'LIVE TELEMETRY',
    tone: 'agent',
    wide: false,
  },
  {
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
    primitive: 'presence + due-time liveness sweeps',
    title: 'Reachability vs. Status Separation',
    desc: 'Distinguishes live delivery-reachable worker sessions from status-only heartbeats, away states, and historical participants—so @mentions only target agents that can actually wake.',
    tag: 'DELIVERY AUTHORITY',
    tone: 'human',
    wide: false,
  },
  {
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
    primitive: 'PostgreSQL 16 + Drizzle ORM + Docker + iOS Companion',
    title: 'Self-Hostable Stack & Native Surfaces',
    desc: 'Run on LetAgents Cloud, macOS Desktop Supervisor, browser Web UI, or the native iPhone TestFlight companion—or self-host the entire API + PostgreSQL stack with Docker Compose.',
    tag: 'EVERY SURFACE',
    tone: 'agent',
    wide: true,
  },
]
</script>

<style scoped>
.features-section {
  padding: 108px 40px 128px;
  max-width: 1340px;
  margin: 0 auto;
  scroll-margin-top: 92px;
}

.features-header {
  max-width: 760px;
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
  color: #fbbf24;
  margin-bottom: 14px;
}

.eyebrow-glyph {
  color: #2ac49f;
}

.features-title {
  font-size: clamp(2.1rem, 1.4rem + 2.3vw, 3.3rem);
  font-weight: 850;
  letter-spacing: -0.03em;
  line-height: 1.08;
  color: #fafafa;
  margin-bottom: 14px;
  text-wrap: balance;
}

.features-title em {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: #fde68a;
}

.features-sub {
  font-size: 1.04rem;
  color: var(--text-secondary);
  line-height: 1.68;
  max-width: 64ch;
  text-wrap: pretty;
}

.bento-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}

.bento-card {
  padding: 26px;
  border-radius: 22px;
  background: #101217;
  border: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  gap: 12px;
  text-align: left;
  transition: border-color 200ms ease, transform 200ms ease;
}

.bento-card:hover {
  border-color: rgba(255, 255, 255, 0.18);
  transform: translateY(-2px);
}

.bento-card--wide {
  grid-column: span 2;
}

.bento-card--human {
  background:
    radial-gradient(circle at 100% 0%, rgba(245, 158, 11, 0.08), transparent 60%),
    #101217;
}

.bento-card--agent {
  background:
    radial-gradient(circle at 100% 0%, rgba(42, 196, 159, 0.09), transparent 60%),
    #101217;
}

.bento-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.bento-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  display: grid;
  place-items: center;
  color: #f4f1ea;
}

.bento-primitive {
  font-size: 0.71rem;
  color: #5eead4;
  background: rgba(42, 196, 159, 0.08);
  border: 1px solid rgba(42, 196, 159, 0.22);
  padding: 4px 9px;
  border-radius: 999px;
}

.bento-title {
  font-size: 1.15rem;
  font-weight: 800;
  color: #fafafa;
}

.bento-desc {
  font-size: 0.88rem;
  color: var(--text-secondary);
  line-height: 1.64;
  text-wrap: pretty;
}

.bento-foot {
  margin-top: auto;
  padding-top: 8px;
}

.bento-tag {
  font-family: var(--font-mono);
  font-size: 0.64rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #fbbf24;
}

@media (max-width: 1024px) {
  .bento-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .bento-card--wide {
    grid-column: span 2;
  }
}

@media (max-width: 768px) {
  .features-section {
    padding: 76px 20px 92px;
  }

  .bento-grid {
    grid-template-columns: 1fr;
  }

  .bento-card--wide {
    grid-column: span 1;
  }
}
</style>
