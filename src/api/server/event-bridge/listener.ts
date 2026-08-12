import type { PoolClient } from "pg";

import { pool } from "../../db/client.js";
import {
  BRIDGE_CLIENT_ACQUIRE_TIMEOUT_MS,
  LISTEN_RECONNECT_DELAY_MS,
  ROOM_EVENT_CHANNEL,
} from "./constants.js";
import {
  type ParsedBridgeEnvelope,
  roomIdFromParsedEnvelope,
} from "./envelope-codec.js";
import { dispatchBridgeNotification } from "./notification-dispatch.js";
import {
  createOrderedBridgeNotificationReceiver,
  type OrderedBridgeNotificationReceiver,
} from "./ordered-notification-receiver.js";
import { reportBridgeLoss, roomEventBridgeLifecycleEvents } from "./loss-signals.js";
import { queryBridgeClient, scheduleBridgeLossRetry } from "./publisher.js";

let listenerClient: PoolClient | null = null;
let listenerConnectWork: Promise<void> | null = null;
let listenerNotificationReceiver: OrderedBridgeNotificationReceiver | null = null;
let detachListenerClientEvents: (() => void) | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let stopped = false;
let bridgeGeneration = 0;

export function startBridgeListener(): void {
  stopped = false;
  bridgeGeneration += 1;
  startListenerConnect(bridgeGeneration);
}

function startListenerConnect(generation: number): void {
  const work = connectListener(generation);
  listenerConnectWork = work;
  void work.finally(() => {
    if (listenerConnectWork === work) listenerConnectWork = null;
  });
}

export function beginStopBridgeListener(): void {
  stopped = true;
  bridgeGeneration += 1;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

export async function finishStopBridgeListener(): Promise<void> {
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
