import { randomUUID } from "crypto";
import { resolve } from "path";

import {
  getCurrentCodexLiveSession,
  getStoredCodexLiveSession,
  saveCodexLiveSession,
  updateCodexLiveSession,
  type CodexLiveSessionState,
} from "../local-state.js";
import {
  isServerReady,
  launchAppServer,
  resolveCodexServerUrl,
  terminateSpawnedProcess,
  waitForServer,
} from "./app-server.js";
import {
  RpcClient,
  type ThreadStartResult,
  type TurnStartResult,
} from "./rpc-client.js";
import { summarizeCodexRuntimeNotificationForTest } from "./runtime-summary.js";
import {
  isTerminalCodexSessionStatus,
  parseStartupObservationMs,
  sleep,
  STARTUP_POLL_INTERVAL_MS,
} from "./session-status.js";
import { buildStartPrompt, DEFAULT_STOP_PHRASE, formatDeadline, makeToken } from "./start-prompt.js";
import { inspectLocalCodexSession } from "./session-inspection.js";
import { toSessionState } from "./session-mapper.js";
import {
  forgetLaunchedAppServer,
  killOwnedAppServer,
  maybeStartCodexRuntimeBridge,
  postCodexRuntimeReasoningSummary,
  registerLaunchedAppServer,
  scheduleOwnedSessionMonitor,
  startCodexRuntimeBridge,
} from "./session-supervisor.js";
import type { StartLocalCodexSessionInput, StartLocalCodexSessionResult } from "./types.js";

async function waitForWorkerStartup(session: CodexLiveSessionState): Promise<CodexLiveSessionState> {
  const observationMs = parseStartupObservationMs();
  const deadline = Date.now() + observationMs;
  let latest = session;

  while (Date.now() < deadline) {
    await sleep(Math.min(STARTUP_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
    const inspected = await inspectLocalCodexSession(session.session_id);
    if (!inspected) {
      continue;
    }

    latest = inspected.session;
    if (!inspected.server_reachable || latest.status === "unknown") {
      const reason = !inspected.server_reachable
        ? "app-server became unreachable during startup"
        : "worker status became unknown during startup";
      const failed =
        updateCodexLiveSession(session.session_id, (current) => ({
          ...current,
          status: "failed",
          last_error: reason,
          updated_at: new Date().toISOString(),
        })) ?? latest;
      throw new Error(`Codex worker exited during startup: ${failed.last_error ?? reason}`);
    }

    if (isTerminalCodexSessionStatus(latest.status)) {
      const reason = latest.status === "completed"
        ? "turn completed before entering the room polling loop"
        : `turn entered ${latest.status}`;
      const failed =
        updateCodexLiveSession(session.session_id, (current) => ({
          ...current,
          status: "failed",
          last_error: reason,
          updated_at: new Date().toISOString(),
        })) ?? latest;
      throw new Error(`Codex worker exited during startup: ${failed.last_error ?? reason}`);
    }
  }

  return latest;
}

export async function startLocalCodexSession(
  input: StartLocalCodexSessionInput
): Promise<StartLocalCodexSessionResult> {
  const cwd = resolve(input.cwd || process.cwd());
  const currentSession = getCurrentCodexLiveSession(input.room_id);

  if (
    currentSession &&
    currentSession.room_id === input.room_id &&
    resolve(currentSession.cwd) === cwd
  ) {
    const inspected = await inspectLocalCodexSession(currentSession.session_id);
    if (
      inspected &&
      (inspected.session.status === "running" || inspected.session.status === "starting")
    ) {
      scheduleOwnedSessionMonitor(inspected.session);
      await maybeStartCodexRuntimeBridge(inspected.session);
      return { session: inspected.session, reused: true };
    }
  }

  const serverUrl = await resolveCodexServerUrl(input.server_url);
  const stopPhrase = input.stop_phrase || DEFAULT_STOP_PHRASE;
  const maxMinutes = Number.isFinite(input.max_minutes) ? Math.max(0, input.max_minutes ?? 0) : 0;
  const codexBin = input.codex_bin || process.env.LETAGENTS_CODEX_BIN || "codex";
  const token = makeToken();
  const deadline = formatDeadline(maxMinutes);
  const launchedServer = !(await isServerReady(serverUrl));
  let serverPid: number | null = null;
  let client: RpcClient | null = null;
  let notificationSession: CodexLiveSessionState | null = null;
  let startupSucceeded = false;

  try {
    if (launchedServer) {
      serverPid = launchAppServer(serverUrl, codexBin);
      if (serverPid) {
        registerLaunchedAppServer(serverPid);
      }
      const ready = await waitForServer(serverUrl);
      if (!ready) {
        throw new Error(`Timed out waiting for codex app-server at ${serverUrl}`);
      }
    }

    client = new RpcClient(serverUrl, (notification) => {
      const session = notificationSession
        ? getStoredCodexLiveSession(notificationSession.session_id) ?? notificationSession
        : null;
      if (!session) return;
      void postCodexRuntimeReasoningSummary(
        session,
        summarizeCodexRuntimeNotificationForTest(notification)
      ).catch(() => {
        // Runtime notifications should never break the worker turn.
      });
    });
    await client.connect();

    const threadStart = await client.request<ThreadStartResult>("thread/start", {});
    const threadId = threadStart.thread?.id;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id.");
    }

    const prompt = buildStartPrompt({
      room_identifier: input.room_identifier,
      joined_via: input.joined_via,
      cwd,
      stop_phrase: stopPhrase,
      token,
      deadline_utc: deadline.utc,
      max_minutes: maxMinutes,
    });

    const turnStart = await client.request<TurnStartResult>("turn/start", {
      threadId,
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });

    const turnId = turnStart.turn?.id;
    if (!turnId) {
      throw new Error("Codex app-server did not return a turn id.");
    }

    const session = saveCodexLiveSession(
      toSessionState({
        session_id: randomUUID(),
        room_id: input.room_id,
        room_identifier: input.room_identifier,
        room_code: input.room_code ?? null,
        room_display_name: input.room_display_name ?? null,
        joined_via: input.joined_via,
        cwd,
        stop_phrase: stopPhrase,
        max_minutes: maxMinutes,
        deadline_utc: deadline.utc,
        token,
        thread_id: threadId,
        turn_id: turnId,
        server_url: serverUrl,
        server_pid: serverPid,
        launched_server: launchedServer,
        codex_bin: codexBin,
      })
    );
    notificationSession = session;

    try {
      const verifiedSession = await waitForWorkerStartup(session);
      scheduleOwnedSessionMonitor(verifiedSession);
      startCodexRuntimeBridge(verifiedSession, client);
      client = null;
      startupSucceeded = true;
      return { session: verifiedSession, reused: false };
    } catch (error) {
      killOwnedAppServer(session);
      throw error;
    }
  } catch (error) {
    if (!startupSucceeded && launchedServer && serverPid) {
      terminateSpawnedProcess(serverPid);
      forgetLaunchedAppServer(serverPid);
    }
    throw error;
  } finally {
    client?.close();
  }
}
