import { DaemonFenceLostError } from "./singleton.js";

export type DaemonAuthorityDependencies = {
  assertCurrent: () => Promise<void>;
  isHandoffScheduled: () => boolean;
  notifyStateChanged: () => void;
};

/**
 * Owns the daemon's manifest generation and its two deliberately independent
 * serialization lanes. Durable stores remain outside this authority boundary;
 * callers supply only the exact commit closure reserved by a store.
 */
export class DaemonAuthority {
  private manifestGeneration: number;
  private manifestMutation: Promise<void> = Promise.resolve();
  private manifestCommit: Promise<void> = Promise.resolve();

  constructor(
    private readonly dependencies: DaemonAuthorityDependencies,
    initialGeneration = 0,
  ) {
    this.manifestGeneration = initialGeneration;
  }

  get generation(): number {
    return this.manifestGeneration;
  }

  set generation(generation: number) {
    this.manifestGeneration = generation;
  }

  async serializeManifestMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.manifestMutation;
    let release!: () => void;
    this.manifestMutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.dependencies.assertCurrent();
      return await operation();
    } finally {
      release();
    }
  }

  serializeManifestCommit<T>(operation: () => Promise<T>): Promise<T> {
    return this.runSerializedManifestCommit(operation);
  }

  fenceDaemonCommit(commit: () => Promise<void>): Promise<void> {
    return this.runSerializedManifestCommit(async () => {
      if (this.dependencies.isHandoffScheduled()) {
        throw new DaemonFenceLostError("Supervisor handoff fenced a stale daemon-owned commit.");
      }
      await this.dependencies.assertCurrent();
      // assertCurrent performs asynchronous filesystem I/O. Handoff may set
      // the public revocation flag during that await while this process still
      // owns the on-disk generation, so validate both sides of the boundary.
      if (this.dependencies.isHandoffScheduled()) {
        throw new DaemonFenceLostError("Supervisor handoff fenced a stale daemon-owned commit.");
      }
      await commit();
      this.dependencies.notifyStateChanged();
    });
  }

  /**
   * Finish only an exact transition already admitted by this generation.
   * Handoff fences new work but must allow admitted state to become honest.
   */
  fenceAdmittedTransitionCommit(commit: () => Promise<void>): Promise<void> {
    return this.runSerializedManifestCommit(async () => {
      await this.dependencies.assertCurrent();
      await commit();
      await this.dependencies.assertCurrent();
      this.dependencies.notifyStateChanged();
    });
  }

  private async runSerializedManifestCommit<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.manifestCommit;
    let release!: () => void;
    this.manifestCommit = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
