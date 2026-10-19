<template>
  <span class="chat-avatar" :class="{ 'is-agent': agent }" :aria-label="agent ? `${name} · ${provider || 'Agent'}` : name" role="img">
    <img v-if="source && !failed" :key="source" :src="source" alt="" draggable="false" referrerpolicy="no-referrer" @error="failed = true" />
    <span v-else aria-hidden="true">{{ initials }}</span>
  </span>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { avatarInitials } from '../chat-appearance';
import codex from '../../apps/desktop/renderer/src/assets/harness-icons/codex.png';
import claude from '../../apps/desktop/renderer/src/assets/harness-icons/claude-code.png';
import cursor from '../../apps/desktop/renderer/src/assets/harness-icons/cursor.png';
import antigravity from '../../apps/desktop/renderer/src/assets/harness-icons/antigravity.png';
import opencode from '../../apps/desktop/renderer/src/assets/harness-icons/opencode.svg';
const props = defineProps<{ name: string; avatarUrl?: string | null; agent?: boolean; provider?: string | null; agentKey?: string | null }>();
const failed = ref(false);
const initials = computed(() => avatarInitials(props.name));
const source = computed(() => {
  if (!props.agent) {
    try { const url = new URL(props.avatarUrl || ''); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
  }
  let label = (props.provider || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (label === 'supervisorworker') {
    const key = props.agentKey?.split('/').at(-1) || '';
    label = /^desktop-claude(?:-code)?-/.test(key) ? 'claude' : /^desktop-open[-_]model-/.test(key) ? 'opencode'
      : ['codex', 'cursor', 'antigravity'].find((name) => key.startsWith(`desktop-${name}-`)) || '';
  }
  return ({ codex, claude, claudecode: claude, cursor, antigravity, opencode, openmodel: opencode } as Record<string, string>)[label] || null;
});
watch(source, () => { failed.value = false; });
</script>
<style scoped>
.chat-avatar { display: grid; place-items: center; width: 32px; height: 32px; flex: 0 0 32px; align-self: start; overflow: hidden; border-radius: 50%; background: light-dark(#e6e5e3, #292a2c); border: 1px solid light-dark(#0000000f, #ffffff0f); color: var(--text-secondary); font-size: 11px; font-weight: 550; box-sizing: border-box; }
.chat-avatar.is-agent { border-radius: 10px; background: light-dark(#ededed, #242629); }
.chat-avatar img { width: 100%; height: 100%; object-fit: cover; }
.chat-avatar.is-agent img { width: 24px; height: 24px; object-fit: contain; border-radius: 6px; }
</style>
