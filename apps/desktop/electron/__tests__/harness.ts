import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

type TrackedSqliteDatabase = { close: () => void; isOpen?: boolean };

/**
 * Every node:sqlite connection this test process opens, with its file path.
 * The desktop app keeps its SQLite connections (local chat, project bindings)
 * open for its whole life, and so does a test process that loads those
 * modules. On Windows an open file cannot be deleted, so the temp-folder
 * cleanup must close them first; see `removeTestDirectory`.
 */
const openSqliteDatabases = new Map<TrackedSqliteDatabase, string>();

function databaseFilePath(name: string): string {
  if (!name.startsWith("file:")) return name;
  try { return fileURLToPath(name.split("?")[0]!); } catch { return name; }
}

function trackSqliteDatabases(): void {
  const sqlite = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (...args: unknown[]) => TrackedSqliteDatabase;
  };
  const marker = Symbol.for("letagents.test.trackedDatabaseSync");
  if ((sqlite.DatabaseSync as unknown as Record<symbol, boolean>)[marker]) return;
  sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, {
    construct(target, args, newTarget) {
      const database = Reflect.construct(target, args, newTarget) as TrackedSqliteDatabase;
      if (typeof args[0] === "string" && args[0] !== ":memory:") {
        // The daemon opens its state by a file: URL; the folder it lives in is what matters.
        openSqliteDatabases.set(database, resolve(databaseFilePath(args[0])));
      }
      return database;
    },
    get(target, property, receiver) {
      return property === marker ? true : Reflect.get(target, property, receiver);
    },
  });
  // ES-module imports of node:sqlite see the wrapped constructor too.
  syncBuiltinESMExports();
}

// Only Windows refuses to delete an open file; elsewhere nothing is tracked.
if (process.platform === "win32") trackSqliteDatabases();

function isInside(path: string, folder: string): boolean {
  const inside = relative(resolve(folder), path);
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

function closeSqliteDatabasesUnder(folder: string): void {
  for (const [database, path] of openSqliteDatabases) {
    if (!isInside(path, folder)) continue;
    openSqliteDatabases.delete(database);
    try { database.close(); } catch { /* already closed */ }
  }
}

function isWindowsOpenFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return process.platform === "win32" && (code === "EBUSY" || code === "EPERM");
}

/**
 * Delete a test's temp folder. POSIX deletes a file that is still open;
 * Windows refuses (EBUSY/EPERM) while any handle is open, and the app's
 * long-lived SQLite connections stay open until the process ends. Then the
 * deletion waits for process exit, after every later `after` hook has run
 * (so none of them finds its database closed), closes the SQLite connections
 * under the folder and deletes it. If a file is still held then, a detached
 * process removes the folder once this one has ended and released its handles.
 */
export function removeTestDirectory(folder: string): void {
  try {
    rmSync(folder, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!isWindowsOpenFileError(error)) throw error;
  }
  process.once("exit", () => {
    closeSqliteDatabasesUnder(folder);
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      // Something still holds a file open (a database a daemon test did not stop). The system releases every
      // handle when this process ends, so a detached process, which outlives it, removes the folder then.
      try {
        spawn(process.execPath, ["-e", `
          const folder = process.argv[1];
          setTimeout(() => { try { require("node:fs").rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch {} }, 1500);
        `, folder], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      } catch {
        process.stderr.write(`test cleanup could not remove ${folder}: ${String(error)}\n`);
        process.exitCode = 1;
      }
    }
  });
}

export type ElectronTestEnvPathKind =
  | "state"
  | "chatStorage"
  | "localChatDb"
  | "localProfile";

export type ElectronTestEnvOptions = {
  /** Prefix for the temp directory name (passed to mkdtempSync). */
  prefix: string;
  /**
   * Which standard LetAgents desktop env paths to install under the temp dir.
   * Defaults to `["state"]`.
   */
  paths?: ElectronTestEnvPathKind[];
  /**
   * Extra env vars mapped to filenames created under the temp directory.
   * Example: `{ LETAGENTS_AGENT_ATTACHMENTS_DIR: "attachments" }`
   */
  extraEnvFiles?: Record<string, string>;
  /**
   * Extra env keys to clear on cleanup (in addition to keys this helper sets).
   * Useful when a suite also sets cursor/codex homes during individual tests.
   */
  extraCleanupEnvKeys?: string[];
  /** Register `test.after(cleanup)` automatically. Defaults to true. */
  autoCleanup?: boolean;
  /**
   * Point HOME at a folder inside the temp directory, so nothing the suite
   * reads or writes through `os.homedir()` can touch the real home folder.
   * Defaults to true. See `pointHomeAt`.
   */
  isolateHome?: boolean;
};

export type ElectronTestEnv = {
  tempDir: string;
  /** The HOME this suite runs with; null when `isolateHome` is false. */
  homeDir: string | null;
  statePath: string | null;
  chatStorageSettingsPath: string | null;
  localChatDbPath: string | null;
  localProfilePath: string | null;
  /** Write JSON state to LETAGENTS_STATE_PATH (requires `paths` to include `"state"`). */
  resetState: (state?: Record<string, unknown>) => void;
  cleanup: () => void;
};

/**
 * Unroutable API base used by the desktop test suite. When `LETAGENTS_API_URL`
 * is unset, `electron/main/paths.ts` falls back to the PRODUCTION host
 * (`https://letagents.chat`), so any background call the runtime makes during a
 * test (notably the managed-worker desktop-heartbeat/desktop-pause timer) would
 * hammer prod. Port 9 (the "discard" port) is standard-reserved and nothing
 * listens on it locally, so a stray call fails fast instead of reaching prod.
 */
export const TEST_UNROUTABLE_API_URL = "http://127.0.0.1:9";

/**
 * Default `LETAGENTS_API_URL` to an unroutable local address for the test
 * process unless the environment already pins one (CI sets it explicitly).
 * Must run before any `electron/main` module is imported, since `paths.ts`
 * reads the value once at module-evaluation time. Every electron suite calls
 * `createElectronTestEnv` at top level before its dynamic `await import(...)`
 * of runtime code, so routing this through the shared helper keeps a single
 * choke point instead of sprinkling the guard across every test file.
 */
function ensureNonProdApiUrl(): void {
  if (!process.env.LETAGENTS_API_URL?.trim()) {
    process.env.LETAGENTS_API_URL = TEST_UNROUTABLE_API_URL;
  }
}

export type NoProdNetworkGuard = {
  /** Number of intercepted managed-worker heartbeat/pause calls. */
  heartbeatCalls: () => number;
  /** URLs of any fetch that was NOT an expected heartbeat/pause call. */
  escapedUrls: () => string[];
  /** Restore the previous `globalThis.fetch` (no-op if already replaced). */
  restore: () => void;
};

const MANAGED_WORKER_HEARTBEAT_PATHS = ["/desktop-heartbeat", "/desktop-pause"];

/**
 * Belt-and-suspenders hermeticity for the managed-agent runtime suites: replace
 * `globalThis.fetch` so the background desktop-heartbeat/desktop-pause timer
 * (which fires real `apiFetch` calls the tests never await) can never escape to
 * the network — even if `LETAGENTS_API_URL` is somehow unset. Heartbeat/pause
 * calls are answered with a local stub; anything else is recorded in
 * `escapedUrls()` and answered with a non-network 599 so a leak fails loudly via
 * assertion rather than by silently reaching prod. Individual tests that install
 * their own `globalThis.fetch` stub still compose: they save/restore this guard.
 */
export function installNoProdNetworkGuard(
  options: { autoRestore?: boolean } = {},
): NoProdNetworkGuard {
  const previousFetch = globalThis.fetch;
  let heartbeatCalls = 0;
  const escapedUrls: string[] = [];
  const guardedFetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (MANAGED_WORKER_HEARTBEAT_PATHS.some((path) => url.includes(path))) {
      heartbeatCalls += 1;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    escapedUrls.push(url);
    return new Response(
      JSON.stringify({ error: `Unexpected outbound fetch blocked in test: ${url}` }),
      { status: 599, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = guardedFetch;

  function restore(): void {
    if (globalThis.fetch === guardedFetch) {
      globalThis.fetch = previousFetch;
    }
  }

  if (options.autoRestore !== false) {
    test.after(restore);
  }

  return {
    heartbeatCalls: () => heartbeatCalls,
    escapedUrls: () => [...escapedUrls],
    restore,
  };
}

/**
 * Point HOME (USERPROFILE on Windows) at a folder the test run owns. Node's
 * `os.homedir()` reads that variable on every call, so modules that build a
 * path such as `~/.letagents/local-files` while they load also land in the
 * folder, as long as this runs before they are imported.
 *
 * HOME is not restored afterwards. A late write from a stray timer then goes
 * to the removed scratch folder, never to the real home. Each test file runs in
 * its own process, so nothing outside this process sees the change.
 *
 * Static imports run before any code in the test file. A file that imports
 * production modules statically, above its `createElectronTestEnv` call, must
 * also start with `import "./isolated-home.js"`, or those modules compute their
 * paths from the real home while they load.
 */
export function pointHomeAt(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
}

/**
 * Isolate HOME for a test file that does not need `createElectronTestEnv`.
 * Prefer `import "./isolated-home.js"` as the first import of the file, so the
 * change lands before the modules under test are evaluated.
 */
export function installIsolatedTestHome(prefix = "letagents-test-home-"): {
  homeDir: string;
  cleanup: () => void;
} {
  const homeDir = mkdtempSync(join(tmpdir(), prefix));
  pointHomeAt(homeDir);
  const cleanup = (): void => removeTestDirectory(homeDir);
  test.after(cleanup);
  return { homeDir, cleanup };
}

const PATH_ENV: Record<ElectronTestEnvPathKind, { envKey: string; fileName: string }> = {
  state: { envKey: "LETAGENTS_STATE_PATH", fileName: "mcp-state.json" },
  chatStorage: { envKey: "LETAGENTS_CHAT_STORAGE_SETTINGS_PATH", fileName: "chat-storage.json" },
  localChatDb: { envKey: "LETAGENTS_LOCAL_CHAT_DB", fileName: "local-chat.sqlite" },
  localProfile: { envKey: "LETAGENTS_LOCAL_PROFILE_PATH", fileName: "local-profile.json" },
};

/**
 * Shared electron test temp-dir + env-var harness.
 * Replaces the copy-pasted mkdtempSync / LETAGENTS_*_PATH / resetState / test.after cleanup
 * boilerplate used across desktop electron suites.
 */
export function createElectronTestEnv(options: ElectronTestEnvOptions): ElectronTestEnv {
  ensureNonProdApiUrl();
  const pathKinds = options.paths ?? ["state"];
  const tempDir = mkdtempSync(join(tmpdir(), options.prefix));
  const installedEnvKeys = new Set<string>();
  const homeDir = options.isolateHome === false ? null : join(tempDir, "home");
  if (homeDir) pointHomeAt(homeDir);

  let statePath: string | null = null;
  let chatStorageSettingsPath: string | null = null;
  let localChatDbPath: string | null = null;
  let localProfilePath: string | null = null;

  for (const kind of pathKinds) {
    const { envKey, fileName } = PATH_ENV[kind];
    const absolutePath = join(tempDir, fileName);
    process.env[envKey] = absolutePath;
    installedEnvKeys.add(envKey);
    if (kind === "state") statePath = absolutePath;
    if (kind === "chatStorage") chatStorageSettingsPath = absolutePath;
    if (kind === "localChatDb") localChatDbPath = absolutePath;
    if (kind === "localProfile") localProfilePath = absolutePath;
  }

  for (const [envKey, fileName] of Object.entries(options.extraEnvFiles ?? {})) {
    process.env[envKey] = join(tempDir, fileName);
    installedEnvKeys.add(envKey);
  }

  for (const envKey of options.extraCleanupEnvKeys ?? []) {
    installedEnvKeys.add(envKey);
  }

  function resetState(state: Record<string, unknown> = {}): void {
    if (!statePath) {
      throw new Error("createElectronTestEnv: resetState requires paths to include \"state\"");
    }
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  }

  function cleanup(): void {
    for (const envKey of installedEnvKeys) {
      delete process.env[envKey];
    }
    removeTestDirectory(tempDir);
  }

  if (options.autoCleanup !== false) {
    test.after(cleanup);
  }

  return {
    tempDir,
    homeDir,
    statePath,
    chatStorageSettingsPath,
    localChatDbPath,
    localProfilePath,
    resetState,
    cleanup,
  };
}

/** Isolated safeStorage double; production still requires the OS credential store. */
export function installTestSecretStorage(): void {
  const require = createRequire(import.meta.url);
  const id = require.resolve("electron");
  const previous = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports: { safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  } } } as NodeJS.Module;
  test.after(() => { if (previous) require.cache[id] = previous; else delete require.cache[id]; });
}
export function testEncryptedToken(value: string): string {
  return `safe:${Buffer.from(value).toString("base64")}`;
}

/**
 * A file the app keeps private to its owner. On POSIX its mode must be exactly
 * 0600. Windows keeps no POSIX mode (stat reports 0o666 for every file); there
 * the protection is the per-user profile ACL of the folder the app writes
 * into, so the check is that a regular file exists and resolves inside the
 * test's private root. Same rule as assertOwnerPrivateFile in
 * src/mcp/__tests__/support/platform.ts.
 */
export function assertOwnerPrivateFile(filePath: string, privateRoot: string): void {
  const stats = statSync(filePath);
  assert.ok(stats.isFile(), `${filePath} is a regular file`);
  if (process.platform !== "win32") {
    assert.equal(stats.mode & 0o777, 0o600, `${filePath} is readable by its owner only`);
    return;
  }
  assert.ok(
    isInside(realpathSync.native(filePath), realpathSync.native(privateRoot)),
    `${filePath} resolves inside ${privateRoot}`,
  );
}

export type ObservedGitSpawn = {
  /** Git's arguments, without the program name. */
  args: string[];
  child: ChildProcess;
};

/**
 * Call `listener` for every Git process this test process starts
 * asynchronously (spawn/execFile, as the desktop's runGit does). The test's own
 * execFileSync/spawnSync calls are not included. Returns a restore function.
 *
 * This replaces a counting `#!/bin/sh` `git` wrapper put first on PATH, which
 * cannot work on Windows: execFile there finds only git.exe or git.com. A
 * listener that changes files on `child.once("exit")` runs before the caller
 * sees the result, because execFile settles on "close", which comes after
 * "exit".
 */
export function observeGitSpawns(listener: (spawn: ObservedGitSpawn) => void): () => void {
  type SpawnOptions = { file?: string; args?: string[] };
  const prototype = ChildProcess.prototype as unknown as {
    spawn: (this: ChildProcess, options: SpawnOptions) => unknown;
  };
  const original = prototype.spawn;
  const observed = function (this: ChildProcess, options: SpawnOptions): unknown {
    const result = original.call(this, options);
    const program = basename(String(options?.file ?? "")).toLowerCase().replace(/\.exe$/, "");
    if (program === "git") listener({ args: (options.args ?? []).slice(1), child: this });
    return result;
  };
  prototype.spawn = observed;
  return () => {
    if (prototype.spawn === observed) prototype.spawn = original;
  };
}
