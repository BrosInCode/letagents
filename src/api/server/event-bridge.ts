import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import type { PoolClient } from "pg";

import {
  getMessageById,
  getReasoningSessionById,
  getRoomSharedArtifactByIdentityKey,
  getTaskById,
} from "../db.js";
import { pool } from "../db/client.js";
import { formatMessageId, parseScopedId } from "../db/utils.js";
import { attachTaskDetails } from "../routes/rooms/tasks/task-details.js";

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

const instanceId = randomUUID();

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

export type BridgeEnvelope = InlineBridgeEnvelope | RefBridgeEnvelope;

type RefBuilder = (data: unknown) => Record<string, unknown> | null;
type RefHydrator = (ref: Record<string, unknown>) => Promise<unknown | null>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringField(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  return typeof value === "string" && value ? value : null;
}

const REF_BUILDERS: Record<string, RefBuilder> = {
  "messages:message:created": (data) => {
    const event = asRecord(data);
    const message = asRecord(event?.message);
    const roomId = stringField(event, "projectId");
    const number = parseScopedId(stringField(message, "id") ?? "", "msg");
    return roomId && number ? { room_id: roomId, number } : null;
  },
  "tasks:task:updated": (data) => {
    const event = asRecord(data);
    const roomId = stringField(event, "projectId");
    const taskId = stringField(asRecord(event?.task), "id");
    return roomId && taskId ? { room_id: roomId, task_id: taskId } : null;
  },
  "reasoning:reasoning:updated": (data) => {
    const event = asRecord(data);
    const roomId = stringField(event, "projectId");
    const sessionId = stringField(asRecord(event?.session), "id");
    return roomId && sessionId ? { room_id: roomId, session_id: sessionId } : null;
  },
  "artifacts:artifact:updated": (data) => {
    const event = asRecord(data);
    const roomId = stringField(event, "projectId");
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
    return message ? { projectId: roomId, message } : null;
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
export class BridgedEventEmitter extends EventEmitter {
  constructor(readonly lane: string) {
    super();
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const dispatched = super.emit(event, ...args);
    if (bridgeActive && typeof event === "string") {
      void publishBridgedEvent(this.lane, event, args[0]);
    }
    return dispatched;
  }

  emitLocal(event: string, data: unknown): boolean {
    return super.emit(event, data);
  }
}

const laneRegistry = new Map<string, BridgedEventEmitter>();

export function createBridgedEmitter(lane: string): BridgedEventEmitter {
  const existing = laneRegistry.get(lane);
  if (existing) {
    return existing;
  }
  const emitter = new BridgedEventEmitter(lane);
  laneRegistry.set(lane, emitter);
  return emitter;
}

async function publishBridgedEvent(lane: string, event: string, data: unknown): Promise<void> {
  const envelope = buildBridgeEnvelope(lane, event, data);
  if (!envelope) {
    return;
  }
  try {
    await pool.query("SELECT pg_notify($1, $2)", [ROOM_EVENT_CHANNEL, JSON.stringify(envelope)]);
  } catch (error) {
    // Cross-instance delivery is best-effort; local delivery already happened.
    console.error(`[room event bridge] failed to publish ${lane}/${event}`, error);
  }
}

let bridgeActive = false;
let listenerClient: PoolClient | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let stopped = false;

export function startRoomEventBridge(): void {
  if (bridgeActive) {
    return;
  }
  bridgeActive = true;
  stopped = false;
  void connectListener();
}

export async function stopRoomEventBridge(): Promise<void> {
  stopped = true;
  bridgeActive = false;
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
  if (!payload) {
    return;
  }
  let envelope: Partial<BridgeEnvelope>;
  try {
    envelope = JSON.parse(payload) as Partial<BridgeEnvelope>;
  } catch {
    console.error("[room event bridge] received malformed notification payload");
    return;
  }
  if (
    envelope.v !== 1 ||
    typeof envelope.lane !== "string" ||
    typeof envelope.event !== "string" ||
    envelope.origin === instanceId
  ) {
    return;
  }
  const emitter = laneRegistry.get(envelope.lane);
  if (!emitter) {
    return;
  }
  if (envelope.mode === "inline") {
    emitter.emitLocal(envelope.event, envelope.data);
    return;
  }
  if (envelope.mode !== "ref") {
    return;
  }
  const ref = asRecord(envelope.ref);
  if (!ref) {
    return;
  }
  const hydrator = REF_HYDRATORS[`${envelope.lane}:${envelope.event}`];
  if (!hydrator) {
    return;
  }
  const data = await hydrator(ref);
  if (data === null) {
    return;
  }
  emitter.emitLocal(envelope.event, data);
}
