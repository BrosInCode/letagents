import {
  getCurrentCodexLiveSession,
  getStoredCodexLiveSession,
  updateCodexLiveSession,
} from "../local-state.js";
import { isServerReady } from "./app-server.js";
import { RpcClient, type ThreadReadResult } from "./rpc-client.js";
import { summarizeCodexRuntimeSnapshotForTest } from "./runtime-summary.js";
import {
  deriveCodexLiveSessionStatus,
  extractThreadStatus,
  extractTurnStatus,
  isLikelyMaterializingError,
  isTerminalCodexSessionStatus,
  summarizeItems,
} from "./session-status.js";
import {
  clearSessionMonitor,
  killOwnedAppServer,
  postCodexRuntimeReasoningSummary,
} from "./session-supervisor.js";
import type { LocalCodexSessionStatus } from "./types.js";

export async function inspectLocalCodexSession(
  sessionId?: string | null,
  roomId?: string | null
): Promise<LocalCodexSessionStatus | null> {
  const session = sessionId
    ? getStoredCodexLiveSession(sessionId)
    : getCurrentCodexLiveSession(roomId ?? undefined);

  if (!session) {
    return null;
  }

  const serverReachable = await isServerReady(session.server_url);
  if (!serverReachable) {
    const updated =
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        status: deriveCodexLiveSessionStatus(current, false, null, null),
        updated_at: new Date().toISOString(),
      })) ?? session;
    if (updated.launched_server) {
      killOwnedAppServer(updated);
      clearSessionMonitor(updated.session_id);
    }

    return {
      session: updated,
      server_reachable: false,
      thread_status: null,
      turn_status: null,
      recent_items: [],
    };
  }

  const client = new RpcClient(session.server_url);
  try {
    await client.connect();
    let read: ThreadReadResult | null = null;
    try {
      read = await client.request<ThreadReadResult>("thread/read", {
        threadId: session.thread_id,
        includeTurns: true,
      });
    } catch (error) {
      if (!isLikelyMaterializingError(error)) {
        throw error;
      }
    }

    const turns = read?.thread?.turns ?? [];
    const turn = turns.find((candidate) => candidate.id === session.turn_id) ?? turns[turns.length - 1];
    const threadStatus = extractThreadStatus(read?.thread);
    const turnStatus = extractTurnStatus(turn);
    const recentItems = summarizeItems(turn?.items ?? turn?.output);
    const updated =
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        status: deriveCodexLiveSessionStatus(current, true, threadStatus, turnStatus),
        last_error: null,
        updated_at: new Date().toISOString(),
      })) ?? session;
    if (isTerminalCodexSessionStatus(updated.status)) {
      killOwnedAppServer(updated);
      clearSessionMonitor(updated.session_id);
    }

    void postCodexRuntimeReasoningSummary(
      updated,
      summarizeCodexRuntimeSnapshotForTest({
        threadStatus,
        turnStatus,
        recentItems,
      })
    ).catch(() => {
      // Snapshot-derived reasoning should never break session inspection.
    });

    return {
      session: updated,
      server_reachable: true,
      thread_status: read?.thread?.status ?? null,
      turn_status: turn?.status ?? null,
      recent_items: recentItems,
    };
  } catch (error) {
    const updated =
      updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        status: "unknown",
        last_error: error instanceof Error ? error.message : String(error),
        updated_at: new Date().toISOString(),
      })) ?? session;
    if (updated.launched_server) {
      killOwnedAppServer(updated);
      clearSessionMonitor(updated.session_id);
    }

    return {
      session: updated,
      server_reachable: true,
      thread_status: null,
      turn_status: null,
      recent_items: [],
    };
  } finally {
    client.close();
  }
}
