<template>
  <div class="claude-limit-notice" data-testid="claude-limit-notice">
    <CircleAlert class="claude-limit-icon" :size="16" aria-hidden="true" />
    <div class="claude-limit-copy">
      <strong>{{ notice.title }}</strong>
      <p><template v-if="agentName">{{ agentName }} · </template>{{ notice.detail }}</p>
      <p v-if="notice.reset" class="claude-limit-reset">Resets {{ notice.reset }}</p>
      <div class="claude-limit-actions">
        <button v-if="canSwitch" type="button" class="claude-limit-switch" @click="emit('switch-model')">Change model <ArrowRight :size="13" aria-hidden="true" /></button>
        <a :href="CLAUDE_USAGE_URL" @click="openUsage">Manage Claude usage <ArrowUpRight :size="13" aria-hidden="true" /></a>
        <slot />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ArrowRight, ArrowUpRight, CircleAlert } from "@lucide/vue";
import { CLAUDE_USAGE_URL, type ClaudeLimitNotice } from "../../../../domain/claude-usage-limit";
import { desktopIpc } from "../../../../ipc";
import { useDesktopActionToasts } from "../../../../composables/useDesktopActionToasts";

defineProps<{ notice: ClaudeLimitNotice; agentName?: string; canSwitch?: boolean }>();
const emit = defineEmits<{ "switch-model": [] }>();
const { pushActionToast } = useDesktopActionToasts();
function openUsage(event: MouseEvent) {
  const open = desktopIpc.app?.openExternalUrl;
  if (!open) return;
  event.preventDefault();
  void open(CLAUDE_USAGE_URL).catch(() => pushActionToast("Couldn’t open Claude usage.", "error"));
}
</script>

<style scoped>
.claude-limit-notice {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  min-width: 0;
  border: 1px solid color-mix(in srgb, var(--amber-text) 28%, var(--border));
  border-radius: 11px;
  background: color-mix(in srgb, var(--amber-text) 5%, var(--bg-elevated));
  padding: 12px;
  text-align: left;
}
.claude-limit-icon { color: var(--amber-text); margin-top: 2px; }
.claude-limit-copy > strong { color: var(--text); font-size: .83rem; font-weight: 650; }
.claude-limit-copy > p { margin: 4px 0 0; color: var(--text-secondary); font-size: .75rem; line-height: 1.45; overflow-wrap: anywhere; }
.claude-limit-copy > .claude-limit-reset { color: var(--amber-text); }
.claude-limit-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 10px; margin-top: 9px; }
.claude-limit-actions :is(button, a),
.claude-limit-actions :slotted(button) {
  display: inline-flex; align-items: center; gap: 5px; min-height: 30px; padding: 0 5px;
  border: 0; border-radius: 5px; background: transparent; color: var(--text-secondary);
  font: inherit; font-size: .73rem; font-weight: 550; text-decoration: none; cursor: pointer;
}
.claude-limit-actions .claude-limit-switch {
  padding: 0 8px; background: var(--accent-hover); color: var(--text);
}
.claude-limit-actions :is(button, a):focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
@media (hover: hover) and (pointer: fine) {
  .claude-limit-actions :is(button, a):hover { background: var(--accent-hover); color: var(--text); }
}
</style>
