import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL || process.env.DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
}

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../db.js") : null;
const rentalProjectionModule = testDatabaseUrl
  ? await import("../rental/room-projection.js")
  : null;

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const addMessage = dbModule?.addMessage;
const createProjectWithName = dbModule?.createProjectWithName;
const createTask = dbModule?.createTask;
const getGitChildRoom = dbModule?.getGitChildRoom;
const getGitHubRepositoryLinkById = dbModule?.getGitHubRepositoryLinkById;
const getOrCreateGitChildRoom = dbModule?.getOrCreateGitChildRoom;
const getProjectById = dbModule?.getProjectById;
const getRoomAlias = dbModule?.getRoomAlias;
const migrateGitHubRepositoryCanonicalRoom = dbModule?.migrateGitHubRepositoryCanonicalRoom;
const upsertGitHubAppInstallation = dbModule?.upsertGitHubAppInstallation;
const getGitHubAppInstallationById = dbModule?.getGitHubAppInstallationById;
const upsertGitHubAppRepository = dbModule?.upsertGitHubAppRepository;
const upsertGitHubRepositoryLink = dbModule?.upsertGitHubRepositoryLink;
const provisionRentalRoom = rentalProjectionModule?.provisionRentalRoom;

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseReady(): Promise<void> {
  if (!pool) {
    throw new Error("DB-backed repo migration tests require TEST_DB_URL or DB_URL");
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw lastError ?? new Error("database did not become ready in time");
}

async function resetDatabase(): Promise<void> {
  if (!db || !pool) {
    throw new Error("DB-backed repo migration tests require TEST_DB_URL or DB_URL");
  }

  await waitForDatabaseReady();
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder });
}

async function seedInstalledRepository(input: {
  installationId: string;
  githubRepoId: string;
  roomId: string;
  ownerLogin: string;
  repoName: string;
}): Promise<void> {
  if (
    !createProjectWithName ||
    !upsertGitHubAppInstallation ||
    !upsertGitHubAppRepository ||
    !upsertGitHubRepositoryLink
  ) {
    throw new Error("DB-backed repo migration tests require TEST_DB_URL or DB_URL");
  }

  await createProjectWithName(input.roomId);
  await upsertGitHubAppInstallation({
    installation_id: input.installationId,
    target_type: "Organization",
    target_login: input.ownerLogin,
    target_github_id: `${input.installationId}-acct`,
    repository_selection: "selected",
    permissions: { pull_requests: "write" },
  });
  await upsertGitHubAppRepository({
    github_repo_id: input.githubRepoId,
    installation_id: input.installationId,
    owner_login: input.ownerLogin,
    repo_name: input.repoName,
  });
  await upsertGitHubRepositoryLink({
    github_repo_id: input.githubRepoId,
    room_id: input.roomId,
    owner_login: input.ownerLogin,
    repo_name: input.repoName,
  });
}

if (!requiresDatabase) {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.after(async () => {
    await pool?.end();
  });
}

test(
  "migrateGitHubRepositoryCanonicalRoom preserves old locator as an alias after a repo rename",
  { concurrency: false, skip: requiresDatabase ? "set TEST_DB_URL or DB_URL to run DB-backed migration tests" : false },
  async () => {
    if (!migrateGitHubRepositoryCanonicalRoom || !getProjectById || !getRoomAlias || !getGitHubRepositoryLinkById) {
      throw new Error("DB-backed repo migration tests require TEST_DB_URL or DB_URL");
    }

    const oldRoomId = "github.com/brosincode/old-name";
    const nextRoomId = "github.com/brosincode/letagents";

    await seedInstalledRepository({
      installationId: "inst-rename",
      githubRepoId: "repo-rename",
      roomId: oldRoomId,
      ownerLogin: "brosincode",
      repoName: "old-name",
    });

    const migrated = await migrateGitHubRepositoryCanonicalRoom({
      github_repo_id: "repo-rename",
      owner_login: "brosincode",
      repo_name: "letagents",
    });

    assert.equal(migrated?.id, nextRoomId);
    assert.equal((await getProjectById(nextRoomId))?.id, nextRoomId);
    assert.equal((await getProjectById(oldRoomId))?.id, nextRoomId);
    const alias = await getRoomAlias(oldRoomId);
    assert.equal(alias?.alias, oldRoomId);
    assert.equal(alias?.room_id, nextRoomId);
    assert.equal((await getGitHubRepositoryLinkById("repo-rename"))?.room_id, nextRoomId);
    assert.equal((await getGitHubRepositoryLinkById("repo-rename"))?.full_name, "brosincode/letagents");
  }
);

test(
  "messages and tasks keep their numbering after a repo rename and a repo transfer",
  { concurrency: false, skip: requiresDatabase ? "set TEST_DB_URL or DB_URL to run DB-backed migration tests" : false },
  async () => {
    if (!migrateGitHubRepositoryCanonicalRoom || !addMessage || !createTask || !pool) {
      throw new Error("DB-backed repo migration tests require TEST_DB_URL or DB_URL");
    }

    const originalRoomId = "github.com/brosincode/numbered-old";
    const renamedRoomId = "github.com/brosincode/numbered-new";
    const transferredRoomId = "github.com/another-org/numbered-new";

    await seedInstalledRepository({
      installationId: "inst-numbered",
      githubRepoId: "repo-numbered",
      roomId: originalRoomId,
      ownerLogin: "brosincode",
      repoName: "numbered-old",
    });

    assert.equal((await addMessage(originalRoomId, "alice", "before rename 1")).id, "msg_1");
    assert.equal((await addMessage(originalRoomId, "alice", "before rename 2")).id, "msg_2");
    assert.equal((await createTask(originalRoomId, "before rename", "alice")).id, "task_1");

    await migrateGitHubRepositoryCanonicalRoom({
      github_repo_id: "repo-numbered",
      owner_login: "brosincode",
      repo_name: "numbered-new",
    });

    assert.equal((await addMessage(renamedRoomId, "alice", "after rename")).id, "msg_3");
    assert.equal((await createTask(renamedRoomId, "after rename", "alice")).id, "task_2");

    await migrateGitHubRepositoryCanonicalRoom({
      github_repo_id: "repo-numbered",
      owner_login: "another-org",
      repo_name: "numbered-new",
    });

    assert.equal((await addMessage(transferredRoomId, "alice", "after transfer")).id, "msg_4");
    assert.equal((await createTask(transferredRoomId, "after transfer", "alice")).id, "task_3");

    const sequences = await pool.query<{ name: string; value: number }>(
      "SELECT name, value FROM id_sequences WHERE name LIKE 'messages:%' OR name LIKE 'tasks:%' ORDER BY name",
    );
    assert.deepEqual(sequences.rows, [
      { name: `messages:${transferredRoomId}`, value: 4 },
      { name: `tasks:${transferredRoomId}`, value: 3 },
    ]);
  }
);

test(
  "a repo rename rewrites room ids that no foreign key cascades",
  { concurrency: false, skip: requiresDatabase ? "set TEST_DB_URL or DB_URL to run DB-backed migration tests" : false },
  async () => {
    if (!migrateGitHubRepositoryCanonicalRoom || !pool) {
      throw new Error("DB-backed repo migration tests require TEST_DB_URL or DB_URL");
    }

    const oldRoomId = "github.com/brosincode/plain-old";
    const nextRoomId = "github.com/brosincode/plain-new";
    const otherRoomId = "github.com/brosincode/unrelated";

    await seedInstalledRepository({
      installationId: "inst-plain",
      githubRepoId: "repo-plain",
      roomId: oldRoomId,
      ownerLogin: "brosincode",
      repoName: "plain-old",
    });
    await createProjectWithName!(otherRoomId);
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO accounts (id, provider, provider_user_id, login, created_at, updated_at)
       VALUES ('acct-plain', 'github', 'plain-user', 'plain', $1, $1)`,
      [now],
    );
    await pool.query(
      `INSERT INTO supervisor_host_grants (grant_id, owner_account_id, host_id, installation_id, token_hash,
         allowed_room_ids, allowed_agent_keys, issued_at, expires_at, created_at, updated_at)
       VALUES ('grant-plain', 'acct-plain', 'host', 'install', 'hash-plain', $1, ARRAY['agent'], $2, $2, $2, $2)`,
      [[otherRoomId, oldRoomId], now],
    );
    await pool.query(
      `INSERT INTO agent_asks (id, link_token_hash, room_id, asker_account_id, provider_id, model_label, expires_at)
       VALUES ('ask-plain', 'ask-hash-plain', $1, 'acct-plain', 'codex', 'Codex', $2)`,
      [oldRoomId, now],
    );
    await pool.query(
      `INSERT INTO tracker_connections (id, account_id, provider, display_name, site_key, auth_kind,
         credentials_ciphertext, credentials_iv)
       VALUES ('conn-plain', 'acct-plain', 'jira', 'Jira', 'site', 'api_token', 'x', 'y')`,
    );
    await pool.query(
      `INSERT INTO tracker_rules (id, connection_id, name, room_id, trigger, actions, created_by)
       VALUES ('rule-plain', 'conn-plain', 'Rule', $1, '{}'::jsonb, '[]'::jsonb, 'acct-plain')`,
      [oldRoomId],
    );
    await pool.query(
      `INSERT INTO tracker_rule_versions (id, rule_id, version, name, room_id, trigger, actions, created_by)
       VALUES ('rulev-plain', 'rule-plain', 1, 'Rule', $1, '{}'::jsonb, '[]'::jsonb, 'acct-plain')`,
      [oldRoomId],
    );

    // A task-watch rule in another room watches a task in this room.
    await pool.query(
      `INSERT INTO agent_wake_rules (id, room_id, agent_key, agent_name, event, arguments, identity_key,
         cursor_at, created_at, updated_at, expires_at, next_check_at, baseline)
       VALUES ('wake-plain', $1, 'owner/agent', 'Agent', 'task.status_changed', '{}'::jsonb, 'wake-plain',
         $3, $3, $3, $3, $3, jsonb_build_object('room_id', $2::text, 'status', 'in_progress'))`,
      [otherRoomId, oldRoomId, now],
    );
    // A reminder push queued for a message in this room.
    await addMessage!(oldRoomId, "alice", "remind me");
    await pool.query(
      `INSERT INTO message_reminders (id, account_id, room_id, message_number, due_at)
       VALUES ('reminder-plain', 'acct-plain', $1, 1, $2)`,
      [oldRoomId, now],
    );
    await pool.query(
      `INSERT INTO desktop_push_devices (id, account_id, installation_id, device_token, token_hash, bundle_id,
         environment, last_registered_at, created_at, updated_at)
       VALUES ('device-plain', 'acct-plain', 'install', 'token', 'token-hash', 'bundle', 'sandbox', $1, $1, $1)`,
      [now],
    );
    await pool.query(
      `INSERT INTO desktop_reminder_deliveries (id, reminder_id, device_id, room_id, message_number)
       VALUES ('delivery-plain', 'reminder-plain', 'device-plain', $1, 1)`,
      [oldRoomId],
    );

    await migrateGitHubRepositoryCanonicalRoom({
      github_repo_id: "repo-plain",
      owner_login: "brosincode",
      repo_name: "plain-new",
    });

    const grant = await pool.query("SELECT allowed_room_ids FROM supervisor_host_grants WHERE grant_id = 'grant-plain'");
    assert.deepEqual(grant.rows[0].allowed_room_ids, [otherRoomId, nextRoomId]);
    const ask = await pool.query("SELECT room_id FROM agent_asks WHERE id = 'ask-plain'");
    assert.equal(ask.rows[0].room_id, nextRoomId);
    const ruleVersion = await pool.query("SELECT room_id FROM tracker_rule_versions WHERE id = 'rulev-plain'");
    assert.equal(ruleVersion.rows[0].room_id, nextRoomId);
    const appRepository = await pool.query("SELECT room_id FROM github_app_repositories WHERE github_repo_id = 'repo-plain'");
    assert.equal(appRepository.rows[0].room_id, nextRoomId);
    const wakeRule = await pool.query("SELECT room_id, baseline FROM agent_wake_rules WHERE id = 'wake-plain'");
    assert.equal(wakeRule.rows[0].room_id, otherRoomId);
    assert.deepEqual(wakeRule.rows[0].baseline, { room_id: nextRoomId, status: "in_progress" });
    const reminderDelivery = await pool.query("SELECT room_id FROM desktop_reminder_deliveries WHERE id = 'delivery-plain'");
    assert.equal(reminderDelivery.rows[0].room_id, nextRoomId);
    const binding = await pool.query("SELECT repository_full_name FROM room_git_bindings WHERE room_id = $1", [nextRoomId]);
    assert.equal(binding.rows[0].repository_full_name, "brosincode/plain-new");
  }
);

test(
  "migrateGitHubRepositoryCanonicalRoom preserves old locator as an alias after a repo transfer",
  { concurrency: false, skip: requiresDatabase ? "set TEST_DB_URL or DB_URL to run DB-backed migration tests" : false },
  async () => {
    if (!migrateGitHubRepositoryCanonicalRoom || !getProjectById || !getRoomAlias || !getGitHubRepositoryLinkById) {
      throw new Error("DB-backed repo migration tests require TEST_DB_URL or DB_URL");
    }

    const oldRoomId = "github.com/oldorg/letagents";
    const nextRoomId = "github.com/neworg/letagents";

    await seedInstalledRepository({
      installationId: "inst-transfer",
      githubRepoId: "repo-transfer",
      roomId: oldRoomId,
      ownerLogin: "oldorg",
      repoName: "letagents",
    });

    const migrated = await migrateGitHubRepositoryCanonicalRoom({
      github_repo_id: "repo-transfer",
      owner_login: "neworg",
      repo_name: "letagents",
    });

    assert.equal(migrated?.id, nextRoomId);
    assert.equal((await getProjectById(nextRoomId))?.id, nextRoomId);
    assert.equal((await getProjectById(oldRoomId))?.id, nextRoomId);
    const alias = await getRoomAlias(oldRoomId);
    assert.equal(alias?.alias, oldRoomId);
    assert.equal(alias?.room_id, nextRoomId);
    assert.equal((await getGitHubRepositoryLinkById("repo-transfer"))?.room_id, nextRoomId);
    assert.equal((await getGitHubRepositoryLinkById("repo-transfer"))?.full_name, "neworg/letagents");
  }
);

test(
  "opaque Git child room identity survives a repo rename and remains discoverable by parent plus focus key",
  { concurrency: false, skip: requiresDatabase ? "set TEST_DB_URL or DB_URL to run DB-backed migration tests" : false },
  async () => {
    if (
      !getGitChildRoom ||
      !getOrCreateGitChildRoom ||
      !getProjectById ||
      !migrateGitHubRepositoryCanonicalRoom
    ) {
      throw new Error("DB-backed repo migration tests require TEST_DB_URL or DB_URL");
    }

    const oldRoomId = "github.com/brosincode/old-child-name";
    const nextRoomId = "github.com/brosincode/letagents-child";
    const focusKey = "git:branch:Y29kZXgvZ2l0LXJvb21z";

    await seedInstalledRepository({
      installationId: "inst-child-rename",
      githubRepoId: "repo-child-rename",
      roomId: oldRoomId,
      ownerLogin: "brosincode",
      repoName: "old-child-name",
    });
    const child = await getOrCreateGitChildRoom({
      parentRoomId: oldRoomId,
      focusKey,
      displayName: "branch: codex/git-rooms",
    });

    await migrateGitHubRepositoryCanonicalRoom({
      github_repo_id: "repo-child-rename",
      owner_login: "brosincode",
      repo_name: "letagents-child",
    });

    const storedChild = await getProjectById(child.room.id);
    assert.match(storedChild?.id || "", /^focus_\d+$/);
    assert.equal(storedChild?.parent_room_id, nextRoomId);

    const lookedUpByNewLocator = await getGitChildRoom({
      parentRoomId: nextRoomId,
      focusKey,
    });
    assert.equal(lookedUpByNewLocator?.id, child.room.id);
  }
);

test(
  "rental provisioning allocates a canonical focus room and remains idempotent",
  { concurrency: false, skip: requiresDatabase ? "set TEST_DB_URL or DB_URL to run DB-backed migration tests" : false },
  async () => {
    if (!createProjectWithName || !getProjectById || !pool || !provisionRentalRoom) {
      throw new Error("DB-backed rental provisioning tests require TEST_DB_URL or DB_URL");
    }

    const parentRoomId = "github.com/brosincode/rental-parent";
    const now = new Date().toISOString();
    await createProjectWithName(parentRoomId);
    await pool.query(
      `INSERT INTO accounts (id, provider, provider_user_id, login, created_at, updated_at)
       VALUES
         ('acct-renter', 'github', 'renter-user', 'renter', $1, $1),
         ('acct-provider', 'github', 'provider-user', 'provider', $1, $1)`,
      [now],
    );
    await pool.query(
      `INSERT INTO rental_listings (id, provider_account_id, display_name, ide_kind)
       VALUES ('listing-canonical-room', 'acct-provider', 'Canonical room provider', 'codex')`,
    );
    await pool.query(
      `INSERT INTO rental_sessions (
         id, listing_id, renter_account_id, provider_account_id, target_room_id,
         task_title, task_prompt, status
       ) VALUES (
         'session-canonical-room', 'listing-canonical-room', 'acct-renter',
         'acct-provider', $1, 'Canonical room task', 'Verify room allocation', 'accepted'
       )`,
      [parentRoomId],
    );

    const first = await provisionRentalRoom({
      sessionId: "session-canonical-room",
      parentRoomId,
      providerDisplayName: "Provider",
    });
    const second = await provisionRentalRoom({
      sessionId: "session-canonical-room",
      parentRoomId,
      providerDisplayName: "Provider",
    });
    const projectedRoom = await getProjectById(first.roomId);

    assert.match(first.roomId, /^focus_[1-9]\d*$/);
    assert.equal(second.roomId, first.roomId);
    assert.equal(second.participantId, first.participantId);
    assert.equal(projectedRoom?.kind, "focus");
    assert.equal(projectedRoom?.parent_room_id, parentRoomId);
    assert.equal(projectedRoom?.focus_key, "rental:session-canonical-room");
  },
);

test(
  "a repository webhook marks the installation as an organization and keeps what it does not carry",
  { concurrency: false, skip: requiresDatabase ? "set TEST_DB_URL or DB_URL to run DB-backed migration tests" : false },
  async () => {
    if (!upsertGitHubAppInstallation || !getGitHubAppInstallationById) {
      throw new Error("DB-backed repo migration tests require TEST_DB_URL or DB_URL");
    }

    // The installation event: the whole installation.
    await upsertGitHubAppInstallation({
      installation_id: "inst-keep",
      target_type: "Organization",
      target_login: "BrosInCode",
      target_github_id: "269600601",
      repository_selection: "all",
      permissions: { contents: "read", pull_requests: "write" },
      suspended_at: null,
      uninstalled_at: null,
    });
    // A later push or pull request event: only the ID and the organization.
    await upsertGitHubAppInstallation({
      installation_id: "inst-keep",
      target_type: "Organization",
      target_login: "BrosInCode",
      target_github_id: "269600601",
    });

    const stored = await getGitHubAppInstallationById("inst-keep");
    assert.equal(stored?.target_type, "Organization");
    assert.equal(stored?.repository_selection, "all");
    assert.equal(stored?.permissions_json, JSON.stringify({ contents: "read", pull_requests: "write" }));
    assert.equal(stored?.suspended_at, null);
    assert.equal(stored?.uninstalled_at, null);

    // An explicit null still clears: unsuspend and permission changes say so.
    await upsertGitHubAppInstallation({
      installation_id: "inst-keep",
      target_type: "Organization",
      target_login: "BrosInCode",
      target_github_id: "269600601",
      permissions: null,
      suspended_at: null,
    });
    assert.equal((await getGitHubAppInstallationById("inst-keep"))?.permissions_json, null);
  },
);
