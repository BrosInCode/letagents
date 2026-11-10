import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { classifyRoomId, getRoomNature } from "../rooms/room-nature.js";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import("../db/client.js") : null;
const db = url ? await import("../db.js") : null;
const options = { skip: !url ? "Set TEST_DB_URL for PostgreSQL integration tests." : false };

test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve("drizzle") }); });
test.after(async () => { await client?.pool.end(); });

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

test("a repo room renamed A -> B -> A keeps its nature, and both names reach it", options, async () => {
  const repoId = `room-nature-${suffix}`;
  const ownerA = `acme-${suffix}`;
  const ownerB = `acme-moved-${suffix}`;
  const roomA = `github.com/${ownerA}/app`;
  const roomB = `github.com/${ownerB}/app`;

  await db!.upsertGitHubRepositoryLink({ github_repo_id: repoId, room_id: roomA, owner_login: ownerA, repo_name: "app" });
  const created = await db!.getProjectById(roomA);
  assert.ok(created);
  assert.equal(getRoomNature(created).origin, "repo");
  assert.equal(created.code, null);
  assert.equal(created.name, roomA);

  const movedToB = await db!.migrateGitHubRepositoryCanonicalRoom({ github_repo_id: repoId, owner_login: ownerB, repo_name: "app" });
  assert.equal(movedToB?.id, roomB);
  assert.equal(getRoomNature(movedToB!).origin, "repo");
  assert.equal((await db!.getProjectById(roomA))?.id, roomB, "the old name reaches the renamed room");
  assert.equal((await db!.getRoomAlias(roomA))?.room_id, roomB);

  const movedBack = await db!.migrateGitHubRepositoryCanonicalRoom({ github_repo_id: repoId, owner_login: ownerA, repo_name: "app" });
  assert.equal(movedBack?.id, roomA);
  assert.equal(getRoomNature(movedBack!).origin, "repo");
  assert.equal(movedBack!.name, roomA);
  assert.equal(await db!.getRoomAlias(roomA), undefined, "the id is no longer also an alias");
  assert.equal((await db!.getRoomAlias(roomB))?.room_id, roomA);
  assert.equal((await db!.getProjectById(roomB))?.id, roomA);
  assert.equal((await db!.getGitHubRepositoryLinkById(repoId))?.room_id, roomA);
  assert.equal(classifyRoomId(roomA), "repo");
});

test("a join-code room keeps its nature through a code rotation", options, async () => {
  const room = await db!.createProject();
  assert.equal(getRoomNature(room).origin, "join_code");
  assert.equal(room.code, room.id);

  const rotated = await db!.rotateProjectCode(room.id);
  assert.ok(rotated);
  assert.notEqual(rotated.id, room.id);
  const stored = await db!.getProjectById(rotated.id);
  assert.equal(getRoomNature(stored!).origin, "join_code");
  assert.equal(stored!.code, rotated.id);
  assert.equal(stored!.name, undefined);
  assert.equal(await db!.getProjectById(room.id), undefined, "the old code no longer opens the room");
  assert.equal(await db!.getProjectByCode(room.id.toLowerCase()), undefined);
  assert.equal((await db!.getProjectByCode(rotated.id.toLowerCase()))?.id, rotated.id);
});

test("named and focus rooms read back with their nature", options, async () => {
  const named = await db!.createProjectWithName(`room-nature-${suffix}`);
  assert.equal(getRoomNature(named).origin, "named");
  const parent = await db!.createProjectWithName(`github.com/acme-focus-${suffix}/app`);
  const { room: child } = await db!.getOrCreateGitChildRoom({ parentRoomId: parent.id, focusKey: "git:branch:bWFpbg" });
  const stored = await db!.getProjectById(child.id);
  assert.equal(getRoomNature(stored!).origin, "focus");
  assert.equal(getRoomNature(stored!).accessRoomId, parent.id);
  assert.equal(classifyRoomId(stored!.id), "focus");
});
