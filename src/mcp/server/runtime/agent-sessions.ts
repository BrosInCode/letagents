import {
  getStoredAgentSession,
  isLocalRoomStorageEnabled,
  saveAgentSession,
  type StoredAgentIdentityState,
  type StoredAgentSessionState,
} from "../../local-state.js";
import { getGitCurrentBranch } from "../../git-remote.js";
import { randomUUID } from "node:crypto";
import { normalizeAgentBaseName } from "../../../shared/codenames.js";
import { formatOwnerAttribution } from "../../../shared/agent-identity.js";
import {
  LETAGENTS_AGENT_SESSION_ID_HEADER,
  LETAGENTS_AGENT_SESSION_TOKEN_HEADER,
} from "../../../shared/request-headers.js";
import {
  AGENT_INSTANCE_UUID,
  detectAgentIdeLabel,
  detectAgentRuntimeLabel,
  ensureAgentIdentity,
} from "./identity.js";
import { requireValidWorkerBearerRuntime } from "./worker-bearer.js";

// A worker bearer already represents a server-side worker session. This local
// marker lets the MCP tool contract stay session-shaped without persisting or
// transmitting a second set of credentials.
export const WORKER_BEARER_AGENT_SESSION_ID = "worker_bearer";

export function buildAgentDeliveryHeaders(
  agentSession?: StoredAgentSessionState | null
): Record<string, string> {
  if (!agentSession || requireValidWorkerBearerRuntime().mode === "worker") {
    return {};
  }

  return {
    [LETAGENTS_AGENT_SESSION_ID_HEADER]: agentSession.session_id,
    [LETAGENTS_AGENT_SESSION_TOKEN_HEADER]: agentSession.session_token,
  };
}

export function toPublicAgentSession(session: StoredAgentSessionState | null): Record<string, unknown> | null {
  if (!session) {
    return null;
  }

  return {
    session_id: session.session_id,
    room_id: session.room_id,
    session_kind: session.session_kind,
    runtime: session.runtime,
    host_id: session.host_id ?? null,
    host_kind: session.host_kind ?? null,
    host_label: session.host_label ?? null,
    liveness_capability: session.liveness_capability ?? null,
    tool_bridge_id: session.tool_bridge_id ?? null,
    actor_label: session.actor_label,
    agent_key: session.agent_key,
    agent_instance_id: session.agent_instance_id ?? null,
    display_name: session.display_name,
    owner_label: session.owner_label,
    ide_label: session.ide_label,
    repo_branch: session.repo_branch ?? null,
    created_at: session.created_at,
    updated_at: session.updated_at,
    last_seen_at: session.last_seen_at,
    ended_at: session.ended_at ?? null,
  };
}

export function resolveAgentSession(
  roomId: string | null | undefined,
  sessionId?: string | null
): StoredAgentSessionState | null {
  if (!sessionId) {
    return null;
  }
  const session = getStoredAgentSession(sessionId);
  if (!session) {
    throw new Error(`Unknown agent_session_id: ${sessionId}`);
  }
  if (session.ended_at) {
    throw new Error(`agent_session_id ${sessionId} ended at ${session.ended_at}`);
  }
  if (roomId && session.room_id !== roomId) {
    throw new Error(`agent_session_id ${sessionId} is registered for ${session.room_id}, not ${roomId}`);
  }
  return session;
}

/**
 * The stable base this client declares as `requested_base_display_name` when
 * registering. Rules (task_66):
 * - An explicit display_name that replays the EXACT label of any prior stored
 *   session for this room+identity is a resume, not a rename: reuse the base
 *   recorded when THAT label was allocated, so a server-decorated label
 *   converges. The whole lineage is consulted (most recent first) because a
 *   latest-only lookup would lose an older concurrent sibling's base and
 *   misread its restart as a deliberate rename.
 * - Any other explicit display_name is deliberate intent and IS the base —
 *   a numeric-ending custom name ("Agent 47") is therefore never demoted.
 * - With no explicit name, fall back to the most recent recorded base in the
 *   lineage, then to the durable identity's display name.
 */
export function resolveClientRequestedBase(input: {
  explicitDisplayName?: string | null;
  identityDisplayName: string;
  priorSessions?: readonly Pick<StoredAgentSessionState, "display_name" | "requested_base_display_name">[] | null;
}): string {
  const explicit = input.explicitDisplayName?.trim() || "";
  const lineage = input.priorSessions ?? [];
  if (explicit) {
    const replayed = lineage.find((session) => session.display_name?.trim() === explicit);
    const replayedBase = replayed?.requested_base_display_name?.trim() || "";
    return replayedBase || explicit;
  }
  const latestBase = lineage
    .map((session) => session.requested_base_display_name?.trim() || "")
    .find((base) => base.length > 0);
  return latestBase || input.identityDisplayName.trim();
}

export function identityFromAgentSession(session: StoredAgentSessionState): StoredAgentIdentityState {
  return {
    name: normalizeAgentBaseName(session.display_name),
    display_name: session.display_name,
    owner_label: session.owner_label,
    owner_attribution: formatOwnerAttribution(session.owner_label),
    ide_label: session.ide_label,
    actor_label: session.actor_label,
    canonical_key: session.agent_key,
    runtime_key: `agent_session:${session.session_id}`,
    source: "api",
    resolved_at: session.updated_at,
  };
}

export function requireWorkerAgentSession(
  roomId: string | null | undefined,
  sessionId?: string | null
): StoredAgentSessionState {
  const session = resolveAgentSession(roomId, sessionId);
  if (!session) {
    throw new Error(
      "Registered worker agent_session_id is required for this write action. " +
        "Call register_agent_session for this room first, then pass the returned agent_session_id explicitly."
    );
  }
  if (session.session_kind !== "worker") {
    throw new Error("Worker agent_session_id is required for this write action.");
  }
  return session;
}

export async function resolveWorkerToolIdentity(input: {
  roomId?: string | null;
  agentSessionId?: string | null;
}): Promise<{ identity: StoredAgentIdentityState; agentSession: StoredAgentSessionState }> {
  if (
    requireValidWorkerBearerRuntime().mode === "worker" &&
    (!input.agentSessionId || input.agentSessionId === WORKER_BEARER_AGENT_SESSION_ID)
  ) {
    const identity = await ensureAgentIdentity();
    const now = new Date().toISOString();
    return {
      identity,
      agentSession: {
        session_id: WORKER_BEARER_AGENT_SESSION_ID,
        session_token: "",
        room_id: input.roomId ?? "worker_bearer_room",
        session_kind: "worker",
        runtime: detectAgentRuntimeLabel(),
        host_id: null,
        host_kind: null,
        host_label: null,
        liveness_capability: null,
        tool_bridge_id: null,
        actor_label: identity.actor_label,
        agent_key: identity.canonical_key ?? identity.runtime_key ?? identity.actor_label,
        agent_instance_id: AGENT_INSTANCE_UUID,
        display_name: identity.display_name,
        owner_label: identity.owner_label,
        ide_label: identity.ide_label ?? detectAgentIdeLabel(),
        repo_branch: null,
        created_at: now,
        updated_at: now,
        last_seen_at: now,
        ended_at: null,
      },
    };
  }
  const agentSession = input.agentSessionId
    ? requireWorkerAgentSession(input.roomId, input.agentSessionId)
    : input.roomId && await isLocalRoomStorageEnabled(input.roomId)
      ? await ensureLocalWorkerAgentSession(input.roomId)
      : requireWorkerAgentSession(input.roomId, input.agentSessionId);
  return {
    identity: identityFromAgentSession(agentSession),
    agentSession,
  };
}

export async function ensureLocalWorkerAgentSession(
  roomId: string,
  input: {
    sessionKind?: "worker" | "controller";
    runtime?: string | null;
    displayName?: string | null;
    repoBranch?: string | null;
  } = {},
): Promise<StoredAgentSessionState> {
  const identity = await ensureAgentIdentity();
  const now = new Date().toISOString();
  const runtime = input.runtime?.trim() || detectAgentRuntimeLabel();
  const displayName = input.displayName?.trim() || identity.display_name;
  return saveAgentSession({
    session_id: `local_${randomUUID()}`,
    session_token: `local_${randomUUID()}`,
    room_id: roomId,
    session_kind: input.sessionKind ?? "worker",
    runtime,
    host_id: null,
    host_kind: "local",
    host_label: "Local device",
    liveness_capability: null,
    tool_bridge_id: null,
    actor_label: identity.actor_label,
    agent_key: identity.canonical_key || identity.runtime_key || identity.actor_label,
    agent_instance_id: AGENT_INSTANCE_UUID,
    display_name: displayName,
    owner_label: identity.owner_label,
    ide_label: identity.ide_label ?? detectAgentIdeLabel(),
    repo_branch: input.repoBranch ?? null,
    created_at: now,
    updated_at: now,
    last_seen_at: now,
    ended_at: null,
  });
}

export function getAgentSessionRepoBranch(cwd?: string | null): string | null {
  const workingDir = cwd?.trim() || process.cwd();
  return getGitCurrentBranch(workingDir);
}

export function agentSessionCredentials(agentSession: StoredAgentSessionState): Record<string, string> {
  if (requireValidWorkerBearerRuntime().mode === "worker") {
    return {};
  }
  return {
    agent_session_id: agentSession.session_id,
    agent_session_token: agentSession.session_token,
  };
}
