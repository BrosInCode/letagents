import type { DaemonRequest } from "./types.js";
import { DAEMON_MAINTENANCE_MESSAGE, type DaemonMaintenanceHold } from "../../../shared/daemon-maintenance.mjs";

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
