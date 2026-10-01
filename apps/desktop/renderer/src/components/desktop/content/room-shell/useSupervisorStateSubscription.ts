import type { DesktopSupervisorStateSnapshot } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc";

export interface SupervisorStateSubscriptionOptions {
  roomIdentifier: () => string;
  /** Applies one snapshot; called at most once per animation frame. */
  accept: (snapshot: DesktopSupervisorStateSnapshot) => void;
}

/**
 * The room's push subscription to supervisor state. Snapshots are coalesced
 * to the newest (daemon generation, sequence) and applied once per animation
 * frame; a snapshot from a previous room or subscription is never applied.
 */
export function useSupervisorStateSubscription(options: SupervisorStateSubscriptionOptions) {
  let mounted = false;
  let epoch = 0;
  let unsubscribe: (() => void) | null = null;
  let active = false;
  let lastSnapshotAtMs: number | null = null;
  let pendingSnapshot: DesktopSupervisorStateSnapshot | null = null;
  let frame: number | null = null;

  function stop(): void {
    epoch += 1;
    unsubscribe?.();
    unsubscribe = null;
    active = false;
    lastSnapshotAtMs = null;
    pendingSnapshot = null;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
  }

  function sync(): void {
    stop();
    if (!mounted) return;
    const roomIdentifier = options.roomIdentifier();
    const subscription = epoch;
    unsubscribe = desktopIpc.supervisor?.onState?.((snapshot) => {
      if (subscription !== epoch || options.roomIdentifier() !== roomIdentifier) return;
      lastSnapshotAtMs = Date.now();
      queue(snapshot);
    }, roomIdentifier) || null;
    active = Boolean(unsubscribe);
  }

  function queue(snapshot: DesktopSupervisorStateSnapshot): void {
    const pending = pendingSnapshot;
    if (
      pending
      && (
        snapshot.daemonGeneration < pending.daemonGeneration
        || (
          snapshot.daemonGeneration === pending.daemonGeneration
          && snapshot.sequence < pending.sequence
        )
      )
    ) return;
    pendingSnapshot = snapshot;
    if (frame !== null) return;
    const scheduled = epoch;
    frame = window.requestAnimationFrame(() => {
      if (scheduled !== epoch) return;
      frame = null;
      const next = pendingSnapshot;
      pendingSnapshot = null;
      if (next) options.accept(next);
    });
  }

  return {
    /** Resubscribe for the current room (a no-op until mounted). */
    sync,
    mount(): void { mounted = true; sync(); },
    unmount(): void { mounted = false; stop(); },
    /** Read-only: the stale-subscription repair reads active and lastSnapshotAtMs; tests read the queue. */
    state: () => ({ active, lastSnapshotAtMs, pending: pendingSnapshot, frame }),
  };
}
