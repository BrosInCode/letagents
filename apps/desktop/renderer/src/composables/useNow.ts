import { getCurrentInstance, onMounted, onScopeDispose, readonly, shallowRef, watch, type Ref } from "vue";

import { shouldSkipPollTick } from "../domain/visibility-polling";

/**
 * One shared clock for every component that only needs "the time now" to keep
 * a relative age or an elapsed time fresh.
 *
 * - One timer per interval length, shared by all subscribers (not one per row).
 * - The timer starts on the first subscriber and stops with the last one.
 * - Ticks land on wall-clock boundaries (a 30 s clock ticks at :00 and :30), so
 *   every view that shows an age changes at the same moment.
 * - A tick is skipped while the window is hidden. The clock catches up at once
 *   when the window is visible again.
 */
interface SharedClock {
  now: Ref<number>;
  subscribers: number;
  alignTimer: ReturnType<typeof setTimeout> | null;
  interval: ReturnType<typeof setInterval> | null;
  onVisibility: (() => void) | null;
}

const clocks = new Map<number, SharedClock>();

function isHidden(): boolean {
  return Boolean(globalThis.document?.hidden);
}

/** A clock timer must never keep a Node process alive (tests); browsers have no `unref`. */
function unrefTimer(timer: unknown): void {
  (timer as { unref?: () => void } | null)?.unref?.();
}

function startClock(intervalMs: number, clock: SharedClock): void {
  const tick = () => {
    if (shouldSkipPollTick({ hidden: isHidden() })) return;
    clock.now.value = Date.now();
  };
  clock.onVisibility = () => { if (!isHidden()) clock.now.value = Date.now(); };
  globalThis.document?.addEventListener?.("visibilitychange", clock.onVisibility);
  const untilBoundary = intervalMs - (Date.now() % intervalMs);
  clock.alignTimer = setTimeout(() => {
    clock.alignTimer = null;
    tick();
    clock.interval = setInterval(tick, intervalMs);
    unrefTimer(clock.interval);
  }, untilBoundary);
  unrefTimer(clock.alignTimer);
}

function stopClock(clock: SharedClock): void {
  if (clock.alignTimer !== null) clearTimeout(clock.alignTimer);
  if (clock.interval !== null) clearInterval(clock.interval);
  if (clock.onVisibility) globalThis.document?.removeEventListener?.("visibilitychange", clock.onVisibility);
  clock.alignTimer = null;
  clock.interval = null;
  clock.onVisibility = null;
}

/** Subscribe to the shared clock. Returns a function that ends the subscription. */
export function subscribeNow(intervalMs: number): { now: Readonly<Ref<number>>; unsubscribe: () => void } {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = { now: shallowRef(Date.now()), subscribers: 0, alignTimer: null, interval: null, onVisibility: null };
    clocks.set(intervalMs, clock);
  }
  const entry = clock;
  if (entry.subscribers === 0) startClock(intervalMs, entry);
  // A new subscriber must not read an age from before the clock was idle.
  entry.now.value = Date.now();
  entry.subscribers += 1;
  let subscribed = true;
  return {
    now: readonly(entry.now),
    unsubscribe() {
      if (!subscribed) return;
      subscribed = false;
      entry.subscribers -= 1;
      if (entry.subscribers > 0) return;
      stopClock(entry);
      clocks.delete(intervalMs);
    },
  };
}

/** Number of intervals that currently have a running shared clock (for tests). */
export function activeNowClockCount(): number {
  return clocks.size;
}

/**
 * The time now in ms, moved on every `intervalMs` while the calling component
 * (or effect scope) is alive and `active` is true. Call it in `setup`.
 */
export function useNow(intervalMs: number, active: () => boolean = () => true): Readonly<Ref<number>> {
  const result = shallowRef(Date.now());
  let subscription: ReturnType<typeof subscribeNow> | null = null;
  let stopMirror: (() => void) | null = null;
  const stop = () => {
    stopMirror?.();
    subscription?.unsubscribe();
    stopMirror = null;
    subscription = null;
  };
  const watchActive = () => watch(
    active,
    (running) => {
      stop();
      if (!running) return;
      subscription = subscribeNow(intervalMs);
      result.value = subscription.now.value;
      stopMirror = watch(subscription.now, (value) => { result.value = value; }, { flush: "sync" });
    },
    { immediate: true },
  );
  // In a component, start only once it is mounted: a server-side or test
  // render never mounts, so it must not leave a timer running.
  if (getCurrentInstance()) onMounted(watchActive);
  else watchActive();
  onScopeDispose(stop);
  return readonly(result);
}
