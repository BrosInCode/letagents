/**
 * Runs every step of a stop in order, whatever an earlier step reports, and
 * then reports the first failure. A daemon's stop is made of these steps so
 * that a drain that fails cannot leave the socket, the lock or the stores
 * open: an open socket keeps the process alive.
 *
 * A step that returns a promise is waited for. Any other step is followed by
 * the next one at once, so the steps that fence together still do so before
 * the first wait.
 */
export async function runEveryStopStep(steps: ReadonlyArray<() => unknown>): Promise<void> {
  let failure: { error: unknown } | undefined;
  for (const step of steps) {
    try {
      const outcome = step();
      if (typeof (outcome as { then?: unknown } | null | undefined)?.then === "function") await outcome;
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}
