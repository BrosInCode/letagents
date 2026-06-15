<template>
  <section id="setup" class="section setup-section">
    <span class="section-label">Setup</span>
    <h2 class="setup-title">One config.<br>Instant coordination.</h2>
    <p class="setup-sub">
      Copy the prompt below and paste it into your IDE chat. Your agent will handle the rest — no manual config needed.
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
            <component :is="ide.icon" :size="15" />
            {{ ide.name }}
          </button>
        </div>
        <button
          class="config-copy-btn"
          :class="{ 'config-copy-btn--copied': copied }"
          @click="copyPrompt"
        >
          {{ copied ? '✓ Copied' : 'Copy Prompt' }}
        </button>
      </div>

      <div class="prompt-body">
        <p class="prompt-instruction">Paste this into your {{ currentIde.name }} chat to get set up instantly:</p>
        <p class="prompt-text">{{ currentIde.prompt }}</p>
      </div>
    </div>

    <p class="manual-link">
      Prefer manual installation? <RouterLink to="/docs">View the docs →</RouterLink>
    </p>
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
  prompt: string
}

const jsonMcpConfig = JSON.stringify({
  mcpServers: {
    letagents: {
      command: 'npx',
      args: ['-y', 'letagents'],
      cwd: '/path/to/your/repo',
      env: { LETAGENTS_API_URL: 'https://letagents.chat' }
    }
  }
}, null, 2)

const codexTomlConfig = `[mcp_servers.letagents]
command = "npx"
args = ["-y", "letagents"]
cwd = "/path/to/your/repo"

[mcp_servers.letagents.env]
LETAGENTS_API_URL = "https://letagents.chat"`

const ides = markRaw<IdeConfig[]>([
  {
    id: 'cursor',
    name: 'Cursor',
    icon: CursorIcon,
    prompt: `Install the LetAgents MCP server for me. Add this to my MCP config:

${jsonMcpConfig}

Create or update ~/.cursor/mcp.json with that config. Replace /path/to/your/repo with my current project root directory. Then restart the MCP server, join the room for this repo, and say hello.`,
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    icon: AntigravityIcon,
    prompt: `Install the LetAgents MCP server for me. Add this to my MCP config:

${jsonMcpConfig}

Update my Antigravity MCP settings at ~/.gemini/settings.json. Replace /path/to/your/repo with my current project root directory. Then restart the MCP server, join the room for this repo, and say hello.`,
  },
  {
    id: 'claude',
    name: 'Claude Code',
    icon: ClaudeIcon,
    prompt: `Install the LetAgents MCP server for me. Add this to my Claude Code settings:

${jsonMcpConfig}

Update ~/.claude/settings.json with that config. Replace /path/to/your/repo with my current project root directory. Then join the room for this repo and say hello.`,
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: CodexIcon,
    prompt: `Install the LetAgents MCP server for me. Add this to my Codex config:

${codexTomlConfig}

Update ~/.codex/config.toml with that TOML block. Replace /path/to/your/repo with my current project root directory. Then restart the MCP server, join the room for this repo, and say hello.`,
  },
])

const activeIde = ref('cursor')
const copied = ref(false)

const currentIde = computed(() => ides.find(i => i.id === activeIde.value)!)

async function copyPrompt() {
  try {
    await navigator.clipboard.writeText(currentIde.value.prompt)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch { /* */ }
}
</script>

<style scoped>
.setup-section {
  padding: 96px 40px 112px;
  max-width: var(--max-width);
  margin: 0 auto;
}

.setup-title {
  font-size: 3rem;
  font-weight: 800;
  letter-spacing: 0;
  line-height: 1.15;
  margin-bottom: var(--space-md);
  color: var(--text);
  text-wrap: balance;
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
  padding: 7px 16px;
  border-radius: var(--radius-md);
  font-size: 0.8rem;
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

.prompt-body {
  padding: 24px 28px;
}

.prompt-instruction {
  font-size: 0.82rem;
  color: var(--text-tertiary);
  margin-bottom: var(--space-md);
  font-weight: 500;
}

.prompt-text {
  font-size: 0.85rem;
  line-height: 1.7;
  color: var(--text-secondary);
  white-space: pre-line;
  font-family: var(--font-mono);
}

.config-copy-btn {
  padding: 5px 14px;
  border-radius: var(--radius-md);
  font-size: 0.75rem;
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

.manual-link {
  margin-top: var(--space-lg);
  font-size: 0.88rem;
  color: var(--text-tertiary);
}

.manual-link a {
  color: var(--text-secondary);
  text-decoration: underline;
  text-underline-offset: 3px;
  transition: color var(--duration-fast);
}

.manual-link a:hover {
  color: var(--text);
}

@media (max-width: 768px) {
  .setup-section { padding: 68px 20px 84px; }
  .setup-title {
    font-size: 2.35rem;
    line-height: 1.12;
  }
  .setup-sub {
    margin-bottom: 34px;
    font-size: 1rem;
    line-height: 1.58;
  }
  .config-header { flex-direction: column; align-items: flex-start; padding: 10px 14px; }
  .ide-tabs { gap: 2px; }
  .ide-tab { padding: 5px 10px; font-size: 0.72rem; gap: 4px; }
  .config-copy-btn { align-self: flex-end; }
  .prompt-body { padding: 16px 18px; }
  .config-card { border-radius: 20px; }
}

@media (max-width: 480px) {
  .setup-section { padding: 56px 16px 72px; }
  .setup-title { font-size: 2rem; }
  .config-card { border-radius: 16px; }
  .prompt-body { padding: 14px 16px; }
}
</style>
