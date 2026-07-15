export interface SupervisorOwnershipTransfer<TManifest, TLegacy> {
  claim(): Promise<TManifest>;
  listLegacy(): readonly TLegacy[];
  stopLegacy(owner: TLegacy): Promise<void>;
  activate(manifest: TManifest): Promise<TManifest>;
  rollback(manifest: TManifest): Promise<void>;
}

export interface SupervisorLaneOwnerSummary {
  displayName: string;
  provider: string;
  observedState: string;
  condition: string;
  lastError?: string | null;
}

/**
 * Explain a durable lane conflict without implying that a blocked manifest is
 * a healthy duplicate. The existing entry remains the fail-closed owner until
 * the user inspects and stops it, so a live or ambiguous writer is never
 * silently unfenced just to make the Start button succeed.
 */
export function describeSupervisorLaneConflict(owner: SupervisorLaneOwnerSummary): string {
  const inspect = "Open the existing agent in Inspector and choose Stop before creating a replacement.";
  if (owner.observedState === "failed" || owner.condition !== "none") {
    const cause = owner.lastError ? ` Cause: ${owner.lastError}.` : "";
    return `${owner.displayName} already reserved this room's supervised ${owner.provider} lane, but startup is ${owner.observedState} (${owner.condition}).${cause} ${inspect}`;
  }
  return `${owner.displayName} already owns this room's supervised ${owner.provider} lane. Use that agent, or stop it before creating a replacement.`;
}

/**
 * Transfer one provider lane with a durable claim as the linearization point.
 * A new legacy start sees the claim before teardown begins; activation happens
 * only after every previous owner is gone. Any failed teardown releases the
 * claim so the lane never remains half-transferred.
 */
export async function transferSupervisorOwnership<TManifest, TLegacy>(
  transfer: SupervisorOwnershipTransfer<TManifest, TLegacy>,
): Promise<TManifest> {
  const manifest = await transfer.claim();
  try {
    for (const owner of transfer.listLegacy()) await transfer.stopLegacy(owner);
    return await transfer.activate(manifest);
  } catch (error) {
    await transfer.rollback(manifest).catch(() => undefined);
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
    await launch.release().catch(() => undefined);
    throw error;
  }
}
