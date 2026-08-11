import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createElectronTestEnv, installNoProdNetworkGuard } from "./harness.js";

const { tempDir, resetState } = createElectronTestEnv({
  prefix: "letagents-cursor-runtime-",
  paths: ["state", "chatStorage", "localChatDb", "localProfile"],
  extraCleanupEnvKeys: ["LETAGENTS_CURSOR_SOURCE_HOME"],
});
const cursorSourceHome = join(tempDir, "cursor-source-home");
mkdirSync(join(cursorSourceHome, ".cursor"), { recursive: true });
writeFileSync(join(cursorSourceHome, ".cursor", "mcp.json"), '{"mcpServers":{"filesystem":{"command":"npx"}}}\n');
process.env.LETAGENTS_CURSOR_SOURCE_HOME = cursorSourceHome;

// The managed-worker desktop-heartbeat/desktop-pause timer fires background
// `apiFetch` calls that these fixture-seeded sessions never await. Without this
// guard those calls resolve against `LETAGENTS_API_URL` — which defaults to the
// PRODUCTION host when unset — so intercept them for the whole suite.
const netGuard = installNoProdNetworkGuard({ autoRestore: false });

const {
  createDesktopCursorRuntime,
} = await import("../main/agents/cursor-runtime.js");
const {
  getStoredAgentSession,
  getStoredCursorLiveSession,
  saveAgentSession,
} = await import("../main/agents/state.js");

import type {
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
  DesktopGitRoomInfo,
  DesktopRoomStorageState,
  DesktopRoomStreamEvent,
} from "../ipc-types.js";
import type {
  CursorRunner,
  CursorTurnInput,
  CursorTurnResult,
} from "../main/agents/cursor-runner.js";
import type { StoredAgentSessionState } from "../main/agents/state.js";

function readyPreflight(): DesktopAgentProviderPreflight {
  return {
    providerId: "cursor",
    status: "ready",
    canStart: true,
    message: "Cursor is ready.",
    detail: null,
    nextAction: null,
    version: "2026.06.26-7079533",
    mcpStatus: "installed",
  };
}

function storageState(roomIdentifier = "room_1"): DesktopRoomStorageState {
  return {
    roomIdentifier,
    defaultMode: "cloud",
    overrideMode: "inherit",
    effectiveMode: "cloud",
    isLocalRoom: false,
    localRoom: null,
    databasePath: "/tmp/local-chat.sqlite",
    localFilesPath: "/tmp/files",
  };
}

function localStorageState(roomIdentifier = "room_1"): DesktopRoomStorageState {
  return {
    roomIdentifier,
    defaultMode: "local",
    overrideMode: "local",
    effectiveMode: "local",
    isLocalRoom: true,
    localRoom: {
      roomIdentifier,
      displayName: "Local Room",
      cloudRoomIdentifier: null,
      publishStatus: "local_only",
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
      publishedAt: null,
      gitRoom: null,
    },
    databasePath: "/tmp/local-chat.sqlite",
    localFilesPath: "/tmp/files",
  };
}

function branchGitRoom(): DesktopGitRoomInfo {
  return {
    provider: "git",
    host: "local",
    repository: {
      id: null,
      fullName: "repo",
      owner: "",
      name: "repo",
    },
    ref: {
      type: "branch",
      name: "feature/cursor-agent",
      defaultBranch: "main",
      baseRef: null,
      headRef: null,
      headRepository: null,
    },
    visibility: "local",
    accessMode: "local",
    isDefault: false,
    source: "local_git",
  };
}

function messageEvent(
  overrides: Partial<Extract<DesktopRoomStreamEvent, { type: "message" }>> = {},
): Extract<DesktopRoomStreamEvent, { type: "message" }> {
  return {
    type: "message",
    roomIdentifier: "room_1",
    message: {
      id: "msg_1",
      sender: "EmmyMay",
      text: "please inspect this",
      attachments: [],
      agentPromptKind: null,
      source: "browser",
      timestamp: "2026-06-30T00:00:00.000Z",
      actorLabel: null,
      agentIdentity: null,
      threadRootId: "msg_1",
      threadReplyToId: null,
      thread: null,
      replyTo: null,
    },
    ...overrides,
  };
}

function fakeRegisterWorker(input: {
  roomIdentifier: string;
  displayName: string;
  token: string;
  repoBranch: string | null;
}): StoredAgentSessionState {
  return saveAgentSession({
    session_id: "agent_session_cursor",
    session_token: "agent_session_token",
    room_id: input.roomIdentifier,
    session_kind: "worker",
    runtime: `cursor:${input.token}`,
    host_id: "host_1",
    host_kind: "macos",
    host_label: "LetAgents Desktop",
    liveness_capability: "desktop_supervised_cursor_readonly",
    tool_bridge_id: `host_1:cursor:${input.token}:desktop:${input.token}`,
    actor_label: `${input.displayName} | EmmyMay's agent | Cursor`,
    agent_key: "EmmyMay/cursor-worker",
    agent_instance_id: `desktop-cursor:${input.token}`,
    display_name: input.displayName,
    owner_label: "EmmyMay",
    ide_label: "Cursor",
    repo_branch: input.repoBranch,
    created_at: "2026-06-30T00:00:00.000Z",
    updated_at: "2026-06-30T00:00:00.000Z",
    last_seen_at: "2026-06-30T00:00:00.000Z",
    ended_at: null,
  });
}

function createRuntimeHarness(
  runner: CursorRunner,
  options: { storage?: DesktopRoomStorageState } = {},
) {
  const published: Array<{ text: string | null; eventId: string }> = [];
  const failures: Array<{ code: string; eventId: string | null }> = [];
  const preflightInputs: DesktopAgentProviderPreflightInput[] = [];
  const runtime = createDesktopCursorRuntime({
    runner,
    preflight: async (_providerId, input) => {
      preflightInputs.push(input ?? {});
      return readyPreflight();
    },
    registerWorker: async (input) => fakeRegisterWorker(input),
    disconnectWorker: async (session) => {
      if (session) {
        const { markAgentSessionEnded } = await import("../main/agents/state.js");
        markAgentSessionEnded(session.session_id);
      }
    },
    publishReply: async (input) => {
      published.push({
        text: input.text,
        eventId: input.event.type === "message" ? input.event.message.id : input.event.task.id,
      });
    },
    publishFailure: async (input) => {
      failures.push({ code: input.failure.code, eventId: input.failure.eventId });
    },
    resolveStorage: async (roomIdentifier) => options.storage ?? storageState(roomIdentifier),
    emitSessionUpdate: () => undefined,
    now: () => "2026-06-30T00:00:00.000Z",
  });
  return { runtime, published, failures, preflightInputs };
}

test("Cursor runtime starts, lists, and inspects a read-only desktop worker", async () => {
  resetState();
  const { runtime, preflightInputs } = createRuntimeHarness({
    async runTurn(): Promise<CursorTurnResult> {
      throw new Error("runTurn should not be called during start");
    },
  });

  const result = await runtime.start({
    providerId: "cursor",
    roomIdentifier: "room_1",
    roomGitRoom: branchGitRoom(),
    roomDisplayName: "Room One",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
  });

  assert.equal(result.session.providerId, "cursor");
  assert.equal(result.session.status, "completed");
  assert.equal(result.session.deliveryMode, "desktop_events");
  assert.equal(result.session.permissionProfileId, "read_only");
  assert.equal(result.session.cursorMcpPolicy, "filter_letagents");
  assert.equal(result.session.permissionProfile.label, "Read-only");
  assert.equal(result.session.canStop, true);
  assert.equal(result.session.ideLabel, "Cursor");
  assert.equal(runtime.listSessions("room_1").length, 1);

  const inspected = await runtime.inspect(result.session.id);
  assert.equal(inspected?.session.providerId, "cursor");
  assert.equal(inspected?.serverReachable, true);
  assert.equal(inspected?.recentItems.length, 1);
  assert.equal(getStoredCursorLiveSession(result.session.id)?.permission_profile_id, "read_only");
  assert.equal(getStoredCursorLiveSession(result.session.id)?.cursor_mcp_policy, "filter_letagents");
  assert.equal(preflightInputs[0]?.permissionProfileId, "read_only");
  assert.equal(preflightInputs[0]?.cursorMcpPolicy, "filter_letagents");
  assert.equal(preflightInputs[0]?.roomGitRoom?.ref.name, "feature/cursor-agent");
});

test("Cursor runtime starts and stops in a local room without cloud worker registration", async () => {
  resetState();
  const { createLocalRoom } = await import("../main/rooms/local-store.js");
  const roomIdentifier = "local_cursor_start";
  await createLocalRoom({
    roomIdentifier,
    displayName: "Cursor Local",
  });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    fetchCalls += 1;
    throw new Error("local room start/stop should not call the cloud API");
  }) as typeof fetch;
  const runtime = createDesktopCursorRuntime({
    runner: {
      async runTurn(): Promise<CursorTurnResult> {
        throw new Error("runTurn should not be called during start");
      },
    },
    preflight: async () => readyPreflight(),
    emitSessionUpdate: () => undefined,
    now: () => "2026-06-30T00:00:00.000Z",
  });

  try {
    const result = await runtime.start({
      providerId: "cursor",
      roomIdentifier,
      roomDisplayName: "Cursor Local",
      repoRootPath: tempDir,
      deliveryMode: "desktop_events",
    });
    const workerSession = getStoredAgentSession(result.session.agentSessionId);

    assert.equal(result.session.providerId, "cursor");
    assert.equal(result.session.roomIdentifier, roomIdentifier);
    assert.ok(result.session.agentSessionId?.startsWith("local_agent_session_"));
    assert.equal(workerSession?.room_id, roomIdentifier);
    assert.match(workerSession?.session_token ?? "", /^local_agent_token_/);
    assert.equal(workerSession?.ide_label, "Cursor");
    assert.match(workerSession?.agent_key ?? "", /^local\/.+\/cursor\//);

    await runtime.stop({ sessionId: result.session.id });
    assert.ok(getStoredAgentSession(result.session.agentSessionId)?.ended_at);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cursor stop control is owner-authorized for active and blocked sessions", async () => {
  resetState();
  let turns = 0;
  const { runtime } = createRuntimeHarness({
    async runTurn(): Promise<CursorTurnResult> {
      turns += 1;
      return {
        sessionId: "cursor_stop_authority",
        text: "ordinary addressed text",
        status: "success",
        error: null,
        recentItems: [],
      };
    },
  });
  const started = await runtime.start({
    providerId: "cursor",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
    stopPhrase: "/stop-cursor-room",
  });
  const stopMessage = {
    ...messageEvent().message,
    id: "msg_stop_other_account",
    text: "/stop-cursor-room",
    accountAgentRouting: {
      version: 1 as const,
      authority: "receipts" as const,
      recipientAgentKeys: [started.session.agentKey!],
      recipientSessions: [{
        agentKey: started.session.agentKey!,
        agentSessionId: started.session.agentSessionId!,
      }],
      controlAuthorized: false,
    },
  };
  runtime.dispatchRoomStreamEvent(messageEvent({ message: stopMessage }));
  await runtime.waitForIdle();
  assert.equal(turns, 1, "addressed text from another account remains ordinary work");
  assert.notEqual(getStoredCursorLiveSession(started.session.id)?.status, "interrupted");

  runtime.dispatchRoomStreamEvent(messageEvent({
    message: {
      ...stopMessage,
      id: "msg_stop_owner",
      accountAgentRouting: {
        version: 1,
        authority: "receipts",
        recipientAgentKeys: [],
        recipientSessions: [],
        controlAuthorized: true,
      },
    },
  }));
  await runtime.waitForIdle();
  assert.equal(turns, 2);
  assert.equal(getStoredCursorLiveSession(started.session.id)?.status, "interrupted");

  resetState();
  let blockedTurns = 0;
  const { runtime: blockedRuntime } = createRuntimeHarness({
    async runTurn(): Promise<CursorTurnResult> {
      blockedTurns += 1;
      return {
        sessionId: null,
        text: null,
        status: "error",
        error: "You've hit your usage limit.",
        recentItems: [],
      };
    },
  });
  const blocked = await blockedRuntime.start({
    providerId: "cursor",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
    stopPhrase: "/stop-cursor-room",
  });
  blockedRuntime.dispatchRoomStreamEvent(messageEvent());
  await blockedRuntime.waitForIdle();
  assert.equal(getStoredCursorLiveSession(blocked.session.id)?.status, "blocked");
  blockedRuntime.dispatchRoomStreamEvent(messageEvent({
    message: {
      ...messageEvent().message,
      id: "msg_stop_blocked_owner",
      text: "/stop-cursor-room",
      accountAgentRouting: {
        version: 1,
        authority: "legacy",
        recipientAgentKeys: [],
        recipientSessions: [],
        controlAuthorized: true,
      },
    },
  }));
  await blockedRuntime.waitForIdle();
  assert.equal(blockedTurns, 1, "blocked stop control bypasses the unavailable model turn");
  assert.equal(getStoredCursorLiveSession(blocked.session.id)?.status, "interrupted");
});

test("Cursor runtime persists selected MCP policy and model, then reuses them for event turns", async () => {
  resetState();
  const calls: CursorTurnInput[] = [];
  const { runtime, preflightInputs } = createRuntimeHarness({
    async runTurn(input: CursorTurnInput): Promise<CursorTurnResult> {
      calls.push(input);
      return {
        sessionId: "cursor_session_1",
        text: "Normal policy turn complete.",
        status: "success",
        error: null,
        recentItems: [{ type: "result", text: "Normal policy turn complete." }],
      };
    },
  });

  const started = await runtime.start({
    providerId: "cursor",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
    cursorMcpPolicy: "normal",
    model: "gpt-5.3-codex-high",
    modelSource: "custom",
  });
  runtime.dispatchRoomStreamEvent(messageEvent());
  await runtime.waitForIdle();

  assert.equal(started.session.cursorMcpPolicy, "normal");
  assert.equal(started.session.model, "gpt-5.3-codex-high");
  assert.equal(getStoredCursorLiveSession(started.session.id)?.cursor_mcp_policy, "normal");
  assert.equal(getStoredCursorLiveSession(started.session.id)?.model, "gpt-5.3-codex-high");
  assert.equal(preflightInputs[0]?.cursorMcpPolicy, "normal");
  assert.equal(preflightInputs[0]?.model, "gpt-5.3-codex-high");
  assert.equal(preflightInputs[0]?.modelSource, "custom");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.model, "gpt-5.3-codex-high");
  assert.deepEqual(calls[0]?.env, {});
});

test("Cursor runtime persists write-capable permission profiles and maps them to runner flags", async () => {
  resetState();
  const calls: CursorTurnInput[] = [];
  const { runtime, preflightInputs } = createRuntimeHarness({
    async runTurn(input: CursorTurnInput): Promise<CursorTurnResult> {
      calls.push(input);
      return {
        sessionId: "cursor_session_write",
        text: "Write-capable turn complete.",
        status: "success",
        error: null,
        recentItems: [{ type: "result", text: "Write-capable turn complete." }],
      };
    },
  });

  const started = await runtime.start({
    providerId: "cursor",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
    permissionProfileId: "full_access",
  });
  runtime.dispatchRoomStreamEvent(messageEvent({ message: { ...messageEvent().message, text: "make the change" } }));
  await runtime.waitForIdle();

  assert.equal(started.session.permissionProfileId, "full_access");
  assert.equal(getStoredCursorLiveSession(started.session.id)?.permission_profile_id, "full_access");
  assert.equal(preflightInputs[0]?.permissionProfileId, "full_access");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.mode, null);
  assert.equal(calls[0]?.force, true);
  assert.equal(calls[0]?.sandbox, "disabled");
  assert.match(calls[0]?.prompt ?? "", /Cursor full access/);
});

test("Cursor runtime maps sandboxed-write profile to Cursor sandbox flags", async () => {
  resetState();
  const calls: CursorTurnInput[] = [];
  const { runtime } = createRuntimeHarness({
    async runTurn(input: CursorTurnInput): Promise<CursorTurnResult> {
      calls.push(input);
      return {
        sessionId: "cursor_session_sandboxed",
        text: "Sandboxed turn complete.",
        status: "success",
        error: null,
        recentItems: [],
      };
    },
  });

  await runtime.start({
    providerId: "cursor",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
    permissionProfileId: "sandboxed_write",
  });
  runtime.dispatchRoomStreamEvent(messageEvent({ message: { ...messageEvent().message, text: "make a sandboxed change" } }));
  await runtime.waitForIdle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.mode, null);
  assert.equal(calls[0]?.force, true);
  assert.equal(calls[0]?.sandbox, "enabled");
  assert.match(calls[0]?.prompt ?? "", /Cursor sandboxed write/);
});

test("Cursor runtime delivers room events into ask-mode runner and persists resume state", async () => {
  resetState();
  const prompts: CursorTurnInput[] = [];
  const { runtime, published } = createRuntimeHarness({
    async runTurn(input: CursorTurnInput): Promise<CursorTurnResult> {
      prompts.push(input);
      return {
        sessionId: "cursor_session_1",
        text: "I can inspect this in read-only mode.",
        status: "success",
        error: null,
        recentItems: [{ type: "result", text: "I can inspect this in read-only mode." }],
      };
    },
  });
  const started = await runtime.start({
    providerId: "cursor",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
  });

  runtime.dispatchRoomStreamEvent(messageEvent());
  await runtime.waitForIdle();

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.mode, "ask");
  assert.equal(prompts[0]?.force, false);
  assert.equal(prompts[0]?.sandbox, null);
  assert.equal(prompts[0]?.env?.HOME, join(tempDir, "cursor-managed", "home"));
  assert.equal(prompts[0]?.env?.CURSOR_CONFIG_DIR, join(tempDir, "cursor-managed", "config", "cursor"));
  assert.equal(prompts[0]?.env?.CURSOR_DATA_DIR, join(tempDir, "cursor-managed", "data", "cursor"));
  assert.match(prompts[0]?.prompt ?? "", /Cursor read-only/);
  assert.match(prompts[0]?.prompt ?? "", /Do not call raw LetAgents MCP room tools/);
  assert.match(prompts[0]?.prompt ?? "", /LETAGENTS_ROOM_TOOL_REQUEST/);
  assert.match(prompts[0]?.prompt ?? "", /must not edit files/);
  assert.equal(prompts[0]?.cursorSessionId, null);
  assert.deepEqual(published, [{ text: "I can inspect this in read-only mode.", eventId: "msg_1" }]);
  const stored = getStoredCursorLiveSession(started.session.id);
  assert.equal(stored?.cursor_session_id, "cursor_session_1");
  assert.equal(stored?.status, "completed");
  assert.equal(stored?.active_work, null);
});

test("Cursor runtime feeds desktop room tool results back into the runner", async () => {
  resetState();
  const prompts: CursorTurnInput[] = [];
  const { runtime, published } = createRuntimeHarness({
    async runTurn(input: CursorTurnInput): Promise<CursorTurnResult> {
      prompts.push(input);
      if (prompts.length === 1) {
        return {
          sessionId: "cursor_session_1",
          text: 'LETAGENTS_ROOM_TOOL_REQUEST {"tool":"publish_room_artifact","arguments":{"artifact":{"provider":"github","kind":"pull_request","number":42}},"idempotency_key":"event_1:artifact"}',
          status: "success",
          error: null,
          recentItems: [],
        };
      }
      assert.match(input.prompt, /Desktop room tool result/);
      assert.match(input.prompt, /"ok": true/);
      assert.match(input.prompt, /github:pull_request:number:42/);
      return {
        sessionId: "cursor_session_1",
        text: "Artifact published in this local room.",
        status: "success",
        error: null,
        recentItems: [],
      };
    },
  }, { storage: localStorageState() });
  await runtime.start({
    providerId: "cursor",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
  });

  runtime.dispatchRoomStreamEvent(messageEvent());
  await runtime.waitForIdle();

  assert.equal(prompts.length, 2);
  assert.equal(prompts[1]?.cursorSessionId, "cursor_session_1");
  assert.deepEqual(published, [{ text: "Artifact published in this local room.", eventId: "msg_1" }]);
});

test("Cursor runtime runs multiple desktop room tools before publishing the final reply", async () => {
  resetState();
  const prompts: CursorTurnInput[] = [];
  const { runtime, published } = createRuntimeHarness({
    async runTurn(input: CursorTurnInput): Promise<CursorTurnResult> {
      prompts.push(input);
      if (prompts.length === 1) {
        return {
          sessionId: "cursor_session_1",
          text: 'LETAGENTS_ROOM_TOOL_REQUEST {"tool":"publish_room_artifact","arguments":{"artifact":{"provider":"github","kind":"pull_request","number":42}},"idempotency_key":"event_1:artifact"}',
          status: "success",
          error: null,
          recentItems: [],
        };
      }
      if (prompts.length === 2) {
        assert.match(input.prompt, /Desktop room tool result/);
        assert.match(input.prompt, /"ok": true/);
        assert.match(input.prompt, /github:pull_request:number:42/);
        return {
          sessionId: "cursor_session_1",
          text: 'LETAGENTS_ROOM_TOOL_REQUEST {"tool":"publish_room_artifact","arguments":{"artifact":{"provider":"github","kind":"pull_request","number":43}},"idempotency_key":"event_1:artifact_2"}',
          status: "success",
          error: null,
          recentItems: [],
        };
      }
      assert.match(input.prompt, /Desktop room tool result/);
      assert.match(input.prompt, /"ok": true/);
      assert.match(input.prompt, /github:pull_request:number:43/);
      return {
        sessionId: "cursor_session_1",
        text: "Both artifacts were published in this local room.",
        status: "success",
        error: null,
        recentItems: [],
      };
    },
  }, { storage: localStorageState() });
  await runtime.start({
    providerId: "cursor",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
  });

  runtime.dispatchRoomStreamEvent(messageEvent());
  await runtime.waitForIdle();

  assert.equal(prompts.length, 3);
  assert.equal(prompts[1]?.cursorSessionId, "cursor_session_1");
  assert.equal(prompts[2]?.cursorSessionId, "cursor_session_1");
  assert.deepEqual(published, [{ text: "Both artifacts were published in this local room.", eventId: "msg_1" }]);
});

test("Cursor runtime preempts an active event and redelivers the newer event with resume state", async () => {
  resetState();
  const calls: CursorTurnInput[] = [];
  const { runtime, published } = createRuntimeHarness({
    async runTurn(input: CursorTurnInput): Promise<CursorTurnResult> {
      calls.push(input);
      if (calls.length === 1) {
        return new Promise((resolve) => {
          input.abortController?.signal.addEventListener("abort", () => {
            resolve({
              sessionId: "cursor_session_1",
              text: null,
              status: "error",
              error: "interrupted by newer room event",
              recentItems: [{ type: "result", subtype: "interrupted" }],
            });
          }, { once: true });
        });
      }
      return {
        sessionId: "cursor_session_1",
        text: "Handling the newer event.",
        status: "success",
        error: null,
        recentItems: [{ type: "result", text: "Handling the newer event." }],
      };
    },
  });
  const started = await runtime.start({
    providerId: "cursor",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
  });

  const baseMessage = messageEvent().message;
  runtime.dispatchRoomStreamEvent(messageEvent({
    message: {
      ...baseMessage,
      id: "msg_1",
      text: "long read-only request",
    },
  }));
  while (calls.length < 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  runtime.dispatchRoomStreamEvent(messageEvent({
    message: {
      ...baseMessage,
      id: "msg_2",
      threadRootId: "msg_2",
      text: "newer urgent request",
    },
  }));
  await runtime.waitForIdle();

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.abortController?.signal.aborted, true);
  assert.equal(calls[0]?.cursorSessionId, null);
  assert.equal(calls[1]?.cursorSessionId, "cursor_session_1");
  assert.deepEqual(published, [{ text: "Handling the newer event.", eventId: "msg_2" }]);
  const stored = getStoredCursorLiveSession(started.session.id);
  assert.equal(stored?.cursor_session_id, "cursor_session_1");
  assert.equal(stored?.status, "completed");
  assert.equal(stored?.last_error, null);
  assert.equal(stored?.active_work, null);
});

test("Cursor runtime queues write-capable events instead of preempting active writes", async () => {
  resetState();
  const calls: CursorTurnInput[] = [];
  let finishFirstTurn: (() => void) | null = null;
  const { runtime, published } = createRuntimeHarness({
    async runTurn(input: CursorTurnInput): Promise<CursorTurnResult> {
      calls.push(input);
      if (calls.length === 1) {
        return new Promise((resolve) => {
          finishFirstTurn = () => resolve({
            sessionId: "cursor_session_write",
            text: "First write turn complete.",
            status: "success",
            error: null,
            recentItems: [{ type: "result", text: "First write turn complete." }],
          });
        });
      }
      return {
        sessionId: "cursor_session_write",
        text: "Second write turn complete.",
        status: "success",
        error: null,
        recentItems: [{ type: "result", text: "Second write turn complete." }],
      };
    },
  });
  const started = await runtime.start({
    providerId: "cursor",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
    permissionProfileId: "full_access",
  });

  const baseMessage = messageEvent().message;
  runtime.dispatchRoomStreamEvent(messageEvent({
    message: {
      ...baseMessage,
      id: "msg_1",
      text: "first write request",
    },
  }));
  while (calls.length < 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  runtime.dispatchRoomStreamEvent(messageEvent({
    message: {
      ...baseMessage,
      id: "msg_2",
      threadRootId: "msg_2",
      text: "second write request",
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.abortController?.signal.aborted, false);
  assert.ok(finishFirstTurn);
  (finishFirstTurn as () => void)();
  await runtime.waitForIdle();

  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.cursorSessionId, "cursor_session_write");
  assert.deepEqual(published, [
    { text: "First write turn complete.", eventId: "msg_1" },
    { text: "Second write turn complete.", eventId: "msg_2" },
  ]);
  const stored = getStoredCursorLiveSession(started.session.id);
  assert.equal(stored?.cursor_session_id, "cursor_session_write");
  assert.equal(stored?.status, "completed");
  assert.equal(stored?.last_error, null);
  assert.equal(stored?.active_work, null);
});

test("Cursor runtime stop interrupts the worker session and disconnects the room identity", async () => {
  resetState();
  let capturedAbort: AbortController | null = null;
  let abortObserved = false;
  const { runtime } = createRuntimeHarness({
    async runTurn(input: CursorTurnInput): Promise<CursorTurnResult> {
      capturedAbort = input.abortController ?? null;
      return new Promise((resolve) => {
        input.abortController?.signal.addEventListener("abort", () => {
          abortObserved = true;
          resolve({
            sessionId: "cursor_session_1",
            text: null,
            status: "error",
            error: "interrupted",
            recentItems: [],
          });
        }, { once: true });
      });
    },
  });
  const started = await runtime.start({
    providerId: "cursor",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
  });

  runtime.dispatchRoomStreamEvent(messageEvent());
  while (!capturedAbort) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const stopped = await runtime.stop({ sessionId: started.session.id });
  await runtime.waitForIdle();

  assert.ok(capturedAbort);
  assert.equal(stopped?.status, "interrupted");
  assert.equal(abortObserved, true);
  const stored = getStoredCursorLiveSession(started.session.id);
  assert.equal(stored?.status, "interrupted");
  assert.equal(stored?.active_work, null);
  assert.ok(getStoredAgentSession("agent_session_cursor")?.ended_at);
});

test("consecutive turn errors park the Cursor session as failed and end the worker", async () => {
  resetState();
  let turns = 0;
  const { runtime } = createRuntimeHarness({
    async runTurn(): Promise<CursorTurnResult> {
      turns += 1;
      return {
        sessionId: null,
        text: null,
        status: "error",
        error: "cursor-agent exploded",
        recentItems: [],
      };
    },
  });
  const started = await runtime.start({
    providerId: "cursor",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
  });

  for (const id of ["msg_e1", "msg_e2", "msg_e3"]) {
    runtime.dispatchRoomStreamEvent(messageEvent({
      message: { ...messageEvent().message, id, threadRootId: id },
    }));
    await runtime.waitForIdle();
  }

  const parked = getStoredCursorLiveSession(started.session.id);
  assert.equal(parked?.status, "failed");
  assert.match(parked?.last_error ?? "", /Stopped after 3 consecutive turn errors/);
  assert.ok(
    getStoredAgentSession("agent_session_cursor")?.ended_at,
    "parking must end the worker registration",
  );

  runtime.dispatchRoomStreamEvent(messageEvent({
    message: { ...messageEvent().message, id: "msg_e4", threadRootId: "msg_e4" },
  }));
  await runtime.waitForIdle();
  assert.equal(turns, 3, "failed sessions must not receive further room events");
});

test("Cursor usage-limit errors block immediately and publish one visible failure", async () => {
  resetState();
  let turns = 0;
  let quotaExhausted = true;
  const { runtime, failures, published } = createRuntimeHarness({
    async runTurn(): Promise<CursorTurnResult> {
      turns += 1;
      if (!quotaExhausted) {
        return {
          sessionId: "cursor_after_quota",
          text: "Reply after quota recovery.",
          status: "success",
          error: null,
          recentItems: [],
        };
      }
      return {
        sessionId: null,
        text: null,
        status: "error",
        error: "You've hit your usage limit. Switch models or set a Spend Limit to continue.",
        recentItems: [],
      };
    },
  });
  const started = await runtime.start({
    providerId: "cursor",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
  });

  runtime.dispatchRoomStreamEvent(messageEvent());
  await runtime.waitForIdle();

  const blocked = getStoredCursorLiveSession(started.session.id);
  assert.equal(blocked?.status, "blocked");
  assert.equal(blocked?.failure?.code, "quota_exhausted");
  assert.equal(blocked?.failure?.eventId, "msg_1");
  assert.deepEqual(failures, [{ code: "quota_exhausted", eventId: "msg_1" }]);

  runtime.dispatchRoomStreamEvent(messageEvent({
    message: { ...messageEvent().message, id: "msg_after_limit", threadRootId: "msg_after_limit" },
  }));
  await runtime.waitForIdle();
  assert.equal(turns, 1, "blocked sessions must not read subsequent room messages");
  assert.equal(getStoredCursorLiveSession(started.session.id)?.queued_events?.length, 1);

  quotaExhausted = false;
  const resumed = await runtime.retry({ sessionId: started.session.id });
  assert.equal(resumed?.status, "completed");
  await runtime.waitForIdle();
  assert.equal(getStoredCursorLiveSession(started.session.id)?.status, "completed");
  assert.equal(getStoredCursorLiveSession(started.session.id)?.failure, null);
  assert.equal(turns, 3, "retry must replay the failed message before draining messages queued while blocked");
  assert.deepEqual(published, [
    { text: "Reply after quota recovery.", eventId: "msg_1" },
    { text: "Reply after quota recovery.", eventId: "msg_after_limit" },
  ]);
});

test("no runtime network call escapes to the real API during this suite", () => {
  // The only outbound fetch these fixture-seeded sessions may make is the
  // managed-worker heartbeat/pause timer, which the guard intercepts locally.
  // Anything else (a real prod call) would be recorded here.
  assert.deepEqual(netGuard.escapedUrls(), []);
});
