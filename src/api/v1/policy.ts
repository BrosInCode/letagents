import type { ApiActor } from "../../../shared/api/actor.mjs";
import {
  CAPABILITY_NAMES,
  getCapability,
  isCapabilityName,
  type CapabilityName,
  type CapabilityPolicy,
  type CapabilityPolicyRule,
} from "../../../shared/api/capabilities.mjs";
import { shouldRequireBoardIntent } from "../db/coordination/board-intent-approval.js";
import { pool } from "../db/client.js";

/**
 * The room's API policy for one capability.
 * - `configured`: the room admin's mode, else the registry default.
 * - `mode`: what applies to this actor now. A `confirm` asks the viewer in an
 *   app-drawn sheet before a page acts for them; any other caller (a person,
 *   an agent, a job's agent, a remote MCP client) acts for itself and has no
 *   sheet to show, so for it `confirm` is `allow`. The default of
 *   `tasks.propose` follows the Board Manager: a person's own board write
 *   (no `via`) skips board intents; anyone else needs approval while
 *   `shouldRequireBoardIntent` is true.
 * - `rule`: the run-time rule a default carries. `own_tracker_connection`
 *   stays `approve` here; the intent handler relaxes it to `allow` when the
 *   viewer's own tracker connection runs the change.
 */
export interface ResolvedApiPolicy {
  capability: CapabilityName;
  mode: CapabilityPolicy;
  configured: CapabilityPolicy;
  source: "room" | "default";
  rule: CapabilityPolicyRule | null;
}

/** Reads are always allowed for room participants in `api: 1`; only the other capabilities have a room policy. */
export function isPolicyCapability(capability: CapabilityName): boolean {
  return !capability.endsWith(".read");
}

export const POLICY_CAPABILITIES: readonly CapabilityName[] = Object.freeze(CAPABILITY_NAMES.filter(isPolicyCapability));

/** What happens when this actor uses this capability in this room. Intents and jobs act on `mode`. */
export async function resolvePolicy(roomId: string, capability: CapabilityName, actor: ApiActor): Promise<ResolvedApiPolicy> {
  const spec = getCapability(capability);
  if (!isPolicyCapability(capability)) {
    return { capability, mode: "allow", configured: "allow", source: "default", rule: null };
  }
  const row = await readRoomPolicy(roomId, capability);
  const configured = row ?? spec.defaultPolicy;
  const rule = row ? null : spec.policyRule;
  let mode: CapabilityPolicy = configured;
  if (rule === "board_manager_mode") {
    const personOwnWrite = actor.principal.kind === "person" && !actor.via;
    mode = personOwnWrite || !(await shouldRequireBoardIntent({ room_id: roomId })) ? "allow" : "approve";
  }
  if (mode === "confirm" && actor.via?.kind !== "page") mode = "allow";
  return { capability, mode, configured, source: row ? "room" : "default", rule };
}

/** Every policy capability with its configured mode, for the room's settings. */
export async function listRoomPolicies(roomId: string): Promise<Omit<ResolvedApiPolicy, "mode">[]> {
  const result = await pool.query<{ capability: string; mode: CapabilityPolicy }>(
    "SELECT capability, mode FROM room_api_policies WHERE room_id = $1", [roomId]);
  const rows = new Map(result.rows.map((row) => [row.capability, row.mode]));
  return POLICY_CAPABILITIES.map((capability) => {
    const row = rows.get(capability);
    const spec = getCapability(capability);
    return row
      ? { capability, configured: row, source: "room" as const, rule: null }
      : { capability, configured: spec.defaultPolicy, source: "default" as const, rule: spec.policyRule };
  });
}

/** Sets a room's mode for one capability; `null` goes back to the default. */
export async function setRoomPolicy(input: {
  roomId: string;
  capability: CapabilityName;
  mode: CapabilityPolicy | null;
  accountId: string;
}): Promise<void> {
  if (!isCapabilityName(input.capability) || !isPolicyCapability(input.capability)) {
    throw new TypeError(`setRoomPolicy: "${input.capability}" has no room policy.`);
  }
  if (input.mode === null) {
    await pool.query("DELETE FROM room_api_policies WHERE room_id = $1 AND capability = $2", [input.roomId, input.capability]);
    return;
  }
  await pool.query(`
    INSERT INTO room_api_policies (room_id, capability, mode, updated_by, updated_at)
    VALUES ($1, $2, $3, $4, now())
    ON CONFLICT (room_id, capability) DO UPDATE SET mode = EXCLUDED.mode, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [input.roomId, input.capability, input.mode, input.accountId]);
}

async function readRoomPolicy(roomId: string, capability: CapabilityName): Promise<CapabilityPolicy | null> {
  const result = await pool.query<{ mode: CapabilityPolicy }>(
    "SELECT mode FROM room_api_policies WHERE room_id = $1 AND capability = $2", [roomId, capability]);
  return result.rows[0]?.mode ?? null;
}
