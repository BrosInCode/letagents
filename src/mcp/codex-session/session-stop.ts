import {
  getCurrentCodexLiveSession,
  getStoredCodexLiveSession,
  updateCodexLiveSession,
  type CodexLiveSessionState,
} from "../local-state.js";
import { isServerReady } from "./app-server.js";
import { RpcClient } from "./rpc-client.js";
import {
  clearSessionMonitor,
  killOwnedAppServer,
} from "./session-supervisor.js";
import type { StopLocalCodexSessionOptions } from "./types.js";

export async function stopLocalCodexSession(
  options?: StopLocalCodexSessionOptions
): Promise<CodexLiveSessionState | null> {
  const session = options?.session_id
    ? getStoredCodexLiveSession(options.session_id)
    : getCurrentCodexLiveSession(options?.room_id ?? undefined);

  if (!session) {
    return null;
  }

  // Attempt to interrupt the turn via RPC, but gracefully handle a dead server.
  const serverReachable = await isServerReady(session.server_url);
  if (serverReachable) {
    try {
      const client = new RpcClient(session.server_url);
      await client.connect();
      try {
        await client.request("turn/interrupt", {
          threadId: session.thread_id,
          turnId: session.turn_id,
        });
      } finally {
        client.close();
      }
    } catch {
      // Server may have died between the readiness check and the RPC call.
    }
  }

  const updated =
    updateCodexLiveSession(session.session_id, (current) => ({
      ...current,
      status: "interrupted",
      last_error: serverReachable ? null : "server unreachable at stop time",
      updated_at: new Date().toISOString(),
    })) ?? session;

  if (options?.shutdown_server || updated.launched_server) {
    killOwnedAppServer(updated);
  }
  clearSessionMonitor(updated.session_id);

  return updated;
}
