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
