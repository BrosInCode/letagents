import { EventEmitter } from "events";

import { roomEventBridgeLossEvents } from "../bridged-emitter.js";

let lossEpoch = 0;

/** Lifecycle signal used by health checks and the real-Postgres bridge test. */
export const roomEventBridgeLifecycleEvents = new EventEmitter();

export function reportBridgeLoss(reason: string, roomId?: string | null): number {
  const epoch = ++lossEpoch;
  roomEventBridgeLossEvents.emit("loss", {
    epoch,
    reason,
    roomId: roomId ?? null,
  });
  return epoch;
}
