import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import type { TrackerConnectionRow } from "../connectors/store.js";
import type { BoardIntent, Project, Task } from "../db/types.js";
import type { AuthenticatedRequest } from "../http/helpers.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerJevLinkRoutes, respondToJevLinkIntentDecision } = await import("../routes/rooms/jev-links.js");
const { registerTrackerRuleRoutes } = await import("../routes/account/connectors/rules.js");

type Who = "session" | "owner_token" | "agent_session" | "anonymous";
const PR_URL = "https://github.com/BrosInCode/letagents/pull/91";

function authAs(req: AuthenticatedRequest, who: Who) {
  if (who === "anonymous") return;
  req.authKind = who;
  req.sessionAccount = who === "agent_session" ? null : { account_id: "acct_1", login: "emmy" } as AuthenticatedRequest["sessionAccount"];
  req.headers.authorization = "Bearer test-token";
}

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body: unknown, who: Who = "session") => {
    const response = await fetch(`${base}${path}`, {
      method: "POST", headers: { "x-test-auth": who, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) as any };
  };
  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

function decisions() {
  const calls: string[] = [];
  const task = { id: "task_7", room_id: "room-1" } as Task;
  return {
    calls,
    jevLinks: async () => ({
      acceptLink: async () => { calls.push("accept"); return task; },
      rejectLink: async () => { calls.push("reject"); return task; },
      approveIntent: async () => { calls.push("approve"); return { intent: {} as never, task, run: { status: "started" as const } }; },
      denyIntent: async () => { calls.push("deny"); return { intent: {} as BoardIntent, detached: true }; },
    }),
  };
}

test("only a room admin signed in to the app may accept or reject a Jev link", async () => {
  const fake = decisions();
  const app = express();
  app.use(express.json());
  app.use((req: AuthenticatedRequest, _res, next) => { authAs(req, (req.headers["x-test-auth"] as Who) ?? "anonymous"); next(); });
  registerJevLinkRoutes(app, {
    resolveCanonicalRoomRequestId: async (id) => id,
    resolveRoomOrReply: async (id) => ({ id } as Project),
    // Owner tokens are admin too: the route must still refuse them.
    requireAdmin: async (req, res) => {
      if (!req.authKind) { res.status(401).json({ error: "sign in" }); return false; }
      return true;
    },
    jevLinks: fake.jevLinks,
  });
  const server = await listen(app);
  try {
    const path = "/rooms/room-1/tasks/task_7/jev-link/accept";
    assert.equal((await server.call(path, { pr_url: PR_URL }, "anonymous")).status, 401);
    const agent = await server.call(path, { pr_url: PR_URL }, "owner_token");
    assert.equal(agent.status, 403);
    assert.equal(agent.json.code, "jev_link_person_required");
    assert.equal((await server.call(path, { pr_url: PR_URL }, "agent_session")).status, 403);
    assert.equal((await server.call(path, { pr_url: "https://evil.example/pull/1" })).status, 400);
    assert.deepEqual(fake.calls, [], "nothing ran for a refused request");
    assert.equal((await server.call(path, { pr_url: PR_URL })).status, 200);
    assert.equal((await server.call("/rooms/room-1/tasks/task_7/jev-link/reject", { pr_url: PR_URL })).status, 200);
    assert.deepEqual(fake.calls, ["accept", "reject"]);
  } finally {
    await server.close();
  }
});

test("a Jev intent is decided by a person only: never the Board Manager or an agent token", async () => {
  const fake = decisions();
  const app = express();
  app.use(express.json());
  app.use((req: AuthenticatedRequest, _res, next) => { authAs(req, (req.headers["x-test-auth"] as Who) ?? "anonymous"); next(); });
  app.post("/decide", async (req: AuthenticatedRequest, res) => {
    const body = req.body as { manager?: boolean };
    await respondToJevLinkIntentDecision({
      req, res, project: { id: "room-1" } as Project, intent: { id: "bi_1" } as BoardIntent, decision: "approve",
      decisionBy: "emmy", reason: null, workerIdentity: body.manager ? { agent_session_id: "s1" } : null, deps: { jevLinks: fake.jevLinks },
    });
  });
  const server = await listen(app);
  try {
    assert.equal((await server.call("/decide", { manager: true })).status, 403, "the Board Manager cannot approve");
    assert.equal((await server.call("/decide", {}, "owner_token")).status, 403, "an agent's owner token cannot approve");
    assert.deepEqual(fake.calls, []);
    const approved = await server.call("/decide", {});
    assert.equal(approved.status, 200);
    assert.equal(approved.json.result.kind, "tracker_jev_link_confirmed");
    assert.deepEqual(fake.calls, ["approve"]);
  } finally {
    await server.close();
  }
});

test("rule drafting needs the connection's Jev switch and never saves", async () => {
  const CONNECTION = "tcon_00000000-0000-0000-0000-000000000001";
  let jevOn = false;
  const drafts: string[] = [];
  const app = express();
  app.use(express.json());
  app.use((req: AuthenticatedRequest, _res, next) => { authAs(req, (req.headers["x-test-auth"] as Who) ?? "anonymous"); next(); });
  const created: unknown[] = [];
  registerTrackerRuleRoutes(app, {
    connections: { get: async (id) => (id === CONNECTION ? { id, account_id: "acct_1", provider: "jira", status_map: {}, jev_linking_enabled: jevOn } as unknown as TrackerConnectionRow : null) },
    rules: { create: async (...args: unknown[]) => { created.push(args); return null as never; } } as never,
    draftRule: async (input) => {
      drafts.push(input.sentence);
      return { draft: { name: input.sentence, room_id: null, trigger: { event: "pull_request", action: "opened" }, actions: [{ kind: "transition", toStatus: "In Review" }] }, error: null };
    },
  });
  const server = await listen(app);
  try {
    const path = `/account/connectors/${CONNECTION}/rules/draft`;
    const off = await server.call(path, { sentence: "When a PR opens, move it to In Review" });
    assert.equal(off.status, 409);
    assert.equal(off.json.code, "jev_disabled");
    assert.deepEqual(drafts, [], "the switch off means no Jev call");
    jevOn = true;
    assert.equal((await server.call(path, { sentence: "" })).status, 400);
    assert.equal((await server.call(path, { sentence: "x".repeat(501) })).status, 400);
    assert.equal((await server.call(path, { sentence: "When a PR opens, move it to In Review" }, "owner_token")).status, 403);
    const drafted = await server.call(path, { sentence: "When a PR opens, move it to In Review" });
    assert.equal(drafted.status, 200);
    assert.equal(drafted.json.draft.actions[0].toStatus, "In Review");
    assert.deepEqual(created, [], "a draft is never saved");
  } finally {
    await server.close();
  }
});
