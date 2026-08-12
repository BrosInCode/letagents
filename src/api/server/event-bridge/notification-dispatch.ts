import { createBoundedExecutor } from "../../bounded-async.js";
import { getBridgedEmitter } from "../bridged-emitter.js";
import {
  asRecord,
  instanceId,
  hasMalformedRoomId,
  type ParsedBridgeEnvelope,
  REF_HYDRATORS,
  roomIdField,
  roomIdFromBridgeValue,
  roomIdFromParsedEnvelope,
} from "./envelope-codec.js";
import { reportBridgeLoss } from "./loss-signals.js";

let roomInterestPredicate: ((roomId: string) => boolean) | null = null;
const observedRemoteLosses = new Map<string, number>();
const MAX_OBSERVED_REMOTE_LOSSES = 4_096;

export function setRoomEventBridgeInterestPredicate(
  predicate: ((roomId: string) => boolean) | null,
): void {
  roomInterestPredicate = predicate;
}

function applyRemoteBridgeLoss(origin: string, roomId: string | null, epoch: number): void {
  const key = `${origin}\n${roomId ?? "*"}`;
  const observedEpoch = observedRemoteLosses.get(key) ?? 0;
  if (epoch <= observedEpoch) return;
  observedRemoteLosses.delete(key);
  observedRemoteLosses.set(key, epoch);
  while (observedRemoteLosses.size > MAX_OBSERVED_REMOTE_LOSSES) {
    const oldest = observedRemoteLosses.keys().next().value as string | undefined;
    if (!oldest) break;
    observedRemoteLosses.delete(oldest);
  }
  reportBridgeLoss("remote_publish_loss", roomId);
}

export async function dispatchBridgeNotification(
  envelope: ParsedBridgeEnvelope,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent()) return;
  if (envelope.origin === instanceId) {
    return;
  }
  if (
    envelope.v !== 1
    || typeof envelope.origin !== "string"
  ) {
    reportBridgeLoss("malformed_notification_envelope");
    return;
  }
  if (envelope.mode === "loss") {
    if (!Array.isArray(envelope.losses) || envelope.losses.length === 0) {
      reportBridgeLoss("malformed_loss_marker");
      return;
    }
    for (const value of envelope.losses) {
      const marker = asRecord(value);
      const roomId = marker?.room_id === null
        ? null
        : roomIdField(marker, "room_id");
      const epoch = marker?.epoch;
      if ((marker?.room_id !== null && !roomId) || !Number.isSafeInteger(epoch) || (epoch as number) <= 0) {
        reportBridgeLoss("malformed_loss_marker");
        return;
      }
      applyRemoteBridgeLoss(envelope.origin, roomId, epoch as number);
    }
    return;
  }
  if (typeof envelope.lane !== "string" || typeof envelope.event !== "string") {
    reportBridgeLoss("malformed_notification_envelope");
    return;
  }
  const emitter = getBridgedEmitter(envelope.lane);
  if (!emitter) {
    reportBridgeLoss("unknown_notification_lane", roomIdFromParsedEnvelope(envelope));
    return;
  }
  if (envelope.mode === "inline") {
    if (hasMalformedRoomId(envelope.data)) {
      reportBridgeLoss("malformed_notification_room");
      return;
    }
    if (!isCurrent()) return;
    try {
      if (!emitter.emitLocal(envelope.event, envelope.data)) {
        reportBridgeLoss("unknown_notification_event", roomIdFromBridgeValue(envelope.data));
      }
    } catch (error) {
      console.error("[room event bridge] inline consumer failed", error);
      reportBridgeLoss("inline_dispatch_failed", roomIdFromBridgeValue(envelope.data));
    }
    return;
  }
  if (envelope.mode !== "ref") {
    reportBridgeLoss("unknown_notification_mode");
    return;
  }
  const ref = asRecord(envelope.ref);
  if (!ref) {
    reportBridgeLoss("malformed_reference");
    return;
  }
  if (hasMalformedRoomId(ref)) {
    reportBridgeLoss("malformed_reference_room");
    return;
  }
  const hydrator = REF_HYDRATORS[`${envelope.lane}:${envelope.event}`];
  if (!hydrator) {
    reportBridgeLoss("missing_reference_hydrator", roomIdFromBridgeValue(ref));
    return;
  }
  const referenceRoomId = roomIdFromBridgeValue(ref);
  if (referenceRoomId && roomInterestPredicate && !roomInterestPredicate(referenceRoomId)) {
    // Avoid one DB hydration per uninterested API pod. Retain a local gap so a
    // subscriber racing this check repairs authoritatively instead of assuming
    // the skipped reference is replayable.
    reportBridgeLoss("uninterested_reference", referenceRoomId);
    return;
  }
  let data: unknown | null;
  try {
    data = await runBridgeHydration(() => hydrator(ref));
  } catch (error) {
    console.error("[room event bridge] reference hydration failed", error);
    reportBridgeLoss("reference_hydration_failed", referenceRoomId);
    return;
  }
  if (data === null) {
    reportBridgeLoss("reference_disappeared", referenceRoomId);
    return;
  }
  if (!isCurrent()) return;
  try {
    if (!emitter.emitLocal(envelope.event, data)) {
      reportBridgeLoss("unknown_notification_event", roomIdFromBridgeValue(data));
    }
  } catch (error) {
    console.error("[room event bridge] reference consumer failed", error);
    reportBridgeLoss("reference_dispatch_failed", referenceRoomId);
  }
}

const runBridgeHydration = createBoundedExecutor({
  label: "room event bridge hydration",
  maxConcurrent: 16,
  maxQueued: 128,
  timeoutMs: 10_000,
});
