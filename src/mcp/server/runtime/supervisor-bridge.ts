import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import type { StoredAgentSessionState } from "../../local-state.js";

const NEGOTIATION_PROTOCOL_VERSION = 1;
const SUPPORTED_SUPERVISOR_PROTOCOL_VERSIONS = new Set([1, 2]);
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const SUPERVISOR_CONTEXT_FILE = ".letagents-supervisor-context.json";
const WORK_ATTEMPT_MARKER_FILE = ".letagents-work-attempt.json";
const MAX_SUPERVISOR_CONTEXT_BYTES = 4 * 1024;

type SupervisorResponse = { version?: number; id?: string; ok?: boolean; error?: string; result?: unknown };
type SupervisorBridgeOptions = {
  requestTimeoutMs?: number;
  cwd?: string;
  /** Tests may inject a private socket; production always uses the canonical local daemon path. */
  trustedDaemonSocketPath?: string;
};
type SupervisorCoordinates = {
  entryId: string;
  socketPath: string;
  workAttemptId: string;
  executionGenerationId: string;
};
type ResolvedSupervisorCoordinates = SupervisorCoordinates & {
  supervisorContextCwd: string | null;
};

export type SupervisedWorkerBindingResult = {
  bound: boolean;
  /** Validated, canonical, non-secret route suitable for protected local state. */
  supervisorContextCwd: string | null;
};

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
  const coordinates = await resolveSupervisorCoordinates(session, env, options);
  if (!coordinates) return { bound: false, supervisorContextCwd: null };
  const { entryId, socketPath, workAttemptId, executionGenerationId } = coordinates;
  if (session.session_kind !== "worker") throw new Error("A supervised provider must register a worker session.");

  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Supervisor bridge timeout must be a positive integer.");
  const negotiation = await supervisorRequest(socketPath, {
    version: NEGOTIATION_PROTOCOL_VERSION,
    id: randomUUID(),
    method: "daemon.negotiate",
  }, timeoutMs);
  if (!negotiation.ok) throw new Error(negotiation.error || "Supervisor protocol negotiation failed.");
  const protocolVersion = negotiationProtocolVersion(negotiation.result);
  if (negotiation.version !== protocolVersion) throw new Error("Supervisor negotiation response version does not match its negotiated protocol.");

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
  }, timeoutMs);
  if (!response.ok) throw new Error(response.error || "Supervisor rejected the worker session binding.");
  if (response.version !== protocolVersion) throw new Error("Supervisor binding response used an unexpected protocol version.");
  return { bound: true, supervisorContextCwd: coordinates.supervisorContextCwd };
}

/** Persist the room-delivery cursor beside the daemon-private exact worker credential. */
export async function checkpointSupervisedWorkerCursor(
  session: StoredAgentSessionState,
  roomCursor: string,
  env: NodeJS.ProcessEnv = process.env,
  options: SupervisorBridgeOptions = {},
): Promise<boolean> {
  const coordinates = await resolveSupervisorCoordinates(session, env, options);
  if (!coordinates) return false;
  const { entryId, socketPath, workAttemptId, executionGenerationId } = coordinates;
  if (session.session_kind !== "worker") throw new Error("A supervised provider must use a worker session.");
  if (!roomCursor.trim()) throw new Error("Supervised worker cursor is required.");

  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const negotiation = await supervisorRequest(socketPath, {
    version: NEGOTIATION_PROTOCOL_VERSION,
    id: randomUUID(),
    method: "daemon.negotiate",
  }, timeoutMs);
  if (!negotiation.ok) throw new Error(negotiation.error || "Supervisor protocol negotiation failed.");
  const protocolVersion = negotiationProtocolVersion(negotiation.result);
  if (negotiation.version !== protocolVersion) throw new Error("Supervisor negotiation response version does not match its negotiated protocol.");
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
  }, timeoutMs);
  if (!response.ok) throw new Error(response.error || "Supervisor rejected the worker cursor checkpoint.");
  if (response.version !== protocolVersion) throw new Error("Supervisor cursor checkpoint response used an unexpected protocol version.");
  return true;
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
  };
  const values = Object.values(environmentCoordinates);
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
  if (!context) return null;
  if (!/^codex(?::|$)/i.test(session.runtime.trim())) {
    throw new Error("Codex supervisor bridge context cannot bind a non-Codex worker session.");
  }
  if (context.roomId !== session.room_id) {
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
  const marker = await readWorkAttemptMarker(cwd);
  if (marker.workAttemptId !== coordinates.workAttemptId) {
    throw new Error("Codex supervisor bridge context does not match the daemon-owned worktree.");
  }
  return { ...coordinates, supervisorContextCwd: await realpath(cwd) };
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
