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
    await client.query("CREATE TABLE accounts (id text PRIMARY KEY); CREATE TABLE rooms (id text PRIMARY KEY, display_name text)");
    await client.query("INSERT INTO accounts VALUES ('alice'), ('bob'); INSERT INTO rooms VALUES ('github.com/alice/shared', 'shared')");
    const migration = await readFile(new URL("../../../drizzle/0143_organizations.sql", import.meta.url), "utf8");
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
    // Rooms may belong to a company; deleting the company only detaches them.
    await client.query("INSERT INTO rooms (id, display_name, organization_id) VALUES ('adhoc-1', 'Adhoc', '1'), ('adhoc-2', 'Plain', NULL)");
    await client.query("SAVEPOINT bad_room_org");
    await assert.rejects(
      client.query("INSERT INTO rooms (id, display_name, organization_id) VALUES ('adhoc-3', 'Bad', '404')"),
      { code: "23503" },
    );
    await client.query("ROLLBACK TO SAVEPOINT bad_room_org");
    const partial = await client.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'rooms_organization_id_idx' AND schemaname = 'organization_migration_test'");
    assert.match(partial.rows[0].indexdef, /WHERE \(organization_id IS NOT NULL\)/);
    await client.query("DELETE FROM organizations WHERE github_org_id = '1'");
    assert.equal((await client.query("SELECT organization_id FROM rooms WHERE id = 'adhoc-1'")).rows[0].organization_id, null);
    assert.equal((await client.query("SELECT * FROM organization_memberships")).rowCount, 1);
    assert.deepEqual(
      (await client.query("SELECT id, organization_id FROM rooms WHERE id = 'github.com/alice/shared'")).rows,
      [{ id: "github.com/alice/shared", organization_id: null }],
    );
    await client.query("DELETE FROM accounts WHERE id = 'alice'");
    assert.equal((await client.query("SELECT * FROM organization_memberships")).rowCount, 0);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
