import type { DesktopAccountRoomEntry, DesktopRoomLiveMetadata, DesktopSupervisorManifestEntry } from "../../../electron/ipc-types";
import type { DesktopHostApproval } from "../../../shared/host-approvals";
import type { AgentInspectorRequest } from "../components/desktop/content/desktop-chat-message/types";
import { projectAgentInspectors } from "./agent-inspector";
import { participantAgentInspectorRequest, resolveSupervisorEntryId, supervisedAgentInspectorRequest } from "./agent-inspector-identity";
import { managedAgentProviderLabel, mergeReachableAgentPresenceParticipants } from "./managed-agents";

export type SettingsAgentFilter = "all" | "attention" | "active" | "paused" | "external" | "retired";
export interface SettingsAgentRow {
  id: string;
  roomId: string;
  roomName: string;
  name: string;
  provider: string;
  summary: string;
  searchText: string;
  status: string;
  attention: boolean;
  active: boolean;
  paused: boolean;
  retired: boolean;
  external: boolean;
  stale: boolean;
  approvals: number;
  request: AgentInspectorRequest;
}

export function settingsAgentRooms(rooms: readonly DesktopAccountRoomEntry[]) {
  return [...new Map(rooms.filter(room => !room.archived).flatMap(room => [room, ...room.focusRooms])
    .map(room => [room.roomIdentifier, { id: room.roomIdentifier, name: room.displayName || room.name }])).values()];
}

/** Use the same state and exact identity projections as the room inspector. */
export function settingsAgentRows(input: {
  rooms: readonly { id: string; name: string }[];
  entries: readonly DesktopSupervisorManifestEntry[];
  supervisorFresh: boolean;
  metadata: ReadonlyMap<string, DesktopRoomLiveMetadata>;
  staleRooms: ReadonlySet<string>;
  approvals: readonly DesktopHostApproval[];
}): SettingsAgentRow[] {
  const rows: SettingsAgentRow[] = [];
  for (const room of input.rooms) {
    const entries = input.entries.filter(entry => entry.roomId === room.id);
    for (const projection of projectAgentInspectors(entries, { roomId: room.id, resourceFreshness: input.supervisorFresh ? "fresh" : "stale" })) {
      const approvals = new Set(input.approvals.filter(approval => approval.presentation.agentId === projection.entryId
        && (approval.status === "pending" || approval.status === "decision_recorded")).map(approval => approval.requestKey || approval.id)).size;
      const retired = projection.overallState === "retired";
      rows.push({
        id: projection.entryId, roomId: room.id, roomName: room.name,
        name: projection.displayName, provider: managedAgentProviderLabel(projection.provider),
        summary: projection.now?.summary || projection.entry.roomAgentState?.task.title || projection.charter || projection.overallDetail,
        searchText: [projection.charter, projection.entry.roomAgentState?.task.title, projection.model, projection.ownerAttribution].filter(Boolean).join(" "),
        status: !input.supervisorFresh ? "Status unavailable" : approvals ? "Approval needed" : projection.overallLabel,
        attention: !retired && (projection.overallState === "needs_attention" || approvals > 0),
        active: ["online", "responding", "starting", "recovering", "reconnecting", "restoring_conversation"].includes(projection.overallState),
        paused: projection.overallState === "paused", retired, external: false, stale: !input.supervisorFresh, approvals,
        request: supervisedAgentInspectorRequest(projection.entry, { displayName: projection.displayName, ownerAttribution: projection.ownerAttribution }),
      });
    }
    const metadata = input.metadata.get(room.id);
    if (!metadata) continue;
    const participants = mergeReachableAgentPresenceParticipants(metadata.participants, metadata.presence, room.id);
    for (const participant of participants) {
      if (participant.kind !== "agent" || participant.hiddenAt) continue;
      const presence = metadata.presence.find(candidate => candidate.roomId === room.id && candidate.sessionKind === "worker"
        && (participant.agentKey ? candidate.agentKey === participant.agentKey : candidate.actorLabel === participant.actorLabel));
      const identity = { agentKey: participant.agentKey, agentSessionId: presence?.agentSessionId ?? null };
      if (resolveSupervisorEntryId(entries, identity).state === "matched") continue;
      const stale = input.staleRooms.has(room.id);
      const external = input.supervisorFresh;
      const active = !stale && (presence?.freshness === "active" || participant.activityState === "active");
      rows.push({
        id: `${room.id}:${participant.participantKey}`, roomId: room.id, roomName: room.name,
        name: participant.displayName, provider: participant.ideLabel || presence?.ideLabel || presence?.runtime || "Other",
        summary: presence?.statusText || (external ? "Managed by its own host" : "Agent controls are unavailable until the service reconnects"),
        searchText: participant.ownerLabel || "",
        status: stale ? "Status unavailable" : active ? "Online" : "Offline",
        attention: !stale && presence?.status === "blocked", active, paused: false, retired: false, external, stale, approvals: 0,
        request: participantAgentInspectorRequest({
          messageId: null, clientMessageId: null, messageSource: null,
          actorLabel: participant.actorLabel, displayName: participant.displayName, sender: participant.displayName,
          ownerAttribution: participant.ownerLabel ? `${participant.ownerLabel}'s agent` : null,
          ideLabel: participant.ideLabel || presence?.runtime || null, ...identity,
        }),
      });
    }
  }
  return rows.sort((a, b) => Number(b.attention) - Number(a.attention) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function filterSettingsAgents(rows: readonly SettingsAgentRow[], filter: SettingsAgentFilter, roomId: string, query: string) {
  const search = query.trim().toLocaleLowerCase();
  return rows.filter(row => (!roomId || row.roomId === roomId)
    && (filter === "retired" ? row.retired : !row.retired)
    && (filter === "all" || filter === "retired" || row[filter])
    && (!search || [row.name, row.provider, row.roomName, row.summary, row.searchText].some(value => value.toLocaleLowerCase().includes(search))));
}
