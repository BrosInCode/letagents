import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createElectronTestEnv, installNoProdNetworkGuard } from "./harness.js";

// Characterization tests for the Codex managed-agent event-delivery lifecycle in
// codex-supervisor.ts. These lock the CURRENT behavior of the codex runtime
// (dispatch -> enqueue -> wait-for-idle -> turn -> publish) before it is ported
// onto the shared managed-agent-event-turn engine (Phase 3.3b). No dependency
// injection seam was added to codex-supervisor: the runtime is already fully
// exercisable through its production JSON-RPC transport by faking the global
// `WebSocket` (the CodexRpcClient socket) plus the global `fetch` used by the
// app-server readiness probe, and by running rooms in local storage mode.

const { tempDir, resetState } = createElectronTestEnv({
  prefix: "letagents-codex-event-lifecycle-",
  paths: ["state", "chatStorage", "localChatDb"],
});

// Guard the whole suite against a real API call escaping between the
// per-test `installFakeCodexServer` fetch stubs — notably the managed-worker
// desktop-heartbeat/desktop-pause timer, which resolves against
// `LETAGENTS_API_URL` (PROD by default when unset).
const netGuard = installNoProdNetworkGuard({ autoRestore: false });

const {
  saveAgentSession,
  saveCodexLiveSession,
  getCurrentCodexLiveSession,
  getStoredCodexLiveSession,
  getStoredAgentSession,
} = await import("../main/agents/state.js");
const {
  dispatchRoomStreamEventToManagedAgents,
  stopDesktopManagedAgent,
} = await import("../main/agents/codex-supervisor.js");
const {
  createLocalRoom,
  setLocalAwareRoomStorageMode,
} = await import("../main/rooms/local-store.js");
const {
  getLocalChatMessages,
} = await import("../main/rooms/messages/local-store.js");
const { supervisorDaemonClient } = await import("../main/supervisor-daemon.js");

import type {
  DesktopCodexLiveSessionState,
  StoredAgentSessionState,
} from "../main/agents/state.js";
import type { DesktopRoomStreamEvent } from "../ipc-types.js";

// --- fakes -----------------------------------------------------------------

type SentMessage = {
  id?: number;
  method?: string;
  params?: { threadId?: string; turnId?: string; input?: Array<{ text?: string }> };
};

type FakeCodexServerOptions = {
  /** Reply text returned for each successive event `turn/start`, in order. */
  turnReplies?: string[];
  /** When set, every `turn/start` rejects with this error message. */
  turnStartError?: string | null;
  /** Terminal status reported for event turns. Defaults to `completed`. */
  eventTurnStatus?: string;
  /**
   * Status sequence reported for the session's pre-existing turn (`turn_boot`)
   * on successive `thread/read` calls issued before an event turn starts. The
   * last entry sticks. Defaults to `["completed"]` (idle immediately).
   */
  bootTurnStatuses?: string[];
  /** Error sequence returned by `thread/read` before normal reads resume. */
  threadReadErrors?: Array<string | null>;
  /** Fired when a `thread/read` reports the boot turn (1-based read count). */
  onBootTurnRead?: (readCount: number) => void;
  /** Fired when a `turn/start` arrives (1-based event-turn count). */
  onTurnStart?: (turnCount: number) => void;
  /** Close the app-server socket immediately after acknowledging an event turn. */
  disconnectAfterTurnStart?: boolean;
};

type FakeCodexServer = {
  sentMessages: SentMessage[];
  prompts: string[];
  unexpectedFetches: string[];
  turnStartCount(): number;
  threadReadCount(): number;
  interruptCount(): number;
  restore(): void;
};

function installFakeCodexServer(options: FakeCodexServerOptions = {}): FakeCodexServer {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const replies = [...(options.turnReplies ?? [])];
  const bootTurnStatuses = options.bootTurnStatuses ?? ["completed"];
  const threadReadErrors = [...(options.threadReadErrors ?? [])];
  const eventTurns = new Map<string, string>();
  const sentMessages: SentMessage[] = [];
  const prompts: string[] = [];
  let turnStartCount = 0;
  let bootReadCount = 0;

  function bootTurnStatus(): string {
    const index = Math.min(bootReadCount, bootTurnStatuses.length - 1);
    bootReadCount += 1;
    options.onBootTurnRead?.(bootReadCount);
    return bootTurnStatuses[index] ?? "completed";
  }

  function terminalMethod(status: string): string | null {
    return /^(completed|interrupted|failed|cancelled|stopped)$/i.test(status)
      ? `turn/${status.toLowerCase()}`
      : null;
  }

  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(readonly url: string) {
      queueMicrotask(() => this.onopen?.());
    }

    send(raw: string): void {
      const message = JSON.parse(raw) as SentMessage;
      sentMessages.push(message);
      if (!message.id) {
        return;
      }

      let result: Record<string, unknown> = {};
      let error: string | null = null;
      let notification: { method: string; params: Record<string, unknown> } | null = null;
      if (message.method === "initialize") {
        result = {};
      } else if (message.method === "turn/start") {
        if (options.turnStartError) {
          error = options.turnStartError;
        } else {
          const turnId = `turn_event_${++turnStartCount}`;
          options.onTurnStart?.(turnStartCount);
          prompts.push(String(message.params?.input?.[0]?.text ?? ""));
          eventTurns.set(turnId, replies.shift() ?? "NO_ROOM_REPLY");
          result = { turn: { id: turnId } };
          const method = terminalMethod(options.eventTurnStatus ?? "completed");
          if (method) {
            notification = {
              method,
              params: { threadId: message.params?.threadId, turnId },
            };
          }
        }
      } else if (message.method === "thread/read") {
        error = threadReadErrors.shift() ?? null;
        if (!error) {
          const status = bootTurnStatus();
          result = {
            thread: {
              status: { type: "idle" },
              turns: [
                { id: "turn_boot", status, items: [] },
                ...[...eventTurns.entries()].map(([id, text]) => ({
                  id,
                  status: options.eventTurnStatus ?? "completed",
                  items: [{ type: "agentMessage", phase: "final", text }],
                })),
              ],
            },
          };
          const nextStatus = bootTurnStatuses[
            Math.min(bootReadCount, bootTurnStatuses.length - 1)
          ] ?? status;
          const method = isActiveCodexTurnStatusForTest(status)
            ? terminalMethod(nextStatus)
            : null;
          if (method) {
            notification = {
              method,
              params: { threadId: message.params?.threadId, turnId: "turn_boot" },
            };
          }
        }
      } else if (message.method === "turn/interrupt") {
        result = {};
      } else {
        error = `Unexpected Codex app-server RPC in test: ${message.method ?? "(missing)"}`;
      }

      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify(error ? { id: message.id, error: { message: error } } : { id: message.id, result }),
        });
        if (!error && options.disconnectAfterTurnStart && message.method === "turn/start") {
          this.readyState = 3;
          this.onclose?.();
          return;
        }
        if (!error && notification) {
          this.onmessage?.({ data: JSON.stringify(notification) });
        }
      });
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  const unexpectedFetches: string[] = [];
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/readyz")) {
      return new Response("ok", { status: 200 });
    }
    if (url.includes("/reasoning-sessions")) {
      return new Response(JSON.stringify({ session: { id: "reasoning_1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    unexpectedFetches.push(url);
    return new Response(JSON.stringify({ error: `Unexpected fetch: ${url}` }), { status: 599 });
  }) as typeof fetch;

  return {
    sentMessages,
    prompts,
    unexpectedFetches,
    turnStartCount: () => sentMessages.filter((message) => message.method === "turn/start").length,
    threadReadCount: () => sentMessages.filter((message) => message.method === "thread/read").length,
    interruptCount: () => sentMessages.filter((message) => message.method === "turn/interrupt").length,
    restore: () => {
      globalThis.WebSocket = originalWebSocket;
      globalThis.fetch = originalFetch;
    },
  };
}

function isActiveCodexTurnStatusForTest(status: string): boolean {
  return /^(active|inprogress|running|queued|pending)$/i.test(status.replace(/[^a-z]/gi, ""));
}

async function waitFor<T>(
  read: () => T | Promise<T>,
  description: string,
  timeoutMs = 8_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) {
      return value as NonNullable<T>;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

// --- fixtures --------------------------------------------------------------

function liveSession(
  overrides: Partial<DesktopCodexLiveSessionState> = {},
): DesktopCodexLiveSessionState {
  return {
    session_id: "codex_session_1",
    room_id: "room_1",
    room_identifier: "room_1",
    room_display_name: "Codex Room",
    display_name: "RiverField",
    joined_via: "join_room",
    cwd: "/tmp/repo",
    repo_branch: "codex/git-rooms",
    stop_phrase: "/stop-codex-room",
    max_minutes: 0,
    delivery_mode: "desktop_events",
    deadline_utc: null,
    token: "LOCAL_CODEX_ROOM_test",
    thread_id: "thread_1",
    turn_id: "turn_boot",
    server_url: "ws://127.0.0.1:4500",
    server_pid: null,
    launched_server: false,
    codex_bin: "codex",
    agent_session_id: "agent_session_1",
    reasoning_session_id: "reasoning_1",
    status: "completed",
    last_error: null,
    started_at: "2026-06-14T12:00:00.000Z",
    updated_at: "2026-06-14T12:00:00.000Z",
    ...overrides,
  };
}

function workerSession(
  overrides: Partial<StoredAgentSessionState> = {},
): StoredAgentSessionState {
  return {
    session_id: "agent_session_1",
    session_token: "agent_session_1_token",
    room_id: "room_1",
    session_kind: "worker",
    runtime: "codex:LOCAL_CODEX_ROOM_test",
    actor_label: "RiverField | EmmyMay's agent | Codex",
    agent_key: "EmmyMay/riverfield",
    agent_instance_id: "desktop-codex:LOCAL_CODEX_ROOM_test",
    display_name: "RiverField",
    owner_label: "EmmyMay's agent",
    ide_label: "Codex",
    liveness_capability: "desktop_supervised_codex_app_server",
    created_at: "2026-06-14T12:00:00.000Z",
    updated_at: "2026-06-14T12:00:00.000Z",
    last_seen_at: "2026-06-14T12:00:00.000Z",
    ended_at: null,
    ...overrides,
  };
}

function messageEvent(
  roomIdentifier: string,
  overrides: Partial<Extract<DesktopRoomStreamEvent, { type: "message" }>["message"]> = {},
): Extract<DesktopRoomStreamEvent, { type: "message" }> {
  return {
    type: "message",
    roomIdentifier,
    message: {
      id: "msg_1",
      sender: "EmmyMay",
      text: "please check this",
      attachments: [],
      agentPromptKind: null,
      source: "browser",
      timestamp: "2026-06-14T12:00:00.000Z",
      actorLabel: null,
      agentIdentity: null,
      threadRootId: "msg_1",
      threadReplyToId: null,
      thread: null,
      replyTo: null,
      ...overrides,
    },
  };
}

async function seedDeliverableSession(input: {
  roomIdentifier: string;
  sessionId?: string;
  workerSessionId?: string;
  displayName?: string;
  ideLabel?: string;
  stopPhrase?: string;
  cwd?: string;
  repoBranch?: string | null;
  /**
   * Skip the local-room record so the room's storage mode is controlled purely
   * by the override (a local room record forces effectiveMode "local" forever).
   */
  createRoom?: boolean;
}): Promise<DesktopCodexLiveSessionState> {
  const sessionId = input.sessionId ?? "codex_session_1";
  const workerSessionId = input.workerSessionId ?? "agent_session_1";
  const displayName = input.displayName ?? "RiverField";
  const token = `LOCAL_CODEX_ROOM_${sessionId}`;
  if (input.createRoom !== false) {
    await createLocalRoom({ roomIdentifier: input.roomIdentifier, displayName: "Codex Room" });
  }
  await setLocalAwareRoomStorageMode(input.roomIdentifier, "local");
  saveAgentSession(workerSession({
    session_id: workerSessionId,
    session_token: `${workerSessionId}_token`,
    room_id: input.roomIdentifier,
    runtime: `codex:${token}`,
    agent_instance_id: `desktop-codex:${token}`,
    actor_label: `${displayName} | EmmyMay's agent | ${input.ideLabel ?? "Codex"}`,
    agent_key: `EmmyMay/${displayName.toLowerCase()}`,
    display_name: displayName,
    ide_label: input.ideLabel ?? "Codex",
  }));
  return saveCodexLiveSession(liveSession({
    session_id: sessionId,
    room_id: input.roomIdentifier,
    room_identifier: input.roomIdentifier,
    display_name: displayName,
    token,
    agent_session_id: workerSessionId,
    thread_id: `thread_${sessionId}`,
    turn_id: "turn_boot",
    stop_phrase: input.stopPhrase ?? "/stop-codex-room",
    cwd: input.cwd ?? "/tmp/repo",
    repo_branch: input.repoBranch === undefined ? "codex/git-rooms" : input.repoBranch,
    status: "completed",
  }));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initCommittedRepo(prefix: string): string {
  const repo = mkdtempSync(join(tempDir, prefix));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "agent@example.com"]);
  git(repo, ["config", "user.name", "Agent"]);
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-qm", "init"]);
  return repo;
}

// --- 1. happy path ---------------------------------------------------------

test("codex dispatch enqueues, delivers, and publishes a room reply", async () => {
  resetState();
  const roomIdentifier = "local_room_codex_happy";
  await seedDeliverableSession({ roomIdentifier, sessionId: "codex_happy" });
  const server = installFakeCodexServer({ turnReplies: ["Codex delivered a room reply."] });
  try {
    dispatchRoomStreamEventToManagedAgents(messageEvent(roomIdentifier, {
      id: "msg_happy",
      text: "@RiverField please check this",
      threadRootId: "msg_happy",
    }));

    const reply = await waitFor(async () => {
      const page = await getLocalChatMessages(roomIdentifier);
      return page.messages.find((message) => message.text === "Codex delivered a room reply.") ?? null;
    }, "codex happy-path room reply");

    assert.equal(reply.sender, "RiverField | EmmyMay's agent | Codex");
    assert.equal(server.turnStartCount(), 1);
    assert.match(server.prompts[0] ?? "", /please check this/);
    const session = getCurrentCodexLiveSession(roomIdentifier);
    assert.equal(session?.status, "completed");
    assert.equal(session?.last_error, null);
    assert.equal(session?.active_work, null);
    assert.equal(
      server.threadReadCount(),
      2,
      "one readiness read plus one terminal transcript reconciliation read",
    );
  } finally {
    server.restore();
  }
});

// --- 2. wait-for-idle ------------------------------------------------------

test("codex delivery waits for the in-flight turn to go idle and never interrupts it", async () => {
  resetState();
  const roomIdentifier = "local_room_codex_idle";
  await seedDeliverableSession({ roomIdentifier, sessionId: "codex_idle" });
  // The pre-existing turn reports active on the first thread/read, then idle.
  const server = installFakeCodexServer({
    turnReplies: ["Reply after the prior turn drained."],
    bootTurnStatuses: ["inProgress", "completed"],
  });
  try {
    dispatchRoomStreamEventToManagedAgents(messageEvent(roomIdentifier, {
      id: "msg_idle",
      text: "@RiverField please check this",
      threadRootId: "msg_idle",
    }));

    const reply = await waitFor(async () => {
      const page = await getLocalChatMessages(roomIdentifier);
      return page.messages.find((message) => message.text === "Reply after the prior turn drained.") ?? null;
    }, "codex reply after waiting for idle");

    assert.ok(reply);
    // The delivery must not have started the event turn until the prior turn
    // drained, and must never have interrupted the in-flight turn.
    assert.equal(server.interruptCount(), 0);
    assert.equal(server.turnStartCount(), 1);
    const threadReadsBeforeTurnStart = server.sentMessages
      .slice(0, server.sentMessages.findIndex((message) => message.method === "turn/start"))
      .filter((message) => message.method === "thread/read").length;
    assert.equal(
      threadReadsBeforeTurnStart,
      2,
      "the active snapshot and one lifecycle-triggered reconciliation should replace 1s polling",
    );
  } finally {
    server.restore();
  }
});

test("codex connection loss settles an event turn without transcript polling", async () => {
  resetState();
  const roomIdentifier = "local_room_codex_disconnect";
  const seeded = await seedDeliverableSession({ roomIdentifier, sessionId: "codex_disconnect" });
  const server = installFakeCodexServer({ disconnectAfterTurnStart: true });
  try {
    dispatchRoomStreamEventToManagedAgents(messageEvent(roomIdentifier, {
      id: "msg_disconnect",
      text: "@RiverField please check this",
      threadRootId: "msg_disconnect",
    }));

    const session = await waitFor(() => {
      const current = getStoredCodexLiveSession(seeded.session_id);
      return current?.status === "unknown" ? current : null;
    }, "codex event turn to settle after connection loss");

    assert.match(session.last_error ?? "", /disconnected before .* turn completed/i);
    assert.equal(session.active_work, null);
    assert.equal(server.threadReadCount(), 1, "only the readiness read should occur");
  } finally {
    server.restore();
  }
});

test("codex delivery retries a transient thread-not-found response after wake", async () => {
  resetState();
  const roomIdentifier = "local_room_codex_wake_recovery";
  await seedDeliverableSession({ roomIdentifier, sessionId: "codex_wake_recovery" });
  const server = installFakeCodexServer({
    threadReadErrors: ["thread not found: thread_boot", null],
    turnReplies: ["Reply after the thread became available."],
  });
  try {
    dispatchRoomStreamEventToManagedAgents(messageEvent(roomIdentifier, {
      id: "msg_after_wake",
      text: "@RiverField are you still there?",
      threadRootId: "msg_after_wake",
    }));

    const reply = await waitFor(async () => {
      const page = await getLocalChatMessages(roomIdentifier);
      return page.messages.find((message) => message.text === "Reply after the thread became available.") ?? null;
    }, "codex reply after transient thread-not-found response");

    assert.ok(reply);
    assert.equal(server.turnStartCount(), 1);
    assert.equal(getCurrentCodexLiveSession(roomIdentifier)?.status, "completed");
    assert.equal(getCurrentCodexLiveSession(roomIdentifier)?.last_error, null);
  } finally {
    server.restore();
  }
});

// --- 3. error path: no budget, infinite retry ------------------------------

test("codex turn errors set status 'unknown', stay deliverable, and never park (no error budget)", async () => {
  resetState();
  const roomIdentifier = "local_room_codex_error";
  await seedDeliverableSession({ roomIdentifier, sessionId: "codex_error" });
  // Every turn/start rejects; delivery leaves the session deliverable and retries.
  const server = installFakeCodexServer({ turnStartError: "codex turn exploded" });
  try {
    // Dispatch far more than the shared engine's 3-strike budget would tolerate.
    for (let index = 0; index < 5; index += 1) {
      dispatchRoomStreamEventToManagedAgents(messageEvent(roomIdentifier, {
        id: `msg_error_${index}`,
        text: "@RiverField please check this",
        threadRootId: `msg_error_${index}`,
      }));
    }

    await waitFor(
      () => (server.turnStartCount() >= 5 ? true : null),
      "five failing codex turn attempts",
    );

    const session = getCurrentCodexLiveSession(roomIdentifier);
    // Characterizes CURRENT behavior: unknown (deliverable), NOT failed/parked.
    assert.equal(session?.status, "unknown");
    assert.equal(session?.last_error, "codex turn exploded");
    assert.notEqual(session?.status, "failed");
    // The worker session is never disconnected (no parking cleanup path).
    const worker = getStoredAgentSession(session?.agent_session_id ?? null);
    assert.equal(worker?.ended_at ?? null, null);

    // A further event still delivers (proves infinite retry, no budget gate).
    dispatchRoomStreamEventToManagedAgents(messageEvent(roomIdentifier, {
      id: "msg_error_after",
      text: "@RiverField please check this",
      threadRootId: "msg_error_after",
    }));
    await waitFor(
      () => (server.turnStartCount() >= 6 ? true : null),
      "codex still delivers after repeated errors",
    );
  } finally {
    server.restore();
  }
});

// --- 4. stop() -------------------------------------------------------------

test("codex stop with shutdown interrupts the session and disconnects the worker", async () => {
  resetState();
  const originalReleaseLegacyLane = supervisorDaemonClient.releaseLegacyLane;
  (supervisorDaemonClient as unknown as { releaseLegacyLane: () => Promise<{ released: boolean }> }).releaseLegacyLane = async () => ({ released: true });
  const roomIdentifier = "local_room_codex_stop_shutdown";
  try {
    const seeded = await seedDeliverableSession({
      roomIdentifier,
      sessionId: "codex_stop_shutdown",
      workerSessionId: "agent_session_stop_shutdown",
    });
    // No RPC server needed: the shutdown stop path never touches the app-server.
    const stopped = await stopDesktopManagedAgent({ sessionId: seeded.session_id, stopMode: "worker" });

    assert.ok(stopped);
    assert.equal(stopped?.status, "interrupted");
    const session = getStoredCodexLiveSession(seeded.session_id);
    assert.equal(session?.status, "interrupted");
    assert.equal(session?.active_work, null);
    // killOwnedAppServer marks the worker session ended (worker disconnected).
    const worker = getStoredAgentSession(seeded.agent_session_id ?? null);
    assert.ok(worker?.ended_at, "expected the worker agent-session to be marked ended");
  } finally {
    (supervisorDaemonClient as unknown as { releaseLegacyLane: typeof originalReleaseLegacyLane }).releaseLegacyLane = originalReleaseLegacyLane;
  }
});

test("codex non-shutdown stop issues a turn/interrupt RPC for an active turn", async () => {
  resetState();
  const roomIdentifier = "local_room_codex_stop_interrupt";
  const seeded = await seedDeliverableSession({
    roomIdentifier,
    sessionId: "codex_stop_interrupt",
    workerSessionId: "agent_session_stop_interrupt",
  });
  // Point the session at an active turn so stop takes the interrupt-RPC branch.
  saveCodexLiveSession(liveSession({
    ...seeded,
    turn_id: "turn_boot",
  }));
  const server = installFakeCodexServer({ bootTurnStatuses: ["inProgress"] });
  try {
    const stopped = await stopDesktopManagedAgent({ sessionId: seeded.session_id });
    assert.ok(stopped);
    assert.equal(server.interruptCount(), 1);
    // A desktop-events session stays alive after a plain (non-shutdown) stop so
    // it can keep handling future room events.
    assert.equal(stopped?.status, "running");
    const worker = getStoredAgentSession(seeded.agent_session_id ?? null);
    assert.equal(worker?.ended_at ?? null, null);
  } finally {
    server.restore();
  }
});

// --- 5. stop-phrase --------------------------------------------------------

test("codex stop-phrase message ends the session after the turn", async () => {
  resetState();
  const roomIdentifier = "local_room_codex_stop_phrase";
  const seeded = await seedDeliverableSession({
    roomIdentifier,
    sessionId: "codex_stop_phrase",
    workerSessionId: "agent_session_stop_phrase",
    stopPhrase: "/stop-codex-room",
  });
  const server = installFakeCodexServer({ turnReplies: ["Acknowledged, shutting down."] });
  try {
    dispatchRoomStreamEventToManagedAgents(messageEvent(roomIdentifier, {
      id: "msg_stop_phrase",
      text: "/stop-codex-room",
      threadRootId: "msg_stop_phrase",
    }));

    const session = await waitFor(
      () => {
        const current = getStoredCodexLiveSession(seeded.session_id);
        return current?.status === "interrupted" ? current : null;
      },
      "codex session interrupted by stop phrase",
    );

    assert.equal(session.status, "interrupted");
    assert.equal(server.turnStartCount(), 1);
    // The worker session is ended (killOwnedAppServer) after the stop phrase.
    const worker = getStoredAgentSession(seeded.agent_session_id ?? null);
    assert.ok(worker?.ended_at, "expected the worker agent-session to be marked ended");
  } finally {
    server.restore();
  }
});

test("blocked Codex stop phrase tears down immediately instead of queuing stale work", async () => {
  resetState();
  const roomIdentifier = "local_room_codex_blocked_stop_phrase";
  const seeded = await seedDeliverableSession({
    roomIdentifier,
    sessionId: "codex_blocked_stop_phrase",
    workerSessionId: "agent_session_blocked_stop_phrase",
    stopPhrase: "/stop-codex-room",
  });
  const staleEvent = messageEvent(roomIdentifier, { id: "msg_stale", text: "retry this after recovery" });
  saveCodexLiveSession({
    ...seeded,
    status: "blocked",
    active_work: { kind: "message", event_id: staleEvent.message.id, started_at: seeded.updated_at, summary: "Blocked" },
    pending_event: staleEvent,
    queued_events: [staleEvent],
    failure: {
      code: "configuration_error",
      message: "Needs attention",
      retryable: false,
      eventId: staleEvent.message.id,
      occurredAt: seeded.updated_at,
    },
  });

  dispatchRoomStreamEventToManagedAgents(messageEvent(roomIdentifier, {
    id: "msg_blocked_stop_phrase",
    text: "/stop-codex-room",
  }));

  const stopped = await waitFor(() => {
    const current = getStoredCodexLiveSession(seeded.session_id);
    return current?.status === "interrupted" ? current : null;
  }, "blocked Codex session interrupted by stop phrase");

  assert.equal(stopped.pending_event ?? null, null);
  assert.deepEqual(stopped.queued_events ?? [], []);
  assert.equal(stopped.failure ?? null, null);
  assert.equal(stopped.active_work ?? null, null);
  assert.ok(getStoredAgentSession(seeded.agent_session_id ?? null)?.ended_at,
    "an exact stop must disconnect the blocked worker, not only queue its event");
});

test("codex stop-phrase message still ends the session when its turn is interrupted", async () => {
  resetState();
  const roomIdentifier = "local_room_codex_interrupted_stop_phrase";
  const seeded = await seedDeliverableSession({
    roomIdentifier,
    sessionId: "codex_interrupted_stop_phrase",
    workerSessionId: "agent_session_interrupted_stop_phrase",
    stopPhrase: "/stop-codex-room",
  });
  const server = installFakeCodexServer({ eventTurnStatus: "interrupted" });
  try {
    dispatchRoomStreamEventToManagedAgents(messageEvent(roomIdentifier, {
      id: "msg_interrupted_stop_phrase",
      text: "/stop-codex-room",
      threadRootId: "msg_interrupted_stop_phrase",
    }));

    const session = await waitFor(
      () => {
        const current = getStoredCodexLiveSession(seeded.session_id);
        return current?.status === "interrupted" ? current : null;
      },
      "codex session interrupted after its stop-phrase turn was interrupted",
    );

    assert.equal(session.status, "interrupted");
    assert.equal(server.turnStartCount(), 1);
    const worker = getStoredAgentSession(seeded.agent_session_id ?? null);
    assert.ok(worker?.ended_at, "expected the worker agent-session to be marked ended");
  } finally {
    server.restore();
  }
});

// --- 6. change-baseline timing ----------------------------------------------

test("codex captures the change baseline after the previous turn goes idle, not at enqueue", async () => {
  resetState();
  const roomIdentifier = "local_room_codex_change_baseline";
  const repo = initCommittedRepo("codex-change-baseline-repo-");
  const seeded = await seedDeliverableSession({
    roomIdentifier,
    sessionId: "codex_change_baseline",
    workerSessionId: "agent_session_change_baseline",
    cwd: repo,
    repoBranch: "feature/baseline-timing",
  });

  // The previous (boot) turn is still running when the event is enqueued. While
  // it runs it "writes a file" (moves the git-change signature); only then does
  // the thread go idle and the event turn start. The second event's own turn
  // also writes a file, this time AFTER the baseline was captured.
  let activeWorkDuringPreviousTurn: unknown = "unread";
  const server = installFakeCodexServer({
    turnReplies: ["Reply after the previous turn.", "Reply after own-turn changes."],
    bootTurnStatuses: ["inProgress", "completed"],
    onBootTurnRead: (readCount) => {
      if (readCount === 1) {
        // The previous turn is still active: record that the session has NOT
        // been marked active for the new event, then mutate the working tree
        // as the previous turn's "work".
        activeWorkDuringPreviousTurn =
          getStoredCodexLiveSession(seeded.session_id)?.active_work ?? null;
        writeFileSync(join(repo, "previous-turn.txt"), "written by the previous turn\n");
      }
    },
    onTurnStart: (turnCount) => {
      if (turnCount === 2) {
        // The second event's own turn mutates the working tree after that
        // event's baseline was captured.
        writeFileSync(join(repo, "own-turn.txt"), "written by the event turn\n");
      }
    },
  });
  try {
    dispatchRoomStreamEventToManagedAgents(messageEvent(roomIdentifier, {
      id: "msg_baseline_1",
      text: "@RiverField please check this",
      threadRootId: "msg_baseline_1",
    }));

    const firstReply = await waitFor(async () => {
      const page = await getLocalChatMessages(roomIdentifier);
      return page.messages.find((message) => message.text === "Reply after the previous turn.") ?? null;
    }, "reply for the event enqueued behind a running turn");

    // While the previous turn was still running, the new event had not marked
    // the session active (no active_work attributed to it yet).
    assert.equal(activeWorkDuringPreviousTurn, null);
    // The baseline was captured AFTER the previous turn went idle, so the file
    // the previous turn wrote is part of the baseline and is NOT attributed to
    // this event's reply as a working-tree change attachment.
    assert.deepEqual(firstReply.attachments ?? [], []);

    // Positive control, same session: a change made during the event's OWN
    // turn (after the baseline) IS attributed to that event's reply.
    dispatchRoomStreamEventToManagedAgents(messageEvent(roomIdentifier, {
      id: "msg_baseline_2",
      text: "@RiverField please check this again",
      threadRootId: "msg_baseline_2",
    }));
    const secondReply = await waitFor(async () => {
      const page = await getLocalChatMessages(roomIdentifier);
      return page.messages.find((message) => message.text === "Reply after own-turn changes.") ?? null;
    }, "reply for the event whose own turn changed the working tree");
    assert.equal(
      (secondReply.attachments ?? []).length,
      1,
      "expected the own-turn change to attach a working-tree summary",
    );
    assert.match(JSON.stringify(secondReply.attachments), /managed-agent-change-summary/);
  } finally {
    server.restore();
  }
});

// --- 8. storage-resolution timing --------------------------------------------

test("codex publishes to the storage destination captured at enqueue time, not at delivery", async () => {
  resetState();
  // No local-room record and no "local_" prefix: the storage mode is controlled
  // purely by the per-room override so it can actually flip local -> cloud.
  const roomIdentifier = "codex-room-storage-flip";
  await seedDeliverableSession({
    roomIdentifier,
    sessionId: "codex_storage_flip",
    workerSessionId: "agent_session_storage_flip",
    createRoom: false,
  });

  // Event A holds the queue on the wait-for-idle poll (~1s); event B is queued
  // behind it. The room's storage mode flips to cloud while both are pending.
  const server = installFakeCodexServer({
    turnReplies: ["Reply A before the flip.", "Reply B enqueued before the flip."],
    bootTurnStatuses: ["inProgress", "completed"],
  });
  try {
    dispatchRoomStreamEventToManagedAgents(messageEvent(roomIdentifier, {
      id: "msg_flip_a",
      text: "@RiverField please check this",
      threadRootId: "msg_flip_a",
    }));
    dispatchRoomStreamEventToManagedAgents(messageEvent(roomIdentifier, {
      id: "msg_flip_b",
      text: "@RiverField please check this too",
      threadRootId: "msg_flip_b",
    }));

    // Let the enqueue-time storage resolution settle, then flip the room to
    // cloud while event A is still waiting for the previous turn to go idle
    // and event B is still queued behind it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const flipped = await setLocalAwareRoomStorageMode(roomIdentifier, "cloud");
    assert.equal(flipped.effectiveMode, "cloud");

    // Both replies land in the LOCAL store: the storage destination in effect
    // at enqueue time wins, not the flipped one.
    await waitFor(async () => {
      const page = await getLocalChatMessages(roomIdentifier);
      const hasA = page.messages.some((message) => message.text === "Reply A before the flip.");
      const hasB = page.messages.some((message) => message.text === "Reply B enqueued before the flip.");
      return hasA && hasB ? true : null;
    }, "both replies published to the enqueue-time (local) storage");

    // And nothing tried to publish the replies to the cloud messages API.
    assert.deepEqual(
      server.unexpectedFetches.filter((url) => url.includes("/messages")),
      [],
    );
  } finally {
    await setLocalAwareRoomStorageMode(roomIdentifier, "local");
    server.restore();
  }
});

test("no runtime network call escapes to the real API during this suite", () => {
  // Codex runs its rooms in local storage mode, so the managed-worker cloud
  // heartbeat/pause path stays dormant; this asserts nothing slipped past the
  // per-test fake server to a real (prod) endpoint.
  assert.deepEqual(netGuard.escapedUrls(), []);
});
