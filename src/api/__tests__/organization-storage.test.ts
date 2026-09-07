import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";

test("verified joins are atomic, idempotent, and keyed by immutable organization identity", {
  skip: !process.env.TEST_DB_URL && "set TEST_DB_URL to run DB-backed storage tests",
}, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_DB_URL });
  const schema = `organization_storage_${process.pid}`;
  const url = new URL(process.env.TEST_DB_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DB_URL = url.toString();
  const { pool } = await import("../db/client.js");
  const store = await import("../db/organizations.js");
  const { getConnectedOrganizationRooms } = await import("../db/organization-rooms.js");
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query("CREATE TABLE accounts (id text PRIMARY KEY); INSERT INTO accounts VALUES ('alice'), ('bob')");
    await pool.query(await readFile(new URL("../../../drizzle/0093_organizations.sql", import.meta.url), "utf8"));
    const membership = { github_org_id: "42", login: "acme", avatar_url: null, role: "owner" as const };
    assert.equal(await store.saveVerifiedOrganizationMembership({ accountId: "alice", membership, create: false }), null);
    const setup = { accountId: "alice", membership, create: true };
    await Promise.all([store.saveVerifiedOrganizationMembership(setup), store.saveVerifiedOrganizationMembership(setup)]);
    assert.equal((await pool.query("SELECT * FROM organizations")).rowCount, 1);
    assert.equal((await pool.query("SELECT * FROM organization_memberships")).rowCount, 1);
    const before = (await pool.query("SELECT joined_at FROM organization_memberships")).rows[0].joined_at;
    await store.saveVerifiedOrganizationMembership({ ...setup, membership: { ...membership, login: "renamed", role: "member" }, create: false });
    const row = (await pool.query("SELECT * FROM organization_memberships")).rows[0];
    assert.equal(row.role, "member");
    assert.deepEqual(row.joined_at, before);
    assert.equal((await store.getOrganizationsForGitHubIds(["42"]))[0].login, "renamed");
    await store.saveVerifiedOrganizationMembership({ accountId: "bob", membership, create: false });
    assert.deepEqual(await store.getJoinedOrganizationIds("bob"), ["42"]);
    await pool.query(`
      CREATE TABLE rooms (id text PRIMARY KEY, display_name text, kind text);
      CREATE TABLE github_app_installations (
        installation_id text PRIMARY KEY, target_github_id text, target_type text,
        suspended_at timestamptz, uninstalled_at timestamptz
      );
      CREATE TABLE github_app_repositories (
        github_repo_id text PRIMARY KEY, installation_id text, removed_at timestamptz
      );
      CREATE TABLE github_repositories (github_repo_id text PRIMARY KEY, room_id text, full_name text);
      INSERT INTO github_app_installations VALUES
        ('active', '42', 'Organization', NULL, NULL),
        ('suspended', '42', 'Organization', now(), NULL),
        ('uninstalled', '42', 'Organization', NULL, now()),
        ('other', '99', 'Organization', NULL, NULL),
        ('personal', '42', 'User', NULL, NULL);
    `);
    for (const [id, installation, kind, removed] of [
      ["100", "active", "main", false],
      ["101", "suspended", "main", false],
      ["102", "uninstalled", "main", false],
      ["103", "other", "main", false],
      ["104", "personal", "main", false],
      ["105", "active", "main", true],
      ["106", "active", "focus", false],
    ]) {
      await pool.query("INSERT INTO rooms VALUES ($1, $2, $3)", [`repo-${id}`, `repo-${id}`, kind]);
      await pool.query("INSERT INTO github_repositories VALUES ($1, $2, $3)", [id, `repo-${id}`, `acme/repo-${id}`]);
      await pool.query("INSERT INTO github_app_repositories VALUES ($1, $2, $3)", [id, installation, removed ? new Date() : null]);
    }
    assert.deepEqual((await getConnectedOrganizationRooms("42")).map((room) => room.github_repo_id), ["100"]);
    assert.deepEqual((await getConnectedOrganizationRooms("99")).map((room) => room.github_repo_id), ["103"]);
    await assert.rejects(store.saveVerifiedOrganizationMembership({ accountId: "missing", membership: { ...membership, github_org_id: "43" }, create: true }));
    assert.deepEqual(await store.getOrganizationsForGitHubIds(["43"]), []);
    await store.removeOrganizationMembership("alice", "42");
    assert.deepEqual(await store.getJoinedOrganizationIds("alice"), []);
    assert.deepEqual(await store.getJoinedOrganizationIds("bob"), ["42"]);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
