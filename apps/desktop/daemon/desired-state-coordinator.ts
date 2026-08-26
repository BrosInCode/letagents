import type { EntryConcurrencyGate } from "./entry-concurrency-gate.js";
import type { LegacyLaneCoordinator } from "./legacy-lane-coordinator.js";
import type { ManifestAdministrationCoordinator } from "./manifest-administration-coordinator.js";
import type { ManifestStore } from "./manifest-store.js";
import type { SupervisedAgentDelivery } from "./supervised-agent-delivery.js";
import type { DaemonManifestEntry, DesiredState, LegacyLaneOwner } from "./types.js";

type DesiredStateAuthority = {
  currentManifestGeneration: () => number;
  acceptManifestGeneration: (generation: number) => void;
  assertCurrent: () => Promise<void>;
  serializeManifest: <T>(operation: () => Promise<T>) => Promise<T>;
  fenceCommit: (commit: () => Promise<void>) => Promise<void>;
};

export type DesiredStateCoordinatorOptions = {
  store: ManifestStore;
  entryConcurrency: EntryConcurrencyGate;
  legacyLanes: LegacyLaneCoordinator;
  manifestAdministration: ManifestAdministrationCoordinator;
  delivery: SupervisedAgentDelivery | null;
  authority: DesiredStateAuthority;
  waitForActiveRoomMove: (entryId: string) => Promise<void>;
  clearRecovery: (entryId: string) => void;
  restartDeliveryOrConverge: (entryId: string) => Promise<void>;
  requestConvergence: (entryId: string) => void;
};

/** Owns Pause, Resume, and Stop desired-state mutations and their lane fences. */
export class DesiredStateCoordinator {
  private readonly store: ManifestStore;
  private readonly entryConcurrency: EntryConcurrencyGate;
  private readonly legacyLanes: LegacyLaneCoordinator;
  private readonly manifestAdministration: ManifestAdministrationCoordinator;
  private readonly delivery: SupervisedAgentDelivery | null;
  private readonly authority: DesiredStateAuthority;
  private readonly waitForActiveRoomMove: DesiredStateCoordinatorOptions["waitForActiveRoomMove"];
  private readonly clearRecovery: DesiredStateCoordinatorOptions["clearRecovery"];
  private readonly restartDeliveryOrConverge: DesiredStateCoordinatorOptions["restartDeliveryOrConverge"];
  private readonly requestConvergence: DesiredStateCoordinatorOptions["requestConvergence"];

  constructor(options: DesiredStateCoordinatorOptions) {
    this.store = options.store;
    this.entryConcurrency = options.entryConcurrency;
    this.legacyLanes = options.legacyLanes;
    this.manifestAdministration = options.manifestAdministration;
    this.delivery = options.delivery;
    this.authority = options.authority;
    this.waitForActiveRoomMove = options.waitForActiveRoomMove;
    this.clearRecovery = options.clearRecovery;
    this.restartDeliveryOrConverge = options.restartDeliveryOrConverge;
    this.requestConvergence = options.requestConvergence;
  }

  async set(id: string, desiredState: DesiredState): Promise<DaemonManifestEntry> {
    const release = this.entryConcurrency.beginLifecycle(id);
    try {
      return await this.setExclusive(id, desiredState);
    } finally {
      release();
    }
  }

  async setExclusive(id: string, desiredState: DesiredState): Promise<DaemonManifestEntry> {
    validateDesiredStateInput(id, desiredState);
    this.entryConcurrency.bumpControlEpoch(id);
    const deliveryStopped = desiredState !== "running" && Boolean(this.delivery);
    if (deliveryStopped) {
      try {
        // Wait only for a room-move transition already active when lifecycle
        // exclusion began. Provider launch work remains synchronously fenced.
        await this.waitForActiveRoomMove(id);
        this.clearRecovery(id);
        await this.delivery!.stop(id);
      } catch (error) {
        await this.restartDeliveryOrConverge(id);
        throw error;
      }
    }
    let updated: DaemonManifestEntry;
    try {
      updated = await this.authority.serializeManifest(async () => {
        await this.authority.assertCurrent();
        const manifest = await this.store.load();
        const legacyOwners = this.legacyLanes.liveOwners(manifest.legacy_lane_owners ?? []);
        const entry = manifest.entries.find((candidate) => candidate.id === id);
        if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
        this.assertLaneAvailable(manifest.entries, legacyOwners, entry, desiredState);
        const nextEntry = { ...entry, desired_state: desiredState };
        const next = await this.store.write(
          this.authority.currentManifestGeneration(),
          manifest.entries.map((candidate) => candidate.id === id ? nextEntry : candidate),
          legacyOwners,
          (commit) => this.authority.fenceCommit(commit),
          desiredState === "running" ? undefined : {
            agentId: id,
            detail: `Room move cancelled because the agent lifecycle changed to ${desiredState} before destination membership was joined.`,
          },
        );
        this.authority.acceptManifestGeneration(next.generation);
        return nextEntry;
      });
    } catch (error) {
      if (deliveryStopped) await this.restartDeliveryOrConverge(id);
      throw error;
    }
    this.requestConvergence(id);
    return updated;
  }

  async compareAndSet(
    id: string,
    expectedDesiredState: DesiredState,
    desiredState: DesiredState,
  ): Promise<{ applied: boolean; entry: DaemonManifestEntry }> {
    const release = this.entryConcurrency.beginLifecycle(id);
    try {
      return await this.compareAndSetExclusive(id, expectedDesiredState, desiredState);
    } finally {
      release();
    }
  }

  private async compareAndSetExclusive(
    id: string,
    expectedDesiredState: DesiredState,
    desiredState: DesiredState,
  ): Promise<{ applied: boolean; entry: DaemonManifestEntry }> {
    validateDesiredStateInput(id, expectedDesiredState, "expected desired state");
    validateDesiredStateInput(id, desiredState);
    const preflight = await this.store.getEntry(id);
    if (!preflight) throw new Error(`Unknown daemon manifest entry: ${id}`);
    if (preflight.desired_state !== expectedDesiredState) return { applied: false, entry: preflight };
    this.entryConcurrency.bumpControlEpoch(id);
    const deliveryStopped = desiredState !== "running" && Boolean(this.delivery);
    if (deliveryStopped) {
      try {
        await this.waitForActiveRoomMove(id);
        this.clearRecovery(id);
        await this.delivery!.stop(id);
      } catch (error) {
        await this.restartDeliveryOrConverge(id);
        throw error;
      }
    }
    let result: { applied: boolean; entry: DaemonManifestEntry };
    try {
      result = await this.authority.serializeManifest(async () => {
        await this.authority.assertCurrent();
        const manifest = await this.store.load();
        const legacyOwners = this.legacyLanes.liveOwners(manifest.legacy_lane_owners ?? []);
        const entry = manifest.entries.find((candidate) => candidate.id === id);
        if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
        if (entry.desired_state !== expectedDesiredState) return { applied: false, entry };
        this.assertLaneAvailable(manifest.entries, legacyOwners, entry, desiredState);
        const nextEntry = { ...entry, desired_state: desiredState };
        const next = await this.store.write(
          this.authority.currentManifestGeneration(),
          manifest.entries.map((candidate) => candidate.id === id ? nextEntry : candidate),
          legacyOwners,
          (commit) => this.authority.fenceCommit(commit),
          desiredState === "running" ? undefined : {
            agentId: id,
            detail: `Room move cancelled because the agent lifecycle changed to ${desiredState} before destination membership was joined.`,
          },
        );
        this.authority.acceptManifestGeneration(next.generation);
        return { applied: true, entry: nextEntry };
      });
    } catch (error) {
      if (deliveryStopped) await this.restartDeliveryOrConverge(id);
      throw error;
    }
    if (!result.applied && deliveryStopped) await this.restartDeliveryOrConverge(id);
    // A speculative epoch bump may have fenced an in-flight launch even when
    // the CAS lost. Reconcile both the changed and unchanged durable state.
    this.requestConvergence(id);
    return result;
  }

  private assertLaneAvailable(
    entries: readonly DaemonManifestEntry[],
    legacyOwners: readonly LegacyLaneOwner[],
    entry: DaemonManifestEntry,
    desiredState: DesiredState,
  ): void {
    if (desiredState === "stopped") return;
    const supervisedOwner = this.manifestAdministration.competingSupervisedLaneOwner(entries, entry);
    if (supervisedOwner) {
      throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by supervised entry '${supervisedOwner.id}'.`);
    }
    const legacyOwner = legacyOwners.find((candidate) =>
      candidate.room_id === entry.room_id && candidate.provider === entry.provider);
    if (legacyOwner && desiredState === "running") {
      throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by legacy reservation '${legacyOwner.reservation_id}'.`);
    }
  }
}

function validateDesiredStateInput(
  id: string,
  desiredState: DesiredState,
  label = "desired state",
): void {
  if (!id) throw new Error("Manifest entry id is required.");
  if (!["running", "paused", "stopped"].includes(desiredState)) {
    throw new Error(`Invalid ${label}.`);
  }
}
