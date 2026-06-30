import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempDir = mkdtempSync(join(tmpdir(), "letagents-claude-code-runtime-"));
process.env.LETAGENTS_STATE_PATH = join(tempDir, "mcp-state.json");

const {
  createDesktopClaudeCodeRuntime,
} = await import("../main/agents/claude-code-runtime.js");
const {
  buildClaudeCodeQueryOptions,
  claudeCodePreToolUseGuard,
  isBlockedClaudeCodeTool,
} = await import("../main/agents/claude-code-runner.js");
const {
  getStoredAgentSession,
  getStoredClaudeCodeLiveSession,
  saveAgentSession,
} = await import("../main/agents/state.js");

import type {
  DesktopAgentProviderPreflight,
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

function createRuntimeHarness(runner: ClaudeCodeRunner) {
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
    resolveStorage: async (roomIdentifier) => storageState(roomIdentifier),
    emitSessionUpdate: () => undefined,
    now: () => "2026-06-30T00:00:00.000Z",
  });
  return { runtime, published };
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
  assert.equal("allowedTools" in options, false);
  assert.equal(isBlockedClaudeCodeTool("mcp__letagents__send_message"), true);
  assert.equal(isBlockedClaudeCodeTool("mcp__letagents__rental_run_command"), true);
  assert.equal(isBlockedClaudeCodeTool("Read"), false);

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
  assert.equal(result.session.canStop, true);
  assert.equal(result.session.ideLabel, "Claude Code");
  assert.equal(runtime.listSessions("room_1").length, 1);

  const inspected = await runtime.inspect(result.session.id);
  assert.equal(inspected?.session.providerId, "claude-code");
  assert.equal(inspected?.serverReachable, true);
  assert.equal(inspected?.recentItems.length, 1);
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
  });

  runtime.dispatchRoomStreamEvent(messageEvent());
  await runtime.waitForIdle();

  assert.equal(prompts.length, 1);
  assert.match(prompts[0]?.prompt ?? "", /Desktop-delivered LetAgents room event/);
  assert.match(prompts[0]?.prompt ?? "", /Do not call LetAgents MCP room tools/);
  assert.equal(prompts[0]?.claudeSessionId, null);
  assert.deepEqual(published, [{ text: "I will check this.", eventId: "msg_1" }]);
  const stored = getStoredClaudeCodeLiveSession(started.session.id);
  assert.equal(stored?.claude_session_id, "claude_session_1");
  assert.equal(stored?.status, "completed");
  assert.equal(stored?.active_work, null);
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
