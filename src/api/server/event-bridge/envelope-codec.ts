import { randomUUID } from "crypto";

import {
  getMessageById,
  getMessageRecipientAgentTargets,
  getReasoningSessionById,
  getRoomSharedArtifactByIdentityKey,
  getTaskById,
} from "../../db.js";
import { formatMessageId, parseScopedId } from "../../db/utils.js";
import { attachTaskDetails } from "../../routes/rooms/tasks/task-details.js";
import { isPromptOnlyAgentMessage } from "../../../shared/room-agent-prompts.js";
import { MAX_BRIDGE_ROOM_ID_BYTES, MAX_INLINE_DATA_BYTES } from "./constants.js";

export const instanceId = randomUUID();

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

export interface BridgeLossMarker {
  room_id: string | null;
  epoch: number;
}

export interface LossBridgeEnvelope {
  v: 1;
  mode: "loss";
  losses: BridgeLossMarker[];
  origin: string;
}

export type BridgeEnvelope = InlineBridgeEnvelope | RefBridgeEnvelope | LossBridgeEnvelope;

export interface ParsedBridgeEnvelope {
  v?: unknown;
  lane?: unknown;
  event?: unknown;
  mode?: unknown;
  data?: unknown;
  ref?: unknown;
  losses?: unknown;
  origin?: unknown;
}

type RefBuilder = (data: unknown) => Record<string, unknown> | null;
type RefHydrator = (ref: Record<string, unknown>) => Promise<unknown | null>;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringField(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  return typeof value === "string" && value ? value : null;
}

export function roomIdField(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) return null;
  return Buffer.byteLength(value, "utf8") <= MAX_BRIDGE_ROOM_ID_BYTES ? value : null;
}

export function roomIdFromBridgeValue(value: unknown): string | null {
  return roomIdField(asRecord(value), "projectId")
    ?? roomIdField(asRecord(value), "room_id")
    ?? roomIdField(asRecord(asRecord(value)?.activity), "room_id");
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

export const REF_HYDRATORS: Record<string, RefHydrator> = {
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

export function roomIdFromParsedEnvelope(envelope: ParsedBridgeEnvelope): string | null {
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

export function hasMalformedRoomId(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  for (const field of ["projectId", "room_id"] as const) {
    if (field in record && roomIdField(record, field) === null) return true;
  }
  const activity = asRecord(record.activity);
  return Boolean(activity && "room_id" in activity && roomIdField(activity, "room_id") === null);
}
