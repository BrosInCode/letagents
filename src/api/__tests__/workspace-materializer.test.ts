/**
 * Tests for Workspace Materializer + Retention — p4.0
 *
 * Uses node:test runner + node:assert/strict (project convention).
 * Tests against a real fixture git repo created in beforeAll.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import {
  materializeWorkspace,
  getActiveManifest,
  type WorkspaceMaterializerDeps,
} from "../rental/workspace-materializer.js";
import {
  runRetentionSweep,
  archiveWorkspace,
  type WorkspaceRetentionDeps,
} from "../rental/workspace-retention.js";

// ---------------------------------------------------------------------------
// Test fixture: a tiny git repo with known files
// ---------------------------------------------------------------------------

let fixtureRepoPath: string;
let fixtureCommitSha: string;
let testWorkspaceRoot: string;

before(() => {
  fixtureRepoPath = path.join(os.tmpdir(), `rental-test-repo-${Date.now()}`);
  fs.mkdirSync(fixtureRepoPath, { recursive: true });

  execSync("git init", { cwd: fixtureRepoPath, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', {
    cwd: fixtureRepoPath,
    stdio: "pipe",
  });
  execSync('git config user.name "Test"', {
    cwd: fixtureRepoPath,
    stdio: "pipe",
  });

  // Create test file structure
  fs.mkdirSync(path.join(fixtureRepoPath, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureRepoPath, "src", "index.ts"),
    'export const hello = "world";',
  );
  fs.writeFileSync(
    path.join(fixtureRepoPath, "src", "utils.ts"),
    "export const add = (a: number, b: number) => a + b;",
  );
  fs.mkdirSync(path.join(fixtureRepoPath, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureRepoPath, "docs", "README.md"),
    "# Test project",
  );
  fs.writeFileSync(
    path.join(fixtureRepoPath, ".env"),
    "SECRET_KEY=should-not-leak",
  );
  fs.writeFileSync(
    path.join(fixtureRepoPath, "package.json"),
    '{"name":"test"}',
  );

  execSync("git add -A", { cwd: fixtureRepoPath, stdio: "pipe" });
  execSync('git commit -m "initial"', {
    cwd: fixtureRepoPath,
    stdio: "pipe",
  });

  fixtureCommitSha = execSync("git rev-parse HEAD", {
    cwd: fixtureRepoPath,
    encoding: "utf-8",
  }).trim();

  testWorkspaceRoot = path.join(
    os.tmpdir(),
    `rental-test-workspaces-${Date.now()}`,
  );
});

after(() => {
  try {
    if (fixtureRepoPath) {
      fs.rmSync(fixtureRepoPath, { recursive: true, force: true });
    }
    if (testWorkspaceRoot) {
      fs.rmSync(testWorkspaceRoot, { recursive: true, force: true });
    }
  } catch {
    // Best effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

function createMockDb() {
  const manifests = new Map<string, Record<string, unknown>>();

  return {
    manifests,
    db: {
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          returning: async () => {
            manifests.set(v.id as string, { ...v });
            return [v];
          },
        }),
      }),
      update: () => ({
        set: (updates: Record<string, unknown>) => ({
          where: async () => {
            for (const [, manifest] of manifests) {
              Object.assign(manifest, updates);
            }
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: async () => Array.from(manifests.values()),
        }),
      }),
    } as unknown as WorkspaceMaterializerDeps["db"],
  };
}

let idCounter = 0;
function mockGenerateId(): string {
  return `manifest_test_${++idCounter}`;
}

// ---------------------------------------------------------------------------
// Materializer tests
// ---------------------------------------------------------------------------

describe("WorkspaceMaterializer", () => {
  it("materializes full workspace (Trusted Open — no scope globs)", async () => {
    const { db } = createMockDb();
    const deps: WorkspaceMaterializerDeps = {
      db,
      generateId: mockGenerateId,
    };

    const result = await materializeWorkspace(deps, {
      sessionId: "session_test_1",
      repoUrl: fixtureRepoPath,
      baseCommitSha: fixtureCommitSha,
      scopeGlobs: [],
      workspaceRoot: testWorkspaceRoot,
    });

    assert.ok(result.manifestId, "manifest ID should be set");
    assert.ok(
      result.workspacePath.includes(testWorkspaceRoot),
      "workspace should be under root",
    );
    assert.equal(result.workBranch, "rental/session_test_1");
    assert.ok(result.filesMaterialized >= 3, "should have ≥3 files (minus .env)");
    assert.ok(result.bytesMaterialized > 0, "should have >0 bytes");

    // Workspace directory should exist
    assert.ok(fs.existsSync(result.workspacePath), "workspace dir exists");
    assert.ok(
      fs.existsSync(path.join(result.workspacePath, "src", "index.ts")),
      "src/index.ts exists",
    );

    // .env should be blocked even in Trusted Open mode (always-blocked denylist)
    assert.ok(
      !fs.existsSync(path.join(result.workspacePath, ".env")),
      ".env should be blocked even in Trusted Open mode",
    );
  });

  it("materializes scoped workspace — only src/**/*.ts", async () => {
    const { db } = createMockDb();
    const deps: WorkspaceMaterializerDeps = {
      db,
      generateId: mockGenerateId,
    };

    const result = await materializeWorkspace(deps, {
      sessionId: "session_test_2",
      repoUrl: fixtureRepoPath,
      baseCommitSha: fixtureCommitSha,
      scopeGlobs: ["src/**/*.ts"],
      workspaceRoot: testWorkspaceRoot,
    });

    assert.ok(result.filesMaterialized >= 2, "should have ≥2 .ts files");

    // .env and docs should be filtered out
    assert.ok(
      !fs.existsSync(path.join(result.workspacePath, ".env")),
      ".env should be removed",
    );
    assert.ok(
      !fs.existsSync(path.join(result.workspacePath, "docs", "README.md")),
      "docs/README.md should be removed",
    );

    // src files should be present
    assert.ok(
      fs.existsSync(path.join(result.workspacePath, "src", "index.ts")),
      "src/index.ts should exist",
    );
    assert.ok(
      fs.existsSync(path.join(result.workspacePath, "src", "utils.ts")),
      "src/utils.ts should exist",
    );
  });

  it("re-materialization reuses cached bare clone", async () => {
    const { db } = createMockDb();
    const logs: string[] = [];
    const deps: WorkspaceMaterializerDeps = {
      db,
      generateId: mockGenerateId,
      log: (msg) => logs.push(msg),
    };

    // First — should clone
    await materializeWorkspace(deps, {
      sessionId: "session_test_3a",
      repoUrl: fixtureRepoPath,
      baseCommitSha: fixtureCommitSha,
      scopeGlobs: [],
      workspaceRoot: testWorkspaceRoot,
    });

    // Second — should reuse
    logs.length = 0;
    await materializeWorkspace(deps, {
      sessionId: "session_test_3b",
      repoUrl: fixtureRepoPath,
      baseCommitSha: fixtureCommitSha,
      scopeGlobs: [],
      workspaceRoot: testWorkspaceRoot,
    });

    const reuseLogs = logs.filter((l) => l.includes("Reusing cached"));
    assert.ok(reuseLogs.length > 0, "should log reuse of cached bare clone");
  });

  it("throws on invalid base commit", async () => {
    const { db } = createMockDb();
    const deps: WorkspaceMaterializerDeps = {
      db,
      generateId: mockGenerateId,
    };

    await assert.rejects(
      () =>
        materializeWorkspace(deps, {
          sessionId: "session_test_bad",
          repoUrl: fixtureRepoPath,
          baseCommitSha: "0000000000000000000000000000000000000000",
          scopeGlobs: [],
          workspaceRoot: testWorkspaceRoot,
        }),
      /Base commit/,
      "should throw on invalid commit",
    );
  });
});

// ---------------------------------------------------------------------------
// Retention tests
// ---------------------------------------------------------------------------

describe("WorkspaceRetention", () => {
  it("archiveWorkspace marks manifest as expired for sweep pickup", async () => {
    let updatedStatus: string | null = null;
    const archiveDb = {
      update: () => ({
        set: (updates: Record<string, unknown>) => ({
          where: async () => {
            updatedStatus = updates.retention_status as string;
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
    } as unknown as WorkspaceRetentionDeps["db"];

    await archiveWorkspace({ db: archiveDb }, "session_archive_1");

    assert.equal(updatedStatus, "expired", "should set status to expired for sweep");
  });

  it("retention sweep processes expired workspaces", async () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60);
    const expiredWorkspacePath = path.join(
      testWorkspaceRoot,
      "retention-test-dir",
    );
    fs.mkdirSync(expiredWorkspacePath, { recursive: true });
    fs.writeFileSync(path.join(expiredWorkspacePath, "test.txt"), "content");

    let markedExpired = false;
    let markedDeleted = false;

    const retentionDb = {
      update: () => ({
        set: (updates: Record<string, unknown>) => ({
          where: async () => {
            if (updates.retention_status === "expired") markedExpired = true;
            if (updates.retention_status === "deleted") markedDeleted = true;
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: async () => [
            {
              id: "manifest_ret_1",
              session_id: "session_ret_1",
              workspace_path: expiredWorkspacePath,
              work_branch: "rental/session_ret_1",
              retention_status: "active",
              expires_at: pastDate,
            },
          ],
        }),
      }),
    } as unknown as WorkspaceRetentionDeps["db"];

    const result = await runRetentionSweep({ db: retentionDb });

    // The sweep should have processed the manifest
    assert.ok(
      result.expiredCount + result.deletedCount >= 1,
      "should process ≥1 manifest",
    );
  });
});

// ---------------------------------------------------------------------------
// Submodule neutrality
// ---------------------------------------------------------------------------

describe("WorkspaceMaterializer submodule handling", () => {
  let submoduleCommitSha: string;

  before(() => {
    // Add a gitlink + .gitmodules pointing at a host that cannot resolve.
    // If any materializer git command tried to fetch the submodule, the
    // command would fail loudly and the test below would not succeed.
    fs.writeFileSync(
      path.join(fixtureRepoPath, ".gitmodules"),
      [
        '[submodule "vendor/dep"]',
        "\tpath = vendor/dep",
        "\turl = https://letagents-submodule-test.invalid/dep.git",
        "",
      ].join("\n"),
    );
    execSync("git add .gitmodules", { cwd: fixtureRepoPath, stdio: "pipe" });
    execSync(
      `git update-index --add --cacheinfo 160000,${fixtureCommitSha},vendor/dep`,
      { cwd: fixtureRepoPath, stdio: "pipe" },
    );
    execSync('git commit -m "add submodule gitlink"', {
      cwd: fixtureRepoPath,
      stdio: "pipe",
    });
    submoduleCommitSha = execSync("git rev-parse HEAD", {
      cwd: fixtureRepoPath,
      encoding: "utf-8",
    }).trim();
  });

  it("materializes a repo with submodules without fetching them", async () => {
    const { db } = createMockDb();
    const submoduleWorkspaceRoot = path.join(
      os.tmpdir(),
      `rental-test-submodule-ws-${Date.now()}`,
    );

    try {
      const result = await materializeWorkspace(
        { db, generateId: mockGenerateId },
        {
          sessionId: "session_submodule_1",
          repoUrl: fixtureRepoPath,
          baseCommitSha: submoduleCommitSha,
          scopeGlobs: [],
          workspaceRoot: submoduleWorkspaceRoot,
        },
      );

      // Materialization succeeded — nothing contacted the .invalid host.
      assert.ok(result.manifestId);

      // .gitmodules is exported as an inert plain file...
      const gitmodulesPath = path.join(result.workspacePath, ".gitmodules");
      assert.ok(fs.existsSync(gitmodulesPath), ".gitmodules should be a plain file");
      assert.match(
        fs.readFileSync(gitmodulesPath, "utf-8"),
        /letagents-submodule-test\.invalid/,
      );

      // ...and the gitlink produced no submodule content: at most an
      // empty directory, never files, never a nested .git.
      const gitlinkPath = path.join(result.workspacePath, "vendor", "dep");
      if (fs.existsSync(gitlinkPath)) {
        assert.deepStrictEqual(
          fs.readdirSync(gitlinkPath),
          [],
          "gitlink must not materialize submodule content",
        );
      }
      assert.ok(
        !fs.existsSync(path.join(result.workspacePath, ".git")),
        "workspace must not contain a .git directory",
      );
    } finally {
      fs.rmSync(submoduleWorkspaceRoot, { recursive: true, force: true });
    }
  });
});
