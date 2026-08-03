import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import type { StoredAgentSessionState } from "../../local-state.js";

const NEGOTIATION_PROTOCOL_VERSION = 1;
const SUPPORTED_SUPERVISOR_PROTOCOL_VERSIONS = new Set([1, 2]);
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const CONFIRMED_BINDING_VERIFY_TIMEOUT_MS = 250;
const SUPERVISOR_CONTEXT_FILE = ".letagents-supervisor-context.json";
const WORK_ATTEMPT_MARKER_FILE = ".letagents-work-attempt.json";
const MAX_SUPERVISOR_CONTEXT_BYTES = 4 * 1024;

type SupervisorResponse = { version?: number; id?: string; ok?: boolean; error?: string; result?: unknown };
type SupervisorBridgeOptions = {
  requestTimeoutMs?: number;
  cwd?: string;
  /** Tests may inject a private socket; production always uses the canonical local daemon path. */
  trustedDaemonSocketPath?: string;
  /** Keep an already-proven exact generation off the room-delivery latency path. */
  allowConfirmedFastPath?: boolean;
  /** Internal snapshot used to keep an async checkpoint on its original generation. */
  resolvedCoordinates?: ResolvedSupervisorCoordinates;
};
type SupervisorCoordinates = {
  entryId: string;
  socketPath: string;
  workAttemptId: string;
  executionGenerationId: string;
  /** Random exact-turn capability; Cursor rotates it for every native child. */
  providerTurnId?: string;
  /** Non-secret, exact worker route supplied only for resumed bounded turns. */
  agentSessionId?: string;
  roomId?: string;
  agentDisplayName?: string;
};
type ResolvedSupervisorCoordinates = SupervisorCoordinates & {
  supervisorContextCwd: string | null;
};
type NegotiatedSupervisor = {
  protocolVersion: number;
  daemonIdentity: string | null;
  generation: number | null;
};

const confirmedBindingsBySession = new Map<string, string>();
const confirmedRequestsBySession = new Map<string, string>();
const confirmedProtocolsBySession = new Map<string, number>();
const pendingCursorCheckpoints = new Map<string, {
  session: StoredAgentSessionState;
  roomCursor: string;
  env: NodeJS.ProcessEnv;
  options: SupervisorBridgeOptions;
  retryAttempt: number;
}>();
const activeCursorCheckpointDrains = new Set<string>();
const cursorCheckpointRetryTimers = new Map<string, NodeJS.Timeout>();
const CURSOR_CHECKPOINT_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

export type SupervisedWorkerBindingResult = {
  bound: boolean;
  /** Validated, canonical, non-secret route suitable for protected local state. */
  supervisorContextCwd: string | null;
};

/** A credential is returned only to the supervised MCP process that proved all identities. */
export type SupervisedCredentialBorrowResult =
  | { state: "not_supervised" }
  | { state: "available"; credential: string }
  | { state: "deferred"; code: "SUPERVISED_CREDENTIAL_UNAVAILABLE" }
  | { state: "stale"; code: "SUPERVISED_CREDENTIAL_STALE" };

export type PreparedSupervisedEffect =
  | { state: "completed"; result: unknown }
  | { state: "prepared"; effectId: string; action: "execute" }
  | { state: "prepared"; effectId: string; action: "use_final_answer"; sourceMessageId: string }
  | { state: "prepared"; effectId: string; action: "room_move_prepared"; destinationRoom: string };

export async function prepareCurrentSupervisedEffect(input: {
  toolName: string;
  input: unknown;
  mcpRequestId: string;
  mutation: boolean;
}, env: NodeJS.ProcessEnv = process.env, options: SupervisorBridgeOptions = {}): Promise<PreparedSupervisedEffect> {
  const coordinates = await requireCurrentSupervisedCoordinates(env, options);
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const negotiated = await negotiateSupervisor(coordinates.socketPath, timeoutMs);
  if (negotiated.generation === null) throw new Error("The supervised daemon generation is unavailable.");
  const response = await supervisorRequest(coordinates.socketPath, {
    version: negotiated.protocolVersion,
    id: randomUUID(),
    method: "supervisor.prepare_bounded_effect",
    params: {
      entry_id: coordinates.entryId,
      work_attempt_id: coordinates.workAttemptId,
      execution_generation_id: coordinates.executionGenerationId,
      ...(coordinates.providerTurnId ? { provider_turn_id: coordinates.providerTurnId } : {}),
      daemon_generation: negotiated.generation,
      mcp_request_id: input.mcpRequestId,
      tool_name: input.toolName,
      input: input.input,
      mutation: input.mutation,
    },
  }, timeoutMs);
  if (!response.ok) throw new Error(response.error || "The supervised effect was rejected.");
  const result = response.result && typeof response.result === "object" ? response.result as Record<string, unknown> : {};
  if (result.state === "completed") return { state: "completed", result: result.result };
  const effectId = typeof result.effect_id === "string" ? result.effect_id : "";
  if (!effectId) throw new Error("The supervised effect journal did not return an effect id.");
  if (result.action === "use_final_answer" && typeof result.source_message_id === "string") {
    return { state: "prepared", effectId, action: "use_final_answer", sourceMessageId: result.source_message_id };
  }
  if (result.action === "room_move_prepared" && typeof result.destination_room === "string") {
    return { state: "prepared", effectId, action: "room_move_prepared", destinationRoom: result.destination_room };
  }
  return { state: "prepared", effectId, action: "execute" };
}

export async function completeCurrentSupervisedEffect(input: {
  effectId: string;
  result?: unknown;
  error?: string;
}, env: NodeJS.ProcessEnv = process.env, options: SupervisorBridgeOptions = {}): Promise<void> {
  const coordinates = await requireCurrentSupervisedCoordinates(env, options);
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const negotiated = await negotiateSupervisor(coordinates.socketPath, timeoutMs);
  if (negotiated.generation === null) throw new Error("The supervised daemon generation is unavailable.");
  const response = await supervisorRequest(coordinates.socketPath, {
    version: negotiated.protocolVersion,
    id: randomUUID(),
    method: "supervisor.complete_bounded_effect",
    params: {
      entry_id: coordinates.entryId,
      work_attempt_id: coordinates.workAttemptId,
      execution_generation_id: coordinates.executionGenerationId,
      ...(coordinates.providerTurnId ? { provider_turn_id: coordinates.providerTurnId } : {}),
      daemon_generation: negotiated.generation,
      effect_id: input.effectId,
      result: input.result,
      error: input.error,
    },
  }, timeoutMs);
  if (!response.ok) throw new Error(response.error || "The supervised effect completion was rejected.");
}

async function requireCurrentSupervisedCoordinates(
  env: NodeJS.ProcessEnv,
  options: SupervisorBridgeOptions,
): Promise<ResolvedSupervisorCoordinates> {
  if (env.LETAGENTS_EXECUTION_PROFILE?.trim() !== "supervised_room_turn") {
    throw new Error("Supervised effects require the supervised_room_turn execution profile.");
  }
  const coordinates = await resolveSupervisorCoordinates(supervisedContextSession(env), env, options);
  if (!coordinates) throw new Error("The exact supervised daemon coordinates are unavailable.");
  return coordinates;
}

/**
 * Resolve and borrow for the MCP process itself. Unlike registration, this
 * never reads local agent state: the daemon-owned launch context is the sole
 * authority for the exact worker session identity.
 */
export async function borrowCurrentSupervisedWorkerCredential(
  env: NodeJS.ProcessEnv = process.env,
  options: SupervisorBridgeOptions = {},
): Promise<SupervisedCredentialBorrowResult> {
  if (env.LETAGENTS_SUPERVISED_BOUNDED_TURNS?.trim() !== "1") {
    return { state: "not_supervised" };
  }
  const seed = supervisedContextSession(env);
  const coordinates = await resolveSupervisorCoordinates(seed, env, options);
  if (!coordinates?.agentSessionId || !coordinates.roomId) {
    return { state: "stale", code: "SUPERVISED_CREDENTIAL_STALE" };
  }
  return borrowSupervisedWorkerCredential({
    ...seed,
    session_id: coordinates.agentSessionId,
    room_id: coordinates.roomId,
  }, env, { ...options, resolvedCoordinates: coordinates });
}

/** A public, non-secret session-shaped marker for supervised MCP tools. */
export async function resolveCurrentSupervisedWorkerSession(
  roomId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
  options: SupervisorBridgeOptions = {},
): Promise<StoredAgentSessionState> {
  const seed = supervisedContextSession(env);
  const coordinates = await resolveSupervisorCoordinates(seed, env, options);
  if (!coordinates?.agentSessionId || !coordinates.roomId) {
    throw new Error("Daemon-supervised bounded turn is missing its exact worker session context.");
  }
  if (roomId && roomId !== coordinates.roomId) {
    throw new Error(`Daemon-supervised worker session is registered for ${coordinates.roomId}, not ${roomId}.`);
  }
  const displayName = coordinates.agentDisplayName || "Daemon-supervised worker";
  return {
    ...seed,
    session_id: coordinates.agentSessionId,
    room_id: coordinates.roomId,
    agent_key: coordinates.agentSessionId,
    actor_label: displayName,
    display_name: displayName,
  };
}

function supervisedContextSession(env: NodeJS.ProcessEnv = process.env): StoredAgentSessionState {
  const now = new Date(0).toISOString();
  // Codex is the only provider that can recover supervisor coordinates from
  // the worktree context file. Other supervised providers pass their exact
  // coordinates and provider identity through the daemon-created MCP
  // environment, so the fallback must remain Codex for existing context-file
  // sessions rather than inventing a provider that cannot own the file.
  const provider = env.LETAGENTS_SUPERVISOR_PROVIDER?.trim() || "codex";
  const label = provider === "open-model"
    ? "Open Model"
    : provider === "claude-code"
      ? "Claude Code"
      : provider === "codex"
        ? "Codex"
        : "Supervised agent";
  return {
    session_id: "", session_token: "", room_id: "", session_kind: "worker", runtime: provider,
    actor_label: "Daemon-supervised worker", agent_key: "daemon-supervised-worker",
    display_name: "Daemon-supervised worker", owner_label: "", ide_label: label,
    created_at: now, updated_at: now, last_seen_at: now,
  };
}

/**
 * Borrow an in-memory, exact-generation worker bearer. This intentionally has
 * no fallback to the owner/session token: a daemon restarted without Electron
 * handoff must retain its durable inbox and wait.
 */
export async function borrowSupervisedWorkerCredential(
  session: StoredAgentSessionState,
  env: NodeJS.ProcessEnv = process.env,
  options: SupervisorBridgeOptions = {},
): Promise<SupervisedCredentialBorrowResult> {
  const coordinates = options.resolvedCoordinates ?? await resolveSupervisorCoordinates(session, env, options);
  if (!coordinates) return { state: "not_supervised" };
  if (session.session_kind !== "worker") return { state: "stale", code: "SUPERVISED_CREDENTIAL_STALE" };
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const apiUrl = normalizedWorkerApiOrigin(env);
  const negotiated = await negotiateSupervisor(coordinates.socketPath, timeoutMs);
  if (negotiated.generation === null) return { state: "stale", code: "SUPERVISED_CREDENTIAL_STALE" };
  const response = await supervisorRequest(coordinates.socketPath, {
    version: negotiated.protocolVersion,
    id: randomUUID(),
    method: "supervisor.borrow_worker_credential",
    params: {
      entry_id: coordinates.entryId, room_id: session.room_id, work_attempt_id: coordinates.workAttemptId,
      execution_generation_id: coordinates.executionGenerationId, agent_session_id: session.session_id,
      ...(coordinates.providerTurnId ? { provider_turn_id: coordinates.providerTurnId } : {}),
      daemon_generation: negotiated.generation, api_url: apiUrl,
    },
  }, timeoutMs);
  if (!response.ok || response.version !== negotiated.protocolVersion) return { state: "stale", code: "SUPERVISED_CREDENTIAL_STALE" };
  const result = response.result && typeof response.result === "object" ? response.result as Record<string, unknown> : {};
  if (result.status === "deferred") return { state: "deferred", code: "SUPERVISED_CREDENTIAL_UNAVAILABLE" };
  if (result.status !== "available" || typeof result.credential !== "string" || !result.credential.trim()) {
    return { state: "stale", code: "SUPERVISED_CREDENTIAL_STALE" };
  }
  return { state: "available", credential: result.credential };
}

function normalizedWorkerApiOrigin(env: NodeJS.ProcessEnv): string {
  const apiUrl = env.LETAGENTS_API_URL?.trim() || "https://letagents.chat";
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error("Daemon-supervised worker requires a valid LETAGENTS_API_URL.");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopbackHosts.has(parsed.hostname.toLowerCase()))) {
    throw new Error("Daemon-supervised worker requires HTTPS unless LETAGENTS_API_URL uses an exact loopback host.");
  }
  return parsed.origin;
}

/** Bind the exact worker credential minted by registration to its daemon lane. */
export async function bindSupervisedWorkerSession(
  session: StoredAgentSessionState,
  env: NodeJS.ProcessEnv = process.env,
  options: SupervisorBridgeOptions = {},
): Promise<boolean> {
  return (await bindSupervisedWorkerSessionWithContext(session, env, options)).bound;
}

/**
 * Bind and return the validated file-backed route, when one was used.
 * Registration persists this route so later wait/checkpoint calls do not fall
 * back to an unrelated long-lived MCP process cwd.
 */
export async function bindSupervisedWorkerSessionWithContext(
  session: StoredAgentSessionState,
  env: NodeJS.ProcessEnv = process.env,
  options: SupervisorBridgeOptions = {},
): Promise<SupervisedWorkerBindingResult> {
  const coordinates = options.resolvedCoordinates ?? await resolveSupervisorCoordinates(session, env, options);
  if (!coordinates) return { bound: false, supervisorContextCwd: null };
  const { entryId, socketPath, workAttemptId, executionGenerationId } = coordinates;
  if (session.session_kind !== "worker") throw new Error("A supervised provider must register a worker session.");

  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Supervisor bridge timeout must be a positive integer.");
  const requestKey = bindingRequestKey(session, coordinates, env);
  if (options.allowConfirmedFastPath && confirmedRequestsBySession.get(session.session_id) === requestKey) {
    const confirmedProtocol = confirmedProtocolsBySession.get(session.session_id);
    if (!confirmedProtocol) throw new Error("The supervised worker binding protocol is not confirmed.");
    try {
      await verifyConfirmedBinding(
        session,
        coordinates,
        env,
        confirmedProtocol,
        Math.min(timeoutMs, CONFIRMED_BINDING_VERIFY_TIMEOUT_MS),
      );
    } catch (error) {
      clearBindingConfirmationIfCurrent(session.session_id, requestKey);
      throw error;
    }
    return { bound: true, supervisorContextCwd: coordinates.supervisorContextCwd };
  }
  const deadline = Date.now() + timeoutMs;
  const { protocolVersion, daemonIdentity } = await negotiateSupervisor(socketPath, timeoutMs);
  const bindingKey = daemonIdentity ? `${requestKey}\u0000${daemonIdentity}` : null;
  if (bindingKey && confirmedBindingsBySession.get(session.session_id) === bindingKey) {
    confirmedRequestsBySession.set(session.session_id, requestKey);
    confirmedProtocolsBySession.set(session.session_id, protocolVersion);
    return { bound: true, supervisorContextCwd: coordinates.supervisorContextCwd };
  }

  const response = await supervisorRequest(socketPath, {
    version: protocolVersion,
    id: randomUUID(),
    method: "supervisor.bind_worker_session",
    params: {
      entry_id: entryId,
      room_id: session.room_id,
      work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId,
      agent_session_id: session.session_id,
      agent_session_token: session.session_token,
      api_url: env.LETAGENTS_API_URL?.trim() || "https://letagents.chat",
    },
  }, remainingRequestTimeout(deadline));
  if (!response.ok) throw new Error(response.error || "Supervisor rejected the worker session binding.");
  if (response.version !== protocolVersion) throw new Error("Supervisor binding response used an unexpected protocol version.");
  if (bindingKey) {
    confirmedRequestsBySession.set(session.session_id, requestKey);
    confirmedBindingsBySession.set(session.session_id, bindingKey);
    confirmedProtocolsBySession.set(session.session_id, protocolVersion);
  } else {
    // Without a stable daemon identity we cannot prove that a later process at
    // the same socket owns this confirmation, so every wait binds strictly.
    confirmedRequestsBySession.delete(session.session_id);
    confirmedBindingsBySession.delete(session.session_id);
    confirmedProtocolsBySession.delete(session.session_id);
  }
  return { bound: true, supervisorContextCwd: coordinates.supervisorContextCwd };
}

function bindingRequestKey(
  session: StoredAgentSessionState,
  coordinates: SupervisorCoordinates,
  env: NodeJS.ProcessEnv,
): string {
  const tokenDigest = createHash("sha256").update(session.session_token).digest("hex");
  return [
    coordinates.socketPath,
    coordinates.entryId,
    coordinates.workAttemptId,
    coordinates.executionGenerationId,
    session.session_id,
    session.room_id,
    tokenDigest,
    new URL(env.LETAGENTS_API_URL?.trim() || "https://letagents.chat").origin,
  ].join("\u0000");
}

async function verifyConfirmedBinding(
  session: StoredAgentSessionState,
  coordinates: SupervisorCoordinates,
  env: NodeJS.ProcessEnv,
  protocolVersion: number,
  timeoutMs: number,
): Promise<void> {
  const response = await supervisorRequest(coordinates.socketPath, {
    version: protocolVersion,
    id: randomUUID(),
    method: "supervisor.verify_worker_session",
    params: {
      entry_id: coordinates.entryId,
      room_id: session.room_id,
      work_attempt_id: coordinates.workAttemptId,
      execution_generation_id: coordinates.executionGenerationId,
      agent_session_id: session.session_id,
      agent_session_token: session.session_token,
      api_url: env.LETAGENTS_API_URL?.trim() || "https://letagents.chat",
    },
  }, timeoutMs);
  if (!response.ok) throw new Error(response.error || "Supervisor rejected the worker session verification.");
  if (response.version !== protocolVersion) throw new Error("Supervisor verification response used an unexpected protocol version.");
}

function clearBindingConfirmationIfCurrent(sessionId: string, requestKey: string): void {
  if (confirmedRequestsBySession.get(sessionId) !== requestKey) return;
  confirmedRequestsBySession.delete(sessionId);
  confirmedBindingsBySession.delete(sessionId);
  confirmedProtocolsBySession.delete(sessionId);
}

/** Persist the room-delivery cursor beside the daemon-private exact worker credential. */
export async function checkpointSupervisedWorkerCursor(
  session: StoredAgentSessionState,
  roomCursor: string,
  env: NodeJS.ProcessEnv = process.env,
  options: SupervisorBridgeOptions = {},
): Promise<boolean> {
  const coordinates = options.resolvedCoordinates ?? await resolveSupervisorCoordinates(session, env, options);
  if (!coordinates) return false;
  const { entryId, socketPath, workAttemptId, executionGenerationId } = coordinates;
  if (session.session_kind !== "worker") throw new Error("A supervised provider must use a worker session.");
  if (!roomCursor.trim()) throw new Error("Supervised worker cursor is required.");

  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const { protocolVersion } = await negotiateSupervisor(socketPath, timeoutMs);
  const response = await supervisorRequest(socketPath, {
    version: protocolVersion,
    id: randomUUID(),
    method: "supervisor.checkpoint_worker_cursor",
    params: {
      entry_id: entryId,
      work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId,
      agent_session_id: session.session_id,
      room_cursor: roomCursor,
    },
  }, remainingRequestTimeout(deadline));
  if (!response.ok) throw new Error(response.error || "Supervisor rejected the worker cursor checkpoint.");
  if (response.version !== protocolVersion) throw new Error("Supervisor cursor checkpoint response used an unexpected protocol version.");
  return true;
}

/**
 * Coalesce an already-acknowledged cursor outside the MCP response path. The
 * caller acknowledges a prior delivery by passing it as `after_message_id` on
 * the next wait; newly observed output must never be checkpointed here.
 */
export function scheduleSupervisedWorkerCursorCheckpoint(
  session: StoredAgentSessionState,
  roomCursor: string,
  env: NodeJS.ProcessEnv = process.env,
  options: SupervisorBridgeOptions = {},
): void {
  void enqueueSupervisedWorkerCursorCheckpoint(session, roomCursor, env, options).catch((error) => {
    console.error("[letagents] Supervised cursor checkpoint could not be scheduled:", error instanceof Error ? error.message : "unknown supervisor error");
  });
}

async function enqueueSupervisedWorkerCursorCheckpoint(
  session: StoredAgentSessionState,
  roomCursor: string,
  env: NodeJS.ProcessEnv,
  options: SupervisorBridgeOptions,
): Promise<void> {
  const coordinates = await resolveSupervisorCoordinates(session, env, options);
  if (!coordinates) return;
  const key = [
    session.session_id,
    session.room_id,
    coordinates.socketPath,
    coordinates.entryId,
    coordinates.workAttemptId,
    coordinates.executionGenerationId,
  ].join("\u0000");
  const existing = pendingCursorCheckpoints.get(key);
  if (existing && !isNewerRoomCursor(roomCursor, existing.roomCursor)) return;
  pendingCursorCheckpoints.set(key, {
    session,
    roomCursor,
    env,
    options: { ...options, resolvedCoordinates: coordinates },
    retryAttempt: 0,
  });
  const retryTimer = cursorCheckpointRetryTimers.get(key);
  if (retryTimer) {
    clearTimeout(retryTimer);
    cursorCheckpointRetryTimers.delete(key);
  }
  startCursorCheckpointDrain(key);
}

async function drainCursorCheckpoints(key: string): Promise<void> {
  try {
    while (true) {
      const pending = pendingCursorCheckpoints.get(key);
      if (!pending) return;
      pendingCursorCheckpoints.delete(key);
      try {
        await checkpointSupervisedWorkerCursor(
          pending.session,
          pending.roomCursor,
          pending.env,
          pending.options,
        );
      } catch (error) {
        const queued = pendingCursorCheckpoints.get(key);
        if (queued && isNewerRoomCursor(queued.roomCursor, pending.roomCursor)) continue;
        if (isRetryableSupervisorBridgeError(error)
          && pending.retryAttempt < CURSOR_CHECKPOINT_RETRY_DELAYS_MS.length) {
          // A failed newer acknowledgement must not be replaced by an older
          // concurrent wait that happened to enqueue while I/O was in flight.
          if (queued) pendingCursorCheckpoints.delete(key);
          const delayMs = CURSOR_CHECKPOINT_RETRY_DELAYS_MS[pending.retryAttempt]!;
          pendingCursorCheckpoints.set(key, { ...pending, retryAttempt: pending.retryAttempt + 1 });
          const timer = setTimeout(() => {
            cursorCheckpointRetryTimers.delete(key);
            startCursorCheckpointDrain(key);
          }, delayMs);
          timer.unref?.();
          cursorCheckpointRetryTimers.set(key, timer);
          console.warn("[letagents] Supervised cursor checkpoint is pending:", error instanceof Error ? error.message : "unknown supervisor error");
          return;
        }
        // An authority/generation rejection is not a harmless transport blip.
        // Make the next wait prove the exact binding again before it can read.
        await clearCheckpointBindingConfirmationIfCurrent(pending);
        pendingCursorCheckpoints.delete(key);
        console.error("[letagents] Supervised cursor checkpoint was rejected:", error instanceof Error ? error.message : "unknown supervisor error");
      }
    }
  } finally {
    activeCursorCheckpointDrains.delete(key);
    if (pendingCursorCheckpoints.has(key) && !cursorCheckpointRetryTimers.has(key)) {
      startCursorCheckpointDrain(key);
    }
  }
}

async function clearCheckpointBindingConfirmationIfCurrent(pending: {
  session: StoredAgentSessionState;
  env: NodeJS.ProcessEnv;
  options: SupervisorBridgeOptions;
}): Promise<void> {
  try {
    const coordinates = pending.options.resolvedCoordinates
      ?? await resolveSupervisorCoordinates(pending.session, pending.env, pending.options);
    if (!coordinates) return;
    clearBindingConfirmationIfCurrent(
      pending.session.session_id,
      bindingRequestKey(pending.session, coordinates, pending.env),
    );
  } catch {
    // Missing or invalid context already fails the next wait closed.
  }
}

function startCursorCheckpointDrain(key: string): void {
  if (activeCursorCheckpointDrains.has(key) || cursorCheckpointRetryTimers.has(key)) return;
  activeCursorCheckpointDrains.add(key);
  setImmediate(() => { void drainCursorCheckpoints(key); });
}

function isNewerRoomCursor(candidate: string, current: string): boolean {
  if (candidate === current) return false;
  const candidateNumber = parseRoomMessageNumber(candidate);
  const currentNumber = parseRoomMessageNumber(current);
  if (candidateNumber !== null && currentNumber !== null) return candidateNumber > currentNumber;
  return true;
}

function parseRoomMessageNumber(cursor: string): bigint | null {
  const match = /^msg_(\d+)$/.exec(cursor.trim());
  return match ? BigInt(match[1]!) : null;
}

/** Transport failures are retryable bookkeeping failures, not worker failures. */
export function isRetryableSupervisorBridgeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code && ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOENT", "ETIMEDOUT"].includes(code)) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /timed out communicating|socket hang up|connection (?:closed|refused|reset)|broken pipe/i.test(message);
}

function remainingRequestTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining < 1) throw new Error("Timed out communicating with the supervisor daemon.");
  return remaining;
}

async function resolveSupervisorCoordinates(
  session: StoredAgentSessionState,
  env: NodeJS.ProcessEnv,
  options: SupervisorBridgeOptions,
): Promise<ResolvedSupervisorCoordinates | null> {
  const environmentCoordinates: SupervisorCoordinates = {
    entryId: env.LETAGENTS_SUPERVISOR_ENTRY_ID?.trim() ?? "",
    socketPath: env.LETAGENTS_SUPERVISOR_DAEMON_SOCKET?.trim() ?? "",
    workAttemptId: env.LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID?.trim() ?? "",
    executionGenerationId: env.LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID?.trim() ?? "",
    providerTurnId: env.LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID?.trim() || undefined,
    agentSessionId: env.LETAGENTS_SUPERVISOR_AGENT_SESSION_ID?.trim() || undefined,
    roomId: env.LETAGENTS_SUPERVISOR_ROOM_ID?.trim() || undefined,
    agentDisplayName: env.LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME?.trim() || undefined,
  };
  const values = [
    environmentCoordinates.entryId,
    environmentCoordinates.socketPath,
    environmentCoordinates.workAttemptId,
    environmentCoordinates.executionGenerationId,
  ];
  const hasEnvironmentCoordinates = values.some((value) => Boolean(value));
  if (hasEnvironmentCoordinates && values.some((value) => !value)) {
    throw new Error("Supervised worker bridge environment is incomplete.");
  }
  if (hasEnvironmentCoordinates) {
    return { ...environmentCoordinates, supervisorContextCwd: null };
  }

  const context = await readCodexSupervisorContext(
    options.cwd ?? session.supervisor_context_cwd ?? process.cwd(),
  );
  if (!context) {
    if (session.supervisor_context_cwd?.trim()) {
      throw new Error("The persisted supervised worker context is missing.");
    }
    return null;
  }
  if (!/^codex(?::|$)/i.test(session.runtime.trim())) {
    throw new Error("Codex supervisor bridge context cannot bind a non-Codex worker session.");
  }
  if (session.room_id && context.roomId !== session.room_id) {
    throw new Error("Codex supervisor bridge context does not match the worker room.");
  }
  return {
    ...context,
    socketPath: options.trustedDaemonSocketPath ?? join(homedir(), ".letagents", "daemon.sock"),
  };
}

async function readCodexSupervisorContext(cwd: string): Promise<(
  Omit<SupervisorCoordinates, "socketPath"> & { roomId: string; supervisorContextCwd: string }
) | null> {
  const path = join(cwd, SUPERVISOR_CONTEXT_FILE);
  let encoded: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SUPERVISOR_CONTEXT_BYTES) {
      throw new Error("Codex supervisor bridge context must be a small regular file.");
    }
    encoded = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("Codex supervisor bridge context is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex supervisor bridge context is malformed.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.provider !== "codex") {
    throw new Error("Codex supervisor bridge context has an unsupported identity.");
  }
  const required = {
    entryId: record.entry_id,
    roomId: record.room_id,
    workAttemptId: record.work_attempt_id,
    executionGenerationId: record.execution_generation_id,
  };
  for (const [field, candidate] of Object.entries(required)) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      throw new Error(`Codex supervisor bridge context ${field} is required.`);
    }
  }
  const coordinates = Object.fromEntries(
    Object.entries(required).map(([field, candidate]) => [field, (candidate as string).trim()]),
  ) as Omit<SupervisorCoordinates, "socketPath"> & { roomId: string };
  const agentSessionId = typeof record.agent_session_id === "string" && record.agent_session_id.trim()
    ? record.agent_session_id.trim()
    : undefined;
  const agentDisplayName = typeof record.agent_display_name === "string" && record.agent_display_name.trim()
    ? record.agent_display_name.trim()
    : undefined;
  const marker = await readWorkAttemptMarker(cwd);
  if (marker.workAttemptId !== coordinates.workAttemptId) {
    throw new Error("Codex supervisor bridge context does not match the daemon-owned worktree.");
  }
  return { ...coordinates, agentSessionId, agentDisplayName, supervisorContextCwd: await realpath(cwd) };
}

async function readWorkAttemptMarker(cwd: string): Promise<{ workAttemptId: string }> {
  const path = join(cwd, WORK_ATTEMPT_MARKER_FILE);
  let encoded: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SUPERVISOR_CONTEXT_BYTES) {
      throw new Error("Daemon work-attempt marker must be a small regular file.");
    }
    encoded = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Codex supervisor bridge context is outside a daemon-owned worktree.");
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("Daemon work-attempt marker is not valid JSON.");
  }
  const workAttemptId = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).work_attempt_id
    : null;
  if ((value as Record<string, unknown> | null)?.version !== 1 || typeof workAttemptId !== "string" || !workAttemptId.trim()) {
    throw new Error("Daemon work-attempt marker is malformed.");
  }
  return { workAttemptId: workAttemptId.trim() };
}

function negotiationProtocolVersion(result: unknown): number {
  if (!result || typeof result !== "object") throw new Error("Supervisor protocol negotiation returned a malformed result.");
  const protocolVersion = (result as Record<string, unknown>).protocol_version;
  if (typeof protocolVersion !== "number" || !Number.isSafeInteger(protocolVersion)
    || !SUPPORTED_SUPERVISOR_PROTOCOL_VERSIONS.has(protocolVersion)) {
    throw new Error(`Supervisor protocol negotiation returned unsupported version ${String(protocolVersion)}.`);
  }
  return protocolVersion;
}

async function negotiateSupervisor(socketPath: string, timeoutMs: number): Promise<NegotiatedSupervisor> {
  const negotiation = await supervisorRequest(socketPath, {
    version: NEGOTIATION_PROTOCOL_VERSION,
    id: randomUUID(),
    method: "daemon.negotiate",
  }, timeoutMs);
  if (!negotiation.ok) throw new Error(negotiation.error || "Supervisor protocol negotiation failed.");
  const protocolVersion = negotiationProtocolVersion(negotiation.result);
  if (negotiation.version !== protocolVersion) throw new Error("Supervisor negotiation response version does not match its negotiated protocol.");
  const result = negotiation.result as Record<string, unknown>;
  const hasCompleteIdentity = typeof result.generation === "number"
    && Number.isSafeInteger(result.generation)
    && typeof result.pid === "number"
    && Number.isSafeInteger(result.pid)
    && typeof result.started_at === "string"
    && Boolean(result.started_at.trim());
  const daemonIdentity = hasCompleteIdentity
    ? [result.generation, result.pid, result.started_at].join(":")
    : null;
  return { protocolVersion, daemonIdentity, generation: hasCompleteIdentity ? Number(result.generation) : null };
}

function supervisorRequest(socketPath: string, request: Record<string, unknown>, timeoutMs: number): Promise<SupervisorResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out communicating with the supervisor daemon."));
    }, timeoutMs);
    timer.unref();
    const finish = (operation: () => void) => {
      clearTimeout(timer);
      operation();
    };
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(() => reject(error)));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as SupervisorResponse;
        finish(() => response.id === request.id
          ? resolve(response)
          : reject(new Error("Supervisor response id does not match its request.")));
      }
      catch (error) { finish(() => reject(error)); }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}
