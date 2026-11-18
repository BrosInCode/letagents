import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { Job } from "../../../shared/api/jobs.mjs";

// LetAgents API jobs end to end: /api/v1 for people, the agent routes the
// MCP tools call, real message routing and the database.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
delete process.env.LETAGENTS_BASE_URL;
delete process.env.PUBLIC_API_URL;
process.env.LETAGENTS_JEV_ROUTING = "off";
// Worker sessions get a bearer, so an agent can call /api/v1 as itself.
process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "1";

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the /api/v1 jobs DB tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const api = testDatabaseUrl ? await import("../db.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const members = testDatabaseUrl ? await import("../db/room-members.js") : null;
const utils = testDatabaseUrl ? await import("../db/utils.js") : null;
const events = testDatabaseUrl ? await import("../server/events.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;
const mentionEvents = testDatabaseUrl ? await import("../rooms/mention-events.js") : null;
const jobService = testDatabaseUrl ? await import("../jobs/service.js") : null;
const jobStore = testDatabaseUrl ? await import("../db/api-jobs.js") : null;
const policies = testDatabaseUrl ? await import("../v1/policy.js") : null;
const jobPolicy = testDatabaseUrl ? await import("../jobs/policy.js") : null;

type Person = { id: string; login: string; cookie: string; token: string };
type Agent = { key: string; session_id: string; session_token: string; bearer: string | null };

let server: Server | null = null;
let origin = "";
let ada: Person;
let bob: Person;
let roomId = "";
let lonelyRoomId = "";
let agents: Agent[] = [];
const invalidations: Array<{ projectId: string; resource: string }> = [];
const onInvalidated = (event: { projectId: string; resource: string }) => { invalidations.push(event); };
const mentions: Array<{ messageId: string; targetAccountIds: readonly string[] }> = [];
const onMention = (event: { messageId: string; targetAccountIds: readonly string[] }) => { mentions.push(event); };

async function person(login: string): Promise<Person> {
  const account = await accountSessions!.upsertAccount({ provider: "github", provider_user_id: `jobs-${login}`, login, display_name: login });
  const session = `jobs-session-${login}`;
  await accountSessions!.createSession(account.id, session, new Date(Date.now() + 60 * 60_000).toISOString(), null);
  const token = `jobs_owner_token_${login}`;
  await ownerTokens!.createOwnerToken({ accountId: account.id, githubUserId: `jobs-${login}`, token });
  return { id: account.id, login, cookie: `letagents_session=${session}`, token };
}

async function agent(room: string, owner: Person, name: string, online: boolean): Promise<Agent> {
  const session = await api!.createRoomAgentSession({
    room_id: room, session_kind: "worker", runtime: "claude-code", actor_label: name, display_name: name,
    agent_key: `${owner.login}/${name.toLowerCase()}`, owner_account_id: owner.id, owner_label: owner.login, ide_label: "Agent",
  });
  if (online) {
    await api!.markRoomAgentDeliveryConnected({
      room_id: room, actor_label: name, agent_key: session.agent_key, agent_session_id: session.session_id,
      session_kind: "worker", display_name: name, transport: "long_poll",
      credential_fence: { kind: "session_token", token_hash: utils!.hashToken(session.session_token) },
    });
  }
  return { key: session.agent_key, session_id: session.session_id, session_token: session.session_token, bearer: session.worker_bearer };
}

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });

    ada = await person("ada");
    bob = await person("bob");
    const room = await api!.createProjectWithName("api-v1-jobs");
    roomId = room.id;
    await members!.addRoomMember({ roomId, accountId: ada.id, addedVia: "creator" });
    await api!.assignProjectAdmin(roomId, ada.id);
    await members!.addRoomMember({ roomId, accountId: bob.id, addedVia: "seed" });
    // Three agents, so a person's message that names nobody wakes nobody.
    agents = [await agent(roomId, ada, "Cedar", true), await agent(roomId, ada, "Fern", true), await agent(roomId, ada, "Moss", false)];

    const lonely = await api!.createProjectWithName("api-v1-jobs-lonely");
    lonelyRoomId = lonely.id;
    await members!.addRoomMember({ roomId: lonelyRoomId, accountId: ada.id, addedVia: "creator" });
    // A session that was never ended, and whose agent left long ago.
    await agent(lonelyRoomId, ada, "Gone", false);

    events!.roomResourceEvents.on("room_resource:invalidated", onInvalidated);
    mentionEvents!.roomMentionEvents.on(mentionEvents!.ROOM_MENTION_CREATED, onMention);
    server = appModule!.createApiApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  test.after(async () => {
    events!.roomResourceEvents.off("room_resource:invalidated", onInvalidated);
    mentionEvents!.roomMentionEvents.off(mentionEvents!.ROOM_MENTION_CREATED, onMention);
    routesModule!.closeApiRouteEventBroker();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    // Let committed routing wakes start their reads before closing the pool.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await dbClient!.pool.end();
  });
}

const v1 = (room: string, suffix = "") => `${origin}/api/v1/rooms/${encodeURIComponent(room)}/jobs${suffix}`;
const agentRoute = (room: string, suffix: string) => `${origin}/rooms/${encodeURIComponent(room)}/jobs/${suffix}`;

async function call(url: string, init: { method?: string; cookie?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(url, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...(init.cookie ? { cookie: init.cookie, origin } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

const start = (who: Person, body: Record<string, unknown>, room = roomId) => call(v1(room), { cookie: who.cookie, body });

/** Another member. The job rate class allows 10 starts a minute per person, so each test below brings its own. */
async function member(login: string, room = roomId): Promise<Person> {
  const someone = await person(login);
  await members!.addRoomMember({ roomId: room, accountId: someone.id, addedVia: "seed" });
  return someone;
}

/** An agent reports through the routes the MCP tools call, with its own session credentials. */
const report = (who: Agent, jobId: string, action: "progress" | "complete", body: Record<string, unknown>) =>
  call(agentRoute(roomId, `${jobId}/${action}`), {
    token: ada.token,
    body: { ...body, agent_session_id: who.session_id, agent_session_token: who.session_token },
  });

async function rootMessage(jobId: string) {
  const { rows } = await dbClient!.pool.query<{ number: number; text: string; source: string; publisher_account_id: string; thread_root_number: number | null }>(
    "SELECT number, text, source, publisher_account_id, thread_root_number FROM messages WHERE room_id = $1 AND client_message_id = $2",
    [roomId, `internal:job:${jobId}`],
  );
  return rows[0] ?? null;
}

async function receiptKeys(room: string, number: number): Promise<string[]> {
  const { rows } = await dbClient!.pool.query<{ agent_key: string }>(
    "SELECT agent_key FROM message_agent_receipts WHERE message_room_id = $1 AND message_number = $2 ORDER BY agent_key",
    [room, number],
  );
  return rows.map((row) => row.agent_key);
}

async function waitForJobsInvalidation(room: string, since: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (invalidations.slice(since).some((event) => event.projectId === room && event.resource === "jobs")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`no jobs invalidation for ${room}`);
}

test("with no agent online the job is no_agent and nothing is posted", { skip }, async () => {
  const before = invalidations.length;
  const { status, body } = await start(ada, { instruction: "Summarize the release notes" }, lonelyRoomId);
  assert.equal(status, 200);
  assert.ok(Job.safeParse(body).success);
  assert.equal(body.state, "no_agent");
  assert.equal(body.agent, null);
  assert.equal(body.messageId, null);
  const { rows } = await dbClient!.pool.query("SELECT 1 FROM messages WHERE room_id = $1", [lonelyRoomId]);
  assert.equal(rows.length, 0, "an open but silent session does not count as online");
  await waitForJobsInvalidation(lonelyRoomId, before);
});

test("the job posts one thread root as the person, with the exact mention and the reserved id, and wakes only that agent", { skip }, async () => {
  const { status, body } = await start(ada, { agent: agents[1]!.key, instruction: "Rebase PR 12 on staging", input: { pr: 12 } });
  assert.equal(status, 200);
  assert.equal(body.state, "queued");
  assert.equal(body.agent, agents[1]!.key);
  assert.deepEqual(body.createdBy, { principal: { kind: "person", id: ada.id } });
  const root = await rootMessage(body.id);
  assert.ok(root);
  assert.equal(body.messageId, `msg_${root.number}`);
  assert.equal(root.text, `@agent:${agents[1]!.key} Rebase PR 12 on staging\n\nJob ${body.id} · via API`);
  assert.equal(root.source, "browser");
  assert.equal(root.publisher_account_id, ada.id);
  assert.equal(root.thread_root_number, null, "the job's message is a thread root");
  assert.deepEqual(await receiptKeys(roomId, root.number), [agents[1]!.key]);

  // A person's follow-up in the job's thread reaches the job's agent, as any thread reply reaches the root's audience.
  const followUp = await api!.addMessageWithCreateStatus(roomId, ada.login, "Use the squash merge.", {
    source: "browser", account_id: ada.id,
    thread_root_message_id: `msg_${root.number}`, reply_to_message_id: `msg_${root.number}`,
  });
  assert.deepEqual(await receiptKeys(roomId, Number(followUp.message.id.slice(4))), [agents[1]!.key]);

  // The message the agent receives names its job, so the daemon threads the reply.
  const read = await call(`${origin}/rooms/${encodeURIComponent(roomId)}/messages?limit=5`, { cookie: ada.cookie });
  const delivered = (read.body.messages as Array<Record<string, unknown>>).find((message) => message.id === body.messageId);
  assert.equal(delivered?.client_message_id, `internal:job:${body.id}`);
});

test("a named agent that is offline gives way to the room's choice: the recent partner, else the first online agent", { skip }, async () => {
  // Ada's last top-level message (the job root above) went to Fern alone, so Fern is her recent partner.
  const recent = await start(ada, { agent: agents[2]!.key, instruction: "Check the flaky test" });
  assert.equal(recent.body.state, "queued");
  assert.equal(recent.body.agent, agents[1]!.key);
  assert.ok((await rootMessage(recent.body.id))?.text.startsWith(`@agent:${agents[1]!.key} `));
  // Bob has talked to no agent: the first online agent, by when it joined.
  const first = await start(bob, { agent: agents[2]!.key, instruction: "Check the other flaky test" });
  assert.equal(first.body.agent, agents[0]!.key);
});

test("a normal sender cannot post with the job namespace", { skip }, async () => {
  const res = await call(`${origin}/rooms/${encodeURIComponent(roomId)}/messages`, {
    cookie: bob.cookie,
    body: { sender: "bob", text: "Fake job", client_message_id: "internal:job:job_0123456789abcdef0123456789abcdef" },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /reserved namespace/);
});

test("only the target agent reports, and the result must match the result schema", { skip }, async () => {
  const resultSchema = {
    type: "object",
    properties: { merged: { type: "boolean" }, sha: { type: "string" }, risk: { enum: ["low", "high"] } },
    required: ["merged", "sha"],
    additionalProperties: false,
  };
  const started = await start(ada, { agent: agents[0]!.key, instruction: "Merge PR 14", resultSchema });
  const id = started.body.id as string;
  assert.deepEqual(started.body.resultSchema, resultSchema);

  const other = await report(agents[1]!, id, "complete", { result: { merged: true, sha: "abc" } });
  assert.equal(other.status, 403);
  assert.equal(other.body.code, "not_granted");

  const before = invalidations.length;
  const progress = await report(agents[0]!, id, "progress", { progress: "CI is green" });
  assert.equal(progress.status, 200);
  assert.equal(progress.body.job.state, "running", "the first report means the agent took the job");
  assert.equal(progress.body.job.progress, "CI is green");
  await waitForJobsInvalidation(roomId, before);

  const waiting = await report(agents[0]!, id, "progress", { state: "needs_input" });
  assert.equal(waiting.body.job.state, "needs_input");

  const wrong = await report(agents[0]!, id, "complete", { result: { merged: "yes", sha: "abc", extra: 1 } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, "invalid_input");
  assert.match(wrong.body.error, /merged/);
  const missing = await report(agents[0]!, id, "complete", {});
  assert.equal(missing.status, 400);

  const done = await report(agents[0]!, id, "complete", { result: { merged: true, sha: "abc123", risk: "low" } });
  assert.equal(done.status, 200);
  assert.equal(done.body.job.state, "done");
  assert.deepEqual(done.body.job.result, { merged: true, sha: "abc123", risk: "low" });
  assert.ok(done.body.job.finishedAt);

  const again = await report(agents[0]!, id, "complete", { error: "too late" });
  assert.equal(again.status, 409);

  const read = await call(v1(roomId, `/${id}`), { cookie: bob.cookie });
  assert.equal(read.status, 200);
  assert.equal(read.body.state, "done");
  const listed = await call(v1(roomId, "?state=done&limit=5"), { cookie: bob.cookie });
  assert.deepEqual(listed.body.jobs.map((job: { id: string }) => job.id), [id]);

  const read_by_agent = await call(agentRoute(roomId, id), { token: ada.token });
  assert.equal(read_by_agent.body.job.id, id);
});

test("a result schema outside the supported subset is refused", { skip }, async () => {
  const res = await start(ada, { instruction: "x", resultSchema: { type: "string", pattern: "^(a+)+$" } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "invalid_input");
});

test("the agent can fail a job with an error", { skip }, async () => {
  const { body } = await start(ada, { agent: agents[0]!.key, instruction: "Deploy to prod" });
  const failed = await report(agents[0]!, body.id, "complete", { error: "I have no deploy rights here." });
  assert.equal(failed.body.job.state, "failed");
  assert.equal(failed.body.job.error, "I have no deploy rights here.");
});

test("the creator or a room admin may cancel; anyone else may not; a finished job cannot be cancelled", { skip }, async () => {
  const mine = await start(ada, { instruction: "Write the changelog" });
  const refused = await call(v1(roomId, `/${mine.body.id}/cancel`), { cookie: bob.cookie, body: {} });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "not_granted");

  const before = invalidations.length;
  const cancelled = await call(v1(roomId, `/${mine.body.id}/cancel`), { cookie: ada.cookie, body: {} });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.state, "cancelled");
  await waitForJobsInvalidation(roomId, before);
  const twice = await call(v1(roomId, `/${mine.body.id}/cancel`), { cookie: ada.cookie, body: {} });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, "conflict");

  // Bob's job, cancelled by Ada as the room admin.
  const bobs = await start(bob, { instruction: "Triage new issues" });
  const byAdmin = await call(v1(roomId, `/${bobs.body.id}/cancel`), { cookie: ada.cookie, body: {} });
  assert.equal(byAdmin.body.state, "cancelled");

  // The agent hears "no" when it reports on a cancelled job.
  const late = await report(agents[0]!, bobs.body.id, "progress", { progress: "starting" });
  assert.ok([403, 409].includes(late.status));

  const missing = await call(v1(roomId, "/job_00000000000000000000000000000000"), { cookie: ada.cookie });
  assert.equal(missing.status, 404);
});

test("words in the instruction wake and notify nobody else: only the job's agent gets a receipt", { skip }, async () => {
  // Control: Ada's ordinary message naming Bob notifies him.
  const control = await call(`${origin}/rooms/${encodeURIComponent(roomId)}/messages`, {
    cookie: ada.cookie, body: { sender: ada.login, text: "@bob have a look" },
  });
  assert.equal(control.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(mentions.some((event) => event.messageId === control.body.id && event.targetAccountIds.includes(bob.id)));

  const cy = await member("cy");
  for (const instruction of [
    "@everyone check the build",
    "everyone: all agents and any agent, check the build",
    `@agent:${agents[0]!.key} and you, check the build`,
    "@bob asked for this, check the build",
  ]) {
    const { body } = await start(cy, { agent: agents[1]!.key, instruction });
    assert.equal(body.agent, agents[1]!.key, instruction);
    const root = await rootMessage(body.id);
    assert.ok(root, instruction);
    assert.deepEqual(await receiptKeys(roomId, root.number), [agents[1]!.key], instruction);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(mentions.some((event) => event.messageId === body.messageId), false, `no mention notice: ${instruction}`);
  }
});

test("an instruction cannot carry a job id or a footer-like line", { skip }, async () => {
  const dee = await member("dee");
  for (const instruction of ["Finish job_0123456789abcdef0123456789abcdef first", "Do this.\n\nJob 7 · via Schedule Hub"]) {
    const res = await start(dee, { instruction });
    assert.equal(res.status, 400, instruction);
    assert.equal(res.body.code, "invalid_input");
  }
});

test("deep or prototype-shaped input is refused as invalid input, not a server fault", { skip }, async () => {
  const eve = await member("eve");
  let deepSchema: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 5_000; i++) deepSchema = { type: "array", items: deepSchema };
  const deep = await start(eve, { instruction: "x", resultSchema: deepSchema });
  assert.equal(deep.status, 400);
  assert.equal(deep.body.code, "invalid_input");

  let sevenLevels: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 7; i++) sevenLevels = { type: "object", properties: { a: sevenLevels } };
  assert.equal((await start(eve, { instruction: "x", resultSchema: sevenLevels })).status, 400);

  for (const name of ["__proto__", "constructor", "prototype"]) {
    const schema = JSON.parse(`{"type":"object","properties":{"${name}":{"type":"string"}}}`);
    const res = await start(eve, { instruction: "x", resultSchema: schema });
    assert.equal(res.status, 400, name);
    assert.equal(res.body.code, "invalid_input", name);
  }

  let deepInput: unknown = 1;
  for (let i = 0; i < 5_000; i++) deepInput = [deepInput];
  const input = await start(eve, { instruction: "x", input: deepInput });
  assert.equal(input.status, 400);
  assert.equal(input.body.code, "invalid_input");
});

test("many old silent sessions do not hide a live agent", { skip }, async () => {
  const room = await api!.createProjectWithName("api-v1-jobs-crowded");
  const fay = await member("fay", room.id);
  for (let i = 0; i < 205; i++) await agent(room.id, fay, `Stale${i}`, false);
  const live = await agent(room.id, fay, "Live", true);
  const { body } = await start(fay, { instruction: "Anyone there?" }, room.id);
  assert.equal(body.state, "queued");
  assert.equal(body.agent, live.key);
});

test("through a page, only jobs that page started can be cancelled", { skip }, async () => {
  const page = { kind: "page" as const, id: "page_schedule_hub", version: 3 };
  const now = new Date().toISOString();
  const row = (id: string, via: typeof page | null) => ({
    id, room_id: roomId, principal_kind: "person" as const, principal_id: ada.id,
    via_kind: via?.kind ?? null, via_id: via?.id ?? null, via_version: via?.version ?? null,
    target_agent_key: agents[0]!.key, instruction: "x", input: null, result_schema: null, state: "queued" as const,
    progress: null, result: null, error: null, root_message_number: null, created_at: now, updated_at: now, finished_at: null,
  });
  const direct = jobService!.newJobId();
  const viaPage = jobService!.newJobId();
  await jobStore!.insertApiJob(row(direct, null));
  await jobStore!.insertApiJob(row(viaPage, page));
  const actor = { principal: { kind: "person" as const, id: ada.id }, via: { ...page, version: 4 }, roomId };
  const isRoomAdmin = async () => true;
  await assert.rejects(jobService!.cancelJob({ roomId, id: direct, actor, isRoomAdmin }), { code: "not_granted" });
  const cancelled = await jobService!.cancelJob({ roomId, id: viaPage, actor, isRoomAdmin });
  assert.equal(cancelled.state, "cancelled");
  // Bob's page cannot cancel Ada's page job.
  const other = jobService!.newJobId();
  await jobStore!.insertApiJob(row(other, page));
  await assert.rejects(jobService!.cancelJob({
    roomId, id: other, actor: { principal: { kind: "person", id: bob.id }, via: page, roomId }, isRoomAdmin,
  }), { code: "not_granted" });
});

test("the room's jobs.start policy decides: deny and approve refuse, allow starts", { skip }, async () => {
  const gus = await member("gus");
  for (const mode of ["deny", "approve"] as const) {
    await policies!.setRoomPolicy({ roomId, capability: "jobs.start", mode, accountId: ada.id });
    const res = await start(gus, { instruction: "Tidy the board" });
    assert.equal(res.status, 403, mode);
    assert.equal(res.body.code, "not_granted", mode);
    if (mode === "approve") assert.match(res.body.message, /approval/);
  }
  await policies!.setRoomPolicy({ roomId, capability: "jobs.start", mode: "allow", accountId: ada.id });
  assert.equal((await start(gus, { instruction: "Tidy the board" })).status, 200);
  await policies!.setRoomPolicy({ roomId, capability: "jobs.start", mode: null, accountId: ada.id });
});

test("confirm passes for a page call, whose confirm sheet ran in the app; an agent never starts a job", { skip }, async () => {
  const page = { principal: { kind: "person" as const, id: "acct" }, via: { kind: "page" as const, id: "page_x", version: 1 }, roomId: "room" };
  const policy = (mode: "allow" | "confirm" | "approve" | "deny") => async () =>
    ({ capability: "jobs.start" as const, mode, configured: mode, source: "room" as const, rule: null });
  await jobPolicy!.requireJobStartAllowed(page, "room", policy("confirm"));
  await jobPolicy!.requireJobStartAllowed(page, "room", policy("allow"));
  await assert.rejects(jobPolicy!.requireJobStartAllowed(page, "room", policy("approve")), { code: "not_granted" });
  await assert.rejects(jobPolicy!.requireJobStartAllowed(page, "room", policy("deny")), { code: "not_granted" });
  const agentActor = { principal: { kind: "agent" as const, id: "ada/cedar" }, roomId: "room" };
  await assert.rejects(jobPolicy!.requireJobStartAllowed(agentActor, "room", policy("allow")), { code: "not_granted" });
});

test("an agent reads jobs through /api/v1 in its own room but cannot start or cancel one", { skip }, async () => {
  const bearer = agents[0]!.bearer;
  assert.ok(bearer, "worker sessions carry a bearer in this test");
  const listed = await call(v1(roomId, "?limit=1"), { token: bearer });
  assert.equal(listed.status, 200);
  const count = async () => Number((await dbClient!.pool.query("SELECT count(*) FROM api_jobs WHERE room_id = $1", [roomId])).rows[0].count);
  const before = await count();
  // The worker bearer route check refuses the write before the API sees it;
  // requireJobStartAllowed refuses an agent too, behind it (tested above).
  const started = await call(v1(roomId), { token: bearer, body: { instruction: "Do my work for me" } });
  assert.equal(started.status, 403);
  assert.equal(await count(), before, "no job was made");
  const job = listed.body.jobs[0] as { id: string };
  const cancelled = await call(v1(roomId, `/${job.id}/cancel`), { token: bearer, body: {} });
  assert.equal(cancelled.status, 403);
});

test("a supervised agent reports on its job with its worker bearer alone", { skip }, async () => {
  const hal = await member("hal");
  const { body } = await start(hal, { agent: agents[0]!.key, instruction: "Count open PRs", resultSchema: { type: "integer" } });
  const bearer = agents[0]!.bearer!;
  const read = await call(agentRoute(roomId, body.id), { token: bearer });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.job.resultSchema, { type: "integer" });
  const progress = await call(agentRoute(roomId, `${body.id}/progress`), { token: bearer, body: { progress: "Counting" } });
  assert.equal(progress.status, 200);
  assert.equal(progress.body.job.state, "running");
  const otherBearer = agents[1]!.bearer!;
  assert.equal((await call(agentRoute(roomId, `${body.id}/complete`), { token: otherBearer, body: { result: 3 } })).status, 403);
  const done = await call(agentRoute(roomId, `${body.id}/complete`), { token: bearer, body: { result: 3 } });
  assert.equal(done.status, 200);
  assert.equal(done.body.job.state, "done");
});
