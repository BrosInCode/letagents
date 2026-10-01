import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createElectronTestEnv, installTestSecretStorage, testEncryptedToken } from "./harness.js";

installTestSecretStorage();
const env = createElectronTestEnv({
  prefix: "letagents-agent-commit-identity-",
  paths: [],
  extraCleanupEnvKeys: ["LETAGENTS_DESKTOP_USER_DATA_DIR"],
});
// Only the auth store's test override is set: the mirror must follow it, never the real home.
process.env.LETAGENTS_DESKTOP_USER_DATA_DIR = env.tempDir;

const {
  getManagedAgentCommitIdentitySettings,
  githubNoreplyCommitIdentity,
  managedAgentCommitEnvironment,
  managedAgentCommitIdentityPath,
  readManagedAgentCommitIdentitySettings,
  recordManagedAgentCommitAccount,
  setManagedAgentCommitUsesHostIdentity,
} = await import("../main/agents/managed-agent-commit-identity.js");
const { getDesktopAuthStatus, signOutDesktopAuth } = await import("../main/auth.js");
const { claudeCliEnv } = await import("../main/agents/claude-code-provider-adapter.js");
const { minimalOpenCodeEnvironment } = await import("../main/agents/opencode-launch-contract.js");
const { cursorDaemonChildEnv } = await import("../main/agents/cursor-provider-adapter.js");
const { buildManagedCursorChildEnv } = await import("../main/agents/cursor-runner.js");

const FAKE_ACCOUNT = { provider: "github", providerUserId: "424242", login: "octo-fake" };
const FAKE_IDENTITY = { name: "octo-fake", email: "424242+octo-fake@users.noreply.github.com" };
const FAKE_GIT_ENV = {
  GIT_AUTHOR_NAME: FAKE_IDENTITY.name,
  GIT_AUTHOR_EMAIL: FAKE_IDENTITY.email,
  GIT_COMMITTER_NAME: FAKE_IDENTITY.name,
  GIT_COMMITTER_EMAIL: FAKE_IDENTITY.email,
};

let serial = 0;
const settingsPath = () => join(env.tempDir, `identity-${serial++}.json`);

test("the GitHub noreply identity is the login and the numeric-id noreply address", () => {
  assert.deepEqual(githubNoreplyCommitIdentity({ login: "octo-fake", id: "424242" }), FAKE_IDENTITY);
});

test("agents get the noreply identity only for a known GitHub account the owner has not opted out of", async () => {
  const path = settingsPath();
  assert.deepEqual(managedAgentCommitEnvironment(readManagedAgentCommitIdentitySettings(path)), {}, "no account yet");

  await recordManagedAgentCommitAccount(FAKE_ACCOUNT, path);
  assert.deepEqual(managedAgentCommitEnvironment(readManagedAgentCommitIdentitySettings(path)), FAKE_GIT_ENV);
  assert.deepEqual(await getManagedAgentCommitIdentitySettings(path), {
    useHostGitIdentity: false,
    githubIdentity: FAKE_IDENTITY,
  });

  assert.deepEqual(await setManagedAgentCommitUsesHostIdentity(true, path), {
    useHostGitIdentity: true,
    githubIdentity: FAKE_IDENTITY,
  });
  assert.deepEqual(managedAgentCommitEnvironment(readManagedAgentCommitIdentitySettings(path)), {}, "host identity kept");

  await recordManagedAgentCommitAccount({ ...FAKE_ACCOUNT, providerUserId: "777", login: "other-fake" }, path);
  assert.equal(readManagedAgentCommitIdentitySettings(path).useHostGitIdentity, true, "the choice survives an account change");
  await setManagedAgentCommitUsesHostIdentity(false, path);
  assert.equal(managedAgentCommitEnvironment(readManagedAgentCommitIdentitySettings(path)).GIT_AUTHOR_EMAIL,
    "777+other-fake@users.noreply.github.com");

  await recordManagedAgentCommitAccount(null, path);
  assert.deepEqual(managedAgentCommitEnvironment(readManagedAgentCommitIdentitySettings(path)), {}, "signed out");
});

test("only a well-formed GitHub account yields a commit identity", async () => {
  for (const account of [
    { ...FAKE_ACCOUNT, provider: "gitlab" },
    { ...FAKE_ACCOUNT, providerUserId: "github-1" },
    { ...FAKE_ACCOUNT, login: "octo fake\nGIT_AUTHOR_EMAIL=x" },
    { ...FAKE_ACCOUNT, login: "-octo" },
  ]) {
    const path = settingsPath();
    await recordManagedAgentCommitAccount(account, path);
    assert.deepEqual(managedAgentCommitEnvironment(readManagedAgentCommitIdentitySettings(path)), {}, JSON.stringify(account));
  }
  const corrupt = settingsPath();
  writeFileSync(corrupt, "{ not json");
  assert.deepEqual(readManagedAgentCommitIdentitySettings(corrupt), { useHostGitIdentity: false, githubAccount: null });
});

test("recording the same account again leaves the file alone", async () => {
  const path = settingsPath();
  await recordManagedAgentCommitAccount(FAKE_ACCOUNT, path);
  const first = readFileSync(path, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await recordManagedAgentCommitAccount(FAKE_ACCOUNT, path);
  assert.equal(readFileSync(path, "utf8"), first);
});

test("every managed provider's launch environment carries the commit identity", () => {
  const identity = () => FAKE_GIT_ENV;
  const owner = { PATH: "/usr/bin", HOME: "/home/fake", GIT_AUTHOR_EMAIL: "personal@example.invalid" };

  const claude = claudeCliEnv(owner, { LETAGENTS_SUPERVISOR_ENTRY_ID: "entry" }, identity);
  assert.equal(claude.GIT_AUTHOR_EMAIL, FAKE_IDENTITY.email, "Claude Code");
  assert.equal(claude.GIT_COMMITTER_NAME, FAKE_IDENTITY.name);
  const claudeRental = claudeCliEnv(owner, { LETAGENTS_RENTAL_CREDENTIAL_ISOLATION: "1" }, identity);
  assert.equal(claudeRental.GIT_AUTHOR_EMAIL, undefined, "rental children keep only their isolated variables");

  const openCode = minimalOpenCodeEnvironment(owner, { XDG_CONFIG_HOME: "/runtime/config" }, identity);
  assert.equal(openCode.GIT_AUTHOR_EMAIL, FAKE_IDENTITY.email, "Open Model");
  assert.equal(openCode.GIT_COMMITTER_EMAIL, FAKE_IDENTITY.email);

  const cursor = buildManagedCursorChildEnv({ HOME: "/profile/home" }, identity);
  assert.equal(cursor.GIT_AUTHOR_EMAIL, FAKE_IDENTITY.email, "Cursor");
  assert.equal(cursor.GIT_COMMITTER_NAME, FAKE_IDENTITY.name);
  assert.equal(cursor.HOME, "/profile/home");

  const optedOut = () => ({});
  assert.equal(claudeCliEnv(owner, {}, optedOut).GIT_AUTHOR_EMAIL, "personal@example.invalid", "host identity untouched");
  assert.equal(minimalOpenCodeEnvironment(owner, {}, optedOut).GIT_AUTHOR_EMAIL, undefined);
});

test("the supervised Cursor child reads the saved commit identity", async () => {
  const previous = process.env.LETAGENTS_AGENT_COMMIT_IDENTITY_PATH;
  process.env.LETAGENTS_AGENT_COMMIT_IDENTITY_PATH = settingsPath();
  try {
    await recordManagedAgentCommitAccount(FAKE_ACCOUNT);
    const env = cursorDaemonChildEnv({ HOME: "/profile/home", LETAGENTS_TOKEN: "owner-secret-fake" });
    assert.equal(env.GIT_AUTHOR_EMAIL, FAKE_IDENTITY.email);
    assert.equal(env.GIT_COMMITTER_EMAIL, FAKE_IDENTITY.email);
    assert.equal(env.LETAGENTS_TOKEN, undefined);
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_AGENT_COMMIT_IDENTITY_PATH;
    else process.env.LETAGENTS_AGENT_COMMIT_IDENTITY_PATH = previous;
  }
});

test("the desktop mirrors the signed-in GitHub account and forgets it at sign-out", async () => {
  const identityPath = managedAgentCommitIdentityPath();
  assert.equal(identityPath, join(env.tempDir, "agent-commit-identity.json"));
  writeFileSync(join(env.tempDir, "letagents-desktop-auth.json"), `${JSON.stringify({
    version: 2,
    ownerTokenId: "owner-token-fake",
    oauthTokenExpiresAt: null,
    account: null,
    pendingDeviceAuth: null,
    savedAt: new Date().toISOString(),
    encryptedToken: testEncryptedToken("desktop-session-fake"),
  }, null, 2)}\n`);

  const previous = globalThis.fetch;
  const stub = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/auth/session")) {
      return Response.json({
        authenticated: true,
        credential_type: "session",
        account: { id: "account-fake", provider: "github", provider_user_id: "424242", login: "octo-fake" },
      });
    }
    return Response.json({ error: "offline" }, { status: 503 });
  }) as typeof fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = stub;
  try {
    const status = await getDesktopAuthStatus();
    assert.equal(status.authenticated, true);
    assert.deepEqual(await getManagedAgentCommitIdentitySettings(), { useHostGitIdentity: false, githubIdentity: FAKE_IDENTITY });

    await signOutDesktopAuth();
    assert.ok(existsSync(identityPath));
    assert.deepEqual(await getManagedAgentCommitIdentitySettings(), { useHostGitIdentity: false, githubIdentity: null });
  } finally {
    if (globalThis.fetch === stub) globalThis.fetch = previous;
  }
});
