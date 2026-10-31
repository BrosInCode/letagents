import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Express } from "express";

import type { Project, RoomSharedArtifact, TaskLease } from "../db.js";
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

function workLease(overrides: Partial<TaskLease> = {}): TaskLease {
  return {
    id: "lease_1",
    room_id: ROOM_ID,
    task_id: "task_4",
    kind: "work",
    status: "active",
    agent_key: "emmy/cedarvista",
    agent_instance_id: null,
    agent_session_id: "agent_session_1",
    actor_label: "CedarVista | Emmy's agent | Claude Code",
    epoch: 1,
    branch_ref: "feature/x",
    pr_url: null,
    output_intent: null,
    expires_at: null,
    last_heartbeat_at: null,
    revoked_reason: null,
    created_by: "emmy",
    created_at: "2026-06-28T10:00:00.000Z",
    updated_at: "2026-06-28T10:00:00.000Z",
    ...overrides,
  };
}

function sessionNineWorker() {
  return {
    ok: true as const,
    identity: {
      actor_label: "Generic | Emmy's agent | Codex",
      agent_key: "codex",
      agent_instance_id: null,
      agent_session_id: "agent_session_9",
      session_kind: "worker" as const,
      runtime: "codex",
      display_name: "Generic",
      owner_label: "Emmy",
      ide_label: "Codex",
      repo_branch: "feature/x",
    },
  };
}

function sessionNineLease(overrides: Partial<TaskLease> = {}): TaskLease {
  return workLease({
    id: "lease_9",
    agent_key: "codex",
    agent_session_id: "agent_session_9",
    actor_label: "Generic | Emmy's agent | Codex",
    branch_ref: "feature/x",
    ...overrides,
  });
}

function sessionNineChangeSummaryBody(extra: Record<string, unknown>) {
  return {
    agent_session_id: "agent_session_9",
    agent_session_token: "token_9",
    artifact: {
      provider: "git",
      kind: "change_summary",
      id: "managed-agent:session:agent_session_9:branch:feature/x",
      ref: "feature/x",
      state: "updated",
    },
    ...extra,
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
    requireWorkerRequestAgentIdentity: async () => {
      throw new Error("unexpected worker identity check");
    },
    getActiveTaskLeases: async () => {
      throw new Error("unexpected lease lookup");
    },
    publishWorkerArtifactFenced: async () => {
      throw new Error("unexpected fenced publish");
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

test("room artifact route stores agent-session publishes as workflow artifacts", async () => {
  const calls: unknown[] = [];
  const hydratedArtifact = artifactRow({
    source: "task_workflow_artifact",
    linked_task_ids: ["task_4"],
  });

  const handler = registeredHandler("post", routeDeps(calls, {
    requireWorkerRequestAgentIdentity: async (input) => {
      calls.push({
        workerIdentity: {
          room_id: input.room_id,
          agent_session_id: input.body.agent_session_id,
        },
      });
      return {
        ok: true,
        identity: {
          actor_label: "CedarVista | Emmy's agent | Claude Code",
          agent_key: "emmy/cedarvista",
          agent_instance_id: null,
          agent_session_id: "agent_session_1",
          session_kind: "worker",
          runtime: "claude-code:token",
          display_name: "CedarVista",
          owner_label: "Emmy",
          ide_label: "Claude Code",
          repo_branch: "feature/x",
        },
      };
    },
    getActiveTaskLeases: async (roomId, taskId) => {
      calls.push({ activeLeases: { room_id: roomId, task_id: taskId } });
      return [workLease()];
    },
    publishWorkerArtifactFenced: async (input) => {
      calls.push({
        fencedPublish: {
          leaseFence: input.leaseFence,
          room_id: input.room_id,
          linked_task_id: input.linked_task_id,
          source: input.source,
        },
      });
      return artifactRow({ room_id: input.room_id, source: "task_workflow_artifact" });
    },
    getRoomSharedArtifactByIdentityKey: async () => hydratedArtifact,
  }));

  const res = responseStub();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/letagents" },
      authKind: "owner_token",
      body: {
        artifact: {
          provider: "git",
          kind: "change_summary",
          id: "managed-agent:key:emmy/cedarvista:branch:feature/x",
          title: "CedarVista changes on feature/x (2 files)",
          ref: "feature/x",
          state: "updated",
        },
        task_id: "task_4",
        agent_session_id: "agent_session_1",
        agent_session_token: "token_1",
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
      workerIdentity: {
        room_id: "github.com/brosincode/letagents",
        agent_session_id: "agent_session_1",
      },
    },
    {
      activeLeases: {
        room_id: "github.com/brosincode/letagents",
        task_id: "task_4",
      },
    },
    {
      fencedPublish: {
        leaseFence: {
          lease_id: "lease_1",
          room_id: "github.com/brosincode/letagents",
          task_id: "task_4",
          kind: "work",
          expected_epoch: 1,
          agent_session_id: "agent_session_1",
        },
        room_id: "github.com/brosincode/letagents",
        linked_task_id: "task_4",
        source: "task_workflow_artifact",
      },
    },
  ]);
  assert.deepEqual(res.body, {
    room_id: ROOM_ID,
    artifact: hydratedArtifact,
  });
});

test("room artifact route rejects a change_summary id that does not match the authenticated worker", async () => {
  const calls: unknown[] = [];
  const handler = registeredHandler("post", routeDeps(calls, {
    requireWorkerRequestAgentIdentity: async () => ({
      ok: true,
      identity: {
        actor_label: "CedarVista | Emmy's agent | Claude Code",
        agent_key: "emmy/cedarvista",
        agent_instance_id: null,
        agent_session_id: "agent_session_1",
        session_kind: "worker",
        runtime: "claude-code:token",
        display_name: "CedarVista",
        owner_label: "Emmy",
        ide_label: "Claude Code",
        repo_branch: "feature/x",
      },
    }),
    // upsert is left as the default throwing stub — it must NOT be reached.
  }));

  const res = responseStub();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/letagents" },
      authKind: "owner_token",
      body: {
        artifact: {
          provider: "git",
          kind: "change_summary",
          id: "managed-agent:key:someone/else:branch:feature/x",
          ref: "feature/x",
          state: "updated",
        },
        agent_session_id: "agent_session_1",
        agent_session_token: "token_1",
      },
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 403);
});

test("room artifact route accepts a session-based change_summary id matching the worker session", async () => {
  const calls: unknown[] = [];
  const hydratedArtifact = artifactRow({ kind: "change_summary" });
  const handler = registeredHandler("post", routeDeps(calls, {
    requireWorkerRequestAgentIdentity: async () => ({
      ok: true,
      identity: {
        actor_label: "Generic | Emmy's agent | Codex",
        agent_key: "codex",
        agent_instance_id: null,
        agent_session_id: "agent_session_9",
        session_kind: "worker",
        runtime: "codex",
        display_name: "Generic",
        owner_label: "Emmy",
        ide_label: "Codex",
        repo_branch: "feature/x",
      },
    }),
    getActiveTaskLeases: async () => [
      workLease({
        id: "lease_9",
        agent_key: "codex",
        agent_session_id: "agent_session_9",
        actor_label: "Generic | Emmy's agent | Codex",
        branch_ref: "feature/x",
      }),
    ],
    publishWorkerArtifactFenced: async (input) =>
      artifactRow({ room_id: input.room_id, kind: "change_summary" }),
    getRoomSharedArtifactByIdentityKey: async () => hydratedArtifact,
  }));

  const res = responseStub();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/letagents" },
      authKind: "owner_token",
      body: {
        agent_session_id: "agent_session_9",
        agent_session_token: "token_9",
        task_id: "task_4",
        artifact: {
          provider: "git",
          kind: "change_summary",
          id: "managed-agent:session:agent_session_9:branch:feature/x",
          ref: "feature/x",
          state: "updated",
        },
      },
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 200);
});

test("room artifact route refuses a worker artifact when the task lease belongs to another session", async () => {
  const calls: unknown[] = [];
  const handler = registeredHandler("post", routeDeps(calls, {
    requireWorkerRequestAgentIdentity: async () => ({
      ok: true,
      identity: {
        actor_label: "Generic | Emmy's agent | Codex",
        agent_key: "codex",
        agent_instance_id: null,
        agent_session_id: "agent_session_9",
        session_kind: "worker",
        runtime: "codex",
        display_name: "Generic",
        owner_label: "Emmy",
        ide_label: "Codex",
        repo_branch: "feature/x",
      },
    }),
    getActiveTaskLeases: async () => [
      workLease({
        id: "lease_2",
        agent_key: "emmy/other",
        agent_session_id: "agent_session_2",
      }),
    ],
    // publishWorkerArtifactFenced is left as the throwing stub — must not be reached.
  }));

  const res = responseStub();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/letagents" },
      authKind: "owner_token",
      body: {
        agent_session_id: "agent_session_9",
        agent_session_token: "token_9",
        task_id: "task_4",
        artifact: {
          provider: "git",
          kind: "change_summary",
          id: "managed-agent:session:agent_session_9:branch:feature/x",
          ref: "feature/x",
          state: "updated",
        },
      },
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: "Worker artifacts must be bound to the caller's active work lease.",
  });
});

test("room artifact route refuses a worker artifact bound to no task", async () => {
  const calls: unknown[] = [];
  const handler = registeredHandler("post", routeDeps(calls, {
    requireWorkerRequestAgentIdentity: async () => sessionNineWorker(),
    getActiveTaskLeases: async (roomId, taskId) => {
      calls.push({ activeLeases: { room_id: roomId, task_id: taskId } });
      return [sessionNineLease()];
    },
    publishWorkerArtifactFenced: async (input) => {
      calls.push({ fencedPublish: { room_id: input.room_id } });
      return artifactRow({ room_id: input.room_id, kind: "change_summary" });
    },
    getRoomSharedArtifactByIdentityKey: async () => artifactRow({ kind: "change_summary" }),
  }));

  const res = responseStub();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/letagents" },
      authKind: "owner_token",
      body: sessionNineChangeSummaryBody({}),
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: "Worker artifacts must be bound to exactly one active task.",
  });
  assert.deepEqual(calls, [
    { resolve: "github.com/brosincode/letagents" },
    { participant: "github.com/brosincode/letagents" },
  ]);
});

test("room artifact route refuses a worker artifact bound to two tasks", async () => {
  const calls: unknown[] = [];
  const handler = registeredHandler("post", routeDeps(calls, {
    requireWorkerRequestAgentIdentity: async () => sessionNineWorker(),
    getActiveTaskLeases: async (roomId, taskId) => {
      calls.push({ activeLeases: { room_id: roomId, task_id: taskId } });
      return [sessionNineLease()];
    },
    publishWorkerArtifactFenced: async (input) => {
      calls.push({ fencedPublish: { room_id: input.room_id } });
      return artifactRow({ room_id: input.room_id, kind: "change_summary" });
    },
    getRoomSharedArtifactByIdentityKey: async () => artifactRow({ kind: "change_summary" }),
  }));

  const res = responseStub();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/letagents" },
      authKind: "owner_token",
      body: sessionNineChangeSummaryBody({
        task_id: "task_4",
        linked_task_ids: ["task_5"],
      }),
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: "Worker artifacts must be bound to exactly one active task.",
  });
  assert.deepEqual(calls, [
    { resolve: "github.com/brosincode/letagents" },
    { participant: "github.com/brosincode/letagents" },
  ]);
});

test("room artifact route refuses a worker artifact whose only lease is a review lease", async () => {
  const calls: unknown[] = [];
  const handler = registeredHandler("post", routeDeps(calls, {
    requireWorkerRequestAgentIdentity: async () => sessionNineWorker(),
    getActiveTaskLeases: async (roomId, taskId) => {
      calls.push({ activeLeases: { room_id: roomId, task_id: taskId } });
      return [sessionNineLease({ kind: "review" })];
    },
    publishWorkerArtifactFenced: async (input) => {
      calls.push({ fencedPublish: { room_id: input.room_id } });
      return artifactRow({ room_id: input.room_id, kind: "change_summary" });
    },
    getRoomSharedArtifactByIdentityKey: async () => artifactRow({ kind: "change_summary" }),
  }));

  const res = responseStub();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/letagents" },
      authKind: "owner_token",
      body: sessionNineChangeSummaryBody({ task_id: "task_4" }),
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: "Worker artifacts must be bound to the caller's active work lease.",
  });
  assert.deepEqual(calls, [
    { resolve: "github.com/brosincode/letagents" },
    { participant: "github.com/brosincode/letagents" },
    { activeLeases: { room_id: "github.com/brosincode/letagents", task_id: "task_4" } },
  ]);
});

test("room artifact route refuses a worker artifact whose work lease is not active", async () => {
  const calls: unknown[] = [];
  const handler = registeredHandler("post", routeDeps(calls, {
    requireWorkerRequestAgentIdentity: async () => sessionNineWorker(),
    getActiveTaskLeases: async (roomId, taskId) => {
      calls.push({ activeLeases: { room_id: roomId, task_id: taskId } });
      return [sessionNineLease({ status: "released" })];
    },
    publishWorkerArtifactFenced: async (input) => {
      calls.push({ fencedPublish: { room_id: input.room_id } });
      return artifactRow({ room_id: input.room_id, kind: "change_summary" });
    },
    getRoomSharedArtifactByIdentityKey: async () => artifactRow({ kind: "change_summary" }),
  }));

  const res = responseStub();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/letagents" },
      authKind: "owner_token",
      body: sessionNineChangeSummaryBody({ task_id: "task_4" }),
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: "Worker artifacts must be bound to the caller's active work lease.",
  });
  assert.deepEqual(calls, [
    { resolve: "github.com/brosincode/letagents" },
    { participant: "github.com/brosincode/letagents" },
    { activeLeases: { room_id: "github.com/brosincode/letagents", task_id: "task_4" } },
  ]);
});

test("room artifact route binds a worker publish to its own work lease, not the first lease listed", async () => {
  const calls: unknown[] = [];
  const handler = registeredHandler("post", routeDeps(calls, {
    requireWorkerRequestAgentIdentity: async () => sessionNineWorker(),
    getActiveTaskLeases: async (roomId, taskId) => {
      calls.push({ activeLeases: { room_id: roomId, task_id: taskId } });
      return [
        workLease({
          id: "lease_other",
          agent_key: "emmy/other",
          agent_session_id: "agent_session_2",
          epoch: 4,
        }),
        sessionNineLease({ id: "lease_own", epoch: 2 }),
      ];
    },
    publishWorkerArtifactFenced: async (input) => {
      calls.push({ fencedPublish: { leaseFence: input.leaseFence } });
      return artifactRow({ room_id: input.room_id, kind: "change_summary" });
    },
    getRoomSharedArtifactByIdentityKey: async () => artifactRow({ kind: "change_summary" }),
  }));

  const res = responseStub();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/letagents" },
      authKind: "owner_token",
      body: sessionNineChangeSummaryBody({ task_id: "task_4" }),
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [
    { resolve: "github.com/brosincode/letagents" },
    { participant: "github.com/brosincode/letagents" },
    { activeLeases: { room_id: "github.com/brosincode/letagents", task_id: "task_4" } },
    {
      fencedPublish: {
        leaseFence: {
          lease_id: "lease_own",
          room_id: "github.com/brosincode/letagents",
          task_id: "task_4",
          kind: "work",
          expected_epoch: 2,
          agent_session_id: "agent_session_9",
        },
      },
    },
  ]);
});

test("room artifact route rejects a malformed managed-agent change_summary identity form", async () => {
  const calls: unknown[] = [];
  const handler = registeredHandler("post", routeDeps(calls, {
    requireWorkerRequestAgentIdentity: async () => ({
      ok: true,
      identity: {
        actor_label: "X | Emmy's agent | Codex",
        agent_key: "emmy/x",
        agent_instance_id: null,
        agent_session_id: "agent_session_9",
        session_kind: "worker",
        runtime: "codex",
        display_name: "X",
        owner_label: "Emmy",
        ide_label: "Codex",
        repo_branch: "feature/x",
      },
    }),
    // upsert left as the throwing stub — must not be reached.
  }));

  const res = responseStub();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/letagents" },
      authKind: "owner_token",
      body: {
        agent_session_id: "agent_session_9",
        agent_session_token: "token_9",
        artifact: {
          provider: "git",
          kind: "change_summary",
          id: "managed-agent:weird:branch:feature/x",
          ref: "feature/x",
          state: "updated",
        },
      },
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 403);
});

test("room artifact route rejects a managed-agent change_summary id missing a branch segment", async () => {
  const calls: unknown[] = [];
  const handler = registeredHandler("post", routeDeps(calls, {
    requireWorkerRequestAgentIdentity: async () => ({
      ok: true,
      identity: {
        actor_label: "X | Emmy's agent | Codex",
        agent_key: "emmy/x",
        agent_instance_id: null,
        agent_session_id: "agent_session_9",
        session_kind: "worker",
        runtime: "codex",
        display_name: "X",
        owner_label: "Emmy",
        ide_label: "Codex",
        repo_branch: "feature/x",
      },
    }),
    // upsert left as the throwing stub — must not be reached.
  }));

  const res = responseStub();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/letagents" },
      authKind: "owner_token",
      body: {
        agent_session_id: "agent_session_9",
        agent_session_token: "token_9",
        artifact: {
          provider: "git",
          kind: "change_summary",
          id: "managed-agent:key:emmy/x",
          ref: "feature/x",
          state: "updated",
        },
      },
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 403);
});

test("room artifact route rejects invalid agent session credentials instead of downgrading to manual", async () => {
  const calls: unknown[] = [];
  const handler = registeredHandler("post", routeDeps(calls, {
    requireWorkerRequestAgentIdentity: async () => ({
      ok: false,
      status: 401,
      error: "Invalid agent session credentials.",
    }),
  }));

  const res = responseStub();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/letagents" },
      authKind: "owner_token",
      body: {
        artifact: {
          provider: "git",
          kind: "change_summary",
          id: "managed-agent:key:emmy/cedarvista:branch:feature/x",
        },
        agent_session_id: "agent_session_1",
        agent_session_token: "wrong",
      },
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Invalid agent session credentials." });
  assert.deepEqual(calls, [
    { resolve: "github.com/brosincode/letagents" },
    { participant: "github.com/brosincode/letagents" },
  ]);
});

test("room artifact route passes change_summary detail through to the fenced publish", async () => {
  // Regression guard: normalizePublishedArtifact rebuilds the artifact field by
  // field, so a new field is silently dropped unless it is threaded through.
  const calls: unknown[] = [];
  let capturedPublish: { artifact?: { detail?: unknown } } | null = null;
  const handler = registeredHandler("post", routeDeps(calls, {
    requireWorkerRequestAgentIdentity: async () => ({
      ok: true,
      identity: {
        actor_label: "X | Emmy's agent | Claude Code",
        agent_key: "emmy/x",
        agent_instance_id: null,
        agent_session_id: "agent_session_1",
        session_kind: "worker",
        runtime: "claude-code:token",
        display_name: "X",
        owner_label: "Emmy",
        ide_label: "Claude Code",
        repo_branch: "feature/y",
      },
    }),
    getActiveTaskLeases: async () => [
      workLease({
        agent_key: "emmy/x",
        actor_label: "X | Emmy's agent | Claude Code",
        branch_ref: "feature/y",
      }),
    ],
    publishWorkerArtifactFenced: async (input) => {
      capturedPublish = input as { artifact?: { detail?: unknown } };
      return artifactRow({ room_id: input.room_id, kind: "change_summary" });
    },
    getRoomSharedArtifactByIdentityKey: async () => artifactRow({ kind: "change_summary" }),
  }));

  const res = responseStub();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/letagents" },
      authKind: "owner_token",
      body: {
        agent_session_id: "agent_session_1",
        agent_session_token: "token_1",
        task_id: "task_4",
        artifact: {
          provider: "git",
          kind: "change_summary",
          id: "managed-agent:key:emmy/x:branch:feature/y",
          ref: "feature/y",
          state: "updated",
          detail: {
            type: "change_summary",
            version: 1,
            changedFileCount: 1,
            additions: 4,
            deletions: 1,
            stagedFileCount: 1,
            unstagedFileCount: 0,
            untrackedFileCount: 0,
            hiddenFileCount: 0,
            files: [
              {
                path: "src/a.ts",
                previousPath: null,
                status: "modified",
                additions: 4,
                deletions: 1,
                binary: false,
                staged: true,
                unstaged: false,
                untracked: false,
              },
            ],
          },
        },
      },
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 200);
  const detail = capturedPublish?.artifact?.detail as
    | { type: string; files: unknown[] }
    | undefined;
  assert.ok(detail, "detail must survive validation + normalization into the fenced publish");
  assert.equal(detail?.type, "change_summary");
  assert.equal(detail?.files.length, 1);
});
