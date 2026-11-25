/**
 * Manifest and entry reads, per-agent versions, and runtime lifecycle authority.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import { composeDaemonManifestEntry } from "../manifest-entry-projection.js";
import { executionRuntimeStorageIdentity } from "../execution-shadow-store.js";
import type { DaemonManifest, DaemonManifestEntry, DaemonProviderConnection } from "../types.js";
import { type Row, type ActivityShape, storeMethods } from "./shared.js";
import { deepFreeze } from "../deep-freeze.js";

export const entryReads = storeMethods({
  async load(activityMode: "full" | "summary" = "full"): Promise<{ entries: DaemonManifestEntry[]; versions: Record<string, number> }> {
    const database = await this.getDatabase();
    const rows = this.reads.get(database, "allEntries").all() as Row[];
    const versions: Record<string, number> = {};
    const entries = rows.map((row) => {
      versions[String(row.agent_id)] = Number(row.version);
      return composeDaemonManifestEntry(this.projectionFromRow(database, row, activityMode));
    });
    return { entries, versions };
  },

  /**
   * The manifest as the state watch reads it: every entry in summary activity
   * mode, projected again only for an agent whose manifest rows changed since
   * the last such read. The database counts those changes itself
   * (`agent_state_versions.manifest_version`, moved by triggers on `agents` and
   * `activity_events`), so a writer cannot leave an entry stale, and a change
   * for one agent costs no other agent a read. Entries are frozen and shared.
   */
  async loadForStateWatch(): Promise<DaemonManifest> {
    const database = await this.getDatabase();
    const project = (row: Row): DaemonManifestEntry => deepFreeze(composeDaemonManifestEntry(this.projectionFromRow(database, row, "summary")));
    if (database.isTransaction) {
      return { entries: (this.reads.get(database, "allEntries").all() as Row[]).map(project) };
    }
    const kept = this.stateWatchEntries?.database === database
      ? this.stateWatchEntries.byAgent : new Map<string, { version: number; entry: DaemonManifestEntry }>();
    const versions = new Map<string, number>();
    for (const row of this.reads.get(database, "agentManifestVersions").all() as Row[]) versions.set(String(row.agent_id), Number(row.manifest_version));
    const keep = new Map<string, { version: number; entry: DaemonManifestEntry }>();
    const entries: DaemonManifestEntry[] = [];
    if (kept.size === 0) {
      for (const row of this.reads.get(database, "allEntries").all() as Row[]) {
        const entry = project(row);
        keep.set(entry.id, { version: versions.get(entry.id) ?? 0, entry });
        entries.push(entry);
      }
    } else {
      for (const idRow of this.reads.get(database, "entryIds").all() as Row[]) {
        const id = String(idRow.agent_id);
        const version = versions.get(id) ?? 0;
        const previous = kept.get(id);
        if (previous && previous.version === version) {
          keep.set(id, previous);
          entries.push(previous.entry);
          continue;
        }
        const row = this.reads.get(database, "entry").get(id) as Row | undefined;
        if (!row) continue;
        const entry = project(row);
        keep.set(id, { version, entry });
        entries.push(entry);
      }
    }
    this.stateWatchEntries = { database, byAgent: keep };
    return { entries };
  },

  /**
   * The id of every entry, in the order that load() returns the entries. It
   * reads one column of `agents`: no entry is projected and no activity is read.
   */
  async listEntryIds(): Promise<string[]> {
    const database = await this.getDatabase();
    return (this.reads.get(database, "entryIds").all() as Row[]).map((row) => String(row.agent_id));
  },

  async listUnresolvedTurnControlRecovery(): Promise<{ agentIds: string[] }> {
    const database = await this.getDatabase();
    const agentIds = (this.reads.get(database, "unresolvedTurnControlAgentIds").all() as Row[])
      .map((row) => String(row.agent_id));
    return { agentIds };
  },

  async getEntry(agentId: string, activityMode: "full" | "summary" = "full"): Promise<DaemonManifestEntry | undefined> {
    const database = await this.getDatabase();
    return this.readEntryFromDatabase(database, agentId, activityMode);
  },

  async getEntryVersion(agentId: string): Promise<number | undefined> {
    const database = await this.getDatabase();
    const row = this.reads.get(database, "entryVersion").get(agentId) as Row | undefined;
    return row ? Number(row.version) : undefined;
  },

  async getEntryWithVersion(
    agentId: string,
    activityMode: "full" | "summary" = "full",
  ): Promise<{ entry: DaemonManifestEntry; version: number } | undefined> {
    const database = await this.getDatabase();
    const row = this.reads.get(database, "entry").get(agentId) as Row | undefined;
    if (!row) return undefined;
    return {
      entry: composeDaemonManifestEntry(this.projectionFromRow(database, row, activityMode)),
      version: Number(row.version),
    };
  },

  /**
   * One entry as getEntry(agentId, "summary") reads it, and the shape of its
   * whole activity, from the same snapshot. Reads no payloads.
   */
  async getEntrySummaryWithActivityShape(agentId: string): Promise<{ entry: DaemonManifestEntry; activityShape: ActivityShape } | undefined> {
    const database = await this.getDatabase();
    const entry = this.readEntryFromDatabase(database, agentId, "summary");
    if (!entry) return undefined;
    const row = this.reads.get(database, "activityShape").get(agentId, agentId) as Row;
    return { entry, activityShape: {
      count: Number(row.count), sequenceTotal: Number(row.sequence_total),
      firstSequence: row.first_sequence == null ? null : Number(row.first_sequence),
    } };
  },

  async listRoomEntries(roomId: string, activityMode: "full" | "summary" = "full"): Promise<DaemonManifestEntry[]> {
    const database = await this.getDatabase();
    return (this.reads.get(database, "roomEntries").all(roomId) as Row[])
      .map((row) => composeDaemonManifestEntry(this.projectionFromRow(database, row, activityMode)));
  },

  /**
   * Read the authority frozen onto one exact native process birth. This never
   * consults current release policy and never materializes or relabels a row.
   */
  async readRuntimeLifecycleAuthority(input: {
    agentId: string;
    executionGenerationId: string;
    providerConnection: DaemonProviderConnection;
    configurationRevision: number;
  }): Promise<"typed" | null> {
    const snapshot = structuredClone(input);
    if (!snapshot.agentId || !snapshot.executionGenerationId
      || snapshot.providerConnection.pid === null || !snapshot.providerConnection.processIdentity
      || !Number.isSafeInteger(snapshot.configurationRevision) || snapshot.configurationRevision < 1) return null;
    const provider = {
      codex_app_server: "codex",
      claude_cli: "claude-code",
      cursor_cli: "cursor",
      opencode_server: "open-model",
      antigravity_acp: "antigravity",
    } as const;
    const runtimeGenerationId = executionRuntimeStorageIdentity(snapshot.agentId,
      snapshot.executionGenerationId, snapshot.providerConnection.kind,
      snapshot.providerConnection.pid, snapshot.providerConnection.processIdentity);
    const row = (await this.getDatabase()).prepare(`SELECT authority_mode FROM execution_runtime_generations
      WHERE agent_id=? AND execution_generation_id=? AND runtime_generation_id=? AND provider=? AND config_revision=?`)
      .get(snapshot.agentId, snapshot.executionGenerationId, runtimeGenerationId,
        provider[snapshot.providerConnection.kind], snapshot.configurationRevision) as Row | undefined;
    return row?.authority_mode === "typed" ? "typed" : null;
  },
});
