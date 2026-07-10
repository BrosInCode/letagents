import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

// Characterization tests for the Codex managed-agent event-delivery lifecycle in
// codex-supervisor.ts. These lock the CURRENT behavior of the codex runtime
// (dispatch -> enqueue -> wait-for-idle -> turn -> publish) before it is ported
// onto the shared managed-agent-event-turn engine (Phase 3.3b). No dependency
// injection seam was added to codex-supervisor: the runtime is already fully
// exercisable through its production JSON-RPC transport by faking the global
// `WebSocket` (the CodexRpcClient socket) plus the global `fetch` used by the
// app-server readiness probe, and by running rooms in local storage mode.

const { resetState } = createElectronTestEnv({
  prefix: "letagents-codex-event-lifecycle-",
  paths: ["state", "chatStorage", "localChatDb"],
});

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
  /**
   * Status sequence reported for the session's pre-existing turn (`turn_boot`)
   * on successive `thread/read` calls issued before an event turn starts. The
   * last entry sticks. Defaults to `["completed"]` (idle immediately).
   */
  bootTurnStatuses?: string[];
};

type FakeCodexServer = {
  sentMessages: SentMessage[];
  prompts: string[];
  turnStartCount(): number;
  interruptCount(): number;
  restore(): void;
};

function installFakeCodexServer(options: FakeCodexServerOptions = {}): FakeCodexServer {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const replies = [...(options.turnReplies ?? [])];
  const bootTurnStatuses = options.bootTurnStatuses ?? ["completed"];
  const eventTurns = new Map<string, string>();
  const sentMessages: SentMessage[] = [];
  const prompts: string[] = [];
  let turnStartCount = 0;
  let bootReadCount = 0;

  function bootTurnStatus(): string {
    const index = Math.min(bootReadCount, bootTurnStatuses.length - 1);
    bootReadCount += 1;
    return bootTurnStatuses[index] ?? "completed";
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
      if (message.method === "initialize") {
        result = {};
      } else if (message.method === "turn/start") {
        if (options.turnStartError) {
          error = options.turnStartError;
        } else {
          const turnId = `turn_event_${++turnStartCount}`;
          prompts.push(String(message.params?.input?.[0]?.text ?? ""));
          eventTurns.set(turnId, replies.shift() ?? "NO_ROOM_REPLY");
          result = { turn: { id: turnId } };
        }
      } else if (message.method === "thread/read") {
        result = {
          thread: {
            status: { type: "idle" },
            turns: [
              { id: "turn_boot", status: bootTurnStatus(), items: [] },
              ...[...eventTurns.entries()].map(([id, text]) => ({
                id,
                status: "completed",
                items: [{ type: "agentMessage", phase: "final", text }],
              })),
            ],
          },
        };
      } else if (message.method === "turn/interrupt") {
        result = {};
      } else {
        error = `Unexpected Codex app-server RPC in test: ${message.method ?? "(missing)"}`;
      }

      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify(error ? { id: message.id, error: { message: error } } : { id: message.id, result }),
        });
      });
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }

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
    return new Response(JSON.stringify({ error: `Unexpected fetch: ${url}` }), { status: 599 });
  }) as typeof fetch;

  return {
    sentMessages,
    prompts,
    turnStartCount: () => sentMessages.filter((message) => message.method === "turn/start").length,
    interruptCount: () => sentMessages.filter((message) => message.method === "turn/interrupt").length,
    restore: () => {
      globalThis.WebSocket = originalWebSocket;
      globalThis.fetch = originalFetch;
    },
  };
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
  providerId?: "codex" | "open-model";
  ideLabel?: string;
  stopPhrase?: string;
}): Promise<DesktopCodexLiveSessionState> {
  const sessionId = input.sessionId ?? "codex_session_1";
  const workerSessionId = input.workerSessionId ?? "agent_session_1";
  const displayName = input.displayName ?? "RiverField";
  const token = `LOCAL_CODEX_ROOM_${sessionId}`;
  await createLocalRoom({ roomIdentifier: input.roomIdentifier, displayName: "Codex Room" });
  await setLocalAwareRoomStorageMode(input.roomIdentifier, "local");
  saveAgentSession(workerSession({
    session_id: workerSessionId,
    session_token: `${workerSessionId}_token`,
    room_id: input.roomIdentifier,
    // The runtime/instance markers stay codex-prefixed for every Codex-engine
    // provider (codex AND open-model) — worker binding matches on these exact
    // per-token markers.
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
    provider_id: input.providerId === "open-model" ? "open-model" : undefined,
    token,
    agent_session_id: workerSessionId,
    thread_id: `thread_${sessionId}`,
    turn_id: "turn_boot",
    stop_phrase: input.stopPhrase ?? "/stop-codex-room",
    status: "completed",
  }));
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
      text: "please check this",
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
      text: "please check this",
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
    assert.ok(
      threadReadsBeforeTurnStart >= 2,
      `expected at least two idle polls before turn/start, saw ${threadReadsBeforeTurnStart}`,
    );
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
        text: "please check this",
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
      text: "please check this",
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
  const roomIdentifier = "local_room_codex_stop_shutdown";
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

// --- 6. open-model rides the codex runtime ---------------------------------

test("open-model sessions ride the codex runtime with codex:-prefixed markers", async () => {
  resetState();
  const roomIdentifier = "local_room_open_model_ride";
  const seeded = await seedDeliverableSession({
    roomIdentifier,
    sessionId: "open_model_ride",
    workerSessionId: "agent_session_open_model_ride",
    displayName: "OpenModelRiver",
    providerId: "open-model",
    ideLabel: "Open Model",
  });
  const server = installFakeCodexServer({ turnReplies: ["Open Model delivered via the codex runtime."] });
  try {
    dispatchRoomStreamEventToManagedAgents(messageEvent(roomIdentifier, {
      id: "msg_open_model_ride",
      text: "please check this",
      threadRootId: "msg_open_model_ride",
    }));

    const reply = await waitFor(async () => {
      const page = await getLocalChatMessages(roomIdentifier);
      return page.messages.find((message) => message.text === "Open Model delivered via the codex runtime.") ?? null;
    }, "open-model reply delivered by the codex runtime");

    assert.ok(reply);
    // Delivered exactly once — the open-model runtime's own dispatch is a no-op;
    // the codex runtime is what picks up open-model live sessions.
    assert.equal(server.turnStartCount(), 1);
    const session = getCurrentCodexLiveSession(roomIdentifier);
    assert.equal(session?.provider_id, "open-model");
    assert.equal(session?.status, "completed");
    // The invariant that the port must preserve: codex:-prefixed runtime and
    // desktop-codex:-prefixed instance markers. Delivery only succeeds because
    // the worker binding matched on these exact codex-prefixed markers.
    const worker = getStoredAgentSession(seeded.agent_session_id ?? null);
    assert.ok(worker?.runtime?.startsWith("codex:"), `runtime marker was ${worker?.runtime}`);
    assert.ok(
      worker?.agent_instance_id?.startsWith("desktop-codex:"),
      `instance marker was ${worker?.agent_instance_id}`,
    );
    assert.equal(worker?.liveness_capability, "desktop_supervised_codex_app_server");
  } finally {
    server.restore();
  }
});
