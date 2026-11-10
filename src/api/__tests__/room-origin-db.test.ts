import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { Response } from "express";

import { getRoomNature, originFromIdShape } from "../rooms/room-nature.js";
import { ROOM_ORIGIN_SHAPE_SQL } from "../db/room-origin-audit.js";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import("../db/client.js") : null;
const db = url ? await import("../db.js") : null;
const resolution = url ? await import("../rooms/resolution.js") : null;
const gitRouting = url ? await import("../github/git-room-routing.js") : null;
const appSync = url ? await import("../github/app-sync.js") : null;
const rental = url ? await import("../rental/room-projection.js") : null;
const access = url ? await import("../rooms/access.js") : null;
const audit = url ? await import("../db/room-origin-audit.js") : null;
const formatting = url ? await import("../rooms/formatting.js") : null;
const schema = url ? await import("../db/schema.js") : null;
const mappers = url ? await import("../db/mappers.js") : null;
const options = { skip: !url ? "Set TEST_DB_URL for PostgreSQL integration tests." : false };

test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve("drizzle") }); });
test.after(async () => { await client?.pool.end(); });

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let sequence = 0;
const unique = (label: string) => `${label}-${suffix}-${++sequence}`;

const MIGRATION = readFileSync(resolve("drizzle/0147_room_origin.sql"), "utf8");
const BACKFILL = MIGRATION.split("--> statement-breakpoint")
  .map((statement) => statement.replace(/^\s*--.*$/gm, "").trim())
  .find((statement) => statement.startsWith("UPDATE rooms"))!;

async function storedOrigin(roomId: string): Promise<string | null> {
  const result = await client!.pool.query<{ origin: string | null }>("SELECT origin FROM rooms WHERE id = $1", [roomId]);
  assert.equal(result.rowCount, 1, `room ${roomId} exists`);
  return result.rows[0]!.origin;
}

function fakeResponse() {
  const res = {
    statusCode: 200,
    status(code: number) { res.statusCode = code; return res; },
    json() { return res; },
  };
  return res as unknown as Response;
}

// ── The backfill rule ─────────────────────────────────────────────────────

const SHAPES = [
  "github.com/brosincode/letagents", "GitHub.com/Owner/Repo", "www.github.com/acme/app",
  "ssh.github.com:443/acme/app", "gitlab.com/group/sub/project", "GitLab.com/a/b/c/d", "bitbucket.org/ws/repo",
  "github-work/acme/app", "team/design/notes", "github.com/acme", "github.com/acme/app/extra",
  "JA0E-4NYO", "ja0e-4nyo", "JA0E-4NYO-L2QP", "ABCD-12345", " JA0E-4NYO ", "ABC-1234",
  "focus_12", "focus_0", "FOCUS_12", "github.com/acme/app/focus/task_7", "my-room", "My Room", "", "a/b",
  "github.com", "a//b", "x/y/z/", "é/ü/ß", "ﬀab-1234", "straße-1234",
];

const isAscii = (id: string) => /^[\x01-\x7f]*$/.test(id);

test("the backfill CASE and the audit CASE equal originFromIdShape for every ASCII shape and kind", options, async () => {
  const ascii = SHAPES.filter(isAscii);
  assert.ok(ascii.length < SHAPES.length, "the corpus keeps ids outside ASCII for the next test");
  for (const kind of ["main", "focus"]) {
    const values = ascii.map((_, index) => `($${index * 2 + 1}::text, $${index * 2 + 2}::text)`).join(", ");
    const params = ascii.flatMap((id) => [id, kind]);
    const result = await client!.pool.query<{ id: string; origin: string }>(
      `SELECT r.id, ${ROOM_ORIGIN_SHAPE_SQL} AS origin FROM (VALUES ${values}) AS r(id, kind)`,
      params,
    );
    for (const row of result.rows) {
      assert.equal(row.origin, originFromIdShape({ id: row.id, kind }), `${kind} ${JSON.stringify(row.id)}`);
    }
  }
  const normalize = (sql: string) => sql.replace(/\br\./g, "").replace(/\s+/g, " ").trim();
  const migrationCase = /SET origin = (CASE[\s\S]*?END)/.exec(BACKFILL)?.[1];
  assert.ok(migrationCase);
  assert.equal(normalize(migrationCase), normalize(ROOM_ORIGIN_SHAPE_SQL));
});

test("ids outside ASCII are left to the server's rule after the migration", options, async () => {
  const ligature = `\uFB00${Math.random().toString(36).slice(2, 4)}-${String(Date.now()).slice(-4)}`; // "ﬀ.." upper-cases to "FF.."
  const accented = unique("café");
  for (const id of [ligature, accented]) {
    await client!.pool.query("INSERT INTO rooms (id, display_name, created_at) VALUES ($1, 'Old', now())", [id]);
  }
  await client!.pool.query(BACKFILL);
  assert.equal(await storedOrigin(ligature), null, "the SQL rule skips it");
  assert.equal(await storedOrigin(accented), null);
  // Before the fill, the fallback reads the id shape, as the server did.
  // (getProjectById upper-cases a code-shaped request, so read the row.)
  const readRoom = async (id: string) => {
    const [row] = await client!.db.select().from(schema!.rooms).where(eq(schema!.rooms.id, id));
    return mappers!.toProject(row!);
  };
  assert.equal((await readRoom(ligature)).code, ligature);

  const backfill = await import("../db/room-origin-backfill.js");
  assert.ok(await backfill.reconcileRoomOriginBackfill(client!.pool) >= 2);
  assert.equal(await storedOrigin(ligature), "join_code");
  assert.equal(await storedOrigin(accented), "named");
  assert.equal((await readRoom(ligature)).code, ligature);
  assert.equal(getRoomNature(await readRoom(ligature)).originSource, "stored");
});

test("the backfill fills a row inserted the old way and fires no rename trigger", options, async () => {
  const roomId = unique("old-insert");
  await client!.pool.query(
    "INSERT INTO rooms (id, display_name, created_at) VALUES ($1, 'Old', now())",
    [roomId],
  );
  assert.equal(await storedOrigin(roomId), null);

  // Hold the thread-rollout row, which the UPDATE OF id fence on rooms locks.
  const holder = new Pool({ connectionString: url, max: 1 });
  const held = await holder.connect();
  try {
    await held.query("BEGIN");
    await held.query("SELECT 1 FROM message_thread_projection_rollout FOR UPDATE");

    const backfill = await client!.pool.connect();
    try {
      await backfill.query("BEGIN");
      await backfill.query("SET LOCAL lock_timeout = '2s'");
      await backfill.query(BACKFILL);
      await backfill.query("COMMIT");
    } finally {
      backfill.release();
    }
    assert.equal(await storedOrigin(roomId), "named");

    // The contrast: an UPDATE that names id waits for the held row.
    const renamer = await client!.pool.connect();
    try {
      await renamer.query("BEGIN");
      await renamer.query("SET LOCAL lock_timeout = '500ms'");
      await assert.rejects(() => renamer.query("UPDATE rooms SET id = id WHERE id = $1", [roomId]), /lock timeout/);
      await renamer.query("ROLLBACK");
    } finally {
      renamer.release();
    }
  } finally {
    await held.query("ROLLBACK");
    held.release();
    await holder.end();
  }
});

// ── Every writer stores an origin ─────────────────────────────────────────

test("every writer path stores the room's origin in the creating transaction", options, async () => {
  // Join with create: a named room and a repository room.
  const namedId = unique("join-named");
  const joinedNamed = await resolution!.resolveRoomOrReply(namedId, fakeResponse(), { allowCreate: true });
  assert.equal(await storedOrigin(joinedNamed!.id), "named");
  const repoId = `github.com/${unique("join-repo")}/app`;
  const joinedRepo = await resolution!.resolveRoomOrReply(repoId, fakeResponse(), { allowCreate: true });
  assert.equal(await storedOrigin(joinedRepo!.id), "repo");

  // create_project: a join-code room.
  const project = await db!.createProject();
  assert.equal(await storedOrigin(project.id), "join_code");

  // Code rotation keeps the origin.
  const rotated = await db!.rotateProjectCode(project.id);
  assert.equal(await storedOrigin(rotated!.id), "join_code");
  assert.equal(getRoomNature(rotated!).origin, "join_code");

  // Repository binding by webhook (the repository link) and by App install.
  const webhookOwner = unique("webhook");
  const webhookRepoId = unique("gh-webhook");
  await db!.upsertGitHubRepositoryLink({ github_repo_id: webhookRepoId, room_id: `github.com/${webhookOwner}/app`, owner_login: webhookOwner, repo_name: "app" });
  assert.equal(await storedOrigin(`github.com/${webhookOwner}/app`), "repo");

  const installOwner = unique("install");
  const installationId = unique("installation");
  const sync = appSync!.createGitHubAppSync({
    getGitHubAppRepositoryByFullName: db!.getGitHubAppRepositoryByFullName,
    upsertGitHubAppInstallation: db!.upsertGitHubAppInstallation,
    upsertGitHubAppRepository: db!.upsertGitHubAppRepository,
    upsertGitHubRepositoryLink: db!.upsertGitHubRepositoryLink,
  });
  await sync.syncGitHubAppInstallationFromPayload({
    installation: { id: installationId, account: { login: installOwner, id: 7, type: "Organization" }, target_type: "Organization", repository_selection: "selected" },
  } as never);
  await sync.syncGitHubAppRepositoryFromPayload(
    { id: unique("gh-install"), name: "app", full_name: `${installOwner}/app`, owner: { login: installOwner }, private: true } as never,
    installationId,
  );
  assert.equal(await storedOrigin(`github.com/${installOwner}/app`), "repo");

  // Rename keeps the origin (A -> B).
  const renamed = await db!.migrateGitHubRepositoryCanonicalRoom({ github_repo_id: webhookRepoId, owner_login: `${webhookOwner}-moved`, repo_name: "app" });
  assert.equal(renamed?.id, `github.com/${webhookOwner}-moved/app`);
  assert.equal(await storedOrigin(renamed!.id), "repo");

  // Focus rooms: from a task, from an intent.
  const parent = await db!.createProjectWithName(unique("focus-parent"));
  const task = await db!.createTask(parent.id, "Focus task", "Human");
  const forTask = await db!.createFocusRoomForTask(parent.id, task.id);
  assert.equal(await storedOrigin(forTask!.room.id), "focus");
  const fromIntent = await db!.createFocusRoomFromIntent(parent.id, "Look into it");
  assert.equal(await storedOrigin(fromIntent.room.id), "focus");

  // Branch room, created from its locator.
  const focusKey = gitRouting!.buildGitHubRefFocusKey({ refType: "branch", refName: "feature/origin" });
  const branch = await resolution!.resolveRoomOrReply(`${joinedRepo!.id}/focus/${focusKey}`, fakeResponse(), { allowCreate: true });
  assert.equal(branch?.kind, "focus");
  assert.equal(await storedOrigin(branch!.id), "focus");

  // Rental provisioning.
  const renter = unique("renter");
  const provider = unique("provider");
  const listing = unique("listing");
  const sessionId = unique("session");
  await client!.pool.query(
    `INSERT INTO accounts (id, provider, provider_user_id, login, created_at, updated_at)
     VALUES ($1, 'github', $1, $1, now(), now()), ($2, 'github', $2, $2, now(), now())`,
    [renter, provider],
  );
  await client!.pool.query(
    "INSERT INTO rental_listings (id, provider_account_id, display_name, ide_kind) VALUES ($1, $2, 'Provider', 'codex')",
    [listing, provider],
  );
  await client!.pool.query(
    `INSERT INTO rental_sessions (id, listing_id, renter_account_id, provider_account_id, target_room_id, task_title, task_prompt, status)
     VALUES ($1, $2, $3, $4, $5, 'Task', 'Prompt', 'accepted')`,
    [sessionId, listing, renter, provider, parent.id],
  );
  const provisioned = await rental!.provisionRentalRoom({ sessionId, parentRoomId: parent.id, providerDisplayName: "Provider" });
  assert.equal(await storedOrigin(provisioned.roomId), "focus");
});

// ── A row without an origin behaves as before ─────────────────────────────

test("a room inserted without an origin reads the same as one with it", options, async () => {
  const part = () => Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, "0");
  const codeId = `${part()}-${part()}`;
  const ids = [codeId, `github.com/${unique("null-repo")}/app`, unique("null-named")];
  for (const id of ids) {
    await client!.pool.query("INSERT INTO rooms (id, display_name, created_at) VALUES ($1, 'Old', now()) ON CONFLICT DO NOTHING", [id]);
  }

  const before = [];
  for (const id of ids) {
    const project = (await db!.getProjectById(id))!;
    before.push({
      code: project.code, name: project.name,
      repo: access!.isRepoBackedProject(project),
      origin: getRoomNature(project).origin, source: getRoomNature(project).originSource,
    });
  }
  assert.deepEqual(before.map((entry) => entry.source), ["id_shape", "id_shape", "id_shape"]);

  await client!.pool.query(BACKFILL);
  for (const [index, id] of ids.entries()) {
    const project = (await db!.getProjectById(id))!;
    const nature = getRoomNature(project);
    assert.equal(nature.originSource, "stored");
    assert.deepEqual(
      { code: project.code, name: project.name, repo: access!.isRepoBackedProject(project), origin: nature.origin },
      { code: before[index]!.code, name: before[index]!.name, repo: before[index]!.repo, origin: before[index]!.origin },
      id,
    );
  }
  assert.deepEqual(before.map((entry) => entry.origin), ["join_code", "repo", "named"]);
});

test("origin never reaches a room response", options, async () => {
  const room = await db!.createProjectWithName(unique("response"));
  assert.equal(getRoomNature(room).originSource, "stored");
  assert.equal(Object.keys(room).includes("origin"), false);
  assert.equal(JSON.stringify(room).includes("origin"), false);
  const response = formatting!.toRoomResponse((await db!.getProjectById(room.id))!);
  assert.equal(Object.keys(response).includes("origin"), false);
});

test("the audit reports a stored origin that differs from the id shape, and fixes nothing", options, async () => {
  const roomId = unique("audit-named");
  await client!.pool.query("INSERT INTO rooms (id, display_name, origin, created_at) VALUES ($1, 'Odd', 'repo', now())", [roomId]);
  const lines: string[] = [];
  const findings = await audit!.logRoomOriginAudit(client!.pool, (line) => lines.push(line));
  const parity = findings!.find((finding) => finding.name === "origin_differs_from_id_shape")!;
  assert.ok(parity.count >= 1);
  assert.ok(lines.some((line) => line.includes("origin_differs_from_id_shape")));
  assert.equal(await storedOrigin(roomId), "repo");
  await client!.pool.query("DELETE FROM rooms WHERE id = $1", [roomId]);
});
