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

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const createProjectWithName = dbModule?.createProjectWithName;
const getGitHubRepositoryLinkById = dbModule?.getGitHubRepositoryLinkById;
const getProjectById = dbModule?.getProjectById;
const getRoomAlias = dbModule?.getRoomAlias;
const migrateGitHubRepositoryCanonicalRoom = dbModule?.migrateGitHubRepositoryCanonicalRoom;
const upsertGitHubAppInstallation = dbModule?.upsertGitHubAppInstallation;
const upsertGitHubAppRepository = dbModule?.upsertGitHubAppRepository;
const upsertGitHubRepositoryLink = dbModule?.upsertGitHubRepositoryLink;

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
