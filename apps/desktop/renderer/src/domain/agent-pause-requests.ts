import { ref, watch, type Ref } from "vue";
import type { DesktopSupervisorManifestEntry } from "../../../electron/ipc-types";

/**
 * Room-level ownership of open Pause requests. The daemon drains room delivery
 * before it saves desired=paused, which can take a while mid-turn, so an agent
 * reads as pausing from the click until its saved state arrives. The room owns
 * this, not the Inspector that asked: closing it must not end the state.
 */
export function useAgentPauseRequests(entries: Readonly<Ref<readonly DesktopSupervisorManifestEntry[]>>) {
  const entryIds = ref<ReadonlySet<string>>(new Set());

  function without(ids: ReadonlySet<string>, predicate: (entryId: string) => boolean): ReadonlySet<string> {
    const next = new Set([...ids].filter((entryId) => !predicate(entryId)));
    return next.size === ids.size ? ids : next;
  }

  // A request ends once the saved state is visible (or the agent is gone).
  watch(entries, (current) => {
    entryIds.value = without(entryIds.value, (entryId) =>
      current.find((entry) => entry.id === entryId)?.desiredState !== "running");
  }, { flush: "sync" });

  /** The request no longer decides the state: it failed, or the agent was resumed. */
  function clear(entryId: string): void {
    entryIds.value = without(entryIds.value, (candidate) => candidate === entryId);
  }

  /** Runs a Pause request; the agent reads as pausing until its saved state arrives. */
  async function run<T>(entryId: string, request: () => Promise<T>): Promise<T> {
    entryIds.value = new Set([...entryIds.value, entryId]);
    try {
      return await request();
    } catch (error) {
      clear(entryId);
      throw error;
    }
  }

  return { entryIds, run, clear };
}
