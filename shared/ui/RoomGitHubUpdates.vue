<template>
  <template v-if="!grouped"><slot :message="messages[0]" :history="false" /></template>
  <section v-else ref="element" class="room-github-updates" :data-scroll-anchor-id="anchorId || messages[0]?.id" aria-label="GitHub updates">
    <header class="github-updates-heading">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 19c-4 1-4-2-6-2m12 5v-4c0-1-.3-2-1-2 4-.5 6-2 6-6 0-2-.5-3-2-4 .3-1 .3-3-.2-4-2 0-3 1-4 2-2-.5-4-.5-6 0-1-1-2-2-4-2-.5 1-.5 3-.2 4C2 7 2 8 2 10c0 4 2 5.5 6 6-.7.5-1 1.5-1 2v4" /></svg>
      <strong>GitHub updates</strong><span v-if="repositories.length === 1">{{ repositories[0] }}</span>
    </header>
    <div class="github-update-rows">
      <div v-for="row in rows" :key="row.key" class="github-update-row" :data-tone="row.event.tone">
        <button type="button" class="github-update-toggle" :aria-expanded="open.has(row.key)" :aria-controls="panelId(row.key)" @click="toggle(row.key)">
          <svg class="github-update-symbol" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="4" cy="3" r="1.5" /><circle cx="4" cy="13" r="1.5" /><circle cx="12" cy="13" r="1.5" /><path d="M4 4.5v7M12 11.5V6a3 3 0 0 0-3-3H8m2-2L8 3l2 2" /></svg>
          <span class="github-update-copy"><strong :title="row.title">{{ row.title }}</strong><span>{{ row.label }}<span v-if="repositories.length > 1"> · {{ row.event.repository }}</span> · {{ row.messages.length }} {{ row.messages.length === 1 ? 'update' : 'updates' }}</span></span>
          <span class="github-update-status">{{ row.event.statusLabel || row.event.kindLabel }}</span>
          <svg class="github-update-caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
        </button>
        <ThreadTransition :instant="instant" @settled="emit('layoutSettled')">
          <div v-show="open.has(row.key)" :id="panelId(row.key)" class="github-update-disclosure" :inert="!open.has(row.key)">
            <div class="github-history-inner">
              <div class="github-history-heading"><span>History</span><a v-if="safeUrl(row.event.url)" :href="safeUrl(row.event.url)!" target="_blank" rel="noopener noreferrer">Open on GitHub ↗</a></div>
              <div :ref="el => setScroller(row.key, el)" class="github-history-scroll" tabindex="0" :aria-label="`${row.label} update history`" @scroll="rememberScroll(row.key)">
                <template v-for="message in row.messages" :key="message.id"><slot :message="message" :history="true" /></template>
              </div>
              <div class="github-history-bottom"><button type="button" :class="{ available: unseen.has(row.key) }" :disabled="!unseen.has(row.key)" @click="latest(row.key)">Latest updates ↓</button></div>
            </div>
          </div>
        </ThreadTransition>
      </div>
    </div>
  </section>
</template>
<script setup lang="ts" generic="M extends { id: string; timestamp: string }">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import ThreadTransition from './ThreadTransition.vue';
import { githubUpdateRows, type GitHubUpdateEvent } from '../grouped-github-updates';
const props = defineProps<{ anchorId?: string; messages: readonly M[]; grouped: boolean; parseEvent: (message: M) => GitHubUpdateEvent | null }>();
defineSlots<{ default(props: { message: M; history: boolean }): unknown }>();
const emit = defineEmits<{ rowsChanged: []; layoutStart: []; layoutSettled: [] }>();
const element = ref<HTMLElement | null>(null);
const instant = ref(false);
const open = ref(new Set<string>());
const unseen = ref(new Set<string>());
const scrollers = new Map<string, HTMLElement>();
const positions = new Map<string, { top: number; bottom: boolean; id?: string; offset?: number }>();
const instanceId = useId();
const rows = computed(() => githubUpdateRows(props.messages, props.parseEvent));
const repositories = computed(() => [...new Set(rows.value.map(row => row.event.repository).filter(Boolean))]);
function panelId(key: string) { return `${instanceId}-${encodeURIComponent(key)}`; }
function safeUrl(value: string | null) { try { const url = new URL(value || ''); return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : null; } catch { return null; } }
function setScroller(key: string, el: unknown) { if (el instanceof HTMLElement) scrollers.set(key, el); else scrollers.delete(key); }
function rememberScroll(key: string) {
  const el = scrollers.get(key); if (!el) return;
  const bottom = el.scrollHeight - el.clientHeight - el.scrollTop < 12;
  const top = el.getBoundingClientRect().top;
  const anchor = [...el.children].find(node => { const row = node as HTMLElement; return (row.dataset.messageId || row.dataset.msgId) && row.getBoundingClientRect().bottom > top; }) as HTMLElement | undefined;
  positions.set(key, { top: el.scrollTop, bottom, id: anchor?.dataset.messageId || anchor?.dataset.msgId, offset: anchor ? anchor.getBoundingClientRect().top - top : undefined });
  if (bottom) unseen.value.delete(key);
}
function latest(key: string) { const el = scrollers.get(key); if (el) { el.scrollTop = el.scrollHeight; rememberScroll(key); } }
async function toggle(key: string) { emit('layoutStart'); const showing = !open.value.has(key); showing ? open.value.add(key) : open.value.delete(key); await nextTick(); if (showing && !positions.has(key)) latest(key); emit('rowsChanged'); }
watch(() => rows.value.map(row => ({ key: row.key, last: row.messages.at(-1)?.id, count: row.messages.length })), async (next, before) => {
  const previous = new Map(positions);
  await nextTick();
  for (const row of rows.value) {
    const el = scrollers.get(row.key); const position = previous.get(row.key);
    if (!el || !open.value.has(row.key) || !position) continue;
    if (position.bottom) latest(row.key);
    else {
      const anchor = position.id ? [...el.children].find(node => (node as HTMLElement).dataset.messageId === position.id || (node as HTMLElement).dataset.msgId === position.id) : undefined;
      el.scrollTop = anchor && position.offset !== undefined ? el.scrollTop + anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - position.offset : position.top;
      if (before?.find(item => item.key === row.key)?.last !== next.find(item => item.key === row.key)?.last) unseen.value.add(row.key);
      rememberScroll(row.key);
    }
  }
  emit('rowsChanged');
});
// The owning timeline sends this before its existing reveal/scroll path. Keep
// original message DOM identities inside the history; hidden rows aren't read.
function reveal(event: Event) {
  const detail = (event as CustomEvent<{ id: string; ready: () => void }>).detail;
  const row = rows.value.find(row => row.messages.some(message => message.id === detail.id));
  if (!row) return;
  event.stopPropagation();
  instant.value = true;
  open.value.add(row.key);
  void nextTick(() => { instant.value = false; emit('rowsChanged'); detail.ready(); });
}
onMounted(() => element.value?.addEventListener('reveal-github-message', reveal));
onBeforeUnmount(() => element.value?.removeEventListener('reveal-github-message', reveal));
</script>
<style scoped>
.room-github-updates { width: min(100%, var(--room-chat-content-max, 720px)); align-self: center; flex: 0 0 auto; box-sizing: border-box; margin: 20px auto; padding: 0 8px 8px; border: 1px solid var(--border, #242427); border-radius: 12px; background: light-dark(#fafafa, #0d0d0e); overflow: hidden; }
.github-updates-heading { display: flex; align-items: center; gap: 9px; min-height: 52px; padding: 0 16px; font-size: 12px; color: var(--text-tertiary); }
.github-updates-heading svg { width: 17px; height: 17px; flex-shrink: 0; }
.github-updates-heading strong { font-weight: 500; color: var(--text-secondary); }
.github-updates-heading > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.github-update-row + .github-update-row { border-top: 1px solid var(--border, #242427); }
.github-update-toggle { display: grid; grid-template-columns: 20px minmax(0, 1fr) 130px 14px; align-items: center; gap: 14px; min-height: 82px; width: 100%; padding: 14px 16px; border: 0; border-radius: 8px; background: transparent; color: var(--text); text-align: left; cursor: pointer; font: inherit; transition: background-color 140ms ease; }
.github-update-toggle:focus-visible { outline: 2px solid var(--text-secondary); outline-offset: -3px; }
.github-update-symbol { width: 18px; height: 18px; color: var(--text-tertiary); }
.github-update-copy { min-width: 0; display: grid; gap: 4px; }
.github-update-copy > strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 520; line-height: 22px; }
.github-update-copy > span { font-size: 11px; line-height: 18px; color: var(--text-tertiary); }
.github-update-status { text-align: right; font-size: 12px; line-height: 20px; color: var(--text-secondary); text-transform: capitalize; }
[data-tone=emerald] .github-update-status { color: light-dark(#217751, #91b5a3); }
[data-tone=rose] .github-update-status { color: light-dark(#ad4444, #d59393); }
[data-tone=sky] .github-update-status { color: light-dark(#346a99, #94b1d0); }
.github-update-caret { width: 12px; height: 12px; color: var(--text-tertiary); transition: transform 180ms cubic-bezier(.22,1,.36,1); }
[aria-expanded=true] > .github-update-caret { transform: rotate(90deg); }
.github-history-inner { padding: 2px 16px 4px 50px; }
.github-history-heading { display: flex; justify-content: space-between; align-items: center; min-height: 32px; gap: 12px; font-size: 11px; color: var(--text-tertiary); }
.github-history-heading a { color: var(--text-secondary); text-decoration: none; }
.github-history-scroll { height: 177px; overflow: auto; overscroll-behavior: contain; overflow-anchor: none; scrollbar-width: thin; outline-offset: -1px; }
.github-history-bottom { display: flex; justify-content: flex-end; height: 29px; align-items: center; }
.github-history-bottom button { visibility: hidden; border: 0; background: none; color: var(--text-secondary); font-size: 11px; cursor: pointer; }
.github-history-bottom button.available { visibility: visible; }
@media (hover: hover) and (pointer: fine) { .github-update-toggle:hover { background: light-dark(#f0f0f0, #18181a); } }
@media (max-width: 520px) { .github-update-toggle { grid-template-columns: 18px minmax(0, 1fr) 12px; gap: 4px 10px; padding: 13px; } .github-update-status { grid-column: 2; grid-row: 2; text-align: left; font-size: 11px; } .github-update-caret { grid-column: 3; grid-row: 1 / 3; } .github-history-inner { padding-left: 18px; padding-right: 10px; } .github-updates-heading > span { display: none; } }
@media (prefers-reduced-motion: reduce) { .github-update-toggle, .github-update-caret { transition: none; } }
</style>
