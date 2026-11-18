import { listAgents, type Agent } from "../../../../shared/api/agents.mjs";
import { getRoomAgentPresence, getRoomParticipants, type RoomAgentPresence, type RoomParticipant } from "../../db.js";
import { defineRoute, type ApiRoute } from "../route.js";

const ROSTER_LIMIT = 200;

// Routes for the methods in shared/api/agents.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  defineRoute(listAgents, async (_input, { room }) => {
    // The roster the room's participant list shows: every agent the room has
    // seen, with the live roster's presence. `freshness` is "active" only
    // while the agent's delivery was heard from inside the 90 s presence
    // window; an unended session alone does not make an agent online.
    const [participants, presence] = await Promise.all([
      getRoomParticipants(room.id, { limit: ROSTER_LIMIT }),
      getRoomAgentPresence(room.id, { limit: ROSTER_LIMIT }),
    ]);
    const presenceByLabel = new Map(presence.map((entry) => [entry.actor_label.trim(), entry]));
    const agents = new Map<string, Agent>();
    for (const participant of participants) {
      const label = participant.actor_label?.trim();
      if (participant.kind !== "agent" || !label) continue;
      agents.set(label, toAgent(label, participant, presenceByLabel.get(label) ?? null));
    }
    // An agent that joined but has not been recorded as a participant yet.
    for (const [label, entry] of presenceByLabel) {
      if (!agents.has(label)) agents.set(label, toAgent(label, null, entry));
    }
    return {
      agents: [...agents.values()].sort((a, b) =>
        Number(b.online) - Number(a.online) || Date.parse(b.lastSeenAt ?? "") - Date.parse(a.lastSeenAt ?? "") || 0),
    };
  }),
];

function toAgent(label: string, participant: RoomParticipant | null, presence: RoomAgentPresence | null): Agent {
  const agentKey = presence?.agent_key || participant?.agent_key || null;
  const seen = [participant?.last_seen_at, presence?.last_heartbeat_at]
    .map((value) => Date.parse(value ?? ""))
    .filter((ms) => Number.isFinite(ms) && ms > 0);
  return {
    name: presence?.display_name || participant?.display_name || label,
    label,
    agentKey,
    // The key is `owner_login/name`, written at registration from the owner's account.
    ownerLogin: agentKey?.includes("/") ? agentKey.slice(0, agentKey.indexOf("/")) : null,
    online: presence?.freshness === "active",
    status: presence ? presence.status : null,
    statusText: presence?.status_text ?? null,
    lastSeenAt: seen.length ? new Date(Math.max(...seen)).toISOString() : null,
  };
}
