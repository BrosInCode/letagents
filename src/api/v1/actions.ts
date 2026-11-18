import { randomUUID } from "node:crypto";

import type { ApiActor } from "../../../shared/api/actor.mjs";
import type { CapabilityName } from "../../../shared/api/capabilities.mjs";
import { pool } from "../db/client.js";

/** `ok`, an ApiError code, or a later outcome an intent or job handler records (`pending_approval`). */
export type ApiActionOutcome = string;

export interface ApiActionRecord {
  actor: ApiActor;
  /** The contract method name, for example `rooms.setPolicy`. */
  method: string;
  capability: CapabilityName;
  /** What the call acted on, in a few words: a capability, a task id, a document key. */
  target: string | null;
  outcome: ApiActionOutcome;
}

/**
 * Appends one row to `api_actions`. The router calls it for every write,
 * intent and job that passed the capability check and the rate limit; reads
 * are rate-limited, not recorded. Refusals before the rate limit are not
 * recorded either, so a flood of refused calls cannot fill the table.
 */
export async function recordApiAction(record: ApiActionRecord): Promise<void> {
  const { actor } = record;
  await pool.query(`
    INSERT INTO api_actions
      (action_id, room_id, principal_kind, principal_id, via_kind, via_id, via_version, method, capability, target, outcome)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
  [`apiact_${randomUUID()}`, actor.roomId, actor.principal.kind, actor.principal.id, actor.via?.kind ?? null,
    actor.via?.id ?? null, actor.via?.version ?? null, record.method, record.capability, record.target, record.outcome]);
}

const callTargets = new WeakMap<object, string>();

/** A handler names what it acted on; the router stores it with the action. */
export function setApiActionTarget(call: { req: object }, target: string): void {
  callTargets.set(call.req, target.slice(0, 500));
}

export function apiActionTarget(req: object): string | null {
  return callTargets.get(req) ?? null;
}
