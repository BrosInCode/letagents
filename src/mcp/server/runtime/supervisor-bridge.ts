import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

import type { StoredAgentSessionState } from "../../local-state.js";

const NEGOTIATION_PROTOCOL_VERSION = 1;
const SUPPORTED_SUPERVISOR_PROTOCOL_VERSIONS = new Set([1, 2]);
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

type SupervisorResponse = { version?: number; id?: string; ok?: boolean; error?: string; result?: unknown };
type SupervisorBridgeOptions = { requestTimeoutMs?: number };

/** Bind the exact worker credential minted by registration to its daemon lane. */
export async function bindSupervisedWorkerSession(
  session: StoredAgentSessionState,
  env: NodeJS.ProcessEnv = process.env,
  options: SupervisorBridgeOptions = {},
): Promise<boolean> {
  const entryId = env.LETAGENTS_SUPERVISOR_ENTRY_ID?.trim();
  const socketPath = env.LETAGENTS_SUPERVISOR_DAEMON_SOCKET?.trim();
  const workAttemptId = env.LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID?.trim();
  const executionGenerationId = env.LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID?.trim();
  if (!entryId && !socketPath && !workAttemptId && !executionGenerationId) return false;
  if (!entryId || !socketPath || !workAttemptId || !executionGenerationId) throw new Error("Supervised worker bridge environment is incomplete.");
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
  return true;
}

/** Persist the room-delivery cursor beside the daemon-private exact worker credential. */
export async function checkpointSupervisedWorkerCursor(
  session: StoredAgentSessionState,
  roomCursor: string,
  env: NodeJS.ProcessEnv = process.env,
  options: SupervisorBridgeOptions = {},
): Promise<boolean> {
  const entryId = env.LETAGENTS_SUPERVISOR_ENTRY_ID?.trim();
  const socketPath = env.LETAGENTS_SUPERVISOR_DAEMON_SOCKET?.trim();
  const workAttemptId = env.LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID?.trim();
  const executionGenerationId = env.LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID?.trim();
  if (!entryId && !socketPath && !workAttemptId && !executionGenerationId) return false;
  if (!entryId || !socketPath || !workAttemptId || !executionGenerationId) throw new Error("Supervised worker bridge environment is incomplete.");
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
