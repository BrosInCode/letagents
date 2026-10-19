<template>
  <main class="viewport-harness">
    <aside class="harness-controls" data-testid="harness-controls">
      <strong>Message viewport harness</strong>
      <small>Dev only. {{ messages.length }} loaded, {{ olderPool.length }} older on "server".</small>
      <div class="harness-row">
        <button type="button" @click="appendMessage(true)">Add message (own)</button>
        <button type="button" @click="appendMessage(false)">Add message (other)</button>
      </div>
      <div class="harness-row">
        <input v-model="jumpId" placeholder="message id, e.g. msg_000010" aria-label="Message id" />
        <button type="button" @click="jump(jumpId)">Jump</button>
      </div>
      <div class="harness-row">
        <button type="button" @click="jump(messages[0]?.id ?? '')">Jump to oldest</button>
        <button type="button" @click="jump(messages[Math.floor(messages.length / 2)]?.id ?? '')">Jump to middle</button>
      </div>
      <div class="harness-row">
        <input v-model="searchQuery" placeholder="search" aria-label="Search" />
        <button type="button" :disabled="!searchHits.length" @click="stepSearch(1)">Next</button>
        <button type="button" :disabled="!searchHits.length" @click="stepSearch(-1)">Previous</button>
      </div>
      <small v-if="searchQuery">{{ searchHits.length }} hits; active {{ activeSearchMessageId ?? "none" }}</small>
      <div class="harness-row">
        <button type="button" @click="switchRoom()">Switch room</button>
        <button type="button" @click="remount()">Remount (measure)</button>
      </div>
      <div class="harness-row">
        <button type="button" @click="activeThreadParentId = null">Close thread</button>
      </div>
      <pre class="harness-metrics" data-testid="harness-metrics">{{ metricsText }}</pre>
      <ol class="harness-log">
        <li v-for="(line, index) in log" :key="index">{{ line }}</li>
      </ol>
    </aside>
    <section class="harness-viewport room-tab-page room-chat-page">
      <div class="room-chat-layout" :data-thread-open="Boolean(activeThreadParentId)">
        <div class="room-chat-main">
          <RoomMessageViewport
            v-if="mounted"
            :key="mountKey"
            ref="viewport"
            :active="true"
            :active-search-message-id="activeSearchMessageId"
            :active-thread-parent-id="activeThreadParentId"
            :has-older-messages="olderPool.length > 0"
            :loading-older-messages="loadingOlder"
            :older-messages-error="null"
            :messages="messages"
            :thread-messages="[]"
            :message-namespace="`harness:${roomIdentifier}`"
            :local-agent-work="[]"
            :delivery-receipts-by-message="{}"
            :has-filtered-room-activity="false"
            :room-identifier="roomIdentifier"
            :github-activity-available="true"
            :room-loading="false"
            :search-query="searchQuery"
            :task-reference-ids="taskReferenceIds"
            :initial-scroll-position="null"
            @load-older="loadOlder"
            @open-thread="openThread"
            @reveal-message="(id) => note(`reveal-message ${id} (not loaded)`)"
          >
            <template #thread>
              <div class="harness-thread" data-testid="harness-thread-panel">
                Thread panel for {{ activeThreadParentId }}
                <button type="button" @click="activeThreadParentId = null">Close</button>
              </div>
            </template>
          </RoomMessageViewport>
        </div>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, type ComponentInternalInstance, type VNode } from "vue";
import RoomMessageViewport from "../../renderer/src/components/desktop/content/room-chat/RoomMessageViewport.vue";
import type { DesktopRoomMessage } from "../../electron/ipc-types";
import { createFakeMessages } from "./fake-messages";

const params = new URLSearchParams(location.search);
const count = Math.max(1, Math.min(50_000, Number(params.get("n")) || 2000));
const olderCount = Math.max(0, Number(params.get("older") ?? 300) || 0);
const pageSize = 50;

const roomIdentifier = ref("harness-room-a");
const mounted = ref(true);
const mountKey = ref(0);
const viewport = ref<InstanceType<typeof RoomMessageViewport> | null>(null);
const all = createFakeMessages(count + olderCount);
const olderPool = shallowRef<DesktopRoomMessage[]>(all.slice(0, olderCount));
const messages = shallowRef<DesktopRoomMessage[]>(all.slice(olderCount));
const loadingOlder = ref(false);
const jumpId = ref("");
const searchQuery = ref("");
const activeSearchIndex = ref(-1);
const activeThreadParentId = ref<string | null>(null);
const taskReferenceIds = new Set<string>(["task_42"]);
const log = ref<string[]>([]);
const metrics = ref<Record<string, number | string>>({});
let appended = 0;

const searchHits = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return [];
  return messages.value.filter(message => message.text.toLowerCase().includes(query));
});
const activeSearchMessageId = computed(() => searchHits.value[activeSearchIndex.value]?.id ?? null);
const metricsText = computed(() => Object.entries(metrics.value).map(([key, value]) => `${key}: ${value}`).join("\n"));

function note(line: string): void {
  log.value = [line, ...log.value].slice(0, 12);
}

function listElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="room-chat-list"]');
}

function countComponents(): number {
  const root = (viewport.value as unknown as { $: ComponentInternalInstance } | null)?.$;
  if (!root) return 0;
  let total = 0;
  const visitInstance = (instance: ComponentInternalInstance): void => {
    total += 1;
    visitVNode(instance.subTree);
  };
  const visitVNode = (vnode: VNode | null | undefined): void => {
    if (!vnode) return;
    if (vnode.component) { visitInstance(vnode.component); return; }
    if (vnode.suspense) { visitVNode(vnode.suspense.activeBranch); return; }
    if (Array.isArray(vnode.children)) for (const child of vnode.children) visitVNode(child as VNode);
  };
  visitInstance(root);
  return total;
}

function afterPaint(): Promise<void> {
  // A background page can run no animation frames at all. mountMs and appendMs
  // are measured with a forced layout before this wait, so they stay valid there.
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => setTimeout(finish, 0));
    setTimeout(finish, 100);
  });
}

function snapshot(extra: Record<string, number | string> = {}): Record<string, number | string> {
  const list = listElement();
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const next = {
    ...metrics.value,
    loadedMessages: messages.value.length,
    mountedMessages: list?.querySelectorAll(".room-chat-message").length ?? 0,
    domNodesInList: list?.getElementsByTagName("*").length ?? 0,
    components: countComponents(),
    ...(memory ? { heapMB: Math.round(memory.usedJSHeapSize / 1024 / 1024) } : {}),
    ...extra,
  };
  metrics.value = next;
  return next;
}

async function remount(): Promise<Record<string, number | string>> {
  mounted.value = false;
  await nextTick();
  await afterPaint();
  const started = performance.now();
  mounted.value = true;
  mountKey.value += 1;
  await nextTick();
  listElement()?.getBoundingClientRect();
  const scriptAndLayout = performance.now() - started;
  await afterPaint();
  return snapshot({ mountMs: round(scriptAndLayout), mountToPaintMs: round(performance.now() - started) });
}

async function appendMessage(own: boolean): Promise<Record<string, number | string>> {
  appended += 1;
  const [message] = createFakeMessages(1, { prefix: own ? "own" : "new", startIndex: 900_000 + appended, endTime: Date.now() + appended * 1000 });
  const started = performance.now();
  messages.value = [...messages.value, { ...message!, id: `${own ? "own" : "new"}_${appended}` }];
  await nextTick();
  listElement()?.getBoundingClientRect();
  const scriptAndLayout = performance.now() - started;
  await afterPaint();
  return snapshot({ appendMs: round(scriptAndLayout), appendToPaintMs: round(performance.now() - started) });
}

async function jump(id: string): Promise<boolean> {
  const found = Boolean(viewport.value?.scrollToMessage(id));
  note(`jump ${id}: ${found ? "found" : "not found"}`);
  await nextTick();
  await afterPaint();
  snapshot();
  return found;
}

function stepSearch(direction: 1 | -1): void {
  const total = searchHits.value.length;
  if (!total) return;
  activeSearchIndex.value = activeSearchIndex.value < 0
    ? (direction === 1 ? total - 1 : 0)
    : (activeSearchIndex.value - direction + total) % total;
  void nextTick().then(afterPaint).then(() => snapshot());
}

function loadOlder(): void {
  if (loadingOlder.value || !olderPool.value.length) return;
  loadingOlder.value = true;
  note("load-older requested");
  setTimeout(() => {
    const pool = olderPool.value;
    const page = pool.slice(Math.max(0, pool.length - pageSize));
    olderPool.value = pool.slice(0, Math.max(0, pool.length - pageSize));
    messages.value = [...page, ...messages.value];
    loadingOlder.value = false;
    void nextTick().then(afterPaint).then(() => snapshot());
  }, 250);
}

function openThread(id: string): void {
  activeThreadParentId.value = activeThreadParentId.value === id ? null : id;
}

async function switchRoom(): Promise<void> {
  roomIdentifier.value = roomIdentifier.value.endsWith("a") ? "harness-room-b" : "harness-room-a";
  activeThreadParentId.value = null;
  activeSearchIndex.value = -1;
  const fresh = createFakeMessages(count + olderCount, { prefix: roomIdentifier.value.endsWith("a") ? "msg" : "roomb" });
  olderPool.value = fresh.slice(0, olderCount);
  messages.value = fresh.slice(olderCount);
  await nextTick();
  await afterPaint();
  snapshot();
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

// For scripted checks from the browser console or an automation tool.
(window as unknown as { __viewportHarness: unknown }).__viewportHarness = {
  remount, appendMessage, jump, switchRoom, snapshot, loadOlder,
  list: listElement,
  messages: () => messages.value,
  search(query: string) { searchQuery.value = query; activeSearchIndex.value = -1; },
  stepSearch,
  openThread,
};

void nextTick().then(afterPaint).then(() => snapshot());
</script>

<style>
html, body, #app { height: 100%; margin: 0; }
body { background: var(--bg, #0a0a0a); color: var(--text-primary, #eee); }
.viewport-harness { display: grid; grid-template-columns: 300px minmax(0, 1fr); height: 100vh; }
.harness-controls { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-right: 1px solid #333; overflow: auto; font: 12px/1.4 system-ui, sans-serif; }
.harness-row { display: flex; gap: 6px; flex-wrap: wrap; }
.harness-row input { flex: 1; min-width: 0; }
.harness-metrics { white-space: pre-wrap; background: #151515; padding: 8px; border-radius: 4px; }
.harness-log { margin: 0; padding-left: 18px; color: #aaa; }
.harness-viewport { min-height: 0; height: 100vh; display: flex; flex-direction: column; }
.harness-viewport .room-chat-layout { flex: 1; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr); }
.harness-thread { margin: 8px 0; padding: 12px; border: 1px dashed #666; border-radius: 6px; }
</style>
