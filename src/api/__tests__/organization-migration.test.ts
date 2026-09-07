import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";

test("organization migration preserves standalone rooms and enforces membership identity", {
  skip: !process.env.TEST_DB_URL && "set TEST_DB_URL to run DB-backed migration tests",
}, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DB_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA organization_migration_test");
    await client.query("SET LOCAL search_path TO organization_migration_test");
    await client.query("CREATE TABLE accounts (id text PRIMARY KEY); CREATE TABLE rooms (id text PRIMARY KEY)");
    await client.query("INSERT INTO accounts VALUES ('alice'), ('bob'); INSERT INTO rooms VALUES ('github.com/alice/shared')");
    const migration = await readFile(new URL("../../../drizzle/0093_organizations.sql", import.meta.url), "utf8");
    await client.query(migration);
    await client.query("INSERT INTO organizations VALUES ('1', 'acme', NULL, now(), now()), ('2', 'other', NULL, now(), now())");
    await client.query("INSERT INTO organization_memberships VALUES ('1', 'alice', 'owner', now(), now()), ('2', 'alice', 'member', now(), now())");
    await client.query("UPDATE organizations SET login = 'renamed' WHERE github_org_id = '1'");
    assert.equal((await client.query("SELECT * FROM organization_memberships WHERE account_id = 'alice'")).rowCount, 2);
    for (const [statement, code] of [
      ["INSERT INTO organizations VALUES ('1', 'duplicate', NULL, now(), now())", "23505"],
      ["INSERT INTO organization_memberships VALUES ('1', 'alice', 'member', now(), now())", "23505"],
      ["INSERT INTO organization_memberships VALUES ('1', 'bob', 'admin', now(), now())", "23514"],
      ["INSERT INTO organization_memberships VALUES ('99', 'bob', 'member', now(), now())", "23503"],
    ]) {
      await client.query("SAVEPOINT invalid_membership");
      await assert.rejects(client.query(statement), { code });
      await client.query("ROLLBACK TO SAVEPOINT invalid_membership");
    }
    await client.query("DELETE FROM organizations WHERE github_org_id = '1'");
    assert.equal((await client.query("SELECT * FROM organization_memberships")).rowCount, 1);
    assert.deepEqual((await client.query("SELECT * FROM rooms")).rows, [{ id: "github.com/alice/shared" }]);
    await client.query("DELETE FROM accounts WHERE id = 'alice'");
    assert.equal((await client.query("SELECT * FROM organization_memberships")).rowCount, 0);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
