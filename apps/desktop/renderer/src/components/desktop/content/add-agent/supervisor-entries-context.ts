import { inject, type InjectionKey, type Ref } from "vue";
import type { DesktopSupervisorManifestEntry } from "../../../../../../electron/ipc-types";
import type { SupervisorEntriesResource } from "../../../../domain/agent-inspector-identity";

/**
 * The room shell's view of the daemon's supervisor entries, shared with the
 * add-agent flow. The daemon pushes every manifest change to the shell, which
 * polls only when that push goes stale, so a launch card follows `entries`
 * instead of running a read loop of its own. `refresh` asks the shell to read
 * the entries and the daemon status again; it polls only when the push is
 * stale.
 */
export interface SupervisorEntriesContext {
  entries: Readonly<Ref<readonly DesktopSupervisorManifestEntry[]>>;
  state: Readonly<Ref<SupervisorEntriesResource["state"]>>;
  /** Why the shell's last read failed, while `state` is "error". */
  error: Readonly<Ref<string | null>>;
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
