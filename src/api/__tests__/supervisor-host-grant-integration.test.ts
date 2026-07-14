import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = "true";

const client = testDatabaseUrl ? await import("../db/client.js") : null;
const authDb = testDatabaseUrl ? await import("../db.js") : null;
const schema = testDatabaseUrl ? await import("../db/schema.js") : null;
const { resolveRequestAuth } = await import("../request/auth.js");
const { isSupervisorGrantRouteAllowed } = await import("../request/supervisor-grant-route-registry.js");

async function reset() {
  if (!client) throw new Error("DB-backed supervisor tests require TEST_DB_URL");
  await client.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.pool.query("CREATE SCHEMA public");
  await migrate(client.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

if (!requiresDatabase) {
  test.beforeEach(reset);
  test.after(async () => { await client?.pool.end(); });
}

async function seedOwner(id: string): Promise<void> {
  await client!.db.insert(schema!.accounts).values({
    id, provider: "github", provider_user_id: id, login: id, display_name: id,
    avatar_url: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
}

test("supervisor registry is exact default-deny", () => {
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/grant_1/renew"), true);
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/rooms/room_1/messages"), false);
  assert.equal(isSupervisorGrantRouteAllowed("DELETE", "/supervisor-host-grants/grant_1"), false);
});

test("concurrent renewal has exactly one winner and stale token cannot replay", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_1");
  const created = await authDb!.createSupervisorHostGrant({
    owner_account_id: "owner_1", host_id: "host_1", installation_id: "install_1",
    allowed_room_ids: ["room_1"], allowed_agent_keys: ["owner/agent_1"], expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const input = { grant_id: created.grant.grant_id, expected_generation: 1, expected_token_version: 1, expires_at: new Date(Date.now() + 120_000).toISOString() };
  const [left, right] = await Promise.all([authDb!.rotateSupervisorHostGrant(input), authDb!.rotateSupervisorHostGrant(input)]);
  assert.equal([left, right].filter(Boolean).length, 1);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${created.token}` } } as never)).authKind, null);
  const winner = left ?? right;
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${winner!.token}` } } as never)).authKind, "supervisor_grant");
});

test("handoff is a current-generation CAS and revoked/lapsed grants cannot authenticate", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_2");
  const created = await authDb!.createSupervisorHostGrant({
    owner_account_id: "owner_2", host_id: "host_2", installation_id: "install_2",
    allowed_room_ids: ["room_2"], allowed_agent_keys: ["owner/agent_2"], expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const [left, right] = await Promise.all([
    authDb!.advanceSupervisorHostGrantGeneration({ grant_id: created.grant.grant_id, expected_generation: 1, expected_token_version: 1 }),
    authDb!.advanceSupervisorHostGrantGeneration({ grant_id: created.grant.grant_id, expected_generation: 1, expected_token_version: 1 }),
  ]);
  assert.equal([left, right].filter(Boolean).length, 1);
  assert.equal((await authDb!.advanceSupervisorHostGrantGeneration({ grant_id: created.grant.grant_id, expected_generation: 1, expected_token_version: 1 })), null);
  await authDb!.revokeSupervisorHostGrant({ grant_id: created.grant.grant_id, owner_account_id: "owner_2" });
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${created.token}` } } as never)).authKind, null);
});
