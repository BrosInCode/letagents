import type { DesktopAgentPresence, DesktopParticipantSummary, DesktopSupervisorManifestEntry } from "../../../electron/ipc-types";
import { FRIENDLY_AGENT_NAMES, agentDisplayNameKey, suggestFreeAgentCodenameFrom } from "../../../../../shared/agent-names.mjs";
import { supervisedAgentDisplayLabel } from "./codenames";
import { normalizeManagedAgentRoomIdentifier } from "./managed-agents";

/** A name someone in the room already answers to after "@". */
export interface RoomHeldName {
  name: string;
  holder: "agent" | "person";
}

/**
 * Names a new agent should not take in this room, as far as this window can
 * see. The room assigns the final name when the agent joins; this list lets
 * the Add agent dialog say so before the person clicks Start.
 *
 * - People: every visible person, by display name and GitHub login.
 * - Agents: every agent saved on this computer for the room, in any state,
 *   because a saved agent keeps its name while it is stopped; and every
 *   agent in the room with a known state, online or offline. An agent row
 *   with no state at all is message history only.
 */
export function roomHeldNames(input: {
  roomIdentifier: string | null | undefined;
  participants: readonly DesktopParticipantSummary[];
  presence: readonly DesktopAgentPresence[];
  entries: readonly DesktopSupervisorManifestEntry[];
}): RoomHeldName[] {
  const room = normalizeManagedAgentRoomIdentifier(input.roomIdentifier);
  const held: RoomHeldName[] = [];
  for (const participant of input.participants) {
    if (participant.hiddenAt) continue;
    if (participant.kind === "human") {
      held.push({ name: participant.displayName, holder: "person" });
      if (participant.githubLogin) held.push({ name: participant.githubLogin, holder: "person" });
    } else if (participant.activityState) {
      // Offline agents count too: the room keeps a durable agent's name
      // while it is away, and a name people still see is a confusing one.
      held.push({ name: participant.displayName, holder: "agent" });
    }
  }
  for (const presence of input.presence) {
    if (presence.sessionKind !== "worker" || presence.activityState === "offline") continue;
    if (normalizeManagedAgentRoomIdentifier(presence.roomId) !== room) continue;
    held.push({ name: presence.displayName, holder: "agent" });
  }
  for (const entry of input.entries) {
    if (normalizeManagedAgentRoomIdentifier(entry.roomId) !== room) continue;
    held.push({ name: supervisedAgentDisplayLabel(entry.displayName, entry.id), holder: "agent" });
  }
  return held.filter((entry) => agentDisplayNameKey(entry.name ?? ""));
}

/** The held name `name` would collide with, compared the way "@" mentions are. */
export function heldNameMatch(name: string, held: readonly RoomHeldName[]): RoomHeldName | null {
  const key = agentDisplayNameKey(name.trim());
  if (!key) return null;
  return held.find((entry) => agentDisplayNameKey(entry.name) === key) ?? null;
}

/** The sentence the dialog shows under a taken name. */
export function heldNameMessage(match: RoomHeldName): string {
  return match.holder === "person"
    ? `${match.name} is a person in this room. Choose another name.`
    : `An agent named ${match.name} is already in this room. Choose another name.`;
}

/**
 * The first friendly name nobody in the room answers to ("Atlas", then
 * "Scout", ...), else a codename that is free.
 */
export function freeAgentName(held: readonly RoomHeldName[], seed: string): string {
  const friendly = FRIENDLY_AGENT_NAMES.find((name) => !heldNameMatch(name, held));
  if (friendly) return friendly;
  return suggestFreeAgentCodenameFrom(held.map((entry) => entry.name), seedIndex(seed)) ?? FRIENDLY_AGENT_NAMES[0];
}

/** Where a seed starts the codename scan. Only a starting point: the room assigns the final name. */
function seedIndex(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  return hash >>> 0;
}
