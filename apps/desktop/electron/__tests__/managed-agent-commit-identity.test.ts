import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  canUseNoreplyIdentity,
  getManagedAgentCommitIdentitySettings,
  githubNoreplyCommitIdentity,
  isGitHubRemoteUrl,
  managedAgentCommitEnvironment,
  managedAgentCommitIdentityPath,
  readGitCommitIdentityFacts,
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
const fixture = (name: string) => {
  const path = join(env.tempDir, `${name}-${serial++}`);
  mkdirSync(path, { recursive: true });
  return path;
};

/** A workspace whose Git facts allow the noreply identity, for settings-only tests. */
const QUALIFYING_FACTS = {
  emailScope: "global",
  email: "owner@example.invalid",
  hostEmail: "owner@example.invalid",
  signing: false,
  originUrl: "https://github.com/fake-org/fake-repo.git",
  environmentIdentity: false,
};
const environmentFor = (path: string) =>
  managedAgentCommitEnvironment("/fake/workspace", {
    settings: readManagedAgentCommitIdentitySettings(path),
    readFacts: () => QUALIFYING_FACTS,
  });

/** A scratch HOME whose global Git config holds a personal email; never the real home. */
function gitHome(globalConfig = "[user]\n\tname = Fake Owner\n\temail = owner@example.invalid\n") {
  const home = fixture("git-home");
  writeFileSync(join(home, ".gitconfig"), globalConfig);
  return { home, gitEnv: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } as NodeJS.ProcessEnv };
}

function gitRepo(gitEnv: NodeJS.ProcessEnv, origin: string | null = "https://github.com/fake-org/fake-repo.git", at?: string) {
  const repo = at ?? fixture("repo");
  execFileSync("git", ["init", "-q"], { cwd: repo, env: gitEnv });
  if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: repo, env: gitEnv });
  return repo;
}

/** The commit environment for a signed-in account that has not opted out. */
function identityFor(workspace: string | null, gitEnv: NodeJS.ProcessEnv) {
  return managedAgentCommitEnvironment(workspace, {
    settings: { useHostGitIdentity: false, githubAccount: { login: "octo-fake", id: "424242" } },
    readFacts: (path) => readGitCommitIdentityFacts(path, gitEnv),
  });
}

test("the GitHub noreply identity is the login and the numeric-id noreply address", () => {
  assert.deepEqual(githubNoreplyCommitIdentity({ login: "octo-fake", id: "424242" }), FAKE_IDENTITY);
});

test("agents get the noreply identity only for a known GitHub account the owner has not opted out of", async () => {
  const path = settingsPath();
  assert.deepEqual(environmentFor(path), {}, "no account yet");

  await recordManagedAgentCommitAccount(FAKE_ACCOUNT, path);
  assert.deepEqual(environmentFor(path), FAKE_GIT_ENV);
  assert.deepEqual(await getManagedAgentCommitIdentitySettings(path), {
    useHostGitIdentity: false,
    githubIdentity: FAKE_IDENTITY,
  });

  assert.deepEqual(await setManagedAgentCommitUsesHostIdentity(true, path), {
    useHostGitIdentity: true,
    githubIdentity: FAKE_IDENTITY,
  });
  assert.deepEqual(environmentFor(path), {}, "host identity kept");

  await recordManagedAgentCommitAccount({ ...FAKE_ACCOUNT, providerUserId: "777", login: "other-fake" }, path);
  assert.equal(readManagedAgentCommitIdentitySettings(path).useHostGitIdentity, true, "the choice survives an account change");
  await setManagedAgentCommitUsesHostIdentity(false, path);
  assert.equal(environmentFor(path).GIT_AUTHOR_EMAIL, "777+other-fake@users.noreply.github.com");

  await recordManagedAgentCommitAccount(null, path);
  assert.deepEqual(environmentFor(path), {}, "signed out");
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
    assert.deepEqual(environmentFor(path), {}, JSON.stringify(account));
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

test("only a global identity in a GitHub repository is replaced", () => {
  const { gitEnv } = gitHome();
  assert.deepEqual(identityFor(gitRepo(gitEnv), gitEnv), FAKE_GIT_ENV, "global email, GitHub over HTTPS");
  assert.deepEqual(identityFor(gitRepo(gitEnv, "git@github.com:fake-org/fake-repo.git"), gitEnv), FAKE_GIT_ENV,
    "GitHub over SSH");

  const local = gitRepo(gitEnv);
  execFileSync("git", ["config", "user.email", "repo@example.invalid"], { cwd: local, env: gitEnv });
  assert.equal(readGitCommitIdentityFacts(local, gitEnv)?.emailScope, "local");
  assert.deepEqual(identityFor(local, gitEnv), {}, "a repository email is the owner's choice");
  const sameLocal = gitRepo(gitEnv);
  execFileSync("git", ["config", "user.email", "owner@example.invalid"], { cwd: sameLocal, env: gitEnv });
  assert.deepEqual(identityFor(sameLocal, gitEnv), {}, "even when the repository repeats the global email");

  assert.deepEqual(identityFor(gitRepo(gitEnv, "https://gitlab.com/fake-org/fake-repo.git"), gitEnv), {}, "not GitHub");
  assert.deepEqual(identityFor(gitRepo(gitEnv, "https://github.example.invalid/fake-org/fake-repo.git"), gitEnv), {},
    "not github.com");
  assert.deepEqual(identityFor(gitRepo(gitEnv, null), gitEnv), {}, "no origin");
  assert.deepEqual(identityFor(fixture("not-a-repo"), gitEnv), {}, "a room scratch folder");
  assert.deepEqual(identityFor(null, gitEnv), {}, "no workspace, as for rentals");
  assert.deepEqual(identityFor(gitRepo(gitEnv), { ...gitEnv, GIT_AUTHOR_EMAIL: "env@example.invalid" }), {},
    "an identity already in the environment");

  const { gitEnv: unset } = gitHome("");
  assert.deepEqual(identityFor(gitRepo(unset), unset), {}, "no email configured at all");
});

test("an email from a conditional include is kept; an unconditional include is the global identity", () => {
  const work = realpathSync(fixture("work"));
  const included = join(fixture("included"), "work.gitconfig");
  writeFileSync(included, "[user]\n\temail = work@example.invalid\n");
  const { gitEnv } = gitHome(`[user]\n\temail = owner@example.invalid\n[includeIf "gitdir:${work}/"]\n\tpath = ${included}\n`);
  gitRepo(gitEnv, "https://github.com/fake-org/work.git", work);
  const facts = readGitCommitIdentityFacts(work, gitEnv);
  assert.equal(facts?.email, "work@example.invalid");
  assert.equal(facts?.emailScope, "global", "Git reports an includeIf email under the including scope");
  assert.equal(facts?.hostEmail, "owner@example.invalid");
  assert.deepEqual(identityFor(work, gitEnv), {}, "includeIf identity");
  assert.deepEqual(identityFor(gitRepo(gitEnv), gitEnv), FAKE_GIT_ENV, "other repositories still use the global email");

  const { gitEnv: plain } = gitHome(`[include]\n\tpath = ${included}\n`);
  assert.deepEqual(identityFor(gitRepo(plain), plain), FAKE_GIT_ENV);
});

test("signing setups keep the host identity", () => {
  for (const signing of [
    "[commit]\n\tgpgsign = true\n",
    "[commit]\n\tgpgsign\n",
    "[tag]\n\tgpgSign = yes\n",
    "[user]\n\tsigningkey = ABCDEF0123456789\n",
  ]) {
    const { gitEnv } = gitHome(`[user]\n\temail = owner@example.invalid\n${signing}`);
    const repo = gitRepo(gitEnv);
    assert.equal(readGitCommitIdentityFacts(repo, gitEnv)?.signing, true, signing);
    assert.deepEqual(identityFor(repo, gitEnv), {}, signing);
  }
  const { gitEnv } = gitHome("[user]\n\temail = owner@example.invalid\n[commit]\n\tgpgsign = false\n");
  assert.deepEqual(identityFor(gitRepo(gitEnv), gitEnv), FAKE_GIT_ENV, "signing turned off");
  assert.equal(canUseNoreplyIdentity({ ...QUALIFYING_FACTS, signing: true }), false);
});

test("a commit made with the managed environment is authored and committed by the noreply identity", () => {
  const { gitEnv } = gitHome();
  const repo = gitRepo(gitEnv);
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "fake"], {
    cwd: repo, env: { ...gitEnv, ...identityFor(repo, gitEnv) },
  });
  assert.equal(
    execFileSync("git", ["log", "-1", "--format=%an <%ae>|%cn <%ce>"], { cwd: repo, env: gitEnv, encoding: "utf8" }).trim(),
    `octo-fake <${FAKE_IDENTITY.email}>|octo-fake <${FAKE_IDENTITY.email}>`,
  );
});

test("GitHub remotes are recognised by host", () => {
  for (const url of [
    "https://github.com/a/b.git", "http://github.com/a/b", "ssh://git@github.com/a/b.git",
    "git@github.com:a/b.git", "https://user@github.com/a/b.git", "git://github.com/a/b.git",
  ]) {
    assert.equal(isGitHubRemoteUrl(url), true, url);
  }
  for (const url of [
    null, "https://gitlab.com/a/b.git", "https://github.com.evil.invalid/a/b", "git@gitlab.com:a/b.git",
    "/tmp/a/b.git", "https://example.invalid/github.com/a",
  ]) {
    assert.equal(isGitHubRemoteUrl(url), false, String(url));
  }
});

test("every managed provider's launch environment carries the identity for its own workspace", () => {
  const asked: Array<string | null | undefined> = [];
  const identity = (workspace: string | null | undefined) => {
    asked.push(workspace);
    return workspace === "/work/attempt" ? FAKE_GIT_ENV : {};
  };
  const owner = { PATH: "/usr/bin", HOME: "/home/fake", GIT_AUTHOR_EMAIL: "personal@example.invalid" };
  const request = { cwd: "/work/attempt", supervisorEntryId: "supervised_fake" };
  const rental = { cwd: "/work/attempt", supervisorEntryId: "supervised_rental_fake" };

  const claude = claudeCliEnv(owner, { LETAGENTS_SUPERVISOR_ENTRY_ID: "entry" }, "/work/attempt", identity);
  assert.equal(claude.GIT_AUTHOR_EMAIL, FAKE_IDENTITY.email, "Claude Code");
  assert.equal(claude.GIT_COMMITTER_NAME, FAKE_IDENTITY.name);
  const claudeRental = claudeCliEnv(owner, { LETAGENTS_RENTAL_CREDENTIAL_ISOLATION: "1" }, "/work/attempt", identity);
  assert.equal(claudeRental.GIT_AUTHOR_EMAIL, undefined, "rental children keep only their isolated variables");
  assert.equal(claudeCliEnv(owner, {}, "/elsewhere", identity).GIT_AUTHOR_EMAIL, "personal@example.invalid",
    "a workspace that does not qualify keeps the host's own identity");

  const openCode = minimalOpenCodeEnvironment(owner, { XDG_CONFIG_HOME: "/runtime/config" }, request, identity);
  assert.equal(openCode.GIT_AUTHOR_EMAIL, FAKE_IDENTITY.email, "Open Model");
  assert.equal(minimalOpenCodeEnvironment(owner, {}, rental, identity).GIT_AUTHOR_EMAIL, undefined, "Open Model rental");

  const cursor = buildManagedCursorChildEnv({ HOME: "/profile/home" }, request, identity);
  assert.equal(cursor.GIT_AUTHOR_EMAIL, FAKE_IDENTITY.email, "Cursor");
  assert.equal(cursor.HOME, "/profile/home");
  assert.equal(buildManagedCursorChildEnv({}, rental, identity).GIT_AUTHOR_EMAIL, undefined, "Cursor rental");
  assert.ok(asked.includes(null), "a rental never asks for the owner's identity");
});

test("the supervised Cursor child gets the identity for its work attempt, and a rental never does", async () => {
  const previous = {
    LETAGENTS_AGENT_COMMIT_IDENTITY_PATH: process.env.LETAGENTS_AGENT_COMMIT_IDENTITY_PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  const { home, gitEnv } = gitHome();
  const repo = gitRepo(gitEnv);
  // The daemon's own environment is what the probe reads; point it at the scratch home.
  process.env.LETAGENTS_AGENT_COMMIT_IDENTITY_PATH = settingsPath();
  process.env.HOME = home;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    await recordManagedAgentCommitAccount(FAKE_ACCOUNT);
    const child = cursorDaemonChildEnv({ HOME: "/profile/home", LETAGENTS_TOKEN: "owner-secret-fake" },
      { cwd: repo, supervisorEntryId: "supervised_fake" });
    assert.equal(child.GIT_AUTHOR_EMAIL, FAKE_IDENTITY.email);
    assert.equal(child.GIT_COMMITTER_EMAIL, FAKE_IDENTITY.email);
    assert.equal(child.LETAGENTS_TOKEN, undefined);
    const rented = cursorDaemonChildEnv({ HOME: "/profile/home" }, { cwd: repo, supervisorEntryId: "supervised_rental_fake" });
    assert.equal(rented.GIT_AUTHOR_EMAIL, undefined, "rental");
    assert.equal(cursorDaemonChildEnv({ HOME: "/profile/home" }).GIT_AUTHOR_EMAIL, undefined, "identity probes get none");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
