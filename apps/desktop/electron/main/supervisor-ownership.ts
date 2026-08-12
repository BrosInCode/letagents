export interface SupervisorOwnershipTransfer<TManifest, TLegacy> {
  claim(): Promise<TManifest>;
  listLegacy(): readonly TLegacy[];
  stopLegacy(owner: TLegacy): Promise<void>;
  activate(manifest: TManifest): Promise<TManifest>;
  rollback(manifest: TManifest): Promise<void>;
}

/**
 * Transfer one supervised entry with its durable claim as the linearization
 * point. A new legacy start sees every non-stopped supervised claim before
 * teardown begins; activation happens only after the legacy provider engine is
 * gone. Other supervised entries remain independent.
 */
export async function transferSupervisorOwnership<TManifest, TLegacy>(
  transfer: SupervisorOwnershipTransfer<TManifest, TLegacy>,
): Promise<TManifest> {
  const manifest = await transfer.claim();
  try {
    for (const owner of transfer.listLegacy()) await transfer.stopLegacy(owner);
    return await transfer.activate(manifest);
  } catch (error) {
    try {
      await transfer.rollback(manifest);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Supervisor ownership transfer failed and its durable claim could not be rolled back.",
      );
    }
    throw error;
  }
}

export interface LegacyOwnershipLaunch<TStarted> {
  reserve(): Promise<void>;
  start(): Promise<TStarted>;
  activate(started: TStarted): Promise<void>;
  stop(started: TStarted): Promise<void>;
  release(): Promise<void>;
}

/**
 * Hold the daemon lane reservation across the entire legacy spawn. Activation
 * binds the durable fence to the new session; only a confirmed stop may
 * release a post-spawn reservation.
 */
export async function launchLegacyWithOwnership<TStarted>(
  launch: LegacyOwnershipLaunch<TStarted>,
): Promise<TStarted> {
  await launch.reserve();
  let started: TStarted | null = null;
  try {
    started = await launch.start();
    await launch.activate(started);
    return started;
  } catch (error) {
    if (started !== null) {
      try {
        await launch.stop(started);
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          "Legacy launch failed after spawn and cleanup could not stop it; its daemon ownership fence remains held.",
        );
      }
    }
    try {
      await launch.release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        started === null
          ? "Legacy launch failed before spawn and its daemon ownership reservation could not be released."
          : "Legacy launch failed after spawn cleanup and its daemon ownership reservation could not be released.",
      );
    }
    throw error;
  }
}
