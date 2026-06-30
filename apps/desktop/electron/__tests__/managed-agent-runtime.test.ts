import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopManagedAgentRuntimeRegistry,
  type DesktopManagedAgentRuntime,
} from "../main/agents/managed-agent-runtime.js";
import type {
  DesktopManagedAgentInspectResult,
  DesktopManagedAgentSession,
  DesktopManagedAgentStartInput,
  DesktopManagedAgentStartResult,
  DesktopManagedAgentStopInput,
  DesktopRoomStreamEvent,
} from "../ipc-types.js";

function session(providerId = "codex"): DesktopManagedAgentSession {
  return {
    id: "session_1",
    providerId,
    runtime: providerId,
    roomIdentifier: "room_1",
    roomDisplayName: "Room One",
    repoRootPath: "/tmp/repo",
    repoBranch: "codex/git-rooms",
    status: "running",
    deliveryMode: "desktop_events",
    canStop: true,
    agentSessionId: "agent_session_1",
    actorLabel: "WarmGolden",
    agentKey: "codex/warm-golden",
    displayName: "WarmGolden",
    ownerLabel: "EmmyMay",
    ideLabel: "Codex",
    reasoningSessionId: null,
    activeWork: null,
    pendingPermissionRequests: [],
    startedAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    lastError: null,
  };
}

function stubRuntime(providerId = "codex"): DesktopManagedAgentRuntime & {
  events: DesktopRoomStreamEvent[];
  starts: DesktopManagedAgentStartInput[];
  inspections: Array<{ sessionId?: string | null; roomIdentifier?: string | null }>;
  stops: DesktopManagedAgentStopInput[];
  failDispatch: boolean;
} {
  const instance = {
    providerId,
    events: [] as DesktopRoomStreamEvent[],
    starts: [] as DesktopManagedAgentStartInput[],
    inspections: [] as Array<{ sessionId?: string | null; roomIdentifier?: string | null }>,
    stops: [] as DesktopManagedAgentStopInput[],
    failDispatch: false,
    listSessions: () => [session(providerId)],
    start: async (input: DesktopManagedAgentStartInput): Promise<DesktopManagedAgentStartResult> => {
      instance.starts.push(input);
      return { session: session(input.providerId), reused: false, message: "started" };
    },
    inspect: async (
      sessionId?: string | null,
      roomIdentifier?: string | null,
    ): Promise<DesktopManagedAgentInspectResult | null> => {
      instance.inspections.push({ sessionId, roomIdentifier });
      if (sessionId && sessionId !== `session_${providerId}`) {
        return null;
      }
      return {
        session: session(providerId),
        serverReachable: true,
        recentItems: [],
      };
    },
    stop: async (input: DesktopManagedAgentStopInput = {}): Promise<DesktopManagedAgentSession | null> => {
      instance.stops.push(input);
      if (input.sessionId && input.sessionId !== `session_${providerId}`) {
        return null;
      }
      return session(providerId);
    },
    dispatchRoomStreamEvent: (event: DesktopRoomStreamEvent) => {
      if (instance.failDispatch) {
        throw new Error(`${providerId} dispatch failed`);
      }
      instance.events.push(event);
    },
  };
  return instance;
}

test("registry starts the runtime matching the requested provider", async () => {
  const registry = new DesktopManagedAgentRuntimeRegistry();
  const codex = stubRuntime("codex");
  const claude = stubRuntime("claude-code");
  registry.register(codex);
  registry.register(claude);

  const result = await registry.start({
    providerId: "claude-code",
    roomIdentifier: "room_1",
    repoRootPath: "/tmp/repo",
  });

  assert.equal(result.session.providerId, "claude-code");
  assert.equal(codex.starts.length, 0);
  assert.equal(claude.starts.length, 1);
});

test("registry lists sessions from all registered runtimes", () => {
  const registry = new DesktopManagedAgentRuntimeRegistry();
  registry.register(stubRuntime("codex"));
  registry.register(stubRuntime("claude-code"));

  assert.deepEqual(
    registry.listSessions("room_1").map((entry) => entry.providerId),
    ["codex", "claude-code"]
  );
});

test("registry dispatches room stream events to every registered runtime", () => {
  const registry = new DesktopManagedAgentRuntimeRegistry();
  const codex = stubRuntime("codex");
  const claude = stubRuntime("claude-code");
  registry.register(codex);
  registry.register(claude);
  const event: DesktopRoomStreamEvent = {
    type: "message",
    roomIdentifier: "room_1",
    message: {
      id: "msg_1",
      sender: "EmmyMay",
      text: "hello",
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
  };

  registry.dispatchRoomStreamEvent(event);

  assert.equal(codex.events.length, 1);
  assert.equal(claude.events.length, 1);
});

test("registry isolates room stream dispatch failures by runtime", () => {
  const registry = new DesktopManagedAgentRuntimeRegistry();
  const codex = stubRuntime("codex");
  const claude = stubRuntime("claude-code");
  codex.failDispatch = true;
  registry.register(codex);
  registry.register(claude);
  const event: DesktopRoomStreamEvent = {
    type: "message",
    roomIdentifier: "room_1",
    message: {
      id: "msg_1",
      sender: "EmmyMay",
      text: "hello",
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
  };

  registry.dispatchRoomStreamEvent(event);

  assert.equal(codex.events.length, 0);
  assert.equal(claude.events.length, 1);
});

test("registry inspects the first runtime with a matching session", async () => {
  const registry = new DesktopManagedAgentRuntimeRegistry();
  const codex = stubRuntime("codex");
  const claude = stubRuntime("claude-code");
  registry.register(codex);
  registry.register(claude);

  const result = await registry.inspect("session_claude-code", "room_1");

  assert.equal(result?.session.providerId, "claude-code");
  assert.equal(codex.inspections.length, 1);
  assert.equal(claude.inspections.length, 1);
});

test("registry stops the first runtime with a matching session", async () => {
  const registry = new DesktopManagedAgentRuntimeRegistry();
  const codex = stubRuntime("codex");
  const claude = stubRuntime("claude-code");
  registry.register(codex);
  registry.register(claude);

  const result = await registry.stop({ sessionId: "session_claude-code" });

  assert.equal(result?.providerId, "claude-code");
  assert.equal(codex.stops.length, 1);
  assert.equal(claude.stops.length, 1);
});

test("registry rejects duplicate runtime providers", () => {
  const registry = new DesktopManagedAgentRuntimeRegistry();
  registry.register(stubRuntime("codex"));

  assert.throws(() => registry.register(stubRuntime("codex")), /already registered/);
});

test("registry rejects starts for providers without a desktop runtime", async () => {
  const registry = new DesktopManagedAgentRuntimeRegistry();
  registry.register(stubRuntime("codex"));

  await assert.rejects(
    registry.start({
      providerId: "claude-code",
      roomIdentifier: "room_1",
      repoRootPath: "/tmp/repo",
    }),
    /No desktop managed runtime registered for provider 'claude-code'/
  );
});
