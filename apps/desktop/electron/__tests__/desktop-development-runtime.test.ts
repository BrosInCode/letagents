import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

interface PackageManifest {
  scripts?: Record<string, string>;
}

function readManifest(url: URL): PackageManifest {
  return JSON.parse(readFileSync(url, "utf8")) as PackageManifest;
}

test("desktop development builds every runtime before starting its watchers and Electron", () => {
  const rootManifest = readManifest(new URL("../../../../package.json", import.meta.url));
  const desktopManifest = readManifest(new URL("../../package.json", import.meta.url));

  assert.equal(
    rootManifest.scripts?.["dev:desktop"],
    "node scripts/ensure-desktop-dependencies.mjs && npm --prefix apps/desktop run dev",
  );
  assert.equal(
    desktopManifest.scripts?.dev,
    "npm run build:dev && concurrently -k \"npm:dev:renderer\" \"npm:watch:mcp\" \"npm:watch:electron\" \"npm:watch:daemon\" \"npm:serve:electron\"",
  );
  assert.equal(
    desktopManifest.scripts?.["build:dev"],
    "npm run build:mcp && npm run build:electron && npm run build:daemon",
  );
  assert.equal(desktopManifest.scripts?.["build:mcp"], "npm --prefix ../.. run build");
  assert.equal(
    desktopManifest.scripts?.["watch:mcp"],
    "tsc -p ../../tsconfig.json --watch --preserveWatchOutput",
  );
  assert.equal(
    desktopManifest.scripts?.["serve:electron"],
    "wait-on tcp:5174 ../../dist/mcp/server.js dist-electron/main.js dist-daemon/main.js && cross-env LETAGENTS_DESKTOP_DEV_SERVER_URL=http://127.0.0.1:5174 electron .",
  );
  assert.match(desktopManifest.scripts?.["test:electron"] ?? "", /--test-concurrency=1/);
});

const bootstrapUrl = new URL("../../../../scripts/ensure-desktop-dependencies.mjs", import.meta.url);
const runnerSource = `
  import { writeFileSync } from "node:fs";
  import { ensureDesktopDependencies } from ${JSON.stringify(bootstrapUrl.href)};
  ensureDesktopDependencies({
    repoRoot: process.argv[1],
    desktopRoot: process.argv[2],
    lockRoot: process.argv[3],
    npmCommand: process.execPath,
    npmCommandArgs: [process.argv[4]],
    lockTimeoutMs: Number(process.env.FAKE_LOCK_TIMEOUT_MS || 10_000),
    onLockContention: process.env.FAKE_NPM_CONTENTION_PATH
      ? () => writeFileSync(process.env.FAKE_NPM_CONTENTION_PATH, "waiting")
      : undefined,
  });
`;

interface BootstrapFixture {
  root: string;
  desktopRoot: string;
  linkedDesktopRoot: string;
  lockRoot: string;
  installLogPath: string;
  fakeNpmPath: string;
}

function makeBootstrapFixture(): BootstrapFixture {
  const root = mkdtempSync(join(tmpdir(), "letagents-desktop-bootstrap-test-"));
  const desktopRoot = join(root, "apps", "desktop");
  const linkedDesktopRoot = join(root, "linked-worktree", "apps", "desktop");
  const lockRoot = join(root, "locks");
  mkdirSync(desktopRoot, { recursive: true });
  mkdirSync(linkedDesktopRoot, { recursive: true });
  mkdirSync(join(desktopRoot, "node_modules"));
  symlinkSync(join(desktopRoot, "node_modules"), join(linkedDesktopRoot, "node_modules"), "dir");
  mkdirSync(lockRoot);
  writeFileSync(join(desktopRoot, "package.json"), '{"name":"desktop-test","private":true}\n');
  writeFileSync(join(desktopRoot, "package-lock.json"), '{"name":"desktop-test","lockfileVersion":3}\n');
  writeFileSync(join(linkedDesktopRoot, "package.json"), '{"name":"desktop-test","private":true}\n');
  writeFileSync(join(linkedDesktopRoot, "package-lock.json"), '{"name":"desktop-test","lockfileVersion":3}\n');

  const installLogPath = join(root, "installs.jsonl");
  const fakeNpmPath = join(root, "fake-npm.mjs");
  writeFileSync(
    fakeNpmPath,
    `
      import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const args = process.argv.slice(2);
      const prefix = args[args.indexOf("--prefix") + 1];
      const marker = join(prefix, "node_modules", ".fake-install-complete");
      if (args[0] === "ls") process.exit(existsSync(marker) ? 0 : 1);
      if (args[0] === "rebuild") process.exit(0);
      if (args[0] !== "install") process.exit(2);
      appendFileSync(process.env.FAKE_NPM_INSTALL_LOG, JSON.stringify({ args, nodeEnv: process.env.NODE_ENV }) + "\\n");
      if (process.env.FAKE_NPM_FAIL === "1") process.exit(7);
      if (process.env.FAKE_NPM_RELEASE_PATH) {
        const releaseDeadline = Date.now() + 5_000;
        while (!existsSync(process.env.FAKE_NPM_RELEASE_PATH)) {
          if (Date.now() >= releaseDeadline) process.exit(8);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const dependencyRoot = join(prefix, "node_modules");
      const binRoot = join(dependencyRoot, ".bin");
      mkdirSync(binRoot, { recursive: true });
      if (process.env.npm_config_ignore_scripts !== "true") {
        for (const name of ["concurrently", "cross-env", "electron", "tsc", "vite", "vue-tsc", "wait-on"]) {
          writeFileSync(join(binRoot, name), "");
        }
        mkdirSync(join(dependencyRoot, "esbuild", "bin"), { recursive: true });
        writeFileSync(join(dependencyRoot, "esbuild", "bin", "esbuild"), "");
      }
      writeFileSync(marker, "complete");
      if (process.env.FAKE_NPM_MUTATE_LOCK === "1") {
        writeFileSync(join(prefix, "package-lock.json"), '{"mutated":true}\\n');
      }
    `,
  );

  return {
    root,
    desktopRoot,
    linkedDesktopRoot,
    lockRoot,
    installLogPath,
    fakeNpmPath,
  };
}

function runBootstrap(
  fixture: BootstrapFixture,
  extraEnv: NodeJS.ProcessEnv = {},
  desktopRoot = fixture.desktopRoot,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        runnerSource,
        fixture.root,
        desktopRoot,
        fixture.lockRoot,
        fixture.fakeNpmPath,
      ],
      {
        env: {
          ...process.env,
          FAKE_NPM_INSTALL_LOG: fixture.installLogPath,
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function installRecords(fixture: BootstrapFixture): Array<{ args: string[]; nodeEnv?: string }> {
  if (!existsSync(fixture.installLogPath)) return [];
  return readFileSync(fixture.installLogPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; nodeEnv?: string });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for test file: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("desktop dependency bootstrap serializes cold starts and preserves its valid cache", async (t) => {
  const fixture = makeBootstrapFixture();
  const releasePath = join(fixture.root, "release-install");
  const contentionPath = join(fixture.root, "lock-contention");
  t.after(() => {
    writeFileSync(releasePath, "release");
    rmSync(fixture.root, { recursive: true, force: true });
  });
  const environment = { NODE_ENV: "production", FAKE_NPM_RELEASE_PATH: releasePath };
  const firstResult = runBootstrap(fixture, environment);
  await waitForFile(fixture.installLogPath);
  const secondResult = runBootstrap(
    fixture,
    { ...environment, FAKE_NPM_CONTENTION_PATH: contentionPath },
    fixture.linkedDesktopRoot,
  );
  await waitForFile(contentionPath);
  assert.equal(installRecords(fixture).length, 1);
  writeFileSync(releasePath, "release");
  const [first, second] = await Promise.all([firstResult, secondResult]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.match(first.stdout + second.stdout, /updated by another process/);

  const installs = installRecords(fixture);
  assert.equal(installs.length, 1);
  assert.ok(installs[0]?.args.includes("--include=dev"));
  assert.ok(installs[0]?.args.includes("--include=optional"));
  assert.ok(installs[0]?.args.includes("--package-lock=true"));
  assert.equal(installs[0]?.nodeEnv, "production");

  const cached = await runBootstrap(fixture);
  assert.equal(cached.code, 0, cached.stderr);
  assert.match(cached.stdout, /dependencies are current/);
  assert.equal(installRecords(fixture).length, 1);
});

test("desktop dependency bootstrap leaves no cache stamp after failed or incomplete installs", async (t) => {
  const fixture = makeBootstrapFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const stampPath = join(fixture.desktopRoot, "node_modules", ".letagents-package-lock.sha256");

  const failed = await runBootstrap(fixture, { FAKE_NPM_FAIL: "1" });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /install failed with status 7/);
  assert.equal(existsSync(stampPath), false);

  const recovered = await runBootstrap(fixture);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(existsSync(stampPath), true);

  rmSync(stampPath);
  rmSync(join(fixture.desktopRoot, "node_modules", "esbuild", "bin", "esbuild"));
  const ignoredScripts = await runBootstrap(fixture, { npm_config_ignore_scripts: "true" });
  assert.equal(ignoredScripts.code, 1);
  assert.match(ignoredScripts.stderr, /ignore-scripts/);
  assert.equal(existsSync(stampPath), false);
});

test("desktop dependency bootstrap refuses to bless a mutated lockfile", async (t) => {
  const fixture = makeBootstrapFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const result = await runBootstrap(fixture, { FAKE_NPM_MUTATE_LOCK: "1" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /changed apps\/desktop\/package-lock\.json/);
  assert.equal(
    existsSync(join(fixture.desktopRoot, "node_modules", ".letagents-package-lock.sha256")),
    false,
  );
});

test("desktop dependency bootstrap never steals an abandoned install lock", async (t) => {
  const fixture = makeBootstrapFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const installTarget = realpathSync(join(fixture.desktopRoot, "node_modules"));
  const targetDigest = createHash("sha256").update(installTarget).digest("hex").slice(0, 24);
  const lockPath = join(
    fixture.lockRoot,
    `letagents-desktop-dependencies-${targetDigest}.lock`,
  );
  mkdirSync(lockPath);
  const ownerPath = join(lockPath, "owner.json");
  const owner = '{"pid":2147483647,"token":"abandoned"}\n';
  writeFileSync(ownerPath, owner);

  const result = await runBootstrap(fixture, { FAKE_LOCK_TIMEOUT_MS: "50" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /held by PID 2147483647/);
  assert.match(result.stderr, /remove that exact lock directory and retry/);
  assert.equal(readFileSync(ownerPath, "utf8"), owner);
});
