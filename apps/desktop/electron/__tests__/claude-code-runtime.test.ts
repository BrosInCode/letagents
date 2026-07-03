import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempDir = mkdtempSync(join(tmpdir(), "letagents-claude-code-runtime-"));
process.env.LETAGENTS_STATE_PATH = join(tempDir, "mcp-state.json");
process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH = join(tempDir, "chat-storage.json");
process.env.LETAGENTS_LOCAL_CHAT_DB = join(tempDir, "local-chat.sqlite");
process.env.LETAGENTS_LOCAL_PROFILE_PATH = join(tempDir, "local-profile.json");

const {
  createDesktopClaudeCodeRuntime,
} = await import("../main/agents/claude-code-runtime.js");
const {
  buildClaudeCodeQueryOptions,
  claudeCodePreToolUseGuard,
  isAutoAllowedClaudeCodeTool,
  isBlockedClaudeCodeTool,
} = await import("../main/agents/claude-code-runner.js");
const {
  buildManagedAgentPermissionRoomText,
  createManagedAgentPermissionRequest,
  isAutoAllowedManagedAgentTool,
} = await import("../main/agents/managed-agent-permissions.js");
const {
  getStoredAgentSession,
  getStoredClaudeCodeLiveSession,
  saveAgentSession,
} = await import("../main/agents/state.js");

import type {
  DesktopAgentProviderPreflight,
  DesktopManagedAgentPermissionRequest,
  DesktopRoomStorageState,
  DesktopRoomStreamEvent,
} from "../ipc-types.js";
import type {
  ClaudeCodeRunner,
  ClaudeCodeTurnInput,
  ClaudeCodeTurnResult,
} from "../main/agents/claude-code-runner.js";
import type { StoredAgentSessionState } from "../main/agents/state.js";

test.after(() => {
  delete process.env.LETAGENTS_STATE_PATH;
  delete process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH;
  delete process.env.LETAGENTS_LOCAL_CHAT_DB;
  delete process.env.LETAGENTS_LOCAL_PROFILE_PATH;
  rmSync(tempDir, { recursive: true, force: true });
});

function resetState(state: Record<string, unknown> = {}): void {
  writeFileSync(process.env.LETAGENTS_STATE_PATH ?? "", `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function readyPreflight(): DesktopAgentProviderPreflight {
  return {
    providerId: "claude-code",
    status: "ready",
    canStart: true,
    message: "Claude Code is ready.",
    detail: null,
    nextAction: null,
    version: "2.1.70 (Claude Code)",
    mcpStatus: "not_installed",
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

function messageEvent(
  overrides: Partial<Extract<DesktopRoomStreamEvent, { type: "message" }>> = {},
): Extract<DesktopRoomStreamEvent, { type: "message" }> {
  return {
    type: "message",
    roomIdentifier: "room_1",
    message: {
      id: "msg_1",
      sender: "EmmyMay",
      text: "please check this",
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
    session_id: "agent_session_claude",
    session_token: "agent_session_token",
    room_id: input.roomIdentifier,
    session_kind: "worker",
    runtime: `claude-code:${input.token}`,
    host_id: "host_1",
    host_kind: "macos",
    host_label: "LetAgents Desktop",
    liveness_capability: "desktop_supervised_claude_code_sdk",
    tool_bridge_id: `host_1:claude-code:${input.token}:desktop:${input.token}`,
    actor_label: `${input.displayName} | EmmyMay's agent | Claude Code`,
    agent_key: "EmmyMay/claude-code-worker",
    agent_instance_id: `desktop-claude-code:${input.token}`,
    display_name: input.displayName,
    owner_label: "EmmyMay",
    ide_label: "Claude Code",
    repo_branch: input.repoBranch,
    created_at: "2026-06-30T00:00:00.000Z",
    updated_at: "2026-06-30T00:00:00.000Z",
    last_seen_at: "2026-06-30T00:00:00.000Z",
    ended_at: null,
  });
}

function createRuntimeHarness(
  runner: ClaudeCodeRunner,
  options: {
    publishPermissionRequest?: (input: {
      request: DesktopManagedAgentPermissionRequest;
    }) => Promise<{ roomMessageId: string | null }>;
    permissionTimeoutMs?: number;
    storage?: DesktopRoomStorageState;
  } = {},
) {
  const published: Array<{ text: string | null; eventId: string }> = [];
  const runtime = createDesktopClaudeCodeRuntime({
    runner,
    preflight: async () => readyPreflight(),
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
    publishPermissionRequest: options.publishPermissionRequest,
    resolveStorage: async (roomIdentifier) => options.storage ?? storageState(roomIdentifier),
    emitSessionUpdate: () => undefined,
    permissionTimeoutMs: options.permissionTimeoutMs,
    now: () => "2026-06-30T00:00:00.000Z",
  });
  return { runtime, published };
}

async function waitFor<T>(
  getter: () => T | null | undefined,
  label: string,
  timeoutMs = 1_000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = getter();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function assertClaudeCliPermissionResult(
  decision: { toolUseID?: string; updatedInput?: Record<string, unknown> } | null | undefined,
  toolUseID: string,
  options: { updatedInput?: Record<string, unknown> } = {},
): void {
  assert.ok(decision);
  assert.equal("decisionClassification" in decision, false);
  assert.equal(decision.toolUseID, toolUseID);
  if ("updatedInput" in options) {
    assert.deepEqual(decision.updatedInput, options.updatedInput);
  }
}

test("Claude Code runner options lock down ambient MCP and blocked room tools", async () => {
  const abortController = new AbortController();
  const options = buildClaudeCodeQueryOptions({
    prompt: "hello",
    cwd: tempDir,
    claudeSessionId: "claude_session_1",
    claudeBin: "/usr/local/bin/claude",
    abortController,
  });

  assert.equal(options.permissionMode, "default");
  assert.equal(options.allowDangerouslySkipPermissions, undefined);
  assert.equal(options.abortController, undefined);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.resume, "claude_session_1");
  assert.equal(options.pathToClaudeCodeExecutable, "/usr/local/bin/claude");
  assert.ok(options.disallowedTools?.includes("rental_run_command"));
  assert.ok(options.disallowedTools?.includes("send_message"));
  assert.ok(options.disallowedTools?.includes("post_reasoning"));
  assert.ok(options.disallowedTools?.includes("get_board"));
  assert.ok(options.disallowedTools?.includes("create_board_intent"));
  assert.ok(options.disallowedTools?.includes("get_room_artifacts"));
  assert.equal("allowedTools" in options, false);
  assert.equal(typeof options.canUseTool, "function");
  assert.equal(isBlockedClaudeCodeTool("mcp__letagents__send_message"), true);
  assert.equal(isBlockedClaudeCodeTool("mcp__letagents__get_board"), true);
  assert.equal(isBlockedClaudeCodeTool("mcp__letagents__post_reasoning"), true);
  assert.equal(isBlockedClaudeCodeTool("mcp__letagents__rental_run_command"), true);
  assert.equal(isBlockedClaudeCodeTool("Read"), false);
  assert.equal(isAutoAllowedClaudeCodeTool("Read"), true);
  assert.equal(isAutoAllowedClaudeCodeTool("mcp__other__Read"), false);
  assert.equal(isAutoAllowedManagedAgentTool("custom__grep"), false);
  const autoAllowed = await options.canUseTool?.("Read", { file_path: "/tmp/README.md" }, {
    signal: abortController.signal,
    toolUseID: "tool_read",
  });
  assert.equal(autoAllowed?.behavior, "allow");
  assertClaudeCliPermissionResult(autoAllowed, "tool_read", {
    updatedInput: { file_path: "/tmp/README.md" },
  });
  const defaultDenied = await options.canUseTool?.("Bash", { command: "touch file" }, {
    signal: abortController.signal,
    toolUseID: "tool_bash",
    title: "Run shell command",
  });
  assert.equal(defaultDenied?.behavior, "deny");
  assertClaudeCliPermissionResult(defaultDenied, "tool_bash");
  const blockedDenied = await options.canUseTool?.("mcp__letagents__send_message", { text: "nope" }, {
    signal: abortController.signal,
    toolUseID: "tool_room",
  });
  assert.equal(blockedDenied?.behavior, "deny");
  assertClaudeCliPermissionResult(blockedDenied, "tool_room");

  const denied = await claudeCodePreToolUseGuard({
    hook_event_name: "PreToolUse",
    tool_name: "mcp__letagents__send_message",
    tool_input: { text: "nope" },
    tool_use_id: "tool_1",
    session_id: "claude_session_1",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: tempDir,
  } as never, "tool_1", { signal: abortController.signal });
  const deniedOutput = denied as {
    decision?: string;
    hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string };
  };
  assert.equal(deniedOutput.decision, "block");
  assert.equal(deniedOutput.hookSpecificOutput?.hookEventName, "PreToolUse");
  assert.equal(
    deniedOutput.hookSpecificOutput?.hookEventName === "PreToolUse"
      ? deniedOutput.hookSpecificOutput.permissionDecision
      : null,
    "deny",
  );

  const deferred = await claudeCodePreToolUseGuard({
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "/tmp/README.md" },
    tool_use_id: "tool_2",
    session_id: "claude_session_1",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: tempDir,
  } as never, "tool_2", { signal: abortController.signal });
  const deferredOutput = deferred as {
    hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string };
  };
  assert.equal(
    deferredOutput.hookSpecificOutput?.hookEventName === "PreToolUse"
      ? deferredOutput.hookSpecificOutput.permissionDecision
      : null,
    "defer",
  );
});

test("Claude Code runner options pass selected model and effort, and omit provider defaults", () => {
  const selectedOptions = buildClaudeCodeQueryOptions({
    prompt: "hello",
    cwd: tempDir,
    model: "  sonnet  ",
    effort: "high",
  });
  assert.equal(selectedOptions.model, "sonnet");
  assert.equal(selectedOptions.effort, "high");

  const defaultOptions = buildClaudeCodeQueryOptions({
    prompt: "hello",
    cwd: tempDir,
  });
  assert.equal(defaultOptions.model, undefined);
  assert.equal(defaultOptions.effort, undefined);
});

test("Claude Code runtime starts, lists, and inspects a desktop-managed worker", async () => {
  resetState();
  const { runtime } = createRuntimeHarness({
    async runTurn(): Promise<ClaudeCodeTurnResult> {
      throw new Error("runTurn should not be called during start");
    },
  });

  const result = await runtime.start({
    providerId: "claude-code",
    roomIdentifier: "room_1",
    roomDisplayName: "Room One",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
  });

  assert.equal(result.session.providerId, "claude-code");
  assert.equal(result.session.status, "completed");
  assert.equal(result.session.deliveryMode, "desktop_events");
  assert.equal(result.session.permissionProfileId, "ask_before_write");
  assert.equal(result.session.permissionProfile.label, "Ask before writes");
  assert.equal(result.session.canStop, true);
  assert.equal(result.session.ideLabel, "Claude Code");
  assert.equal(runtime.listSessions("room_1").length, 1);

  const inspected = await runtime.inspect(result.session.id);
  assert.equal(inspected?.session.providerId, "claude-code");
  assert.equal(inspected?.serverReachable, true);
  assert.equal(inspected?.recentItems.length, 1);
  assert.equal(getStoredClaudeCodeLiveSession(result.session.id)?.permission_profile_id, "ask_before_write");
});

test("Claude Code runtime starts in a local room without cloud worker registration", async () => {
  resetState();
  const { createLocalRoom } = await import("../main/rooms/local-store.js");
  const roomIdentifier = "local_claude_start";
  await createLocalRoom({
    roomIdentifier,
    displayName: "HZLocal",
  });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    fetchCalls += 1;
    throw new Error("local room start/stop should not call the cloud API");
  }) as typeof fetch;
  const runtime = createDesktopClaudeCodeRuntime({
    runner: {
      async runTurn(): Promise<ClaudeCodeTurnResult> {
        throw new Error("runTurn should not be called during start");
      },
    },
    preflight: async () => readyPreflight(),
    emitSessionUpdate: () => undefined,
    now: () => "2026-06-30T00:00:00.000Z",
  });

  try {
    const result = await runtime.start({
      providerId: "claude-code",
      roomIdentifier,
      roomDisplayName: "HZLocal",
      repoRootPath: tempDir,
      deliveryMode: "desktop_events",
      permissionProfileId: "full_access",
    });
    const workerSession = getStoredAgentSession(result.session.agentSessionId);

    assert.equal(result.session.roomIdentifier, roomIdentifier);
    assert.equal(result.session.status, "completed");
    assert.equal(result.session.permissionProfileId, "full_access");
    assert.ok(result.session.agentSessionId?.startsWith("local_agent_session_"));
    assert.equal(workerSession?.room_id, roomIdentifier);
    assert.match(workerSession?.session_token ?? "", /^local_agent_token_/);
    assert.equal(workerSession?.ide_label, "Claude Code");
    assert.ok(workerSession?.owner_label);
    assert.match(workerSession?.agent_key ?? "", /^local\/.+\/claude-code\//);

    await runtime.stop({ sessionId: result.session.id });
    assert.ok(getStoredAgentSession(result.session.agentSessionId)?.ended_at);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Claude Code runtime applies read-only and full-access permission profiles", async () => {
  resetState();
  let observedReadOnly: string | null = null;
  let publishPermissionCalls = 0;
  const readOnlyHarness = createRuntimeHarness({
    async runTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
      const decision = await input.canUseTool!("Bash", { command: "touch file" }, {
        signal: new AbortController().signal,
        toolUseID: "tool_write",
        title: "Run write command",
      });
      observedReadOnly = decision.behavior;
      assertClaudeCliPermissionResult(decision, "tool_write");
      return {
        sessionId: "claude_session_readonly",
        text: "Read-only profile checked.",
        status: "success",
        error: null,
        recentItems: [{ type: "result", text: "Read-only profile checked." }],
      };
    },
  }, {
    publishPermissionRequest: async () => {
      publishPermissionCalls += 1;
      return { roomMessageId: "msg_perm" };
    },
  });
  const readOnlyStarted = await readOnlyHarness.runtime.start({
    providerId: "claude-code",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
    permissionProfileId: "read_only",
  });
  readOnlyHarness.runtime.dispatchRoomStreamEvent(messageEvent());
  await readOnlyHarness.runtime.waitForIdle();
  assert.equal(readOnlyStarted.session.permissionProfileId, "read_only");
  assert.equal(observedReadOnly, "deny");
  assert.equal(publishPermissionCalls, 0);

  resetState();
  let observedFullAccess: string | null = null;
  const fullAccessHarness = createRuntimeHarness({
    async runTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
      const decision = await input.canUseTool!("Bash", { command: "npm test" }, {
        signal: new AbortController().signal,
        toolUseID: "tool_bash",
        title: "Run tests",
      });
      observedFullAccess = decision.behavior;
      assertClaudeCliPermissionResult(decision, "tool_bash", {
        updatedInput: { command: "npm test" },
      });
      return {
        sessionId: "claude_session_full",
        text: "Full access profile checked.",
        status: "success",
        error: null,
        recentItems: [{ type: "result", text: "Full access profile checked." }],
      };
    },
  }, {
    publishPermissionRequest: async () => {
      throw new Error("full access should not create a permission request");
    },
  });
  const fullAccessStarted = await fullAccessHarness.runtime.start({
    providerId: "claude-code",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
    permissionProfileId: "full_access",
  });
  fullAccessHarness.runtime.dispatchRoomStreamEvent(messageEvent());
  await fullAccessHarness.runtime.waitForIdle();
  assert.equal(fullAccessStarted.session.permissionProfileId, "full_access");
  assert.equal(observedFullAccess, "allow");
});

test("Claude Code runtime delivers room events into the SDK runner and persists resume state", async () => {
  resetState();
  const prompts: ClaudeCodeTurnInput[] = [];
  const { runtime, published } = createRuntimeHarness({
    async runTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
      prompts.push(input);
      return {
        sessionId: "claude_session_1",
        text: "I will check this.",
        status: "success",
        error: null,
        recentItems: [{ type: "result", text: "I will check this." }],
      };
    },
  });
  const started = await runtime.start({
    providerId: "claude-code",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
    model: "sonnet",
    modelSource: "known",
    effort: "high",
  });

  runtime.dispatchRoomStreamEvent(messageEvent());
  await runtime.waitForIdle();

  assert.equal(prompts.length, 1);
  assert.equal(started.session.model, "sonnet");
  assert.equal(started.session.effort, "high");
  assert.equal(getStoredClaudeCodeLiveSession(started.session.id)?.effort, "high");
  assert.equal(prompts[0]?.model, "sonnet");
  assert.equal(prompts[0]?.effort, "high");
  assert.match(prompts[0]?.prompt ?? "", /Desktop-delivered LetAgents room event/);
  assert.match(prompts[0]?.prompt ?? "", /Do not call raw LetAgents MCP room tools/);
  assert.match(prompts[0]?.prompt ?? "", /LETAGENTS_ROOM_TOOL_REQUEST/);
  assert.equal(prompts[0]?.claudeSessionId, null);
  assert.deepEqual(published, [{ text: "I will check this.", eventId: "msg_1" }]);
  const stored = getStoredClaudeCodeLiveSession(started.session.id);
  assert.equal(stored?.model, "sonnet");
  assert.equal(stored?.claude_session_id, "claude_session_1");
  assert.equal(stored?.status, "completed");
  assert.equal(stored?.active_work, null);
});

test("Claude Code runtime feeds desktop room tool results back into the SDK runner", async () => {
  resetState();
  const prompts: ClaudeCodeTurnInput[] = [];
  const { runtime, published } = createRuntimeHarness({
    async runTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
      prompts.push(input);
      if (prompts.length === 1) {
        return {
          sessionId: "claude_session_1",
          text: 'LETAGENTS_ROOM_TOOL_REQUEST {"tool":"publish_room_artifact","arguments":{"artifact":{"provider":"github","kind":"pull_request","number":42}},"idempotency_key":"event_1:artifact"}',
          status: "success",
          error: null,
          recentItems: [],
        };
      }
      assert.match(input.prompt, /Desktop room tool result/);
      assert.match(input.prompt, /unsupported_local_room_tool/);
      return {
        sessionId: "claude_session_1",
        text: "Artifact publishing is not available in this local room.",
        status: "success",
        error: null,
        recentItems: [],
      };
    },
  }, { storage: localStorageState() });
  await runtime.start({
    providerId: "claude-code",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
  });

  runtime.dispatchRoomStreamEvent(messageEvent());
  await runtime.waitForIdle();

  assert.equal(prompts.length, 2);
  assert.equal(prompts[1]?.claudeSessionId, "claude_session_1");
  assert.deepEqual(published, [{ text: "Artifact publishing is not available in this local room.", eventId: "msg_1" }]);
});

test("Claude Code runtime runs multiple desktop room tools before publishing the final reply", async () => {
  resetState();
  const prompts: ClaudeCodeTurnInput[] = [];
  const { runtime, published } = createRuntimeHarness({
    async runTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
      prompts.push(input);
      if (prompts.length === 1) {
        return {
          sessionId: "claude_session_1",
          text: 'LETAGENTS_ROOM_TOOL_REQUEST {"tool":"publish_room_artifact","arguments":{"artifact":{"provider":"github","kind":"pull_request","number":42}},"idempotency_key":"event_1:artifact"}',
          status: "success",
          error: null,
          recentItems: [],
        };
      }
      if (prompts.length === 2) {
        assert.match(input.prompt, /Desktop room tool result/);
        assert.match(input.prompt, /unsupported_local_room_tool/);
        return {
          sessionId: "claude_session_1",
          text: 'LETAGENTS_ROOM_TOOL_REQUEST {"tool":"publish_room_artifact","arguments":{"artifact":{"provider":"github","kind":"pull_request","number":43}},"idempotency_key":"event_1:artifact_2"}',
          status: "success",
          error: null,
          recentItems: [],
        };
      }
      assert.match(input.prompt, /Desktop room tool result/);
      assert.match(input.prompt, /unsupported_local_room_tool/);
      return {
        sessionId: "claude_session_1",
        text: "Both artifact attempts hit the local-room limitation.",
        status: "success",
        error: null,
        recentItems: [],
      };
    },
  }, { storage: localStorageState() });
  await runtime.start({
    providerId: "claude-code",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
  });

  runtime.dispatchRoomStreamEvent(messageEvent());
  await runtime.waitForIdle();

  assert.equal(prompts.length, 3);
  assert.equal(prompts[1]?.claudeSessionId, "claude_session_1");
  assert.equal(prompts[2]?.claudeSessionId, "claude_session_1");
  assert.deepEqual(published, [{ text: "Both artifact attempts hit the local-room limitation.", eventId: "msg_1" }]);
});

test("Claude Code runtime surfaces tool permission requests for desktop approval", async () => {
  resetState();
  const permissionRequests: DesktopManagedAgentPermissionRequest[] = [];
  let runtime!: ReturnType<typeof createRuntimeHarness>["runtime"];
  let observedDecision: string | null = null;
  const harness = createRuntimeHarness({
    async runTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
      assert.equal(typeof input.canUseTool, "function");
      const permission = input.canUseTool!("Bash", { command: "npm test" }, {
        signal: new AbortController().signal,
        toolUseID: "tool_bash",
        title: "Run npm test",
        displayName: "Run command",
        description: "Claude Code wants to run the project test command.",
      });
      const request = await waitFor(() => permissionRequests[0], "permission request");
      const listed = runtime.listSessions("room_1")[0];
      assert.equal(listed?.pendingPermissionRequests.length, 1);
      assert.equal(listed?.pendingPermissionRequests[0]?.id, request.id);
      const result = await runtime.resolvePermissionRequest({
        requestId: request.id,
        sessionId: listed?.id,
        behavior: "allow",
      });
      assert.equal(result.accepted, true);
      const decision = await permission;
      observedDecision = decision.behavior;
      assert.equal("updatedPermissions" in decision, false);
      assertClaudeCliPermissionResult(decision, "tool_bash", {
        updatedInput: { command: "npm test" },
      });
      return {
        sessionId: "claude_session_1",
        text: "Tests are approved to run.",
        status: "success",
        error: null,
        recentItems: [{ type: "result", text: "Tests are approved to run." }],
      };
    },
  }, {
    publishPermissionRequest: async (input) => {
      permissionRequests.push(input.request);
      return { roomMessageId: "msg_perm_1" };
    },
  });
  runtime = harness.runtime;
  const started = await runtime.start({
    providerId: "claude-code",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
  });

  runtime.dispatchRoomStreamEvent(messageEvent());
  await runtime.waitForIdle();

  assert.equal(observedDecision, "allow");
  assert.deepEqual(harness.published, [{ text: "Tests are approved to run.", eventId: "msg_1" }]);
  const stored = getStoredClaudeCodeLiveSession(started.session.id);
  assert.equal(stored?.pending_permission_requests?.length, 0);
  assert.equal(stored?.status, "completed");
});

test("Claude Code runtime ignores room permission replies without interrupting the turn", async () => {
  resetState();
  const permissionRequests: DesktopManagedAgentPermissionRequest[] = [];
  const calls: ClaudeCodeTurnInput[] = [];
  let permissionSettled = false;
  let runtime!: ReturnType<typeof createRuntimeHarness>["runtime"];
  const harness = createRuntimeHarness({
    async runTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
      calls.push(input);
      const permission = input.canUseTool!("Bash", { command: "npm run build" }, {
        signal: new AbortController().signal,
        toolUseID: "tool_build",
        title: "Run build",
      });
      permission.finally(() => {
        permissionSettled = true;
      }).catch(() => undefined);
      const request = await waitFor(() => permissionRequests[0], "permission request");
      const baseMessage = messageEvent().message;
      runtime.dispatchRoomStreamEvent(messageEvent({
        message: {
          ...baseMessage,
          id: "msg_room_approval",
          sender: "EmmyMay",
          text: `approve ${request.id}`,
          timestamp: "2026-06-30T00:00:01.000Z",
        },
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(permissionSettled, false);
      assert.equal(calls.length, 1);
      const listed = runtime.listSessions("room_1")[0];
      assert.equal(listed?.pendingPermissionRequests.length, 1);
      const result = await runtime.resolvePermissionRequest({
        requestId: request.id,
        sessionId: listed?.id,
        behavior: "deny",
        message: "Owner denied.",
      });
      assert.equal(result.accepted, true);
      const decision = await permission;
      assert.equal(decision.behavior, "deny");
      assertClaudeCliPermissionResult(decision, "tool_build");
      return {
        sessionId: "claude_session_1",
        text: "Build was not run.",
        status: "success",
        error: null,
        recentItems: [{ type: "result", text: "Build was not run." }],
      };
    },
  }, {
    publishPermissionRequest: async (input) => {
      permissionRequests.push(input.request);
      return { roomMessageId: "msg_perm_room" };
    },
  });
  runtime = harness.runtime;
  await runtime.start({
    providerId: "claude-code",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
  });

  runtime.dispatchRoomStreamEvent(messageEvent());
  await runtime.waitForIdle();

  assert.equal(calls.length, 1);
  assert.deepEqual(harness.published, [{ text: "Build was not run.", eventId: "msg_1" }]);
});

test("Claude Code runtime ignores implicit room permission replies without preempting the active turn", async () => {
  resetState();
  const permissionRequests: DesktopManagedAgentPermissionRequest[] = [];
  const calls: ClaudeCodeTurnInput[] = [];
  let runtime!: ReturnType<typeof createRuntimeHarness>["runtime"];
  const harness = createRuntimeHarness({
    async runTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
      calls.push(input);
      const permission = input.canUseTool!("Bash", { command: "npm run build" }, {
        signal: new AbortController().signal,
        toolUseID: "tool_build",
        title: "Run build",
      });
      let permissionSettled = false;
      permission.finally(() => {
        permissionSettled = true;
      }).catch(() => undefined);
      const request = await waitFor(() => permissionRequests[0], "permission request");
      const baseMessage = messageEvent().message;
      runtime.dispatchRoomStreamEvent(messageEvent({
        message: {
          ...baseMessage,
          id: "msg_approval",
          sender: "EmmyMay",
          text: "approve",
          replyTo: {
            id: "msg_perm_room",
            sender: "WarmGolden",
            text: "Permission request",
            source: "agent",
            timestamp: "2026-06-30T00:00:00.500Z",
          },
          timestamp: "2026-06-30T00:00:01.000Z",
        },
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(permissionSettled, false);
      assert.equal(calls.length, 1);
      const listed = runtime.listSessions("room_1")[0];
      const result = await runtime.resolvePermissionRequest({
        requestId: request.id,
        sessionId: listed?.id,
        behavior: "allow",
      });
      assert.equal(result.accepted, true);
      const decision = await permission;
      assert.equal(decision.behavior, "allow");
      assertClaudeCliPermissionResult(decision, "tool_build", {
        updatedInput: { command: "npm run build" },
      });
      return {
        sessionId: "claude_session_1",
        text: "Build permission approved.",
        status: "success",
        error: null,
        recentItems: [{ type: "result", text: "Build permission approved." }],
      };
    },
  }, {
    publishPermissionRequest: async (input) => {
      permissionRequests.push(input.request);
      return { roomMessageId: "msg_perm_room" };
    },
  });
  runtime = harness.runtime;
  await runtime.start({
    providerId: "claude-code",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
  });

  runtime.dispatchRoomStreamEvent(messageEvent());
  await runtime.waitForIdle();

  assert.equal(calls.length, 1);
  assert.deepEqual(harness.published, [{ text: "Build permission approved.", eventId: "msg_1" }]);
});

test("Claude Code runtime preempts an active event and redelivers the newer event with resume state", async () => {
  resetState();
  const calls: ClaudeCodeTurnInput[] = [];
  const { runtime, published } = createRuntimeHarness({
    async runTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
      calls.push(input);
      if (calls.length === 1) {
        return new Promise((resolve) => {
          input.abortController?.signal.addEventListener("abort", () => {
            resolve({
              sessionId: "claude_session_1",
              text: null,
              status: "error",
              error: "interrupted by newer room event",
              recentItems: [{ type: "result", subtype: "error_during_execution" }],
            });
          }, { once: true });
        });
      }
      return {
        sessionId: "claude_session_1",
        text: "Handling the newer event.",
        status: "success",
        error: null,
        recentItems: [{ type: "result", text: "Handling the newer event." }],
      };
    },
  });
  const started = await runtime.start({
    providerId: "claude-code",
    roomIdentifier: "room_1",
    repoRootPath: tempDir,
    deliveryMode: "desktop_events",
  });

  const baseMessage = messageEvent().message;
  runtime.dispatchRoomStreamEvent(messageEvent({
    message: {
      ...baseMessage,
      id: "msg_1",
      text: "long running request",
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
  assert.equal(calls[0]?.claudeSessionId, null);
  assert.equal(calls[1]?.claudeSessionId, "claude_session_1");
  assert.deepEqual(published, [{ text: "Handling the newer event.", eventId: "msg_2" }]);
  const stored = getStoredClaudeCodeLiveSession(started.session.id);
  assert.equal(stored?.claude_session_id, "claude_session_1");
  assert.equal(stored?.status, "completed");
  assert.equal(stored?.last_error, null);
  assert.equal(stored?.active_work, null);
});

test("managed agent permission room text omits raw ids and redacts secret command details", () => {
  const request = createManagedAgentPermissionRequest({
    providerId: "claude-code",
    sessionId: "session_1",
    toolName: "Bash",
    toolInput: {
      command:
        "curl -H 'Authorization: Bearer token_123' https://user:pass@example.com/deploy?token=secret --password=s3cr3t",
    },
    toolUseId: "tool_bash",
    title: "Run deploy command",
    requestedAt: "2026-06-30T00:00:00.000Z",
  });
  const text = buildManagedAgentPermissionRoomText({
    request,
    agentDisplayName: "WarmGolden",
  });

  assert.equal(request.id.startsWith("perm_"), true);
  assert.doesNotMatch(text, new RegExp(request.id));
  assert.doesNotMatch(text, /approve perm_|deny perm_/i);
  assert.doesNotMatch(text, /token_123|secret|s3cr3t|user:pass/i);
  assert.match(text, /approval controls near the message composer/);
  assert.doesNotMatch(text, /Use the local agent detail modal to allow or deny/);
  assert.match(request.inputSummary ?? "", /Authorization: Bearer \[redacted\]/);
  assert.match(request.inputSummary ?? "", /token=\[redacted\]/);
  assert.match(request.inputSummary ?? "", /--password=\[redacted\]/);
});

test("Claude Code runtime stop interrupts the worker session and disconnects the room identity", async () => {
  resetState();
  let capturedAbort: AbortController | null = null;
  let abortObserved = false;
  const { runtime } = createRuntimeHarness({
    async runTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
      capturedAbort = input.abortController ?? null;
      return new Promise((resolve) => {
        input.abortController?.signal.addEventListener("abort", () => {
          abortObserved = true;
          resolve({
            sessionId: "claude_session_1",
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
    providerId: "claude-code",
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
  const stored = getStoredClaudeCodeLiveSession(started.session.id);
  assert.equal(stored?.status, "interrupted");
  assert.equal(stored?.active_work, null);
  assert.ok(getStoredAgentSession("agent_session_claude")?.ended_at);
});
