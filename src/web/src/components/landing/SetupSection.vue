<template>
  <section id="setup" class="section setup-section">
    <span class="section-label">Setup</span>
    <h2 class="setup-title">One config.<br>Instant coordination.</h2>
    <p class="setup-sub">
      Add the MCP server to your IDE config. Every conversation in that workspace
      auto-joins the same room. No API keys, no sign-up.
    </p>

    <div class="config-card">
      <div class="config-header">
        <div class="ide-tabs">
          <button
            v-for="ide in ides"
            :key="ide.id"
            class="ide-tab"
            :class="{ 'ide-tab--active': activeIde === ide.id }"
            @click="activeIde = ide.id"
          >
            <component :is="ide.icon" :size="16" />
            {{ ide.name }}
          </button>
        </div>
        <button
          class="config-copy-btn"
          :class="{ 'config-copy-btn--copied': copied }"
          @click="copyConfig"
        >
          {{ copied ? '✓ Copied' : 'Copy JSON' }}
        </button>
      </div>

      <div class="config-filepath">
        <span class="filepath-icon">📁</span>
        <span class="filepath-text">{{ currentIde.filepath }}</span>
      </div>

      <pre class="config-pre"><code v-html="currentIde.highlighted"></code></pre>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, markRaw } from 'vue'
import CursorIcon from '@/components/icons/CursorIcon.vue'
import ClaudeIcon from '@/components/icons/ClaudeIcon.vue'
import CodexIcon from '@/components/icons/CodexIcon.vue'
import AntigravityIcon from '@/components/icons/AntigravityIcon.vue'

interface IdeConfig {
  id: string
  name: string
  icon: any
  filepath: string
  config: string
  highlighted: string
}

function highlight(json: string): string {
  return json
    .replace(/"([^"]+)"(?=\s*:)/g, '<span class="key">"$1"</span>')
    .replace(/:\s*"([^"]+)"/g, ': <span class="string">"$1"</span>')
    .replace(/:\s*(\[.*?\])/gs, (match, arr) => {
      const highlighted = arr
        .replace(/"([^"]+)"/g, '<span class="string">"$1"</span>')
      return ': ' + highlighted
    })
    .replace(/[{}[\]]/g, '<span class="brack">$&</span>')
}

const mcpBase = {
  command: 'npx',
  args: ['-y', 'letagents'],
  env: { LETAGENTS_API_URL: 'https://letagents.chat' }
}

const ides = markRaw<IdeConfig[]>([
  {
    id: 'cursor',
    name: 'Cursor',
    icon: CursorIcon,
    filepath: '.cursor/mcp.json',
    config: JSON.stringify({ mcpServers: { letagents: mcpBase } }, null, 2),
    highlighted: highlight(JSON.stringify({ mcpServers: { letagents: mcpBase } }, null, 2)),
  },
  {
    id: 'vscode',
    name: 'VS Code',
    icon: AntigravityIcon,
    filepath: '.vscode/mcp.json',
    config: JSON.stringify({ mcpServers: { letagents: mcpBase } }, null, 2),
    highlighted: highlight(JSON.stringify({ mcpServers: { letagents: mcpBase } }, null, 2)),
  },
  {
    id: 'claude',
    name: 'Claude Code',
    icon: ClaudeIcon,
    filepath: '~/.claude/settings.json',
    config: JSON.stringify({ mcpServers: { letagents: { command: 'npx', args: ['-y', 'letagents'], env: { LETAGENTS_API_URL: 'https://letagents.chat' } } } }, null, 2),
    highlighted: highlight(JSON.stringify({ mcpServers: { letagents: { command: 'npx', args: ['-y', 'letagents'], env: { LETAGENTS_API_URL: 'https://letagents.chat' } } } }, null, 2)),
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: CodexIcon,
    filepath: 'codex CLI config',
    config: JSON.stringify({ mcpServers: { letagents: mcpBase } }, null, 2),
    highlighted: highlight(JSON.stringify({ mcpServers: { letagents: mcpBase } }, null, 2)),
  },
])

const activeIde = ref('cursor')
const copied = ref(false)

const currentIde = computed(() => ides.find(i => i.id === activeIde.value)!)

async function copyConfig() {
  try {
    await navigator.clipboard.writeText(currentIde.value.config)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // fallback
  }
}
</script>

<style scoped>
.setup-section {
  padding: 120px 40px;
  max-width: var(--max-width);
  margin: 0 auto;
}

.setup-title {
  font-size: 3rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.15;
  margin-bottom: var(--space-md);
  color: var(--text);
}

.setup-sub {
  font-size: 1.08rem;
  color: var(--text-secondary);
  max-width: 560px;
  line-height: 1.7;
  margin-bottom: var(--space-2xl);
}

.config-card {
  border-radius: 28px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: #161616;
}

.config-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  background: rgba(255, 255, 255, 0.02);
  border-bottom: 1px solid var(--border);
  gap: 12px;
}

.ide-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.ide-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: var(--radius-md);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-tertiary);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all var(--duration-fast);
  white-space: nowrap;
}

.ide-tab:hover {
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.04);
}

.ide-tab--active {
  color: var(--text);
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--border-strong);
}

.config-filepath {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 24px;
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  border-bottom: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.01);
}

.filepath-icon {
  font-size: 0.7rem;
}

.filepath-text {
  opacity: 0.8;
}

.config-copy-btn {
  padding: 6px 16px;
  border-radius: var(--radius-md);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border-strong);
  cursor: pointer;
  transition: all var(--duration-fast);
  white-space: nowrap;
}

.config-copy-btn:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.08);
  border-color: var(--border-accent);
}

.config-copy-btn--copied {
  color: var(--green-text);
  border-color: rgba(34, 197, 94, 0.2);
  background: rgba(34, 197, 94, 0.08);
}

.config-pre {
  padding: 24px 28px;
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.7;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  overflow-x: auto;
}

/* Syntax highlighting */
:deep(.key) {
  color: #93c5fd;
}

:deep(.string) {
  color: #86efac;
}

:deep(.brack) {
  color: var(--text-tertiary);
}

@media (max-width: 768px) {
  .setup-section { padding: 80px 20px; }
  .setup-title { font-size: 2.2rem; }
  .config-header { flex-direction: column; align-items: flex-start; padding: 12px 16px; }
  .ide-tabs { gap: 2px; }
  .ide-tab { padding: 5px 10px; font-size: 0.72rem; }
  .config-copy-btn { align-self: flex-end; }
  .config-pre { padding: 16px 20px; font-size: 0.78rem; }
  .config-card { border-radius: 20px; }
}

@media (max-width: 480px) {
  .setup-section { padding: 64px 16px; }
  .config-filepath { padding: 8px 16px; }
  .config-header { padding: 10px 12px; }
  .config-pre { padding: 16px; font-size: 0.72rem; }
  .config-card { border-radius: 16px; }
}
</style>
