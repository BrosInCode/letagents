import type { PoolClient } from "pg";

import { createBoundedExecutor } from "../../bounded-async.js";
import { pool } from "../../db/client.js";
import { setBridgedEventPublisher } from "../bridged-emitter.js";
import {
  BRIDGE_CLIENT_ACQUIRE_TIMEOUT_MS,
  BRIDGE_PUBLISH_STATEMENT_TIMEOUT_MS,
  LISTEN_RECONNECT_DELAY_MS,
  ROOM_EVENT_CHANNEL,
} from "./constants.js";
import {
  buildBridgeEnvelope,
  type BridgeEnvelope,
  type BridgeLossMarker,
  instanceId,
  type LossBridgeEnvelope,
  roomIdFromBridgeValue,
} from "./envelope-codec.js";
import { reportBridgeLoss } from "./loss-signals.js";

let lossRetryTimer: NodeJS.Timeout | null = null;
let stopped = false;
let bridgeActive = false;
const pendingRoomLosses = new Map<string, number>();
let pendingGlobalLossEpoch = 0;
const inFlightPublishes = new Set<Promise<void>>();
const activeBridgePublishOperations = new Set<Promise<void>>();
// Room identifiers may be up to 1 KiB. Four scoped entries keep the compact
// marker comfortably below PostgreSQL's NOTIFY payload ceiling; a larger
// burst is represented by one conservative global boundary.
const MAX_PENDING_ROOM_LOSSES = 4;

function reportPublisherBridgeLoss(reason: string, roomId?: string | null): void {
  const epoch = reportBridgeLoss(reason, roomId);
  queuePendingBridgeLoss(roomId ?? null, epoch);
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

export function scheduleBridgeLossRetry(delayMs = LISTEN_RECONNECT_DELAY_MS): void {
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

export function queryBridgeClient(
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

export function startBridgePublisher(): boolean {
  if (bridgeActive) {
    return false;
  }
  bridgeActive = true;
  stopped = false;
  setBridgedEventPublisher((lane, event, data) => {
    const publish = publishBridgedEvent(lane, event, data);
    trackBridgePublish(publish);
  });
  return true;
}

export function beginStopBridgePublisher(): void {
  stopped = true;
  bridgeActive = false;
  setBridgedEventPublisher(null);
  if (lossRetryTimer) {
    clearTimeout(lossRetryTimer);
    lossRetryTimer = null;
  }
}

export async function finishStopBridgePublisher(): Promise<void> {
  await Promise.allSettled(Array.from(inFlightPublishes));
  await Promise.allSettled(Array.from(activeBridgePublishOperations));
}
