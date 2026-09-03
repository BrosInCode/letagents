import type { SupervisorGrantHttp } from "./cloud-http.js";
import { collectBoundedInventory } from "./bounded-inventory.js";
import type { ExecutionDelegationInventoryScope } from "./execution-delegation-journal.js";
import type { DaemonManifestEntry } from "./types.js";
import type { InstalledHostGrant } from "./worker-runtime-custody.js";

type SyncLane = {
  controller: AbortController;
  promise: Promise<void>;
};

type RoomLane = {
  promise: Promise<void>;
};

export type ExecutionDelegationSyncOptions = {
  entries: {
    getEntry(entryId: string): Promise<DaemonManifestEntry | undefined>;
    listRoomEntries(roomId: string): Promise<DaemonManifestEntry[]>;
    listExecutionDelegationInstanceIds(input: ExecutionDelegationInventoryScope): Promise<string[]>;
  };
  authority: {
    currentHostGrant(entry: DaemonManifestEntry): InstalledHostGrant | null;
    syncExecutionDelegation(input: {
      entryId: string;
      delegationInstanceId: string;
      signal: AbortSignal;
    }): Promise<unknown>;
  };
  remote: Pick<SupervisorGrantHttp, "listExecutionDelegationIds">;
  entryObserved?(entryId: string): void;
  requestConvergence(entryId: string): void;
  diagnostic(entryId: string, error: unknown): void;
};

/**
 * Converts lossy room pointers into exact, host-authorized delegation state.
 * Each agent owns one lane: bursts may add one follow-up pass, never parallel
 * inventory reads or exact journal mutations.
 */
export class ExecutionDelegationSyncCoordinator {
  private readonly lanes = new Map<string, SyncLane>();
  private readonly eventSerials = new Map<string, number>();
  private readonly roomLanes = new Map<string, RoomLane>();
  private readonly roomEventSerials = new Map<string, number>();
  private fenced = false;

  constructor(private readonly options: ExecutionDelegationSyncOptions) {}

  request(entryId: string): Promise<void> {
    if (this.fenced) return Promise.resolve();
    this.eventSerials.set(entryId, (this.eventSerials.get(entryId) ?? 0) + 1);
    return this.start(entryId);
  }

  requestRoom(roomId: string): Promise<void> {
    if (this.fenced) return Promise.resolve();
    this.roomEventSerials.set(roomId, (this.roomEventSerials.get(roomId) ?? 0) + 1);
    return this.startRoom(roomId);
  }

  private start(entryId: string): Promise<void> {
    const active = this.lanes.get(entryId);
    if (active) return active.promise;
    const startedEventSerial = this.eventSerials.get(entryId) ?? 0;
    const lane: SyncLane = { controller: new AbortController(), promise: Promise.resolve() };
    this.lanes.set(entryId, lane);
    lane.promise = Promise.resolve().then(() => (
      this.reconcileOnce(entryId, lane.controller.signal)
    )).finally(() => {
      if (this.lanes.get(entryId) === lane) this.lanes.delete(entryId);
      if (!this.fenced && (this.eventSerials.get(entryId) ?? 0) > startedEventSerial) {
        queueMicrotask(() => {
          void this.start(entryId).catch((error) => this.options.diagnostic(entryId, error));
        });
      } else {
        this.eventSerials.delete(entryId);
      }
    });
    return lane.promise;
  }

  async fenceAndDrain(): Promise<void> {
    this.fenced = true;
    for (const lane of this.lanes.values()) lane.controller.abort();
    await Promise.allSettled([
      ...[...this.lanes.values()].map((lane) => lane.promise),
      ...[...this.roomLanes.values()].map((lane) => lane.promise),
    ]);
    this.eventSerials.clear();
    this.roomEventSerials.clear();
  }

  private startRoom(roomId: string): Promise<void> {
    const active = this.roomLanes.get(roomId);
    if (active) return active.promise;
    const startedEventSerial = this.roomEventSerials.get(roomId) ?? 0;
    const lane: RoomLane = { promise: Promise.resolve() };
    this.roomLanes.set(roomId, lane);
    lane.promise = Promise.resolve().then(async () => {
      const entries = await this.options.entries.listRoomEntries(roomId);
      for (const entry of entries) this.options.entryObserved?.(entry.id);
      await Promise.all(entries.map((entry) => this.request(entry.id)));
    }).finally(() => {
      if (this.roomLanes.get(roomId) === lane) this.roomLanes.delete(roomId);
      if (!this.fenced && (this.roomEventSerials.get(roomId) ?? 0) > startedEventSerial) {
        queueMicrotask(() => {
          void this.startRoom(roomId).catch((error) => this.options.diagnostic(roomId, error));
        });
      } else {
        this.roomEventSerials.delete(roomId);
      }
    });
    return lane.promise;
  }

  private async reconcileOnce(entryId: string, signal: AbortSignal): Promise<void> {
    const entry = await this.options.entries.getEntry(entryId);
    if (!entry) return;
    const grant = this.options.authority.currentHostGrant(entry);
    if (!grant || grant.ownerAccountId === null || grant.scopeKey !== "owner"
      || Date.parse(grant.expiresAt) <= Date.now()) return;

    const localIds = await this.options.entries.listExecutionDelegationInstanceIds({
      agentId: entry.id,
      roomId: grant.roomId,
      agentKey: grant.agentKey,
      ownerAccountId: grant.ownerAccountId,
      hostId: grant.hostId,
      installationId: grant.installationId,
    });
    const ids = await collectBoundedInventory(async (after) => {
      const page = await this.options.remote.listExecutionDelegationIds({
        apiUrl: grant.apiUrl,
        grantId: grant.grantId,
        supervisorGrant: grant.supervisorGrant,
        grantGeneration: grant.grantGeneration,
        roomId: grant.roomId,
        agentKey: grant.agentKey,
        after,
        signal,
      });
      return { ids: page.delegationInstanceIds, nextCursor: page.nextCursor };
    }, "Execution delegation inventory", localIds);

    let reconciledAny = false;
    try {
      for (const delegationInstanceId of ids) {
        await this.options.authority.syncExecutionDelegation({ entryId, delegationInstanceId, signal });
        reconciledAny = true;
      }
      const currentEntry = await this.options.entries.getEntry(entryId);
      if (!currentEntry || this.options.authority.currentHostGrant(currentEntry) !== grant) {
        throw new Error("Execution delegation authority changed during reconciliation.");
      }
    } catch (error) {
      if (reconciledAny) this.options.requestConvergence(entryId);
      throw error;
    }
    this.options.requestConvergence(entryId);
  }
}
