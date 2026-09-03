import type { SupervisedDeliveryHttp, SupervisedPollResponse } from "./supervised-agent-delivery.js";
import type { DaemonToolAgentSession } from "./supervised-tool-runtime.js";
import type { RemoteExecutionDelegationRevision } from "./execution-delegation-journal.js";
import {
  parseExecutionDelegationDecisionIntent,
  type ExecutionDelegationDecisionIntent,
} from "../../../shared/execution-delegation-decision.mjs";
import { isClearedRoomAgentWorkSummary, parseRoomAgentWorkSummary, type RoomAgentWorkSummary } from "../../../shared/room-agent-work.mjs";

const DEFAULT_ROOM_POLL_MAX_MS = 180_000;
const MAX_ROOM_POLL_MAX_MS = 24 * 60 * 60 * 1_000;
const LIVENESS_GRACE_MS = 30_000;
export const NATIVE_LIVENESS_STALE_AFTER_MS = 90_000;
const CLOUD_REQUEST_TIMEOUT_MS = 20_000;
const EXECUTION_DELEGATION_INVENTORY_PAGE_SIZE = 100;

export interface SupervisorGrantHttp {
  createWorkerSession(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number; roomId: string; agentKey: string; agentInstanceId: string;
    provider: string; displayName: string; signal?: AbortSignal;
  }): Promise<{
    sessionId: string; bearer: string; bearerId: string; expiresAt: string | null;
    /** Exact public identity paired with the worker bearer by the server. */
    agentSession?: DaemonToolAgentSession;
  }>;
  endWorkerSession?(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number; sessionId: string;
  }): Promise<void>;
  renewHostGrant?(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number;
    hostId: string; installationId: string; ttlMs: number;
  }): Promise<{ grantId: string; supervisorGrant: string; grantGeneration: number; expiresAt: string }>;
  getExecutionDelegation(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number;
    delegationInstanceId: string; signal?: AbortSignal;
  }): Promise<RemoteExecutionDelegationRevision>;
  listExecutionDelegationIds(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number;
    roomId: string; agentKey: string; after: string | null; signal?: AbortSignal;
  }): Promise<{ delegationInstanceIds: string[]; nextCursor: string | null }>;
  getExecutionDelegationDecision?(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number;
    decisionId: string; signal?: AbortSignal;
  }): Promise<ExecutionDelegationDecisionIntent>;
  listExecutionDelegationDecisionIds?(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number;
    roomId: string; agentKey: string; after: string | null; signal?: AbortSignal;
  }): Promise<{ decisionIds: string[]; nextCursor: string | null }>;
}

export class SupervisorGrantRequestError extends Error {
  constructor(readonly status: number, operation: string) {
    super(`${operation} failed with HTTP ${status}.`);
  }
}

export function supervisedProviderLabel(provider: string): string {
  switch (provider.trim().toLowerCase()) {
    case "codex": return "Codex";
    case "claude":
    case "claude-code": return "Claude Code";
    case "antigravity": return "Antigravity";
    case "cursor": return "Cursor";
    case "open-model":
    case "open_model": return "Open Model";
    default: return provider.trim() || "Agent";
  }
}

function supervisedRoomPath(roomId: string): string {
  return roomId.split("/").map(encodeURIComponent).join("/");
}

export function hostGrantApiOrigin(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Host grant api_url must be HTTPS or exact loopback HTTP.");
  }
  return url.origin;
}

export function lastRoomMessageId(messages: readonly Record<string, unknown>[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const id = messages[index]?.id;
    if (typeof id === "string" && id.trim()) return id;
  }
  return null;
}

// Cloud requests hold daemon serialization locks while they run, and a fetch
// with no deadline waits ~300s for headers by default. Every request therefore
// carries a bounded deadline composed with the caller's signal.
function boundedCloudSignal(signal?: AbortSignal, timeoutMs = CLOUD_REQUEST_TIMEOUT_MS): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function parseExecutionDelegationResponse(
  value: unknown,
  expectedInstanceId: string,
): RemoteExecutionDelegationRevision {
  const body = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const raw = body?.delegation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Execution delegation response omitted its delegation.");
  }
  const record = raw as Record<string, unknown>;
  const requiredString = (name: string): string => {
    const item = record[name];
    if (typeof item !== "string" || !item.trim() || item.trim() !== item) {
      throw new Error(`Execution delegation response omitted ${name}.`);
    }
    return item;
  };
  const timestamp = (name: string, nullable = false): number | null => {
    if (nullable && record[name] === null) return null;
    const parsed = Date.parse(requiredString(name));
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`Execution delegation response returned invalid ${name}.`);
    }
    return parsed;
  };
  const delegationInstanceId = requiredString("delegation_instance_id");
  const revision = Number(record.revision);
  const scopeSha256 = requiredString("scope_sha256");
  if (delegationInstanceId !== expectedInstanceId
    || !Number.isSafeInteger(revision) || revision < 1
    || record.category !== "file_change" || record.risk_ceiling !== "low"
    || !/^[0-9a-f]{64}$/.test(scopeSha256)) {
    throw new Error("Execution delegation response returned a different authority identity.");
  }
  return {
    delegationInstanceId,
    revision,
    ownerAccountId: requiredString("owner_account_id"),
    roomId: requiredString("room_id"),
    agentKey: requiredString("agent_key"),
    approverAccountId: requiredString("approver_account_id"),
    category: "file_change",
    riskCeiling: "low",
    scopeSha256,
    createdAtMs: timestamp("created_at")!,
    expiresAtMs: timestamp("expires_at")!,
    revokedAtMs: timestamp("revoked_at", true),
  };
}

function parseExecutionDelegationInventoryPage(
  value: unknown,
  key: "delegation_instance_ids" | "decision_ids",
): { ids: string[]; nextCursor: string | null } {
  const body = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const ids = body?.[key];
  const nextCursor = body?.next_cursor;
  if (!Array.isArray(ids) || ids.length > EXECUTION_DELEGATION_INVENTORY_PAGE_SIZE
    || ids.some((id) => typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 512)
    || new Set(ids).size !== ids.length
    || ids.some((id, index) => index > 0 && id <= ids[index - 1]!)
    || (nextCursor !== null && (typeof nextCursor !== "string" || !nextCursor.trim()))
    || (nextCursor !== null && nextCursor !== ids.at(-1))) {
    throw new Error("Execution delegation inventory returned an invalid page.");
  }
  return { ids: ids as string[], nextCursor: nextCursor as string | null };
}

export type RoomWorkPublishInput = {
  apiOrigin: string; grantId: string; supervisorGrant: string; grantGeneration: number;
  sessionId: string; roomId: string; sourceMessageId: string; agentKey: string;
  revision: number; summary: RoomAgentWorkSummary; signal: AbortSignal;
};
export type RoomWorkPublishResult = "acknowledged" | "cleared" | "conflict";

/** Optional evidence publication. This must never renew credentials or execute work. */
export async function publishRoomWork(input: RoomWorkPublishInput): Promise<RoomWorkPublishResult> {
  const summary = parseRoomAgentWorkSummary(input.summary);
  if (!summary || hostGrantApiOrigin(input.apiOrigin) !== input.apiOrigin) throw new Error("Invalid room work publication.");
  const response = await fetch(`${input.apiOrigin}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/worker-sessions/${encodeURIComponent(input.sessionId)}/agent-work`, {
    method: "POST", redirect: "error",
    headers: { authorization: `Bearer ${input.supervisorGrant}`, "content-type": "application/json", "x-letagents-supervisor-generation": String(input.grantGeneration) },
    body: JSON.stringify({ generation: input.grantGeneration, room_id: input.roomId,
      source_message_id: input.sourceMessageId, revision: input.revision, summary }),
    signal: boundedCloudSignal(input.signal),
  });
  const body = await response.json() as Record<string, unknown>;
  if (response.status === 409 && body.code === "payload_cleared") return "cleared";
  if (response.status === 409 && ["publisher_conflict", "revision_conflict"].includes(String(body.code))) return "conflict";
  if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Room work publication");
  const work = body.work as Record<string, unknown> | undefined;
  if (!["created", "updated", "replayed"].includes(String(body.status)) || !work
    || typeof work.attempt_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(work.attempt_id)
    || work.room_id !== input.roomId || work.source_message_id !== input.sourceMessageId
    || work.agent_key !== input.agentKey || work.revision !== input.revision) {
    throw new Error("Room work publication returned a different receipt.");
  }
  if (body.status === "replayed" && isClearedRoomAgentWorkSummary(work.summary)) return "cleared";
  const accepted = parseRoomAgentWorkSummary(work.summary);
  if (!accepted || JSON.stringify(accepted) !== JSON.stringify(summary)) throw new Error("Room work publication returned a different summary.");
  return "acknowledged";
}

/** The daemon talks to the room API only through the live worker bearer. */
export const productionSupervisedDeliveryHttp: SupervisedDeliveryHttp = {
  admissionOwnsInitialCursor: true,
  async poll(input) {
    const query = new URLSearchParams({ timeout: String(DEFAULT_ROOM_POLL_MAX_MS) });
    if (input.afterMessageId) query.set("after", input.afterMessageId);
    const response = await fetch(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/messages/poll?${query}`, {
      headers: { authorization: `Bearer ${input.bearer}` },
      signal: boundedCloudSignal(input.signal, DEFAULT_ROOM_POLL_MAX_MS + 20_000),
    });
    if (!response.ok) throw new Error(`Supervised room poll failed with HTTP ${response.status}.`);
    return await response.json() as SupervisedPollResponse;
  },
  async latest(input) {
    const response = await fetch(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/messages?limit=1&before=latest`, {
      headers: { authorization: `Bearer ${input.bearer}` }, signal: boundedCloudSignal(input.signal),
    });
    if (!response.ok) throw new Error(`Supervised room tail read failed with HTTP ${response.status}.`);
    return await response.json() as { messages?: Array<Record<string, unknown>> };
  },
  async joinRoom(input) {
    const response = await fetch(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/join`, {
      method: "POST", headers: { authorization: `Bearer ${input.bearer}`, "content-type": "application/json" }, body: "{}", signal: boundedCloudSignal(input.signal),
    });
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Destination room join");
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const roomId = typeof body.room_id === "string" && body.room_id.trim() ? body.room_id.trim()
      : typeof body.id === "string" && body.id.trim() ? body.id.trim() : input.roomId;
    return { roomId };
  },
  async publish(input) {
    const response = await fetch(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({
        sender: "supervised-daemon",
        text: input.text,
        client_message_id: input.clientMessageId,
        ...(input.replyTo && input.threadRootId
          ? { reply_to: input.replyTo, thread_root_id: input.threadRootId }
          : {}),
      }),
      signal: boundedCloudSignal(input.signal),
    });
    if (!response.ok) throw new Error(`Supervised room publication failed with HTTP ${response.status}.`);
    const message = await response.json() as Record<string, unknown>;
    const messageId = typeof message.id === "string" && message.id.trim() ? message.id : null;
    const roomId = typeof message.room_id === "string" && message.room_id.trim() ? message.room_id : null;
    if (!messageId || !roomId || roomId !== input.roomId) throw new Error("Supervised room publication response omitted its canonical message identity.");
    return { messageId, roomId };
  },
};

/** Host grants and worker bearers are process-memory values, never daemon state. */
export const productionSupervisorGrantHttp: SupervisorGrantHttp & Required<Pick<SupervisorGrantHttp,
  "getExecutionDelegationDecision" | "listExecutionDelegationDecisionIds">> = {
  async createWorkerSession(input) {
    const ideLabel = supervisedProviderLabel(input.provider);
    const response = await fetch(`${input.apiUrl}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/worker-sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.supervisorGrant}`, "content-type": "application/json", "x-letagents-supervisor-generation": String(input.grantGeneration) },
      body: JSON.stringify({
        generation: input.grantGeneration,
        room_id: input.roomId,
        agent_key: input.agentKey,
        agent_instance_id: input.agentInstanceId,
        display_name: input.displayName,
        runtime: input.provider,
        ide_label: ideLabel,
      }),
      signal: boundedCloudSignal(input.signal),
    });
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Supervisor worker session mint");
    const body = await response.json() as Record<string, unknown>;
    const requireString = (name: string) => {
      const value = body[name];
      if (typeof value !== "string" || !value.trim()) throw new Error(`Supervisor worker session response omitted ${name}.`);
      return value;
    };
    const sessionKind = requireString("session_kind");
    if (sessionKind !== "worker") throw new Error("Supervisor worker session response returned a non-worker identity.");
    const endedAt = body.ended_at;
    if (endedAt !== null) throw new Error("Supervisor worker session response returned an ended identity.");
    const agentSession: DaemonToolAgentSession = {
      session_id: requireString("session_id"), session_token: "", room_id: requireString("room_id"),
      session_kind: "worker", runtime: requireString("runtime"), actor_label: requireString("actor_label"),
      agent_key: requireString("agent_key"), agent_instance_id: requireString("agent_instance_id"),
      display_name: requireString("display_name"), owner_label: requireString("owner_label"),
      ide_label: requireString("ide_label"), created_at: requireString("created_at"),
      updated_at: requireString("updated_at"), last_seen_at: requireString("last_seen_at"), ended_at: null,
    };
    if (agentSession.room_id !== input.roomId
      || agentSession.runtime !== input.provider
      || agentSession.agent_key !== input.agentKey
      || agentSession.agent_instance_id !== input.agentInstanceId) {
      throw new Error("Supervisor worker session response returned a different authority identity.");
    }
    return {
      sessionId: agentSession.session_id, bearer: requireString("worker_bearer"), bearerId: requireString("worker_bearer_id"),
      expiresAt: typeof body.worker_bearer_expires_at === "string" ? body.worker_bearer_expires_at : null,
      agentSession,
    };
  },
  async endWorkerSession(input) {
    const response = await fetch(`${input.apiUrl}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/worker-sessions/${encodeURIComponent(input.sessionId)}/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.supervisorGrant}`, "content-type": "application/json", "x-letagents-supervisor-generation": String(input.grantGeneration) },
      body: JSON.stringify({ generation: input.grantGeneration }),
      signal: boundedCloudSignal(),
    });
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Supervisor worker session end");
  },
  async renewHostGrant(input) {
    const response = await fetch(`${input.apiUrl}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/renew`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.supervisorGrant}`, "content-type": "application/json", "x-letagents-supervisor-generation": String(input.grantGeneration) },
      body: JSON.stringify({
        generation: input.grantGeneration, host_id: input.hostId,
        installation_id: input.installationId, ttl_ms: input.ttlMs,
      }),
      signal: boundedCloudSignal(),
    });
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Supervisor host grant renewal");
    const body = await response.json() as Record<string, unknown>;
    const requireString = (name: string) => {
      const value = body[name];
      if (typeof value !== "string" || !value.trim()) throw new Error(`Supervisor grant renewal response omitted ${name}.`);
      return value;
    };
    const generation = Number(body.current_generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Supervisor grant renewal response omitted current_generation.");
    return {
      grantId: requireString("grant_id"), supervisorGrant: requireString("supervisor_grant"),
      grantGeneration: generation, expiresAt: requireString("expires_at"),
    };
  },
  async getExecutionDelegation(input) {
    const apiOrigin = hostGrantApiOrigin(input.apiUrl);
    const response = await fetch(
      `${apiOrigin}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/execution-delegations/${encodeURIComponent(input.delegationInstanceId)}`,
      {
        headers: {
          authorization: `Bearer ${input.supervisorGrant}`,
          "x-letagents-supervisor-generation": String(input.grantGeneration),
        },
        signal: boundedCloudSignal(input.signal),
      },
    );
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Execution delegation read");
    return parseExecutionDelegationResponse(await response.json(), input.delegationInstanceId);
  },
  async listExecutionDelegationIds(input) {
    const apiOrigin = hostGrantApiOrigin(input.apiUrl);
    const query = new URLSearchParams({ room_id: input.roomId, agent_key: input.agentKey });
    if (input.after) query.set("after", input.after);
    const response = await fetch(
      `${apiOrigin}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/execution-delegations?${query}`,
      {
        headers: {
          authorization: `Bearer ${input.supervisorGrant}`,
          "x-letagents-supervisor-generation": String(input.grantGeneration),
        },
        signal: boundedCloudSignal(input.signal),
      },
    );
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Execution delegation inventory");
    const page = parseExecutionDelegationInventoryPage(await response.json(), "delegation_instance_ids");
    return { delegationInstanceIds: page.ids, nextCursor: page.nextCursor };
  },
  async getExecutionDelegationDecision(input) {
    const apiOrigin = hostGrantApiOrigin(input.apiUrl);
    const response = await fetch(
      `${apiOrigin}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/execution-delegation-decisions/${encodeURIComponent(input.decisionId)}`,
      {
        headers: {
          authorization: `Bearer ${input.supervisorGrant}`,
          "x-letagents-supervisor-generation": String(input.grantGeneration),
        },
        signal: boundedCloudSignal(input.signal),
      },
    );
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Execution delegation decision read");
    const body = await response.json() as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || !Object.hasOwn(body, "decision")) {
      throw new Error("Execution delegation decision response returned an invalid wrapper.");
    }
    const decision = parseExecutionDelegationDecisionIntent(body.decision);
    if (!decision || decision.decision_id !== input.decisionId) {
      throw new Error("Execution delegation decision response returned a different intent.");
    }
    return decision;
  },
  async listExecutionDelegationDecisionIds(input) {
    const apiOrigin = hostGrantApiOrigin(input.apiUrl);
    const query = new URLSearchParams({ room_id: input.roomId, agent_key: input.agentKey });
    if (input.after) query.set("after", input.after);
    const response = await fetch(
      `${apiOrigin}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/execution-delegation-decisions?${query}`,
      {
        headers: {
          authorization: `Bearer ${input.supervisorGrant}`,
          "x-letagents-supervisor-generation": String(input.grantGeneration),
        },
        signal: boundedCloudSignal(input.signal),
      },
    );
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Execution delegation decision inventory");
    const page = parseExecutionDelegationInventoryPage(await response.json(), "decision_ids");
    return { decisionIds: page.ids, nextCursor: page.nextCursor };
  },
};

export async function publishWorkerNativeActivity(input: {
  apiUrl: string;
  roomId: string;
  agentSessionId: string;
  bearer: string;
  observedAt: string;
  sequence: number;
  method: string;
  status: "working" | "idle";
  operation: string;
}): Promise<boolean> {
  const roomPath = supervisedRoomPath(input.roomId);
  const endpoint = `${input.apiUrl}/rooms/${roomPath}/agent-sessions/${encodeURIComponent(input.agentSessionId)}/native-activity`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${input.bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      observed_at: input.observedAt,
      sequence: input.sequence,
      method: input.method,
      status: input.status,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Native activity endpoint rejected ${input.operation} with HTTP ${response.status}.`);
  const payload = await response.json() as { accepted?: boolean };
  return payload.accepted !== false;
}

/** Room waits are normally long polls, so reachability must outlive one poll. */
export function workplaceLivenessStaleAfterMs(rawPollMaxMs = process.env.LETAGENTS_POLL_MAX_MS): number {
  const parsed = rawPollMaxMs == null || rawPollMaxMs === ""
    ? Number.NaN
    : Number.parseInt(String(rawPollMaxMs), 10);
  const pollMaxMs = Number.isNaN(parsed) || parsed < 1_000
    ? DEFAULT_ROOM_POLL_MAX_MS
    : Math.min(parsed, MAX_ROOM_POLL_MAX_MS);
  return Math.max(NATIVE_LIVENESS_STALE_AFTER_MS, pollMaxMs + LIVENESS_GRACE_MS);
}
