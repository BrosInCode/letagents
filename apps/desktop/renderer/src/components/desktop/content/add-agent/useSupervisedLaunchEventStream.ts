import { ref } from "vue";
import type { DesktopLaunchEvent } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc/index.js";

/** Own the transient launch event stream; the daemon manifest remains durable truth. */
export function useSupervisedLaunchEventStream() {
  const activeLaunchId = ref<string | null>(null);
  const events = ref<DesktopLaunchEvent[]>([]);
  let generation = 0;
  let unsubscribeListener: (() => void) | null = null;

  function append(event: DesktopLaunchEvent): void {
    if (events.value.some((existing) => existing.sequence === event.sequence)) return;
    events.value = [...events.value, event];
  }

  function unsubscribe(): void {
    generation += 1;
    unsubscribeListener?.();
    unsubscribeListener = null;
  }

  async function replay(launchId: string): Promise<void> {
    const replayGeneration = generation;
    const getEvents = desktopIpc.supervisor.getLaunchEvents;
    if (typeof getEvents !== "function") return;
    try {
      const history = await getEvents(launchId);
      if (replayGeneration !== generation || activeLaunchId.value !== launchId) return;
      for (const event of history) append(event);
    } catch {
      // The manifest snapshot is the durable fallback when replay is unavailable.
    }
  }

  function subscribe(launchId: string): void {
    unsubscribe();
    activeLaunchId.value = launchId;
    events.value = [];
    unsubscribeListener = desktopIpc.supervisor.onLaunchEvent?.((event) => {
      if (event.launchId === activeLaunchId.value) append(event);
    }) ?? null;
    void replay(launchId);
  }

  function clear(): void {
    unsubscribe();
    activeLaunchId.value = null;
    events.value = [];
  }

  return { activeLaunchId, events, append, replay, subscribe, unsubscribe, clear };
}
