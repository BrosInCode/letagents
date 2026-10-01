import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const client = url ? await import("../db/client.js") : null;
const api = url ? await import("../db.js") : null;
const schema = url ? await import("../db/schema.js") : null;
const store = url ? await import("../db/wake-rules.js") : null;
const service = url ? await import("../wake-rules/service.js") : null;
const scheduler = url ? await import("../wake-rules/scheduler.js") : null;
const skip = { skip: !url && "set TEST_DB_URL to run wake rule persistence tests" };

test.beforeEach(async () => {
  if (!client) return;
  await client.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.pool.query("CREATE SCHEMA public");
  await migrate(client.db, { migrationsFolder: path.resolve("drizzle") });
});
test.after(async () => { await client?.pool.end(); });

async function seed(name = "wake-room") {
  const room = await api!.createProjectWithName(name);
  const now = new Date().toISOString();
  const ownerId = `owner-${name}`;
  await client!.db.insert(schema!.accounts).values({
    id: ownerId, provider: "github", provider_user_id: ownerId, login: ownerId, created_at: now, updated_at: now,
  });
  const sessions = [];
  for (const label of ["Fable", "Ada"]) sessions.push(await api!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "claude-code", actor_label: label,
    agent_key: `${ownerId}/${label.toLowerCase()}`, display_name: label,
    owner_account_id: ownerId, owner_label: ownerId, ide_label: "Agent",
  }));
  const agent = (index: number) => ({
    agent_key: sessions[index]!.agent_key, agent_name: sessions[index]!.display_name, session_id: sessions[index]!.session_id,
  });
  return { room, ownerId, sessions, agent };
}

async function receipts(roomId: string, messageNumber: number) {
  return (await client!.pool.query(
    "SELECT agent_key, activation_reason FROM message_agent_receipts WHERE message_room_id = $1 AND message_number = $2",
    [roomId, messageNumber],
  )).rows;
}

async function row(ruleId: string) {
  const [found] = await client!.db.select().from(schema!.agent_wake_rules)
    .where((await import("drizzle-orm")).eq(schema!.agent_wake_rules.id, ruleId));
  return found!;
}

test("a wake is one message addressed to one agent, committed with the rule", skip, async () => {
  const { room, agent } = await seed();
  const { rule } = await service!.addWakeRuleForAgent({
    roomId: room.id, agent: agent(0),
    body: { event: "timer", arguments: { after_ms: 60_000 }, note: "check the deploy" },
  });
  const pending = await row(rule.id);
  const due = new Date(Date.parse(rule.arguments.at!) + 1000);
  await scheduler!.checkWakeRules([pending], due);

  const fired = await row(rule.id);
  assert.equal(fired.status, "fired");
  assert.equal(fired.fire_count, 1);
  assert.ok(fired.wake_message_number);
  const message = await api!.getMessageById(room.id, `msg_${fired.wake_message_number}`);
  assert.equal(message?.source, "wake_rule");
  assert.equal(message?.sender, "letagents");
  assert.equal(message?.display_text, "Fable woke up · Scheduled check-in");
  assert.match(message!.text, /Your note: check the deploy/);
  // Only the waiting agent is woken, and people get no push for it.
  assert.deepEqual(await receipts(room.id, fired.wake_message_number!), [{ agent_key: agent(0).agent_key, activation_reason: "wake_rule" }]);
  assert.equal((await client!.pool.query("SELECT count(*)::int AS n FROM desktop_push_notifications")).rows[0].n, 0);
});

test("two instances waking the same rule produce one message", skip, async () => {
  const { room, agent } = await seed();
  const { rule } = await service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body: { event: "timer", arguments: { after_ms: 60_000 } } });
  const pending = await row(rule.id);
  const results = await Promise.all([
    scheduler!.deliverWakeRule(pending, { kind: "fire", facts: {}, cursorAt: new Date().toISOString(), baseline: null }),
    scheduler!.deliverWakeRule(pending, { kind: "fire", facts: {}, cursorAt: new Date().toISOString(), baseline: null }),
  ]);
  assert.ok(results.includes(true));
  const wakes = (await client!.pool.query("SELECT count(*)::int AS n FROM messages WHERE room_id = $1 AND source = 'wake_rule'", [room.id])).rows[0].n;
  assert.equal(wakes, 1);
  assert.equal((await row(rule.id)).fire_count, 1);
});

test("a cancelled rule never wakes, and undo restores it within the window", skip, async () => {
  const { room, agent } = await seed();
  const { rule } = await service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body: { event: "github.pr_closed", arguments: { pr: 5 } } }).catch(async (error) => {
    // Rooms without a repository refuse GitHub rules; bind one for this test.
    assert.match(String(error), /not connected to a GitHub repository/);
    const now = new Date().toISOString();
    await client!.db.insert(schema!.room_git_bindings).values({
      room_id: room.id, provider: "github", host: "github.com", repository_full_name: "org/repo", repository_owner: "org",
      repository_name: "repo", ref_type: "default_branch", source: "manual", created_at: now, updated_at: now,
    });
    return service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body: { event: "github.pr_closed", arguments: { pr: 5 } } });
  });
  const person = { kind: "human" as const, id: "acct", label: "EmmyMay" };
  const before = await row(rule.id);
  await service!.cancelWakeRuleAs(room.id, rule.id, person);
  assert.equal(await scheduler!.deliverWakeRule(before, { kind: "fire", facts: { pr: 5, merged: true }, cursorAt: new Date().toISOString(), baseline: null }), false);
  assert.equal((await client!.pool.query("SELECT count(*)::int AS n FROM messages WHERE source = 'wake_rule'")).rows[0].n, 0);

  // Another agent cannot revive a wait a person stopped.
  await assert.rejects(service!.restoreWakeRuleAs(room.id, rule.id, { kind: "agent", id: agent(0).agent_key, label: "Fable" }), /Only EmmyMay can undo/);
  const restored = await service!.restoreWakeRuleAs(room.id, rule.id, person);
  assert.equal(restored.status, "active");
  assert.equal(restored.cancelled_by, null);
  await client!.pool.query("UPDATE agent_wake_rules SET status = 'cancelled', ended_at = now() - interval '11 minutes' WHERE id = $1", [rule.id]);
  await assert.rejects(service!.restoreWakeRuleAs(room.id, rule.id, person), /can no longer be restored/);
});

test("rules are deduplicated per agent and bounded", skip, async () => {
  const { room, agent } = await seed();
  const body = { event: "timer", arguments: { at: new Date(Date.now() + 3_600_000).toISOString() } };
  const first = await service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body });
  const again = await service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body });
  assert.equal(again.created, false);
  assert.equal(again.rule.id, first.rule.id);
  assert.equal((await service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(1), body })).created, true, "another agent's identical wait is its own");
  for (let minute = 2; minute <= 20; minute += 1) {
    await service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body: { event: "timer", arguments: { after_ms: minute * 60_000 } } });
  }
  await assert.rejects(
    service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body: { event: "timer", arguments: { after_ms: 30 * 60_000 } } }),
    /already have 20 active wake rules/,
  );
  await assert.rejects(
    service!.cancelWakeRuleAs(room.id, first.rule.id, { kind: "agent", id: agent(1).agent_key, label: "Ada" }),
    /only your own/,
  );
  const page = await store!.listWakeRules(room.id, { agentKey: agent(0).agent_key });
  assert.equal(page.active.length, 20);
});

test("a task rule wakes on the status change and an unfired rule expires once", skip, async () => {
  const { room, agent } = await seed();
  const task = await api!.createTask(room.id, "Ship wake rules", "owner");
  await client!.pool.query("UPDATE tasks SET status = 'in_progress' WHERE room_id = $1 AND number = $2", [room.id, Number(task.id.slice(5))]);
  await assert.rejects(
    service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body: { event: "task.status_changed", arguments: { task_id: task.id, to: ["in_progress"] } } }),
    /already in progress/,
  );
  const { rule } = await service!.addWakeRuleForAgent({
    roomId: room.id, agent: agent(0), body: { event: "task.status_changed", arguments: { task_id: task.id, to: ["in_review"] } },
  });
  await scheduler!.checkWakeRules([await row(rule.id)]);
  assert.equal((await row(rule.id)).status, "active", "nothing changed yet");
  await client!.pool.query("UPDATE tasks SET status = 'in_review' WHERE room_id = $1 AND number = $2", [room.id, Number(task.id.slice(5))]);
  await scheduler!.checkWakeRules([await row(rule.id)]);
  const fired = await row(rule.id);
  assert.equal(fired.status, "fired");
  const message = await api!.getMessageById(room.id, `msg_${fired.wake_message_number}`);
  assert.equal(message?.display_text, `Fable woke up · ${task.id} moved to review`);

  const waiting = await service!.addWakeRuleForAgent({
    roomId: room.id, agent: agent(1), body: { event: "task.status_changed", arguments: { task_id: task.id, to: ["done"] } },
  });
  await client!.pool.query("UPDATE agent_wake_rules SET expires_at = now() - interval '1 second' WHERE id = $1", [waiting.rule.id]);
  await scheduler!.checkWakeRules([await row(waiting.rule.id)]);
  await scheduler!.checkWakeRules([await row(waiting.rule.id)]);
  const expired = await row(waiting.rule.id);
  assert.equal(expired.status, "expired");
  const notices = (await client!.pool.query(
    "SELECT display_text FROM messages WHERE room_id = $1 AND source = 'wake_rule' AND number = $2", [room.id, expired.wake_message_number],
  )).rows;
  assert.deepEqual(notices, [{ display_text: `Ada stopped waiting · ${task.id} to move to done didn't happen in time` }]);
  const recent = (await store!.listWakeRules(room.id)).recent.map((entry) => [entry.id, entry.status]);
  assert.deepEqual(recent.sort(), [[rule.id, "fired"], [waiting.rule.id, "expired"]].sort());
});

test("a CI rule sees checks recorded in the branch room of the same repository", skip, async () => {
  const { room, agent } = await seed("wake-repo-room");
  const branchRoom = await api!.createProjectWithName("wake-branch-room");
  const now = new Date().toISOString();
  for (const [roomId, refType, refName] of [[room.id, "default_branch", "main"], [branchRoom.id, "branch", "feature/billing"]] as const) {
    await client!.db.insert(schema!.room_git_bindings).values({
      room_id: roomId, provider: "github", host: "github.com", repository_full_name: "org/repo", repository_owner: "org",
      repository_name: "repo", ref_type: refType, ref_name: refName, source: "manual", created_at: now, updated_at: now,
    });
  }
  const { rule } = await service!.addWakeRuleForAgent({
    roomId: room.id, agent: agent(0),
    body: { event: "github.check_completed", arguments: { branch: "feature/billing" }, note: "merge once green" },
  });
  let sequence = 0;
  const record = (title: string, state: string, headRef = "feature/billing") => api!.insertGitHubRoomEvent({
    room_id: branchRoom.id, event_type: "check_run", action: "completed", idempotency_key: `check-${++sequence}`,
    title, state, head_ref: headRef, head_sha: "sha-1", github_object_url: `https://github.com/org/repo/runs/${sequence}`,
  });
  await record("lint", "success");
  await record("test", "failure");
  await record("other branch", "failure", "main");

  const fresh = new Date();
  await scheduler!.checkWakeRules([await row(rule.id)], fresh);
  const settling = await row(rule.id);
  assert.equal(settling.status, "active", "CI is still reporting");
  assert.ok(Date.parse(settling.next_check_at) > fresh.getTime());

  await scheduler!.checkWakeRules([await row(rule.id)], new Date(fresh.getTime() + 120_000));
  const fired = await row(rule.id);
  assert.equal(fired.status, "fired");
  const message = await api!.getMessageById(room.id, `msg_${fired.wake_message_number}`);
  assert.equal(message?.display_text, "Fable woke up · CI finished on feature/billing: 1 passed, 1 failed");
  assert.match(message!.text, /- test: failure \(https:\/\/github.com\/org\/repo\/runs\/2\)/);
  assert.doesNotMatch(message!.text, /other branch/);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function bindRepository(roomIds: readonly string[], repository = "org/repo") {
  const now = new Date().toISOString();
  await client!.pool.query(`
    INSERT INTO room_git_bindings (room_id, provider, host, repository_full_name, repository_owner, repository_name, ref_type, ref_name, source, created_at, updated_at)
    SELECT id, 'github', 'github.com', $2, split_part($2, '/', 1), split_part($2, '/', 2), 'branch', id, 'manual', $3, $3
      FROM unnest($1::text[]) AS id
  `, [roomIds, repository, now]);
}

test("the scheduler keeps its loop after a pass fails", skip, async () => {
  const { EventEmitter } = await import("node:events");
  const { room, agent } = await seed();
  const sources = { taskEvents: new EventEmitter(), githubRoomEvents: new EventEmitter(), wakeRuleEvents: new EventEmitter() };
  await client!.pool.query("ALTER TABLE agent_wake_rules RENAME TO agent_wake_rules_hidden");
  const stop = scheduler!.startWakeRuleScheduler(sources);
  try {
    await sleep(300);
    await client!.pool.query("ALTER TABLE agent_wake_rules_hidden RENAME TO agent_wake_rules");
    const { rule } = await service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body: { event: "timer", arguments: { after_ms: 60_000 } } });
    await client!.pool.query(
      "UPDATE agent_wake_rules SET arguments = jsonb_build_object('at', to_char(now() AT TIME ZONE 'UTC' - interval '1 second', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')), next_check_at = now() WHERE id = $1",
      [rule.id],
    );
    // No event nudges this scheduler: only its own retry can find the rule.
    let status = "active";
    for (let attempt = 0; attempt < 40 && status === "active"; attempt += 1) {
      await sleep(250);
      status = (await row(rule.id)).status;
    }
    assert.equal(status, "fired");
  } finally {
    await stop();
  }
});

test("a rule whose check fails backs off instead of spinning", skip, async () => {
  const { room, agent } = await seed();
  const { rule } = await service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body: { event: "task.status_changed", arguments: { task_id: (await api!.createTask(room.id, "Watched", "owner")).id } } });
  const now = new Date();
  const failing = { ...(await import("../db/wake-rules.js")).wakeRuleEvaluationDeps, readTaskStatus: async () => { throw new Error("statement timeout"); } };
  await scheduler!.checkWakeRules([await row(rule.id)], now, failing);
  const backedOff = await row(rule.id);
  assert.equal(backedOff.status, "active");
  assert.ok(Date.parse(backedOff.next_check_at) >= now.getTime() + 29_000);

  // Past expiry the backoff still holds: a failing expiry notice is not retried every pass.
  await client!.pool.query("UPDATE agent_wake_rules SET expires_at = now() - interval '1 minute' WHERE id = $1", [rule.id]);
  const later = new Date();
  await scheduler!.checkWakeRules([await row(rule.id)], later, failing);
  assert.ok(Date.parse((await row(rule.id)).next_check_at) >= later.getTime() + 29_000);
});

test("GitHub rules see every room of a large repository and a real review", skip, async () => {
  const { room, agent } = await seed("wake-large-repo");
  const others = [];
  for (let index = 0; index < 520; index += 1) others.push((await api!.createProjectWithName(`wake-branch-${index}`)).id);
  await bindRepository([room.id, ...others]);
  const { rule } = await service!.addWakeRuleForAgent({
    roomId: room.id, agent: agent(0), body: { event: "github.review_submitted", arguments: { pr: 77, states: ["approved"] } },
  });
  await api!.insertGitHubRoomEvent({
    room_id: others.at(-1)!, event_type: "pull_request_review", action: "submitted", idempotency_key: "review-1",
    github_object_id: "77", state: "commented", actor_login: "ada", github_object_url: "https://github.com/org/repo/pull/77#review-1",
  });
  await api!.insertGitHubRoomEvent({
    room_id: others.at(-1)!, event_type: "pull_request_review", action: "submitted", idempotency_key: "review-2",
    github_object_id: "77", state: "approved", actor_login: "grace", github_object_url: "https://github.com/org/repo/pull/77#review-2",
  });
  await scheduler!.checkWakeRules([await row(rule.id)]);
  const fired = await row(rule.id);
  assert.equal(fired.status, "fired");
  const message = await api!.getMessageById(room.id, `msg_${fired.wake_message_number}`);
  assert.equal(message?.display_text, "Fable woke up · grace approved #77");
});

test("undo counts against the agent's limit and belongs to whoever cancelled", skip, async () => {
  const { room, agent } = await seed();
  const person = { kind: "human" as const, id: "acct", label: "EmmyMay" };
  const first = await service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body: { event: "timer", arguments: { after_ms: 60 * 60_000 } } });
  await service!.cancelWakeRuleAs(room.id, first.rule.id, person);
  for (let minute = 2; minute <= 21; minute += 1) {
    await service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body: { event: "timer", arguments: { after_ms: minute * 60_000 } } });
  }
  await assert.rejects(service!.restoreWakeRuleAs(room.id, first.rule.id, person), /already has 20 active wake rules/);
  await assert.rejects(store!.restoreWakeRule(room.id, first.rule.id, { kind: "human", id: "someone-else", label: "Ada" }), /./);
});

test("rules on a merged pull request or a finished task end without a wake, and say why", skip, async () => {
  const { room, agent } = await seed("wake-retire-room");
  await bindRepository([room.id]);
  const review = await service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body: { event: "github.review_submitted", arguments: { pr: 7 }, repeat: true } });
  const merge = await service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(1), body: { event: "github.pr_closed", arguments: { pr: 7 }, repeat: true } });
  const task = await api!.createTask(room.id, "Tide", "owner");
  await client!.pool.query("UPDATE tasks SET status = 'in_review' WHERE room_id = $1 AND number = $2", [room.id, Number(task.id.slice(5))]);
  const taskRule = await service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body: { event: "task.status_changed", arguments: { task_id: task.id, to: ["blocked"] }, repeat: true } });

  await api!.insertGitHubRoomEvent({
    room_id: room.id, event_type: "pull_request", action: "closed", idempotency_key: "pr-7-closed", github_object_id: "7",
    state: "merged", github_object_url: "https://github.com/org/repo/pull/7", provider_event_at: new Date(Date.now() - 60_000).toISOString(),
  });
  await client!.pool.query("UPDATE tasks SET status = 'done' WHERE room_id = $1 AND number = $2", [room.id, Number(task.id.slice(5))]);
  await scheduler!.checkWakeRules([await row(review.rule.id), await row(merge.rule.id), await row(taskRule.rule.id)]);

  const retired = await row(review.rule.id);
  assert.deepEqual([retired.status, retired.ended_reason, retired.wake_message_number, retired.fire_count], ["retired", "#7 was merged", null, 0]);
  assert.ok(retired.ended_at);
  const finishedTask = await row(taskRule.rule.id);
  assert.deepEqual([finishedTask.status, finishedTask.ended_reason], ["retired", `${task.id} is done`]);
  const lastWake = await row(merge.rule.id);
  assert.deepEqual([lastWake.status, lastWake.ended_reason], ["fired", "#7 was merged"], "a repeating rule that waits for the merge wakes once, then ends");
  const message = await api!.getMessageById(room.id, `msg_${lastWake.wake_message_number}`);
  assert.match(message!.text, /This rule is finished \(#7 was merged\)/);
  assert.equal((await client!.pool.query("SELECT count(*)::int AS n FROM messages WHERE room_id = $1 AND source = 'wake_rule'", [room.id])).rows[0].n, 1);
  const recent = (await store!.listWakeRules(room.id)).recent.find((entry) => entry.id === review.rule.id);
  assert.deepEqual([recent?.status, recent?.ended_reason], ["retired", "#7 was merged"]);

  // Waiting on a pull request that already ended is refused; a reopened one can be waited on again.
  await assert.rejects(
    service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body: { event: "github.check_completed", arguments: { pr: 7 } } }),
    /#7 is already merged/,
  );
  await api!.insertGitHubRoomEvent({
    room_id: room.id, event_type: "pull_request", action: "reopened", idempotency_key: "pr-7-reopened", github_object_id: "7",
    state: "open", provider_event_at: new Date().toISOString(),
  });
  assert.equal((await service!.addWakeRuleForAgent({ roomId: room.id, agent: agent(0), body: { event: "github.check_completed", arguments: { pr: 7 } } })).created, true);
});
