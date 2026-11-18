import { createHash, randomBytes } from "node:crypto";

import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";

import type { ApiActor } from "../../../shared/api/actor.mjs";
import type { IntentKind, IntentState } from "../../../shared/api/intents.mjs";
import { db } from "./client.js";
import { api_intents, type ApiIntentRow } from "./schema.js";

export type { ApiIntentRow };

export function newIntentId(): string {
  return `intent_${randomBytes(16).toString("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** One change, whatever the key order: the pending-intent index compares this. */
export function intentPayloadFingerprint(kind: IntentKind, payload: Record<string, unknown>): string {
  return createHash("sha256").update(`${kind}\0${stableJson(payload)}`).digest("hex");
}

function uniqueViolation(error: unknown): string | null {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    const record = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (record.code === "23505" && typeof record.constraint === "string") return record.constraint;
    current = record.cause;
  }
  return null;
}

/** The same caller's retry key was already used for another change. */
export class ApiIntentClientIdConflictError extends Error {
  constructor() {
    super("This clientIntentId was already used for a different change.");
    this.name = "ApiIntentClientIdConflictError";
  }
}

export async function findApiIntentByClientId(
  roomId: string,
  principal: ApiActor["principal"],
  clientIntentId: string,
): Promise<ApiIntentRow | null> {
  const [row] = await db.select().from(api_intents).where(and(
    eq(api_intents.room_id, roomId),
    eq(api_intents.principal_kind, principal.kind),
    eq(api_intents.principal_id, principal.id),
    eq(api_intents.client_intent_id, clientIntentId),
  )).limit(1);
  return row ?? null;
}

/** The intent a retry key names, when it is the same change; a different change is a conflict. */
export function sameClientIntent(row: ApiIntentRow, kind: IntentKind, payload: Record<string, unknown>): ApiIntentRow {
  if (row.kind !== kind || row.payload_fingerprint !== intentPayloadFingerprint(kind, payload)) throw new ApiIntentClientIdConflictError();
  return row;
}

/**
 * Inserts a new intent. A pending one for the same proposer and change
 * already there is returned instead (`created: false`), so a retried or
 * repeated proposal waits once.
 */
export async function insertApiIntent(input: {
  roomId: string;
  kind: IntentKind;
  payload: Record<string, unknown>;
  actor: ApiActor;
  state: IntentState;
  clientIntentId?: string | null;
  now: string;
}): Promise<{ row: ApiIntentRow; created: boolean }> {
  const fingerprint = intentPayloadFingerprint(input.kind, input.payload);
  const { principal, via } = input.actor;
  const values: ApiIntentRow = {
    id: newIntentId(),
    room_id: input.roomId,
    kind: input.kind,
    payload: input.payload,
    payload_fingerprint: fingerprint,
    principal_kind: principal.kind,
    principal_id: principal.id,
    principal_login: principal.login ?? null,
    client_intent_id: input.clientIntentId ?? null,
    via_kind: via?.kind ?? null,
    via_id: via?.id ?? null,
    via_version: via?.version ?? null,
    state: input.state,
    decided_by: null,
    decided_at: null,
    result: null,
    error: null,
    effect_id: null,
    created_at: input.now,
    updated_at: input.now,
  };
  try {
    const [row] = await db.insert(api_intents).values(values).returning();
    return { row: row!, created: true };
  } catch (error) {
    const constraint = uniqueViolation(error);
    if (constraint === "api_intents_client_id_uq" && input.clientIntentId) {
      // A concurrent retry with the same key stored it first.
      const first = await findApiIntentByClientId(input.roomId, principal, input.clientIntentId);
      if (first) return { row: sameClientIntent(first, input.kind, input.payload), created: false };
    }
    if (constraint !== "api_intents_pending_uq") throw error;
  }
  const [existing] = await db.select().from(api_intents).where(and(
    eq(api_intents.room_id, input.roomId),
    eq(api_intents.kind, input.kind),
    eq(api_intents.payload_fingerprint, fingerprint),
    eq(api_intents.principal_kind, principal.kind),
    eq(api_intents.principal_id, principal.id),
    eq(api_intents.state, "pending_approval"),
  )).limit(1);
  // Decided between the insert and this read: propose again.
  if (!existing) throw new Error("The pending intent changed while it was proposed. Try again.");
  return { row: existing, created: false };
}

export async function getApiIntent(roomId: string, id: string): Promise<ApiIntentRow | null> {
  const [row] = await db.select().from(api_intents).where(and(eq(api_intents.room_id, roomId), eq(api_intents.id, id))).limit(1);
  return row ?? null;
}

export async function listApiIntents(roomId: string, options: { state?: IntentState; limit: number }): Promise<ApiIntentRow[]> {
  return db.select().from(api_intents)
    .where(and(eq(api_intents.room_id, roomId), options.state ? eq(api_intents.state, options.state) : undefined))
    .orderBy(desc(api_intents.created_at), desc(api_intents.id))
    .limit(options.limit);
}

export type ApiIntentChange = Partial<Pick<ApiIntentRow, "state" | "decided_by" | "decided_at" | "result" | "error" | "effect_id">>;

/**
 * Compare-and-set: applies the change only while the intent is in one of
 * `from`, in one statement, so two admins (or an admin and a retry) can
 * never both decide or both run it. Null when another writer moved it first.
 */
export async function moveApiIntent(
  roomId: string,
  id: string,
  from: readonly IntentState[],
  change: ApiIntentChange,
  now: string,
): Promise<ApiIntentRow | null> {
  const [row] = await db.update(api_intents)
    .set({ ...change, updated_at: now })
    .where(and(eq(api_intents.room_id, roomId), eq(api_intents.id, id), inArray(api_intents.state, [...from])))
    .returning();
  return row ?? null;
}

/** Intents `running` since before `before`, oldest first: what a stopped server may have left. */
export async function listStaleRunningApiIntents(before: string, limit: number): Promise<ApiIntentRow[]> {
  return db.select().from(api_intents)
    .where(and(eq(api_intents.state, "running"), lt(api_intents.updated_at, before)))
    .orderBy(asc(api_intents.updated_at))
    .limit(limit);
}

/** The running intent a journal row was made for (its idempotency key is `api_intent:<id>`). */
export async function getRunningApiIntent(roomId: string, id: string): Promise<ApiIntentRow | null> {
  const [row] = await db.select().from(api_intents)
    .where(and(eq(api_intents.room_id, roomId), eq(api_intents.id, id), eq(api_intents.state, "running"))).limit(1);
  return row ?? null;
}
