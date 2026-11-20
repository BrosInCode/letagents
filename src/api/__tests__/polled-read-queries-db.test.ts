import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import("../db/client.js") : null;
const api = url ? await import("../db.js") : null;
const attention = url ? await import("../account-unread/attention.js") : null;
const identities = url ? await import("../db/auth/agent-identities.js") : null;
const options = { skip: !url ? "Set TEST_DB_URL to run PostgreSQL integration tests." : false };
const migrationsFolder = path.resolve("drizzle");

async function resetSchema() {
  await client!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client!.pool.query("CREATE SCHEMA public");
}
async function indexNames(table: string): Promise<string[]> {
  const result = await client!.pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname", [table]);
  return result.rows.map((row) => row.indexname);
}

test.after(async () => { await client?.pool.end(); });

test("migration 0156 builds the new indexes from scratch and on a database that stopped before it", options, async () => {
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"));
  const before = journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0156_polled_read_indexes");
  assert.ok(before > 0, "the journal lists 0156");

  // A database from scratch.
  await resetSchema();
  await migrate(client!.db, { migrationsFolder });
  const artifacts = await indexNames("room_shared_artifacts");
  assert.ok(artifacts.includes("room_shared_artifacts_room_kind_key_idx"));
  assert.ok(!artifacts.includes("room_shared_artifacts_room_kind_idx"));
  assert.ok(artifacts.includes("room_shared_artifacts_room_url_idx") && artifacts.includes("room_shared_artifacts_room_ref_idx"));
  const partial = await client!.pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'agents_avatar_canonical_key_idx'");
  assert.match(partial.rows[0].indexdef, /\(canonical_key\) WHERE \(avatar IS NOT NULL\)/);

  // A database that stopped just before 0156: the old index exists, then 0156 swaps it.
  await resetSchema();
  const staged = mkdtempSync(path.join(tmpdir(), "migrations-0155-"));
  cpSync(migrationsFolder, staged, { recursive: true });
  writeFileSync(path.join(staged, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, before) }));
  await migrate(client!.db, { migrationsFolder: staged });
  assert.ok((await indexNames("room_shared_artifacts")).includes("room_shared_artifacts_room_kind_idx"));
  assert.ok(!(await indexNames("agents")).includes("agents_avatar_canonical_key_idx"));
  await migrate(client!.db, { migrationsFolder });
  assert.deepEqual(await indexNames("room_shared_artifacts"), artifacts);
  assert.ok((await indexNames("agents")).includes("agents_avatar_canonical_key_idx"));
  await migrate(client!.db, { migrationsFolder });
});

test("the artifact list keeps its order and reads the room through the new index", options, async () => {
  await resetSchema();
  await migrate(client!.db, { migrationsFolder });
  const room = await api!.createProjectWithName("artifact-list-room");
  const other = await api!.createProjectWithName("artifact-list-other");
  const insert = (roomId: string, count: number) => client!.pool.query(
    `INSERT INTO room_shared_artifacts (room_id, identity_key, provider, kind, source, first_seen_at, updated_at)
     SELECT $1, 'github:' || k || ':n:' || lpad(g::text, 6, '0'), 'github', k, 'manual', now(), now() - (g || ' seconds')::interval
     FROM generate_series(1, $2) g, unnest(ARRAY['issue','pull_request','branch','review']) k`, [roomId, count]);
  await insert(room.id, 1500);
  await insert(other.id, 1500);
  await client!.pool.query("ANALYZE room_shared_artifacts");

  const listed = await api!.getRoomSharedArtifacts({ room_id: room.id, limit: 250 });
  const expected = await client!.pool.query(
    "SELECT identity_key FROM room_shared_artifacts WHERE room_id = $1 ORDER BY kind ASC, identity_key ASC LIMIT 250", [room.id]);
  assert.deepEqual(listed.map((row) => row.identity_key), expected.rows.map((row) => row.identity_key));
  assert.equal(listed.length, 250);
  assert.equal(listed[0].kind, "branch");

  const plan = await client!.pool.query(
    "EXPLAIN (FORMAT JSON) SELECT * FROM room_shared_artifacts WHERE room_id = $1 ORDER BY kind ASC, identity_key ASC LIMIT 100", [room.id]);
  const text = JSON.stringify(plan.rows[0]["QUERY PLAN"]);
  assert.match(text, /"Index Name":"room_shared_artifacts_room_kind_key_idx"/);
  assert.doesNotMatch(text, /"Node Type":"Sort"/);
});

test("the avatar lookup sends one array parameter and matches awkward keys exactly", options, async () => {
  await resetSchema();
  await migrate(client!.db, { migrationsFolder });
  const now = new Date().toISOString();
  await client!.db.insert((await import("../db/schema.js")).accounts).values({
    id: "avatar-owner", provider: "github", provider_user_id: "avatar-owner", login: "avatar-owner",
    display_name: null, avatar_url: null, created_at: now, updated_at: now,
  }).onConflictDoNothing();
  const avatar = { kind: "character", character: "orbit", color: "blue" };
  const keys = ["o/a,b", 'o/"quoted"', "o/{brace}", "o/back\\slash", "o/zoë-日本", "o/NULL", "o/plain", "o/no-avatar", "o/bad-avatar"];
  for (const [index, key] of keys.entries()) {
    const value = key === "o/no-avatar" ? null : key === "o/bad-avatar" ? { kind: "nope" } : avatar;
    await client!.pool.query(
      `INSERT INTO agents (id, canonical_key, name, display_name, owner_account_id, owner_login, owner_label, avatar, created_at, updated_at)
       VALUES ($1, $2, $2, $2, 'avatar-owner', 'o', 'o', $3, now(), now())`, [`agent_av_${index}`, key, value]);
  }
  const logged: Array<{ query: string; params: unknown[] }> = [];
  const logging = drizzle(client!.pool, { logger: { logQuery: (query, params) => { logged.push({ query, params }); } } });

  const found = await identities!.getAgentAvatars([...keys, "o/missing", null, undefined, keys[0]], logging as any);
  assert.deepEqual([...found.keys()].sort(), keys.filter((key) => key !== "o/no-avatar" && key !== "o/bad-avatar").sort());
  assert.deepEqual(found.get("o/zoë-日本"), avatar);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].params.length, 1, "one bind parameter for any number of keys");
  assert.ok(Array.isArray(logged[0].params[0]));
  assert.match(logged[0].query, /= ANY\(\$1::text\[\]\)/);

  logged.length = 0;
  assert.equal((await identities!.getAgentAvatars([null, "", undefined], logging as any)).size, 0);
  assert.equal(logged.length, 0, "no query for an empty list");

  // A few thousand agents with a few avatars: a lookup of 100 keys reads the small partial index.
  await client!.pool.query(
    `INSERT INTO agents (id, canonical_key, name, display_name, owner_account_id, owner_login, owner_label, avatar, created_at, updated_at)
     SELECT 'agent_bulk_' || g, 'o/bulk-' || g, 'b' || g, 'b' || g, 'avatar-owner', 'o', 'o',
       CASE WHEN g % 500 = 0 THEN '{"kind":"initials","color":"rose"}'::jsonb END, now(), now()
     FROM generate_series(1, 5000) g`);
  await client!.pool.query("ANALYZE agents");
  const hundred = Array.from({ length: 100 }, (_, index) => `o/bulk-${(index + 1) * 50}`);
  const plan = await client!.pool.query(
    "EXPLAIN (FORMAT JSON) SELECT canonical_key, avatar FROM agents WHERE canonical_key = ANY($1::text[]) AND avatar IS NOT NULL", [hundred]);
  assert.match(JSON.stringify(plan.rows[0]["QUERY PLAN"]), /"Index Name":"agents_avatar_canonical_key_idx"/);

  const many = Array.from({ length: 800 }, (_, index) => `o/many-${index}`);
  assert.equal((await identities!.getAgentAvatars(many, logging as any)).size, 0);
  assert.equal(logged[0].params.length, 1);
});

test("per-room attention reads only attention tasks, in the order and shape the route returned", options, async () => {
  await resetSchema();
  await migrate(client!.db, { migrationsFolder });
  const room = await api!.createProjectWithName("attention-room");
  const other = await api!.createProjectWithName("attention-other");
  const statuses = ["proposed", "accepted", "assigned", "in_progress", "blocked", "in_review", "merged", "done", "cancelled"];
  let number = 0;
  for (const roomId of [room.id, other.id]) {
    for (const status of [...statuses, ...statuses]) {
      number += 1;
      // Same second for every other card so the number tie-break is exercised.
      const updated = new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(number / 2))).toISOString();
      await client!.pool.query(
        `INSERT INTO tasks (room_id, number, title, description, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'tester', $6, $6)`,
        [roomId, number, `Task ${number}`, number % 3 === 0 ? null : `Body ${number}`, status, updated]);
    }
  }
  const oldRoute = (await api!.getTasksForRooms([room.id]))
    .filter((task) => ["proposed", "blocked", "in_review"].includes(task.status))
    .map((task) => ({ id: task.id, title: task.title, status: task.status, description: task.description, updated_at: task.updated_at }));
  const newRoute = (await attention!.getAttentionTasksForRooms([room.id]))
    .filter((task) => ["proposed", "blocked", "in_review"].includes(task.status))
    .map((task) => ({ id: task.id, title: task.title, status: task.status, description: task.description, updated_at: task.updated_at }));
  assert.equal(oldRoute.length, 6);
  assert.deepEqual(newRoute, oldRoute);
  assert.equal((await attention!.getAttentionTasksForRooms([room.id])).length, 6, "SQL already dropped the other statuses");
  assert.ok(oldRoute.some((task) => task.description === null));
});

test("the per-room attention route reads only attention tasks through its default reader", options, async () => {
  await resetSchema();
  await migrate(client!.db, { migrationsFolder });
  const { registerRoomKnowledgeRoutes } = await import("../routes/rooms/knowledge.js");
  const room = await api!.createProjectWithName("attention-route-room");
  const statuses = ["proposed", "accepted", "assigned", "in_progress", "blocked", "in_review", "merged", "done", "cancelled"];
  let number = 0;
  for (const status of [...statuses, ...statuses]) {
    number += 1;
    const updated = new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(number / 2))).toISOString();
    await client!.pool.query(
      `INSERT INTO tasks (room_id, number, title, description, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'tester', $6, $6)`,
      [room.id, number, `Task ${number}`, number % 3 === 0 ? null : `Body ${number}`, status, updated]);
  }
  const routes: Array<{ path: RegExp; handler: Function }> = [];
  const app = { get: (path: RegExp, handler: Function) => routes.push({ path, handler }), post() {}, patch() {} } as any;
  // No getTasks: the route uses its default reader.
  registerRoomKnowledgeRoutes(app, {
    resolveCanonicalRoomRequestId: async (id: string) => id,
    resolveRoomOrReply: async (id: string) => ({ id }),
    requireParticipant: async () => true,
    store: { listRoomKnowledge: async () => ({ records: [], truncated: false }) },
  } as any);
  const path = `/rooms/${room.id}/attention`;
  const found = routes.find((entry) => entry.path.test(path))!;
  const matches = path.match(found.path)!;
  let body: any;
  await found.handler({ params: { 0: matches[1] }, body: {}, headers: {} }, { json(value: unknown) { body = value; }, status() { return this; } });

  const old = (await api!.getTasksForRooms([room.id]))
    .filter((task) => ["proposed", "blocked", "in_review"].includes(task.status))
    .map((task) => ({ id: task.id, title: task.title, status: task.status, description: task.description, updated_at: task.updated_at }));
  assert.equal(old.length, 6);
  assert.deepEqual(body.tasks, old);
});
