import { AuditLog } from "./audit-log.js";
import { DaemonControlSocket } from "./control-socket.js";
import { ManifestStore } from "./manifest-store.js";
import { assertMacOS } from "./platform.js";
import { DaemonFenceLostError, DaemonSingleton, defaultDaemonPaths } from "./singleton.js";
import type { DaemonManifestEntry, ObservedState, PolicyCondition } from "./types.js";

export class SupervisorDaemon {
  private manifestGeneration = 0;
  private readonly singleton: DaemonSingleton;
  private readonly store: ManifestStore;
  private readonly audit: AuditLog;
  private readonly socket: DaemonControlSocket;

  constructor(paths = defaultDaemonPaths(), platform = process.platform) {
    this.singleton = new DaemonSingleton(paths.lockPath, platform);
    this.store = new ManifestStore(paths.manifestPath);
    this.audit = new AuditLog(paths.auditPath);
    this.socket = new DaemonControlSocket(paths.socketPath, async (request) => {
      await this.singleton.assertCurrent();
      if (request.method === "manifest.list") return (await this.store.load()).entries;
      throw new Error(`Unsupported daemon method: ${request.method}`);
    }, async (error) => { if (error instanceof DaemonFenceLostError) await this.stop(); });
  }

  async start(): Promise<void> {
    assertMacOS();
    await this.singleton.acquire();
    this.manifestGeneration = (await this.store.load()).generation;
    await this.socket.start();
  }

  async stop(): Promise<void> {
    await this.socket.stop();
    await this.singleton.release();
  }

  async transition(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string): Promise<void> {
    await this.singleton.assertCurrent();
    const manifest = await this.store.load();
    const entry = manifest.entries.find((candidate) => candidate.id === entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
    const updated: DaemonManifestEntry = { ...entry, observed_state: to, condition };
    const next = await this.store.write(this.manifestGeneration, manifest.entries.map((candidate) => candidate.id === entryId ? updated : candidate));
    this.manifestGeneration = next.generation;
    await this.audit.append({ at: new Date().toISOString(), entry_id: entryId, from: entry.observed_state, to, cause, actor, generation: next.generation });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const daemon = new SupervisorDaemon();
  void daemon.start().catch((error) => { console.error(error); process.exitCode = 1; });
}
