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

  function begin(entryId: string): void {
    entryIds.value = new Set([...entryIds.value, entryId]);
  }

  /** The request failed, so the agent's own state is the truth again. */
  function fail(entryId: string): void {
    entryIds.value = without(entryIds.value, (candidate) => candidate === entryId);
  }

  return { entryIds, begin, fail };
}
