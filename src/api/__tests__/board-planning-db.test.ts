import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { BoardPlanningConflictError, defaultBoardPlanning } from "../../../shared/board-planning.mjs";

const databaseUrl = process.env.TEST_DB_URL;
if (databaseUrl) process.env.DB_URL = databaseUrl;
const client = databaseUrl ? await import("../db/client.js") : null;
const planning = databaseUrl ? await import("../db/board-planning.js") : null;
const api = databaseUrl ? await import("../db.js") : null;
const schema = databaseUrl ? await import("../db/schema.js") : null;
const options = { skip: !databaseUrl && "set TEST_DB_URL to run PostgreSQL planning tests" };

test.before(async () => {
  if (!client) return;
  await migrate(client.db, { migrationsFolder: path.resolve("drizzle") });
});
test.after(async () => { await client?.pool.end(); });

async function room(name: string) {
  const project = await api!.createProjectWithName(`${name}-${crypto.randomUUID()}`);
  await client!.pool.query("INSERT INTO tasks(room_id,number,title,status,created_by,created_at,updated_at) VALUES($1,1,'Planned task','accepted','test',now(),now())", [project.id]);
  return project.id;
}

test("planning defaults read without a write, and foreign task references roll back", options, async () => {
  const roomId = await room("planning-defaults");
  const initial = await planning!.getBoardPlanning(roomId, false);
  assert.equal(initial.revision, 0);
  assert.equal(initial.canEdit, false);
  assert.equal(initial.document.defaultTargetPoints, 16);
  assert.equal(initial.taskFacts[0].id, "task_1");
  const document = defaultBoardPlanning();
  document.tasks.task_999 = { estimate: 8 };
  await assert.rejects(planning!.updateBoardPlanning(roomId, "person", { expectedRevision: 0, document }), /no longer exists in this room/);
  assert.equal((await client!.pool.query("SELECT * FROM room_board_planning WHERE room_id=$1", [roomId])).rows.length, 0);
});

test("two concurrent edits cannot silently overwrite each other's sprint settings", options, async () => {
  const roomId = await room("planning-concurrency");
  const first = defaultBoardPlanning(), second = defaultBoardPlanning();
  first.defaultTargetPoints = 8;
  second.defaultTargetPoints = 24;
  first.tasks.task_1 = { estimate: 3 };
  second.tasks.task_1 = { estimate: 5 };
  const results = await Promise.allSettled([
    planning!.updateBoardPlanning(roomId, "one", { expectedRevision: 0, document: first }),
    planning!.updateBoardPlanning(roomId, "two", { expectedRevision: 0, document: second }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof BoardPlanningConflictError);
  const saved = await planning!.getBoardPlanning(roomId, true);
  assert.equal(saved.revision, 1);
  assert.ok([8, 24].includes(saved.document.defaultTargetPoints));
  const task = (await client!.pool.query("SELECT status,assignee_agent_key FROM tasks WHERE room_id=$1 AND number=1", [roomId])).rows[0];
  assert.deepEqual(task, { status: "accepted", assignee_agent_key: null }, "planning cannot claim or progress work");
});

test("sprint facts include finished tasks beyond a task page and saved provider identity", options, async () => {
  const roomId = await room("planning-complete-facts");
  const otherRoom = await room("planning-isolated-facts");
  await client!.pool.query(`INSERT INTO tasks(room_id,number,title,status,assignee_agent_key,created_by,created_at,updated_at)
    SELECT $1,n,'Finished task '||n,'done','owner/brook','test',now(),now() FROM generate_series(2,251) AS n`, [roomId]);
  const ownerId = `planning-owner-${crypto.randomUUID()}`;
  await client!.pool.query(`INSERT INTO accounts(id,provider,provider_user_id,login,display_name,created_at,updated_at)
    VALUES($1,'github',$1,$1,'Owner',now(),now())`, [ownerId]);
  await api!.createRoomAgentSession({ room_id: roomId, owner_account_id: ownerId, session_kind: "worker", runtime: "codex", actor_label: "BrookCopper",
    agent_key: "owner/brook", display_name: "BrookCopper", owner_label: "owner", ide_label: "Codex" });
  const facts = await planning!.getBoardPlanning(roomId, true);
  assert.equal(facts.taskFacts.length, 251);
  assert.equal(facts.taskFacts.find(task => task.id === "task_251")?.provider, "codex");
  assert.equal(facts.taskFacts.filter(task => task.status === "done").length, 250);
  assert.equal((await planning!.getBoardPlanning(otherRoom, false)).taskFacts.length, 1);
});

test("planning migration schedules a tracker read-backfill without taking any poll claim", options, async () => {
  const connection = await client!.pool.connect();
  try {
    await connection.query(`CREATE TEMP TABLE room_tracker_filters(provider text,last_synced_at timestamptz,sync_claimed_at timestamptz)`);
    await connection.query(`INSERT INTO room_tracker_filters VALUES
      ('jira','2026-11-01','2026-11-06'),('linear','2026-11-01','2026-11-06'),('github','2026-11-01','2026-11-06')`);
    const sql = await readFile(path.resolve("drizzle/0141_board_planning.sql"), "utf8");
    await connection.query(sql.split("--> statement-breakpoint")[1]);
    const rows = (await connection.query("SELECT provider,last_synced_at IS NULL AS reset,sync_claimed_at IS NOT NULL AS claimed FROM room_tracker_filters ORDER BY provider")).rows;
    assert.deepEqual(rows, [
      { provider: "github", reset: false, claimed: true },
      { provider: "jira", reset: true, claimed: true },
      { provider: "linear", reset: true, claimed: true },
    ]);
  } finally { await connection.query("DROP TABLE IF EXISTS pg_temp.room_tracker_filters"); connection.release(); }
});

async function importedSprint(roomId: string) {
  const suffix = crypto.randomUUID(), now = new Date().toISOString();
  const ownerId = `planning-owner-${suffix}`, connectionId = `tcon_${suffix}`, itemId = `ext_${suffix}`;
  await client!.db.insert(schema!.accounts).values({ id: ownerId, provider: "github", provider_user_id: ownerId, login: ownerId, display_name: "Owner", created_at: now, updated_at: now });
  await client!.db.insert(schema!.tracker_connections).values({ id: connectionId, account_id: ownerId, provider: "jira", display_name: "Planning test", site_key: suffix, site_url: "https://example.atlassian.net", auth_kind: "api_token", credentials_ciphertext: "test", credentials_iv: "test", credentials_version: 1, status_map: {} });
  const payload = { planning: { estimate: 3, iterations: [{ id: "24", name: "Source sprint", state: "active", startDate: "2026-11-02", endDate: "2026-11-13", goal: null }] } };
  await client!.db.insert(schema!.external_items).values({ id: itemId, connection_id: connectionId, provider: "jira", key: "APP-1", title: "Imported task", ticket_state: "in_progress", raw_status: "In Progress", url: "https://example.atlassian.net/browse/APP-1", payload, synced_at: now });
  await client!.pool.query("UPDATE tasks SET external_item_id=$2 WHERE room_id=$1 AND number=1", [roomId, itemId]);
  return { id: `imported:jira:${connectionId}:24`, itemId, payload };
}

test("retired imported sprint references recover without accepting new or cross-room references", options, async () => {
  const roomId = await room("planning-retired-source"), source = await importedSprint(roomId);
  const foreign = await importedSprint(await room("planning-other-source"));
  const document = defaultBoardPlanning();
  document.sprintTargets[source.id] = 24;
  document.tasks.task_1 = { sprintId: source.id, estimate: 5, priority: "high", columnId: "todo" };
  await planning!.updateBoardPlanning(roomId, "person", { expectedRevision: 0, document });
  const beforeRemoval = await planning!.getBoardPlanning(roomId, true);
  await client!.pool.query("UPDATE external_items SET payload=$2 WHERE id=$1", [source.itemId, { planning: { estimate: 3, iterations: [] } }]);

  // An already-open draft must refresh, rather than silently keeping stale IDs.
  beforeRemoval.document.columns[0].name = "Ready";
  await assert.rejects(planning!.updateBoardPlanning(roomId, "person", { expectedRevision: 1, document: beforeRemoval.document }), /missing sprint.*Refresh the board/);
  const refreshed = await planning!.getBoardPlanning(roomId, true);
  assert.equal(refreshed.revision, 1);
  assert.deepEqual(refreshed.document.sprintTargets, {});
  assert.deepEqual(refreshed.document.tasks.task_1, { sprintId: null, estimate: 5, priority: "high", columnId: "todo" });
  const raw = (await client!.pool.query("SELECT document FROM room_board_planning WHERE room_id=$1", [roomId])).rows[0].document;
  assert.equal(raw.tasks.task_1.sprintId, source.id, "GET reconciliation must not write stored planning");
  refreshed.document.columns[0].name = "Ready";
  await planning!.updateBoardPlanning(roomId, "person", { expectedRevision: 1, document: refreshed.document });

  // Reappearance after a save must not restore an override the user no longer sees.
  await client!.pool.query("UPDATE external_items SET payload=$2 WHERE id=$1", [source.itemId, source.payload]);
  const saved = await planning!.getBoardPlanning(roomId, true);
  assert.equal(saved.document.columns[0].name, "Ready");
  assert.equal(saved.document.tasks.task_1.sprintId, null);
  assert.deepEqual(saved.document.sprintTargets, {});
  assert.equal(saved.revision, 2);
  for (const invalidId of ["imported:jira:unknown:24", foreign.id]) {
    const invalid = structuredClone(saved.document);
    invalid.sprintTargets[invalidId] = 16;
    await assert.rejects(planning!.updateBoardPlanning(roomId, "person", { expectedRevision: 2, document: invalid }), /missing sprint/);
    delete invalid.sprintTargets[invalidId];
    invalid.tasks.task_1.sprintId = invalidId;
    await assert.rejects(planning!.updateBoardPlanning(roomId, "person", { expectedRevision: 2, document: invalid }), /missing sprint/);
  }
  assert.equal((await planning!.getBoardPlanning(roomId, true)).revision, 2);
});
