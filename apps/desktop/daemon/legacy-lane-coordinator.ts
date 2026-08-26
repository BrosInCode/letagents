import { execFileSync } from "node:child_process";

import { sameProcessBirthIdentity } from "./process-identity.js";
import type { DaemonManifest, DaemonManifestEntry, LegacyLaneOwner } from "./types.js";

export type ReserveLegacyLaneInput = {
  reservation_id: string;
  room_id: string;
  provider: string;
  owner_pid: number;
  owner_process_identity: string;
};

export type ReleaseLegacyLaneInput = {
  reservation_id: string | null;
  session_id: string | null;
  room_id: string | null;
  provider: string | null;
};

export type LegacyLaneManifestStorage = {
  load(): Promise<DaemonManifest>;
};

export type LegacyLaneManifestCommit = {
  currentGeneration(): number;
  write(
    expectedGeneration: number,
    entries: DaemonManifestEntry[],
    owners: LegacyLaneOwner[],
  ): Promise<Pick<DaemonManifest, "generation">>;
  acceptGeneration(generation: number): void;
};

export type LegacyLaneMutationAuthority = {
  serialize<T>(operation: () => Promise<T>): Promise<T>;
  assertCurrent(): Promise<void>;
};

export type LegacyLaneProcessIdentity = {
  readBirthIdentity(pid: number): string;
  probe(pid: number): void;
  sameBirthIdentity(actualIdentity: string, expectedIdentity: string): boolean;
};

export type LegacyLaneCoordinatorOptions = {
  storage: LegacyLaneManifestStorage;
  commit: LegacyLaneManifestCommit;
  authority: LegacyLaneMutationAuthority;
  processIdentity?: LegacyLaneProcessIdentity;
  isSupervisedLaneOwner(entry: DaemonManifestEntry): boolean;
  now?: () => string;
};

const systemProcessIdentity: LegacyLaneProcessIdentity = {
  readBirthIdentity(pid) {
    return execFileSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  },
  probe(pid) {
    process.kill(pid, 0);
  },
  sameBirthIdentity: sameProcessBirthIdentity,
};

/** Durable ownership boundary between legacy Electron and supervised lanes. */
export class LegacyLaneCoordinator {
  private readonly storage: LegacyLaneManifestStorage;
  private readonly commit: LegacyLaneManifestCommit;
  private readonly authority: LegacyLaneMutationAuthority;
  private readonly processIdentity: LegacyLaneProcessIdentity;
  private readonly isSupervisedLaneOwner: (entry: DaemonManifestEntry) => boolean;
  private readonly now: () => string;

  constructor(options: LegacyLaneCoordinatorOptions) {
    this.storage = options.storage;
    this.commit = options.commit;
    this.authority = options.authority;
    this.processIdentity = options.processIdentity ?? systemProcessIdentity;
    this.isSupervisedLaneOwner = options.isSupervisedLaneOwner;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async reserve(input: ReserveLegacyLaneInput): Promise<LegacyLaneOwner> {
    for (const [field, value] of Object.entries({
      reservation_id: input.reservation_id,
      room_id: input.room_id,
      provider: input.provider,
    })) {
      if (!value.trim()) throw new Error(`Legacy lane ${field} is required.`);
    }
    if (!Number.isSafeInteger(input.owner_pid) || input.owner_pid < 1) {
      throw new Error("Legacy lane owner_pid is required.");
    }
    if (!input.owner_process_identity.trim()) {
      throw new Error("Legacy lane owner_process_identity is required.");
    }
    return this.authority.serialize(async () => {
      await this.authority.assertCurrent();
      const manifest = await this.storage.load();
      const legacyOwners = this.liveOwners(manifest.legacy_lane_owners ?? []);
      const duplicate = legacyOwners.find((candidate) => candidate.reservation_id === input.reservation_id);
      if (duplicate) {
        if (duplicate.room_id !== input.room_id || duplicate.provider !== input.provider) {
          throw new Error(`Legacy reservation '${input.reservation_id}' is already bound to another lane.`);
        }
        if (
          duplicate.owner_pid !== input.owner_pid
          || duplicate.owner_process_identity !== input.owner_process_identity
        ) {
          throw new Error(`Legacy reservation '${input.reservation_id}' belongs to another Electron process.`);
        }
        return duplicate;
      }
      const supervisedOwner = manifest.entries.find((candidate) =>
        candidate.room_id === input.room_id
        && candidate.provider === input.provider
        && this.isSupervisedLaneOwner(candidate));
      if (supervisedOwner) {
        throw new Error(
          `Provider lane '${input.room_id}/${input.provider}' is already owned by supervised entry '${supervisedOwner.id}'.`,
        );
      }
      const legacyOwner = legacyOwners.find((candidate) =>
        candidate.room_id === input.room_id && candidate.provider === input.provider);
      if (legacyOwner) {
        throw new Error(
          `Provider lane '${input.room_id}/${input.provider}' is already owned by legacy reservation '${legacyOwner.reservation_id}'.`,
        );
      }
      const now = this.now();
      const owner: LegacyLaneOwner = {
        ...input,
        state: "reserved",
        session_id: null,
        created_at: now,
        updated_at: now,
      };
      await this.writeOwners(manifest.entries, [...legacyOwners, owner]);
      return owner;
    });
  }

  liveOwners(owners: readonly LegacyLaneOwner[]): LegacyLaneOwner[] {
    return owners.filter((owner) =>
      owner.state === "active"
      || this.isProcessOwnerLive(owner.owner_pid, owner.owner_process_identity));
  }

  isProcessOwnerLive(pid: number, expectedIdentity: string): boolean {
    try {
      // Electron records the start-time-only identity. Compare its stable birth
      // prefix so command changes and ps column padding cannot prune a live
      // reservation before activation.
      const identity = this.processIdentity.readBirthIdentity(pid).trim();
      return Boolean(identity) && this.processIdentity.sameBirthIdentity(identity, expectedIdentity);
    } catch {
      try {
        this.processIdentity.probe(pid);
        // Unknown identity evidence fails closed by retaining the fence.
        return true;
      } catch (probeError) {
        return (probeError as NodeJS.ErrnoException).code === "EPERM";
      }
    }
  }

  async recoverOrphanedReservations(): Promise<void> {
    await this.authority.serialize(async () => {
      const manifest = await this.storage.load();
      const owners = manifest.legacy_lane_owners ?? [];
      const live = this.liveOwners(owners);
      if (live.length === owners.length) return;
      await this.writeOwners(manifest.entries, live);
    });
  }

  async activate(reservationId: string, sessionId: string): Promise<LegacyLaneOwner> {
    if (!reservationId.trim() || !sessionId.trim()) {
      throw new Error("Legacy reservation and session ids are required.");
    }
    return this.authority.serialize(async () => {
      await this.authority.assertCurrent();
      const manifest = await this.storage.load();
      const legacyOwners = this.liveOwners(manifest.legacy_lane_owners ?? []);
      const owner = legacyOwners.find((candidate) => candidate.reservation_id === reservationId);
      if (!owner) throw new Error(`Unknown legacy lane reservation: ${reservationId}`);
      if (owner.state === "active" && owner.session_id !== sessionId) {
        throw new Error(`Legacy reservation '${reservationId}' is already active for another session.`);
      }
      const updated: LegacyLaneOwner = {
        ...owner,
        state: "active",
        session_id: sessionId,
        updated_at: this.now(),
      };
      await this.writeOwners(
        manifest.entries,
        legacyOwners.map((candidate) => candidate.reservation_id === reservationId ? updated : candidate),
      );
      return updated;
    });
  }

  async release(input: ReleaseLegacyLaneInput): Promise<{ released: boolean }> {
    const reservationId = input.reservation_id?.trim() || null;
    const sessionId = input.session_id?.trim() || null;
    const roomId = input.room_id?.trim() || null;
    const provider = input.provider?.trim() || null;
    if (!reservationId && !sessionId && !(roomId && provider)) {
      throw new Error("Legacy reservation_id, session_id, or complete room/provider lane is required.");
    }
    return this.authority.serialize(async () => {
      await this.authority.assertCurrent();
      const manifest = await this.storage.load();
      const owners = manifest.legacy_lane_owners ?? [];
      const retained = owners.filter((candidate) => !(
        (reservationId && candidate.reservation_id === reservationId)
        || (sessionId && candidate.session_id === sessionId)
        || (roomId && provider && candidate.room_id === roomId && candidate.provider === provider)
      ));
      if (retained.length === owners.length) return { released: false };
      await this.writeOwners(manifest.entries, retained);
      return { released: true };
    });
  }

  private async writeOwners(entries: DaemonManifestEntry[], owners: LegacyLaneOwner[]): Promise<void> {
    const next = await this.commit.write(this.commit.currentGeneration(), entries, owners);
    this.commit.acceptGeneration(next.generation);
  }
}
