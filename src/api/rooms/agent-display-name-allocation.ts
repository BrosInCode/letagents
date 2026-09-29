import { normalizeRoutingHandle, normalizeRoutingSender } from "../../../shared/routing-aliases.mjs";
import { isAgentProcessGone } from "../../shared/agent-presence.js";
import { pickLocalCodename } from "../../shared/codenames.js";

/**
 * Codename picks are hashed, not sequential, so a scan is bounded instead of
 * relying on the pool to contain a free name.
 */
export const MAX_DISPLAY_NAME_COLLISION_OFFSET = 1_024;

/**
 * The form in which two display names are the same name to a room. A display
 * name is what people and agents type after "@", so names are compared the way
 * mention routing compares them: "FieldMeadow", "fieldmeadow" and
 * "Field Meadow" all answer to "@FieldMeadow" and cannot coexist.
 */
export function agentDisplayNameKey(displayName: string): string {
  return normalizeRoutingHandle(displayName) || normalizeRoutingSender(displayName);
}

/**
 * A held name is never decorated with a number. "Name 1" cannot be addressed
 * as typed (the mention parser stops at the space and wakes the holder of
 * "Name"), so a collision receives its own codename. The seed is
 * deterministic, so one identity converges on the same replacement whenever
 * the same names are held.
 */
export function pickAgentDisplayName(input: {
  base_display_name: string;
  agent_key: string;
  collision_offset: number;
}): string {
  return input.collision_offset === 0
    ? input.base_display_name
    : pickLocalCodename(`${input.agent_key}:${input.collision_offset}`).display_name;
}

/**
 * First free name at or after `from_offset`, or null when the bounded scan
 * finds none.
 */
export function allocateAgentDisplayName(input: {
  base_display_name: string;
  agent_key: string;
  is_held: (displayName: string) => boolean;
  from_offset?: number;
}): { display_name: string; collision_offset: number } | null {
  for (
    let offset = input.from_offset ?? 0;
    offset <= MAX_DISPLAY_NAME_COLLISION_OFFSET;
    offset += 1
  ) {
    const displayName = pickAgentDisplayName({
      base_display_name: input.base_display_name,
      agent_key: input.agent_key,
      collision_offset: offset,
    });
    if (!input.is_held(displayName)) return { display_name: displayName, collision_offset: offset };
  }
  return null;
}

/** A worker session whose name other agents in its room must not take. */
export interface RoomWorkerNameHolder {
  session_id: string;
  agent_key: string;
  agent_instance_id: string | null;
  display_name: string;
  /** The name that was asked for when `display_name` was assigned. */
  assigned_base_display_name: string | null;
  created_at: string;
  /** Set only for an offline durable worker, which keeps its name reserved. */
  ended_at: string | null;
  owner_account_id?: string | null;
  last_seen_at?: string | null;
  /** Set for a worker whose lifetime a desktop supervisor owns. */
  supervisor_grant_id?: string | null;
  process_host_id?: string | null;
  agent_heard_at?: string | null;
  delivery_connected?: boolean;
  process_seen_at?: string | null;
  process_connection_id?: string | null;
  process_disconnected_at?: string | null;
}

/**
 * Holders of `display_name` whose process is gone, so that the name can pass
 * to a registration by the same owner.
 *
 * A process that restarts leaves its session behind, and an agent that
 * registers afresh leaves its registration behind. Nothing else ends either,
 * so each would refuse the agent its own name for ever.
 *
 * A holder is released only on evidence that its process no longer exists.
 * Being quiet is not evidence: a holder whose client never opened a process
 * connection is never released, however long it has been unseen.
 *
 * Also never released: another owner's agent, the caller's own instance, and
 * a supervised worker, whose lifetime belongs to its supervisor.
 */
export function selectReleasableNameHolders<Holder extends RoomWorkerNameHolder>(input: {
  display_name: string;
  owner_account_id: string;
  agent_key: string;
  agent_instance_id: string | null;
  process_host_id: string | null;
  holders: readonly Holder[];
  now_ms: number;
}): Holder[] {
  const key = agentDisplayNameKey(input.display_name);
  if (!key) return [];
  return input.holders.filter((holder) => {
    if (!holder.owner_account_id || holder.owner_account_id !== input.owner_account_id) return false;
    if (holder.supervisor_grant_id) return false;
    if (holder.agent_key === input.agent_key && holder.agent_instance_id === input.agent_instance_id) return false;
    if (agentDisplayNameKey(holder.display_name) !== key) return false;
    return isAgentProcessGone(holder, { now_ms: input.now_ms, process_host_id: input.process_host_id });
  });
}

function isSenior(left: RoomWorkerNameHolder, right: RoomWorkerNameHolder): boolean {
  const leftCreated = Date.parse(left.created_at);
  const rightCreated = Date.parse(right.created_at);
  if (leftCreated !== rightCreated) return leftCreated < rightCreated;
  return left.session_id < right.session_id;
}

/**
 * Whether an agent of another identity already answers to `displayName`.
 *
 * An agent answers to its display name and to the last segment of its key,
 * because mention routing matches both. A key cannot be renamed away, so a
 * name matching another agent's key is always held.
 *
 * Of two live workers that already share a display name, the one whose
 * session is older keeps it: `own_sessions` living under the name yield only
 * to an older holder, so an existing pair converges without both moving.
 */
export function isNameHeldByAnotherAgent(input: {
  display_name: string;
  agent_key: string;
  own_sessions: readonly RoomWorkerNameHolder[];
  holders: readonly RoomWorkerNameHolder[];
}): boolean {
  const key = agentDisplayNameKey(input.display_name);
  if (!key) return false;
  const ownUnderName = input.own_sessions.filter((own) =>
    !own.ended_at && agentDisplayNameKey(own.display_name) === key);
  return input.holders.some((holder) => {
    if (holder.agent_key === input.agent_key) return false;
    if (agentDisplayNameKey(holder.agent_key.split("/").pop() ?? "") === key) return true;
    if (agentDisplayNameKey(holder.display_name) !== key) return false;
    if (holder.ended_at) return true;
    return !ownUnderName.some((own) => isSenior(own, holder));
  });
}

/**
 * Name for a supervised worker that is minting or rotating its session.
 *
 * The supervisor requests the name in its manifest; the room decides whether
 * that name is free. A supervisor that has not adopted an earlier
 * reassignment asks for the taken name again on every rotation, so a name the
 * room assigned for that same request is kept for as long as it stays free.
 * Otherwise the holder going offline would hand its name to the newcomer and
 * leave people addressing the wrong agent.
 */
export function resolveSupervisedWorkerDisplayName(input: {
  requested_display_name: string;
  agent_key: string;
  agent_instance_id: string;
  holders: readonly RoomWorkerNameHolder[];
  additionally_held?: Iterable<string>;
}): { display_name: string; reassigned: boolean } | null {
  const own = input.holders.find((holder) => !holder.ended_at
    && holder.agent_key === input.agent_key
    && holder.agent_instance_id === input.agent_instance_id) ?? null;
  const ownSessions = own ? [own] : [];
  const additionallyHeld = new Set(
    Array.from(input.additionally_held ?? [], (name) => agentDisplayNameKey(name)).filter(Boolean),
  );
  const isHeld = (candidate: string): boolean =>
    additionallyHeld.has(agentDisplayNameKey(candidate))
    || isNameHeldByAnotherAgent({
      display_name: candidate,
      agent_key: input.agent_key,
      own_sessions: ownSessions,
      holders: input.holders,
    });

  const requested = input.requested_display_name;
  const requestedKey = agentDisplayNameKey(requested);
  const ownKey = own ? agentDisplayNameKey(own.display_name) : "";
  const repeatsReassignedRequest = Boolean(own
    && ownKey !== requestedKey
    && own.assigned_base_display_name
    && agentDisplayNameKey(own.assigned_base_display_name) === requestedKey);
  if (own && repeatsReassignedRequest && !isHeld(own.display_name)) {
    return { display_name: own.display_name, reassigned: true };
  }
  if (!isHeld(requested)) return { display_name: requested, reassigned: false };
  if (own && ownKey !== requestedKey && !isHeld(own.display_name)) {
    return { display_name: own.display_name, reassigned: true };
  }
  const allocated = allocateAgentDisplayName({
    base_display_name: requested,
    agent_key: input.agent_key,
    is_held: isHeld,
    from_offset: 1,
  });
  return allocated ? { display_name: allocated.display_name, reassigned: true } : null;
}
