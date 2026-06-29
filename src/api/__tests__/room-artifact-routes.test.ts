import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Express } from "express";

import type { Project, RoomSharedArtifact } from "../db.js";
import type { RoomArtifactRouteDeps } from "../routes/rooms/artifacts.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const { registerRoomArtifactRoutes } = await import("../routes/rooms/artifacts.js");

type RequestStub = Record<string, unknown>;
type ResponseStub = ReturnType<typeof responseStub>;
type Handler = (req: RequestStub, res: ResponseStub) => Promise<void>;
const ARTIFACT_ROUTE = "^\\/rooms\\/(.+)\\/artifacts$";
const ROOM_ID = "github.com/brosincode/letagents";
const BRANCH_IDENTITY_KEY = "github:branch:ref:codex/git-rooms";

function responseStub() {
  return {
    statusCode: 200,
    body: undefined as unknown,
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

function roomProject(roomId: string): Project {
  return {
    id: roomId,
    code: null,
    display_name: "Repo Room",
    name: null,
    kind: "main",
    parent_room_id: null,
    focus_key: null,
    source_task_id: null,
    focus_status: null,
    focus_parent_visibility: null,
    focus_activity_scope: null,
    focus_github_event_routing: null,
    focus_archived_at: null,
    git_lifecycle_event_order_at: null,
    concluded_at: null,
    conclusion_summary: null,
    conclusion_details: null,
    created_at: "2026-06-28T10:00:00.000Z",
  };
}

function artifactRow(overrides: Partial<RoomSharedArtifact> = {}): RoomSharedArtifact {
  return {
    room_id: ROOM_ID,
    identity_key: BRANCH_IDENTITY_KEY,
    provider: "github",
    kind: "branch",
    artifact_id: null,
    artifact_number: null,
    title: "Git Rooms branch",
    url: null,
    ref: "codex/git-rooms",
    state: "open",
    source: "manual",
    first_seen_at: "2026-06-28T10:00:00.000Z",
    updated_at: "2026-06-28T10:00:00.000Z",
    linked_task_ids: [],
    ...overrides,
  };
}

function routeDeps(
  calls: unknown[],
  overrides: Partial<RoomArtifactRouteDeps> = {}
): RoomArtifactRouteDeps {
  return {
    resolveCanonicalRoomRequestId: async (roomId: string) => {
      calls.push({ resolve: roomId });
      return roomId;
    },
    resolveRoomOrReply: async (roomId: string) => roomProject(roomId),
    requireParticipant: async (_req: unknown, _res: unknown, project: { id: string }) => {
      calls.push({ participant: project.id });
      return true;
    },
    getRoomSharedArtifacts: async () => {
      throw new Error("unexpected list");
    },
    upsertRoomSharedArtifact: async () => {
      throw new Error("unexpected upsert");
    },
    linkRoomSharedArtifactToTask: async () => {
      throw new Error("unexpected link");
    },
    getRoomSharedArtifactByIdentityKey: async () => {
      throw new Error("unexpected hydration");
    },
    ...overrides,
  };
}

function registeredHandler(method: "get" | "post", deps: RoomArtifactRouteDeps): Handler {
  let handler: Handler | undefined;
  const app = {
    get(path: RegExp, registeredHandler: Handler) {
      assert.equal(path.source, ARTIFACT_ROUTE);
      if (method === "get") {
        handler = registeredHandler;
      }
    },
    post(path: RegExp, registeredHandler: Handler) {
      assert.equal(path.source, ARTIFACT_ROUTE);
      if (method === "post") {
        handler = registeredHandler;
      }
    },
  };
  registerRoomArtifactRoutes(app as unknown as Express, deps);
  assert.ok(handler);
  return handler;
}

test("room artifact route returns shared artifacts for the canonical room", async () => {
  const calls: unknown[] = [];
  const listedArtifact = artifactRow({
    identity_key: "github:pull_request:number:42",
    kind: "pull_request",
    artifact_number: 42,
    title: "Add Git Rooms",
    url: "https://github.com/BrosInCode/letagents/pull/42",
    ref: "codex/git-rooms",
    source: "task_workflow_artifact",
    updated_at: "2026-06-28T11:00:00.000Z",
    linked_task_ids: ["task_4", "task_7"],
  });
  const handler = registeredHandler("get", routeDeps(calls, {
    getRoomSharedArtifacts: async (input) => {
      calls.push({ artifacts: input });
      return [listedArtifact];
    },
  }));

  const res = responseStub();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/letagents" },
      query: { task_id: "task_4", limit: "25" },
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [
    { resolve: "github.com/brosincode/letagents" },
    { participant: "github.com/brosincode/letagents" },
    {
      artifacts: {
        room_id: ROOM_ID,
        task_id: "task_4",
        limit: 25,
      },
    },
  ]);
  assert.deepEqual(res.body, {
    room_id: ROOM_ID,
    artifacts: [listedArtifact],
  });
});

test("room artifact route publishes a manual artifact and links tasks", async () => {
  const calls: unknown[] = [];
  const artifactEvents = new EventEmitter();
  const emittedArtifactUpdates: unknown[] = [];
  artifactEvents.on("artifact:updated", (event) => {
    emittedArtifactUpdates.push(event);
  });
  const hydratedArtifact = artifactRow({ linked_task_ids: ["task_4", "task_7"] });

  const handler = registeredHandler("post", routeDeps(calls, {
    artifactEvents,
    upsertRoomSharedArtifact: async (input) => {
      calls.push({ upsert: input });
      return artifactRow({
        room_id: input.room_id,
      });
    },
    linkRoomSharedArtifactToTask: async (input) => {
      calls.push({ link: input });
    },
    getRoomSharedArtifactByIdentityKey: async (input) => {
      calls.push({ hydrate: input });
      return hydratedArtifact;
    },
  }));

  const res = responseStub();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/letagents" },
      body: {
        artifact: {
          provider: "github",
          kind: "branch",
          title: " Git Rooms branch ",
          ref: " codex/git-rooms ",
          state: " open ",
        },
        task_id: " task_4 ",
        linked_task_ids: ["task_7", "task_4", ""],
      },
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [
    { resolve: "github.com/brosincode/letagents" },
    { participant: "github.com/brosincode/letagents" },
    {
      upsert: {
        room_id: "github.com/brosincode/letagents",
        artifact: {
          provider: "github",
          kind: "branch",
          title: "Git Rooms branch",
          ref: "codex/git-rooms",
          state: "open",
        },
        source: "manual",
      },
    },
    {
      link: {
        room_id: "github.com/brosincode/letagents",
        artifact_identity_key: BRANCH_IDENTITY_KEY,
        task_id: "task_4",
        source: "manual",
      },
    },
    {
      link: {
        room_id: "github.com/brosincode/letagents",
        artifact_identity_key: BRANCH_IDENTITY_KEY,
        task_id: "task_7",
        source: "manual",
      },
    },
    {
      hydrate: {
        room_id: "github.com/brosincode/letagents",
        identity_key: BRANCH_IDENTITY_KEY,
      },
    },
  ]);
  assert.deepEqual(emittedArtifactUpdates, [
    {
      projectId: ROOM_ID,
      artifact: hydratedArtifact,
    },
  ]);
  assert.deepEqual(res.body, {
    room_id: ROOM_ID,
    artifact: hydratedArtifact,
  });
});
