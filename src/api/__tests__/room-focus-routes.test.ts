import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomFocusRoutes, toFocusRoomListResponse } = await import("../routes/rooms/focus.js");
const { QUICK_FOCUS_ROOM_CONCLUSION_SUMMARY } = await import("../focus-rooms/conclusion.js");
import type { GitRoomBinding, Project, Task } from "../db.js";

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    getFocusRoomByKey: unused,
    getTaskById: unused,
    getTaskOwnershipState: unused,
    concludeFocusRoom: unused,
    resolveCanonicalRoomRequestId: unused,
    resolveRoomOrReply: unused,
    requireParticipant: unused,
    requireAdmin: unused,
    resolveProjectRole: unused,
    toRoomResponse: () => ({}),
    normalizeOptionalString: () => null,
    enforceFocusRoomConclusion: unused,
    emitProjectMessage: unused,
    formatFocusRoomConclusionMessage: () => "",
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "github.com/owner/repo",
    code: null,
    display_name: "Repo Room",
    name: "github.com/owner/repo",
    kind: "main",
    parent_room_id: null,
    focus_key: null,
    source_task_id: null,
    focus_status: null,
    focus_parent_visibility: null,
    focus_activity_scope: null,
    focus_github_event_routing: null,
    focus_archived_at: null,
    concluded_at: null,
    conclusion_summary: null,
    conclusion_details: null,
    created_at: "2026-06-28T10:00:00.000Z",
    ...overrides,
  };
}

function gitRoomBinding(roomId: string): GitRoomBinding {
  return {
    room_id: roomId,
    provider: "github",
    host: "github.com",
    repository_id: "1",
    repository_full_name: "BrosInCode/letagents",
    repository_owner: "BrosInCode",
    repository_name: "letagents",
    ref_type: "branch",
    ref_name: "codex/git-rooms",
    default_branch: "main",
    base_ref: "main",
    head_ref: "codex/git-rooms",
    head_repository_id: null,
    head_repository_full_name: null,
    head_repository_owner: null,
    head_repository_name: null,
    visibility: "public",
    is_default: false,
    source: "webhook",
    created_at: "2026-06-28T10:00:00.000Z",
    updated_at: "2026-06-28T10:00:00.000Z",
  };
}

function task(): Task {
  return {
    id: "task_1",
    room_id: "room_1",
    title: "Conclude the focus room",
    description: null,
    status: "in_progress",
    assignee: "Worker | Owner's agent | Agent",
    assignee_agent_key: "owner/worker",
    created_by: "Owner",
    source_message_id: null,
    pr_url: null,
    workflow_artifacts: [],
    workflow_refs: [],
    created_at: "2026-08-08T10:00:00.000Z",
    updated_at: "2026-08-08T10:00:00.000Z",
  };
}

const conclusionDetails = {
  artifact: "PR #886",
  review_state: "reviewed" as const,
  blocker_state: "none" as const,
  parent_task_next: "mark_done" as const,
  next_owner: "Owner",
};

function responseRecorder() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

function workerPrincipal() {
  return {
    bearer_id: "agent_bearer_1",
    bearer_generation: 1,
    capabilities: ["coordination.self_write"],
    room_id: "room_1",
    agent_session_id: "agent_session_1",
    actor_label: "Worker | Owner's agent | Agent",
    agent_key: "owner/worker",
    agent_instance_id: "instance_1",
    session_kind: "worker" as const,
    runtime: "codex",
    display_name: "Worker",
    owner_label: "Owner",
    ide_label: "Agent",
    repo_branch: null,
    expires_at: "2026-08-08T12:00:00.000Z",
  };
}

type ConclusionHandler = (req: unknown, res: unknown) => Promise<void>;

function registerConclusionHandler(overrides: Record<string, unknown> = {}): ConclusionHandler {
  let concludeHandler: ConclusionHandler | null = null;
  const app = {
    get() {},
    patch() {},
    delete() {},
    post(path: RegExp, handler: ConclusionHandler) {
      if (path.toString().includes("conclude")) concludeHandler = handler;
    },
  };
  const focusRoom = project({
    id: "focus_1",
    kind: "focus",
    parent_room_id: "room_1",
    focus_key: "task_1",
    source_task_id: "task_1",
    focus_status: "active",
  });
  const taskRecord = task();
  const deps = {
    ...createDeps(),
    getFocusRoomByKey: async () => focusRoom,
    getTaskById: async () => taskRecord,
    getTaskOwnershipState: async () => ({
      status: taskRecord.status,
      assignee: taskRecord.assignee,
      assignee_agent_key: taskRecord.assignee_agent_key,
    }),
    concludeFocusRoom: async () => ({
      room: project({
        ...focusRoom,
        focus_status: "concluded",
        conclusion_summary: "Done",
        conclusion_details: conclusionDetails,
      }),
      task: taskRecord,
      updated: false,
    }),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => project({ id: "room_1" }),
    requireParticipant: async () => true,
    resolveProjectRole: async () => "participant" as const,
    toRoomResponse: (room: Project) => ({ room_id: room.id, focus_status: room.focus_status }),
    normalizeOptionalString: (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null,
    enforceFocusRoomConclusion: async () => ({ kind: "allow" as const }),
    emitProjectMessage: async () => null,
    formatFocusRoomConclusionMessage: () => "Focus room concluded.",
    ...overrides,
  };

  registerRoomFocusRoutes(app as never, deps as never);
  assert.ok(concludeHandler);
  return concludeHandler;
}

test("registerRoomFocusRoutes preserves canonical Focus Room route order", () => {
  const calls: Array<{ method: "delete" | "get" | "patch" | "post"; path: string }> = [];
  const app = {
    get(path: RegExp) {
      calls.push({ method: "get", path: path.toString() });
    },
    delete(path: RegExp) {
      calls.push({ method: "delete", path: path.toString() });
    },
    patch(path: RegExp) {
      calls.push({ method: "patch", path: path.toString() });
    },
    post(path: RegExp) {
      calls.push({ method: "post", path: path.toString() });
    },
  };

  registerRoomFocusRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "get", path: "/^\\/rooms\\/(.+)\\/focus\\/([^/]+)$/" },
    { method: "patch", path: "/^\\/rooms\\/(.+)\\/focus\\/([^/]+)\\/settings$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/focus-rooms$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/focus-rooms$/" },
    { method: "delete", path: "/^\\/rooms\\/(.+)\\/focus\\/([^/]+)$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/focus\\/([^/]+)\\/conclude$/" },
  ]);
});

test("toFocusRoomListResponse passes Git Room bindings to focus room responses", () => {
  const gitFocusRoom = project({
    id: "focus_37",
    kind: "focus",
    parent_room_id: "github.com/owner/repo",
    focus_key: "git:branch:Y29kZXgvZ2l0LXJvb21z",
    focus_status: "active",
  });
  const taskFocusRoom = project({
    id: "focus_1",
    kind: "focus",
    parent_room_id: "github.com/owner/repo",
    focus_key: "task_1",
    source_task_id: "task_1",
    focus_status: "active",
  });
  const binding = gitRoomBinding(gitFocusRoom.id);
  const calls: unknown[] = [];

  const response = toFocusRoomListResponse({
    project: project(),
    focusRooms: [gitFocusRoom, taskFocusRoom],
    gitRoomBindings: new Map([[gitFocusRoom.id, binding]]),
    toRoomResponse: (focusRoom: Project, options?: unknown) => {
      calls.push({ focusRoomId: focusRoom.id, options });
      return { room_id: focusRoom.id };
    },
  });

  assert.deepEqual(response, {
    room_id: "github.com/owner/repo",
    focus_rooms: [
      { room_id: gitFocusRoom.id },
      { room_id: taskFocusRoom.id },
    ],
  });
  assert.deepEqual(calls, [
    {
      focusRoomId: gitFocusRoom.id,
      options: { gitRoomBinding: binding },
    },
    {
      focusRoomId: taskFocusRoom.id,
      options: { gitRoomBinding: null },
    },
  ]);
});

test("focus room archive route requires an admin guard", async () => {
  let deleteHandler: ((req: unknown, res: unknown) => Promise<void>) | null = null;
  let requireAdminCalled = false;
  let requireParticipantCalled = false;
  const app = {
    get() {},
    patch() {},
    post() {},
    delete(_path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      deleteHandler = handler;
    },
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireAdmin: async () => {
      requireAdminCalled = true;
      return false;
    },
    requireParticipant: async () => {
      requireParticipantCalled = true;
      return false;
    },
  };

  registerRoomFocusRoutes(app as never, deps as never);
  assert.ok(deleteHandler);

  await deleteHandler(
    { params: { 0: "room_1", 1: "focus_1" } },
    { status: () => ({ json: () => undefined }), json: () => undefined },
  );

  assert.equal(requireAdminCalled, true);
  assert.equal(requireParticipantCalled, false);
});

test("marked desktop-human focus room conclusions skip agent coordination", async () => {
  let coordinationCalled = false;
  let concludeCalled = false;
  const concludeHandler = registerConclusionHandler({
    enforceFocusRoomConclusion: async () => {
      coordinationCalled = true;
      return { kind: "allow" as const };
    },
    concludeFocusRoom: async () => {
      concludeCalled = true;
      return {
        room: project({
          id: "focus_1",
          kind: "focus",
          parent_room_id: "room_1",
          focus_key: "task_1",
          source_task_id: "task_1",
          focus_status: "concluded",
          conclusion_summary: "Done",
          conclusion_details: conclusionDetails,
        }),
        task: task(),
        updated: false,
      };
    },
  });
  const res = responseRecorder();

  await concludeHandler(
    {
      authKind: "owner_token",
      headers: { "x-letagents-desktop-client": "1" },
      params: { 0: "room_1", 1: "focus_1" },
      body: { summary: "Done", conclusion_details: conclusionDetails },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(coordinationCalled, false);
  assert.equal(concludeCalled, true);
});

test("marked desktop humans can quick-close without a summary or structured details", async () => {
  let conclusionInput: unknown[] | null = null;
  const concludeHandler = registerConclusionHandler({
    concludeFocusRoom: async (...input: unknown[]) => {
      conclusionInput = input;
      return {
        room: project({
          id: "focus_1",
          kind: "focus",
          parent_room_id: "room_1",
          focus_key: "task_1",
          source_task_id: "task_1",
          focus_status: "concluded",
          conclusion_summary: QUICK_FOCUS_ROOM_CONCLUSION_SUMMARY,
          conclusion_details: null,
        }),
        task: task(),
        updated: false,
      };
    },
  });
  const res = responseRecorder();

  await concludeHandler(
    {
      authKind: "owner_token",
      headers: { "x-letagents-desktop-client": "1" },
      params: { 0: "room_1", 1: "focus_1" },
      body: { quick_close: true },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(conclusionInput?.[2], QUICK_FOCUS_ROOM_CONCLUSION_SUMMARY);
  assert.equal(conclusionInput?.[3], null);
});

test("quick-close does not bypass summary requirements for agent sessions", async () => {
  let concludeCalled = false;
  const concludeHandler = registerConclusionHandler({
    concludeFocusRoom: async () => {
      concludeCalled = true;
      return null;
    },
  });
  const res = responseRecorder();

  await concludeHandler(
    {
      authKind: "agent_session",
      headers: { "x-letagents-desktop-client": "1" },
      agentSession: workerPrincipal(),
      params: { 0: "room_1", 1: "focus_1" },
      body: { quick_close: true },
    },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "summary is required" });
  assert.equal(concludeCalled, false);
});

test("unmarked owner-token focus room conclusions still require worker identity", async () => {
  let coordinationCalled = false;
  let concludeCalled = false;
  const concludeHandler = registerConclusionHandler({
    enforceFocusRoomConclusion: async () => {
      coordinationCalled = true;
      return { kind: "allow" as const };
    },
    concludeFocusRoom: async () => {
      concludeCalled = true;
      return null;
    },
  });
  const res = responseRecorder();

  await concludeHandler(
    {
      authKind: "owner_token",
      headers: {},
      params: { 0: "room_1", 1: "focus_1" },
      body: { summary: "Done", conclusion_details: conclusionDetails },
    },
    res,
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: "Registered worker session is required for agent write actions.",
  });
  assert.equal(coordinationCalled, false);
  assert.equal(concludeCalled, false);
});

test("agent-session focus room conclusions still enforce task coordination", async () => {
  let enforcementInput: Record<string, unknown> | null = null;
  let concludeCalled = false;
  const concludeHandler = registerConclusionHandler({
    enforceFocusRoomConclusion: async (input: Record<string, unknown>) => {
      enforcementInput = input;
      return {
        kind: "deny" as const,
        code: "coordination_lease_required",
        error: "An active work lease is required.",
      };
    },
    concludeFocusRoom: async () => {
      concludeCalled = true;
      return null;
    },
  });
  const res = responseRecorder();

  await concludeHandler(
    {
      authKind: "agent_session",
      headers: { "x-letagents-desktop-client": "1" },
      agentSession: workerPrincipal(),
      params: { 0: "room_1", 1: "focus_1" },
      body: { summary: "Done", conclusion_details: conclusionDetails },
    },
    res,
  );

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    error: "An active work lease is required.",
    code: "coordination_lease_required",
  });
  assert.equal(enforcementInput?.actorSessionId, "agent_session_1");
  assert.equal(enforcementInput?.actorKey, "owner/worker");
  assert.equal(concludeCalled, false);
});
