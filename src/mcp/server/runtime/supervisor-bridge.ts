import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

import type { StoredAgentSessionState } from "../../local-state.js";

const SUPERVISOR_PROTOCOL_VERSION = 1;

type SupervisorResponse = { ok?: boolean; error?: string };

/** Bind the exact worker credential minted by registration to its daemon lane. */
export async function bindSupervisedWorkerSession(
  session: StoredAgentSessionState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const entryId = env.LETAGENTS_SUPERVISOR_ENTRY_ID?.trim();
  const socketPath = env.LETAGENTS_SUPERVISOR_DAEMON_SOCKET?.trim();
  const workAttemptId = env.LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID?.trim();
  const executionGenerationId = env.LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID?.trim();
  if (!entryId && !socketPath && !workAttemptId && !executionGenerationId) return false;
  if (!entryId || !socketPath || !workAttemptId || !executionGenerationId) throw new Error("Supervised worker bridge environment is incomplete.");
  if (session.session_kind !== "worker") throw new Error("A supervised provider must register a worker session.");

  const response = await supervisorRequest(socketPath, {
    version: SUPERVISOR_PROTOCOL_VERSION,
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
  });
  if (!response.ok) throw new Error(response.error || "Supervisor rejected the worker session binding.");
  return true;
}

function supervisorRequest(socketPath: string, request: Record<string, unknown>): Promise<SupervisorResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out binding the worker session to the supervisor daemon."));
    }, 5_000);
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
      try { finish(() => resolve(JSON.parse(buffer.slice(0, newline)) as SupervisorResponse)); }
      catch (error) { finish(() => reject(error)); }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}
