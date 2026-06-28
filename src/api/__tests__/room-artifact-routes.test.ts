import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const { registerRoomArtifactRoutes } = await import("../routes/rooms/artifacts.js");

type Handler = (req: Record<string, any>, res: Record<string, any>) => Promise<void>;

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

test("room artifact route returns shared artifacts for the canonical room", async () => {
  let handler: Handler | undefined;
  const app = {
    get(path: RegExp, registeredHandler: Handler) {
      assert.equal(path.source, "^\\/rooms\\/(.+)\\/artifacts$");
      handler = registeredHandler;
    },
    post(path: RegExp, _registeredHandler: Handler) {
      assert.equal(path.source, "^\\/rooms\\/(.+)\\/artifacts$");
    },
  };
  const calls: unknown[] = [];

  registerRoomArtifactRoutes(app as never, {
    resolveCanonicalRoomRequestId: async (roomId) => {
      calls.push({ resolve: roomId });
      return roomId;
    },
    resolveRoomOrReply: async (roomId) => ({
      id: roomId,
      display_name: "Repo Room",
    } as never),
    requireParticipant: async (_req, _res, project) => {
      calls.push({ participant: project.id });
      return true;
    },
    getRoomSharedArtifacts: async (input) => {
      calls.push({ artifacts: input });
      return [
        {
          room_id: input.room_id,
          identity_key: "github:pull_request:number:42",
          provider: "github",
          kind: "pull_request",
          artifact_id: null,
          artifact_number: 42,
          title: "Add Git Rooms",
          url: "https://github.com/BrosInCode/letagents/pull/42",
          ref: "codex/git-rooms",
          state: "open",
          source: "task_workflow_artifact",
          first_seen_at: "2026-06-28T10:00:00.000Z",
          updated_at: "2026-06-28T11:00:00.000Z",
          linked_task_ids: ["task_4", "task_7"],
        },
      ];
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
  });

  assert.ok(handler);
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
        room_id: "github.com/brosincode/letagents",
        task_id: "task_4",
        limit: 25,
      },
    },
  ]);
  assert.deepEqual(res.body, {
    room_id: "github.com/brosincode/letagents",
    artifacts: [
      {
        room_id: "github.com/brosincode/letagents",
        identity_key: "github:pull_request:number:42",
        provider: "github",
        kind: "pull_request",
        artifact_id: null,
        artifact_number: 42,
        title: "Add Git Rooms",
        url: "https://github.com/BrosInCode/letagents/pull/42",
        ref: "codex/git-rooms",
        state: "open",
        source: "task_workflow_artifact",
        first_seen_at: "2026-06-28T10:00:00.000Z",
        updated_at: "2026-06-28T11:00:00.000Z",
        linked_task_ids: ["task_4", "task_7"],
      },
    ],
  });
});

test("room artifact route publishes a manual artifact and links tasks", async () => {
  let handler: Handler | undefined;
  const app = {
    get(path: RegExp, _registeredHandler: Handler) {
      assert.equal(path.source, "^\\/rooms\\/(.+)\\/artifacts$");
    },
    post(path: RegExp, registeredHandler: Handler) {
      assert.equal(path.source, "^\\/rooms\\/(.+)\\/artifacts$");
      handler = registeredHandler;
    },
  };
  const calls: unknown[] = [];
  const artifactEvents = new EventEmitter();
  const emittedArtifactUpdates: unknown[] = [];
  artifactEvents.on("artifact:updated", (event) => {
    emittedArtifactUpdates.push(event);
  });

  registerRoomArtifactRoutes(app as never, {
    artifactEvents,
    resolveCanonicalRoomRequestId: async (roomId) => {
      calls.push({ resolve: roomId });
      return roomId;
    },
    resolveRoomOrReply: async (roomId) => ({
      id: roomId,
      display_name: "Repo Room",
    } as never),
    requireParticipant: async (_req, _res, project) => {
      calls.push({ participant: project.id });
      return true;
    },
    getRoomSharedArtifacts: async () => {
      throw new Error("unexpected list");
    },
    upsertRoomSharedArtifact: async (input) => {
      calls.push({ upsert: input });
      return {
        room_id: input.room_id,
        identity_key: "github:branch:ref:codex/git-rooms",
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
      };
    },
    linkRoomSharedArtifactToTask: async (input) => {
      calls.push({ link: input });
    },
    getRoomSharedArtifactByIdentityKey: async (input) => {
      calls.push({ hydrate: input });
      return {
        room_id: input.room_id,
        identity_key: input.identity_key,
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
        linked_task_ids: ["task_4", "task_7"],
      };
    },
  });

  assert.ok(handler);
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
        artifact_identity_key: "github:branch:ref:codex/git-rooms",
        task_id: "task_4",
        source: "manual",
      },
    },
    {
      link: {
        room_id: "github.com/brosincode/letagents",
        artifact_identity_key: "github:branch:ref:codex/git-rooms",
        task_id: "task_7",
        source: "manual",
      },
    },
    {
      hydrate: {
        room_id: "github.com/brosincode/letagents",
        identity_key: "github:branch:ref:codex/git-rooms",
      },
    },
  ]);
  assert.deepEqual(emittedArtifactUpdates, [
    {
      projectId: "github.com/brosincode/letagents",
      artifact: {
        room_id: "github.com/brosincode/letagents",
        identity_key: "github:branch:ref:codex/git-rooms",
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
        linked_task_ids: ["task_4", "task_7"],
      },
    },
  ]);
  assert.deepEqual(res.body, {
    room_id: "github.com/brosincode/letagents",
    artifact: {
      room_id: "github.com/brosincode/letagents",
      identity_key: "github:branch:ref:codex/git-rooms",
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
      linked_task_ids: ["task_4", "task_7"],
    },
  });
});
