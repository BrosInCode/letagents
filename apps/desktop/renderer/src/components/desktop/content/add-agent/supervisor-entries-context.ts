import { inject, type InjectionKey } from "vue";

/**
 * Lets the add-agent flow ask the room shell to refresh its supervisor entries
 * and daemon status. New entries normally arrive by push; the refresh polls
 * the daemon only when that push is stale.
 */
export interface SupervisorEntriesContext {
  refresh: () => Promise<void>;
}

export const supervisorEntriesKey: InjectionKey<SupervisorEntriesContext> =
  Symbol("supervisor-entries");

export function useSupervisorEntriesContext(): SupervisorEntriesContext {
  const context = inject(supervisorEntriesKey, null);
  if (!context) {
    throw new Error("Supervisor entries context is unavailable.");
  }
  return context;
}
