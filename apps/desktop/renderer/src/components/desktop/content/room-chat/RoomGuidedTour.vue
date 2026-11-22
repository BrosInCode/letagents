<template>
  <dialog ref="dialog" class="room-guide" aria-label="Quick tour" data-testid="room-guided-tour" @close="stop">
    <svg v-if="thread" class="room-guide-thread" aria-hidden="true">
      <path :d="thread.path" class="thread-shadow" />
      <path :d="thread.path" class="thread-line" />
      <circle :cx="thread.x" :cy="thread.y" r="10" class="thread-ring" />
      <circle :cx="thread.x" :cy="thread.y" r="3" class="thread-tip" />
    </svg>
    <section ref="card" class="room-guide-card">
      <button class="room-guide-close" aria-label="Close quick tour" type="button" @click="dialog?.close()">
        <X aria-hidden="true" />
      </button>
      <div class="room-guide-text" aria-live="polite">
        <Transition name="guide-example" mode="out-in">
          <div :key="step.title" class="room-guide-example">
            <span class="room-guide-icon"><component :is="step.icon" aria-hidden="true" /></span>
            <h2>{{ step.title }}</h2>
            <p>{{ step.description }}</p>
            <span class="room-guide-example-note">{{ step.example }}</span>
          </div>
        </Transition>
      </div>
      <footer class="room-guide-actions">
        <button type="button" class="room-guide-back" :disabled="index === 0" @click="move(-1)">
          <ArrowLeft aria-hidden="true" /> Back
        </button>
        <span class="room-guide-position">{{ index + 1 }} / {{ availableSteps.length }}</span>
        <button type="button" class="room-guide-next" data-testid="room-guide-next" autofocus
          @click="index + 1 === availableSteps.length ? dialog?.close() : move(1)">
          {{ index + 1 === availableSteps.length ? "Done" : "Next" }} <ArrowRight aria-hidden="true" />
        </button>
      </footer>
    </section>
  </dialog>
</template>

<script setup lang="ts">
import { ArrowLeft, ArrowRight, Bot, Columns3, Folder, ListTodo, MessageCircle, NotebookText, X } from "@lucide/vue";
import { computed, nextTick, onDeactivated, onUnmounted, ref, shallowRef } from "vue";

const steps = [
  { title: "Rooms", selector: "[data-testid='sidebar-rooms-heading'], [data-testid='sidebar-section-rooms']", icon: Folder, description: "Each room keeps its own conversations, agents, and tasks together.", example: "Switch projects from the sidebar." },
  { title: "Chat", selector: "[data-testid='desktop-room-tab-chat']", icon: MessageCircle, description: "Talk to your team and mention an agent when you need its help.", example: "Ask for a second look in a thread." },
  { title: "Agents", selector: "[data-testid='desktop-room-tab-activity']", icon: Bot, description: "See who’s in the room and what the agents are working on.", example: "Open an agent to see its activity." },
  { title: "Board", selector: "[data-testid='desktop-room-tab-board']", icon: Columns3, description: "Track assignments, reviews, and blockers for this room.", example: "Open a task to see what’s left." },
  { title: "Memory", selector: "[data-testid='desktop-room-tab-memory']", icon: NotebookText, description: "Keep decisions and context where teammates can find them again.", example: "Save the reason behind a decision." },
  { title: "My work", selector: "[data-testid='sidebar-my-work']", icon: ListTodo, description: "See your assignments across the rooms you work in.", example: "Pick up a task without searching through chat." },
];

const dialog = ref<HTMLDialogElement | null>(null);
const card = ref<HTMLElement | null>(null);
const availableSteps = shallowRef(steps);
const index = ref(0);
const step = computed(() => availableSteps.value[index.value] ?? steps[1]);
const thread = ref<{ path: string; x: number; y: number } | null>(null);
let frame = 0;

function visibleTarget(selector: string): DOMRect | undefined {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    if (element.closest('[inert], [hidden], [aria-hidden="true"]')) continue;
    const box = element.getBoundingClientRect();
    if (box.width && box.height && box.right > 0 && box.left < window.innerWidth && box.bottom > 0 && box.top < window.innerHeight) return box;
  }
}

function pointToTarget(animate = false) {
  cancelAnimationFrame(frame);
  const element = card.value;
  const target = visibleTarget(step.value.selector);
  if (!element || !target) {
    thread.value = null;
    return;
  }
  const box = element.getBoundingClientRect();
  const destination = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
  const source = thread.value ?? destination;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const start = performance.now();

  function draw(progress: number) {
    const t = 1 - (1 - progress) ** 3;
    const x = source.x + (destination.x - source.x) * t;
    const y = source.y + (destination.y - source.y) * t;
    const above = y < box.top;
    const below = y > box.bottom;
    const fromX = above || below ? box.left + box.width / 2 : x < box.left ? box.left : box.right;
    const fromY = above ? box.top : below ? box.bottom : box.top + box.height / 2;
    const sag = Math.min(76, Math.hypot(x - fromX, y - fromY) * .24) + Math.sin(progress * Math.PI) * 26;
    thread.value = {
      x, y,
      path: `M ${fromX} ${fromY} C ${fromX + (x - fromX) * .38} ${fromY + sag}, ${x - (x - fromX) * .24} ${y + sag}, ${x} ${y}`,
    };
  }

  if (!animate || reduced || !thread.value) {
    draw(1);
    return;
  }
  function tick(now: number) {
    const progress = Math.min(1, (now - start) / 430);
    draw(progress);
    if (progress < 1) frame = requestAnimationFrame(tick);
  }
  frame = requestAnimationFrame(tick);
}

function resize() {
  const room = dialog.value?.closest(".desktop-room-shell");
  const box = room?.getBoundingClientRect();
  const x = box ? Math.min(window.innerWidth, box.right) - box.width / 2 : window.innerWidth / 2;
  dialog.value?.style.setProperty("--tour-center-x", `${x}px`);
  pointToTarget();
}

async function open() {
  if (!dialog.value || dialog.value.open) return;
  const visible = steps.filter(item => visibleTarget(item.selector));
  availableSteps.value = visible.length ? visible : [steps[1]];
  index.value = 0;
  dialog.value.showModal();
  window.addEventListener("resize", resize);
  await nextTick();
  resize();
}

function move(direction: number) {
  index.value += direction;
  pointToTarget(true);
}

function stop() {
  cancelAnimationFrame(frame);
  window.removeEventListener("resize", resize);
  thread.value = null;
}

function close() { dialog.value?.close(); }
onDeactivated(close);
onUnmounted(stop);
defineExpose({ open, close });
</script>

<style scoped>
.room-guide { position: fixed; inset: 0; width: 100vw; height: 100dvh; max-width: none; max-height: none; padding: 0; border: 0; color: var(--text); background: transparent; }
.room-guide[open] { display: grid; place-items: center; }
.room-guide::backdrop { background: #0008; }
.room-guide-thread { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; color: var(--workspace-accent, #a8dec7); }
.thread-line, .thread-shadow { fill: none; stroke: currentColor; stroke-width: 1.4; }
.thread-shadow { stroke-width: 6; opacity: .12; }
.thread-ring { fill: transparent; stroke: currentColor; opacity: .68; }
.thread-tip { fill: currentColor; }
.room-guide-card { position: absolute; top: 50%; left: clamp(min(228px, 50vw), var(--tour-center-x, 50vw), max(calc(100vw - 228px), 50vw)); transform: translate(-50%, -50%); box-sizing: border-box; display: grid; grid-template-rows: 1fr auto; width: min(420px, calc(100vw - 36px)); min-height: 275px; padding: 24px; border: 1px solid var(--workspace-border, var(--border)); border-radius: 18px; background: var(--workspace-canvas, var(--bg)); box-shadow: 0 20px 60px #0005; }
.room-guide-text { min-height: 182px; }
.room-guide-example { display: grid; align-content: start; gap: 11px; }
.room-guide-icon { display: grid; width: 33px; height: 33px; place-items: center; border-radius: 9px; color: var(--workspace-accent, var(--text)); background: var(--workspace-composer, var(--bg-card)); }
.room-guide-icon svg { width: 17px; height: 17px; }
.room-guide-example h2 { margin: 0; font-family: "Iowan Old Style", Georgia, serif; font-weight: 500; font-size: 34px; line-height: 1; }
.room-guide-example p, .room-guide-example-note { margin: 0; color: var(--text-secondary); line-height: 1.45; }
.room-guide-example-note { display: block; width: fit-content; padding: 5px 9px; border-radius: 6px; background: var(--workspace-composer, var(--bg-card)); font-size: 12px; }
.room-guide-actions { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.room-guide-actions button, .room-guide-close { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; padding: 0 10px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--text); font: inherit; cursor: pointer; }
.room-guide-actions button:disabled { opacity: .32; cursor: default; }
.room-guide-actions button:focus-visible, .room-guide-close:focus-visible { outline: 2px solid var(--workspace-accent, var(--text)); }
.room-guide-actions button:hover:not(:disabled), .room-guide-close:hover { background: var(--workspace-composer, var(--bg-card)); }
.room-guide-actions .room-guide-next { border-color: var(--workspace-border, var(--border)); background: var(--workspace-composer, var(--bg-card)); }
.room-guide-actions svg, .room-guide-close svg { width: 15px; height: 15px; }
.room-guide-position { color: var(--text-secondary); font-size: 12px; }
.room-guide-close { position: absolute; z-index: 1; right: 13px; top: 13px; }
.guide-example-enter-active { transition: opacity 180ms ease, transform 200ms cubic-bezier(.16,1,.3,1); }
.guide-example-leave-active { transition: opacity 100ms ease; }
.guide-example-enter-from { opacity: 0; transform: translateY(5px); }
.guide-example-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) { .guide-example-enter-active, .guide-example-leave-active { transition: none; } .guide-example-enter-from { transform: none; } }
</style>
