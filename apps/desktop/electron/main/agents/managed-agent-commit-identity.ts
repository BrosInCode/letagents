import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";

import type { DesktopAgentCommitIdentitySettings } from "../../ipc-types.js";
import { desktopRuntimeEnvironment } from "../desktop-shell-environment.js";

/**
 * Who managed agents commit as.
 *
 * Without an identity in its environment, a managed agent commits as the
 * host's global Git identity, which is often a personal email, and publishes
 * it in every public repository the agent pushes to. When the desktop knows
 * the signed-in GitHub account, a launch into a GitHub repository that would
 * use that global identity carries the account's noreply identity in
 * GIT_AUTHOR_* and GIT_COMMITTER_* instead. Identities set for a repository,
 * by a conditional include or in the environment, and signing setups, are left
 * alone. Git config is never written. The owner can keep the host identity.
 *
 * The desktop writes this small file and the supervisor daemon reads it at
 * each launch, so a change applies to the next agent start without a daemon
 * handoff. It holds no credential.
 */

type GitHubCommitAccount = { login: string; id: string };

type PersistedAgentCommitIdentitySettings = {
  version?: number;
  useHostGitIdentity?: unknown;
  githubAccount?: unknown;
  savedAt?: string;
};

export type ManagedAgentCommitIdentitySettings = {
  useHostGitIdentity: boolean;
  githubAccount: GitHubCommitAccount | null;
};

// GitHub logins are ASCII letters, digits and hyphens; account ids are numeric.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_ACCOUNT_ID = /^[1-9][0-9]{0,19}$/;

export function managedAgentCommitIdentityPath(): string {
  const configured = process.env.LETAGENTS_AGENT_COMMIT_IDENTITY_PATH?.trim();
  if (configured) return configured;
  // The account half mirrors the desktop auth store. A test that moves that
  // store must not overwrite the owner's real file through the mirror.
  const testUserData = process.env.LETAGENTS_DESKTOP_USER_DATA_DIR?.trim();
  if (testUserData) return join(testUserData, "agent-commit-identity.json");
  return join(homedir(), ".letagents", "agent-commit-identity.json");
}

function normalizeGitHubAccount(value: unknown): GitHubCommitAccount | null {
  if (!value || typeof value !== "object") return null;
  const { login, id } = value as { login?: unknown; id?: unknown };
  const normalizedLogin = typeof login === "string" ? login.trim() : "";
  const normalizedId = typeof id === "string" || typeof id === "number" ? String(id).trim() : "";
  return GITHUB_LOGIN.test(normalizedLogin) && GITHUB_ACCOUNT_ID.test(normalizedId)
    ? { login: normalizedLogin, id: normalizedId }
    : null;
}

function normalizeSettings(raw: string): ManagedAgentCommitIdentitySettings {
  const parsed = JSON.parse(raw) as PersistedAgentCommitIdentitySettings;
  return {
    useHostGitIdentity: parsed.useHostGitIdentity === true,
    githubAccount: normalizeGitHubAccount(parsed.githubAccount),
  };
}

const EMPTY_SETTINGS: ManagedAgentCommitIdentitySettings = { useHostGitIdentity: false, githubAccount: null };

/** The noreply identity GitHub attributes to the account without exposing an email. */
export function githubNoreplyCommitIdentity(account: GitHubCommitAccount): { name: string; email: string } {
  return { name: account.login, email: `${account.id}+${account.login}@users.noreply.github.com` };
}

export function readManagedAgentCommitIdentitySettings(
  path = managedAgentCommitIdentityPath(),
): ManagedAgentCommitIdentitySettings {
  try {
    return normalizeSettings(readFileSync(path, "utf8"));
  } catch {
    return EMPTY_SETTINGS;
  }
}

/** One identity setting Git reads, as the workspace resolves it and as it is outside any repository. */
export type GitIdentitySetting = { key: string; scope: string; value: string | null; hostValue: string | null };

/** What Git would use for a commit in a workspace, as the owner's environment resolves it. */
export type GitCommitIdentityFacts = {
  /** user.email, user.name and the author.* and committer.* overrides that are set. */
  identity: GitIdentitySetting[];
  /** Commits or tags are signed, or a signing key is configured. */
  signing: boolean;
  /** The configured origin URL, before any insteadOf rewrite. */
  originUrl: string | null;
  /** GIT_AUTHOR_* or GIT_COMMITTER_* is already set in the environment. */
  environmentIdentity: boolean;
};

const GIT_IDENTITY_KEYS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const;
// Git takes the author and committer from these, the more specific ones first.
const GIT_IDENTITY_CONFIG_KEYS = [
  "user.email", "user.name", "author.email", "author.name", "committer.email", "committer.name",
] as const;
const GIT_PROBE_TIMEOUT_MS = 3_000;

export function isGitHubRemoteUrl(url: string | null): boolean {
  if (!url) return false;
  return /^(?:https?|ssh|git|git\+ssh):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\//i.test(url)
    || /^[^@/:]+@github\.com:/i.test(url);
}

function gitBoolean(value: string | null): boolean {
  // A key with no value is true in Git config.
  return value === null || /^(?:true|yes|on|1)$/i.test(value.trim());
}

/**
 * Only an identity the owner set for every repository is replaced, and only
 * for a GitHub repository. Any identity setting from a repository, worktree,
 * conditional include or the environment was chosen on purpose and stays.
 * Signing stays intact: a key bound to the owner's email would not sign as
 * the noreply identity, and gpg without a key fails on the committer.
 */
export function canUseNoreplyIdentity(facts: GitCommitIdentityFacts): boolean {
  const email = facts.identity.find((setting) => setting.key === "user.email");
  return Boolean(email?.value)
    && facts.identity.every((setting) => (setting.scope === "global" || setting.scope === "system")
      && setting.value === setting.hostValue)
    && !facts.signing
    && !facts.environmentIdentity
    && isGitHubRemoteUrl(facts.originUrl);
}

function gitProbeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  // Resolve the workspace itself, not a repository the launching process points at.
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key];
  return env;
}

/** Every config entry Git sees from `cwd`, last value winning; null when Git cannot answer. */
function listGitConfig(cwd: string, env: NodeJS.ProcessEnv): Promise<Map<string, { scope: string; value: string | null }> | null> {
  return new Promise((resolve) => {
    const child = execFile("git", ["config", "--show-scope", "--list", "-z"], {
      cwd, env, encoding: "utf8", timeout: GIT_PROBE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) return resolve(null);
      // Entries are `scope NUL key LF value NUL`, or `scope NUL key NUL` without a value.
      const values = new Map<string, { scope: string; value: string | null }>();
      const tokens = String(stdout).split("\0");
      for (let index = 0; index + 1 < tokens.length; index += 2) {
        const entry = tokens[index + 1]!;
        const separator = entry.indexOf("\n");
        const key = (separator === -1 ? entry : entry.slice(0, separator)).toLowerCase();
        values.set(key, { scope: tokens[index]!, value: separator === -1 ? null : entry.slice(separator + 1) });
      }
      resolve(values);
    });
    child.stdin?.end();
  });
}

/** Null when Git cannot answer, which leaves Git's own resolution alone. */
export async function readGitCommitIdentityFacts(
  workspace: string,
  source: NodeJS.ProcessEnv = desktopRuntimeEnvironment(),
): Promise<GitCommitIdentityFacts | null> {
  const env = gitProbeEnvironment(source);
  const [values, host] = await Promise.all([
    listGitConfig(workspace, env),
    // Outside any repository, gitdir/onbranch/hasconfig includes cannot apply.
    listGitConfig(parse(workspace).root || "/", env),
  ]);
  if (!values || !host) return null;
  const signingKey = values.get("user.signingkey");
  const commitSign = values.get("commit.gpgsign");
  const tagSign = values.get("tag.gpgsign");
  return {
    identity: GIT_IDENTITY_CONFIG_KEYS.flatMap((key) => {
      const setting = values.get(key);
      return setting ? [{ key, scope: setting.scope, value: setting.value, hostValue: host.get(key)?.value ?? null }] : [];
    }),
    signing: Boolean(signingKey?.value) || (commitSign ? gitBoolean(commitSign.value) : false)
      || (tagSign ? gitBoolean(tagSign.value) : false),
    originUrl: values.get("remote.origin.url")?.value ?? null,
    environmentIdentity: GIT_IDENTITY_KEYS.some((key) => Boolean(source[key]?.trim())),
  };
}

/** The workspace whose Git identity a managed launch may set; rentals never carry the owner's. */
export function managedAgentCommitWorkspace(
  request: { cwd: string; supervisorEntryId?: string | null } | null | undefined,
): string | null {
  if (!request || request.supervisorEntryId?.startsWith("supervised_rental_")) return null;
  return request.cwd?.trim() || null;
}

/**
 * GIT_AUTHOR_* and GIT_COMMITTER_* for a managed agent's launch environment.
 * Empty, so Git resolves its identity as usual, when the owner keeps the host
 * identity, no GitHub account is known, or the workspace does not qualify.
 */
export async function managedAgentCommitEnvironment(
  workspace: string | null | undefined,
  options: {
    settings?: ManagedAgentCommitIdentitySettings;
    readFacts?: (workspace: string) => Promise<GitCommitIdentityFacts | null>;
  } = {},
): Promise<Record<string, string>> {
  const settings = options.settings ?? await readSettingsForUpdate(managedAgentCommitIdentityPath());
  if (settings.useHostGitIdentity || !settings.githubAccount || !workspace?.trim()) return {};
  const facts = await (options.readFacts ?? readGitCommitIdentityFacts)(workspace);
  if (!facts || !canUseNoreplyIdentity(facts)) return {};
  const identity = githubNoreplyCommitIdentity(settings.githubAccount);
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

/** The commit identity for a managed launch's work attempt. */
export function managedCommitEnvironmentFor(
  request: { cwd: string; supervisorEntryId?: string | null } | null | undefined,
): Promise<Record<string, string>> {
  return managedAgentCommitEnvironment(managedAgentCommitWorkspace(request));
}

async function readSettingsForUpdate(path: string): Promise<ManagedAgentCommitIdentitySettings> {
  try {
    return normalizeSettings(await readFile(path, "utf8"));
  } catch {
    return EMPTY_SETTINGS;
  }
}

async function writeSettings(path: string, settings: ManagedAgentCommitIdentitySettings): Promise<void> {
  const persisted: PersistedAgentCommitIdentitySettings = {
    version: 1,
    useHostGitIdentity: settings.useHostGitIdentity,
    githubAccount: settings.githubAccount,
    savedAt: new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // A launch may read the file at any moment; publish only a complete file.
  const staged = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(staged, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(staged, path);
}

function settingsStatus(settings: ManagedAgentCommitIdentitySettings): DesktopAgentCommitIdentitySettings {
  return {
    useHostGitIdentity: settings.useHostGitIdentity,
    githubIdentity: settings.githubAccount ? githubNoreplyCommitIdentity(settings.githubAccount) : null,
  };
}

let settingsMutation: Promise<unknown> = Promise.resolve();

function serializeSettingsMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = settingsMutation.then(operation);
  settingsMutation = result.catch(() => undefined);
  return result;
}

export async function getManagedAgentCommitIdentitySettings(
  path = managedAgentCommitIdentityPath(),
): Promise<DesktopAgentCommitIdentitySettings> {
  return settingsStatus(await readSettingsForUpdate(path));
}

export function setManagedAgentCommitUsesHostIdentity(
  useHostGitIdentity: boolean,
  path = managedAgentCommitIdentityPath(),
): Promise<DesktopAgentCommitIdentitySettings> {
  return serializeSettingsMutation(async () => {
    const next = { ...await readSettingsForUpdate(path), useHostGitIdentity: useHostGitIdentity === true };
    await writeSettings(path, next);
    return settingsStatus(next);
  });
}

/**
 * Mirror the signed-in account. Only a GitHub account yields an identity;
 * signing out forgets it, so agents fall back to the host identity.
 */
export function recordManagedAgentCommitAccount(
  account: { provider: string; providerUserId: string; login: string } | null,
  path = managedAgentCommitIdentityPath(),
): Promise<void> {
  const githubAccount = account?.provider === "github"
    ? normalizeGitHubAccount({ login: account.login, id: account.providerUserId })
    : null;
  return serializeSettingsMutation(async () => {
    const current = await readSettingsForUpdate(path);
    if (current.githubAccount?.login === githubAccount?.login && current.githubAccount?.id === githubAccount?.id) return;
    await writeSettings(path, { ...current, githubAccount });
  });
}
