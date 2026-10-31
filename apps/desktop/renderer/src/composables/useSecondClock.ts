import { onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";

/**
 * The time now, moved on once a second while `active` says that something on
 * screen counts down to a saved time. The countdown itself is always that
 * saved time minus this clock, so it is right after a restart or a long sleep.
 */
export function useSecondClock(active: () => boolean): Ref<number> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  onMounted(() => watch(active, (ticking) => {
    stop();
    if (!ticking) return;
    now.value = Date.now();
    timer = setInterval(() => { now.value = Date.now(); }, 1_000);
  }, { immediate: true }));
  onBeforeUnmount(stop);
  return now;
}
