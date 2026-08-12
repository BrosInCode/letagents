import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
};

export type ElectronTestEnv = {
  tempDir: string;
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
    rmSync(tempDir, { recursive: true, force: true });
  }

  if (options.autoCleanup !== false) {
    test.after(cleanup);
  }

  return {
    tempDir,
    statePath,
    chatStorageSettingsPath,
    localChatDbPath,
    localProfilePath,
    resetState,
    cleanup,
  };
}
