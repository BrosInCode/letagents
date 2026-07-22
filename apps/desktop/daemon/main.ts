import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { AuditLog } from "./audit-log.js";
import { DaemonControlSocket } from "./control-socket.js";
import { redactCredentialText, sanitizeDaemonActivityEvent } from "./credential-redaction.js";
import { WorkDurabilityStore } from "./durability-store.js";
import { projectDaemonCreateRequestReplayParameters, serializeDaemonDeploymentId } from "./manifest-entry-projection.js";
import { ManifestConflictError, ManifestStore } from "./manifest-store.js";
import { assertMacOS } from "./platform.js";
import type { ProviderActionAttachTerminal, ProviderActionHandle, ProviderActionPort, ProviderActionRef, ProviderActionSpawn, ProviderActionStreamEvent, ProviderActionTerminal, ProviderTurnControlResult } from "./provider-action-port.js";
import { CRASH_LOOP_EXIT_LIMIT, CRASH_LOOP_WINDOW_MS } from "./reconciler-policy.js";
import { ProviderReconciler, type ReconcilerExecutionInput } from "./reconciler-runner.js";
import { advanceReconciliationState, beginReconciliationAction, completeReconciliationAction, recordReconciliationActionFailure, rememberCompletedControlAction } from "./reconciler-state.js";
import { DaemonFenceLostError, DaemonSingleton, defaultDaemonPaths } from "./singleton.js";
import { DAEMON_IMPLEMENTATION_VERSION, DAEMON_PROTOCOL_VERSION, type DaemonActivityEvent, type DaemonDeliveryCutover, type DaemonManifestEntry, type DaemonManifestEntryView, type DaemonRequest, type DesiredState, type ExecutionTerminalPayload, type LegacyLaneOwner, type ObservedState, type PolicyCondition, type ReconciliationNotice } from "./types.js";
import { devMcpServerEntryFromEnv } from "./dev-spawn-options.js";
import { createGitCommand, repositoryStorageKey, WorkspaceProvisioner, type GitCommand } from "./workspace-provisioner.js";
import { WorkerBindingStore, type WorkerSessionBinding } from "./worker-binding-store.js";
import { SupervisedAgentInboxStore, type SupervisedInboxReceiptWithTimeline } from "./supervised-agent-inbox-store.js";
import { SupervisedAgentDelivery, type SupervisedDeliveryAuthority, type SupervisedDeliveryHttp } from "./supervised-agent-delivery.js";

type DaemonPaths = Pick<ReturnType<typeof defaultDaemonPaths>, "lockPath" | "socketPath" | "manifestPath" | "auditPath"> & Partial<Pick<ReturnType<typeof defaultDaemonPaths>, "legacyManifestPath" | "attemptsPath" | "attemptsRoot" | "workspaceRoot" | "workerBindingsPath">>;
type LiveBindingIdentity = { agentSessionId: string; executionGenerationId: string; updatedAt: string };
type PendingResumeBinding = {
  roomId: string;
  workAttemptId: string;
  predecessorExecutionGenerationId: string;
  successorExecutionGenerationId: string;
  agentSessionId: string;
  providerContinuationId: string;
};
type SupervisedWaitEvidence = { roomCursor: string; agentSessionId: string };
type RecoveryClock = {
  nowMs?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};
export interface SupervisorGrantHttp {
  createWorkerSession(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number; roomId: string; agentKey: string; agentInstanceId: string; signal?: AbortSignal;
  }): Promise<{ sessionId: string; bearer: string; bearerId: string; expiresAt: string | null }>;
  renewHostGrant?(input: {
    apiUrl: string; grantId: string; supervisorGrant: string; grantGeneration: number;
    hostId: string; installationId: string; ttlMs: number;
  }): Promise<{ grantId: string; supervisorGrant: string; grantGeneration: number; expiresAt: string }>;
}
export class SupervisorGrantRequestError extends Error {
  constructor(readonly status: number, operation: string) {
    super(`${operation} failed with HTTP ${status}.`);
  }
}
class InvalidSupervisorGrantRenewalError extends Error {}
type InstalledHostGrant = {
  entryId: string; roomId: string; agentKey: string; grantId: string; supervisorGrant: string;
  grantGeneration: number; apiUrl: string; daemonGeneration: number;
  hostId: string; installationId: string; expiresAt: string;
};
/** A short-lived, process-only worker bearer.  It is intentionally never durable. */
type CachedWorkerAuthorization = {
  entryId: string; roomId: string; agentKey: string; workAttemptId: string | null;
  grantId: string; grantGeneration: number; daemonGeneration: number; apiUrl: string;
  agentSessionId: string; bearer: string; bearerId: string; expiresAt: string | null; mintedAtMs: number;
};
type BootstrapOperation = {
  controller: AbortController;
  phase: "observing" | "committing";
  operation: Promise<unknown>;
};

const DEFAULT_ROOM_POLL_MAX_MS = 180_000;
const MAX_ROOM_POLL_MAX_MS = 24 * 60 * 60 * 1_000;
const LIVENESS_GRACE_MS = 30_000;
const NATIVE_LIVENESS_STALE_AFTER_MS = 90_000;
const WORKER_BEARER_ROTATION_LEAD_MS = 60_000;
const HOST_GRANT_TTL_MS = 24 * 60 * 60 * 1_000;
const HOST_GRANT_RENEWAL_LEAD_MS = 60 * 60 * 1_000;
// Electron's ordinary control-socket request times out at 3s. Keep the
// admission boundary inside that window: after Electron gives up, a late
// first-tail write would be both surprising and hard to surface to the user.
const BOOTSTRAP_ROOM_INGRESS_TIMEOUT_MS = 2_500;
const WORKER_MINT_TIMEOUT_MS = 2_000;
const WORKER_MINT_MAX_ATTEMPTS = 3;
const WORKER_MINT_RETRY_DELAY_MS = 100;
const WORKER_MINT_FALLBACK_FRESH_MS = 2 * 60_000;

function schedulerErrorDetail(error: unknown, depth = 0): string {
  if (depth > 3) return "nested error omitted";
  if (!(error instanceof Error)) return redactCredentialText(String(error || "unknown error")).value;
  const cause = (error as Error & { cause?: unknown }).cause;
  const detail = cause === undefined ? error.message : `${error.message}; cause: ${schedulerErrorDetail(cause, depth + 1)}`;
  return redactCredentialText(detail).value;
}

function retryableWorkerMintFailure(error: unknown): boolean {
  if (!(error instanceof SupervisorGrantRequestError)) return true;
  return error.status >= 500 || [408, 425, 429].includes(error.status);
}

class WorkerCredentialMintError extends Error {
  constructor(
    readonly attempts: number,
    readonly retryable: boolean,
    cause: unknown,
  ) {
    super(`Worker credential mint failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${schedulerErrorDetail(cause)}`, { cause });
    this.name = "WorkerCredentialMintError";
  }
}

function exhaustedTransientWorkerMint(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof WorkerCredentialMintError) return current.retryable;
    if (!(current instanceof Error)) return false;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

function supervisedRoomPath(roomId: string): string {
  return roomId.split("/").map(encodeURIComponent).join("/");
}

function hostGrantApiOrigin(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Host grant api_url must be HTTPS or exact loopback HTTP.");
  }
  return url.origin;
}

function lastRoomMessageId(messages: readonly Record<string, unknown>[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const id = messages[index]?.id;
    if (typeof id === "string" && id.trim()) return id;
  }
  return null;
}

/** The daemon talks to the room API only through the live worker bearer. */
const productionSupervisedDeliveryHttp: SupervisedDeliveryHttp = {
  admissionOwnsInitialCursor: true,
  async poll(input) {
    const query = new URLSearchParams({ timeout: String(DEFAULT_ROOM_POLL_MAX_MS) });
    if (input.afterMessageId) query.set("after", input.afterMessageId);
    const response = await fetch(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/messages/poll?${query}`, {
      headers: { authorization: `Bearer ${input.bearer}` }, signal: input.signal,
    });
    if (!response.ok) throw new Error(`Supervised room poll failed with HTTP ${response.status}.`);
    return await response.json() as { messages?: Array<Record<string, unknown>>; has_more?: boolean };
  },
  async latest(input) {
    const response = await fetch(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/messages?limit=1&before=latest`, {
      headers: { authorization: `Bearer ${input.bearer}` }, signal: input.signal,
    });
    if (!response.ok) throw new Error(`Supervised room tail read failed with HTTP ${response.status}.`);
    return await response.json() as { messages?: Array<Record<string, unknown>> };
  },
  async publish(input) {
    const response = await fetch(`${input.apiUrl}/rooms/${supervisedRoomPath(input.roomId)}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ sender: "supervised-daemon", text: input.text, client_message_id: input.clientMessageId }),
      signal: input.signal,
    });
    if (!response.ok) throw new Error(`Supervised room publication failed with HTTP ${response.status}.`);
  },
};

/** Host grants and worker bearers are process-memory values, never daemon state. */
const productionSupervisorGrantHttp: SupervisorGrantHttp = {
  async createWorkerSession(input) {
    const response = await fetch(`${input.apiUrl}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/worker-sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.supervisorGrant}`, "content-type": "application/json", "x-letagents-supervisor-generation": String(input.grantGeneration) },
      body: JSON.stringify({ generation: input.grantGeneration, room_id: input.roomId, agent_key: input.agentKey, agent_instance_id: input.agentInstanceId, runtime: "supervisor" }),
      signal: input.signal,
    });
    if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Supervisor worker session mint");
    const body = await response.json() as Record<string, unknown>;
    const requireString = (name: string) => {
      const value = body[name];
      if (typeof value !== "string" || !value.trim()) throw new Error(`Supervisor worker session response omitted ${name}.`);
      return value;
    };
    return {
      sessionId: requireString("session_id"), bearer: requireString("worker_bearer"), bearerId: requireString("worker_bearer_id"),
      expiresAt: typeof body.worker_bearer_expires_at === "string" ? body.worker_bearer_expires_at : null,
    };
  },
  async renewHostGrant(input) {
    const response = await fetch(`${input.apiUrl}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/renew`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.supervisorGrant}`, "content-type": "application/json", "x-letagents-supervisor-generation": String(input.grantGeneration) },
      body: JSON.stringify({
        generation: input.grantGeneration, host_id: input.hostId,
        installation_id: input.installationId, ttl_ms: input.ttlMs,
      }),
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
};

/** Room waits are normally long polls, so a healthy worker can be silent for
 * the entire configured poll window. Reachability must not expire before that
 * request can return and publish its next exact-binding heartbeat. */
export function workplaceLivenessStaleAfterMs(rawPollMaxMs = process.env.LETAGENTS_POLL_MAX_MS): number {
  // Match src/shared/poll-timeout-cap.ts exactly. The desktop daemon is a
  // separately-built executable, so importing that source would escape its
  // rootDir; keeping the grammar explicit here prevents a malformed operator
  // value from making liveness expire before the real MCP/API poll cap.
  const parsed = rawPollMaxMs == null || rawPollMaxMs === ""
    ? Number.NaN
    : Number.parseInt(String(rawPollMaxMs), 10);
  const pollMaxMs = Number.isNaN(parsed) || parsed < 1_000
    ? DEFAULT_ROOM_POLL_MAX_MS
    : Math.min(parsed, MAX_ROOM_POLL_MAX_MS);
  return Math.max(NATIVE_LIVENESS_STALE_AFTER_MS, pollMaxMs + LIVENESS_GRACE_MS);
}
type DaemonTurnControlResult = ProviderTurnControlResult & {
  entryId: string;
  workAttemptId: string;
  executionGenerationId: string;
  actionId: string;
  duplicate: boolean;
  stages: Array<"delivered" | "interrupting" | "applied" | "resumed" | "already_applied">;
};

export type DaemonReconcileInput = Omit<ReconcilerExecutionInput, "desiredState" | "observedState" | "condition" | "exitsInWindow" | "nextRestartAtMs"> & {
  /** Durable provider-action identity; reused ticks must keep this value. */
  reconciliationActionId: string;
  reconciliationActionSequence: number;
};

class ReplacementListenerInstallError extends Error {}
class DeliveryCutoverObservationDetached extends Error {}

function providerStreamLifecycle(event: ProviderActionStreamEvent): "failed" | "terminal" | "idle" | "working" {
  const method = event.method.trim();
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
  const nestedStatus = (value: unknown): unknown[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [value];
    const record = value as Record<string, unknown>;
    return [value, record.type, record.status];
  };
  const statuses = [
    payload.status,
    payload.subtype,
    payload.threadStatus,
    payload.turnStatus,
    (payload.thread as Record<string, unknown> | undefined)?.status,
    (payload.turn as Record<string, unknown> | undefined)?.status,
    (payload.latestTurn as Record<string, unknown> | undefined)?.status,
    (payload.item as Record<string, unknown> | undefined)?.status,
  ].flatMap(nestedStatus);
  const item = payload.item as Record<string, unknown> | undefined;
  const failedMcpToolCall = /^item\/completed$/i.test(method)
    && item?.type === "mcpToolCall"
    && (item.status === "failed" || Boolean(item.error));
  // A tool can fail while the provider process and persistent worker turn are
  // healthy. In particular, a room long-poll or local supervisor checkpoint
  // timeout is retryable coordination evidence, never a process terminal.
  if (failedMcpToolCall) {
    const failedToolName = [item?.tool, item?.name, item?.toolName, item?.tool_name];
    const failedRoomWait = failedToolName.some((value) => typeof value === "string"
      && (value === "wait_for_messages" || value === "mcp__letagents__wait_for_messages"));
    return failedRoomWait ? "idle" : "working";
  }
  const failedStatus = statuses.some((value) => typeof value === "string" && /^(?:systemError|error|error_during_execution|failed)$/i.test(value));
  const failedMethod = /(?:^|\/)(?:failed|systemError|error_during_execution)$/i.test(method);
  const failedResult = /^result(?:\/|$)/i.test(method) && (payload.is_error === true || failedStatus);
  const failedItem = /^item\/completed$/i.test(method)
    && Boolean((payload.item as Record<string, unknown> | undefined)?.error);
  if (failedMethod
    || failedResult
    || failedItem
    || failedStatus && /^(?:result|turn|thread|item)(?:\/|$)/i.test(method)
    || event.kind === "error" && /^(?:result|turn|thread|item)(?:\/|$)/i.test(method)) return "failed";
  if (/^(?:result(?:\/success)?|turn\/completed|thread\/completed)$/i.test(method)) return "terminal";
  if (/(?:completed|finished|idle|stopped|interrupted)$/i.test(method)) return "idle";
  return "working";
}

/**
 * Recognize a structured LetAgents room wait across native provider payloads.
 * Free text is deliberately ignored: only an actual tool-use envelope (Claude)
 * or an MCP tool lifecycle event (Codex and compatible adapters) can make the
 * supervised worker project as quietly polling.
 */
/**
 * Durable, set-once "reached ready" stamp for a manifest entry. Once an entry
 * has reached ready (running + unblocked + live, with this bind restoring
 * reachability), the timestamp is fixed and never cleared, so a later
 * degradation followed by Stop reads as a lifecycle event rather than a
 * cancelled launch. `clearsCoordinationLatch` is true when this bind clears the
 * normal pre-bind coordination latch (running + coordination_blocked).
 */
export function resolveReadyReachedAt(
  current: Pick<DaemonManifestEntry, "desired_state" | "observed_state" | "condition" | "ready_reached_at">,
  clearsCoordinationLatch: boolean,
  now: string,
): string | null {
  if (current.ready_reached_at) return current.ready_reached_at;
  const resultingObserved = clearsCoordinationLatch ? "working" : current.observed_state;
  const resultingCondition = clearsCoordinationLatch ? "none" : current.condition;
  const reachedReady = current.desired_state === "running"
    && resultingCondition === "none"
    && (resultingObserved === "working" || resultingObserved === "idle" || resultingObserved === "checkpointing");
  return reachedReady ? now : null;
}

export function isSupervisedWaitProviderEvent(event: ProviderActionStreamEvent): boolean {
  const isWaitName = (value: unknown): boolean => typeof value === "string"
    && (value === "wait_for_messages" || value === "mcp__letagents__wait_for_messages");
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 8 || !value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some((item) => visit(item, depth + 1));
    const record = value as Record<string, unknown>;
    if (record.type === "tool_use" && isWaitName(record.name)) return true;
    if (event.method === "item/started" && record.type === "mcpToolCall") {
      if ([record.tool, record.name, record.toolName, record.tool_name].some(isWaitName)) return true;
    }
    return Object.values(record).some((child) => visit(child, depth + 1));
  };
  return visit(event.payload, 0);
}

type PollActivityLike = Pick<ProviderActionStreamEvent, "method" | "payload">;

function supervisedWaitToolUseIds(event: PollActivityLike): Set<string> {
  const ids = new Set<string>();
  const isWaitName = (value: unknown): boolean => typeof value === "string"
    && (value === "wait_for_messages" || value === "mcp__letagents__wait_for_messages");
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const waitTool = record.type === "tool_use" && isWaitName(record.name)
      || event.method === "item/started" && record.type === "mcpToolCall"
        && [record.tool, record.name, record.toolName, record.tool_name].some(isWaitName);
    if (waitTool) {
      for (const candidate of [record.id, record.tool_use_id, record.callId, record.call_id, record.toolCallId, record.tool_call_id]) {
        if (typeof candidate === "string" && candidate.trim()) ids.add(candidate.trim());
      }
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(event.payload, 0);
  return ids;
}

function parsedWaitResult(value: unknown, depth = 0): { empty: boolean } | null {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    try { return parsedWaitResult(JSON.parse(trimmed), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = parsedWaitResult(item, depth + 1);
      if (result) return result;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.is_error === true || record.error) return null;
  if (Array.isArray(record.messages)) return { empty: record.messages.length === 0 };
  for (const key of ["content", "text", "tool_use_result", "result", "structuredContent", "output"]) {
    const result = parsedWaitResult(record[key], depth + 1);
    if (result) return result;
  }
  return null;
}

function supervisedToolResults(event: PollActivityLike): Array<{ toolUseId: string; empty: boolean }> {
  const results: Array<{ toolUseId: string; empty: boolean }> = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "tool_result" && typeof record.tool_use_id === "string") {
      const parsed = parsedWaitResult(record);
      if (parsed) results.push({ toolUseId: record.tool_use_id, empty: parsed.empty });
    }
    if (event.method === "item/completed"
      && record.type === "mcpToolCall"
      && typeof record.id === "string"
      && record.status !== "failed"
      && !record.error) {
      const parsed = parsedWaitResult(record.result);
      if (parsed) results.push({ toolUseId: record.id, empty: parsed.empty });
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(event.payload, 0);
  return results;
}

function isThinkingOnlyAssistantEvent(event: PollActivityLike): boolean {
  if (event.method !== "assistant" || !event.payload || typeof event.payload !== "object") return false;
  const payload = event.payload as Record<string, unknown>;
  const message = payload.message;
  if (!message || typeof message !== "object") return false;
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content) && content.length > 0 && content.every((item) =>
    item && typeof item === "object" && (item as Record<string, unknown>).type === "thinking");
}

function correlatedWaitResult(event: PollActivityLike, history: readonly PollActivityLike[]): "empty" | "nonempty" | null {
  const waitIds = new Set(history.flatMap((candidate) => [...supervisedWaitToolUseIds(candidate)]));
  const correlated = supervisedToolResults(event).filter((result) => waitIds.has(result.toolUseId));
  if (correlated.some((result) => !result.empty)) return "nonempty";
  return correlated.some((result) => result.empty) ? "empty" : null;
}

function isCorrelatedEmptyWaitResult(event: PollActivityLike, history: readonly PollActivityLike[]): boolean {
  return correlatedWaitResult(event, history) === "empty";
}

function isCorrelatedNonemptyWaitResult(event: PollActivityLike, history: readonly PollActivityLike[]): boolean {
  return correlatedWaitResult(event, history) === "nonempty";
}

function isCorrelatedWaitProgress(event: PollActivityLike, history: readonly PollActivityLike[]): boolean {
  if (event.method !== "item/mcpToolCall/progress" || !event.payload || typeof event.payload !== "object") return false;
  const itemId = (event.payload as Record<string, unknown>).itemId;
  if (typeof itemId !== "string" || !itemId.trim()) return false;
  const waitIds = new Set(history.flatMap((candidate) => [...supervisedWaitToolUseIds(candidate)]));
  return waitIds.has(itemId.trim());
}

/**
 * Keep the whole empty room-poll handoff quiet, not only the wait tool-use.
 * Claude emits wait tool-use -> user tool-result -> a thinking-only assistant
 * beat -> the next wait. Correlating the exact tool_use_id avoids treating a
 * real addressed result (or an unrelated tool) as idle, and the persisted
 * activity window makes the decision survive a daemon restart mid-poll.
 */
export function isSupervisedQuietPollContinuation(
  event: PollActivityLike,
  history: readonly PollActivityLike[],
): boolean {
  const recent = history.slice(-8);
  if (isCorrelatedWaitProgress(event, recent)) return true;
  if (isCorrelatedEmptyWaitResult(event, recent)) return true;
  if (!isThinkingOnlyAssistantEvent(event)) return false;
  const prior = recent.at(-1);
  return prior ? isCorrelatedEmptyWaitResult(prior, recent.slice(0, -1)) : false;
}

/**
 * Compatibility cursor evidence for the currently published MCP runtime.
 * Its explicit wait cursor is the worker's assertion that every earlier room
 * message was consumed, even when that runtime predates the daemon checkpoint
 * RPC. Newer runtimes also call the RPC; checkpointing is idempotent below.
 */
export function supervisedWaitEvidenceFromProviderEvent(event: ProviderActionStreamEvent): SupervisedWaitEvidence | null {
  const visit = (value: unknown, depth: number): SupervisedWaitEvidence | null => {
    if (depth > 8 || !value || typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const cursor = visit(item, depth + 1);
        if (cursor) return cursor;
      }
      return null;
    }
    const record = value as Record<string, unknown>;
    const input = record.input;
    const name = typeof record.name === "string" ? record.name : "";
    if (record.type === "tool_use"
      && (name === "wait_for_messages" || name === "mcp__letagents__wait_for_messages")
      && input && typeof input === "object" && !Array.isArray(input)) {
      const cursor = (input as Record<string, unknown>).after_message_id;
      const agentSessionId = (input as Record<string, unknown>).agent_session_id;
      if (typeof cursor === "string" && /^msg_\d+$/.test(cursor)
        && typeof agentSessionId === "string" && agentSessionId.trim()) {
        return { roomCursor: cursor, agentSessionId: agentSessionId.trim() };
      }
    }
    for (const child of Object.values(record)) {
      const cursor = visit(child, depth + 1);
      if (cursor) return cursor;
    }
    return null;
  };
  return visit(event.payload, 0);
}

export function supervisedWaitCursorFromProviderEvent(event: ProviderActionStreamEvent): string | null {
  return supervisedWaitEvidenceFromProviderEvent(event)?.roomCursor ?? null;
}

const PS_LONG_START_PREFIX = /^\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}/;

/**
 * Compare the stable birth portion of a process identity. Electron records the
 * owner identity as `ps -o lstart=` (start time only) via defaultGetProcessIdentity
 * because argv/command is mutable; the daemon must therefore compare on that same
 * stable start-time prefix rather than whole-string equality, or a live owner reads
 * dead and its reservation is dropped before activate. Accepting a legacy prefix
 * (pre-2.0.12 identities also appended argv/command) keeps a live upgrade safe.
 * This mirrors sameProcessBirthIdentity in electron/main/agents/provider-evidence.ts;
 * the daemon tsconfig rootDir forbids importing it, so keep the two in sync.
 */
export function sameProcessBirthIdentity(current: string, recorded: string): boolean {
  // When ps output does not match the expected start-time prefix (unexpected/
  // malformed), fall back to exact-match rather than treating everything as equal.
  // This deliberately errs toward "not the same process"; isProcessOwnerLive's outer
  // kill(0) EPERM/ESRCH check is the safety net for genuinely-live-but-unreadable pids.
  const stable = (value: string) => value.trim().match(PS_LONG_START_PREFIX)?.[0].replace(/\s+/g, " ") ?? value.trim();
  return stable(current) === stable(recorded);
}

export class SupervisorDaemon {
  private manifestGeneration = 0;
  private readonly singleton: DaemonSingleton;
  private readonly store: ManifestStore;
  private readonly audit: AuditLog;
  private readonly durability: WorkDurabilityStore;
  private readonly provisioner: WorkspaceProvisioner;
  private readonly gitCommand: GitCommand;
  private readonly workerBindings: WorkerBindingStore;
  /** Shares the daemon's SQLite durability path; delivery orchestration owns no secrets. */
  private readonly supervisedInbox: SupervisedAgentInboxStore;
  private readonly supervisedDelivery: SupervisedAgentDelivery | null;
  private readonly socket: DaemonControlSocket;
  private readonly reconciliationTicks = new Map<string, Promise<void>>();
  private readonly scheduledConvergence = new Map<string, Promise<{ dispose: () => Promise<void> }>>();
  private readonly scheduledConvergenceCancels = new Map<string, () => void>();
  private manifestMutation: Promise<void> = Promise.resolve();
  private readonly liveHandles = new Map<string, ProviderActionHandle>();
  private readonly liveDisposers = new Map<string, Array<() => void>>();
  private readonly convergenceRequests = new Map<string, Promise<void>>();
  /**
   * Control requests must be able to fence a launch while its per-entry
   * reconciliation lane is awaiting remote authorization or capabilities.
   * They therefore cannot rely on that same lane for ordering.
   */
  private readonly entryControlEpochs = new Map<string, number>();
  private readonly providerStreamQueues = new Map<string, Promise<void>>();
  private readonly cursorCheckpointQueues = new Map<string, Promise<void>>();
  private readonly providerCallbacks = new Set<Promise<void>>();
  /** Handoff drains only dispatches that crossed the native-effect boundary. */
  private readonly providerDispatchReservations = new Set<Promise<void>>();
  /** Fatal returned-handle cleanup failure permanently blocks authority release. */
  private fatalProviderDispatchError: unknown = null;
  private readonly activeProviderDispatches = new Map<symbol, {
    entryId: string; executionGenerationId: string; daemonGeneration: number;
  }>();
  private readonly terminalFenceRequests = new WeakMap<ProviderActionHandle, Promise<void>>();
  private readonly turnControlRequests = new Map<string, Promise<DaemonTurnControlResult>>();
  private readonly deliveryCutoverRequests = new Map<string, Promise<void>>();
  private readonly deliveryCutoverControllers = new Map<string, AbortController>();
  private readonly turnControlActiveEntries = new Set<string>();
  private readonly recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly liveBindingIdentities = new Map<string, LiveBindingIdentity>();
  private readonly pendingResumeBindings = new Map<string, PendingResumeBinding>();
  /** Installed by the desktop over the local socket; intentionally never serialized. */
  private readonly hostGrants = new Map<string, InstalledHostGrant>();
  /** Latest successful bootstrap/launch mint, fenced to one effective grant and attempt. */
  private readonly cachedWorkerAuthorizations = new Map<string, CachedWorkerAuthorization>();
  /** Initial-tail reads are authority-bearing admission operations. */
  private readonly bootstrapOperations = new Set<BootstrapOperation>();
  private readonly nowMs: () => number;
  private readonly setRecoveryTimeout: typeof setTimeout;
  private readonly clearRecoveryTimeout: typeof clearTimeout;
  private manifestCommit: Promise<void> = Promise.resolve();
  private readonly startedAt = new Date().toISOString();
  private handoffScheduled = false;
  private handoffTeardownScheduled = false;
  /** Resolves only once this daemon has relinquished every authority surface. */
  private readonly handoffCompletion: Promise<void>;
  private resolveHandoffCompletion!: () => void;
  private rejectHandoffCompletion!: (error: unknown) => void;

  constructor(paths: DaemonPaths = defaultDaemonPaths(), private readonly platform = process.platform, private readonly providerPort?: ProviderActionPort, private readonly autoConverge = providerPort?.constructor.name === "CodexProviderActionPort", private readonly nativeHeartbeatIntervalMs = 15_000, private readonly controlRequestBarrier?: (request: DaemonRequest) => Promise<void>, recoveryClock: RecoveryClock = {}, private readonly supervisedDeliveryHttp: SupervisedDeliveryHttp = productionSupervisedDeliveryHttp, private readonly supervisorGrantHttp: SupervisorGrantHttp = productionSupervisorGrantHttp) {
    this.handoffCompletion = new Promise<void>((resolve, reject) => {
      this.resolveHandoffCompletion = resolve;
      this.rejectHandoffCompletion = reject;
    });
    // A library consumer may prepare a handoff without awaiting its completion.
    // Keep the rejection observed while preserving it for waitForHandoff().
    void this.handoffCompletion.catch(() => undefined);
    this.singleton = new DaemonSingleton(paths.lockPath, platform);
    this.store = new ManifestStore(paths.manifestPath, paths.legacyManifestPath);
    this.audit = new AuditLog(paths.auditPath);
    const root = paths.workspaceRoot ?? dirname(paths.manifestPath);
    const gitCommand = createGitCommand(root);
    this.gitCommand = gitCommand;
    this.durability = new WorkDurabilityStore(
      paths.attemptsPath ?? `${paths.manifestPath}.attempts`,
      paths.attemptsRoot ?? `${paths.manifestPath}.attempt-data`,
      undefined,
      `${root}/worktrees`,
      undefined,
      gitCommand,
      undefined,
      undefined,
      undefined,
      paths.manifestPath,
    );
    this.provisioner = new WorkspaceProvisioner(root, gitCommand);
    this.workerBindings = new WorkerBindingStore(
      paths.workerBindingsPath ?? `${paths.manifestPath}.worker-bindings`,
      (commit) => this.fenceDaemonCommit(commit),
      paths.manifestPath,
    );
    // Inbox state belongs to the canonical daemon database. The worker-binding
    // path is a legacy JSON import source and must never become a second SQLite
    // authority for delivery receipts.
    this.supervisedInbox = new SupervisedAgentInboxStore(paths.manifestPath);
    this.supervisedDelivery = providerPort
      ? new SupervisedAgentDelivery(this.supervisedInbox, providerPort, supervisedDeliveryHttp, (authority) => this.isExactSupervisedDeliveryAuthority(authority))
      : null;
    this.socket = new DaemonControlSocket(paths.socketPath, async (request) => {
      await this.singleton.assertCurrent();
      const isLifecycleRequest = request.method === "daemon.negotiate"
        || request.method === "daemon.status"
        || request.method === "daemon.prepare_handoff";
      if (this.handoffScheduled && !isLifecycleRequest) {
        throw new Error("Supervisor handoff has fenced new daemon mutations.");
      }
      await this.controlRequestBarrier?.(request);
      // A request may have been admitted before prepare_handoff and paused in
      // an injected/native barrier. Re-check after that await so it cannot
      // perform provider effects once handoff begins.
      if (this.handoffScheduled && !isLifecycleRequest) {
        throw new Error("Supervisor handoff has fenced new daemon mutations.");
      }
      if (request.method === "daemon.negotiate") return this.status();
      if (request.method === "daemon.status") return this.status();
      if (request.method === "daemon.prepare_handoff") {
        await this.prepareHandoff();
        return { accepted: true, generation: this.singleton.currentGeneration };
      }
      if (request.method === "manifest.list") return this.entriesWithDerivedLiveness((await this.store.load()).entries);
      if (request.method === "supervisor.retry_room_delivery") {
        const params = this.paramsRecord(request.params);
        await this.retryRoomDelivery({
          entryId: String(params.entry_id ?? ""),
          roomId: String(params.room_id ?? ""),
          sourceMessageId: String(params.source_message_id ?? ""),
          workAttemptId: String(params.work_attempt_id ?? ""),
          executionGenerationId: String(params.execution_generation_id ?? ""),
          agentSessionId: String(params.agent_session_id ?? ""),
          daemonGeneration: Number(params.daemon_generation ?? NaN),
        });
        return { accepted: true };
      }
      if (request.method === "manifest.put") return this.putManifestEntry(this.paramsEntry(request.params));
      if (request.method === "manifest.set_desired_state") {
        const params = this.paramsRecord(request.params);
        const updated = await this.setDesiredState(String(params.id ?? ""), String(params.desired_state ?? "") as DesiredState);
        return this.entryWithDerivedLiveness(updated);
      }
      if (request.method === "manifest.compare_and_set_desired_state") {
        const params = this.paramsRecord(request.params);
        const result = await this.compareAndSetDesiredState(
          String(params.id ?? ""),
          String(params.expected_desired_state ?? "") as DesiredState,
          String(params.desired_state ?? "") as DesiredState,
        );
        return { applied: result.applied, entry: await this.entryWithDerivedLiveness(result.entry) };
      }
      if (request.method === "manifest.control_turn") {
        const params = this.paramsRecord(request.params);
        return this.controlTurn({
          entryId: String(params.id ?? ""),
          workAttemptId: String(params.work_attempt_id ?? ""),
          executionGenerationId: String(params.execution_generation_id ?? ""),
          actionId: String(params.action_id ?? ""),
          correction: typeof params.correction === "string" ? params.correction : null,
        });
      }
      if (request.method === "manifest.resolve_turn_control") {
        const params = this.paramsRecord(request.params);
        return this.resolveTurnControl({
          entryId: String(params.id ?? ""),
          workAttemptId: String(params.work_attempt_id ?? ""),
          executionGenerationId: String(params.execution_generation_id ?? ""),
          actionId: String(params.action_id ?? ""),
          resolution: String(params.resolution ?? "") as "not_applied" | "applied",
        });
      }
      if (request.method === "lane.reserve_legacy") {
        const params = this.paramsRecord(request.params);
        return this.reserveLegacyLane({
          reservation_id: String(params.reservation_id ?? ""),
          room_id: String(params.room_id ?? ""),
          provider: String(params.provider ?? ""),
          owner_pid: Number(params.owner_pid ?? 0),
          owner_process_identity: String(params.owner_process_identity ?? ""),
        });
      }
      if (request.method === "lane.activate_legacy") {
        const params = this.paramsRecord(request.params);
        return this.activateLegacyLane(String(params.reservation_id ?? ""), String(params.session_id ?? ""));
      }
      if (request.method === "lane.release_legacy") {
        const params = this.paramsRecord(request.params);
        return this.releaseLegacyLane({
          reservation_id: typeof params.reservation_id === "string" ? params.reservation_id : null,
          session_id: typeof params.session_id === "string" ? params.session_id : null,
          room_id: typeof params.room_id === "string" ? params.room_id : null,
          provider: typeof params.provider === "string" ? params.provider : null,
        });
      }
      if (request.method === "manifest.append_activity") {
        const params = this.paramsRecord(request.params);
        return this.appendActivity(String(params.id ?? ""), params.event as DaemonActivityEvent);
      }
      if (request.method === "manifest.update_workplace_liveness") {
        const params = this.paramsRecord(request.params);
        return this.updateWorkplaceLiveness(
          String(params.id ?? ""),
          String(params.state ?? "unknown") as "reachable" | "stale" | "unknown",
          typeof params.detail === "string" ? params.detail : null,
          typeof params.observed_at === "string" ? params.observed_at : new Date().toISOString(),
        );
      }
      if (request.method === "supervisor.bind_worker_session") {
        const params = this.paramsRecord(request.params);
        return this.bindWorkerSession({
          entry_id: String(params.entry_id ?? ""),
          room_id: String(params.room_id ?? ""),
          work_attempt_id: String(params.work_attempt_id ?? ""),
          execution_generation_id: String(params.execution_generation_id ?? ""),
          agent_session_id: String(params.agent_session_id ?? ""),
          agent_session_token: String(params.agent_session_token ?? ""),
          api_url: String(params.api_url ?? ""),
        });
      }
      if (request.method === "supervisor.verify_worker_session") {
        const params = this.paramsRecord(request.params);
        return this.verifyWorkerSession({
          entry_id: String(params.entry_id ?? ""),
          room_id: String(params.room_id ?? ""),
          work_attempt_id: String(params.work_attempt_id ?? ""),
          execution_generation_id: String(params.execution_generation_id ?? ""),
          agent_session_id: String(params.agent_session_id ?? ""),
          agent_session_token: String(params.agent_session_token ?? ""),
          api_url: String(params.api_url ?? ""),
        });
      }
      if (request.method === "supervisor.install_worker_credential") {
        const params = this.paramsRecord(request.params);
        return this.installWorkerCredential({
          entry_id: String(params.entry_id ?? ""), room_id: String(params.room_id ?? ""),
          work_attempt_id: String(params.work_attempt_id ?? ""), execution_generation_id: String(params.execution_generation_id ?? ""),
          agent_session_id: String(params.agent_session_id ?? ""), agent_session_token: String(params.agent_session_token ?? ""),
          daemon_generation: Number(params.daemon_generation ?? 0),
        });
      }
      if (request.method === "supervisor.install_host_grant") {
        const params = this.paramsRecord(request.params);
        return this.installHostGrant({
          entry_id: String(params.entry_id ?? ""), room_id: String(params.room_id ?? ""), agent_key: String(params.agent_key ?? ""),
          grant_id: String(params.grant_id ?? ""), supervisor_grant: String(params.supervisor_grant ?? ""),
          grant_generation: Number(params.grant_generation ?? NaN), api_url: String(params.api_url ?? ""),
          host_id: String(params.host_id ?? ""), installation_id: String(params.installation_id ?? ""),
          grant_expires_at: String(params.grant_expires_at ?? ""),
          daemon_generation: Number(params.daemon_generation ?? NaN),
          credential_only: params.credential_only === true,
        });
      }
      if (request.method === "supervisor.bootstrap_room_ingress") {
        const params = this.paramsRecord(request.params);
        return this.beginBootstrap(this.bootstrapRoomIngress.bind(this), {
          entry_id: String(params.entry_id ?? ""),
          daemon_generation: Number(params.daemon_generation ?? NaN),
        });
      }
      if (request.method === "supervisor.borrow_worker_credential") {
        const params = this.paramsRecord(request.params);
        return this.borrowWorkerCredential({
          entry_id: String(params.entry_id ?? ""), room_id: String(params.room_id ?? ""),
          work_attempt_id: String(params.work_attempt_id ?? ""), execution_generation_id: String(params.execution_generation_id ?? ""),
          agent_session_id: String(params.agent_session_id ?? ""), daemon_generation: Number(params.daemon_generation ?? 0),
          api_url: String(params.api_url ?? ""),
        });
      }
      if (request.method === "supervisor.checkpoint_worker_cursor") {
        const params = this.paramsRecord(request.params);
        return this.checkpointWorkerCursor({
          entry_id: String(params.entry_id ?? ""),
          work_attempt_id: String(params.work_attempt_id ?? ""),
          execution_generation_id: String(params.execution_generation_id ?? ""),
          agent_session_id: String(params.agent_session_id ?? ""),
          room_cursor: String(params.room_cursor ?? ""),
        });
      }
      if (request.method === "attempt.read") return this.readAttempt(String(this.paramsRecord(request.params).id ?? ""));
      throw new Error(`Unsupported daemon method: ${request.method}`);
    }, async (error) => { if (error instanceof DaemonFenceLostError) await this.stop(); });
    this.nowMs = recoveryClock.nowMs ?? Date.now;
    this.setRecoveryTimeout = recoveryClock.setTimeout ?? setTimeout;
    this.clearRecoveryTimeout = recoveryClock.clearTimeout ?? clearTimeout;
  }

  async start(): Promise<void> {
    assertMacOS(this.platform);
    await this.singleton.acquire();
    this.durability.bindSupervisorFence(this.supervisorFenceIdentity());
    this.manifestGeneration = (await this.store.load()).generation;
    await this.quarantineDuplicateSupervisedLaneOwners();
    await this.recoverTurnControls();
    await this.recoverOrphanedLegacyReservations();
    await this.socket.start();
    for (const entry of (await this.store.load()).entries) {
      void this.startSupervisedDelivery(entry.id).catch(() => undefined);
    }
    if (this.providerPort && this.autoConverge) {
      for (const entry of (await this.store.load()).entries) this.requestConvergence(entry.id);
    }
  }

  private async recoverTurnControls(): Promise<void> {
    await this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const recoveredAt = new Date().toISOString();
      let changed = false;
      const entries = manifest.entries.map((entry) => {
        if (entry.turn_control?.status !== "prepared" && entry.turn_control?.status !== "dispatching") return entry;
        changed = true;
        const wasPrepared = entry.turn_control.status === "prepared";
        return {
          ...entry,
          turn_control: {
            ...entry.turn_control,
            status: wasPrepared ? "retryable" as const : "uncertain" as const,
            error: wasPrepared
              ? "Supervisor restarted before native dispatch; the correction is safe to retry."
              : "Supervisor restarted after native dispatch began; verify the provider outcome before resolving the action.",
            updated_at: recoveredAt,
          },
        };
      });
      if (!changed) return;
      const next = await this.writeManifest(this.manifestGeneration, entries, manifest.legacy_lane_owners);
      this.manifestGeneration = next.generation;
    });
  }

  async stop(): Promise<void> {
    // Stop is final for this daemon instance. Fence late delivery/cutover
    // continuations before awaiting any drain so they cannot retain a socket
    // or SQLite handle after the caller has observed shutdown.
    this.handoffScheduled = true;
    this.hostGrants.clear();
    this.cachedWorkerAuthorizations.clear();
    await this.fenceAndDrainDeliveryCutovers();
    await this.supervisedDelivery?.fenceAndDrain();
    for (const timer of this.recoveryTimers.values()) this.clearRecoveryTimeout(timer);
    this.recoveryTimers.clear();
    await Promise.all([...this.scheduledConvergence.values()].map(async (scheduled) => (await scheduled).dispose()));
    await Promise.all([...this.convergenceRequests.values()]);
    for (const disposers of this.liveDisposers.values()) for (const dispose of disposers) dispose();
    this.liveDisposers.clear();
    await Promise.all([...this.providerCallbacks]);
    await this.socket.stop();
    await this.serializeManifestCommit(() => this.singleton.release());
    await this.store.close();
    await this.durability.close();
    await this.workerBindings.close();
    await this.supervisedInbox.close();
  }

  /**
   * Wait for a requested version handoff to finish. This is intentionally a
   * daemon-lifecycle promise rather than a socket response: prepare_handoff
   * must acknowledge before it tears down the connection carrying that reply.
   */
  async waitForHandoff(): Promise<void> {
    await this.handoffCompletion;
  }

  /**
   * Version handoff must release daemon authority independently of provider or
   * network callback latency. Provider work survives; only this daemon's
   * observers and control authority are detached.
   */
  private async stopForHandoff(): Promise<void> {
    // Fence first. Any callbacks that outlive this method are prevented from
    // committing daemon-owned state by fenceDaemonCommit().
    this.hostGrants.clear();
    this.cachedWorkerAuthorizations.clear();
    const failures: unknown[] = [];
    try { await this.fenceAndDrainDeliveryCutovers(); } catch (error) { failures.push(error); }
    try { await this.supervisedDelivery?.fenceAndDrain(); } catch (error) { failures.push(error); }
    const captureSync = (operation: () => void): void => {
      try { operation(); } catch (error) { failures.push(error); }
    };
    for (const cancel of this.scheduledConvergenceCancels.values()) captureSync(cancel);
    this.scheduledConvergenceCancels.clear();
    for (const timer of this.recoveryTimers.values()) captureSync(() => this.clearRecoveryTimeout(timer));
    this.recoveryTimers.clear();
    for (const scheduled of this.scheduledConvergence.values()) {
      void scheduled.then(({ dispose }) => dispose()).catch(() => undefined);
    }
    this.scheduledConvergence.clear();
    // Remote grant/capability waits remain freely cancellable, but once a
    // native provider dispatch begins its exact returned identity must be
    // persisted before the shared stores are closed for successor attach.
    if (this.fatalProviderDispatchError) throw this.fatalProviderDispatchError;
    await Promise.all([...this.providerDispatchReservations]);
    if (this.fatalProviderDispatchError) throw this.fatalProviderDispatchError;
    for (const disposers of this.liveDisposers.values()) for (const dispose of disposers) captureSync(dispose);
    this.liveDisposers.clear();
    // Complete every local cleanup step even if one fails. The process-level
    // entrypoint will report the failure and exit non-zero, but should never
    // leave the singleton lock behind merely because (for example) socket
    // unlinking failed after the listener had already closed.
    const cleanup = async (operation: () => Promise<void>): Promise<void> => {
      try { await operation(); } catch (error) { failures.push(error); }
    };
    await cleanup(() => this.socket.stop());
    await cleanup(() => this.serializeManifestCommit(() => this.singleton.release()));
    await cleanup(() => this.store.close());
    await cleanup(() => this.durability.close());
    await cleanup(() => this.workerBindings.close());
    await cleanup(() => this.supervisedInbox.close());
    // Existing convergence/provider callbacks are generation-fenced below.
    // Do not await them: a wedged native transport must not block an upgrade.
    this.convergenceRequests.clear();
    this.providerCallbacks.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, "Supervisor handoff cleanup did not complete cleanly.");
    }
  }

  /**
   * Retries one known blocked receipt. Every identity in the renderer request
   * is compared with the currently-owned runtime before the in-memory bearer
   * is read, so a historical binding cannot reanimate a replacement worker.
   */
  private async retryRoomDelivery(input: {
    entryId: string; roomId: string; sourceMessageId: string; workAttemptId: string;
    executionGenerationId: string; agentSessionId: string; daemonGeneration: number;
  }): Promise<void> {
    for (const [field, value] of Object.entries(input)) {
      if ((typeof value === "string" && !value.trim()) || (field === "daemonGeneration" && !Number.isSafeInteger(value))) {
        throw new Error(`Exact room delivery retry ${field} is required.`);
      }
    }
    if (!this.supervisedDelivery || !this.providerPort?.runRoomTurn) {
      throw new Error("This supervisor does not support room delivery retry.");
    }
    if (input.daemonGeneration !== this.singleton.currentGeneration) {
      throw new Error("The supervisor generation changed; refresh before retrying.");
    }
    const entry = await this.store.getEntry(input.entryId);
    const handle = this.liveHandles.get(input.entryId);
    const binding = await this.workerBindings.get(input.entryId);
    if (!entry || !handle || !binding
      || entry.room_id !== input.roomId
      || entry.delivery_mode === "desktop_events"
      || (entry.provider === "codex" && entry.delivery_mode !== "daemon_inbox")
      || entry.work_attempt_id !== input.workAttemptId
      || entry.provider_ref?.execution_generation_id !== input.executionGenerationId
      || binding.room_id !== input.roomId
      || binding.work_attempt_id !== input.workAttemptId
      || binding.execution_generation_id !== input.executionGenerationId
      || binding.agent_session_id !== input.agentSessionId) {
      throw new Error("The room delivery binding is stale; refresh before retrying.");
    }
    const credential = await this.workerBindings.credentialFor(binding);
    if (!credential) throw new Error("Waiting for desktop credential handoff before retrying delivery.");
    const agent = {
      agentId: entry.id, roomId: binding.room_id, provider: entry.provider, apiUrl: binding.api_url,
      agentSessionId: binding.agent_session_id, bearer: credential, handle,
      executionGenerationId: binding.execution_generation_id, daemonGeneration: this.singleton.currentGeneration,
      deliveryMode: entry.delivery_mode ?? "mcp_polling",
    };
    if (!await this.isExactSupervisedDeliveryAuthority({
      agentId: agent.agentId, roomId: agent.roomId, provider: agent.provider, apiUrl: agent.apiUrl,
      agentSessionId: agent.agentSessionId, bearer: agent.bearer, handle: agent.handle,
      workAttemptId: agent.handle.workAttemptId, executionGenerationId: agent.executionGenerationId,
      daemonGeneration: agent.daemonGeneration, providerContinuationId: agent.handle.providerContinuationId, pid: agent.handle.pid,
    })) throw new Error("The room delivery binding is no longer current; refresh before retrying.");
    await this.supervisedDelivery.retry(agent, input.sourceMessageId);
  }

  /** Build a delivery agent only from one current manifest, handle, binding, and memory credential tuple. */
  private async startSupervisedDelivery(entryId: string): Promise<void> {
    if (this.handoffScheduled || !this.supervisedDelivery || !this.providerPort?.runRoomTurn) return;
    const entry = await this.store.getEntry(entryId);
    // A legacy worker-owned polling loop must be cut over before the daemon
    // can even read its bearer.  This keeps the two ingress systems mutually
    // exclusive across every crash boundary.
    if (entry?.provider === "codex" && (entry.delivery_mode ?? "mcp_polling") === "mcp_polling") {
      await this.startDeliveryCutover(entryId);
      return;
    }
    if (!entry
      || entry.delivery_mode === "desktop_events"
      || (entry.provider === "codex" && entry.delivery_mode !== "daemon_inbox")) return;
    const handle = this.liveHandles.get(entryId);
    const binding = await this.workerBindings.get(entryId);
    if (!entry || !handle || !binding) return;
    const credential = await this.workerBindings.credentialFor(binding);
    if (!credential) return;
    const agent = {
      agentId: entryId,
      roomId: binding.room_id,
      provider: entry.provider,
      apiUrl: binding.api_url,
      agentSessionId: binding.agent_session_id,
      bearer: credential,
      handle,
      executionGenerationId: binding.execution_generation_id,
      daemonGeneration: this.singleton.currentGeneration,
      deliveryMode: entry.delivery_mode ?? "mcp_polling",
    };
    if (!await this.isExactSupervisedDeliveryAuthority({
      agentId: agent.agentId, roomId: agent.roomId, provider: agent.provider,
      apiUrl: agent.apiUrl, agentSessionId: agent.agentSessionId, bearer: agent.bearer,
      handle: agent.handle, workAttemptId: agent.handle.workAttemptId,
      executionGenerationId: agent.executionGenerationId,
      daemonGeneration: agent.daemonGeneration,
      providerContinuationId: agent.handle.providerContinuationId,
      pid: agent.handle.pid,
    })) return;
    // Rebinding replaces the prior loop only after it has been cancelled and
    // joined. The new loop pumps durable work before its first long poll.
    void this.supervisedDelivery.refresh(agent).catch(() => undefined);
  }

  /** Coalesce one durable legacy-polling -> daemon-inbox handoff per agent. */
  private startDeliveryCutover(entryId: string): Promise<void> {
    const existing = this.deliveryCutoverRequests.get(entryId);
    if (existing) return existing;
    const controller = new AbortController();
    this.deliveryCutoverControllers.set(entryId, controller);
    const operation = this.driveDeliveryCutover(entryId, controller.signal).finally(() => {
      if (this.deliveryCutoverRequests.get(entryId) === operation) this.deliveryCutoverRequests.delete(entryId);
      if (this.deliveryCutoverControllers.get(entryId) === controller) this.deliveryCutoverControllers.delete(entryId);
    });
    this.deliveryCutoverRequests.set(entryId, operation);
    return operation;
  }

  /**
   * Fence the exact legacy polling turn before enabling daemon ingress.  The
   * manifest is the effect journal: once a target is recorded no later run may
   * inspect "latest" as a replacement target, and once native dispatch is
   * recorded an active/unknown result is deliberately left gated.
   */
  private async driveDeliveryCutover(entryId: string, detachSignal: AbortSignal): Promise<void> {
    if (this.handoffScheduled || !this.providerPort?.controlExactTurn) return;
    let entry = await this.store.getEntry(entryId);
    this.assertDeliveryCutoverObservation(detachSignal);
    const handle = this.liveHandles.get(entryId);
    if (!entry || !handle
      || entry.provider !== "codex"
      || (entry.delivery_mode ?? "mcp_polling") !== "mcp_polling"
      || entry.desired_state !== "running"
      || entry.condition !== "none"
      || !entry.work_attempt_id
      || !entry.provider_ref
      || handle.workAttemptId !== entry.work_attempt_id
      || handle.providerContinuationId !== entry.provider_ref.provider_continuation_id) return;

    const identity = {
      work_attempt_id: entry.work_attempt_id,
      execution_generation_id: entry.provider_ref.execution_generation_id,
      provider_continuation_id: entry.provider_ref.provider_continuation_id,
    };
    if (!entry.delivery_cutover) {
      this.assertDeliveryCutoverObservation(detachSignal);
      entry = await this.updateManifestEntry(entryId, (current) => {
        this.assertDeliveryCutoverObservation(detachSignal);
        if (current.provider !== "codex" || (current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
          || current.work_attempt_id !== identity.work_attempt_id
          || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
          || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id) return current;
        const cutover: DaemonDeliveryCutover = { ...identity, provider_turn_id: null, phase: "prepared", error: null, updated_at: new Date().toISOString() };
        return { ...current, delivery_cutover: cutover };
      });
      this.assertDeliveryCutoverObservation(detachSignal);
    }
    const cutover = entry.delivery_cutover;
    if (!cutover
      || cutover.work_attempt_id !== identity.work_attempt_id
      || cutover.execution_generation_id !== identity.execution_generation_id
      || cutover.provider_continuation_id !== identity.provider_continuation_id
      || cutover.phase === "uncertain") return;

    if (cutover.phase === "dispatching") {
      if (!cutover.provider_turn_id || !this.providerPort.inspectTurn) {
        await this.markDeliveryCutoverUncertain(entryId, identity, "native interrupt dispatch is ambiguous without an exact turn id", detachSignal);
        return;
      }
      const state = await this.observeDeliveryCutover(detachSignal, this.providerPort.inspectTurn(handle, cutover.provider_turn_id)).catch(() => "unknown" as const);
      this.assertDeliveryCutoverObservation(detachSignal);
      if (state === "terminal") {
        await this.completeDeliveryCutover(entryId, identity, detachSignal);
      } else {
        await this.markDeliveryCutoverUncertain(entryId, identity, `native interrupt dispatch is ambiguous; exact turn remains ${state}`, detachSignal);
      }
      return;
    }

    try {
      const result = await this.observeDeliveryCutover(detachSignal, this.providerPort.controlExactTurn(handle, {
        targetTurnId: cutover.provider_turn_id,
        checkpointTargetTurn: async (turnId) => {
          this.assertDeliveryCutoverObservation(detachSignal);
          await this.updateManifestEntry(entryId, (current) => {
            this.assertDeliveryCutoverObservation(detachSignal);
            const currentCutover = current.delivery_cutover;
            if (!currentCutover
              || current.delivery_mode !== "mcp_polling"
              || currentCutover.phase !== "prepared"
              || currentCutover.work_attempt_id !== identity.work_attempt_id
              || currentCutover.execution_generation_id !== identity.execution_generation_id
              || currentCutover.provider_continuation_id !== identity.provider_continuation_id
              || (currentCutover.provider_turn_id && currentCutover.provider_turn_id !== turnId)) {
              throw new Error("Legacy delivery cutover changed before exact turn checkpoint.");
            }
            return { ...current, delivery_cutover: { ...currentCutover, provider_turn_id: turnId, updated_at: new Date().toISOString() } };
          });
          this.assertDeliveryCutoverObservation(detachSignal);
        },
        markDispatched: async () => {
          this.assertDeliveryCutoverObservation(detachSignal);
          await this.updateManifestEntry(entryId, (current) => {
            this.assertDeliveryCutoverObservation(detachSignal);
            const currentCutover = current.delivery_cutover;
            if (!currentCutover
              || current.delivery_mode !== "mcp_polling"
              || currentCutover.phase !== "prepared"
              || !currentCutover.provider_turn_id
              || currentCutover.work_attempt_id !== identity.work_attempt_id
              || currentCutover.execution_generation_id !== identity.execution_generation_id
              || currentCutover.provider_continuation_id !== identity.provider_continuation_id) {
              throw new Error("Legacy delivery cutover changed before native interrupt dispatch.");
            }
            return { ...current, delivery_cutover: { ...currentCutover, phase: "dispatching", updated_at: new Date().toISOString() } };
          });
          this.assertDeliveryCutoverObservation(detachSignal);
        },
        detachSignal,
      }));
      this.assertDeliveryCutoverObservation(detachSignal);
      // A no-active/terminal inspection is a completion fact. An adapter's
      // interrupt acknowledgement is not: independently re-inspect exactly
      // the persisted target before allowing daemon ingress.
      if (result.outcome === "no_active" || result.outcome === "terminal") {
        await this.completeDeliveryCutover(entryId, identity, detachSignal);
      } else if (result.outcome === "interrupt_dispatched") {
        const targetTurnId = cutover.provider_turn_id ?? result.targetTurnId;
        if (!targetTurnId || !this.providerPort.inspectTurn) {
          await this.markDeliveryCutoverUncertain(entryId, identity, "native interrupt was acknowledged without exact terminal inspection", detachSignal);
          return;
        }
        const state = await this.observeDeliveryCutover(detachSignal, this.providerPort.inspectTurn(handle, targetTurnId)).catch(() => "unknown" as const);
        this.assertDeliveryCutoverObservation(detachSignal);
        if (state === "terminal") await this.completeDeliveryCutover(entryId, identity, detachSignal);
        else await this.markDeliveryCutoverUncertain(entryId, identity, `native interrupt was acknowledged but exact turn remains ${state}`, detachSignal);
      }
    } catch (error) {
      if (error instanceof DeliveryCutoverObservationDetached) return;
      await this.markDeliveryCutoverUncertain(entryId, identity, error instanceof Error ? error.message : "exact legacy turn control failed", detachSignal);
    }
  }

  private async completeDeliveryCutover(entryId: string, identity: Omit<DaemonDeliveryCutover, "provider_turn_id" | "phase" | "updated_at">, detachSignal: AbortSignal): Promise<void> {
    this.assertDeliveryCutoverObservation(detachSignal);
    const completed = await this.updateManifestEntry(entryId, (current) => {
      this.assertDeliveryCutoverObservation(detachSignal);
      const cutover = current.delivery_cutover;
      if (current.delivery_mode !== "mcp_polling"
        || !cutover
        || cutover.work_attempt_id !== identity.work_attempt_id
        || cutover.execution_generation_id !== identity.execution_generation_id
        || cutover.provider_continuation_id !== identity.provider_continuation_id) return current;
      const now = new Date().toISOString();
      return {
        ...current,
        delivery_mode: "daemon_inbox",
        delivery_cutover: null,
        // A terminal legacy turn is the successful boundary of the handoff,
        // not a dead worker. The retained app-server/thread is immediately a
        // healthy idle daemon-inbox session until its next bounded delivery.
        ...(current.observed_state === "working" || current.observed_state === "starting"
          ? { observed_state: "idle" as const, native_liveness: { state: "idle" as const, observed_at: now, detail: "legacy polling turn fenced; daemon inbox ready" } }
          : {}),
      };
    });
    this.assertDeliveryCutoverObservation(detachSignal);
    if (completed.delivery_mode === "daemon_inbox") {
      // This coordinator is still coalesced until its finally runs. Defer the
      // first inbox start one tick so it cannot mistake the cutover operation
      // for an already-running successor.
      const timer = setTimeout(() => void this.startSupervisedDelivery(entryId).catch(() => undefined), 0);
      timer.unref();
    }
  }

  private async markDeliveryCutoverUncertain(entryId: string, identity: Omit<DaemonDeliveryCutover, "provider_turn_id" | "phase" | "updated_at">, detail: string, detachSignal: AbortSignal): Promise<void> {
    this.assertDeliveryCutoverObservation(detachSignal);
    await this.updateManifestEntry(entryId, (current) => {
      this.assertDeliveryCutoverObservation(detachSignal);
      const cutover = current.delivery_cutover;
      if (current.delivery_mode !== "mcp_polling"
        || !cutover
        || cutover.work_attempt_id !== identity.work_attempt_id
        || cutover.execution_generation_id !== identity.execution_generation_id
        || cutover.provider_continuation_id !== identity.provider_continuation_id) return current;
      const safeDetail = redactCredentialText(detail).value;
      const observedAt = new Date().toISOString();
      const activity: DaemonActivityEvent = {
        observed_at: observedAt,
        sequence: (current.activity?.at(-1)?.sequence ?? 0) + 1,
        provider: current.provider,
        kind: "delivery_cutover",
        method: "legacy_polling_interrupt",
        summary: "Daemon inbox cutover needs attention; legacy ingress remains fenced.",
        status: "blocked",
        payload: { phase: "uncertain", provider_turn_id: cutover.provider_turn_id, detail: safeDetail },
        payload_truncated: false,
        payload_redacted: false,
        durable_payload_ref: null,
      };
      return {
        ...current,
        delivery_cutover: { ...cutover, phase: "uncertain", error: safeDetail, updated_at: observedAt },
        activity: [...(current.activity ?? []), activity].slice(-200),
      };
    });
    this.assertDeliveryCutoverObservation(detachSignal);
  }

  /** Retirement detaches local observation only; it never signals the provider. */
  private async fenceAndDrainDeliveryCutovers(): Promise<void> {
    for (const controller of this.deliveryCutoverControllers.values()) controller.abort();
    await Promise.allSettled([...this.deliveryCutoverRequests.values()]);
  }

  private assertDeliveryCutoverObservation(detachSignal: AbortSignal): void {
    if (detachSignal.aborted || this.handoffScheduled) throw new DeliveryCutoverObservationDetached();
  }

  private observeDeliveryCutover<T>(detachSignal: AbortSignal, operation: Promise<T>): Promise<T> {
    this.assertDeliveryCutoverObservation(detachSignal);
    return new Promise<T>((resolve, reject) => {
      const detach = () => {
        detachSignal.removeEventListener("abort", detach);
        reject(new DeliveryCutoverObservationDetached());
      };
      detachSignal.addEventListener("abort", detach, { once: true });
      void operation.then(
        (value) => {
          detachSignal.removeEventListener("abort", detach);
          if (detachSignal.aborted || this.handoffScheduled) reject(new DeliveryCutoverObservationDetached());
          else resolve(value);
        },
        (error) => {
          detachSignal.removeEventListener("abort", detach);
          reject(error);
        },
      );
    });
  }

  /** Re-check every authority component after delivery awaits; bearer equality stays memory-only. */
  private async isExactSupervisedDeliveryAuthority(authority: SupervisedDeliveryAuthority): Promise<boolean> {
    if (this.handoffScheduled) return false;
    try { await this.singleton.assertCurrent(); } catch { return false; }
    if (authority.daemonGeneration !== this.singleton.currentGeneration) return false;
    const entry = await this.store.getEntry(authority.agentId);
    const handle = this.liveHandles.get(authority.agentId);
    if (!entry || !handle
      || entry.id !== authority.agentId
      || entry.room_id !== authority.roomId
      || entry.desired_state !== "running"
      || entry.condition !== "none"
      || entry.delivery_mode === "desktop_events"
      || (entry.provider === "codex" && entry.delivery_mode !== "daemon_inbox")
      || entry.provider !== authority.provider
      || entry.work_attempt_id !== authority.workAttemptId
      || entry.provider_ref?.work_attempt_id !== authority.workAttemptId
      || entry.provider_ref?.execution_generation_id !== authority.executionGenerationId
      || entry.provider_ref?.provider_continuation_id !== authority.providerContinuationId
      || handle !== authority.handle
      || handle.workAttemptId !== authority.workAttemptId
      || handle.providerContinuationId !== authority.providerContinuationId
      || handle.pid !== authority.pid) return false;
    const binding = await this.workerBindings.get(authority.agentId);
    if (!binding
      || binding.entry_id !== authority.agentId
      || binding.room_id !== authority.roomId
      || binding.api_url !== authority.apiUrl
      || binding.work_attempt_id !== authority.workAttemptId
      || binding.execution_generation_id !== authority.executionGenerationId
      || binding.agent_session_id !== authority.agentSessionId) return false;
    return (await this.workerBindings.credentialFor(binding)) === authority.bearer;
  }

  private status() {
    return {
      healthy: true,
      protocol_version: DAEMON_PROTOCOL_VERSION,
      implementation_version: DAEMON_IMPLEMENTATION_VERSION,
      capabilities: { room_delivery_retry: Boolean(this.supervisedDelivery && this.providerPort?.runRoomTurn) },
      generation: this.singleton.currentGeneration,
      pid: process.pid,
      started_at: this.startedAt,
    };
  }

  private async prepareHandoff(): Promise<void> {
    if (this.handoffTeardownScheduled) return;
    if (!this.handoffScheduled) this.handoffScheduled = true;
    // A bootstrap that already read tail N must commit N before lock/socket
    // release. Otherwise a successor could establish a later tail and skip a
    // message that raced this handoff. New bootstrap requests are rejected by
    // the public fence above; this only drains operations admitted before it.
    for (const bootstrap of this.bootstrapOperations) {
      if (bootstrap.phase === "observing") bootstrap.controller.abort();
    }
    await Promise.allSettled([...this.bootstrapOperations].map((bootstrap) => bootstrap.operation));
    // Retire secret custody synchronously with the public handoff fence. The
    // dispatch preflight then proves every native return is journaled before
    // the acknowledgement can authorize Electron to replace this daemon.
    this.hostGrants.clear();
    if (this.fatalProviderDispatchError) throw this.fatalProviderDispatchError;
    await Promise.all([...this.providerDispatchReservations]);
    if (this.fatalProviderDispatchError) throw this.fatalProviderDispatchError;
    this.handoffTeardownScheduled = true;
    // Delayed teardown exists only to flush the successful socket reply.
    setTimeout(() => {
      void this.stopForHandoff().then(
        () => this.resolveHandoffCompletion(),
        (error) => this.rejectHandoffCompletion(error),
      );
    }, 25).unref();
  }

  private beginBootstrap<T>(run: (input: { entry_id: string; daemon_generation: number }, operation: BootstrapOperation) => Promise<T>, input: { entry_id: string; daemon_generation: number }): Promise<T> {
    const controller = new AbortController();
    const operation: BootstrapOperation = { controller, phase: "observing", operation: Promise.resolve() };
    const result = run(input, operation);
    operation.operation = result;
    this.bootstrapOperations.add(operation);
    const clear = () => this.bootstrapOperations.delete(operation);
    void result.then(clear, clear);
    return result;
  }

  private paramsRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Daemon request params must be an object.");
    return value as Record<string, unknown>;
  }

  private paramsEntry(value: unknown): DaemonManifestEntry {
    const params = this.paramsRecord(value);
    const entry = params.entry;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("manifest.put requires an entry.");
    return entry as DaemonManifestEntry;
  }

  private validateEntry(entry: DaemonManifestEntry): void {
    for (const field of ["id", "room_id", "display_name", "provider", "charter", "created_by", "created_at"] as const) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) throw new Error(`Manifest entry ${field} is required.`);
    }
    if (!["running", "paused", "stopped"].includes(entry.desired_state)) throw new Error("Invalid desired state.");
  }

  private isSupervisedLaneOwner(entry: DaemonManifestEntry): boolean {
    return !(entry.desired_state === "stopped" && entry.observed_state === "stopped");
  }

  /**
   * Codex runs have independently addressable app-server threads and work
   * attempts, so more than one supervised Codex agent may participate in a
   * room. Other providers retain the conservative one-supervised-owner lane
   * until their runtimes can prove the same isolation.
   *
   * This only relaxes supervised-vs-supervised admission. A live supervised
   * Codex entry still fences an Electron-owned legacy Codex runtime below.
   */
  private competingSupervisedLaneOwner(
    entries: readonly DaemonManifestEntry[],
    entry: DaemonManifestEntry,
  ): DaemonManifestEntry | undefined {
    if (entry.provider === "codex") return undefined;
    return entries.find((candidate) =>
      candidate.id !== entry.id
      && candidate.room_id === entry.room_id
      && candidate.provider === entry.provider
      && this.isSupervisedLaneOwner(candidate));
  }

  private async quarantineDuplicateSupervisedLaneOwners(): Promise<void> {
    await this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const ownersByLane = new Map<string, DaemonManifestEntry[]>();
      for (const entry of manifest.entries) {
        if (entry.provider === "codex") continue;
        if (!this.isSupervisedLaneOwner(entry)) continue;
        const key = `${entry.room_id}\u0000${entry.provider}`;
        const owners = ownersByLane.get(key) ?? [];
        owners.push(entry);
        ownersByLane.set(key, owners);
      }
      const duplicateIds = new Set(
        [...ownersByLane.values()]
          .filter((owners) => owners.length > 1)
          .flatMap((owners) => owners.map((entry) => entry.id)),
      );
      if (!duplicateIds.size) return;
      const entries = manifest.entries.map((entry) => duplicateIds.has(entry.id)
        ? {
            ...entry,
            desired_state: "stopped" as const,
            last_error: "LetAgents found multiple supervised agents for this provider lane after restart and stopped them to prevent duplicate work.",
          }
        : entry);
      const next = await this.writeManifest(this.manifestGeneration, entries, manifest.legacy_lane_owners);
      this.manifestGeneration = next.generation;
    });
  }

  private async putManifestEntry(entry: DaemonManifestEntry): Promise<DaemonManifestEntry> {
    this.validateEntry(entry);
    const updated = await this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
      const existing = manifest.entries.find((candidate) => candidate.id === entry.id);
      if (existing) {
        if (!isDeepStrictEqual(
          projectDaemonCreateRequestReplayParameters(existing),
          projectDaemonCreateRequestReplayParameters(entry),
        )) {
          throw new Error(`Supervised creation request '${entry.id}' is already bound to different agent parameters.`);
        }
        // A retry after a lost response must observe the durable entry as it is
        // now. It must never rewind running lifecycle state back to the paused
        // creation claim supplied by the retried request.
        return existing;
      }
      if (entry.desired_state !== "stopped") {
        const supervisedOwner = this.competingSupervisedLaneOwner(manifest.entries, entry);
        if (supervisedOwner) {
          throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by supervised entry '${supervisedOwner.id}'.`);
        }
        // A paused supervised entry may atomically become the pending transfer
        // claim while one legacy engine is still running. It cannot activate
        // until that exact legacy reservation has been released.
        const legacyOwner = legacyOwners.find((candidate) =>
          candidate.room_id === entry.room_id && candidate.provider === entry.provider);
        if (legacyOwner && entry.desired_state === "running") {
          throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by legacy reservation '${legacyOwner.reservation_id}'.`);
        }
      }
      const nextEntry: DaemonManifestEntry = {
        ...entry,
        workplace_liveness: entry.workplace_liveness ?? { state: "unknown", observed_at: null, detail: null },
        native_liveness: entry.native_liveness ?? { state: "unknown", observed_at: null, detail: null },
        activity: (entry.activity ?? []).slice(-200),
      };
      const entries = [...manifest.entries, nextEntry];
      const next = await this.writeManifest(this.manifestGeneration, entries, legacyOwners);
      this.manifestGeneration = next.generation;
      return nextEntry;
    });
    this.requestConvergence(updated.id);
    return updated;
  }

  private async setDesiredState(id: string, desiredState: DesiredState): Promise<DaemonManifestEntry> {
    if (!id) throw new Error("Manifest entry id is required.");
    if (!["running", "paused", "stopped"].includes(desiredState)) throw new Error("Invalid desired state.");
    this.bumpEntryControlEpoch(id);
    const updated = await this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
      const entry = manifest.entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      if (desiredState !== "stopped") {
        const supervisedOwner = this.competingSupervisedLaneOwner(manifest.entries, entry);
        if (supervisedOwner) {
          throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by supervised entry '${supervisedOwner.id}'.`);
        }
        const legacyOwner = legacyOwners.find((candidate) =>
          candidate.room_id === entry.room_id && candidate.provider === entry.provider);
        if (legacyOwner && desiredState === "running") {
          throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by legacy reservation '${legacyOwner.reservation_id}'.`);
        }
      }
      const updated = { ...entry, desired_state: desiredState };
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries.map((candidate) => candidate.id === id ? updated : candidate), legacyOwners);
      this.manifestGeneration = next.generation;
      return updated;
    });
    if (desiredState !== "running") {
      this.clearRecoveryConvergence(id);
      void this.supervisedDelivery?.stop(id).catch(() => undefined);
    }
    this.requestConvergence(id);
    return updated;
  }

  private async compareAndSetDesiredState(
    id: string,
    expectedDesiredState: DesiredState,
    desiredState: DesiredState,
  ): Promise<{ applied: boolean; entry: DaemonManifestEntry }> {
    if (!id) throw new Error("Manifest entry id is required.");
    if (!["running", "paused", "stopped"].includes(expectedDesiredState)) throw new Error("Invalid expected desired state.");
    if (!["running", "paused", "stopped"].includes(desiredState)) throw new Error("Invalid desired state.");
    this.bumpEntryControlEpoch(id);
    const result = await this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
      const entry = manifest.entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      if (entry.desired_state !== expectedDesiredState) return { applied: false, entry };
      if (desiredState !== "stopped") {
        const supervisedOwner = this.competingSupervisedLaneOwner(manifest.entries, entry);
        if (supervisedOwner) {
          throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by supervised entry '${supervisedOwner.id}'.`);
        }
        const legacyOwner = legacyOwners.find((candidate) =>
          candidate.room_id === entry.room_id && candidate.provider === entry.provider);
        if (legacyOwner && desiredState === "running") {
          throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by legacy reservation '${legacyOwner.reservation_id}'.`);
        }
      }
      const updated = { ...entry, desired_state: desiredState };
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries.map((candidate) => candidate.id === id ? updated : candidate), legacyOwners);
      this.manifestGeneration = next.generation;
      return { applied: true, entry: updated };
    });
    if (result.applied) {
      if (desiredState !== "running") {
        this.clearRecoveryConvergence(id);
        void this.supervisedDelivery?.stop(id).catch(() => undefined);
      }
      this.requestConvergence(id);
    } else {
      // The speculative epoch bump may have fenced an in-flight launch even
      // though the CAS lost. Reconcile the unchanged durable state again.
      this.requestConvergence(id);
    }
    return result;
  }

  private controlTurn(input: {
    entryId: string;
    workAttemptId: string;
    executionGenerationId: string;
    actionId: string;
    correction: string | null;
  }): Promise<DaemonTurnControlResult> {
    for (const [field, value] of Object.entries({
      id: input.entryId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      action_id: input.actionId,
    })) {
      if (!value.trim()) throw new Error(`Turn control ${field} is required.`);
    }
    const requestKey = `${input.entryId}:${input.actionId}`;
    const existing = this.turnControlRequests.get(requestKey);
    if (existing) return existing;
    if (this.turnControlActiveEntries.has(input.entryId)) {
      throw new Error("A turn-control action is already in flight for this exact supervised entry.");
    }
    this.turnControlActiveEntries.add(input.entryId);
    const operation = this.controlTurnOnce(input).finally(() => {
      this.turnControlRequests.delete(requestKey);
      this.turnControlActiveEntries.delete(input.entryId);
    });
    this.turnControlRequests.set(requestKey, operation);
    return operation;
  }

  private async resolveTurnControl(input: {
    entryId: string;
    workAttemptId: string;
    executionGenerationId: string;
    actionId: string;
    resolution: "not_applied" | "applied";
  }): Promise<DaemonManifestEntryView> {
    if (!input.entryId || !input.workAttemptId || !input.executionGenerationId || !input.actionId) {
      throw new Error("Exact turn-control resolution identity is required.");
    }
    if (input.resolution !== "not_applied" && input.resolution !== "applied") {
      throw new Error("Turn-control resolution must be 'not_applied' or 'applied'.");
    }
    const updated = await this.updateManifestEntry(input.entryId, (current) => {
      const control = current.turn_control;
      if (!control
        || control.action_id !== input.actionId
        || control.work_attempt_id !== input.workAttemptId
        || control.execution_generation_id !== input.executionGenerationId
        || current.work_attempt_id !== input.workAttemptId
        || current.provider_ref?.execution_generation_id !== input.executionGenerationId) {
        throw new Error("Turn-control resolution identity is stale or belongs to another execution.");
      }
      if (control.status !== "uncertain") {
        throw new Error("Only an uncertain turn-control outcome requires operator resolution.");
      }
      const updatedAt = new Date().toISOString();
      const activity = [...(current.activity ?? []), sanitizeDaemonActivityEvent({
        observed_at: updatedAt,
        sequence: ((current.activity ?? []).at(-1)?.sequence ?? 0) + 1,
        provider: current.provider,
        kind: "turn_lifecycle",
        method: "supervisor/resolve-turn-control",
        summary: input.resolution === "not_applied"
          ? "Operator verified the ambiguous native effect was not applied; retry enabled"
          : "Operator verified the ambiguous native effect was applied",
        status: current.observed_state === "working" ? "working" : "idle",
        payload: { action_id: control.action_id, resolution: input.resolution },
        payload_truncated: false,
        payload_redacted: false,
        durable_payload_ref: null,
      })].slice(-200);
      if (input.resolution === "not_applied") {
        return {
          ...current,
          activity,
          turn_control: {
            ...control,
            status: "retryable",
            stages: [],
            error: "Operator verified that the prior native effect was not applied; retry is enabled.",
            updated_at: updatedAt,
          },
        };
      }
      return {
        ...current,
        activity,
        reconciliation: rememberCompletedControlAction(
          advanceReconciliationState(current.reconciliation, current.observed_state, this.nowMs()),
          control.action_id,
        ),
        turn_control: {
          ...control,
          status: "completed",
          interrupted: true,
          resumed: control.has_correction,
          state: current.observed_state === "working" ? "working" : "idle",
          stages: ["already_applied"],
          error: "Operator verified that the prior native effect was applied.",
          updated_at: updatedAt,
        },
      };
    });
    return this.entryWithDerivedLiveness(updated);
  }

  private async controlTurnOnce(input: {
    entryId: string;
    workAttemptId: string;
    executionGenerationId: string;
    actionId: string;
    correction: string | null;
  }): Promise<DaemonTurnControlResult> {
    await this.singleton.assertCurrent();
    const manifest = await this.store.load();
    const entry = manifest.entries.find((candidate) => candidate.id === input.entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entryId}`);
    const ref = entry.provider_ref;
    if (entry.desired_state !== "running") throw new Error("Turn control requires desired_state=running.");
    if (entry.condition !== "none" || (entry.observed_state !== "working" && entry.observed_state !== "idle")) {
      throw new Error("Turn control requires a healthy working or idle supervised entry.");
    }
    if (!entry.work_attempt_id || entry.work_attempt_id !== input.workAttemptId || ref?.work_attempt_id !== input.workAttemptId) {
      throw new Error("Turn control work attempt is stale or belongs to a different entry.");
    }
    if (!ref || ref.execution_generation_id !== input.executionGenerationId) {
      throw new Error("Turn control execution generation is stale or incomplete.");
    }
    const reconciliation = advanceReconciliationState(entry.reconciliation, entry.observed_state, this.nowMs());
    const capabilities = await this.providerPort?.capabilities(input.workAttemptId, entry.provider);
    const capability = capabilities?.turnControl ?? "unsupported";
    const correction = input.correction?.trim() || null;
    const existingControl = entry.turn_control;
    const retryingControl = existingControl?.action_id === input.actionId
      && existingControl.status === "retryable";
    if (existingControl?.action_id === input.actionId) {
      if (existingControl.work_attempt_id !== input.workAttemptId
        || existingControl.execution_generation_id !== input.executionGenerationId
        || existingControl.has_correction !== Boolean(correction)) {
        throw new Error("Turn control action id was reused with different fenced input.");
      }
      if (existingControl.status === "completed") {
        return {
          entryId: input.entryId,
          workAttemptId: input.workAttemptId,
          executionGenerationId: input.executionGenerationId,
          actionId: input.actionId,
          capability: existingControl.capability,
          interrupted: existingControl.interrupted === true,
          resumed: existingControl.resumed === true,
          state: existingControl.state ?? (entry.observed_state === "working" ? "working" : "idle"),
          duplicate: true,
          stages: ["already_applied"],
        };
      }
      if (!retryingControl) {
        throw new Error("Turn control was durably dispatched but its provider outcome is unresolved; it was not replayed.");
      }
    }
    if (existingControl
      && existingControl.work_attempt_id === input.workAttemptId
      && existingControl.execution_generation_id === input.executionGenerationId
      && existingControl.status !== "completed"
      && existingControl.status !== "retryable") {
      throw new Error(`Turn control action '${existingControl.action_id}' is unresolved; refusing a second action on the same execution generation.`);
    }
    if (reconciliation.completed_action_ids.includes(input.actionId)) {
      return {
        entryId: input.entryId,
        workAttemptId: input.workAttemptId,
        executionGenerationId: input.executionGenerationId,
        actionId: input.actionId,
        capability,
        interrupted: false,
        resumed: Boolean(input.correction?.trim()),
        state: entry.observed_state === "working" ? "working" : "idle",
        duplicate: true,
        stages: ["already_applied"],
      };
    }
    if (!this.providerPort?.controlTurn || capability === "unsupported") {
      throw new Error(`Provider '${entry.provider}' does not support supervised turn control.`);
    }
    const binding = await this.workerBindings.get(entry.id);
    if (!binding
      || binding.room_id !== entry.room_id
      || binding.work_attempt_id !== input.workAttemptId
      || binding.execution_generation_id !== input.executionGenerationId) {
      throw new Error("Turn control requires the exact active worker binding for this execution generation.");
    }
    const attempt = await this.durability.getAttempt(input.workAttemptId);
    const execution = attempt.execution_generations.find((candidate) =>
      candidate.execution_generation_id === input.executionGenerationId);
    if (!execution || execution.terminal) throw new Error("Turn control execution generation is no longer live.");
    let handle = this.liveHandles.get(entry.id) ?? null;
    if (!handle) handle = await this.attachLiveProvider(entry);
    if (!handle
      || handle.workAttemptId !== input.workAttemptId
      || handle.providerContinuationId !== ref.provider_continuation_id) {
      throw new Error("Turn control could not resolve the exact live provider continuation.");
    }
    const recordedAt = new Date().toISOString();
    await this.updateManifestEntry(entry.id, (current) => {
      if (current.work_attempt_id !== input.workAttemptId
        || current.provider_ref?.execution_generation_id !== input.executionGenerationId) {
        throw new Error("Turn control was superseded before durable acceptance.");
      }
      if (current.turn_control?.action_id === input.actionId && current.turn_control.status !== "retryable") return current;
      if (current.turn_control
        && current.turn_control.work_attempt_id === input.workAttemptId
        && current.turn_control.execution_generation_id === input.executionGenerationId
        && current.turn_control.status !== "completed"
        && current.turn_control.status !== "retryable") {
        throw new Error(`Turn control action '${current.turn_control.action_id}' became unresolved before dispatch.`);
      }
      return {
        ...current,
        turn_control: {
          action_id: input.actionId,
          work_attempt_id: input.workAttemptId,
          execution_generation_id: input.executionGenerationId,
          has_correction: Boolean(correction),
          status: "prepared",
          capability,
          interrupted: null,
          resumed: null,
          state: null,
          stages: [],
          error: null,
          recorded_at: recordedAt,
          updated_at: recordedAt,
        },
      };
    });
    let providerResult: ProviderTurnControlResult;
    let dispatchMarked = false;
    try {
      providerResult = await this.providerPort.controlTurn(handle, correction, {
        actionId: input.actionId,
        markDispatched: async () => {
          if (dispatchMarked) return;
          await this.updateManifestEntry(entry.id, (current) => {
            if (current.turn_control?.action_id !== input.actionId
              || current.work_attempt_id !== input.workAttemptId
              || current.provider_ref?.execution_generation_id !== input.executionGenerationId) {
              throw new Error("Turn control lost its durable prepared journal before native dispatch.");
            }
            return {
              ...current,
              turn_control: {
                ...current.turn_control,
                status: "dispatching",
                updated_at: new Date().toISOString(),
              },
            };
          });
          dispatchMarked = true;
        },
      });
      if ((providerResult.interrupted || providerResult.resumed) && !dispatchMarked) {
        throw new Error("Provider reported a turn-control effect without marking native dispatch.");
      }
    } catch (error) {
      const message = redactCredentialText(error instanceof Error ? error.message : String(error)).value;
      const outcome = error && typeof error === "object" && "turnControlOutcome" in error
        ? (error as { turnControlOutcome?: unknown }).turnControlOutcome
        : null;
      await this.updateManifestEntry(entry.id, (current) => current.turn_control?.action_id === input.actionId
        ? {
          ...current,
          turn_control: {
            ...current.turn_control,
            status: outcome === "not_applied" ? "retryable" : dispatchMarked ? "uncertain" : "retryable",
            error: message,
            updated_at: new Date().toISOString(),
          },
        }
        : current);
      throw error;
    }
    const stages: DaemonTurnControlResult["stages"] = ["delivered"];
    if (providerResult.interrupted) stages.push("interrupting");
    stages.push("applied");
    if (providerResult.resumed) stages.push("resumed");
    const observedAt = new Date().toISOString();
    await this.updateManifestEntry(entry.id, (current) => {
      if (current.work_attempt_id !== input.workAttemptId
        || current.provider_ref?.execution_generation_id !== input.executionGenerationId) {
        throw new Error("Turn control completed after its execution generation was superseded.");
      }
      const nextReconciliation = rememberCompletedControlAction(
        advanceReconciliationState(current.reconciliation, providerResult.state, this.nowMs()),
        input.actionId,
      );
      const activity = [...(current.activity ?? []), sanitizeDaemonActivityEvent({
        observed_at: observedAt,
        sequence: ((current.activity ?? []).at(-1)?.sequence ?? 0) + 1,
        provider: current.provider,
        kind: "turn_lifecycle",
        method: correction ? "supervisor/steer" : "supervisor/stop-turn",
        summary: correction ? "Human correction applied; same continuation resumed" : "Active turn interrupted; worker remains available",
        status: providerResult.state === "working" ? "working" : "idle",
        payload: { action_id: input.actionId, capability, stages },
        payload_truncated: false,
        payload_redacted: false,
        durable_payload_ref: null,
      })].slice(-200);
      return {
        ...current,
        observed_state: providerResult.state,
        native_liveness: {
          state: providerResult.state === "working" ? "active" : "idle",
          observed_at: observedAt,
          detail: correction ? "human correction resumed on the same continuation" : "turn interrupted; worker available",
        },
        activity,
        reconciliation: nextReconciliation,
        turn_control: {
          action_id: input.actionId,
          work_attempt_id: input.workAttemptId,
          execution_generation_id: input.executionGenerationId,
          has_correction: Boolean(correction),
          status: "completed",
          capability,
          interrupted: providerResult.interrupted,
          resumed: providerResult.resumed,
          state: providerResult.state,
          stages,
          error: null,
          recorded_at: current.turn_control?.action_id === input.actionId
            ? current.turn_control.recorded_at
            : recordedAt,
          updated_at: observedAt,
        },
      };
    });
    return {
      entryId: input.entryId,
      workAttemptId: input.workAttemptId,
      executionGenerationId: input.executionGenerationId,
      actionId: input.actionId,
      duplicate: false,
      stages,
      ...providerResult,
    };
  }

  private async reserveLegacyLane(input: { reservation_id: string; room_id: string; provider: string; owner_pid: number; owner_process_identity: string }): Promise<LegacyLaneOwner> {
    for (const [field, value] of Object.entries({ reservation_id: input.reservation_id, room_id: input.room_id, provider: input.provider })) {
      if (!value.trim()) throw new Error(`Legacy lane ${field} is required.`);
    }
    if (!Number.isSafeInteger(input.owner_pid) || input.owner_pid < 1) throw new Error("Legacy lane owner_pid is required.");
    if (!input.owner_process_identity.trim()) throw new Error("Legacy lane owner_process_identity is required.");
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
      const duplicate = legacyOwners.find((candidate) => candidate.reservation_id === input.reservation_id);
      if (duplicate) {
        if (duplicate.room_id !== input.room_id || duplicate.provider !== input.provider) {
          throw new Error(`Legacy reservation '${input.reservation_id}' is already bound to another lane.`);
        }
        if (duplicate.owner_pid !== input.owner_pid || duplicate.owner_process_identity !== input.owner_process_identity) {
          throw new Error(`Legacy reservation '${input.reservation_id}' belongs to another Electron process.`);
        }
        return duplicate;
      }
      const supervisedOwner = manifest.entries.find((candidate) =>
        candidate.room_id === input.room_id && candidate.provider === input.provider && this.isSupervisedLaneOwner(candidate));
      if (supervisedOwner) {
        throw new Error(`Provider lane '${input.room_id}/${input.provider}' is already owned by supervised entry '${supervisedOwner.id}'.`);
      }
      const legacyOwner = legacyOwners.find((candidate) =>
        candidate.room_id === input.room_id && candidate.provider === input.provider);
      if (legacyOwner) {
        throw new Error(`Provider lane '${input.room_id}/${input.provider}' is already owned by legacy reservation '${legacyOwner.reservation_id}'.`);
      }
      const now = new Date().toISOString();
      const owner: LegacyLaneOwner = {
        ...input,
        state: "reserved",
        session_id: null,
        created_at: now,
        updated_at: now,
      };
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries, [...legacyOwners, owner]);
      this.manifestGeneration = next.generation;
      return owner;
    });
  }

  private liveLegacyLaneOwners(owners: readonly LegacyLaneOwner[]): LegacyLaneOwner[] {
    return owners.filter((owner) => owner.state === "active" || this.isProcessOwnerLive(owner.owner_pid, owner.owner_process_identity));
  }

  private isProcessOwnerLive(pid: number, expectedIdentity: string): boolean {
    try {
      // Read the start-time-only identity to match how Electron records the owner
      // (defaultGetProcessIdentity). Compare the stable birth prefix, not the whole
      // string — a live owner whose recorded identity omits the mutable command must
      // still read live, or its reservation is wrongly pruned before activate.
      const identity = execFileSync(
        "/bin/ps",
        ["-p", String(pid), "-o", "lstart="],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return Boolean(identity) && sameProcessBirthIdentity(identity, expectedIdentity);
    } catch (error) {
      try {
        process.kill(pid, 0);
        // Unknown evidence fails closed: retain the fence until a later
        // reconciliation can prove absence or birth-identity mismatch.
        return true;
      } catch (killError) {
        return (killError as NodeJS.ErrnoException).code === "EPERM";
      }
    }
  }

  private async recoverOrphanedLegacyReservations(): Promise<void> {
    await this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const owners = manifest.legacy_lane_owners ?? [];
      const live = this.liveLegacyLaneOwners(owners);
      if (live.length === owners.length) return;
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries, live);
      this.manifestGeneration = next.generation;
    });
  }

  private async activateLegacyLane(reservationId: string, sessionId: string): Promise<LegacyLaneOwner> {
    if (!reservationId.trim() || !sessionId.trim()) throw new Error("Legacy reservation and session ids are required.");
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
      const owner = legacyOwners.find((candidate) => candidate.reservation_id === reservationId);
      if (!owner) throw new Error(`Unknown legacy lane reservation: ${reservationId}`);
      if (owner.state === "active" && owner.session_id !== sessionId) {
        throw new Error(`Legacy reservation '${reservationId}' is already active for another session.`);
      }
      const updated: LegacyLaneOwner = { ...owner, state: "active", session_id: sessionId, updated_at: new Date().toISOString() };
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries, legacyOwners
        .map((candidate) => candidate.reservation_id === reservationId ? updated : candidate));
      this.manifestGeneration = next.generation;
      return updated;
    });
  }

  private async releaseLegacyLane(input: { reservation_id: string | null; session_id: string | null; room_id: string | null; provider: string | null }): Promise<{ released: boolean }> {
    const reservationId = input.reservation_id?.trim() || null;
    const sessionId = input.session_id?.trim() || null;
    const roomId = input.room_id?.trim() || null;
    const provider = input.provider?.trim() || null;
    if (!reservationId && !sessionId && !(roomId && provider)) {
      throw new Error("Legacy reservation_id, session_id, or complete room/provider lane is required.");
    }
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const owners = manifest.legacy_lane_owners ?? [];
      const retained = owners.filter((candidate) => !(
        (reservationId && candidate.reservation_id === reservationId)
        || (sessionId && candidate.session_id === sessionId)
        || (roomId && provider && candidate.room_id === roomId && candidate.provider === provider)
      ));
      if (retained.length === owners.length) return { released: false };
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries, retained);
      this.manifestGeneration = next.generation;
      return { released: true };
    });
  }

  private async appendActivity(id: string, event: DaemonActivityEvent): Promise<DaemonManifestEntry> {
    if (!event || typeof event !== "object" || !event.observed_at) throw new Error("A bounded activity event is required.");
    const sanitizedEvent = sanitizeDaemonActivityEvent(event);
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const entry = await this.store.getEntry(id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      const lastSequence = entry.activity?.at(-1)?.sequence ?? -1;
      if (sanitizedEvent.sequence <= lastSequence) throw new Error(`Native activity sequence ${sanitizedEvent.sequence} is not newer than ${lastSequence}.`);
      const updated: DaemonManifestEntry = {
        ...entry,
        observed_state: sanitizedEvent.status === "working" || sanitizedEvent.status === "reviewing" ? "working" : sanitizedEvent.status === "blocked" ? entry.observed_state : "idle",
        native_liveness: { state: sanitizedEvent.status === "idle" ? "idle" : "active", observed_at: sanitizedEvent.observed_at, detail: sanitizedEvent.summary },
        activity: [...(entry.activity ?? []), sanitizedEvent].slice(-200),
      };
      const next = await this.store.appendActivity(
        this.manifestGeneration,
        id,
        sanitizedEvent,
        updated.observed_state,
        updated.native_liveness!,
        200,
        (commit) => this.fenceDaemonCommit(commit),
      );
      this.manifestGeneration = next.generation;
      return next.entry;
    });
  }

  private async updateWorkplaceLiveness(id: string, state: "reachable" | "stale" | "unknown", detail: string | null, observedAt: string): Promise<DaemonManifestEntry> {
    if (!id) throw new Error("Manifest entry id is required.");
    if (!["reachable", "stale", "unknown"].includes(state)) throw new Error("Invalid workplace liveness state.");
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const entry = await this.store.getEntry(id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      const updated: DaemonManifestEntry = { ...entry, workplace_liveness: { state, observed_at: observedAt, detail } };
      const next = await this.store.updateWorkplaceLiveness(
        this.manifestGeneration,
        id,
        updated.workplace_liveness!,
        (commit) => this.fenceDaemonCommit(commit),
      );
      this.manifestGeneration = next.generation;
      return next.entry;
    });
  }

  private async entriesWithDerivedLiveness(entries: DaemonManifestEntry[]): Promise<DaemonManifestEntryView[]> {
    const bindings = new Map((await this.workerBindings.list()).map((binding) => [binding.entry_id, binding]));
    return Promise.all(entries.map((entry) => this.entryWithDerivedLiveness(entry, bindings.get(entry.id) ?? null)));
  }

  private async entryWithDerivedLiveness(
    entry: DaemonManifestEntry,
    projectedBinding?: WorkerSessionBinding | null,
  ): Promise<DaemonManifestEntryView> {
    const now = this.nowMs();
    const derive = <T extends string>(
      axis: { state: T; observed_at: string | null; detail: string | null } | undefined,
      staleStates: string[],
      staleAfterMs: number,
    ) => {
      if (!axis?.observed_at || !staleStates.includes(axis.state)) return axis;
      const observed = Date.parse(axis.observed_at);
      return Number.isFinite(observed) && now - observed > staleAfterMs
        ? { ...axis, state: "stale" }
        : axis;
    };
    const binding = projectedBinding === undefined ? await this.workerBindings.get(entry.id) : projectedBinding;
    const bindingMatchesCurrentGeneration = Boolean(
      binding &&
      entry.desired_state === "running" &&
      ["starting", "working", "idle", "recovering"].includes(entry.observed_state) &&
      binding.room_id === entry.room_id &&
      binding.work_attempt_id === entry.work_attempt_id &&
      binding.execution_generation_id === entry.provider_ref?.execution_generation_id,
    );
    // The binding store is advanced by accepted, exact wait publications. It
    // is the live workplace clock; the manifest timestamp only records the
    // original bind and deliberately is not rewritten for every long poll.
    const workplaceLiveness = bindingMatchesCurrentGeneration && binding
      ? {
          state: "reachable" as const,
          observed_at: binding.updated_at,
          detail: entry.workplace_liveness?.detail ?? "supervised worker session bound",
        }
      : entry.workplace_liveness;
    const receipts = await this.supervisedInbox.receipts(entry.id);
    const credential = bindingMatchesCurrentGeneration && binding
      ? await this.workerBindings.credentialFor(binding)
      : null;
    const deliveryReceipts = projectDeliveryReceipts(receipts);
    const nonfinal = receipts.filter((receipt) => receipt.state !== "acknowledged" && receipt.state !== "acknowledged_no_reply");
    const head = nonfinal[0] ?? null;
    const blocked = receipts.find((receipt) => receipt.receipt_state === "blocked") ?? null;
    const hasCurrentBinding = Boolean(bindingMatchesCurrentGeneration && binding);
    const waitingForDesktopGrant = this.requiresHostGrant(entry) && !this.currentHostGrant(entry);
    const connection = hasCurrentBinding
      ? { state: "connected" as const, observed_at: binding!.updated_at, detail: "supervised worker session bound" }
      : entry.desired_state === "running" && ["starting", "recovering"].includes(entry.observed_state)
        ? { state: "reconnecting" as const, observed_at: entry.workplace_liveness?.observed_at ?? null, detail: waitingForDesktopGrant ? "Waiting for desktop credential handoff." : "Awaiting the current worker binding." }
        : { state: "disconnected" as const, observed_at: entry.workplace_liveness?.observed_at ?? null, detail: "No current supervised worker binding." };
    const cutoverNeedsAttention = entry.provider === "codex"
      && (entry.delivery_mode ?? "mcp_polling") === "mcp_polling"
      && entry.delivery_cutover?.phase === "uncertain";
    const inbox = cutoverNeedsAttention
      ? {
          state: "blocked" as const,
          pending_count: nonfinal.length,
          blocked_by_message_id: null,
          detail: `Daemon inbox cutover needs attention; legacy polling remains fenced. ${entry.delivery_cutover?.error ?? "Exact turn state is uncertain."}`,
        }
      : !hasCurrentBinding || !credential
      ? { state: "waiting_for_desktop_credentials" as const, pending_count: nonfinal.length, blocked_by_message_id: blocked?.source_message_id ?? null, detail: waitingForDesktopGrant || hasCurrentBinding ? "Waiting for desktop credential handoff." : "A current worker binding is required before delivery can start." }
      : blocked
        ? { state: "blocked" as const, pending_count: nonfinal.length, blocked_by_message_id: blocked.source_message_id, detail: blocked.last_error ?? "An earlier delivery needs attention." }
        : nonfinal.length
          ? { state: "queued" as const, pending_count: nonfinal.length, blocked_by_message_id: null, detail: "Room delivery is queued." }
          : { state: "empty" as const, pending_count: 0, blocked_by_message_id: null, detail: null };
    const liveHandle = this.liveHandles.get(entry.id);
    const hasLiveDeliveryOwner = Boolean(
      hasCurrentBinding && credential && liveHandle
      && liveHandle.workAttemptId === entry.work_attempt_id
      && liveHandle.providerContinuationId === entry.provider_ref?.provider_continuation_id
      && entry.provider_ref?.execution_generation_id === binding?.execution_generation_id,
    );
    const activeTurn = hasLiveDeliveryOwner && binding && credential && liveHandle
      ? this.supervisedDelivery?.activeTurn({
          agentId: entry.id, roomId: binding.room_id, provider: entry.provider, apiUrl: binding.api_url,
          agentSessionId: binding.agent_session_id, bearer: credential, handle: liveHandle,
          executionGenerationId: binding.execution_generation_id, daemonGeneration: this.singleton.currentGeneration,
          deliveryMode: entry.delivery_mode ?? "mcp_polling",
        }) ?? null
      : null;
    const projectedTurn = projectDeliveryTurn(head, activeTurn);
    const turn = cutoverNeedsAttention
      ? {
          state: "failed" as const,
          inbox_item_id: null,
          source_message_id: null,
          provider_turn_id: entry.delivery_cutover?.provider_turn_id ?? null,
          detail: entry.delivery_cutover?.error ?? "Legacy polling turn cutover is uncertain; daemon ingress is fenced.",
        }
      : projectedTurn;
    return {
      ...entry,
      workplace_liveness: derive(
        workplaceLiveness,
        ["reachable"],
        workplaceLivenessStaleAfterMs(),
      ) as DaemonManifestEntry["workplace_liveness"],
      native_liveness: derive(
        entry.native_liveness,
        ["active", "idle"],
        NATIVE_LIVENESS_STALE_AFTER_MS,
      ) as DaemonManifestEntry["native_liveness"],
      worker_binding: bindingMatchesCurrentGeneration && binding ? {
        agent_session_id: binding.agent_session_id,
        work_attempt_id: binding.work_attempt_id,
        execution_generation_id: binding.execution_generation_id,
        updated_at: binding.updated_at,
      } : null,
      room_agent_state: {
        connection,
        inbox,
        turn,
        task: { state: "none", task_id: null, title: null },
      },
      delivery_receipts: deliveryReceipts,
    };
  }

  private async readAttempt(id: string) {
    const entry = (await this.store.load()).entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
    const attempt = entry.work_attempt_id ? await this.durability.getAttempt(entry.work_attempt_id) : null;
    const lastGeneration = attempt?.execution_generations.at(-1) ?? null;
    return {
      entry_id: entry.id,
      work_attempt_id: attempt?.work_attempt_id ?? null,
      workspace_path: attempt?.workspace_path ?? null,
      last_terminal: lastGeneration?.terminal ?? null,
      restart_count: Math.max(0, (attempt?.execution_generations.length ?? 0) - 1),
      execution_generations: attempt?.execution_generations ?? [],
      checkpoints: attempt?.checkpoints ?? [],
      activity: entry.activity ?? [],
    };
  }

  /** Queue convergence without making a control-socket caller wait for launch. */
  private requestConvergence(entryId: string): void {
    if (this.handoffScheduled || !this.providerPort || !this.autoConverge) return;
    const previous = this.convergenceRequests.get(entryId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      // Direct manifest convergence and the legacy reconciliation scheduler
      // both mutate provider authority for this entry. They must share one
      // serialization lane; otherwise a pause/resume edge can observe the
      // durable generation before its provider handle is installed and mint a
      // second live generation.
      .then(() => this.serializeEntryTick(entryId, () => this.convergeManifestEntry(entryId)))
      .catch(async (error) => {
        await this.recordSchedulerFailure(entryId, error, "daemon-convergence").catch(() => undefined);
      })
      .finally(() => {
        if (this.convergenceRequests.get(entryId) === next) this.convergenceRequests.delete(entryId);
      });
    this.convergenceRequests.set(entryId, next);
  }

  private currentEntryControlEpoch(entryId: string): number {
    return this.entryControlEpochs.get(entryId) ?? 0;
  }

  private bumpEntryControlEpoch(entryId: string): number {
    const next = this.currentEntryControlEpoch(entryId) + 1;
    this.entryControlEpochs.set(entryId, next);
    return next;
  }

  private reserveProviderDispatch(entryId: string, executionGenerationId: string): { token: symbol; release: (error?: unknown) => void } {
    const token = Symbol(`provider-dispatch:${entryId}`);
    let release!: () => void;
    let reject!: (error: unknown) => void;
    const reservation = new Promise<void>((resolve, rejectReservation) => { release = resolve; reject = rejectReservation; });
    // stopForHandoff awaits the original rejected promise. Outside handoff,
    // keep a rejection observed so an injected persistence+stop failure does
    // not become a process-level unhandled rejection.
    void reservation.catch(() => undefined);
    this.providerDispatchReservations.add(reservation);
    this.activeProviderDispatches.set(token, {
      entryId, executionGenerationId, daemonGeneration: this.singleton.currentGeneration,
    });
    return {
      token,
      release: (error) => {
        this.activeProviderDispatches.delete(token);
        this.providerDispatchReservations.delete(reservation);
        if (error === undefined) release();
        else {
          this.fatalProviderDispatchError ??= error;
          reject(error);
        }
      },
    };
  }

  /** Re-read durable intent after every delayed launch boundary. */
  private async launchEntryIfCurrent(entryId: string, expectedEpoch: number): Promise<DaemonManifestEntry | null> {
    if (this.handoffScheduled || this.currentEntryControlEpoch(entryId) !== expectedEpoch) return null;
    const current = await this.store.getEntry(entryId);
    if (this.handoffScheduled || this.currentEntryControlEpoch(entryId) !== expectedEpoch
      || current?.desired_state !== "running") return null;
    return current;
  }

  private async terminalizeUnlaunchedGeneration(
    attempt: Awaited<ReturnType<WorkDurabilityStore["getAttempt"]>>,
    executionGenerationId: string,
    generation: number,
  ): Promise<void> {
    const terminal = this.terminalPayload({
      endedAt: new Date().toISOString(), exitCode: 0, signal: null,
      terminalCause: "stopped", providerContinuationId: null,
    }, "daemon-provider");
    await this.durability.recordTerminal(attempt.work_attempt_id, executionGenerationId, {
      ...terminal, generation, actor: "daemon-provider",
    });
    await this.durability.releaseTerminalExecutionFence(attempt.work_attempt_id, executionGenerationId);
  }

  /** Stop and record the real terminal for a returned handle that could not be journaled. */
  private async fenceUnpersistedReturnedProvider(
    attempt: Awaited<ReturnType<WorkDurabilityStore["getAttempt"]>>,
    executionGenerationId: string,
    generation: number,
    handle: ProviderActionHandle,
  ): Promise<void> {
    const terminal = await this.providerPort!.stop(handle, {
      actionId: `manifest:unjournaled-dispatch-fence:${executionGenerationId}`,
    });
    await this.durability.recordTerminal(attempt.work_attempt_id, executionGenerationId, {
      ...this.terminalPayload(terminal, "daemon-provider"), generation, actor: "daemon-provider",
    });
    await this.durability.releaseTerminalExecutionFence(attempt.work_attempt_id, executionGenerationId);
  }

  /** A real handle returned after Pause/Stop won the race; fence that exact process. */
  private async fenceReturnedProviderAfterControl(
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    generation: number,
  ): Promise<boolean> {
    // A control request bumps the epoch before it queues its durable manifest
    // mutation. Drain that queue so the exact desired state, not a stale
    // pre-control row, decides whether this returned provider must be stopped.
    await this.serializeManifestMutation(async () => undefined);
    const current = await this.store.getEntry(entryId);
    if (!current || current.desired_state === "running") return false;
    await this.supervisedDelivery?.stop(entryId).catch(() => undefined);
    await this.transition(entryId, "stopping", current.condition, `desired state changed to ${current.desired_state} during provider dispatch`, "daemon-convergence");
    const terminal = await this.providerPort!.stop(handle, {
      actionId: `manifest:${entryId}:${current.desired_state}:dispatch-fence:${generation}`,
    });
    if (this.liveHandles.get(entryId) === handle) {
      this.liveHandles.delete(entryId);
      this.liveBindingIdentities.delete(entryId);
      for (const dispose of this.liveDisposers.get(entryId) ?? []) dispose();
      this.liveDisposers.delete(entryId);
    }
    const attempt = current.work_attempt_id ? await this.durability.getAttempt(current.work_attempt_id) : null;
    const execution = attempt?.execution_generations.find((candidate) => candidate.execution_generation_id === executionGenerationId);
    if (attempt && execution && !execution.terminal) {
      await this.durability.recordTerminal(attempt.work_attempt_id, executionGenerationId, {
        ...this.terminalPayload(terminal, execution.actor), generation: execution.generation,
      });
      if (current.desired_state === "stopped") {
        await this.durability.releaseTerminalExecutionFence(attempt.work_attempt_id, executionGenerationId);
      }
    }
    await this.observeProviderExitOnce(entryId, terminal, "daemon-provider", executionGenerationId, handle);
    return true;
  }

  private async revalidateReturnedProviderControl(
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    generation: number,
    expectedEpoch: number,
  ): Promise<"current" | "fenced" | "handoff"> {
    if (this.handoffScheduled) return "handoff";
    if (this.currentEntryControlEpoch(entryId) === expectedEpoch) return "current";
    return await this.fenceReturnedProviderAfterControl(entryId, handle, executionGenerationId, generation)
      ? "fenced"
      : this.handoffScheduled ? "handoff" : "current";
  }

  private async convergeManifestEntry(entryId: string): Promise<void> {
    if (this.handoffScheduled || !this.providerPort) return;
    let entry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    let launchControlEpoch = this.currentEntryControlEpoch(entryId);
    if (!this.providerPort) throw new Error(`No daemon provider port is available for ${entry.provider}.`);

    if (entry.desired_state === "running") {
      if (entry.condition === "quarantined") return;
      // daemon_inbox Codex has no ambient MCP credential.  Do not create a
      // provider (or even a new work execution) until Electron installs the
      // exact host grant over the local daemon socket.
      if (this.requiresHostGrant(entry) && !this.currentHostGrant(entry)) return;
      // A running provider from before cursor admission must not attach,
      // resume, or spawn in the grant-install/bootstrap gap. Bootstrap owns
      // the first-tail boundary and queues this convergence only afterwards.
      if (this.requiresHostGrant(entry) && !await this.supervisedInbox.cursor(entry.id)) return;
      if (this.requiresHostGrant(entry) && !await this.ensureHostGrantFresh(entry)) return;
      entry = await this.launchEntryIfCurrent(entry.id, launchControlEpoch) ?? entry;
      if (entry.desired_state !== "running" || this.currentEntryControlEpoch(entry.id) !== launchControlEpoch || this.handoffScheduled) return;
      if (entry.observed_state === "failed") {
        const now = this.nowMs();
        const exitsInWindow = (entry.reconciliation?.exit_timestamps_ms ?? [])
          .filter((at) => at >= now - CRASH_LOOP_WINDOW_MS).length;
        if (exitsInWindow >= CRASH_LOOP_EXIT_LIMIT) {
          await this.transition(
            entry.id,
            "failed",
            "quarantined",
            "crash-loop threshold reached before provider restart",
            "daemon-convergence",
          );
          return;
        }
        const restartAt = entry.reconciliation?.next_restart_at_ms;
        if (typeof restartAt === "number" && restartAt > now) {
          this.scheduleRecoveryConvergence(entry.id, restartAt - now);
          return;
        }
      }
      entry = await this.ensureWorkAttempt(entry);
      const currentAfterAttempt = await this.launchEntryIfCurrent(entry.id, launchControlEpoch);
      if (!currentAfterAttempt) return;
      entry = currentAfterAttempt;
      let handle = this.liveHandles.get(entry.id) ?? null;
      if (!handle && entry.provider_ref) {
        handle = await this.attachLiveProvider(entry);
        entry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId) ?? entry;
      }
      if (handle) {
        if (this.requiresHostGrant(entry) && this.currentHostGrant(entry)) {
          const binding = await this.workerBindings.get(entry.id);
          const credential = binding ? await this.workerBindings.credentialFor(binding) : null;
          const supervisedSession = binding ? await this.workerBindings.supervisedWorkerSession(entry.id) : null;
          const expiring = binding ? await this.hostWorkerBearerNeedsRotation(entry, binding) : false;
          if ((!credential || expiring) && entry.provider_ref?.execution_generation_id) {
            try {
              const minted = await this.mintHostWorkerSession(entry, entry.provider_ref.execution_generation_id);
              if (minted) await this.bindMintedHostWorkerSession(entry.id, minted);
            } catch (error) {
              // A still-live bearer remains usable until its deadline. Keep
              // the exact provider and let the next heartbeat retry rotation.
              const bearerExpiry = supervisedSession?.expires_at ? Date.parse(supervisedSession.expires_at) : Number.NaN;
              if (!credential) throw error;
              if (Number.isFinite(bearerExpiry) && bearerExpiry <= this.nowMs()) {
                await this.blockExpiredWorkerAuthority(entry, `Worker bearer rotation failed after expiry: ${error instanceof Error ? error.message : "unknown error"}`);
                return;
              }
            }
          }
        }
        if (entry.observed_state !== handle.observedState) {
          await this.transition(entry.id, handle.observedState, entry.condition, "reattached durable provider handle", "daemon-convergence");
        }
        if (["failed", "idle", "stopped"].includes(handle.observedState)) {
          await this.fenceTerminalProviderHandleOnce(
            handle,
            `manifest:${entry.id}:reattached-terminal:${entry.provider_ref?.execution_generation_id ?? "unknown"}`,
          );
        }
        return;
      }

      const attempt = await this.durability.getAttempt(entry.work_attempt_id!);
      const activeExecution = attempt.execution_generations.find((candidate) => candidate.terminal === null);
      if (activeExecution) {
        await this.transition(
          entry.id,
          "recovering",
          "coordination_blocked",
          "durable execution generation remains live without an attachable provider handle",
          "daemon-convergence",
        );
        return;
      }
      const priorBinding = entry.provider_ref ? await this.workerBindings.get(entry.id) : null;
      const resumeWorker = priorBinding
        && priorBinding.room_id === entry.room_id
        && priorBinding.work_attempt_id === attempt.work_attempt_id
        ? {
          agentSessionId: priorBinding.agent_session_id,
          roomCursor: priorBinding.room_cursor ?? null,
        }
        : null;
      const ref = entry.provider_ref ? this.providerRef(entry) : null;
      const mintedAuthorization = this.requiresHostGrant(entry)
        ? await this.mintHostWorkerAuthorization(entry)
        : null;
      if (this.requiresHostGrant(entry) && !mintedAuthorization) return;
      const currentAfterMint = await this.launchEntryIfCurrent(entry.id, launchControlEpoch);
      if (!currentAfterMint) return;
      entry = currentAfterMint;
      const capabilities = await this.providerPort.capabilities(attempt.work_attempt_id, entry.provider);
      const currentAfterCapabilities = await this.launchEntryIfCurrent(entry.id, launchControlEpoch);
      if (!currentAfterCapabilities) return;
      entry = currentAfterCapabilities;
      const resumed = Boolean(ref && capabilities.resume);
      if (this.requiresHostGrant(entry)) {
        const grant = this.currentHostGrant(entry);
        if (!grant || !await this.ownsDaemonGeneration(grant.daemonGeneration)) return;
      }
      // Every potentially long remote authorization/capability await is now
      // complete. Only then may this daemon create a durable live generation.
      await this.transition(entry.id, entry.provider_ref ? "recovering" : "starting", "none", entry.provider_ref ? "recovering durable provider continuation" : "starting daemon-owned provider", "daemon-convergence");
      const currentAfterTransition = await this.launchEntryIfCurrent(entry.id, launchControlEpoch);
      if (!currentAfterTransition) return;
      entry = currentAfterTransition;
      if (this.requiresHostGrant(entry)) {
        const grant = this.currentHostGrant(entry);
        if (!grant || !await this.ownsDaemonGeneration(grant.daemonGeneration)) return;
      }
      const generationNumber = attempt.execution_generations.reduce((max, candidate) => Math.max(max, candidate.generation), 0) + 1;
      const execution = await this.durability.startGeneration(attempt.work_attempt_id, "daemon-provider", generationNumber);
      if (!await this.launchEntryIfCurrent(entry.id, launchControlEpoch)) {
        await this.terminalizeUnlaunchedGeneration(attempt, execution.execution_generation_id, generationNumber);
        return;
      }
      const devMcpServerEntryPath = devMcpServerEntryFromEnv() ?? undefined;
      let mintedHostSession: Awaited<ReturnType<typeof this.mintHostWorkerSession>> = null;
      const spawn: ProviderActionSpawn = {
        workAttemptId: attempt.work_attempt_id,
        roomId: entry.room_id,
        cwd: attempt.workspace_path,
        launchPolicy: entry.provider_launch_policy ?? {},
        provider: entry.provider,
        deliveryMode: entry.delivery_mode ?? "mcp_polling",
        agentDisplayName: entry.display_name,
        actionId: `manifest:${entry.id}:generation:${generationNumber}`,
        supervisorEntryId: entry.id,
        supervisorSocketPath: this.socket.path,
        supervisorExecutionGenerationId: execution.execution_generation_id,
        ...(resumeWorker ? { supervisorWorkerSession: resumeWorker } : {}),
        ...(devMcpServerEntryPath && entry.provider === "codex" ? { devMcpServerEntryPath } : {}),
      };
      let providerPersisted = false;
      let providerDispatched = false;
      let unpersistedReturnedProviderFenced = false;
      try {
        if (mintedAuthorization) {
          mintedHostSession = await this.recordMintedHostWorkerSession(entry, execution.execution_generation_id, mintedAuthorization);
          if (!mintedHostSession) throw new Error("Waiting for desktop credential handoff.");
          Object.assign(spawn, { supervisorWorkerSession: { agentSessionId: mintedHostSession.agentSessionId, roomCursor: null } });
        }
        if (!await this.launchEntryIfCurrent(entry.id, launchControlEpoch)) {
          await this.terminalizeUnlaunchedGeneration(attempt, execution.execution_generation_id, generationNumber);
          return;
        }
        const dispatchReservation = this.reserveProviderDispatch(entry.id, execution.execution_generation_id);
        let fatalReservationError: unknown;
        try {
          try {
            handle = resumed
              ? await this.providerPort.resume(ref!, { ...spawn, resumeFrom: ref })
              : await this.providerPort.spawn(spawn);
            providerDispatched = true;
            await this.persistDispatchedProvider(
              dispatchReservation.token, entry.id, handle, execution.execution_generation_id,
            );
            providerPersisted = true;
            await this.durability.checkpoint(attempt.work_attempt_id, { room_cursor: null, provider_continuation_id: handle.providerContinuationId });
            if (this.handoffScheduled) {
              // The successor attaches this exact durable continuation. Do not
              // signal it or register callbacks owned by the retiring daemon.
              return;
            }
            let control = await this.revalidateReturnedProviderControl(
              entry.id, handle, execution.execution_generation_id, generationNumber, launchControlEpoch,
            );
            if (control === "handoff" || control === "fenced") return;
            launchControlEpoch = this.currentEntryControlEpoch(entry.id);
            // installProviderHandle has its own async listener-registration
            // boundaries. The synchronous guard prevents it from starting room
            // delivery if Pause/Stop/handoff wins during those awaits.
            if (this.handoffScheduled) return;
            await this.installProviderHandle(
              entry.id,
              handle,
              execution.execution_generation_id,
              () => !mintedHostSession
                && !this.handoffScheduled
                && this.currentEntryControlEpoch(entryId) === launchControlEpoch,
            );
            if (this.handoffScheduled) return;
            control = await this.revalidateReturnedProviderControl(
              entry.id, handle, execution.execution_generation_id, generationNumber, launchControlEpoch,
            );
            if (control === "handoff" || control === "fenced") return;
            launchControlEpoch = this.currentEntryControlEpoch(entry.id);

            if (mintedHostSession) {
              control = await this.revalidateReturnedProviderControl(
                entry.id, handle, execution.execution_generation_id, generationNumber, launchControlEpoch,
              );
              if (control === "handoff" || control === "fenced") return;
              launchControlEpoch = this.currentEntryControlEpoch(entry.id);
              try {
                await this.bindMintedHostWorkerSession(
                  entry.id,
                  mintedHostSession,
                  () => !this.handoffScheduled && this.currentEntryControlEpoch(entryId) === launchControlEpoch,
                );
              } catch (error) {
                if (this.handoffScheduled) return;
                control = await this.revalidateReturnedProviderControl(
                  entry.id, handle, execution.execution_generation_id, generationNumber, launchControlEpoch,
                );
                if (control === "handoff" || control === "fenced") return;
                await this.transition(
                  entry.id,
                  "recovering",
                  "coordination_blocked",
                  "Provider is running; waiting for desktop credential handoff.",
                  "daemon-convergence",
                );
                return;
              }
              if (this.handoffScheduled) return;
              control = await this.revalidateReturnedProviderControl(
                entry.id, handle, execution.execution_generation_id, generationNumber, launchControlEpoch,
              );
              if (control === "handoff" || control === "fenced") return;
              launchControlEpoch = this.currentEntryControlEpoch(entry.id);
            }

            // Last guard before terminal/bootstrap state and delivery logic
            // continue outside this native dispatch reservation.
            control = await this.revalidateReturnedProviderControl(
              entry.id, handle, execution.execution_generation_id, generationNumber, launchControlEpoch,
            );
            if (control === "handoff" || control === "fenced") return;
            launchControlEpoch = this.currentEntryControlEpoch(entry.id);
          } catch (error) {
            if (providerDispatched && !providerPersisted && handle) {
              try {
                await this.fenceUnpersistedReturnedProvider(
                  attempt, execution.execution_generation_id, generationNumber, handle,
                );
                unpersistedReturnedProviderFenced = true;
              } catch (cleanupError) {
                fatalReservationError = cleanupError;
                throw new AggregateError([error, cleanupError], "Returned provider could not be journaled or exactly fenced.");
              }
            }
            throw error;
          }
        } finally {
          dispatchReservation.release(fatalReservationError);
        }
      } catch (error) {
        if (providerPersisted && this.handoffScheduled) return;
        // Once the provider reference is durable, do not convert a local
        // post-spawn bookkeeping/credential issue into a terminal execution.
        // The exact provider remains the recovery target; no stop, restart,
        // migration, or second spawn is permitted here.
        if (providerPersisted) {
          await this.transition(
            entry.id,
            "recovering",
            "coordination_blocked",
            "Provider is running; waiting for desktop credential handoff.",
            "daemon-convergence",
          );
          return;
        }
        // A native handle that actually returned is never an "unlaunched"
        // generation. Persistence normally cannot fail here because the
        // active reservation falls back through the retirement gate, but an
        // unexpected fault must still avoid fabricating terminal evidence.
        if (providerDispatched || unpersistedReturnedProviderFenced) throw error;
        const terminal = this.terminalPayload({
          endedAt: new Date().toISOString(), exitCode: null, signal: null,
          terminalCause: "protocol_error", providerContinuationId: entry.provider_ref?.provider_continuation_id ?? null,
        }, "daemon-provider");
        try {
          await this.durability.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, { ...terminal, generation: generationNumber, actor: "daemon-provider" });
          await this.durability.releaseTerminalExecutionFence(attempt.work_attempt_id, execution.execution_generation_id);
        } catch (cleanupError) {
          const launchMessage = error instanceof Error ? error.message : "unknown provider launch failure";
          const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : "unknown failed-launch cleanup failure";
          throw new Error(`Provider launch failed (${launchMessage}) and durable cleanup failed (${cleanupMessage}).`, { cause: error });
        }
        throw error;
      }
      if (["failed", "stopped"].includes(handle.observedState)
        || (handle.observedState === "idle" && entry.delivery_mode !== "daemon_inbox")) {
        // A provider can finish the bootstrap turn before spawn/resume
        // returns and before the daemon has installed its stream listener.
        // The handle state is still authoritative: a persistent polling
        // worker that already failed or completed has no live delivery
        // loop. Fence it after installing the exit listener so the normal
        // terminal callback can persist the edge and mint a bounded resume
        // generation instead of parking forever on a terminal live handle.
        await this.fenceTerminalProviderHandleOnce(
          handle,
          `manifest:${entry.id}:returned-terminal:${generationNumber}`,
        );
        return;
      }
      if (priorBinding && !resumed) {
        await this.transition(
          entry.id,
          "recovering",
          "coordination_blocked",
          "fresh provider generation cannot inherit a terminal worker credential; awaiting exact bind",
          "daemon-convergence",
        );
        return;
      }
      if (resumed && priorBinding) {
        try {
          await this.stageWorkerBindingAfterResume(entry, priorBinding, execution.execution_generation_id, handle);
        } catch (error) {
          await this.transition(
            entry.id,
            "recovering",
            "coordination_blocked",
            `resumed provider worker binding could not be staged: ${error instanceof Error ? error.message : "unknown binding recovery failure"}`,
            "daemon-convergence",
          );
          return;
        }
        await this.transition(
          entry.id,
          "recovering",
          "coordination_blocked",
          "resumed provider awaits exact worker wait evidence",
          "daemon-convergence",
        );
        return;
      }
      await this.transition(entry.id, handle.observedState, "none", resumed ? "provider resumed under daemon authority" : "provider launched under daemon authority", "daemon-convergence");
      return;
    }

    let handle = this.liveHandles.get(entry.id) ?? null;
    if (!handle && entry.provider_ref) {
      handle = await this.attachLiveProvider(entry);
    }
    if (handle) {
      await this.transition(entry.id, "stopping", entry.condition, `desired state changed to ${entry.desired_state}`, "daemon-convergence");
      await this.providerPort.stop(handle, { actionId: `manifest:${entry.id}:${entry.desired_state}:${this.nowMs()}` });
      return;
    }
    await this.transition(entry.id, entry.desired_state === "paused" ? "paused" : "stopped", "none", "desired state converged without a live provider", "daemon-convergence");
  }

  private providerRef(entry: DaemonManifestEntry): ProviderActionRef {
    const ref = entry.provider_ref;
    if (!ref) throw new Error("Manifest entry has no durable provider ref.");
    return {
      workAttemptId: ref.work_attempt_id,
      providerContinuationId: ref.provider_continuation_id,
      provider: entry.provider,
      providerConnection: ref.provider_connection,
    };
  }

  /**
   * Attach only when the manifest's exact execution generation is still live.
   * A provider transport (for example a long-lived app-server) can remain
   * reachable after an intentional worker stop, but that transport is not
   * authority to resurrect the terminal generation. A later desired=running
   * transition must instead mint a successor generation and use resume/spawn.
   */
  private async attachLiveProvider(entry: DaemonManifestEntry): Promise<ProviderActionHandle | null> {
    const ref = entry.provider_ref;
    if (!ref) return null;
    const attempt = await this.durability.getAttempt(ref.work_attempt_id);
    const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === ref.execution_generation_id);
    if (!execution) throw new Error("Manifest provider reference has no matching durable execution generation.");
    if (execution.terminal) return null;
    const attachment = await this.providerPort!.attach(this.providerRef(entry));
    if (!attachment) return null;
    if (this.isAttachTerminal(attachment)) {
      const terminal = attachment.terminal;
      if (terminal.providerContinuationId && terminal.providerContinuationId !== ref.provider_continuation_id) {
        throw new Error("Provider attach terminal evidence belongs to a different durable continuation.");
      }
      await this.durability.recordTerminal(ref.work_attempt_id, execution.execution_generation_id, {
        ...this.terminalPayload(terminal, execution.actor),
        actor: execution.actor,
        generation: execution.generation,
      });
      // A no-handle attach result used to strand this generation forever. The
      // explicit terminal evidence proves the writer absent (or fenced), so it
      // is now safe to release workspace authority before bounded resume.
      await this.durability.releaseTerminalExecutionFence(ref.work_attempt_id, execution.execution_generation_id);
      // Keep the private credential on its durably terminal generation. It is
      // no longer projected or allowed to publish, but a later exact native
      // resume needs it for verify-before-rollover compatibility with workers
      // that cannot bind again after their saved provider session resumes.
      return null;
    }
    const handle = attachment;
    await this.durability.recoverExecutionFence(ref.work_attempt_id);
    await this.installProviderHandle(entry.id, handle, ref.execution_generation_id);
    const binding = await this.workerBindings.get(entry.id);
    if (binding && binding.execution_generation_id !== ref.execution_generation_id) {
      try {
        await this.stageWorkerBindingAfterResume(entry, binding, ref.execution_generation_id, handle);
        await this.transition(
          entry.id,
          "recovering",
          "coordination_blocked",
          "reattached resumed provider awaits exact worker wait evidence",
          "daemon-convergence",
        );
      } catch (error) {
        await this.transition(
          entry.id,
          "recovering",
          "coordination_blocked",
          `reattached provider worker binding could not be staged: ${error instanceof Error ? error.message : "unknown binding recovery failure"}`,
          "daemon-convergence",
        );
      }
    }
    return handle;
  }

  private isAttachTerminal(
    attachment: ProviderActionHandle | ProviderActionAttachTerminal,
  ): attachment is ProviderActionAttachTerminal {
    return "state" in attachment && attachment.state === "terminal";
  }

  private async ensureWorkAttempt(entry: DaemonManifestEntry): Promise<DaemonManifestEntry> {
    if (entry.work_attempt_id) {
      await this.durability.getAttempt(entry.work_attempt_id);
      return entry;
    }
    const sourcePath = entry.source_repo_path?.trim() || entry.workspace_path?.trim();
    if (!sourcePath) throw new Error("A source repository is required to provision a supervised work attempt.");
    const remote = String(await this.gitCommand(["-C", sourcePath, "remote", "get-url", "origin"])).trim();
    const revision = String(await this.gitCommand(["-C", sourcePath, "rev-parse", "--verify", "HEAD^{commit}"])).trim();
    const repo = repositoryStorageKey(remote);
    const workAttemptId = randomUUID();
    const provisioned = await this.provisioner.provision({
      repo,
      workAttemptId,
      taskId: entry.id,
      remoteUrl: remote,
      revision,
      sourceRepoPath: sourcePath,
    });
    const attempt = await this.durability.createAttempt({ taskId: entry.id, leaseId: entry.id, leaseEpoch: 0, workspacePath: provisioned.path, workAttemptId });
    return this.updateManifestEntry(entry.id, (current) => ({ ...current, source_repo_path: sourcePath, workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id }));
  }

  private async persistProviderHandle(entryId: string, handle: ProviderActionHandle, executionGenerationId: string): Promise<void> {
    if (!handle.providerContinuationId) throw new Error("Provider launch did not return a durable continuation id.");
    await this.updateManifestEntry(entryId, (current) => ({
      ...current,
      run_id: executionGenerationId,
      deployment_id: serializeDaemonDeploymentId(entryId, executionGenerationId),
      provider_ref: {
        work_attempt_id: handle.workAttemptId,
        provider_continuation_id: handle.providerContinuationId!,
        provider_connection: handle.providerConnection ?? null,
        execution_generation_id: executionGenerationId,
      },
    }));
  }

  /**
   * Select normal or retirement persistence while the exact native dispatch
   * reservation is live. If handoff wins the normal commit fence, retry only
   * through the narrow retirement gate before releasing the reservation.
   */
  private async persistDispatchedProvider(
    token: symbol,
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
  ): Promise<void> {
    if (this.handoffScheduled) {
      await this.persistReturnedProviderForHandoff(token, entryId, handle, executionGenerationId);
      return;
    }
    try {
      await this.persistProviderHandle(entryId, handle, executionGenerationId);
    } catch (error) {
      if (!this.handoffScheduled || !(error instanceof DaemonFenceLostError)) throw error;
      await this.persistReturnedProviderForHandoff(token, entryId, handle, executionGenerationId);
    }
  }

  /**
   * The sole mutation admitted after prepare_handoff: finish journaling a
   * native dispatch that began while this exact daemon generation owned the
   * singleton. The reservation is deleted before authority/store release.
   */
  private async persistReturnedProviderForHandoff(
    token: symbol,
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
  ): Promise<void> {
    if (!handle.providerContinuationId) throw new Error("Provider launch did not return a durable continuation id.");
    const reservation = this.activeProviderDispatches.get(token);
    if (!this.handoffScheduled || !reservation
      || reservation.entryId !== entryId
      || reservation.executionGenerationId !== executionGenerationId
      || reservation.daemonGeneration !== this.singleton.currentGeneration) {
      throw new DaemonFenceLostError("Retiring provider dispatch reservation is no longer exact.");
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await this.singleton.assertCurrent();
      const activeBeforeRead = this.activeProviderDispatches.get(token);
      if (!this.handoffScheduled || activeBeforeRead !== reservation
        || activeBeforeRead.daemonGeneration !== this.singleton.currentGeneration) {
        throw new DaemonFenceLostError("Retiring provider dispatch persistence gate closed.");
      }
      const snapshot = await this.store.load();
      const current = snapshot.entries.find((candidate) => candidate.id === entryId);
      if (!current || current.work_attempt_id !== handle.workAttemptId) {
        throw new DaemonFenceLostError("Retiring provider dispatch no longer matches the durable work attempt.");
      }
      if (current.provider_ref?.execution_generation_id === executionGenerationId
        && current.provider_ref.provider_continuation_id === handle.providerContinuationId) {
        this.manifestGeneration = snapshot.generation;
        return;
      }
      const updated: DaemonManifestEntry = {
        ...current,
        run_id: executionGenerationId,
        deployment_id: serializeDaemonDeploymentId(entryId, executionGenerationId),
        provider_ref: {
          work_attempt_id: handle.workAttemptId,
          provider_continuation_id: handle.providerContinuationId,
          provider_connection: handle.providerConnection ?? null,
          execution_generation_id: executionGenerationId,
        },
      };
      try {
        const next = await this.store.replaceEntry(snapshot.generation, updated, (commit) => this.serializeManifestCommit(async () => {
          const active = this.activeProviderDispatches.get(token);
          if (!this.handoffScheduled || active !== reservation
            || active.daemonGeneration !== this.singleton.currentGeneration) {
            throw new DaemonFenceLostError("Retiring provider dispatch persistence gate closed.");
          }
          await this.singleton.assertCurrent();
          await commit();
        }));
        this.manifestGeneration = next.generation;
        return;
      } catch (error) {
        if (!(error instanceof ManifestConflictError)) throw error;
      }
    }
    throw new DaemonFenceLostError("Retiring provider dispatch persistence could not converge on the latest manifest generation.");
  }

  private async installProviderHandle(
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    mayStartDelivery: () => boolean = () => true,
  ): Promise<void> {
    for (const dispose of this.liveDisposers.get(entryId) ?? []) dispose();
    this.liveHandles.set(entryId, handle);
    const binding = await this.workerBindings.get(entryId);
    const currentBinding = this.liveBindingIdentities.get(entryId);
    if (binding?.execution_generation_id === executionGenerationId) {
      if (!currentBinding || binding.updated_at >= currentBinding.updatedAt) {
        this.liveBindingIdentities.set(entryId, {
          agentSessionId: binding.agent_session_id,
          executionGenerationId: binding.execution_generation_id,
          updatedAt: binding.updated_at,
        });
      }
    } else if (currentBinding?.executionGenerationId !== executionGenerationId) {
      this.liveBindingIdentities.delete(entryId);
    }
    const disposeExit = await this.providerPort!.onExit(handle, (terminal) => {
      const bindingIdentity = this.liveBindingIdentities.get(entryId);
      this.trackProviderCallback(this.handleProviderTerminal(entryId, handle, executionGenerationId, bindingIdentity, terminal));
    });
    const disposeStream = this.providerPort!.onStream
      ? await this.providerPort!.onStream!(handle, (event) => { this.trackProviderCallback(this.enqueueProviderStream(entryId, handle, event)); })
      : () => {};
    const heartbeat = setInterval(() => {
      const current = this.liveHandles.get(entryId);
      if (!current) return;
      this.trackProviderCallback((async () => {
        const manifestEntry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId);
        if (!manifestEntry || this.liveHandles.get(entryId) !== current) return;
        if (this.liveBindingIdentities.get(entryId)?.executionGenerationId !== manifestEntry.provider_ref?.execution_generation_id) return;
        const retriesCredentialHandoff = manifestEntry.desired_state === "running"
          && manifestEntry.observed_state === "recovering"
          && manifestEntry.condition === "coordination_blocked"
          && manifestEntry.last_error === "Provider is running; waiting for desktop credential handoff.";
        if (!["working", "idle"].includes(manifestEntry.observed_state) && !retriesCredentialHandoff) return;
        if (!["working", "idle"].includes(current.observedState)) return;
        const hostGrant = this.requiresHostGrant(manifestEntry) ? this.currentHostGrant(manifestEntry) : null;
        if (hostGrant && this.hostGrantNeedsRenewal(hostGrant)) {
          this.requestConvergence(entryId);
          return;
        }
        if (hostGrant) {
          const binding = await this.workerBindings.get(entryId);
          if (binding && await this.hostWorkerBearerNeedsRotation(manifestEntry, binding)) {
            // The serialized convergence lane rotates the bearer against the
            // existing generation and provider. No Electron reinstall is
            // required while this daemon still owns the in-memory host grant.
            this.requestConvergence(entryId);
            return;
          }
        }
        const status = current.observedState === "idle" ? "idle" : "working";
        await this.publishNativeActivity(entryId, "native_harness.heartbeat", status);
      })().catch(() => undefined));
    }, this.nativeHeartbeatIntervalMs);
    heartbeat.unref();
    this.liveDisposers.set(entryId, [disposeExit, disposeStream, () => clearInterval(heartbeat)]);
    if (mayStartDelivery()) void this.startSupervisedDelivery(entryId).catch(() => undefined);
  }

  private async stageWorkerBindingAfterResume(
    entry: DaemonManifestEntry,
    priorBinding: WorkerSessionBinding,
    successorExecutionGenerationId: string,
    handle: ProviderActionHandle,
  ): Promise<void> {
    const ref = entry.provider_ref;
    if (!ref
      || priorBinding.entry_id !== entry.id
      || priorBinding.room_id !== entry.room_id
      || priorBinding.work_attempt_id !== ref.work_attempt_id
      || handle.workAttemptId !== ref.work_attempt_id
      || handle.providerContinuationId !== ref.provider_continuation_id) {
      throw new Error("Resumed provider does not match the durable worker continuation identity.");
    }
    const attempt = await this.durability.getAttempt(ref.work_attempt_id);
    const predecessor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === priorBinding.execution_generation_id,
    );
    const successor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === successorExecutionGenerationId,
    );
    if (!predecessor?.terminal) {
      throw new Error("Worker binding predecessor execution is not durably terminal.");
    }
    if (predecessor.terminal.provider_continuation_id !== ref.provider_continuation_id) {
      throw new Error("Worker binding predecessor belongs to a different provider continuation.");
    }
    if (!successor || successor.terminal
      || attempt.execution_generations.filter((candidate) => candidate.terminal === null).length !== 1) {
      throw new Error("Worker binding successor is not the single live execution generation.");
    }
    this.pendingResumeBindings.set(entry.id, {
      roomId: entry.room_id,
      workAttemptId: ref.work_attempt_id,
      predecessorExecutionGenerationId: priorBinding.execution_generation_id,
      successorExecutionGenerationId,
      agentSessionId: priorBinding.agent_session_id,
      providerContinuationId: ref.provider_continuation_id,
    });
  }

  /**
   * Published MCP runtimes before bind-on-wait cannot present their credential
   * again after a native session resume. The first exact wait event proves the
   * saved worker-session identity. While the credential still belongs to its
   * terminal predecessor, verify it with the API; only an accepted response is
   * allowed to atomically advance the private binding and public projection.
   */
  private async restoreWorkerBindingFromWait(
    entryId: string,
    evidence: SupervisedWaitEvidence,
  ): Promise<boolean> {
    const pending = this.pendingResumeBindings.get(entryId);
    if (!pending || evidence.agentSessionId !== pending.agentSessionId) return false;
    const entry = await this.store.getEntry(entryId);
    const handle = this.liveHandles.get(entryId);
    if (!entry || !handle
      || entry.room_id !== pending.roomId
      || entry.work_attempt_id !== pending.workAttemptId
      || entry.provider_ref?.execution_generation_id !== pending.successorExecutionGenerationId
      || entry.provider_ref.provider_continuation_id !== pending.providerContinuationId
      || handle.workAttemptId !== pending.workAttemptId
      || handle.providerContinuationId !== pending.providerContinuationId) {
      throw new Error("Resumed wait evidence does not match the staged provider continuation.");
    }
    const attempt = await this.durability.getAttempt(pending.workAttemptId);
    const predecessor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === pending.predecessorExecutionGenerationId,
    );
    const successor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === pending.successorExecutionGenerationId,
    );
    if (!predecessor?.terminal) throw new Error("Worker binding predecessor execution is not durably terminal.");
    if (predecessor.terminal.provider_continuation_id !== pending.providerContinuationId) {
      throw new Error("Worker binding predecessor belongs to a different provider continuation.");
    }
    if (!successor || successor.terminal
      || attempt.execution_generations.filter((candidate) => candidate.terminal === null).length !== 1) {
      throw new Error("Worker binding successor is not the single live execution generation.");
    }
    const method = "native_harness.resumed_binding";
    const result = await this.workerBindings.verifyAndAdvanceExecutionGeneration({
      entryId,
      roomId: pending.roomId,
      workAttemptId: pending.workAttemptId,
      fromExecutionGenerationId: pending.predecessorExecutionGenerationId,
      toExecutionGenerationId: pending.successorExecutionGenerationId,
      agentSessionId: pending.agentSessionId,
    }, async ({ binding, sequence, observed_at }) => {
      const credential = await this.workerBindings.credentialFor(binding);
      if (!credential) throw new Error("Worker credential is unavailable until desktop credential delivery.");
      const roomPath = binding.room_id.split("/").map(encodeURIComponent).join("/");
      const endpoint = `${binding.api_url}/rooms/${roomPath}/agent-sessions/${encodeURIComponent(binding.agent_session_id)}/native-activity`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify({
          observed_at,
          sequence,
          method,
          status: "working",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Native activity endpoint rejected resumed credential verification with HTTP ${response.status}.`);
      const payload = await response.json() as { accepted?: boolean };
      return { accepted: payload.accepted !== false };
    });
    if (!result.accepted) throw new Error("Native activity endpoint rejected the retained worker credential.");
    const verified = result.binding;
    this.liveBindingIdentities.set(entry.id, {
      agentSessionId: verified.agent_session_id,
      executionGenerationId: verified.execution_generation_id,
      updatedAt: verified.updated_at,
    });
    await this.updateManifestEntry(entry.id, (current) => {
      if (current.work_attempt_id !== pending.workAttemptId
        || current.provider_ref?.execution_generation_id !== pending.successorExecutionGenerationId
        || current.provider_ref.provider_continuation_id !== pending.providerContinuationId) {
        throw new Error("Manifest moved while restoring the resumed worker binding.");
      }
      return {
        ...current,
        observed_state: "working" as const,
        condition: "none" as const,
        last_error: null,
        workplace_liveness: {
          state: "reachable" as const,
          observed_at: verified.updated_at,
          detail: "exact persisted worker session restored after native resume",
        },
        last_worker_binding: {
          agent_session_id: verified.agent_session_id,
          work_attempt_id: verified.work_attempt_id,
          execution_generation_id: verified.execution_generation_id,
          updated_at: verified.updated_at,
        },
      };
    });
    this.pendingResumeBindings.delete(entryId);
    return true;
  }

  private async handleProviderStream(entryId: string, handle: ProviderActionHandle, event: ProviderActionStreamEvent): Promise<void> {
    if (this.liveHandles.get(entryId) !== handle) return;
    const observedLifecycle = providerStreamLifecycle(event);
    const entry = await this.store.getEntry(entryId);
    if (!entry) return;
    // A daemon-inbox worker deliberately completes one bounded native turn at
    // a time. During the one-way legacy Codex cutover, the old polling turn
    // has the same reusable-thread meaning: it is the handoff boundary, never
    // evidence that the app-server deployment died.
    const daemonInbox = entry.delivery_mode === "daemon_inbox";
    const legacyCodexCutover = entry.provider === "codex"
      && (entry.delivery_mode ?? "mcp_polling") === "mcp_polling"
      && entry.desired_state === "running";
    const effectiveLifecycle = (daemonInbox || legacyCodexCutover) && observedLifecycle === "terminal"
      ? "idle"
      : observedLifecycle;
    const addressedWaitResult = observedLifecycle === "idle"
      && isCorrelatedNonemptyWaitResult(event, entry.activity ?? []);
    // A terminal native failure is sticky for the installed execution. Late
    // deltas and heartbeats from that same handle are evidence, not recovery.
    const lifecycle = entry.observed_state === "failed"
      ? "failed"
      : addressedWaitResult ? "working" : effectiveLifecycle;
    // Provider-local stream counters may restart when a replacement daemon
    // attaches. Persist a daemon-global monotonic sequence for the manifest.
    const sequence = Math.max((entry.activity?.at(-1)?.sequence ?? 0) + 1, event.sequence);
    const quietlyPolling = isSupervisedWaitProviderEvent(event)
      || isSupervisedQuietPollContinuation(event, entry.activity ?? []);
    const status: DaemonActivityEvent["status"] = lifecycle === "failed"
      ? "blocked"
      : lifecycle === "terminal" || quietlyPolling ? "idle" : lifecycle;
    const sanitizedEvent = sanitizeDaemonActivityEvent({
      observed_at: event.observedAt,
      sequence,
      provider: event.provider,
      kind: event.kind,
      method: event.method,
      summary: `${event.provider} · ${event.method}`.slice(0, 500),
      status,
      payload: event.payload,
      payload_truncated: event.payloadTruncated,
      payload_redacted: event.payloadRedacted,
      durable_payload_ref: event.durablePayloadRef,
    });
    await this.appendActivity(entryId, sanitizedEvent);
    const waitEvidence = supervisedWaitEvidenceFromProviderEvent(event);
    if (waitEvidence) {
      const pending = this.pendingResumeBindings.get(entryId);
      if (pending && waitEvidence.agentSessionId === pending.agentSessionId) {
        try {
          await this.serializeEntryTick(entryId, () => this.restoreWorkerBindingFromWait(entryId, waitEvidence));
        } catch (error) {
          await this.serializeEntryTick(entryId, () => this.transition(
            entryId,
            "recovering",
            "coordination_blocked",
            `resumed provider credential verification failed: ${error instanceof Error ? error.message : "unknown credential verification failure"}`,
            "daemon-provider-stream",
          ));
          return;
        }
      }
      if (!this.pendingResumeBindings.has(entryId)) {
        await this.checkpointObservedWaitCursor(entry, waitEvidence.roomCursor, waitEvidence.agentSessionId);
      }
    }
    if (lifecycle === "failed" && entry.observed_state !== "failed") {
      await this.transition(entryId, "failed", entry.condition, `provider stream terminal failure: ${sanitizedEvent.method}`, "daemon-provider-stream");
    }
    const liveBinding = this.liveBindingIdentities.get(entryId);
    if (liveBinding?.executionGenerationId === entry.provider_ref?.execution_generation_id) {
      await this.publishNativeActivity(entryId, sanitizedEvent.method, lifecycle === "working" && !quietlyPolling ? "working" : "idle", event.observedAt).catch(() => undefined);
    }
    if (legacyCodexCutover && observedLifecycle === "terminal") {
      // The exact control adapter will checkpoint this now-terminal legacy
      // turn and atomically hand ingress to daemon_inbox without replacing
      // the PID, thread, continuation, work attempt, or generation.
      void this.startDeliveryCutover(entryId).catch(() => undefined);
    }
    if ((lifecycle === "failed" || lifecycle === "terminal")
      && this.liveHandles.get(entryId) === handle
      && !["stopping", "stopped"].includes(handle.observedState)) {
      try {
        // A persistent polling turn ending (successfully or with a native
        // terminal error) means delivery ended. Fence that native process so
        // the terminal callback can mint a bounded resume generation.
        await this.fenceTerminalProviderHandleOnce(
          handle,
          `manifest:${entryId}:terminal-turn:${event.sequence}`,
        );
      } catch (error) {
        await this.transition(
          entryId,
          "failed",
          "coordination_blocked",
          `failed to fence terminal provider turn: ${error instanceof Error ? error.message : "unknown error"}`,
          "daemon-provider-stream",
        );
      }
    }
  }

  private async checkpointObservedWaitCursor(entry: DaemonManifestEntry, roomCursor: string, agentSessionId: string): Promise<void> {
    await this.serializeCursorCheckpoint(entry.id, async () => {
      const executionGenerationId = entry.provider_ref?.execution_generation_id;
      if (!entry.work_attempt_id || !executionGenerationId) return;
      const currentEntry = (await this.store.load()).entries.find((candidate) => candidate.id === entry.id);
      if (!currentEntry
        || currentEntry.room_id !== entry.room_id
        || currentEntry.work_attempt_id !== entry.work_attempt_id
        || currentEntry.provider_ref?.execution_generation_id !== executionGenerationId) return;
      const binding = await this.workerBindings.get(entry.id);
      if (!binding
        || binding.entry_id !== entry.id
        || binding.room_id !== entry.room_id
        || binding.work_attempt_id !== entry.work_attempt_id
        || binding.agent_session_id !== agentSessionId
        || binding.execution_generation_id !== executionGenerationId) return;
      const checkpoint = await this.workerBindings.checkpointCursorMonotonic(
        entry.id,
        binding.agent_session_id,
        executionGenerationId,
        roomCursor,
      );
      const durableAttempt = await this.durability.getAttempt(entry.work_attempt_id);
      const durableCursor = checkpoint.binding.room_cursor;
      if (!durableCursor || (!checkpoint.advanced && durableAttempt.checkpoints.at(-1)?.room_cursor === durableCursor)) return;
      await this.durability.checkpoint(entry.work_attempt_id, {
        room_cursor: durableCursor,
        provider_continuation_id: entry.provider_ref?.provider_continuation_id ?? null,
      });
    });
  }

  private enqueueProviderStream(entryId: string, handle: ProviderActionHandle, event: ProviderActionStreamEvent): Promise<void> {
    const previous = this.providerStreamQueues.get(entryId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.handleProviderStream(entryId, handle, event)).finally(() => {
      if (this.providerStreamQueues.get(entryId) === next) this.providerStreamQueues.delete(entryId);
    });
    this.providerStreamQueues.set(entryId, next);
    return next;
  }

  private serializeCursorCheckpoint<T>(entryId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.cursorCheckpointQueues.get(entryId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined).finally(() => {
      if (this.cursorCheckpointQueues.get(entryId) === tail) this.cursorCheckpointQueues.delete(entryId);
    });
    this.cursorCheckpointQueues.set(entryId, tail);
    return result;
  }

  private fenceTerminalProviderHandleOnce(handle: ProviderActionHandle, actionId: string): Promise<void> {
    const existing = this.terminalFenceRequests.get(handle);
    if (existing) return existing;
    const operation = this.providerPort!
      .stop(handle, { actionId })
      .then(() => undefined);
    this.terminalFenceRequests.set(handle, operation);
    return operation;
  }

  private scheduleRecoveryConvergence(entryId: string, delayMs: number): void {
    if (this.recoveryTimers.has(entryId)) return;
    const timer = this.setRecoveryTimeout(() => {
      this.recoveryTimers.delete(entryId);
      this.requestConvergence(entryId);
    }, Math.max(1, delayMs));
    timer.unref?.();
    this.recoveryTimers.set(entryId, timer);
  }

  private clearRecoveryConvergence(entryId: string): void {
    const timer = this.recoveryTimers.get(entryId);
    if (!timer) return;
    this.clearRecoveryTimeout(timer);
    this.recoveryTimers.delete(entryId);
  }

  private async bindWorkerSession(input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; agent_session_token: string; credential_ref?: string; api_url: string }): Promise<{ bound: true; entry_id: string; agent_session_id: string }> {
    return this.serializeEntryTick(input.entry_id, () => this.bindWorkerSessionLocked(input));
  }

  private async bindWorkerSessionLocked(
    input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; agent_session_token: string; credential_ref?: string; api_url: string },
    mayPublish: () => boolean = () => true,
  ): Promise<{ bound: true; entry_id: string; agent_session_id: string }> {
    const entry = (await this.store.load()).entries.find((candidate) => candidate.id === input.entry_id);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entry_id}`);
    if (entry.room_id !== input.room_id) throw new Error("Worker session room does not match the supervised manifest entry.");
    if (entry.work_attempt_id !== input.work_attempt_id) throw new Error("Worker session work attempt does not match the supervised manifest entry.");
    if (entry.provider_ref?.execution_generation_id !== input.execution_generation_id) {
      throw new Error("Worker session execution generation does not match the active supervised manifest entry.");
    }
    const attempt = await this.durability.getAttempt(input.work_attempt_id);
    const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === input.execution_generation_id);
    if (!execution || execution.terminal) throw new Error("Worker session execution generation is absent or terminal.");
    const currentBinding = await this.workerBindings.get(input.entry_id);
    const currentCredential = currentBinding
      ? await this.workerBindings.credentialFor(currentBinding)
      : null;
    const normalizedApiUrl = new URL(input.api_url).origin;
    const exactCurrentBinding = Boolean(currentBinding
      && currentBinding.entry_id === input.entry_id
      && currentBinding.room_id === input.room_id
      && currentBinding.work_attempt_id === input.work_attempt_id
      && currentBinding.execution_generation_id === input.execution_generation_id
      && currentBinding.agent_session_id === input.agent_session_id
      && currentCredential === input.agent_session_token
      && currentBinding.api_url === normalizedApiUrl);
    const binding = exactCurrentBinding && currentBinding
      ? currentBinding
      : await this.workerBindings.bind(input);
    this.liveBindingIdentities.set(input.entry_id, {
      agentSessionId: binding.agent_session_id,
      executionGenerationId: binding.execution_generation_id,
      updatedAt: binding.updated_at,
    });
    this.pendingResumeBindings.delete(input.entry_id);
    await this.updateManifestEntry(input.entry_id, (current) => {
      const clearsCoordinationLatch = current.desired_state === "running"
        && (current.condition === "coordination_blocked" || current.condition === "auth_blocked");
      const manifestBindingIsCurrent = current.last_worker_binding?.agent_session_id === binding.agent_session_id
        && current.last_worker_binding?.work_attempt_id === binding.work_attempt_id
        && current.last_worker_binding?.execution_generation_id === binding.execution_generation_id;
      if (current.workplace_liveness?.state === "reachable"
        && !clearsCoordinationLatch
        && manifestBindingIsCurrent) return current;
      return {
        ...current,
        // A successful exact-generation bind proves that an ambiguous live
        // provider has its MCP control route. Restore workplace reachability on
        // fresh and persisted-idempotent binds; clear only the coordination
        // latch, while quarantine and native terminal failures stay authoritative.
        workplace_liveness: {
          state: "reachable" as const,
          observed_at: new Date().toISOString(),
          detail: exactCurrentBinding
            ? "exact supervised worker session binding confirmed"
            : "supervised worker session bound",
        },
        ...(clearsCoordinationLatch
          ? {
            observed_state: "working" as const,
            condition: "none" as const,
            last_error: null,
          }
          : {}),
        // Durable set-once ready stamp: this bind restores reachability, so the
        // entry is ready when it is running + unblocked + live.
        ready_reached_at: resolveReadyReachedAt(current, clearsCoordinationLatch, new Date().toISOString()),
        last_worker_binding: {
          agent_session_id: binding.agent_session_id,
          work_attempt_id: binding.work_attempt_id,
          execution_generation_id: binding.execution_generation_id,
          updated_at: binding.updated_at,
        },
      };
    });
    if (mayPublish() && (!exactCurrentBinding || entry.workplace_liveness?.state !== "reachable")) {
      await this.publishNativeActivity(input.entry_id, "native_harness.bound", "working");
    }
    if (mayPublish()) void this.startSupervisedDelivery(input.entry_id).catch(() => undefined);
    return { bound: true, entry_id: input.entry_id, agent_session_id: input.agent_session_id };
  }

  private requiresHostGrant(entry: DaemonManifestEntry): boolean {
    return entry.provider === "codex" && entry.delivery_mode === "daemon_inbox";
  }

  private currentHostGrant(entry: DaemonManifestEntry): InstalledHostGrant | null {
    const grant = this.hostGrants.get(entry.id);
    if (!grant || this.handoffScheduled || grant.daemonGeneration !== this.singleton.currentGeneration
      || grant.entryId !== entry.id || grant.roomId !== entry.room_id) return null;
    return grant;
  }

  private hostGrantNeedsRenewal(grant: InstalledHostGrant): boolean {
    const expiresAt = Date.parse(grant.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt <= this.nowMs() + HOST_GRANT_RENEWAL_LEAD_MS;
  }

  private async blockHostGrantAuthority(entry: DaemonManifestEntry, grant: InstalledHostGrant, detail: string): Promise<void> {
    this.revokeHostGrantIfCurrent(entry.id, grant);
    this.cachedWorkerAuthorizations.delete(entry.id);
    await this.supervisedDelivery?.stop(entry.id).catch(() => undefined);
    const binding = await this.workerBindings.get(entry.id);
    if (binding) await this.workerBindings.unbind(entry.id, binding.agent_session_id, binding.execution_generation_id);
    this.liveBindingIdentities.delete(entry.id);
    await this.updateManifestEntry(entry.id, (current) => ({
      ...current,
      observed_state: current.desired_state === "running" ? "recovering" : current.observed_state,
      condition: "auth_blocked",
      last_error: redactCredentialText(detail).value,
      workplace_liveness: {
        state: "stale",
        observed_at: new Date(this.nowMs()).toISOString(),
        detail: "Supervisor host authority is unavailable; room delivery is paused.",
      },
    }));
  }

  private async blockExpiredWorkerAuthority(entry: DaemonManifestEntry, detail: string): Promise<void> {
    this.cachedWorkerAuthorizations.delete(entry.id);
    await this.supervisedDelivery?.stop(entry.id).catch(() => undefined);
    const binding = await this.workerBindings.get(entry.id);
    if (binding) await this.workerBindings.unbind(entry.id, binding.agent_session_id, binding.execution_generation_id);
    await this.updateManifestEntry(entry.id, (current) => ({
      ...current,
      observed_state: current.desired_state === "running" ? "recovering" : current.observed_state,
      condition: "auth_blocked",
      last_error: redactCredentialText(detail).value,
      workplace_liveness: {
        state: "stale", observed_at: new Date(this.nowMs()).toISOString(),
        detail: "The worker bearer expired before rotation succeeded; room delivery is paused.",
      },
    }));
    this.scheduleRecoveryConvergence(entry.id, this.nativeHeartbeatIntervalMs);
  }

  /** Renew in memory only and rotate the live worker bearer in place. */
  private async ensureHostGrantFresh(entry: DaemonManifestEntry): Promise<InstalledHostGrant | null> {
    const grant = this.currentHostGrant(entry);
    if (!grant) return null;
    const expiresAt = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.nowMs()) {
      await this.blockHostGrantAuthority(entry, grant, "Supervisor host grant expired; waiting for Electron owner recovery.");
      return null;
    }
    if (!this.hostGrantNeedsRenewal(grant)) return grant;
    try {
      if (!this.supervisorGrantHttp.renewHostGrant) throw new Error("Supervisor host grant renewal is unavailable.");
      const renewed = await this.supervisorGrantHttp.renewHostGrant({
        apiUrl: grant.apiUrl, grantId: grant.grantId, supervisorGrant: grant.supervisorGrant,
        grantGeneration: grant.grantGeneration, hostId: grant.hostId,
        installationId: grant.installationId, ttlMs: HOST_GRANT_TTL_MS,
      });
      const renewedExpiry = Date.parse(renewed.expiresAt);
      if (renewed.grantId !== grant.grantId || renewed.grantGeneration !== grant.grantGeneration
        || !renewed.supervisorGrant.trim() || !Number.isFinite(renewedExpiry) || renewedExpiry <= this.nowMs()) {
        throw new InvalidSupervisorGrantRenewalError("Supervisor host grant renewal returned a stale fence.");
      }
      if (!await this.ownsDaemonGeneration(grant.daemonGeneration) || this.hostGrants.get(entry.id) !== grant) return null;
      const replacement: InstalledHostGrant = {
        ...grant, supervisorGrant: renewed.supervisorGrant, expiresAt: renewed.expiresAt,
      };
      this.hostGrants.set(entry.id, replacement);
      const current = await this.store.getEntry(entry.id);
      if (current?.provider_ref?.execution_generation_id && this.liveHandles.get(entry.id)) {
        try {
          const minted = await this.mintHostWorkerSession(current, current.provider_ref.execution_generation_id);
          if (!minted) throw new Error("Renewed host grant could not rotate the live worker bearer.");
          await this.bindMintedHostWorkerSession(entry.id, minted);
        } catch (error) {
          if (error instanceof SupervisorGrantRequestError && [401, 403, 409].includes(error.status)) throw error;
          // The renewed parent grant is valid and stays memory-only. Preserve
          // the still-live worker bearer and let its heartbeat retry rotation;
          // a transient child-session transport failure must not force owner
          // recovery or disturb the provider.
        }
      }
      return replacement;
    } catch (error) {
      const active = this.hostGrants.get(entry.id);
      const definitiveRejection = error instanceof InvalidSupervisorGrantRenewalError
        || (error instanceof SupervisorGrantRequestError && [401, 403, 409].includes(error.status));
      if (definitiveRejection && active && active.grantId === grant.grantId && active.daemonGeneration === grant.daemonGeneration) {
        await this.blockHostGrantAuthority(
          entry,
          active,
          `Supervisor host grant renewal failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        return null;
      }
      if (active && Date.parse(active.expiresAt) <= this.nowMs()) {
        await this.blockHostGrantAuthority(
          entry,
          active,
          `Supervisor host grant expired while renewal was pending: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        return null;
      }
      // Transport and 5xx failures do not revoke a still-valid parent grant
      // or its worker bearer. Retry in the background and let the actual
      // parent/bearer deadlines decide when delivery becomes auth_blocked.
      this.scheduleRecoveryConvergence(entry.id, this.nativeHeartbeatIntervalMs);
      return this.currentHostGrant(entry);
    }
  }

  private async hostWorkerBearerNeedsRotation(entry: DaemonManifestEntry, binding: WorkerSessionBinding): Promise<boolean> {
    const session = await this.workerBindings.supervisedWorkerSession(entry.id);
    if (!session
      || session.room_id !== entry.room_id
      || session.agent_session_id !== binding.agent_session_id
      || session.execution_generation_id !== binding.execution_generation_id) return false;
    // Public metadata is committed before the private vault rebind. If the
    // latter fails, the mismatch makes the next heartbeat remint instead of
    // silently retaining the old credential forever.
    if (session.credential_ref !== binding.credential_ref) return true;
    if (!session.expires_at) return false;
    const expiresAt = Date.parse(session.expires_at);
    return Number.isFinite(expiresAt) && expiresAt <= this.nowMs() + WORKER_BEARER_ROTATION_LEAD_MS;
  }

  private async ownsDaemonGeneration(expectedGeneration: number): Promise<boolean> {
    if (this.handoffScheduled) {
      this.hostGrants.clear();
      this.cachedWorkerAuthorizations.clear();
      return false;
    }
    if (expectedGeneration !== this.singleton.currentGeneration) return false;
    try {
      await this.singleton.assertCurrent();
      if (this.handoffScheduled) {
        this.hostGrants.clear();
        this.cachedWorkerAuthorizations.clear();
        return false;
      }
      return expectedGeneration === this.singleton.currentGeneration;
    } catch {
      // A successor acquired the singleton without this process completing its
      // normal handoff path. Drop every process-memory credential immediately.
      this.hostGrants.clear();
      this.cachedWorkerAuthorizations.clear();
      return false;
    }
  }

  private revokeHostGrantIfCurrent(entryId: string, grant: InstalledHostGrant): void {
    if (this.hostGrants.get(entryId) === grant) {
      this.hostGrants.delete(entryId);
      this.cachedWorkerAuthorizations.delete(entryId);
    }
  }

  private cachedWorkerAuthorization(entry: DaemonManifestEntry, grant: InstalledHostGrant): CachedWorkerAuthorization | null {
    const cached = this.cachedWorkerAuthorizations.get(entry.id);
    if (!cached) return null;
    const expiresAt = cached.expiresAt ? Date.parse(cached.expiresAt) : Number.NaN;
    const fresh = Number.isFinite(expiresAt)
      ? expiresAt > this.nowMs() + WORKER_BEARER_ROTATION_LEAD_MS
      : cached.mintedAtMs + WORKER_MINT_FALLBACK_FRESH_MS > this.nowMs();
    const exact = cached.entryId === entry.id
      && cached.roomId === entry.room_id
      && cached.agentKey === grant.agentKey
      && cached.grantId === grant.grantId
      && cached.grantGeneration === grant.grantGeneration
      && cached.daemonGeneration === grant.daemonGeneration
      && cached.apiUrl === grant.apiUrl;
    if (!fresh || !exact) {
      this.cachedWorkerAuthorizations.delete(entry.id);
      return null;
    }
    // Bootstrap necessarily mints before ensureWorkAttempt. The first launch
    // claims that one-use pre-attempt credential into its newly durable attempt;
    // subsequent use is fenced to that exact attempt.
    if (cached.workAttemptId === null && entry.work_attempt_id) cached.workAttemptId = entry.work_attempt_id;
    if (cached.workAttemptId !== entry.work_attempt_id) {
      this.cachedWorkerAuthorizations.delete(entry.id);
      return null;
    }
    return cached;
  }

  private async mintWorkerSessionWithRetry(entry: DaemonManifestEntry, grant: InstalledHostGrant, signal?: AbortSignal): Promise<Awaited<ReturnType<SupervisorGrantHttp["createWorkerSession"]>>> {
    let lastError: unknown = null;
    let attempts = 0;
    let lastRetryable = false;
    for (let attempt = 1; attempt <= WORKER_MINT_MAX_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) throw new Error("Worker credential mint was cancelled.");
      attempts = attempt;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      let timeoutReject!: (error: Error) => void;
      const timedOut = new Promise<never>((_resolve, reject) => { timeoutReject = reject; });
      const timeout = this.setRecoveryTimeout(() => {
        controller.abort();
        timeoutReject(new Error(`Worker credential mint timed out after ${WORKER_MINT_TIMEOUT_MS}ms.`));
      }, WORKER_MINT_TIMEOUT_MS);
      timeout.unref();
      try {
        return await Promise.race([this.supervisorGrantHttp.createWorkerSession({
          apiUrl: grant.apiUrl, grantId: grant.grantId, supervisorGrant: grant.supervisorGrant,
          grantGeneration: grant.grantGeneration, roomId: grant.roomId, agentKey: grant.agentKey,
          agentInstanceId: `daemon:${entry.id}`, signal: controller.signal,
        }), timedOut]);
      } catch (error) {
        lastError = error;
        const retryable = retryableWorkerMintFailure(error);
        lastRetryable = retryable && !signal?.aborted;
        if (!retryable || signal?.aborted || attempt === WORKER_MINT_MAX_ATTEMPTS) break;
        await new Promise<void>((resolve) => this.setRecoveryTimeout(resolve, WORKER_MINT_RETRY_DELAY_MS));
      } finally {
        this.clearRecoveryTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    }
    throw new WorkerCredentialMintError(attempts, lastRetryable, lastError);
  }

  /** Remote authorization happens before starting a durable provider generation. */
  private async mintHostWorkerAuthorization(entry: DaemonManifestEntry, signal?: AbortSignal, forceFresh = false): Promise<{
    agentSessionId: string; bearer: string; bearerId: string; expiresAt: string | null; apiUrl: string;
  } | null> {
    const grant = this.currentHostGrant(entry);
    if (!grant) return null;
    if (!await this.ownsDaemonGeneration(grant.daemonGeneration) || this.hostGrants.get(entry.id) !== grant) {
      this.revokeHostGrantIfCurrent(entry.id, grant);
      return null;
    }
    const cached = forceFresh ? null : this.cachedWorkerAuthorization(entry, grant);
    if (cached) return {
      agentSessionId: cached.agentSessionId, bearer: cached.bearer, bearerId: cached.bearerId,
      expiresAt: cached.expiresAt, apiUrl: cached.apiUrl,
    };
    const minted = await this.mintWorkerSessionWithRetry(entry, grant, signal);
    if (!await this.ownsDaemonGeneration(grant.daemonGeneration) || this.hostGrants.get(entry.id) !== grant) {
      this.revokeHostGrantIfCurrent(entry.id, grant);
      return null;
    }
    const current = await this.store.getEntry(entry.id);
    if (!current || current.work_attempt_id !== entry.work_attempt_id || this.currentHostGrant(current) !== grant) return null;
    this.cachedWorkerAuthorizations.set(entry.id, {
      entryId: entry.id, roomId: entry.room_id, agentKey: grant.agentKey,
      workAttemptId: entry.work_attempt_id ?? null, grantId: grant.grantId, grantGeneration: grant.grantGeneration,
      daemonGeneration: grant.daemonGeneration, apiUrl: grant.apiUrl, agentSessionId: minted.sessionId,
      bearer: minted.bearer, bearerId: minted.bearerId, expiresAt: minted.expiresAt, mintedAtMs: this.nowMs(),
    });
    return { agentSessionId: minted.sessionId, bearer: minted.bearer, bearerId: minted.bearerId, expiresAt: minted.expiresAt, apiUrl: grant.apiUrl };
  }

  /** Bind public session metadata to the exact generation after it exists. */
  private async recordMintedHostWorkerSession(entry: DaemonManifestEntry, executionGenerationId: string, minted: {
    agentSessionId: string; bearer: string; bearerId: string; expiresAt: string | null; apiUrl: string;
  }): Promise<{
    agentSessionId: string; bearer: string; bearerId: string; expiresAt: string | null; apiUrl: string; executionGenerationId: string;
  } | null> {
    const grant = this.currentHostGrant(entry);
    if (!grant || !entry.work_attempt_id || !await this.ownsDaemonGeneration(grant.daemonGeneration)) return null;
    const current = await this.store.getEntry(entry.id);
    if (!current || !this.currentHostGrant(current)
      || current.work_attempt_id !== entry.work_attempt_id) return null;
    const attempt = await this.durability.getAttempt(entry.work_attempt_id);
    if (!attempt.execution_generations.some((candidate) => candidate.execution_generation_id === executionGenerationId && !candidate.terminal)) return null;
    await this.workerBindings.recordSupervisedWorkerSession({
      agent_id: entry.id, room_id: entry.room_id, agent_session_id: minted.agentSessionId,
      execution_generation_id: executionGenerationId, credential_ref: minted.bearerId, expires_at: minted.expiresAt,
    });
    if (!await this.ownsDaemonGeneration(grant.daemonGeneration) || this.hostGrants.get(entry.id) !== grant) {
      this.revokeHostGrantIfCurrent(entry.id, grant);
      return null;
    }
    return { ...minted, executionGenerationId };
  }

  private async mintHostWorkerSession(entry: DaemonManifestEntry, executionGenerationId: string, forceFresh = false): Promise<{
    agentSessionId: string; bearer: string; bearerId: string; expiresAt: string | null; apiUrl: string; executionGenerationId: string;
  } | null> {
    const minted = await this.mintHostWorkerAuthorization(entry, undefined, forceFresh);
    return minted ? this.recordMintedHostWorkerSession(entry, executionGenerationId, minted) : null;
  }

  /** Provider identity has already been persisted when this binds the raw bearer. */
  private async bindMintedHostWorkerSession(entryId: string, session: {
    agentSessionId: string; bearer: string; bearerId: string; apiUrl: string; executionGenerationId: string;
  }, mayPublish: () => boolean = () => true): Promise<void> {
    const entry = await this.store.getEntry(entryId);
    if (!entry || !entry.work_attempt_id || !entry.provider_ref || entry.provider_ref.execution_generation_id !== session.executionGenerationId || !this.currentHostGrant(entry)) return;
    await this.bindWorkerSessionLocked({
      entry_id: entry.id, room_id: entry.room_id, work_attempt_id: entry.work_attempt_id,
      execution_generation_id: session.executionGenerationId, agent_session_id: session.agentSessionId,
      agent_session_token: session.bearer, credential_ref: session.bearerId, api_url: session.apiUrl,
    }, mayPublish);
  }

  /** Desktop-only local RPC. The host grant itself is never copied to SQLite, activity, or manifests. */
  private async installHostGrant(input: {
    entry_id: string; room_id: string; agent_key: string; grant_id: string; supervisor_grant: string;
    grant_generation: number; api_url: string; daemon_generation: number;
    host_id: string; installation_id: string; grant_expires_at: string; credential_only?: boolean;
  }): Promise<{ status: "installed" | "stale" | "provider_unavailable"; agent_session_id?: string }> {
    return this.serializeEntryTick(input.entry_id, async () => {
      for (const field of ["entry_id", "room_id", "agent_key", "grant_id", "supervisor_grant", "api_url", "host_id", "installation_id", "grant_expires_at"] as const) {
        if (!input[field].trim()) throw new Error(`Host grant ${field} is required.`);
      }
      if (!Number.isSafeInteger(input.grant_generation) || input.grant_generation < 1
        || !await this.ownsDaemonGeneration(input.daemon_generation)) return { status: "stale" };
      const inputExpiry = Date.parse(input.grant_expires_at);
      if (!Number.isFinite(inputExpiry) || inputExpiry <= this.nowMs()) return { status: "stale" };
      let apiUrl: string;
      try { apiUrl = hostGrantApiOrigin(input.api_url); } catch { throw new Error("Host grant api_url must be HTTPS or exact loopback HTTP."); }
      const entry = await this.store.getEntry(input.entry_id);
      if (!entry || !this.requiresHostGrant(entry) || entry.room_id !== input.room_id) return { status: "stale" };
      if (!await this.ownsDaemonGeneration(input.daemon_generation)) return { status: "stale" };
      const currentGrant = this.currentHostGrant(entry);
      const currentGrantIsAtLeastInput = Boolean(currentGrant?.grantId === input.grant_id
        && (currentGrant.grantGeneration > input.grant_generation
          || (currentGrant.grantGeneration === input.grant_generation
            && Date.parse(currentGrant.expiresAt) >= inputExpiry)));
      if (currentGrantIsAtLeastInput && currentGrant && !input.credential_only) {
        // Electron may still hold the pre-renewal safeStorage value. It may
        // confirm installation, but must never roll the daemon's newer
        // memory-only token/expiry backwards in the same generation.
        // A cursorless daemon-inbox entry is waiting for Electron's separate
        // admission RPC. Do not queue provider work in the gap between this
        // grant install and the durable first-tail boundary.
        if (entry.desired_state === "running"
          && (!this.requiresHostGrant(entry) || await this.supervisedInbox.cursor(entry.id))) {
          this.requestConvergence(entry.id);
        }
        return { status: "installed" };
      }
      // Credential-only reconnect is a rebind request, not a credential
      // update. Electron can legitimately still have a pre-renewal encrypted
      // copy, so retain and mint through the daemon's newer memory-only grant.
      const grant: InstalledHostGrant = currentGrantIsAtLeastInput && currentGrant ? currentGrant : {
        entryId: entry.id, roomId: entry.room_id, agentKey: input.agent_key, grantId: input.grant_id,
        supervisorGrant: input.supervisor_grant, grantGeneration: input.grant_generation, apiUrl,
        daemonGeneration: input.daemon_generation, hostId: input.host_id,
        installationId: input.installation_id, expiresAt: input.grant_expires_at,
      };
      // Compare the *effective* grant after stale-install resolution. A stale
      // Electron resend deliberately retains the daemon's newer grant and its
      // cache; an actual grant id/generation replacement cannot reuse it.
      if (currentGrant && (currentGrant.grantId !== grant.grantId
        || currentGrant.grantGeneration !== grant.grantGeneration)) {
        this.cachedWorkerAuthorizations.delete(entry.id);
      }
      // Recovery must not signal, restart, or migrate a live provider. It only
      // rotates the worker bearer against the persisted exact generation.
      const live = this.liveHandles.get(entry.id);
      const hasExactLiveProvider = Boolean(entry.provider_ref && entry.work_attempt_id && live
        && live.workAttemptId === entry.work_attempt_id
        && live.providerContinuationId === entry.provider_ref.provider_continuation_id);
      if (input.credential_only && !hasExactLiveProvider) {
        // Do not retain a new reconnect grant when there is nothing exact to
        // bind it to. A later unrelated reconciliation must not turn this
        // rejected reconnect into a launch.
        return { status: "provider_unavailable" };
      }
      if (this.hostGrants.get(entry.id) !== grant) this.hostGrants.set(entry.id, grant);
      if (hasExactLiveProvider && entry.provider_ref && entry.work_attempt_id && live) {
        const attempt = await this.durability.getAttempt(entry.work_attempt_id);
        if (!await this.ownsDaemonGeneration(input.daemon_generation) || this.hostGrants.get(entry.id) !== grant) {
          this.revokeHostGrantIfCurrent(entry.id, grant);
          return { status: "stale" };
        }
        const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === entry.provider_ref!.execution_generation_id);
        if (execution && !execution.terminal) {
          const minted = await this.mintHostWorkerSession(entry, execution.execution_generation_id, input.credential_only === true);
          if (minted) {
            await this.bindMintedHostWorkerSession(entry.id, minted);
            if (!await this.ownsDaemonGeneration(input.daemon_generation) || this.hostGrants.get(entry.id) !== grant) {
              this.revokeHostGrantIfCurrent(entry.id, grant);
              return { status: "stale" };
            }
            return { status: "installed", agent_session_id: minted.agentSessionId };
          }
        }
      }
      if (input.credential_only) {
        // Reconnect is deliberately not recovery. It may rebind an exact live
        // provider generation, but it must never request convergence, resume,
        // spawn, stop, signal, or alter desired state when that handle is gone.
        // A pre-existing newer grant remains valid even though this exact
        // provider could not be rebound; only discard a newly supplied input.
        if (grant !== currentGrant) this.revokeHostGrantIfCurrent(entry.id, grant);
        return { status: "provider_unavailable" };
      }
      if (!await this.ownsDaemonGeneration(input.daemon_generation) || this.hostGrants.get(entry.id) !== grant) {
        this.revokeHostGrantIfCurrent(entry.id, grant);
        return { status: "stale" };
      }
      // For daemon-inbox entries, bootstrapRoomIngress is the only path that
      // may queue a running convergence after the first cursor exists. A
      // stopped entry never queues lifecycle work merely because its host
      // grant was repaired.
      if (entry.desired_state === "running"
        && (!this.requiresHostGrant(entry) || await this.supervisedInbox.cursor(entry.id))) {
        this.requestConvergence(entry.id);
      }
      return { status: "installed" };
    });
  }

  /**
   * Establish the first daemon-inbox cursor. Fresh entries call this while
   * paused, before provider start/reachability. Upgrade recovery may call it
   * for an already-running or stopped entry that predates cursor admission.
   * It observes the current tail and durably records that boundary before any
   * running convergence is queued. Stopped entries remain stopped. The cursor
   * remains durable even if this generation loses authority after the HTTP
   * read, so a successor resumes this exact boundary instead of reading a
   * newer tail and skipping the intervening message.
   */
  private async bootstrapRoomIngress(input: { entry_id: string; daemon_generation: number }, operation: BootstrapOperation): Promise<{ status: "bootstrapped" | "existing" | "stale"; last_observed_message_id: string | null }> {
    return this.serializeEntryTick(input.entry_id, async () => {
      if (!await this.ownsDaemonGeneration(input.daemon_generation)) return { status: "stale", last_observed_message_id: null };
      const entry = await this.store.getEntry(input.entry_id);
      if (!entry || !this.requiresHostGrant(entry)) return { status: "stale", last_observed_message_id: null };
      const existing = await this.supervisedInbox.cursor(entry.id);
      if (existing) {
        await this.requestAdmittedRunningConvergence(entry.id, input.daemon_generation);
        return { status: "existing", last_observed_message_id: existing.last_observed_message_id };
      }
      const grant = this.currentHostGrant(entry);
      const latest = this.supervisedDeliveryHttp.latest;
      if (!grant || !latest) throw new Error("A supervised room tail reader is required before activation.");
      const timeout = setTimeout(() => {
        if (operation.phase === "observing") operation.controller.abort();
      }, BOOTSTRAP_ROOM_INGRESS_TIMEOUT_MS);
      timeout.unref();
      let minted: NonNullable<Awaited<ReturnType<typeof this.mintHostWorkerAuthorization>>>;
      let tail: { messages?: Array<Record<string, unknown>> };
      try {
        const authorization = await this.mintHostWorkerAuthorization(entry, operation.controller.signal);
        if (!authorization) throw new Error("Room ingress bootstrap lost host grant authority before minting a worker credential.");
        minted = authorization;
        if (operation.controller.signal.aborted) throw new Error("Room ingress bootstrap was cancelled before a room tail was observed.");
        tail = await latest({ roomId: entry.room_id, apiUrl: grant.apiUrl, bearer: minted.bearer, signal: operation.controller.signal });
        if (operation.controller.signal.aborted) throw new Error("Room ingress bootstrap was cancelled before a room tail was observed.");
      } finally {
        clearTimeout(timeout);
      }
      // Do not re-check singleton authority before this durable write. Once a
      // generation observed tail N, every successor must inherit N rather
      // than advancing the initial boundary beyond a message that raced it.
      const tailId = lastRoomMessageId(tail.messages ?? []);
      operation.phase = "committing";
      const result = await this.supervisedInbox.bootstrapCursor({
        agent_id: entry.id, room_id: entry.room_id, last_observed_message_id: tailId,
      });
      await this.requestAdmittedRunningConvergence(entry.id, input.daemon_generation);
      if (!result.created) return { status: "existing", last_observed_message_id: result.last_observed_message_id };
      return { status: "bootstrapped", last_observed_message_id: tailId };
    });
  }

  /** Queue provider work only after this generation has durably admitted ingress. */
  private async requestAdmittedRunningConvergence(entryId: string, daemonGeneration: number): Promise<void> {
    if (!await this.ownsDaemonGeneration(daemonGeneration)) return;
    const entry = await this.store.getEntry(entryId);
    if (!entry || !this.requiresHostGrant(entry) || entry.desired_state !== "running") return;
    if (!await this.supervisedInbox.cursor(entryId)) return;
    this.requestConvergence(entryId);
  }

  private async verifyWorkerSession(input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; agent_session_token: string; api_url: string }): Promise<{ verified: true; entry_id: string; agent_session_id: string }> {
    return this.serializeEntryTick(input.entry_id, () => this.verifyWorkerSessionLocked(input));
  }

  private async verifyWorkerSessionLocked(input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; agent_session_token: string; api_url: string }): Promise<{ verified: true; entry_id: string; agent_session_id: string }> {
    const entry = (await this.store.load()).entries.find((candidate) => candidate.id === input.entry_id);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entry_id}`);
    if (entry.room_id !== input.room_id) throw new Error("Worker session room does not match the supervised manifest entry.");
    if (entry.work_attempt_id !== input.work_attempt_id) throw new Error("Worker session work attempt does not match the supervised manifest entry.");
    if (entry.provider_ref?.execution_generation_id !== input.execution_generation_id) {
      throw new Error("Worker session execution generation does not match the active supervised manifest entry.");
    }
    const attempt = await this.durability.getAttempt(input.work_attempt_id);
    const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === input.execution_generation_id);
    if (!execution || execution.terminal) throw new Error("Worker session execution generation is absent or terminal.");
    const binding = await this.workerBindings.get(input.entry_id);
    const credential = binding ? await this.workerBindings.credentialFor(binding) : null;
    const normalizedApiUrl = new URL(input.api_url).origin;
    if (!binding
      || binding.entry_id !== input.entry_id
      || binding.room_id !== input.room_id
      || binding.work_attempt_id !== input.work_attempt_id
      || binding.execution_generation_id !== input.execution_generation_id
      || binding.agent_session_id !== input.agent_session_id
      || credential !== input.agent_session_token
      || binding.api_url !== normalizedApiUrl) {
      throw new Error("Worker session verification does not match the active supervised binding.");
    }
    return { verified: true, entry_id: input.entry_id, agent_session_id: input.agent_session_id };
  }

  /** Main-process-only handoff path. Tokens live only in WorkerBindingStore memory. */
  private async installWorkerCredential(input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; agent_session_token: string; daemon_generation: number }): Promise<{ status: "installed" | "stale" }> {
    return this.serializeEntryTick(input.entry_id, async () => {
      if (!await this.isExactCredentialRoute(input)) return { status: "stale" };
      const installed = await this.workerBindings.installCredential(input);
      if (installed) void this.startSupervisedDelivery(input.entry_id).catch(() => undefined);
      return { status: installed ? "installed" : "stale" };
    });
  }

  private async borrowWorkerCredential(input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; daemon_generation: number; api_url: string }): Promise<{ status: "available"; credential: string } | { status: "deferred" | "stale" }> {
    return this.serializeEntryTick(input.entry_id, async () => {
      if (!await this.isExactCredentialRoute(input)) return { status: "stale" };
      const credential = await this.workerBindings.credentialFor(input);
      return credential ? { status: "available", credential } : { status: "deferred" };
    });
  }

  /** All four durable identities fence a credential from a retired daemon/turn. */
  private async isExactCredentialRoute(input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; daemon_generation: number; api_url?: string }): Promise<boolean> {
    if (!Number.isSafeInteger(input.daemon_generation) || input.daemon_generation !== this.singleton.currentGeneration) return false;
    const entry = await this.store.getEntry(input.entry_id);
    if (!entry || entry.room_id !== input.room_id || entry.work_attempt_id !== input.work_attempt_id
      || entry.provider_ref?.execution_generation_id !== input.execution_generation_id) return false;
    const attempt = await this.durability.getAttempt(input.work_attempt_id);
    const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === input.execution_generation_id);
    if (!execution || execution.terminal) return false;
    const binding = await this.workerBindings.get(input.entry_id);
    let normalizedApiUrl: string | null = null;
    if (input.api_url !== undefined) {
      try { normalizedApiUrl = new URL(input.api_url).origin; } catch { return false; }
    }
    return Boolean(binding && binding.room_id === input.room_id && binding.work_attempt_id === input.work_attempt_id
      && binding.execution_generation_id === input.execution_generation_id && binding.agent_session_id === input.agent_session_id
      && (normalizedApiUrl === null || binding.api_url === normalizedApiUrl));
  }

  private async checkpointWorkerCursor(input: { entry_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; room_cursor: string }): Promise<{ checkpointed: true; entry_id: string; room_cursor: string }> {
    return this.serializeEntryTick(input.entry_id, () => this.serializeCursorCheckpoint(input.entry_id, async () => {
      const entry = (await this.store.load()).entries.find((candidate) => candidate.id === input.entry_id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entry_id}`);
      if (entry.work_attempt_id !== input.work_attempt_id) throw new Error("Worker cursor work attempt does not match the supervised manifest entry.");
      if (entry.provider_ref?.execution_generation_id !== input.execution_generation_id) {
        throw new Error("Worker cursor execution generation does not match the active supervised manifest entry.");
      }
      const attempt = await this.durability.getAttempt(input.work_attempt_id);
      const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === input.execution_generation_id);
      if (!execution || execution.terminal) throw new Error("Worker cursor execution generation is absent or terminal.");
      const currentBinding = await this.workerBindings.get(input.entry_id);
      if (!currentBinding
        || currentBinding.entry_id !== input.entry_id
        || currentBinding.room_id !== entry.room_id
        || currentBinding.work_attempt_id !== input.work_attempt_id
        || currentBinding.agent_session_id !== input.agent_session_id
        || currentBinding.execution_generation_id !== input.execution_generation_id) {
        throw new Error("Worker cursor checkpoint does not match the active supervised binding.");
      }
      const checkpoint = await this.workerBindings.checkpointCursorMonotonic(
        input.entry_id,
        input.agent_session_id,
        input.execution_generation_id,
        input.room_cursor,
      );
      if (!checkpoint.advanced) {
        const durableCursor = checkpoint.binding.room_cursor;
        if (durableCursor && attempt.checkpoints.at(-1)?.room_cursor !== durableCursor) {
          await this.durability.checkpoint(input.work_attempt_id, {
            room_cursor: durableCursor,
            provider_continuation_id: entry.provider_ref?.provider_continuation_id ?? null,
          });
        }
        return {
          checkpointed: true,
          entry_id: input.entry_id,
          room_cursor: checkpoint.binding.room_cursor ?? input.room_cursor,
        };
      }
      await this.durability.checkpoint(input.work_attempt_id, {
        room_cursor: input.room_cursor,
        provider_continuation_id: entry.provider_ref?.provider_continuation_id ?? null,
      });
      return { checkpointed: true, entry_id: input.entry_id, room_cursor: input.room_cursor };
    }));
  }

  private async publishNativeActivity(entryId: string, method: string, status: "working" | "idle", observedAt = new Date().toISOString()): Promise<boolean> {
    const safeMethod = redactCredentialText(method, 160).value;
    const observedMs = Date.parse(observedAt);
    const currentBinding = await this.workerBindings.get(entryId);
    if (!currentBinding || !await this.workerBindings.credentialFor(currentBinding)) return false;
    const publication = await this.workerBindings.publish(entryId, observedMs, async ({ binding, sequence, observed_at }) => {
      const credential = await this.workerBindings.credentialFor(binding);
      if (!credential) throw new Error("Worker credential is unavailable until desktop credential delivery.");
      const roomPath = binding.room_id.split("/").map(encodeURIComponent).join("/");
      const endpoint = `${binding.api_url}/rooms/${roomPath}/agent-sessions/${encodeURIComponent(binding.agent_session_id)}/native-activity`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify({
          observed_at,
          sequence,
          method: safeMethod,
          status,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Native activity endpoint rejected the daemon bridge with HTTP ${response.status}.`);
      const result = await response.json() as { accepted?: boolean };
      return { accepted: result.accepted !== false };
    });
    if (!publication) return false;
    if (!publication.accepted) throw new Error("Native activity endpoint rejected a stale daemon observation.");
    const verifiedBinding = await this.workerBindings.get(entryId);
    if (verifiedBinding
      && verifiedBinding.room_id === currentBinding.room_id
      && verifiedBinding.work_attempt_id === currentBinding.work_attempt_id
      && verifiedBinding.execution_generation_id === currentBinding.execution_generation_id
      && verifiedBinding.agent_session_id === currentBinding.agent_session_id) {
      // A successful scoped-bearer write is stronger evidence than the stale
      // launch-time credential-handoff latch. This also heals agents that were
      // blocked while an older server still rejected worker bearers.
      let recoveredCredentialHandoff = false;
      await this.updateManifestEntry(entryId, (current) => {
        const recoversCredentialHandoff = current.desired_state === "running"
          && current.condition === "coordination_blocked"
          && current.last_error === "Provider is running; waiting for desktop credential handoff."
          && current.room_id === verifiedBinding.room_id
          && current.work_attempt_id === verifiedBinding.work_attempt_id
          && current.provider_ref?.execution_generation_id === verifiedBinding.execution_generation_id;
        if (!recoversCredentialHandoff) return current;
        recoveredCredentialHandoff = true;
        const confirmedAt = publication.observed_at;
        return {
          ...current,
          observed_state: "working",
          condition: "none",
          last_error: null,
          ready_reached_at: resolveReadyReachedAt(current, true, confirmedAt),
          workplace_liveness: {
            state: "reachable",
            observed_at: confirmedAt,
            detail: "scoped worker bearer verified",
          },
        };
      });
      if (recoveredCredentialHandoff) {
        // The failed bind path suppresses initial inbox startup. A later
        // successful heartbeat must restore both the visible state and actual
        // room delivery, otherwise the agent appears healthy but hears nothing.
        void this.startSupervisedDelivery(entryId).catch(() => undefined);
      }
    }
    return true;
  }

  private async handleProviderTerminal(entryId: string, handle: ProviderActionHandle, executionGenerationId: string, _terminalBinding: LiveBindingIdentity | undefined, terminal: ProviderActionTerminal): Promise<void> {
    if (this.liveHandles.get(entryId) !== handle) return;
    void this.supervisedDelivery?.stop(entryId).catch(() => undefined);
    this.pendingResumeBindings.delete(entryId);
    this.liveHandles.delete(entryId);
    this.liveBindingIdentities.delete(entryId);
    for (const dispose of this.liveDisposers.get(entryId) ?? []) dispose();
    this.liveDisposers.delete(entryId);
    await this.serializeEntryTick(entryId, async () => {
      const entry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId);
      const successorHandle = this.liveHandles.get(entryId);
      if (successorHandle && successorHandle !== handle) return;
      if (entry?.work_attempt_id) {
        const attempt = await this.durability.getAttempt(entry.work_attempt_id);
        if (this.liveHandles.get(entryId)) return;
        const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === executionGenerationId);
        if (execution && !execution.terminal) {
          await this.durability.recordTerminal(entry.work_attempt_id, execution.execution_generation_id, {
            ...this.terminalPayload(terminal, execution.actor),
            generation: execution.generation,
          });
        }
        if (entry.desired_state === "stopped") {
          await this.durability.releaseTerminalExecutionFence(entry.work_attempt_id, executionGenerationId);
        }
      }
      if (this.liveHandles.get(entryId)) return;
      // Do not erase the terminal binding here. installProviderHandle removed its
      // live publication authority above; retaining the owner-only (0600)
      // private credential is what permits an exact successor to verify and
      // roll it forward after an intentional stop/start or daemon replacement.
      await this.observeProviderExitOnce(entryId, terminal, "daemon-provider", executionGenerationId, handle);
      this.requestConvergence(entryId);
    });
  }

  private trackProviderCallback(operation: Promise<void>): void {
    this.providerCallbacks.add(operation);
    void operation.finally(() => this.providerCallbacks.delete(operation));
  }

  private async updateManifestEntry(entryId: string, update: (entry: DaemonManifestEntry) => DaemonManifestEntry): Promise<DaemonManifestEntry> {
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const entry = await this.store.getEntry(entryId);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
      const updated = update(entry);
      if (updated === entry) return entry;
      const next = await this.store.replaceEntry(this.manifestGeneration, updated, (commit) => this.fenceDaemonCommit(commit));
      this.manifestGeneration = next.generation;
      return next.entry;
    });
  }

  /** Identity P1b/P1d must pass into work-durability fencing. */
  supervisorFenceIdentity(): { supervisor_id: string; supervisor_generation: number } {
    return { supervisor_id: this.singleton.lockPath, supervisor_generation: this.singleton.currentGeneration };
  }

  async transition(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string, reconciliation?: DaemonManifestEntry["reconciliation"]): Promise<void> {
    return this.serializeManifestMutation(() => this.transitionOnce(entryId, to, condition, cause, actor, reconciliation));
  }

  private async transitionOnce(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string, reconciliation?: DaemonManifestEntry["reconciliation"], notice?: ReconciliationNotice["kind"], terminal?: ExecutionTerminalPayload): Promise<void> {
    await this.singleton.assertCurrent();
    const entry = await this.store.getEntry(entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
    const safeCause = redactCredentialText(cause).value;
    const safeActor = redactCredentialText(actor).value;
    const sanitizeTerminal = (value: ExecutionTerminalPayload | undefined): ExecutionTerminalPayload | undefined => value ? {
      ...value,
      signal: value.signal === null ? null : redactCredentialText(value.signal).value,
      stdio_archive_ref: value.stdio_archive_ref === null ? null : redactCredentialText(value.stdio_archive_ref).value,
      stdio_tail: redactCredentialText(value.stdio_tail, 64 * 1024).value,
      terminal_cause: redactCredentialText(value.terminal_cause).value,
      actor: redactCredentialText(value.actor).value,
      provider_continuation_id: value.provider_continuation_id === null ? null : redactCredentialText(value.provider_continuation_id).value,
    } : undefined;
    const candidateReconciliation = reconciliation ?? advanceReconciliationState(entry.reconciliation, to, this.nowMs());
    const nextReconciliation = {
      ...candidateReconciliation,
      last_terminal: sanitizeTerminal(candidateReconciliation.last_terminal),
    };
    const safeTerminal = sanitizeTerminal(terminal);
    const noticeKind = notice ?? (condition === "quarantined" ? "quarantine_death" : condition === "coordination_blocked" ? "coordination_escalation" : undefined);
    const notices = (entry.reconciliation_notices ?? []).map((candidate) => ({
      ...candidate,
      cause: redactCredentialText(candidate.cause).value,
      terminal: sanitizeTerminal(candidate.terminal),
    }));
    if (noticeKind) notices.push({ at: new Date().toISOString(), kind: noticeKind, cause: safeCause, terminal: safeTerminal ?? nextReconciliation.last_terminal ?? undefined });
    const lastError = to === "failed" || condition !== "none"
      ? safeCause
      : (["working", "idle", "stopped"].includes(to) ? null : entry.last_error === null || entry.last_error === undefined ? null : redactCredentialText(entry.last_error).value);
    const updated: DaemonManifestEntry = {
      ...entry,
      observed_state: to,
      condition,
      last_error: lastError,
      reconciliation: nextReconciliation,
      reconciliation_notices: notices.slice(-32),
    };
    const next = await this.store.replaceEntry(this.manifestGeneration, updated, (commit) => this.fenceDaemonCommit(commit));
    this.manifestGeneration = next.generation;
    await this.serializeManifestCommit(async () => {
      await this.singleton.assertCurrent();
      await this.audit.append({ at: new Date().toISOString(), entry_id: entryId, from: entry.observed_state, to, cause: safeCause, actor: safeActor, generation: next.generation });
    });
  }

  /**
   * The daemon owns this convergence entry point: manifest state is the source
   * of truth, and every retry deadline survives a daemon restart. P1e supplies
   * the real control-socket port; tests may inject a fake port directly.
   */
  async reconcile(entryId: string, input: DaemonReconcileInput, watchdogThresholdMs: number, actor = "reconciler") {
    return this.serializeEntryTick(entryId, () => this.serializeManifestMutation(() => this.reconcileOnce(entryId, input, watchdogThresholdMs, actor)));
  }

  private async reconcileOnce(entryId: string, input: DaemonReconcileInput, watchdogThresholdMs: number, actor: string) {
    if (!this.providerPort) throw new Error("Provider action port is unavailable");
    await this.singleton.assertCurrent();
    const entry = await this.store.getEntry(entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);

    let reconciliation = advanceReconciliationState(entry.reconciliation, entry.observed_state, input.nowMs);
    if (JSON.stringify(reconciliation) !== JSON.stringify(entry.reconciliation)) {
      const persisted = { ...entry, reconciliation };
      const next = await this.store.replaceEntriesBatch(
        this.manifestGeneration,
        [persisted],
        (commit) => this.fenceDaemonCommit(commit),
      );
      this.manifestGeneration = next.generation;
    }

    let redispatchPending = false;
    let redispatchKind: "poke" | "restart_fresh" | "restart_with_resume" | "stop" | undefined;
    let redispatchActionId = input.reconciliationActionId;
    let redispatchActionSequence = input.reconciliationActionSequence;
    if (reconciliation.pending_action) {
      const pending = reconciliation.pending_action;
      const attachment = await this.providerPort.attachAction(pending.id, input.workAttemptId);
      if (attachment.state === "attached") {
        reconciliation = completeReconciliationAction(reconciliation, pending.id);
        await this.transitionOnce(entryId, attachment.handle.observedState, entry.condition, "reconciled pending provider action", actor, reconciliation);
      }
      if (attachment.state === "absent") { redispatchPending = true; redispatchActionId = pending.id; redispatchActionSequence = pending.sequence; redispatchKind = pending.kind; }
      if (attachment.state === "ambiguous") {
        await this.transitionOnce(entryId, "recovering", "coordination_blocked", `pending provider action ambiguous: ${attachment.reason}`, actor, reconciliation);
        return { decision: { action: "hold_coordination" as const, observedState: "recovering" as const, condition: "coordination_blocked" as const, reason: `pending provider action ambiguous: ${attachment.reason}` }, disposition: "held" as const };
      }
      if (attachment.state === "attached") return {
        decision: { action: "hold_coordination" as const, observedState: attachment.handle.observedState, condition: entry.condition, reason: "pending provider action attached; await next convergence tick" },
        disposition: "held" as const,
      };
    }

    if (redispatchPending && entry.desired_state === "stopped" && redispatchKind !== "stop") {
      reconciliation = completeReconciliationAction(reconciliation, redispatchActionId);
      redispatchPending = false;
      redispatchKind = undefined;
      redispatchActionId = input.reconciliationActionId;
      redispatchActionSequence = input.reconciliationActionSequence;
      await this.transitionOnce(entryId, entry.observed_state, entry.condition, "cancelled pending provider action because desired state is stopped", actor, reconciliation);
    }
    if (redispatchPending && entry.condition === "quarantined") {
      reconciliation = completeReconciliationAction(reconciliation, redispatchActionId);
      await this.transitionOnce(entryId, entry.observed_state, "quarantined", "cancelled pending provider action because entry is quarantined", actor, reconciliation);
      return { decision: { action: "quarantine" as const, observedState: entry.observed_state, condition: "quarantined" as const, reason: "quarantined entry cannot redispatch pending provider action" }, disposition: "held" as const };
    }
    if (redispatchPending && ["restart_fresh", "restart_with_resume"].includes(redispatchKind ?? "") && input.activeLease) {
      await this.transitionOnce(entryId, "recovering", "coordination_blocked", "pending provider action awaits fenced lease rebind", actor, reconciliation);
      return { decision: { action: "hold_coordination" as const, observedState: "recovering" as const, condition: "coordination_blocked" as const, reason: "pending provider action awaits fenced lease rebind" }, disposition: "held" as const };
    }

    const result = await new ProviderReconciler(this.providerPort).reconcile({
      ...input,
      actionId: redispatchActionId,
      forcedAction: redispatchKind,
      desiredState: entry.desired_state,
      observedState: entry.observed_state,
      condition: entry.condition,
      exitsInWindow: reconciliation.exit_timestamps_ms.length,
      nextRestartAtMs: reconciliation.next_restart_at_ms,
    }, watchdogThresholdMs, {
      beforeAction: async (kind) => {
        if (redispatchPending) return;
        reconciliation = beginReconciliationAction(reconciliation, { id: redispatchActionId, sequence: redispatchActionSequence, kind, recorded_at_ms: input.nowMs });
        await this.transitionOnce(entryId, entry.observed_state, entry.condition, `persisted ${kind} action intent`, actor, reconciliation);
      },
    });
    const finalReconciliation = result.disposition === "failed"
      ? recordReconciliationActionFailure(reconciliation, redispatchActionId, input.nowMs)
      : result.disposition === "executed"
        ? completeReconciliationAction(reconciliation, redispatchActionId)
        : reconciliation;
    const target = result.disposition === "failed"
      ? { observedState: "failed" as const, condition: "none" as const }
      : { observedState: result.decision.observedState, condition: result.decision.condition };
    if (target.observedState !== entry.observed_state || target.condition !== entry.condition || JSON.stringify(finalReconciliation) !== JSON.stringify(reconciliation)) {
      await this.transitionOnce(entryId, target.observedState, target.condition, result.decision.reason, actor, finalReconciliation);
    }
    return result;
  }

  private async serializeEntryTick<T>(entryId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.reconciliationTicks.get(entryId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.reconciliationTicks.set(entryId, tail);
    await previous;
    try { return await operation(); } finally {
      release();
      if (this.reconciliationTicks.get(entryId) === tail) this.reconciliationTicks.delete(entryId);
    }
  }

  /** Provider terminal callback: records an actual exit edge before the next tick. */
  async observeProviderExit(entryId: string, terminal: ProviderActionTerminal, actor = "provider", expectedExecutionGenerationId?: string, expectedHandle?: ProviderActionHandle): Promise<void> {
    await this.serializeEntryTick(entryId, () => this.observeProviderExitOnce(entryId, terminal, actor, expectedExecutionGenerationId, expectedHandle));
  }

  private async observeProviderExitOnce(entryId: string, terminal: ProviderActionTerminal, actor: string, expectedExecutionGenerationId?: string, expectedHandle?: ProviderActionHandle): Promise<void> {
    await this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const entry = manifest.entries.find((candidate) => candidate.id === entryId);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
      if (expectedExecutionGenerationId && entry.provider_ref?.execution_generation_id !== expectedExecutionGenerationId) return;
      const currentHandle = this.liveHandles.get(entryId);
      if (expectedHandle && currentHandle && currentHandle !== expectedHandle) return;
      const payload = this.terminalPayload(terminal, actor);
      if (entry.condition === "quarantined") {
        // A stale child cannot unquarantine the entry, but its immutable death
        // evidence must still reach the durable operator inbox.
        await this.transitionOnce(entryId, entry.observed_state, "quarantined", `late provider terminal: ${terminal.terminalCause}`, actor, { ...advanceReconciliationState(entry.reconciliation, entry.observed_state, this.nowMs()), last_terminal: payload }, "quarantine_death", payload);
        return;
      }
      const turnControl = entry.turn_control;
      const completedStopTurn = entry.desired_state === "running"
        && terminal.terminalCause === "stopped"
        && turnControl?.execution_generation_id === entry.provider_ref?.execution_generation_id
        && turnControl?.status === "completed"
        && turnControl?.has_correction === false
        && turnControl?.interrupted === true
        && turnControl?.resumed === false
        && turnControl?.state === "idle";
      const intentional = entry.desired_state === "stopped" || entry.desired_state === "paused" || completedStopTurn;
      const observedState = completedStopTurn ? "idle" : entry.desired_state === "paused" ? "paused" : intentional ? "stopped" : "failed";
      const reconciliation = { ...advanceReconciliationState(entry.reconciliation, observedState, this.nowMs()), last_terminal: payload };
      await this.transitionOnce(
        entryId,
        observedState,
        "none",
        completedStopTurn ? "provider terminal completed intentional stop-turn" : `provider terminal: ${terminal.terminalCause}`,
        actor,
        reconciliation,
      );
    });
  }

  /** Starts periodic convergence and joins provider onExit to the same durable path. */
  async scheduleConvergence(entryId: string, handle: ProviderActionHandle, input: () => DaemonReconcileInput, watchdogThresholdMs: number, intervalMs: number, actor = "reconciler"): Promise<() => Promise<void>> {
    const providerPort = this.providerPort;
    if (!providerPort) throw new Error("Provider action port is unavailable");
    const existing = this.scheduledConvergence.get(entryId);
    if (existing) return (await existing).dispose;
    let resolveReservation!: (control: { dispose: () => Promise<void> }) => void;
    const reservation = new Promise<{ dispose: () => Promise<void> }>((resolve) => { resolveReservation = resolve; });
    this.scheduledConvergence.set(entryId, reservation);
    let timer: ReturnType<typeof setInterval> | null = null;
    let unsubscribe = () => {};
    try {
      let stopped = false;
      let currentHandle = handle;
      let currentHandleGeneration = 0;
      let listenerInstalledGeneration = 0;
      let listenerInstallTail: Promise<void> = Promise.resolve();
      const activeCallbacks = new Set<Promise<void>>();
      const cancel = () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        unsubscribe();
        if (this.scheduledConvergence.get(entryId) === reservation) this.scheduledConvergence.delete(entryId);
        if (this.scheduledConvergenceCancels.get(entryId) === cancel) this.scheduledConvergenceCancels.delete(entryId);
      };
      this.scheduledConvergenceCancels.set(entryId, cancel);
      const trackCallback = (operation: Promise<void>) => {
        activeCallbacks.add(operation);
        void operation.then(() => activeCallbacks.delete(operation), () => activeCallbacks.delete(operation));
      };
      const recordError = async (error: unknown) => this.recordSchedulerFailure(entryId, error, actor);
      const sameHandle = (left: ProviderActionHandle, right: ProviderActionHandle) => left.workAttemptId === right.workAttemptId && left.pid === right.pid && left.providerContinuationId === right.providerContinuationId;
      const recordStaleExit = async (staleHandle: ProviderActionHandle, terminal: ProviderActionTerminal) => {
        const payload = this.terminalPayload(terminal, actor);
        await this.serializeEntryTick(entryId, () => this.serializeManifestMutation(async () => {
          const manifest = await this.store.load();
          const entry = manifest.entries.find((candidate) => candidate.id === entryId);
          if (!entry) return;
          await this.transitionOnce(entryId, entry.observed_state, entry.condition, `stale terminal from superseded provider handle pid=${staleHandle.pid ?? "unknown"}`, actor, { ...advanceReconciliationState(entry.reconciliation, entry.observed_state, this.nowMs()), last_terminal: payload }, "coordination_escalation", payload);
        }));
      };
      const installExitListener = async (nextHandle: ProviderActionHandle, generation: number) => {
        let nextUnsubscribe: () => void;
        try { nextUnsubscribe = await providerPort.onExit(nextHandle, (terminal) => {
          const operation = (async () => {
            try {
              if (generation !== currentHandleGeneration || !sameHandle(nextHandle, currentHandle)) {
                await recordStaleExit(nextHandle, terminal);
                return;
              }
              await this.observeProviderExit(entryId, terminal, actor);
              await tick();
            } catch (error) {
              try { await recordError(error); } catch { /* A fenced daemon cannot persist after losing authority. */ }
            }
          })();
          trackCallback(operation);
        }); } catch (error) {
          if (generation > 1) throw new ReplacementListenerInstallError(error instanceof Error ? error.message : "replacement listener installation failed");
          throw error;
        }
        if (stopped || generation !== currentHandleGeneration || !sameHandle(nextHandle, currentHandle)) { nextUnsubscribe(); return; }
        const previousUnsubscribe = unsubscribe;
        unsubscribe = nextUnsubscribe;
        listenerInstalledGeneration = generation;
        previousUnsubscribe();
      };
      const enqueueExitListenerInstall = (nextHandle: ProviderActionHandle, generation: number) => {
        const operation = listenerInstallTail.then(() => installExitListener(nextHandle, generation));
        listenerInstallTail = operation.catch(() => undefined);
        return operation;
      };
      const queueExitListenerInstall = (nextHandle: ProviderActionHandle) => {
        // Promotion is intentionally before the await inside `onExit`: a late
        // terminal from the superseded child is evidence, never a new restart.
        currentHandle = nextHandle;
        currentHandleGeneration += 1;
        const generation = currentHandleGeneration;
        return enqueueExitListenerInstall(nextHandle, generation);
      };
      let tickTail: Promise<void> = Promise.resolve();
      const tick = () => {
        const operation = tickTail.then(async () => {
          if (stopped) return;
          if (listenerInstalledGeneration !== currentHandleGeneration) await enqueueExitListenerInstall(currentHandle, currentHandleGeneration);
          const result = await this.reconcile(entryId, { ...input(), handle: currentHandle }, watchdogThresholdMs, actor);
          if (!stopped && result.replacementHandle) await queueExitListenerInstall(result.replacementHandle);
        });
        // A failed action is durably escalated by the caller, but must not
        // prevent the next convergence edge from observing the new handle.
        tickTail = operation.catch(() => undefined);
        return operation;
      };
      timer = setInterval(() => {
        trackCallback(tick().catch(async (error) => { try { await recordError(error); } catch { /* See terminal callback. */ } }));
      }, intervalMs);
      await queueExitListenerInstall(handle);
      // A replacement may already exist when its listener bridge transiently
      // fails. Keep the scheduler alive: the next serialized tick retries the
      // same promoted handle instead of launching another child.
      try { await tick(); } catch (error) {
        if (error instanceof ReplacementListenerInstallError) await recordError(error);
        else throw error;
      }
      const dispose = async () => {
        cancel();
        await Promise.all([...activeCallbacks]);
      };
      resolveReservation({ dispose });
      return dispose;
    } catch (error) {
      this.scheduledConvergenceCancels.get(entryId)?.();
      try { await this.recordSchedulerFailure(entryId, error, actor); } catch { /* Preserve the original setup failure for the caller. */ }
      resolveReservation({ dispose: async () => {} });
      if (this.scheduledConvergence.get(entryId) === reservation) this.scheduledConvergence.delete(entryId);
      throw error;
    }
  }

  private async serializeManifestMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.manifestMutation;
    let release!: () => void;
    this.manifestMutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.singleton.assertCurrent();
      return await operation();
    } finally { release(); }
  }

  private writeManifest(
    expectedGeneration: number,
    entries: DaemonManifestEntry[],
    legacyOwners?: LegacyLaneOwner[],
  ) {
    return this.store.write(expectedGeneration, entries, legacyOwners, (commit) => this.fenceDaemonCommit(commit));
  }

  private fenceDaemonCommit(commit: () => Promise<void>): Promise<void> {
    return this.serializeManifestCommit(async () => {
      if (this.handoffScheduled) throw new DaemonFenceLostError("Supervisor handoff fenced a stale daemon-owned commit.");
      await this.singleton.assertCurrent();
      await commit();
    });
  }

  private async serializeManifestCommit<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.manifestCommit;
    let release!: () => void;
    this.manifestCommit = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private terminalPayload(terminal: ProviderActionTerminal, actor: string): ExecutionTerminalPayload {
    return {
      ended_at: terminal.endedAt,
      exit_code: terminal.exitCode,
      signal: terminal.signal,
      stdio_archive_ref: null,
      stdio_tail: "",
      terminal_cause: terminal.terminalCause,
      actor,
      generation: this.singleton.currentGeneration,
      provider_continuation_id: terminal.providerContinuationId,
    };
  }

  private async recordSchedulerFailure(entryId: string, error: unknown, actor: string): Promise<void> {
    const message = schedulerErrorDetail(error);
    await this.serializeEntryTick(entryId, () => this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const entry = manifest.entries.find((candidate) => candidate.id === entryId);
      if (!entry) return;
      const condition = entry.condition === "quarantined" ? "quarantined" : "coordination_blocked";
      // Before a work attempt exists there is no provider execution to
      // recover or reconnect. Preserve that distinction in durable state so
      // the desktop can offer an honest provisioning retry.
      const observedState = !entry.work_attempt_id && !entry.provider_ref
        ? "failed"
        : entry.observed_state;
      await this.transitionOnce(entryId, observedState, condition, `convergence scheduler failure: ${message}`, actor, undefined, "coordination_escalation");
    }));
    // A transient mint failure must converge again without waiting for another
    // Electron RPC. The per-entry timer coalesces this into one bounded retry.
    if (exhaustedTransientWorkerMint(error)) {
      this.scheduleRecoveryConvergence(entryId, this.nativeHeartbeatIntervalMs);
    }
  }
}

function projectDeliveryReceipts(receipts: readonly SupervisedInboxReceiptWithTimeline[]): DaemonManifestEntryView["delivery_receipts"] {
  const sourceMessageByInboxId = new Map(receipts.map((receipt) => [receipt.inbox_item_id, receipt.source_message_id]));
  return receipts.map((receipt) => ({
    inbox_item_id: receipt.inbox_item_id,
    source_message_id: receipt.source_message_id,
    state: receipt.receipt_state,
    attempt_count: receipt.attempt_count,
    provider_turn_id: receipt.provider_turn_id,
    // Inbox ids are daemon-private. The projection exposes only the public
    // source message id needed by the renderer's "view earlier message" link.
    blocked_by_message_id: receipt.blocked_by_inbox_item_id
      ? sourceMessageByInboxId.get(receipt.blocked_by_inbox_item_id) ?? null
      : null,
    error: receipt.last_error,
    updated_at: receipt.updated_at,
    timeline: receipt.timeline,
  }));
}

function projectDeliveryTurn(head: SupervisedInboxReceiptWithTimeline | null, activeTurn: { inboxItemId: string; sourceMessageId: string; phase: "dispatching" | "responding" | "publishing" } | null): NonNullable<DaemonManifestEntryView["room_agent_state"]>["turn"] {
  if (!head) return { state: "idle", inbox_item_id: null, source_message_id: null, provider_turn_id: null, detail: null };
  // A persisted dispatch marker is recovery evidence, not proof that this
  // daemon is currently running the provider turn. Never call it responding
  // until an exact live handle, current binding, and memory credential exist.
  if (!activeTurn || activeTurn.inboxItemId !== head.inbox_item_id) {
    return {
      state: head.state === "blocked" ? "failed" : "idle",
      inbox_item_id: head.inbox_item_id,
      source_message_id: head.source_message_id,
      provider_turn_id: head.provider_turn_id,
      detail: head.last_error ?? "No current delivery operation is running.",
    };
  }
  const state = activeTurn.phase;
  return {
    state,
    inbox_item_id: head.inbox_item_id,
    source_message_id: head.source_message_id,
    provider_turn_id: head.provider_turn_id,
    detail: head.last_error,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const { ProviderActionPortRouter } = await import("./provider-action-port-router.js");
    const daemon = new SupervisorDaemon(defaultDaemonPaths(), process.platform, new ProviderActionPortRouter(), true);
    await daemon.start();
    await daemon.waitForHandoff();
    process.exit(0);
  })().catch((error) => {
    console.error("Supervisor daemon handoff failed:", error);
    process.exit(1);
  });
}
