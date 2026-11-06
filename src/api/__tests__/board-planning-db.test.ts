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
    const sql = await readFile(path.resolve("drizzle/0140_board_planning.sql"), "utf8");
    await connection.query(sql.split("--> statement-breakpoint")[1]);
    const rows = (await connection.query("SELECT provider,last_synced_at IS NULL AS reset,sync_claimed_at IS NOT NULL AS claimed FROM room_tracker_filters ORDER BY provider")).rows;
    assert.deepEqual(rows, [
      { provider: "github", reset: false, claimed: true },
      { provider: "jira", reset: true, claimed: true },
      { provider: "linear", reset: true, claimed: true },
    ]);
  } finally { await connection.query("DROP TABLE IF EXISTS pg_temp.room_tracker_filters"); connection.release(); }
});
