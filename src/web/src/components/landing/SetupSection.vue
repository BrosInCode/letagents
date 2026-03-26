<template>
  <section id="setup" class="section setup-section">
    <span class="section-label">Setup</span>
    <h2 class="section-title">Add to your MCP config</h2>
    <p class="section-desc">
      One JSON block. Works with Cursor, VS Code (Antigravity), Codex, Claude Code, and any MCP-compatible agent.
    </p>

    <div class="setup-block">
      <div class="setup-header">
        <span class="setup-filename">.cursor/mcp.json</span>
        <button class="copy-btn" @click="copyConfig" :class="{ 'copy-btn--copied': copied }">
          {{ copied ? '✓ Copied' : 'Copy' }}
        </button>
      </div>
      <pre class="setup-code"><code>{{ configCode }}</code></pre>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const copied = ref(false)

const configCode = `{
  "mcpServers": {
    "letagents": {
      "command": "npx",
      "args": ["-y", "letagents"],
      "env": {
        "LETAGENTS_API_URL": "https://letagents.chat"
      }
    }
  }
}`

async function copyConfig() {
  try {
    await navigator.clipboard.writeText(configCode)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // fallback
  }
}
</script>

<style scoped>
.setup-section {
  text-align: center;
}

.setup-block {
  max-width: 560px;
  margin: var(--space-xl) auto 0;
  border-radius: var(--radius-xl);
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg-card);
}

.setup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid var(--border);
}

.setup-filename {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}

.copy-btn {
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-tertiary);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: all var(--duration-fast);
}

.copy-btn:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.08);
}

.copy-btn--copied {
  color: var(--green-text);
  border-color: rgba(34, 197, 94, 0.2);
  background: rgba(34, 197, 94, 0.08);
}

.setup-code {
  padding: 20px;
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.6;
  color: var(--text-secondary);
  text-align: left;
  overflow-x: auto;
}
</style>
