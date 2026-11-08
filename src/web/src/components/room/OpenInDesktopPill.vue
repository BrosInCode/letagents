<template>
  <Transition name="open-in-desktop" appear>
    <section
      class="open-in-desktop"
      :data-state="state"
      role="status"
      aria-live="polite"
      data-testid="open-in-desktop"
    >
      <span class="open-in-desktop-tile" aria-hidden="true">
        <svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12" rx="2.5" /><path d="M9 20h6M12 16.5V20" /></svg>
      </span>
      <p class="open-in-desktop-copy">
        <template v-if="state === 'opening'">
          <b>Opening in LetAgents Desktop…</b>
          <span class="open-in-desktop-meta">
            Nothing happened?
            <button type="button" class="open-in-desktop-link" data-testid="open-in-desktop-again" @click="emit('open')">Open again</button>
            ·
            <a class="open-in-desktop-link" :href="downloadHref" data-testid="open-in-desktop-download">Download the app</a>
          </span>
        </template>
        <template v-else>
          <b>Open this room in LetAgents Desktop</b>
          <span class="open-in-desktop-meta">Faster, with notifications and your agents.</span>
        </template>
      </p>
      <span class="open-in-desktop-actions">
        <template v-if="state === 'opening'">
          <button v-if="always" type="button" class="open-in-desktop-button" data-testid="open-in-desktop-stop" @click="emit('stop-always')">Stop opening automatically</button>
          <button type="button" class="open-in-desktop-button" data-variant="primary" data-testid="open-in-desktop-stay" @click="emit('dismiss')">Stay here</button>
        </template>
        <template v-else>
          <button type="button" class="open-in-desktop-button" data-testid="open-in-desktop-always" @click="emit('always')">Always</button>
          <button type="button" class="open-in-desktop-button" data-variant="primary" data-testid="open-in-desktop-open" @click="emit('open')">Open</button>
          <button type="button" class="open-in-desktop-close" aria-label="Not now" title="Not now" data-testid="open-in-desktop-close" @click="emit('dismiss')">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </template>
      </span>
    </section>
  </Transition>
</template>

<script setup lang="ts">
import type { OpenInDesktopState } from '../../composables/openInDesktop'

/**
 * The room's offer to continue in the desktop app, in the same shape as the
 * other asks above the composer. The composable decides when it shows.
 */
defineProps<{
  state: OpenInDesktopState
  always: boolean
  downloadHref: string
}>()

const emit = defineEmits<{
  open: []
  always: []
  dismiss: []
  'stop-always': []
}>()
</script>

<style scoped>
.open-in-desktop {
  display: flex;
  align-items: center;
  gap: 12px;
  box-sizing: border-box;
  margin-top: 8px;
  padding: 14px 12px 14px 16px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 14px;
  background: var(--bg-subtle, var(--bg));
  color: var(--text);
  font-size: 14px;
}
.open-in-desktop-tile {
  display: grid;
  place-items: center;
  flex: 0 0 36px;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text-secondary);
}
.open-in-desktop-tile svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.open-in-desktop[data-state="opening"] .open-in-desktop-tile { color: var(--green-text, var(--text)); }
.open-in-desktop-copy { display: flex; flex: 1 1 auto; flex-direction: column; gap: 3px; min-width: 0; margin: 0; line-height: 1.45; color: var(--text-secondary); }
.open-in-desktop-copy b { color: var(--text); font-weight: 600; letter-spacing: -0.01em; }
.open-in-desktop-meta { font-size: 12px; color: var(--text-secondary); }
.open-in-desktop-link { padding: 0; border: 0; background: transparent; color: var(--text-secondary); font: inherit; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.open-in-desktop-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }
.open-in-desktop-button {
  min-height: 34px;
  padding: 6px 12px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
  transition: transform 140ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1)), background-color 150ms ease, color 150ms ease;
}
.open-in-desktop-button[data-variant="primary"] { background: var(--text); color: var(--bg); border-color: transparent; }
.open-in-desktop-button:active { transform: scale(0.97); }
.open-in-desktop-close {
  display: grid; place-items: center;
  width: 30px; height: 34px; margin-left: 2px; padding: 0;
  border: 0; border-radius: 7px; background: transparent;
  color: var(--text-secondary); cursor: pointer;
  transition: background-color 150ms ease, color 150ms ease;
}
.open-in-desktop-close svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
@media (hover: hover) and (pointer: fine) {
  .open-in-desktop-button:hover { background: var(--accent-hover, color-mix(in srgb, var(--text) 8%, transparent)); }
  .open-in-desktop-button[data-variant="primary"]:hover { background: color-mix(in srgb, var(--text) 90%, var(--bg)); }
  .open-in-desktop-close:hover { background: var(--accent-hover, color-mix(in srgb, var(--text) 8%, transparent)); color: var(--text); }
  .open-in-desktop-link:hover { color: var(--text); }
}
.open-in-desktop-button:focus-visible, .open-in-desktop-close:focus-visible, .open-in-desktop-link:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
@media (pointer: coarse) {
  .open-in-desktop-button { min-height: 42px; }
  .open-in-desktop-close { width: 42px; height: 42px; }
}
@media (max-width: 540px) {
  .open-in-desktop { flex-wrap: wrap; padding: 14px; gap: 10px; }
  .open-in-desktop-copy { flex-basis: calc(100% - 100px); }
  .open-in-desktop-actions { flex-basis: 100%; justify-content: flex-end; }
}
/* It arrives with the page: one short rise, and only a fade when motion is reduced. */
.open-in-desktop-enter-active { transition: opacity 180ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1)), transform 180ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1)); }
.open-in-desktop-leave-active { transition: opacity 120ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1)), transform 120ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1)); }
.open-in-desktop-enter-from, .open-in-desktop-leave-to { opacity: 0; transform: translateY(6px); }
@media (prefers-reduced-motion: reduce) {
  .open-in-desktop-enter-active, .open-in-desktop-leave-active { transition: opacity 150ms ease; }
  .open-in-desktop-enter-from, .open-in-desktop-leave-to { transform: none; }
  .open-in-desktop-button:active { transform: none; }
}
</style>
