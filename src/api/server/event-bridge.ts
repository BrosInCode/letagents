import {
  beginStopBridgeListener,
  finishStopBridgeListener,
  startBridgeListener,
} from "./event-bridge/listener.js";
import {
  beginStopBridgePublisher,
  finishStopBridgePublisher,
  startBridgePublisher,
} from "./event-bridge/publisher.js";

export {
  BridgedEventEmitter,
  createBridgedEmitter,
  roomEventBridgeLossEvents,
} from "./bridged-emitter.js";
export { buildBridgeEnvelope } from "./event-bridge/envelope-codec.js";
export type { BridgeEnvelope } from "./event-bridge/envelope-codec.js";
export {
  dispatchBridgeNotification,
  setRoomEventBridgeInterestPredicate,
} from "./event-bridge/notification-dispatch.js";
export {
  createOrderedBridgeNotificationReceiver,
} from "./event-bridge/ordered-notification-receiver.js";
export type {
  OrderedBridgeNotificationReceiver,
} from "./event-bridge/ordered-notification-receiver.js";
export { roomEventBridgeLifecycleEvents } from "./event-bridge/loss-signals.js";
export { executeBridgePublish } from "./event-bridge/publisher.js";

// Fans room events out across API instances. Local subscribers are served by
// the in-process emitters; when the bridge is started (server entry point
// only), every emit on a bridged emitter is also relayed over Postgres NOTIFY
// so pollers and SSE streams connected to *other* instances wake up too.
//
// Events that fit are inlined into the NOTIFY payload (hard 8000-byte limit);
// oversize events fall back to a compact reference that receivers rehydrate
// from the database. Lanes without a reference form log and drop oversize
// events instead of relaying them truncated.
export function startRoomEventBridge(): void {
  if (!startBridgePublisher()) {
    return;
  }
  startBridgeListener();
}

export async function stopRoomEventBridge(): Promise<void> {
  beginStopBridgePublisher();
  beginStopBridgeListener();
  await finishStopBridgePublisher();
  await finishStopBridgeListener();
}
