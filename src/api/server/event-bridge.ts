import { randomUUID } from "crypto";
import type { EventEmitter } from "events";
import type { PoolClient } from "pg";

import { getMessageById } from "../db.js";
import { pool } from "../db/client.js";
import { formatMessageId, parseScopedId } from "../db/utils.js";
import type { MessageCreatedEvent } from "./events.js";

// Fans room events out across API instances. Local subscribers are served by
// the in-process EventEmitters; this bridge relays a compact reference over
// Postgres NOTIFY so pollers and SSE streams connected to *other* instances
// wake up too. Receivers refetch the message by id, which keeps the payload
// far below the 8000-byte NOTIFY limit.
const ROOM_EVENT_CHANNEL = "letagents_room_events";
const LISTEN_RECONNECT_DELAY_MS = 5_000;

const instanceId = randomUUID();

interface RoomEventNotification {
  kind: "message:created";
  room_id: string;
  message_number: number;
  origin: string;
}

export async function publishRoomMessageCreated(roomId: string, messageId: string): Promise<void> {
  const messageNumber = parseScopedId(messageId, "msg");
  if (!messageNumber) {
    return;
  }
  const notification: RoomEventNotification = {
    kind: "message:created",
    room_id: roomId,
    message_number: messageNumber,
    origin: instanceId,
  };
  try {
    await pool.query("SELECT pg_notify($1, $2)", [ROOM_EVENT_CHANNEL, JSON.stringify(notification)]);
  } catch (error) {
    // Cross-instance delivery is best-effort; local delivery already happened.
    console.error(`[room event bridge] failed to publish message:created for ${roomId}`, error);
  }
}

interface RoomEventBridgeDeps {
  messageEvents: EventEmitter;
}

let bridgeDeps: RoomEventBridgeDeps | null = null;
let listenerClient: PoolClient | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let stopped = false;

export function startRoomEventBridge(deps: RoomEventBridgeDeps): void {
  if (bridgeDeps) {
    return;
  }
  bridgeDeps = deps;
  stopped = false;
  void connectListener();
}

export async function stopRoomEventBridge(): Promise<void> {
  stopped = true;
  bridgeDeps = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const client = listenerClient;
  listenerClient = null;
  if (client) {
    try {
      await client.query(`UNLISTEN ${ROOM_EVENT_CHANNEL}`);
      client.release();
    } catch {
      client.release(true);
    }
  }
}

async function connectListener(): Promise<void> {
  if (stopped) {
    return;
  }
  try {
    const client = await pool.connect();
    listenerClient = client;
    client.on("error", (error: unknown) => {
      console.error("[room event bridge] listener connection failed", error);
      recoverListener(client);
    });
    client.on("notification", (notification) => {
      if (notification.channel !== ROOM_EVENT_CHANNEL) {
        return;
      }
      void handleNotification(notification.payload).catch((error: unknown) => {
        console.error("[room event bridge] failed to handle notification", error);
      });
    });
    await client.query(`LISTEN ${ROOM_EVENT_CHANNEL}`);
  } catch (error) {
    console.error("[room event bridge] failed to start listener", error);
    scheduleReconnect();
  }
}

function recoverListener(client: PoolClient): void {
  if (listenerClient === client) {
    listenerClient = null;
  }
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
    void connectListener();
  }, LISTEN_RECONNECT_DELAY_MS);
}

async function handleNotification(payload: string | undefined): Promise<void> {
  const deps = bridgeDeps;
  if (!payload || !deps) {
    return;
  }
  let parsed: Partial<RoomEventNotification>;
  try {
    parsed = JSON.parse(payload) as Partial<RoomEventNotification>;
  } catch {
    console.error("[room event bridge] received malformed notification payload");
    return;
  }
  if (
    parsed.kind !== "message:created" ||
    typeof parsed.room_id !== "string" ||
    typeof parsed.message_number !== "number" ||
    parsed.origin === instanceId
  ) {
    return;
  }
  const message = await getMessageById(parsed.room_id, formatMessageId(parsed.message_number), {
    include_prompt_only: true,
  });
  if (!message) {
    return;
  }
  deps.messageEvents.emit("message:created", {
    projectId: parsed.room_id,
    message,
  } satisfies MessageCreatedEvent);
}
