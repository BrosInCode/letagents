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
