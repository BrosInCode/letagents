<template>
  <template v-if="!grouped"><slot :message="messages[0]" :history="false" /></template>
  <section v-else ref="element" class="room-github-updates" :data-scroll-anchor-id="anchorId || messages[0]?.id" aria-label="GitHub updates">
    <DisclosurePanel :open="!collapsed" :panel-id="panelId('group')" trigger-class="github-updates-heading" :instant="instant" @toggle="toggleGroup" @settled="emit('layoutSettled')">
    <template #summary><span class="github-updates-heading-copy">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 19c-4 1-4-2-6-2m12 5v-4c0-1-.3-2-1-2 4-.5 6-2 6-6 0-2-.5-3-2-4 .3-1 .3-3-.2-4-2 0-3 1-4 2-2-.5-4-.5-6 0-1-1-2-2-4-2-.5 1-.5 3-.2 4C2 7 2 8 2 10c0 4 2 5.5 6 6-.7.5-1 1.5-1 2v4" /></svg>
      <strong>GitHub updates</strong><span v-if="repositories.length === 1">{{ repositories[0] }}</span>
    </span></template>
    <div class="github-update-rows">
      <div class="github-update-list">
      <button v-if="hiddenRowCount" type="button" class="github-update-earlier" data-testid="github-update-earlier" @click="showEarlier">Show {{ hiddenRowCount }} earlier</button>
      <DisclosurePanel v-for="row in shownRows" :key="row.key" class="github-update-row" :data-tone="row.event.tone"
        :open="open.has(row.key)" :panel-id="panelId(row.key)" trigger-class="github-update-toggle" panel-class="github-update-disclosure"
        :instant="instant" @toggle="toggle(row.key, $event)" @settled="emit('layoutSettled')">
        <template #summary><span class="github-update-summary">
          <svg class="github-update-symbol" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="4" cy="3" r="1.5" /><circle cx="4" cy="13" r="1.5" /><circle cx="12" cy="13" r="1.5" /><path d="M4 4.5v7M12 11.5V6a3 3 0 0 0-3-3H8m2-2L8 3l2 2" /></svg>
          <span class="github-update-copy"><strong :title="row.title">{{ row.title }}</strong><span>{{ row.label }}<span v-if="repositories.length > 1"> · {{ row.event.repository }}</span> · {{ row.messages.length }} {{ row.messages.length === 1 ? 'update' : 'updates' }}</span></span>
          <span class="github-update-status">{{ row.event.statusLabel || row.event.kindLabel }}</span>
        </span></template>
            <div class="github-history-inner">
              <div class="github-history-heading"><span>History</span><a v-if="safeUrl(row.event.url)" :href="safeUrl(row.event.url)!" target="_blank" rel="noopener noreferrer">Open on GitHub ↗</a></div>
              <div :ref="(el: unknown) => setScroller(row.key, el)" class="github-history-scroll" tabindex="0" :aria-label="`${row.label} update history`" @scroll="rememberScroll(row.key)">
                <template v-if="!lazyHistory || rendered.has(row.key)"><template v-for="message in row.messages" :key="message.id"><slot :message="message" :history="true" /></template></template>
              </div>
              <div class="github-history-bottom"><button type="button" :class="{ available: unseen.has(row.key) }" :disabled="!unseen.has(row.key)" @click="latest(row.key)">Latest updates ↓</button></div>
            </div>
      </DisclosurePanel>
      </div>
    </div>
    </DisclosurePanel>
  </section>
</template>
<script setup lang="ts" generic="M extends { id: string; timestamp: string }">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import DisclosurePanel from './DisclosurePanel.vue';
import { githubUpdateRows, type GitHubUpdateEvent } from '../grouped-github-updates';
const props = defineProps<{
  anchorId?: string; messages: readonly M[]; grouped: boolean; parseEvent: (message: M) => GitHubUpdateEvent | null;
  /** Mount a row's history only once it has been opened. */
  lazyHistory?: boolean;
  /** Show only the newest rows, with a button for earlier ones. */
  rowLimit?: number;
}>();
defineSlots<{ default(props: { message: M; history: boolean }): unknown }>();
const emit = defineEmits<{ rowsChanged: []; layoutStart: []; layoutSettled: [] }>();
const element = ref<HTMLElement | null>(null);
const instant = ref(false);
const collapsed = ref(false);
const open = ref(new Set<string>());
const unseen = ref(new Set<string>());
const scrollers = new Map<string, HTMLElement>();
const positions = new Map<string, { top: number; bottom: boolean; id?: string; offset?: number }>();
const instanceId = useId();
const rows = computed(() => githubUpdateRows(props.messages, props.parseEvent));
// Bounded mode (desktop): a long run of events mounts at most rowLimit rows,
// and no closed history. A row stays mounted once it has been opened.
const shownCount = ref(props.rowLimit ?? Number.POSITIVE_INFINITY);
const shownRows = computed(() => props.rowLimit ? rows.value.slice(Math.max(0, rows.value.length - shownCount.value)) : rows.value);
const hiddenRowCount = computed(() => rows.value.length - shownRows.value.length);
const rendered = ref(new Set<string>());
async function showEarlier() {
  emit('layoutStart');
  shownCount.value += props.rowLimit ?? rows.value.length;
  await nextTick();
  emit('rowsChanged');
}
const repositories = computed(() => [...new Set(rows.value.map(row => row.event.repository).filter(Boolean))]);
function panelId(key: string) { return `${instanceId}-${encodeURIComponent(key)}`; }
function safeUrl(value: string | null) { try { const url = new URL(value || ''); return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : null; } catch { return null; } }
function setScroller(key: string, el: unknown) { if (el instanceof HTMLElement) scrollers.set(key, el); else scrollers.delete(key); }
function rememberScroll(key: string) {
  const el = scrollers.get(key); if (!el || collapsed.value || !open.value.has(key) || el.clientHeight <= 0) return;
  const bottom = el.scrollHeight - el.clientHeight - el.scrollTop < 12;
  const top = el.getBoundingClientRect().top;
  const anchor = [...el.children].find(node => { const row = node as HTMLElement; return (row.dataset.messageId || row.dataset.msgId) && row.getBoundingClientRect().bottom > top; }) as HTMLElement | undefined;
  positions.set(key, { top: el.scrollTop, bottom, id: anchor?.dataset.messageId || anchor?.dataset.msgId, offset: anchor ? anchor.getBoundingClientRect().top - top : undefined });
  if (bottom) unseen.value.delete(key);
}
function latest(key: string) { const el = scrollers.get(key); if (el && !collapsed.value && open.value.has(key)) { el.scrollTop = el.scrollHeight; rememberScroll(key); } }
function restoreHistory(key: string) {
  const el = scrollers.get(key), position = positions.get(key);
  if (!el || collapsed.value || !open.value.has(key)) return;
  if (!position || position.bottom) { latest(key); return; }
  const anchor = position.id ? [...el.children].find(node => (node as HTMLElement).dataset.messageId === position.id || (node as HTMLElement).dataset.msgId === position.id) : undefined;
  el.scrollTop = anchor && position.offset !== undefined ? el.scrollTop + anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - position.offset : position.top;
  rememberScroll(key);
}
async function toggleGroup(event: MouseEvent) {
  emit('layoutStart');
  instant.value = event.detail === 0;
  collapsed.value = !collapsed.value;
  await nextTick();
  if (!collapsed.value) for (const key of open.value) restoreHistory(key);
  emit('rowsChanged');
}
async function toggle(key: string, event: MouseEvent) { instant.value = event.detail === 0; emit('layoutStart'); const showing = !open.value.has(key); if (showing) { open.value.add(key); rendered.value.add(key); } else open.value.delete(key); await nextTick(); if (showing) restoreHistory(key); emit('rowsChanged'); }
watch(() => rows.value.map(row => ({ key: row.key, last: row.messages.at(-1)?.id, count: row.messages.length })), async (next, before) => {
  for (const row of next) {
    const position = positions.get(row.key);
    if (position && !position.bottom && before?.find(item => item.key === row.key)?.last !== row.last) unseen.value.add(row.key);
  }
  await nextTick();
  // Hidden elements report zero geometry. Keep their bookmark until reopened.
  if (!collapsed.value) for (const key of open.value) restoreHistory(key);
  emit('rowsChanged');
});
// The owning timeline sends this before its existing reveal/scroll path. Keep
// original message DOM identities inside the history; hidden rows aren't read.
function reveal(event: Event) {
  const detail = (event as CustomEvent<{ id: string; ready: () => void }>).detail;
  const index = rows.value.findIndex(row => row.messages.some(message => message.id === detail.id));
  const row = rows.value[index];
  if (!row) return;
  event.stopPropagation();
  instant.value = true;
  collapsed.value = false;
  if (props.rowLimit) shownCount.value = Math.max(shownCount.value, rows.value.length - index);
  open.value.add(row.key);
  rendered.value.add(row.key);
  void nextTick(() => { instant.value = false; emit('rowsChanged'); detail.ready(); });
}
onMounted(() => element.value?.addEventListener('reveal-github-message', reveal));
onBeforeUnmount(() => element.value?.removeEventListener('reveal-github-message', reveal));
</script>
<style>
.room-github-updates { width: min(100%, var(--room-chat-content-max, 720px)); align-self: center; flex: 0 0 auto; box-sizing: border-box; margin: 20px auto; padding: 8px; border: 1px solid var(--border, #242427); border-radius: 12px; background: light-dark(#fafafa, #0d0d0e); overflow: hidden; }
.room-github-updates .github-updates-heading { min-height: 44px; font-size: 12px; color: var(--text-tertiary); }
.github-updates-heading-copy { display: flex; align-items: center; gap: 9px; min-width: 0; }
.github-updates-heading-copy svg { width: 17px; height: 17px; flex-shrink: 0; }
.github-updates-heading-copy strong { font-weight: 500; color: var(--text-secondary); }
.github-updates-heading-copy > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.github-update-row + .github-update-row { border-top: 1px solid var(--border, #242427); }
.github-update-earlier { display: block; width: 100%; min-height: 36px; border: 0; border-radius: 8px; background: none; color: var(--text-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.github-update-earlier:focus-visible { outline: 2px solid var(--text-secondary, #97979f); outline-offset: -3px; }
.room-github-updates .github-update-toggle { min-height: 82px; color: var(--text); }
.github-update-summary { display: grid; grid-template-columns: 20px minmax(0, 1fr) 130px; align-items: center; gap: 14px; }
.github-update-symbol { width: 18px; height: 18px; color: var(--text-tertiary); }
.github-update-copy { min-width: 0; display: grid; gap: 4px; }
.github-update-copy > strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 520; line-height: 22px; }
.github-update-copy > span { font-size: 11px; line-height: 18px; color: var(--text-tertiary); }
.github-update-status { text-align: right; font-size: 12px; line-height: 20px; color: var(--text-secondary); text-transform: capitalize; }
[data-tone=emerald] .github-update-status { color: light-dark(#217751, #91b5a3); }
[data-tone=rose] .github-update-status { color: light-dark(#ad4444, #d59393); }
[data-tone=sky] .github-update-status { color: light-dark(#346a99, #94b1d0); }
.github-history-inner { padding: 2px 16px 4px 50px; }
.github-history-heading { display: flex; justify-content: space-between; align-items: center; min-height: 32px; gap: 12px; font-size: 11px; color: var(--text-tertiary); }
.github-history-heading a { color: var(--text-secondary); text-decoration: none; }
.github-history-scroll { height: 177px; overflow: auto; overscroll-behavior: contain; overflow-anchor: none; scrollbar-width: thin; outline-offset: -1px; }
.github-history-bottom { display: flex; justify-content: flex-end; height: 29px; align-items: center; }
.github-history-bottom button { visibility: hidden; border: 0; background: none; color: var(--text-secondary); font-size: 11px; cursor: pointer; }
.github-history-bottom button.available { visibility: visible; }
@media (max-width: 520px) {
  .room-github-updates .github-update-toggle { --disclosure-padding: 13px; gap: 10px; }
  .github-update-summary { grid-template-columns: 18px minmax(0, 1fr); gap: 4px 10px; }
  .github-update-status { grid-column: 2; grid-row: 2; text-align: left; font-size: 11px; }
  .github-history-inner { padding-left: 18px; padding-right: 10px; }
  .github-updates-heading-copy > span { display: none; }
}
</style>
