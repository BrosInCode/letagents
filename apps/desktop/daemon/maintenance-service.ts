import { dirname } from "node:path";
import { registerLocalBoardOwner } from "../../../shared/local-board-owner.mjs";
import type { DaemonSingleton } from "./singleton.js";
import type { ManifestStore } from "./manifest-store.js";
import type { DaemonReadModel } from "./daemon-read-model.js";
import type { DaemonRequest } from "./types.js";
import { DAEMON_MAINTENANCE_MESSAGE, readDaemonMaintenance, daemonMaintenancePath, type DaemonMaintenanceHold } from "../../../shared/daemon-maintenance.mjs";

/** A cold maintenance boot has never acquired native custody. Its shutdown
 * closes only its stores, socket and singleton, without provider handoff. */
export class DaemonMaintenanceService {
  private retiring = false;
  private resolve!: () => void;
  private reject!: (error: unknown) => void;
  readonly completion = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  constructor(readonly hold: DaemonMaintenanceHold, private readonly operations: {
    assertCurrent(): Promise<void>;
    status(): unknown;
    list(): Promise<unknown>;
    close(): Promise<void>;
  }) { void this.completion.catch(() => undefined); }

  async handle(request: DaemonRequest): Promise<unknown> {
    await this.operations.assertCurrent();
    if (request.method === "daemon.negotiate" || request.method === "daemon.status") return this.operations.status();
    if (request.method === "daemon.prepare_handoff") {
      if (!this.retiring) {
        this.retiring = true;
        // Let the admission response flush before closing its socket.
        setTimeout(() => { void this.operations.close().then(this.resolve, this.reject); }, 25).unref();
      }
      return { accepted: true };
    }
    if (!this.retiring && request.method === "manifest.list") return this.operations.list();
    throw new Error(DAEMON_MAINTENANCE_MESSAGE);
  }
}

/** Compose held-service resources without acquiring provider custody. */
export async function openDaemonMaintenance(ports: {
  singleton: DaemonSingleton;
  store: Pick<ManifestStore, "load" | "close">;
  socket: { stop(): Promise<void> };
  stores: { close(): Promise<void> }[];
  status(): unknown;
  retire(): void;
}): Promise<DaemonMaintenanceService | null> {
  const hold = await readDaemonMaintenance(daemonMaintenancePath(dirname(ports.singleton.lockPath)));
  if (!hold) return null;
  return new DaemonMaintenanceService(hold, {
    assertCurrent: () => ports.singleton.assertCurrent(), status: ports.status,
    list: async () => (await ports.store.load()).entries,
    close: async () => {
      ports.retire();
      const results = await Promise.allSettled([ports.socket.stop(), ports.store.close(),
        ...ports.stores.map(store => store.close())]);
      await ports.singleton.release();
      const failures = results.filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures, "Maintenance service shutdown failed.");
    },
  });
}

/** The local board shares the same maintenance and generation admission fence. */
export function registerDaemonBoardAccess(singleton: DaemonSingleton, isActive: () => boolean): void {
  const generation = singleton.currentGeneration;
  registerLocalBoardOwner(() => {
    if (!isActive() || singleton.currentGeneration !== generation) {
      throw new Error("The board service is restarting.");
    }
  });
}

export function maintenanceStatus(status: ReturnType<DaemonReadModel["status"]>, hold?: DaemonMaintenanceHold) {
  return { ...status, maintenance_hold_id: hold?.id ?? null,
    capabilities: hold
      ? Object.fromEntries(Object.keys(status.capabilities).map(key => [key, false])) as typeof status.capabilities
      : status.capabilities };
}
