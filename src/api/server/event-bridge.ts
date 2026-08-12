import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import type { PoolClient } from "pg";

import {
  getMessageById,
  getMessageRecipientAgentTargets,
  getReasoningSessionById,
  getRoomSharedArtifactByIdentityKey,
  getTaskById,
} from "../db.js";
import { createBoundedExecutor } from "../bounded-async.js";
import { pool } from "../db/client.js";
import { formatMessageId, parseScopedId } from "../db/utils.js";
import { attachTaskDetails } from "../routes/rooms/tasks/task-details.js";
import { isPromptOnlyAgentMessage } from "../../shared/room-agent-prompts.js";
import {
  BridgedEventEmitter,
  createBridgedEmitter,
  getBridgedEmitter,
  roomEventBridgeLossEvents,
  setBridgedEventPublisher,
} from "./bridged-emitter.js";

export {
  BridgedEventEmitter,
  createBridgedEmitter,
  roomEventBridgeLossEvents,
} from "./bridged-emitter.js";

// Fans room events out across API instances. Local subscribers are served by
// the in-process emitters; when the bridge is started (server entry point
// only), every emit on a bridged emitter is also relayed over Postgres NOTIFY
// so pollers and SSE streams connected to *other* instances wake up too.
//
// Events that fit are inlined into the NOTIFY payload (hard 8000-byte limit);
// oversize events fall back to a compact reference that receivers rehydrate
// from the database. Lanes without a reference form log and drop oversize
// events instead of relaying them truncated.
const ROOM_EVENT_CHANNEL = "letagents_room_events";
const LISTEN_RECONNECT_DELAY_MS = 5_000;
// Leaves headroom under the 8000-byte NOTIFY limit for the envelope fields.
const MAX_INLINE_DATA_BYTES = 7_000;
const MAX_NOTIFICATION_ORIGINS = 1_024;
const MAX_QUEUED_NOTIFICATIONS_PER_ORIGIN = 128;
const MAX_OUTSTANDING_NOTIFICATIONS = 1_024;
const NOTIFICATION_QUEUE_DEADLINE_MS = 10_000;
const BRIDGE_PUBLISH_STATEMENT_TIMEOUT_MS = 5_000;
const BRIDGE_CLIENT_ACQUIRE_TIMEOUT_MS = 2_000;
const MAX_BRIDGE_ROOM_ID_BYTES = 1_024;

const instanceId = randomUUID();
let lossEpoch = 0;
let roomInterestPredicate: ((roomId: string) => boolean) | null = null;

export function setRoomEventBridgeInterestPredicate(
  predicate: ((roomId: string) => boolean) | null,
): void {
  roomInterestPredicate = predicate;
}

/** Lifecycle signal used by health checks and the real-Postgres bridge test. */
export const roomEventBridgeLifecycleEvents = new EventEmitter();

function reportBridgeLoss(reason: string, roomId?: string | null): void {
  roomEventBridgeLossEvents.emit("loss", {
    epoch: ++lossEpoch,
    reason,
    roomId: roomId ?? null,
  });
}

function reportPublisherBridgeLoss(reason: string, roomId?: string | null): void {
  reportBridgeLoss(reason, roomId);
  queuePendingBridgeLoss(roomId ?? null, lossEpoch);
}

function roomIdFromBridgeValue(value: unknown): string | null {
  return roomIdField(asRecord(value), "projectId")
    ?? roomIdField(asRecord(value), "room_id")
    ?? roomIdField(asRecord(asRecord(value)?.activity), "room_id");
}

interface InlineBridgeEnvelope {
  v: 1;
  lane: string;
  event: string;
  mode: "inline";
  data: unknown;
  origin: string;
}

interface RefBridgeEnvelope {
  v: 1;
  lane: string;
  event: string;
  mode: "ref";
  ref: Record<string, unknown>;
  origin: string;
}

interface BridgeLossMarker {
  room_id: string | null;
  epoch: number;
}

interface LossBridgeEnvelope {
  v: 1;
  mode: "loss";
  losses: BridgeLossMarker[];
  origin: string;
}

export type BridgeEnvelope = InlineBridgeEnvelope | RefBridgeEnvelope | LossBridgeEnvelope;

interface ParsedBridgeEnvelope {
  v?: unknown;
  lane?: unknown;
  event?: unknown;
  mode?: unknown;
  data?: unknown;
  ref?: unknown;
  losses?: unknown;
  origin?: unknown;
}

interface OrderedNotificationWork {
  origin: string;
  roomId: string | null;
  queuedAt: number;
  generation: number;
  previousOrigin: Promise<void>;
  previousGlobalBarrier: Promise<void>;
  completion: Promise<void>;
  resolveCompletion: () => void;
  run: (isCurrent: () => boolean) => Promise<void>;
}

interface OrderedNotificationLane {
  queue: OrderedNotificationWork[];
  running: boolean;
}

export interface OrderedBridgeNotificationReceiver {
  enqueue(input: {
    origin: string;
    roomId: string | null;
    run: (isCurrent: () => boolean) => Promise<void>;
  }): boolean;
  close(): void;
}

/**
 * PostgreSQL preserves notification order on one LISTEN connection, but an
 * async notification callback does not. Data work is ordered per room across
 * publishers, so a slow reference from one pod cannot arrive after a later
 * inline event from another pod. Room-less/global loss work is a listener-wide
 * barrier: it follows all earlier notifications and precedes all later ones.
 */
export function createOrderedBridgeNotificationReceiver(options: {
  onLoss: (reason: string, roomId: string | null) => void;
  maxOrigins?: number;
  maxQueuedPerOrigin?: number;
  maxOutstanding?: number;
  deadlineMs?: number;
  now?: () => number;
}): OrderedBridgeNotificationReceiver {
  const maxOrigins = Math.max(1, options.maxOrigins ?? MAX_NOTIFICATION_ORIGINS);
  const maxQueuedPerOrigin = Math.max(
    1,
    options.maxQueuedPerOrigin ?? MAX_QUEUED_NOTIFICATIONS_PER_ORIGIN,
  );
  const deadlineMs = Math.max(1, options.deadlineMs ?? NOTIFICATION_QUEUE_DEADLINE_MS);
  const maxOutstanding = Math.max(1, options.maxOutstanding ?? MAX_OUTSTANDING_NOTIFICATIONS);
  const now = options.now ?? Date.now;
  const lanes = new Map<string, OrderedNotificationLane>();
  const originTails = new Map<string, Promise<void>>();
  let globalBarrierTail: Promise<void> = Promise.resolve();
  let closed = false;
  let generation = 0;
  let outstanding = 0;

  const drain = async (laneKey: string, lane: OrderedNotificationLane) => {
    if (lane.running) return;
    lane.running = true;
    try {
      while (!closed) {
        const work = lane.queue.shift();
        if (!work) return;
        try {
          if (now() - work.queuedAt >= deadlineMs) {
            options.onLoss("notification_queue_deadline", work.roomId);
            continue;
          }
          // Compose PostgreSQL's per-publisher order, per-room order, and the
          // most recent listener-wide global loss barrier.
          await Promise.all([work.previousOrigin, work.previousGlobalBarrier]);
          if (now() - work.queuedAt >= deadlineMs) {
            options.onLoss("notification_queue_deadline", work.roomId);
            continue;
          }
          const isCurrent = () => !closed && work.generation === generation;
          try {
            await work.run(isCurrent);
            if (!isCurrent()) {
              options.onLoss("notification_receiver_retired", work.roomId);
            }
          } catch (error) {
            console.error("[room event bridge] failed to handle notification", error);
            options.onLoss("notification_handler_failed", work.roomId);
          }
        } finally {
          work.resolveCompletion();
          if (originTails.get(work.origin) === work.completion) {
            originTails.delete(work.origin);
          }
          outstanding = Math.max(0, outstanding - 1);
        }
      }
    } finally {
      lane.running = false;
      if (lanes.get(laneKey) === lane) {
        if (lane.queue.length === 0 || closed) lanes.delete(laneKey);
        else void drain(laneKey, lane);
      }
    }
  };

  return {
    enqueue({ origin, roomId, run }) {
      if (closed) {
        options.onLoss("notification_receiver_closed", roomId);
        return false;
      }
      if (outstanding >= maxOutstanding) {
        options.onLoss("notification_total_overflow", roomId);
        return false;
      }
      const laneKey = roomId ? `room:${roomId}` : `origin:${origin}`;
      let lane = lanes.get(laneKey);
      if (!lane) {
        if (lanes.size >= maxOrigins) {
          options.onLoss("notification_origin_overflow", roomId);
          return false;
        }
        lane = { queue: [], running: false };
        lanes.set(laneKey, lane);
      }
      if (lane.queue.length >= maxQueuedPerOrigin) {
        options.onLoss("notification_queue_overflow", roomId);
        return false;
      }
      const previousOrigin = originTails.get(origin) ?? Promise.resolve();
      // A room-less loss is a receiver-wide boundary: it waits for every
      // notification observed before it, and every notification observed
      // after it waits for the boundary. Ordinary room events retain parallel
      // per-room execution between global boundaries.
      const previousGlobalBarrier = roomId === null
        ? Promise.all([globalBarrierTail, ...originTails.values()]).then(() => undefined)
        : globalBarrierTail;
      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
      originTails.set(origin, completion);
      if (roomId === null) globalBarrierTail = completion;
      lane.queue.push({
        origin,
        roomId,
        queuedAt: now(),
        generation,
        previousOrigin,
        previousGlobalBarrier,
        completion,
        resolveCompletion,
        run,
      });
      outstanding += 1;
      void drain(laneKey, lane);
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      generation += 1;
      const lostRooms = new Set<string | null>();
      for (const lane of lanes.values()) {
        for (const work of lane.queue) {
          lostRooms.add(work.roomId);
          work.resolveCompletion();
        }
        outstanding = Math.max(0, outstanding - lane.queue.length);
        lane.queue.length = 0;
      }
      lanes.clear();
      originTails.clear();
      for (const roomId of lostRooms) options.onLoss("notification_receiver_closed", roomId);
    },
  };
}

type RefBuilder = (data: unknown) => Record<string, unknown> | null;
type RefHydrator = (ref: Record<string, unknown>) => Promise<unknown | null>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringField(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  return typeof value === "string" && value ? value : null;
}

function roomIdField(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) return null;
  return Buffer.byteLength(value, "utf8") <= MAX_BRIDGE_ROOM_ID_BYTES ? value : null;
}

const REF_BUILDERS: Record<string, RefBuilder> = {
  "messages:message:created": (data) => {
    const event = asRecord(data);
    const message = asRecord(event?.message);
    const roomId = roomIdField(event, "projectId");
    const number = parseScopedId(stringField(message, "id") ?? "", "msg");
    return roomId && number ? { room_id: roomId, number } : null;
  },
  "tasks:task:updated": (data) => {
    const event = asRecord(data);
    const roomId = roomIdField(event, "projectId");
    const taskId = stringField(asRecord(event?.task), "id");
    return roomId && taskId ? { room_id: roomId, task_id: taskId } : null;
  },
  "reasoning:reasoning:updated": (data) => {
    const event = asRecord(data);
    const roomId = roomIdField(event, "projectId");
    const sessionId = stringField(asRecord(event?.session), "id");
    return roomId && sessionId ? { room_id: roomId, session_id: sessionId } : null;
  },
  "artifacts:artifact:updated": (data) => {
    const event = asRecord(data);
    const roomId = roomIdField(event, "projectId");
    const identityKey = stringField(asRecord(event?.artifact), "identity_key");
    return roomId && identityKey ? { room_id: roomId, identity_key: identityKey } : null;
  },
};

const REF_HYDRATORS: Record<string, RefHydrator> = {
  "messages:message:created": async (ref) => {
    const roomId = stringField(ref, "room_id");
    const number = typeof ref.number === "number" ? ref.number : null;
    if (!roomId || !number) return null;
    const message = await getMessageById(roomId, formatMessageId(number), {
      include_prompt_only: true,
    });
    if (!message) return null;
    return {
      projectId: roomId,
      message,
      recipientAgentTargets: isPromptOnlyAgentMessage(message.text, message.agent_prompt_kind)
        ? await getMessageRecipientAgentTargets(roomId, number)
        : [],
    };
  },
  "tasks:task:updated": async (ref) => {
    const roomId = stringField(ref, "room_id");
    const taskId = stringField(ref, "task_id");
    if (!roomId || !taskId) return null;
    const task = await getTaskById(roomId, taskId);
    if (!task) return null;
    return { projectId: roomId, task: await attachTaskDetails(roomId, task) };
  },
  "reasoning:reasoning:updated": async (ref) => {
    const roomId = stringField(ref, "room_id");
    const sessionId = stringField(ref, "session_id");
    if (!roomId || !sessionId) return null;
    const session = await getReasoningSessionById(roomId, sessionId);
    // The streamed delta is too large to relay; remote subscribers get the
    // session snapshot instead.
    return session ? { projectId: roomId, session, update: null } : null;
  },
  "artifacts:artifact:updated": async (ref) => {
    const roomId = stringField(ref, "room_id");
    const identityKey = stringField(ref, "identity_key");
    if (!roomId || !identityKey) return null;
    const artifact = await getRoomSharedArtifactByIdentityKey({
      room_id: roomId,
      identity_key: identityKey,
    });
    return artifact ? { projectId: roomId, artifact } : null;
  },
};

export function buildBridgeEnvelope(
  lane: string,
  event: string,
  data: unknown,
  origin: string = instanceId,
): BridgeEnvelope | null {
  if (hasMalformedRoomId(data)) {
    console.error(`[room event bridge] ${lane}/${event} contains an invalid room identifier`);
    return null;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch {
    console.error(`[room event bridge] ${lane}/${event} is not serializable; not relayed`);
    return null;
  }
  if (serialized === undefined) {
    return null;
  }
  if (Buffer.byteLength(serialized) <= MAX_INLINE_DATA_BYTES) {
    return { v: 1, lane, event, mode: "inline", data, origin };
  }
  const ref = REF_BUILDERS[`${lane}:${event}`]?.(data) ?? null;
  if (!ref) {
    console.error(
      `[room event bridge] ${lane}/${event} exceeds the relay size limit and has no reference form; not relayed`
    );
    return null;
  }
  return { v: 1, lane, event, mode: "ref", ref, origin };
}

/**
 * EventEmitter whose emits are also relayed to other API instances once the
 * bridge is started. Events received from other instances are dispatched via
 * emitLocal so they are never re-published.
 */
function publishBridgedEvent(lane: string, event: string, data: unknown): Promise<void> {
  const roomId = roomIdFromBridgeValue(data);
  const envelope = buildBridgeEnvelope(lane, event, data);
  if (!envelope) {
    reportPublisherBridgeLoss(`publish_drop:${lane}/${event}`, roomId);
    return Promise.resolve();
  }
  // Do not carry the potentially multi-megabyte canonical body into the
  // bounded publisher queue. Oversize events have already become compact refs
  // and inline events are capped before this async frame is created.
  return publishBridgeEnvelope(lane, event, envelope, roomId);
}

async function publishBridgeEnvelope(
  lane: string,
  event: string,
  envelope: BridgeEnvelope,
  roomId: string | null,
): Promise<void> {
  try {
    await runBridgePublish(async () => {
      const pendingLosses = snapshotPendingBridgeLosses();
      if (pendingLosses.length === 0) {
        await executeBridgePublish(async (client) => {
          await queryBridgeClient(client, "SELECT pg_notify($1, $2)", [
            ROOM_EVENT_CHANNEL,
            JSON.stringify(envelope),
          ]);
        });
        return;
      }
      const lossEnvelope = {
        v: 1,
        mode: "loss",
        losses: pendingLosses,
        origin: instanceId,
      } satisfies LossBridgeEnvelope;
      // Both notifications commit on one PostgreSQL session in this order.
      // A receiver therefore observes the loss boundary before this event.
      await executeBridgePublish(async (client) => {
        await queryBridgeClient(client, `
            WITH loss AS MATERIALIZED (
              SELECT pg_notify($1, $2) AS delivered
            )
            SELECT pg_notify($1, $3) FROM loss
          `,
          [
            ROOM_EVENT_CHANNEL,
            JSON.stringify(lossEnvelope),
            JSON.stringify(envelope),
          ],
        );
      });
      clearPendingBridgeLosses(pendingLosses);
    });
  } catch (error) {
    // Cross-instance delivery is best-effort; local delivery already happened.
    console.error(`[room event bridge] failed to publish ${lane}/${event}`, error);
    reportPublisherBridgeLoss(`publish_failed:${lane}/${event}`, roomId);
  }
}

const runBridgePublish = createBoundedExecutor({
  label: "room event bridge publish",
  // A single ordered publisher makes a retained loss marker commit before
  // every later event from this process. It also avoids connection-pool fanout
  // for a transport whose ordering is part of the recovery contract.
  maxConcurrent: 1,
  maxQueued: 512,
  // Active PostgreSQL work has a stricter statement/acquire deadline below;
  // this outer deadline is for queue admission and must never settle first.
  timeoutMs: 20_000,
});

let bridgeActive = false;
let listenerClient: PoolClient | null = null;
let listenerConnectWork: Promise<void> | null = null;
let listenerNotificationReceiver: OrderedBridgeNotificationReceiver | null = null;
let detachListenerClientEvents: (() => void) | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let lossRetryTimer: NodeJS.Timeout | null = null;
let stopped = false;
let bridgeGeneration = 0;
const pendingRoomLosses = new Map<string, number>();
let pendingGlobalLossEpoch = 0;
const observedRemoteLosses = new Map<string, number>();
const inFlightPublishes = new Set<Promise<void>>();
const activeBridgePublishOperations = new Set<Promise<void>>();
// Room identifiers may be up to 1 KiB. Four scoped entries keep the compact
// marker comfortably below PostgreSQL's NOTIFY payload ceiling; a larger
// burst is represented by one conservative global boundary.
const MAX_PENDING_ROOM_LOSSES = 4;
const MAX_OBSERVED_REMOTE_LOSSES = 4_096;

function queuePendingBridgeLoss(roomId: string | null, epoch: number): void {
  if (!roomId) {
    pendingGlobalLossEpoch = Math.max(pendingGlobalLossEpoch, epoch);
    pendingRoomLosses.clear();
  } else if (pendingGlobalLossEpoch > 0) {
    pendingGlobalLossEpoch = Math.max(pendingGlobalLossEpoch, epoch);
  } else {
    pendingRoomLosses.set(roomId, epoch);
    if (pendingRoomLosses.size > MAX_PENDING_ROOM_LOSSES) {
      pendingGlobalLossEpoch = Math.max(epoch, ...pendingRoomLosses.values());
      pendingRoomLosses.clear();
    }
  }
  scheduleBridgeLossRetry();
}

function snapshotPendingBridgeLosses(): BridgeLossMarker[] {
  if (pendingGlobalLossEpoch > 0) {
    return [{ room_id: null, epoch: pendingGlobalLossEpoch }];
  }
  return Array.from(pendingRoomLosses, ([room_id, epoch]) => ({ room_id, epoch }));
}

function clearPendingBridgeLosses(delivered: readonly BridgeLossMarker[]): void {
  for (const marker of delivered) {
    if (marker.room_id === null) {
      if (pendingGlobalLossEpoch === marker.epoch) pendingGlobalLossEpoch = 0;
      continue;
    }
    if (pendingRoomLosses.get(marker.room_id) === marker.epoch) {
      pendingRoomLosses.delete(marker.room_id);
    }
  }
  if (snapshotPendingBridgeLosses().length === 0 && lossRetryTimer) {
    clearTimeout(lossRetryTimer);
    lossRetryTimer = null;
  }
}

function scheduleBridgeLossRetry(delayMs = LISTEN_RECONNECT_DELAY_MS): void {
  if (stopped || !bridgeActive || lossRetryTimer || snapshotPendingBridgeLosses().length === 0) {
    return;
  }
  lossRetryTimer = setTimeout(() => {
    lossRetryTimer = null;
    trackBridgePublish(flushPendingBridgeLosses());
  }, delayMs);
  lossRetryTimer.unref?.();
}

function trackBridgePublish(publish: Promise<void>): void {
  inFlightPublishes.add(publish);
  void publish.finally(() => inFlightPublishes.delete(publish));
}

export async function executeBridgePublish(
  publish: (client: PoolClient) => Promise<void>,
  statementTimeoutMs = BRIDGE_PUBLISH_STATEMENT_TIMEOUT_MS,
): Promise<void> {
  const boundedStatementTimeoutMs = Math.max(1, Math.floor(statementTimeoutMs));
  const operation = (async () => {
    const client = await pool.connect();
    let releaseWithError = true;
    try {
      // Each pg_notify statement is its own implicit transaction. Install the
      // server deadline before it, with the client timeout slightly later, so
      // a timed-out publish is cancelled/rolled back by PostgreSQL and can
      // never commit after the retained loss marker is queued.
      await queryBridgeClient(
        client,
        `SET statement_timeout = '${boundedStatementTimeoutMs}ms'`,
        [],
        BRIDGE_CLIENT_ACQUIRE_TIMEOUT_MS,
      );
      await publish(client);
      releaseWithError = false;
    } finally {
      if (!releaseWithError) {
        try {
          await queryBridgeClient(client, "RESET statement_timeout", [], BRIDGE_CLIENT_ACQUIRE_TIMEOUT_MS);
        } catch {
          // The publish already committed. Retire the dirty connection without
          // manufacturing a false transport loss for a reset-only failure.
          releaseWithError = true;
        }
      }
      // Destroy on every failed/timed-out publish. Closing the socket is the
      // second hard cancellation boundary after PostgreSQL statement_timeout.
      client.release(releaseWithError);
    }
  })();
  activeBridgePublishOperations.add(operation);
  try {
    await operation;
  } finally {
    activeBridgePublishOperations.delete(operation);
  }
}

function queryBridgeClient(
  client: PoolClient,
  text: string,
  values: readonly unknown[] = [],
  queryTimeout = BRIDGE_PUBLISH_STATEMENT_TIMEOUT_MS + 1_000,
): Promise<unknown> {
  // node-postgres supports per-query query_timeout at runtime; the repository's
  // older @types/pg declaration does not yet expose the config property.
  const query = client.query as unknown as (config: {
    text: string;
    values: readonly unknown[];
    query_timeout: number;
  }) => Promise<unknown>;
  return query.call(client, { text, values, query_timeout: queryTimeout });
}

async function flushPendingBridgeLosses(): Promise<void> {
  try {
    await runBridgePublish(async () => {
      const pendingLosses = snapshotPendingBridgeLosses();
      if (pendingLosses.length === 0) return;
      const envelope = {
        v: 1,
        mode: "loss",
        losses: pendingLosses,
        origin: instanceId,
      } satisfies LossBridgeEnvelope;
      await executeBridgePublish(async (client) => {
        await queryBridgeClient(client, "SELECT pg_notify($1, $2)", [
          ROOM_EVENT_CHANNEL,
          JSON.stringify(envelope),
        ]);
      });
      clearPendingBridgeLosses(pendingLosses);
    });
  } catch (error) {
    // Keep the same marker pending; retry only while there is actual loss to
    // report, rather than adding a permanent background polling loop.
    console.error("[room event bridge] failed to publish retained loss marker", error);
  } finally {
    scheduleBridgeLossRetry();
  }
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

export function startRoomEventBridge(): void {
  if (bridgeActive) {
    return;
  }
  bridgeActive = true;
  stopped = false;
  bridgeGeneration += 1;
  setBridgedEventPublisher((lane, event, data) => {
    const publish = publishBridgedEvent(lane, event, data);
    trackBridgePublish(publish);
  });
  startListenerConnect(bridgeGeneration);
}

function startListenerConnect(generation: number): void {
  const work = connectListener(generation);
  listenerConnectWork = work;
  void work.finally(() => {
    if (listenerConnectWork === work) listenerConnectWork = null;
  });
}

export async function stopRoomEventBridge(): Promise<void> {
  stopped = true;
  bridgeActive = false;
  setBridgedEventPublisher(null);
  bridgeGeneration += 1;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (lossRetryTimer) {
    clearTimeout(lossRetryTimer);
    lossRetryTimer = null;
  }
  await Promise.allSettled(Array.from(inFlightPublishes));
  await Promise.allSettled(Array.from(activeBridgePublishOperations));
  if (listenerConnectWork) await Promise.allSettled([listenerConnectWork]);
  listenerNotificationReceiver?.close();
  listenerNotificationReceiver = null;
  const client = listenerClient;
  listenerClient = null;
  detachListenerClientEvents?.();
  detachListenerClientEvents = null;
  if (client) {
    try {
      // The LISTEN socket is dedicated. Destroying it is an immediate,
      // bounded UNLISTEN and cannot hang shutdown behind a wedged query.
      client.release(true);
    } catch {
      // It may already have been retired by its error/end handler.
    }
  }
}

async function connectListener(generation: number): Promise<void> {
  if (stopped || generation !== bridgeGeneration) {
    return;
  }
  let client: PoolClient | null = null;
  let notificationReceiver: OrderedBridgeNotificationReceiver | null = null;
  let detachClientEvents: (() => void) | null = null;
  try {
    client = await pool.connect();
    const connectedClient = client;
    if (stopped || generation !== bridgeGeneration) {
      connectedClient.release();
      return;
    }
    const onError = (error: unknown) => {
      console.error("[room event bridge] listener connection failed", error);
      recoverListener(connectedClient);
    };
    const onEnd = () => recoverListener(connectedClient);
    notificationReceiver = createOrderedBridgeNotificationReceiver({
      onLoss: (reason, roomId) => reportBridgeLoss(reason, roomId),
    });
    const connectedReceiver = notificationReceiver;
    const onNotification = (notification: { channel: string; payload?: string }) => {
      if (notification.channel !== ROOM_EVENT_CHANNEL) {
        return;
      }
      const envelope = parseNotificationPayload(notification.payload);
      if (!envelope) return;
      const origin = typeof envelope.origin === "string" ? envelope.origin : "invalid-origin";
      connectedReceiver.enqueue({
        origin,
        roomId: roomIdFromParsedEnvelope(envelope),
        run: (isCurrent) => dispatchBridgeNotification(envelope, isCurrent),
      });
    };
    connectedClient.on("error", onError);
    connectedClient.on("end", onEnd);
    connectedClient.on("notification", onNotification);
    detachClientEvents = () => {
      connectedClient.off("error", onError);
      connectedClient.off("end", onEnd);
      connectedClient.off("notification", onNotification);
    };
    await queryBridgeClient(
      connectedClient,
      `LISTEN ${ROOM_EVENT_CHANNEL}`,
      [],
      BRIDGE_CLIENT_ACQUIRE_TIMEOUT_MS,
    );
    if (stopped || generation !== bridgeGeneration) {
      connectedReceiver.close();
      detachClientEvents();
      detachClientEvents = null;
      connectedClient.release(true);
      return;
    }
    listenerClient = connectedClient;
    listenerNotificationReceiver = connectedReceiver;
    detachListenerClientEvents = detachClientEvents;
    // A room may have gained its first local subscriber while this LISTEN
    // connection was still starting or reconnecting. The earlier global loss
    // signal could not name a room that did not yet exist, so publish one
    // broker-only recovery boundary now. Active subscribers repair anything
    // committed between their snapshot and listener readiness; idle rooms do
    // not allocate state.
    reportBridgeLoss("listener_connected_boundary");
    roomEventBridgeLifecycleEvents.emit("connected");
    scheduleBridgeLossRetry(0);
  } catch (error) {
    notificationReceiver?.close();
    detachClientEvents?.();
    if (listenerNotificationReceiver === notificationReceiver) listenerNotificationReceiver = null;
    if (detachListenerClientEvents === detachClientEvents) detachListenerClientEvents = null;
    if (client) {
      if (listenerClient === client) listenerClient = null;
      try {
        client.release(true);
      } catch {
        // The failed client may already have ended.
      }
    }
    if (generation !== bridgeGeneration) return;
    console.error("[room event bridge] failed to start listener", error);
    reportBridgeLoss("listener_connect_failed");
    scheduleReconnect();
  }
}

function recoverListener(client: PoolClient): void {
  if (listenerClient !== client) return;
  listenerClient = null;
  detachListenerClientEvents?.();
  detachListenerClientEvents = null;
  listenerNotificationReceiver?.close();
  listenerNotificationReceiver = null;
  reportBridgeLoss("listener_disconnected");
  try {
    client.release(true);
  } catch {
    // Already released.
  }
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startListenerConnect(bridgeGeneration);
  }, LISTEN_RECONNECT_DELAY_MS);
}

function parseNotificationPayload(payload: string | undefined): ParsedBridgeEnvelope | null {
  if (!payload) {
    reportBridgeLoss("empty_notification");
    return null;
  }
  if (Buffer.byteLength(payload, "utf8") > 8_000) {
    reportBridgeLoss("oversize_notification");
    return null;
  }
  try {
    return JSON.parse(payload) as ParsedBridgeEnvelope;
  } catch {
    console.error("[room event bridge] received malformed notification payload");
    reportBridgeLoss("malformed_notification");
    return null;
  }
}

function roomIdFromParsedEnvelope(envelope: ParsedBridgeEnvelope): string | null {
  if (envelope.mode === "inline") return roomIdFromBridgeValue(envelope.data);
  if (envelope.mode === "ref") return roomIdFromBridgeValue(envelope.ref);
  if (envelope.mode !== "loss" || !Array.isArray(envelope.losses)) return null;
  const rooms = new Set<string>();
  for (const value of envelope.losses) {
    const marker = asRecord(value);
    if (marker?.room_id === null) return null;
    const roomId = roomIdField(marker, "room_id");
    if (roomId) rooms.add(roomId);
  }
  return rooms.size === 1 ? rooms.values().next().value ?? null : null;
}

function hasMalformedRoomId(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  for (const field of ["projectId", "room_id"] as const) {
    if (field in record && roomIdField(record, field) === null) return true;
  }
  const activity = asRecord(record.activity);
  return Boolean(activity && "room_id" in activity && roomIdField(activity, "room_id") === null);
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
