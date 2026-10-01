import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { DesktopAgentCommitIdentitySettings } from "../../ipc-types.js";

/**
 * Who managed agents commit as.
 *
 * Without an identity in its environment, a managed agent commits as the
 * host's global Git identity, which is often a personal email, and publishes
 * it in every public repository the agent pushes to. When the desktop knows
 * the signed-in GitHub account, managed launches carry that account's noreply
 * identity in GIT_AUTHOR_* and GIT_COMMITTER_* instead. Global and repository
 * Git config are never touched. The owner can keep the host identity.
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

/** Synchronous so every provider's launch environment can read it in place. */
export function readManagedAgentCommitIdentitySettings(
  path = managedAgentCommitIdentityPath(),
): ManagedAgentCommitIdentitySettings {
  try {
    return normalizeSettings(readFileSync(path, "utf8"));
  } catch {
    return EMPTY_SETTINGS;
  }
}

/**
 * GIT_AUTHOR_* and GIT_COMMITTER_* for a managed agent's launch environment.
 * Empty when the owner keeps the host identity or no GitHub account is known,
 * so Git falls back to its usual configuration.
 */
export function managedAgentCommitEnvironment(
  settings: ManagedAgentCommitIdentitySettings = readManagedAgentCommitIdentitySettings(),
): Record<string, string> {
  if (settings.useHostGitIdentity || !settings.githubAccount) return {};
  const identity = githubNoreplyCommitIdentity(settings.githubAccount);
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
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
