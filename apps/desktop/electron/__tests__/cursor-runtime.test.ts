import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempDir = mkdtempSync(join(tmpdir(), "letagents-cursor-runtime-"));
process.env.LETAGENTS_STATE_PATH = join(tempDir, "mcp-state.json");
const cursorSourceHome = join(tempDir, "cursor-source-home");
mkdirSync(join(cursorSourceHome, ".cursor"), { recursive: true });
writeFileSync(join(cursorSourceHome, ".cursor", "mcp.json"), '{"mcpServers":{"filesystem":{"command":"npx"}}}\n');
process.env.LETAGENTS_CURSOR_SOURCE_HOME = cursorSourceHome;

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
  DesktopRoomStorageState,
  DesktopRoomStreamEvent,
} from "../ipc-types.js";
import type {
  CursorRunner,
  CursorTurnInput,
  CursorTurnResult,
} from "../main/agents/cursor-runner.js";
import type { StoredAgentSessionState } from "../main/agents/state.js";

test.after(() => {
  delete process.env.LETAGENTS_STATE_PATH;
  delete process.env.LETAGENTS_CURSOR_SOURCE_HOME;
  rmSync(tempDir, { recursive: true, force: true });
});

function resetState(state: Record<string, unknown> = {}): void {
  writeFileSync(process.env.LETAGENTS_STATE_PATH ?? "", `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

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

function createRuntimeHarness(runner: CursorRunner) {
  const published: Array<{ text: string | null; eventId: string }> = [];
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
    resolveStorage: async (roomIdentifier) => storageState(roomIdentifier),
    emitSessionUpdate: () => undefined,
    now: () => "2026-06-30T00:00:00.000Z",
  });
  return { runtime, published, preflightInputs };
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
  assert.equal(preflightInputs[0]?.cursorMcpPolicy, "filter_letagents");
  await assert.rejects(
    () => runtime.start({
      providerId: "cursor",
      roomIdentifier: "room_1",
      roomDisplayName: "Room One",
      repoRootPath: tempDir,
      deliveryMode: "desktop_events",
      permissionProfileId: "full_access",
    }),
    /Full access is not available for cursor/,
  );
});

test("Cursor runtime persists selected MCP policy and reuses it for event turns", async () => {
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
  });
  runtime.dispatchRoomStreamEvent(messageEvent());
  await runtime.waitForIdle();

  assert.equal(started.session.cursorMcpPolicy, "normal");
  assert.equal(getStoredCursorLiveSession(started.session.id)?.cursor_mcp_policy, "normal");
  assert.equal(preflightInputs[0]?.cursorMcpPolicy, "normal");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.env, {});
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
  assert.equal(prompts[0]?.env?.HOME, join(tempDir, "cursor-managed", "home"));
  assert.equal(prompts[0]?.env?.CURSOR_CONFIG_DIR, join(tempDir, "cursor-managed", "config", "cursor"));
  assert.equal(prompts[0]?.env?.CURSOR_DATA_DIR, join(tempDir, "cursor-managed", "data", "cursor"));
  assert.match(prompts[0]?.prompt ?? "", /Cursor read-only prototype/);
  assert.match(prompts[0]?.prompt ?? "", /Do not call LetAgents MCP room tools/);
  assert.match(prompts[0]?.prompt ?? "", /must not edit files/);
  assert.equal(prompts[0]?.cursorSessionId, null);
  assert.deepEqual(published, [{ text: "I can inspect this in read-only mode.", eventId: "msg_1" }]);
  const stored = getStoredCursorLiveSession(started.session.id);
  assert.equal(stored?.cursor_session_id, "cursor_session_1");
  assert.equal(stored?.status, "completed");
  assert.equal(stored?.active_work, null);
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
