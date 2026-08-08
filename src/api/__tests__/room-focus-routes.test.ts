import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomFocusRoutes, toFocusRoomListResponse } = await import("../routes/rooms/focus.js");
import type { GitRoomBinding, Project } from "../db.js";

const focusRouteSource = readFileSync(
  fileURLToPath(new URL("../routes/rooms/focus.ts", import.meta.url)),
  "utf8",
);

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
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
    id: "git-room:github.com:owner/repo:branch:Y29kZXgvZ2l0LXJvb21z",
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

test("desktop human focus room conclusions bypass worker identity and lease enforcement", async () => {
  let concludeHandler: ((req: unknown, res: unknown) => Promise<void>) | null = null;
  let coordinationCalled = false;
  const app = {
    get() {},
    patch() {},
    delete() {},
    post(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      if (path.toString().includes("conclude")) concludeHandler = handler;
    },
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
    enforceFocusRoomConclusion: async () => {
      coordinationCalled = true;
      return { kind: "allow" as const };
    },
  };

  registerRoomFocusRoutes(app as never, deps as never);
  assert.ok(concludeHandler);

  let statusCode = 200;
  let body: unknown = null;
  await concludeHandler(
    {
      authKind: "owner_token",
      headers: { "x-letagents-desktop-client": "1" },
      params: { 0: "room_1", 1: "focus_1" },
      body: {},
    },
    {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
      },
    },
  );

  assert.equal(statusCode, 400);
  assert.deepEqual(body, { error: "summary is required" });
  assert.equal(coordinationCalled, false);
  assert.match(focusRouteSource, /const desktopHumanWrite = isDesktopHumanWrite\(req, requestBody\);/);
  assert.match(focusRouteSource, /task && taskOwnership && !desktopHumanWrite/);
});
