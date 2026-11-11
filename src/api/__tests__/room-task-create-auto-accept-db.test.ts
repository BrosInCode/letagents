import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

// POST /rooms/:id/tasks against a real database: who may create an accepted task.
const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const skip = url ? false : "set TEST_DB_URL to run the task create auto-accept DB tests";
const client = url ? await import("../db/client.js") : null;
const api = url ? await import("../db.js") : null;
const { registerTaskListAndCreateRoutes } = url ? await import("../routes/rooms/tasks/list-and-create.js") : { registerTaskListAndCreateRoutes: null };
const { default: express } = await import("express");

if (url) {
  test.beforeEach(async () => {
    await client!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await client!.pool.query("CREATE SCHEMA public");
    await migrate(client!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  });
  test.after(async () => { await client!.pool.end(); });
}

type Role = "admin" | "participant" | "anonymous";

async function serve(options: { authKind: string; role: Role; withAccount?: boolean }) {
  const room = await api!.createProjectWithName("auto-accept-room");
  const lifecycle: string[] = [];
  const updated: string[] = [];
  const events = new EventEmitter();
  events.on("task:updated", (event: { task: { status: string } }) => updated.push(event.task.status));
  const deps = {
    taskEvents: events,
    resolveCanonicalRoomRequestId: async (id: string) => id,
    resolveRoomOrReply: async () => room,
    requireParticipant: async () => true,
    resolveProjectRole: async () => options.role,
    normalizeOptionalString: (v: unknown) => (typeof v === "string" ? v.trim() || null : null),
    enforceFocusParentBoardWriteIsolation: async () => ({ kind: "allow" }),
    enforceTaskAdmissionCoordination: async () => ({ kind: "allow" }),
    isTrustedAgentCreator: async () => false,
    emitTaskLifecycleStatusMessage: async (_id: string, task: { status: string }) => { lifecycle.push(task.status); },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const r = req as { authKind?: string; sessionAccount?: unknown };
    r.authKind = options.authKind;
    r.sessionAccount = options.withAccount === false ? null : { account_id: "acct_1", login: "owner" };
    next();
  });
  registerTaskListAndCreateRoutes!(app, deps as never);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  const post = async (body: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${port}/rooms/${encodeURIComponent(room.id)}/tasks`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const workerBody = async () => {
    await client!.pool.query(
      "INSERT INTO accounts (id, provider, provider_user_id, login, display_name, created_at, updated_at) VALUES ('acct_1','github','gh-1','owner','Owner', now(), now()) ON CONFLICT DO NOTHING");
    const session = await api!.createRoomAgentSession({
      room_id: room.id, session_kind: "worker", runtime: "codex", actor_label: "Worker | Owner's agent | Agent",
      agent_key: "owner/worker", agent_instance_id: "instance_1", display_name: "Worker",
      owner_account_id: "acct_1", owner_label: "Owner", ide_label: "Agent",
    });
    return { agent_session_id: session.session_id, agent_session_token: session.session_token };
  };
  return { post, workerBody, lifecycle, updated, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("an admin human's new task is accepted with the same side effects as auto-accept", { skip }, async () => {
  const h = await serve({ authKind: "session", role: "admin" });
  try {
    const reply = await h.post({ title: "Owner task", created_by: "human" });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.status, "accepted");
    assert.deepEqual(h.lifecycle, ["accepted"]);
    assert.deepEqual(h.updated, ["accepted"]);
    assert.equal((await api!.getTaskById((reply.body.room_id as string), reply.body.id as string))!.status, "accepted");
  } finally { await h.close(); }
});

test("a non-admin human's new task stays proposed", { skip }, async () => {
  const h = await serve({ authKind: "session", role: "participant" });
  try {
    const reply = await h.post({ title: "Member task", created_by: "human" });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.status, "proposed");
    assert.deepEqual(h.lifecycle, []);
  } finally { await h.close(); }
});

test("agent credentials stay proposed even with created_by human and an admin role", { skip }, async () => {
  const h = await serve({ authKind: "owner_token", role: "admin" });
  try {
    const reply = await h.post({ title: "Agent task", created_by: "human", ...await h.workerBody() });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.status, "proposed");
    assert.deepEqual(h.lifecycle, []);
  } finally { await h.close(); }
});

test("a session write that names an agent session stays proposed", { skip }, async () => {
  const h = await serve({ authKind: "session", role: "admin" });
  try {
    const reply = await h.post({ title: "Agent via session", created_by: "human", agent_session_id: "ras_1" });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.status, "proposed");
  } finally { await h.close(); }
});
