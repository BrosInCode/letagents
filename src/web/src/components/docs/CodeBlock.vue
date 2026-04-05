<template>
  <div class="code-block">
    <div class="code-block-header">
      <span>{{ label }}</span>
      <button class="copy-btn" @click="copy">{{ copied ? 'Copied!' : 'Copy' }}</button>
    </div>
    <pre><code ref="codeEl"><slot /></code></pre>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ label: string }>()

const codeEl = ref<HTMLElement | null>(null)
const copied = ref(false)

async function copy() {
  if (!codeEl.value) return
  try {
    await navigator.clipboard.writeText(codeEl.value.textContent || '')
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch { /* silent */ }
}
</script>

<style scoped>
.code-block {
  position: relative;
  background: #111;
  border: 1px solid var(--border, rgba(255,255,255,0.08));
  border-radius: 10px;
  margin-bottom: 20px;
  overflow: hidden;
}

.code-block-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  background: #1a1a1a;
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.08));
  font-size: 0.72rem;
  color: var(--text-tertiary, #8b8b96);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.copy-btn {
  background: none;
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 6px;
  color: var(--text-secondary, #a1a1aa);
  font-size: 0.7rem;
  font-weight: 600;
  padding: 3px 10px;
  cursor: pointer;
  transition: all 150ms;
  font-family: inherit;
}
.copy-btn:hover { background: rgba(228,228,231,0.1); color: var(--text, #fafafa); }

.code-block pre {
  padding: 16px;
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
  font-size: 0.82rem;
  line-height: 1.65;
  overflow-x: auto;
  color: var(--text-secondary, #a1a1aa);
  margin: 0;
}
</style>
