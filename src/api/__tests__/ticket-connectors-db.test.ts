import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { RepoRoomEvent } from "../repo-workflow.js";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
process.env.LETAGENTS_GITHUB_ENFORCEMENT_MODE = "off";
const client = url ? await import("../db/client.js") : null;
const db = url ? await import("../db.js") : null;
const resolver = url ? await import("../github/room-event-projection/task-resolver.js") : null;
const projection = url ? await import("../github/room-event-projection/task-projection.js") : null;
const validateTaskWorkflowArtifacts = url ? (await import("../repo-workflow.js")).validateTaskWorkflowArtifactsInput : null;
test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve("drizzle") }); });
test.after(async () => { await client?.pool.end(); });
const options = { skip: !url ? "Set TEST_DB_URL to run PostgreSQL integration tests." : false };
let sequence = 0;
const unique = (label: string) => `${label}-${Date.now()}-${++sequence}`;

async function mentionCount(roomId: string): Promise<number> {
  const result = await client!.pool.query("SELECT count(*)::int AS n FROM task_mentions WHERE room_id = $1", [roomId]);
  return result.rows[0].n;
}

function pullRequestOpened(headRef: string, number = 88): RepoRoomEvent {
  return {
    provider: "github",
    kind: "pull_request",
    action: "opened",
    repositoryFullName: "BrosInCode/letagents",
    senderLogin: "kai",
    pullRequest: {
      number,
      title: "Round proration",
      url: `https://github.com/BrosInCode/letagents/pull/${number}`,
      body: "Fixes the rounding.",
      headRef,
      draft: false,
      merged: false,
    },
  } as RepoRoomEvent;
}

test("a room with no external refs records no mentions", options, async () => {
  const room = await db!.createProjectWithName(unique("tickets-none"));
  await db!.createTask(room.id, "Native card", "human");
  await db!.addMessage(room.id, "human", "HT-1234 is on fire");
  assert.equal(await mentionCount(room.id), 0);
  assert.deepEqual(await db!.getRoomExternalRefScope(room.id), { hasExternalRefs: false, detectorOptions: {} });
});

test("a message naming the card's key is listed as a linked thread", options, async () => {
  const room = await db!.createProjectWithName(unique("tickets-mentions"));
  const card = await db!.createTask(room.id, "Proration", "human", undefined, undefined, { externalRef: "jira:HT-1234" });
  assert.equal(card.external_ref, "jira:HT-1234");
  assert.equal(card.ticket_state, null);
  const other = await db!.createTask(room.id, "Other", "human", undefined, undefined, { externalRef: "linear:ENG-5" });

  const root = await db!.addMessage(room.id, "human", "Who owns HT-1234 and ENG-5?");
  await db!.addMessage(room.id, "human", "UTF-8 and HT-999 are not cards here");
  const reply = await db!.addMessage(room.id, "agent", "I'll take HT-1234", { thread_root_message_id: root.id });

  const mentions = await db!.getTaskMentions(room.id, card.id);
  assert.deepEqual(mentions.map((mention) => mention.message_id), [reply.id, root.id]);
  assert.ok(mentions.every((mention) => mention.key === "HT-1234" && mention.thread_root_id === root.id));
  assert.deepEqual((await db!.getTaskMentions(room.id, other.id)).map((mention) => mention.message_id), [root.id]);
  assert.equal(await mentionCount(room.id), 3);

  // Rental tags are set after the write, so the read hides restricted messages.
  const restricted = await db!.addMessage(room.id, "provider", "HT-1234 internal notes");
  await client!.pool.query("UPDATE messages SET visibility = 'provider_only' WHERE room_id = $1 AND number = $2",
    [room.id, Number(restricted.id.replace("msg_", ""))]);
  assert.equal(await mentionCount(room.id), 4);
  assert.deepEqual((await db!.getTaskMentions(room.id, card.id)).map((mention) => mention.message_id), [reply.id, root.id]);
});

test("a room has one card per ticket", options, async () => {
  const room = await db!.createProjectWithName(unique("tickets-unique"));
  const first = await db!.createTask(room.id, "First", "human", undefined, undefined, { externalRef: "jira:HT-1" });
  await assert.rejects(
    db!.createTask(room.id, "Second", "human", undefined, undefined, { externalRef: "jira:HT-1" }),
    (error: unknown) => error instanceof db!.TaskExternalRefConflictError && error.existingTaskId === first.id,
  );
  const second = await db!.createTask(room.id, "Second", "human");
  await assert.rejects(
    db!.updateTask(room.id, second.id, { external_ref: "jira:HT-1" }),
    (error: unknown) => error instanceof db!.TaskExternalRefConflictError,
  );
  const moved = await db!.updateTask(room.id, first.id, { external_ref: null });
  assert.equal(moved?.external_ref, null);
  assert.equal((await db!.updateTask(room.id, second.id, { external_ref: "jira:HT-1" }))?.external_ref, "jira:HT-1");
});

/** Runs work with the given enforcement mode and returns the GitHub calls a lease check made. */
async function enforcementAttempts(mode: string, work: () => Promise<void>): Promise<string[]> {
  const saved = {
    mode: process.env.LETAGENTS_GITHUB_ENFORCEMENT_MODE,
    appId: process.env.GITHUB_APP_ID,
    key: process.env.GITHUB_APP_PRIVATE_KEY,
  };
  const previousFetch = globalThis.fetch;
  const previousWarn = console.warn;
  const calls: string[] = [];
  process.env.LETAGENTS_GITHUB_ENFORCEMENT_MODE = mode;
  // A throwaway app key, so a lease check gets as far as asking GitHub for a token.
  process.env.GITHUB_APP_ID = "1";
  process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url instanceof Request ? url.url : url));
    return new Response("{}", { status: 503 });
  }) as typeof fetch;
  console.warn = (...args: unknown[]) => {
    if (!String(args[0]).includes("letagents-lease enforcement")) previousWarn(...args);
  };
  try {
    await work();
  } finally {
    globalThis.fetch = previousFetch;
    console.warn = previousWarn;
    for (const [name, value] of [["LETAGENTS_GITHUB_ENFORCEMENT_MODE", saved.mode], ["GITHUB_APP_ID", saved.appId], ["GITHUB_APP_PRIVATE_KEY", saved.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  return calls;
}

async function project(room: { id: string }, event: RepoRoomEvent) {
  const resolution = await resolver!.resolveLinkedTaskForRepoRoomEvent(room as never, event);
  const result = resolution.task
    ? await projection!.applyRepoRoomEventToTask(room as never, resolution.task, event, {
      installationId: "1",
      githubRoutingContext: { matched_task_reference: false, matched_workflow_artifact: true },
      matchedByTicketKey: resolution.matchedByTicketKey === true,
    })
    : null;
  return { resolution, result };
}

async function ignoredNotices(roomId: string): Promise<number> {
  const result = await client!.pool.query(
    "SELECT count(*)::int AS n FROM messages WHERE room_id = $1 AND text LIKE '%Ignored unleased GitHub%'", [roomId]);
  return result.rows[0].n;
}

test("a PR opened from branch HT-1234-proration attaches to the card with external_ref=jira:HT-1234", options, async () => {
  const room = await db!.createProjectWithName(unique("tickets-projection"));
  const card = await db!.createTask(room.id, "Proration", "human", undefined, undefined, { externalRef: "jira:HT-1234" });
  await db!.updateTask(room.id, card.id, { status: "accepted" });

  let opened: Awaited<ReturnType<typeof project>> | undefined;
  const attempts = await enforcementAttempts("checks", async () => {
    opened = await project(room, pullRequestOpened("HT-1234-proration"));
  });
  assert.equal(opened?.resolution.task?.id, card.id);
  assert.equal(opened?.resolution.matchedByTicketKey, true);
  assert.equal(opened?.result?.authoritative, true);
  assert.deepEqual(attempts, [], "a key-only PR gets no lease check, even in checks mode");
  const stored = await db!.getTaskById(room.id, card.id);
  assert.equal(stored?.status, "accepted", "without a work lease the key links the PR and leaves the work state alone");
  assert.deepEqual(
    stored?.workflow_artifacts.filter((artifact) => artifact.kind === "pull_request")
      .map((artifact) => [artifact.url, artifact.state, artifact.linked_by]),
    [["https://github.com/BrosInCode/letagents/pull/88", "open", "ticket_key"]],
  );

  // A client writes back the artifact list it read; validation drops linked_by,
  // and the server keeps its mark by URL.
  const echoed = validateTaskWorkflowArtifacts!(JSON.parse(JSON.stringify(stored?.workflow_artifacts)));
  assert.ok(echoed?.every((artifact) => !("linked_by" in artifact)));
  const afterEcho = await db!.updateTask(room.id, card.id, { workflow_artifacts: echoed });
  assert.equal(afterEcho?.workflow_artifacts.find((artifact) => artifact.kind === "pull_request")?.linked_by, "ticket_key");

  // The merge matches by URL now, and keeps the key's quiet handling.
  const merged = { ...pullRequestOpened("HT-1234-proration"), action: "closed" } as RepoRoomEvent & { pullRequest: { merged: boolean } };
  merged.pullRequest = { ...merged.pullRequest, merged: true };
  let closed: Awaited<ReturnType<typeof project>> | undefined;
  const mergeAttempts = await enforcementAttempts("checks", async () => { closed = await project(room, merged); });
  assert.equal(closed?.resolution.matchedByTicketKey, true);
  assert.deepEqual(mergeAttempts, []);
  assert.equal(await ignoredNotices(room.id), 0);
  const afterMerge = await db!.getTaskById(room.id, card.id);
  assert.equal(afterMerge?.status, "accepted");
  assert.deepEqual(
    afterMerge?.workflow_artifacts.filter((artifact) => artifact.kind === "pull_request").map((artifact) => [artifact.state, artifact.linked_by]),
    [["merged", "ticket_key"]],
  );

  const unrelated = await resolver!.resolveLinkedTaskForRepoRoomEvent(room, pullRequestOpened("HT-77-other", 89));
  assert.equal(unrelated.task, undefined);
});

test("a PR linked by URL with no lease still gets the lease check and the notice", options, async () => {
  // Control for the test above: proves the probe sees an enforcement attempt.
  const room = await db!.createProjectWithName(unique("tickets-control"));
  const card = await db!.createTask(room.id, "Explicit link", "human");
  await db!.updateTask(room.id, card.id, { status: "accepted" });
  await db!.updateTask(room.id, card.id, { workflow_artifacts: [{
    provider: "github", kind: "pull_request", number: 90, url: "https://github.com/BrosInCode/letagents/pull/90",
  }] });
  let projected: Awaited<ReturnType<typeof project>> | undefined;
  const attempts = await enforcementAttempts("checks", async () => {
    projected = await project(room, pullRequestOpened("some-branch", 90));
  });
  assert.equal(projected?.resolution.matchedByTicketKey, undefined);
  assert.ok(attempts.length >= 1, "the lease check asked GitHub for a token");
  assert.equal(await ignoredNotices(room.id), 1);
});

test("a ticket card created after a message still links the next mention at once", options, async () => {
  const room = await db!.createProjectWithName(unique("tickets-cache"));
  await db!.addMessage(room.id, "human", "HT-55 first");
  await db!.createTask(room.id, "Late ticket", "human", undefined, undefined, { externalRef: "jira:HT-55" });
  await db!.addMessage(room.id, "human", "HT-55 second");
  await db!.addMessage(room.id, "letagents", "[status] HT-55 moved", { source: "github" });
  assert.equal(await mentionCount(room.id), 1, "the cache is cleared on write; status notices are not threads");
});
