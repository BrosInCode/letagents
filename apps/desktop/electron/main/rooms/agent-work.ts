import {
  isClearedRoomAgentWorkSummary,
  parseRoomAgentWorkSummary,
  type ClearedRoomAgentWorkSummary,
  type RoomAgentWorkSummary,
} from "../../../../../shared/room-agent-work.mjs";
import type {
  DesktopRoomAgentWork,
  DesktopRoomAgentWorkPollResponse,
  DesktopRoomAgentWorkPollResult,
  DesktopRoomAgentWorkSnapshot,
} from "../../ipc-types.js";
import { apiFetch, DesktopApiError } from "../auth.js";
import {
  cloudRoomIdentifierForStorage,
  resolveLocalAwareRoomStorageMode,
} from "./local-store.js";

const ATTEMPT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CURSOR_PATTERN = /^rw1\.[a-f0-9]{64}\.[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^msg_[1-9]\d{0,9}$/;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value as object, key));
}

const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12
    || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59) return null;
  let normalizedOffset = offset;
  if (offset !== "Z") {
    const digits = offset.slice(1).replace(":", "");
    const offsetHour = Number(digits.slice(0, 2));
    const offsetMinute = digits.length === 4 ? Number(digits.slice(2)) : 0;
    if (offsetHour > 23 || offsetMinute > 59) return null;
    normalizedOffset = `${offset[0]}${digits.slice(0, 2)}:${String(offsetMinute).padStart(2, "0")}`;
  }
  const parsed = Date.parse(
    `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${fraction ? `.${fraction}` : ""}${normalizedOffset}`,
  );
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function canonicalSummary(value: unknown): RoomAgentWorkSummary | ClearedRoomAgentWorkSummary | null {
  if (isClearedRoomAgentWorkSummary(value)) return { version: 1, availability: "cleared" };
  return parseRoomAgentWorkSummary(value);
}

function parseWork(
  value: unknown,
  expectedRoomIdentifier: string,
): DesktopRoomAgentWork | null {
  if (!exactKeys(value, ["attempt_id", "room_id", "source_message_id", "agent_key", "revision", "summary", "updated_at"])
    || typeof value.attempt_id !== "string" || !ATTEMPT_ID_PATTERN.test(value.attempt_id)
    || value.room_id !== expectedRoomIdentifier
    || typeof value.source_message_id !== "string" || !MESSAGE_ID_PATTERN.test(value.source_message_id)
    || Number(value.source_message_id.slice(4)) > 2_147_483_647
    || typeof value.agent_key !== "string" || value.agent_key.length < 1 || value.agent_key.length > 512
    || /[\u0000-\u001f\u007f]/.test(value.agent_key)
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return null;
  const updatedAt = normalizeTimestamp(value.updated_at);
  if (!updatedAt) return null;
  const summary = canonicalSummary(value.summary);
  if (!summary) return null;
  return {
    attemptId: value.attempt_id,
    roomId: expectedRoomIdentifier,
    sourceMessageId: value.source_message_id,
    agentKey: value.agent_key,
    revision: Number(value.revision),
    summary,
    updatedAt,
  };
}

function parseSnapshot(
  value: unknown,
  expectedRoomIdentifier: string,
): DesktopRoomAgentWorkSnapshot | null {
  if (!exactKeys(value, ["work", "truncated"])
    || !Array.isArray(value.work) || value.work.length > 50
    || typeof value.truncated !== "boolean") return null;
  const work: DesktopRoomAgentWork[] = [];
  const attempts = new Set<string>();
  const identities = new Set<string>();
  for (const candidate of value.work) {
    const parsed = parseWork(candidate, expectedRoomIdentifier);
    if (!parsed) return null;
    const identity = `${parsed.sourceMessageId}\u0000${parsed.agentKey}`;
    if (attempts.has(parsed.attemptId) || identities.has(identity)) return null;
    attempts.add(parsed.attemptId);
    identities.add(identity);
    work.push(parsed);
  }
  return { work, truncated: value.truncated };
}

/** Strictly map the complete bounded replacement envelope; never salvage rows. */
export function mapDesktopRoomAgentWorkPollPayload(
  value: unknown,
  expectedRoomIdentifier: string,
): DesktopRoomAgentWorkPollResponse | null {
  if (!exactKeys(value, ["room_id", "cursor", "changed", "snapshot"])
    || value.room_id !== expectedRoomIdentifier
    || typeof value.cursor !== "string" || !CURSOR_PATTERN.test(value.cursor)
    || typeof value.changed !== "boolean") return null;
  if (!value.changed) {
    return value.snapshot === null
      ? { roomId: expectedRoomIdentifier, cursor: value.cursor, changed: false, snapshot: null }
      : null;
  }
  const snapshot = parseSnapshot(value.snapshot, expectedRoomIdentifier);
  return snapshot
    ? { roomId: expectedRoomIdentifier, cursor: value.cursor, changed: true, snapshot }
    : null;
}

export async function pollDesktopRoomAgentWork(
  roomIdentifier: string,
  afterCursor?: string | null,
): Promise<DesktopRoomAgentWorkPollResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) return { status: "invalid", response: null };
  const cursor = afterCursor?.trim() || null;
  if (cursor && !CURSOR_PATTERN.test(cursor)) return { status: "invalid", response: null };

  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") return { status: "local", response: null };
  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(storage, trimmedRoomIdentifier);
  const query = cursor ? `?after=${encodeURIComponent(cursor)}&timeout=0` : "?timeout=0";
  try {
    const payload = await apiFetch<unknown>(
      `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/agent-work/poll${query}`,
    );
    const response = mapDesktopRoomAgentWorkPollPayload(payload, cloudRoomIdentifier);
    return response ? { status: "ready", response } : { status: "invalid", response: null };
  } catch (error) {
    if (error instanceof DesktopApiError) {
      if (error.status === 401 || error.status === 403) {
        return { status: "access_revoked", response: null };
      }
      if (error.status === 409 && error.payload?.code === "invalid_cursor") {
        return { status: "invalid", response: null };
      }
    }
    throw error;
  }
}
