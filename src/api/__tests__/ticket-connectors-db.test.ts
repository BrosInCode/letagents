import assert from "node:assert/strict";
import test from "node:test";
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

test("a PR opened from branch HT-1234-proration attaches to the card with external_ref=jira:HT-1234", options, async () => {
  const room = await db!.createProjectWithName(unique("tickets-projection"));
  const card = await db!.createTask(room.id, "Proration", "human", undefined, undefined, { externalRef: "jira:HT-1234" });
  await db!.updateTask(room.id, card.id, { status: "accepted" });
  const event = pullRequestOpened("HT-1234-proration");

  const resolution = await resolver!.resolveLinkedTaskForRepoRoomEvent(room, event);
  assert.equal(resolution.task?.id, card.id);
  assert.equal(resolution.matchedByTicketKey, true);

  const result = await projection!.applyRepoRoomEventToTask(room, resolution.task, event, {
    installationId: null,
    githubRoutingContext: { matched_task_reference: false, matched_workflow_artifact: true },
    matchedByTicketKey: true,
  });
  assert.equal(result.authoritative, true);
  const stored = await db!.getTaskById(room.id, card.id);
  assert.equal(stored?.status, "accepted", "without a work lease the key links the PR and leaves the work state alone");
  assert.deepEqual(
    stored?.workflow_artifacts.filter((artifact) => artifact.kind === "pull_request").map((artifact) => [artifact.url, artifact.state]),
    [["https://github.com/BrosInCode/letagents/pull/88", "open"]],
  );

  const unrelated = await resolver!.resolveLinkedTaskForRepoRoomEvent(room, pullRequestOpened("HT-77-other", 89));
  assert.equal(unrelated.task, undefined);
});
