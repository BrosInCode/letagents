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
  managedCommitEnvironmentFor,
  readGitCommitIdentityFacts,
  readManagedAgentCommitIdentitySettings,
  recordManagedAgentCommitAccount,
  setManagedAgentCommitUsesHostIdentity,
} = await import("../main/agents/managed-agent-commit-identity.js");
const { getDesktopAuthStatus, signOutDesktopAuth } = await import("../main/auth.js");
const { minimalOpenCodeEnvironment } = await import("../main/agents/opencode-launch-contract.js");
const { cursorDaemonChildEnv } = await import("../main/agents/cursor-provider-adapter.js");
const { runCursorTurn } = await import("../main/agents/cursor-runner.js");

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
  identity: [{ key: "user.email", scope: "global", value: "owner@example.invalid", hostValue: "owner@example.invalid" }],
  signing: false,
  originUrl: "https://github.com/fake-org/fake-repo.git",
  environmentIdentity: false,
};
const environmentFor = (path: string) =>
  managedAgentCommitEnvironment("/fake/workspace", {
    settings: readManagedAgentCommitIdentitySettings(path),
    readFacts: async () => QUALIFYING_FACTS,
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
function identityFor(workspace: string | null, gitEnv: NodeJS.ProcessEnv): Promise<Record<string, string>> {
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
  assert.deepEqual(await environmentFor(path), {}, "no account yet");

  await recordManagedAgentCommitAccount(FAKE_ACCOUNT, path);
  assert.deepEqual(await environmentFor(path), FAKE_GIT_ENV);
  assert.deepEqual(await getManagedAgentCommitIdentitySettings(path), {
    useHostGitIdentity: false,
    githubIdentity: FAKE_IDENTITY,
  });

  assert.deepEqual(await setManagedAgentCommitUsesHostIdentity(true, path), {
    useHostGitIdentity: true,
    githubIdentity: FAKE_IDENTITY,
  });
  assert.deepEqual(await environmentFor(path), {}, "host identity kept");

  await recordManagedAgentCommitAccount({ ...FAKE_ACCOUNT, providerUserId: "777", login: "other-fake" }, path);
  assert.equal(readManagedAgentCommitIdentitySettings(path).useHostGitIdentity, true, "the choice survives an account change");
  await setManagedAgentCommitUsesHostIdentity(false, path);
  assert.equal((await environmentFor(path)).GIT_AUTHOR_EMAIL, "777+other-fake@users.noreply.github.com");

  await recordManagedAgentCommitAccount(null, path);
  assert.deepEqual(await environmentFor(path), {}, "signed out");
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
    assert.deepEqual(await environmentFor(path), {}, JSON.stringify(account));
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

test("only a global identity in a GitHub repository is replaced", async () => {
  const { gitEnv } = gitHome();
  assert.deepEqual(await identityFor(gitRepo(gitEnv), gitEnv), FAKE_GIT_ENV, "global email, GitHub over HTTPS");
  assert.deepEqual(await identityFor(gitRepo(gitEnv, "git@github.com:fake-org/fake-repo.git"), gitEnv), FAKE_GIT_ENV,
    "GitHub over SSH");

  const local = gitRepo(gitEnv);
  execFileSync("git", ["config", "user.email", "repo@example.invalid"], { cwd: local, env: gitEnv });
  assert.equal((await readGitCommitIdentityFacts(local, gitEnv))?.identity[0]?.scope, "local");
  assert.deepEqual(await identityFor(local, gitEnv), {}, "a repository email is the owner's choice");
  const sameLocal = gitRepo(gitEnv);
  execFileSync("git", ["config", "user.email", "owner@example.invalid"], { cwd: sameLocal, env: gitEnv });
  assert.deepEqual(await identityFor(sameLocal, gitEnv), {}, "even when the repository repeats the global email");

  assert.deepEqual(await identityFor(gitRepo(gitEnv, "https://gitlab.com/fake-org/fake-repo.git"), gitEnv), {}, "not GitHub");
  assert.deepEqual(await identityFor(gitRepo(gitEnv, "https://github.example.invalid/fake-org/fake-repo.git"), gitEnv), {},
    "not github.com");
  assert.deepEqual(await identityFor(gitRepo(gitEnv, null), gitEnv), {}, "no origin");
  assert.deepEqual(await identityFor(fixture("not-a-repo"), gitEnv), {}, "a room scratch folder");
  assert.deepEqual(await identityFor(null, gitEnv), {}, "no workspace, as for rentals");
  assert.deepEqual(await identityFor(gitRepo(gitEnv), { ...gitEnv, GIT_AUTHOR_EMAIL: "env@example.invalid" }), {},
    "an identity already in the environment");

  const { gitEnv: unset } = gitHome("");
  assert.deepEqual(await identityFor(gitRepo(unset), unset), {}, "no email configured at all");
});

test("an email from a conditional include is kept; an unconditional include is the global identity", async () => {
  const work = realpathSync(fixture("work"));
  const included = join(fixture("included"), "work.gitconfig");
  writeFileSync(included, "[user]\n\temail = work@example.invalid\n");
  const { gitEnv } = gitHome(`[user]\n\temail = owner@example.invalid\n[includeIf "gitdir:${work}/"]\n\tpath = ${included}\n`);
  gitRepo(gitEnv, "https://github.com/fake-org/work.git", work);
  const facts = await readGitCommitIdentityFacts(work, gitEnv);
  assert.deepEqual(facts?.identity.find((setting) => setting.key === "user.email"), {
    key: "user.email",
    scope: "global", // Git reports an includeIf email under the including scope.
    value: "work@example.invalid",
    hostValue: "owner@example.invalid",
  });
  assert.deepEqual(await identityFor(work, gitEnv), {}, "includeIf identity");
  assert.deepEqual(await identityFor(gitRepo(gitEnv), gitEnv), FAKE_GIT_ENV, "other repositories still use the global email");

  const { gitEnv: plain } = gitHome(`[include]\n\tpath = ${included}\n`);
  assert.deepEqual(await identityFor(gitRepo(plain), plain), FAKE_GIT_ENV);
});

test("signing setups keep the host identity", async () => {
  for (const signing of [
    "[commit]\n\tgpgsign = true\n",
    "[commit]\n\tgpgsign\n",
    "[tag]\n\tgpgSign = yes\n",
    "[user]\n\tsigningkey = ABCDEF0123456789\n",
  ]) {
    const { gitEnv } = gitHome(`[user]\n\temail = owner@example.invalid\n${signing}`);
    const repo = gitRepo(gitEnv);
    assert.equal((await readGitCommitIdentityFacts(repo, gitEnv))?.signing, true, signing);
    assert.deepEqual(await identityFor(repo, gitEnv), {}, signing);
  }
  const { gitEnv } = gitHome("[user]\n\temail = owner@example.invalid\n[commit]\n\tgpgsign = false\n");
  assert.deepEqual(await identityFor(gitRepo(gitEnv), gitEnv), FAKE_GIT_ENV, "signing turned off");
  assert.equal(canUseNoreplyIdentity({ ...QUALIFYING_FACTS, signing: true }), false);
});

test("a commit made with the managed environment is authored and committed by the noreply identity", async () => {
  const { gitEnv } = gitHome();
  const repo = gitRepo(gitEnv);
  const identity = await identityFor(repo, gitEnv);
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "fake"], { cwd: repo, env: { ...gitEnv, ...identity } });
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

test("any author or committer setting from a repository, worktree or conditional include is kept", async () => {
  const { gitEnv } = gitHome();
  for (const key of ["user.name", "author.email", "author.name", "committer.email", "committer.name"]) {
    const repo = gitRepo(gitEnv);
    execFileSync("git", ["config", key, "repo-choice@example.invalid"], { cwd: repo, env: gitEnv });
    assert.deepEqual(await identityFor(repo, gitEnv), {}, `repository ${key}`);
  }

  const worktreeScoped = gitRepo(gitEnv);
  execFileSync("git", ["config", "extensions.worktreeConfig", "true"], { cwd: worktreeScoped, env: gitEnv });
  execFileSync("git", ["config", "--worktree", "committer.email", "tree@example.invalid"], { cwd: worktreeScoped, env: gitEnv });
  assert.equal((await readGitCommitIdentityFacts(worktreeScoped, gitEnv))?.identity
    .find((setting) => setting.key === "committer.email")?.scope, "worktree");
  assert.deepEqual(await identityFor(worktreeScoped, gitEnv), {}, "worktree committer.email");

  const work = realpathSync(fixture("author-work"));
  const included = join(fixture("author-included"), "work.gitconfig");
  writeFileSync(included, "[author]\n\tname = Work Persona\n");
  const { gitEnv: conditional } = gitHome(
    `[user]\n\temail = owner@example.invalid\n[includeIf "gitdir:${work}/"]\n\tpath = ${included}\n`);
  gitRepo(conditional, "https://github.com/fake-org/work.git", work);
  assert.deepEqual(await identityFor(work, conditional), {}, "includeIf author.name");
  assert.deepEqual(await identityFor(gitRepo(conditional), conditional), FAKE_GIT_ENV, "other repositories");

  const { gitEnv: globalAuthor } = gitHome("[user]\n\temail = owner@example.invalid\n[author]\n\temail = owner+author@example.invalid\n");
  assert.deepEqual(await identityFor(gitRepo(globalAuthor), globalAuthor), FAKE_GIT_ENV, "a global author.email is still global");
});

test("each provider's environment builder carries the identity it is given", () => {
  const owner = { PATH: "/usr/bin", HOME: "/home/fake", LETAGENTS_TOKEN: "owner-secret-fake" };
  const openCode = minimalOpenCodeEnvironment(owner, { XDG_CONFIG_HOME: "/runtime/config" }, FAKE_GIT_ENV);
  assert.equal(openCode.GIT_AUTHOR_EMAIL, FAKE_IDENTITY.email, "Open Model");
  assert.equal(openCode.GIT_COMMITTER_NAME, FAKE_IDENTITY.name);
  assert.equal(minimalOpenCodeEnvironment(owner, {}).GIT_AUTHOR_EMAIL, undefined);

  const cursor = cursorDaemonChildEnv({ HOME: "/profile/home", LETAGENTS_TOKEN: "owner-secret-fake" }, FAKE_GIT_ENV);
  assert.equal(cursor.GIT_AUTHOR_EMAIL, FAKE_IDENTITY.email, "Cursor");
  assert.equal(cursor.HOME, "/profile/home");
  assert.equal(cursor.LETAGENTS_TOKEN, undefined);
  assert.equal(cursorDaemonChildEnv({ HOME: "/profile/home" }).GIT_AUTHOR_EMAIL, undefined, "identity probes get none");

  const gitAuth = {
    HOME: "/profile/home", GH_CONFIG_DIR: "/owner/gh", GH_TOKEN: "fake-gh-token",
    SSH_AUTH_SOCK: "/owner/ssh.sock", GIT_CONFIG_GLOBAL: "/owner/custom.gitconfig",
    LETAGENTS_TOKEN: "owner-secret-fake", CURSOR_API_KEY: "fake-cursor-key",
  };
  const fullAccess = cursorDaemonChildEnv(gitAuth, FAKE_GIT_ENV, true);
  for (const key of ["GH_CONFIG_DIR", "GH_TOKEN", "SSH_AUTH_SOCK", "GIT_CONFIG_GLOBAL"] as const) {
    assert.equal(fullAccess[key], gitAuth[key]);
    assert.equal(cursorDaemonChildEnv(gitAuth)[key], undefined, `restricted Cursor omits ${key}`);
  }
  assert.equal(fullAccess.LETAGENTS_TOKEN, undefined);
  assert.equal(fullAccess.CURSOR_API_KEY, undefined);
  assert.equal(fullAccess.HOME, "/profile/home");
  assert.equal(fullAccess.GIT_AUTHOR_EMAIL, FAKE_IDENTITY.email);
});

/** Point the daemon's own environment at a scratch home and identity file for one test. */
async function withScratchOwner<T>(run: (repo: string) => Promise<T>): Promise<T> {
  const previous = {
    LETAGENTS_AGENT_COMMIT_IDENTITY_PATH: process.env.LETAGENTS_AGENT_COMMIT_IDENTITY_PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  const { home, gitEnv } = gitHome();
  const repo = gitRepo(gitEnv);
  process.env.LETAGENTS_AGENT_COMMIT_IDENTITY_PATH = settingsPath();
  process.env.HOME = home;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    await recordManagedAgentCommitAccount(FAKE_ACCOUNT);
    return await run(repo);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a work attempt resolves the identity, and a rental never does", async () => {
  await withScratchOwner(async (repo) => {
    assert.deepEqual(await managedCommitEnvironmentFor({ cwd: repo, supervisorEntryId: "supervised_fake" }), FAKE_GIT_ENV);
    assert.deepEqual(await managedCommitEnvironmentFor({ cwd: repo }), FAKE_GIT_ENV, "a legacy launch");
    assert.deepEqual(await managedCommitEnvironmentFor({ cwd: repo, supervisorEntryId: "supervised_rental_fake" }), {});
    assert.deepEqual(await managedCommitEnvironmentFor(null), {});
  });
});

test("a legacy Cursor turn runs with the identity resolved for its workspace", async () => {
  await withScratchOwner(async (repo) => {
    const directory = fixture("legacy-cursor");
    const report = join(directory, "env.json");
    const bin = join(directory, "cursor-agent");
    writeFileSync(bin, [
      "#!/usr/bin/env node",
      `require("node:fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify({`,
      "  author: process.env.GIT_AUTHOR_EMAIL ?? null, committer: process.env.GIT_COMMITTER_NAME ?? null }));",
      "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'fake-session' }) + '\\n');",
      "",
    ].join("\n"), { mode: 0o755 });
    const result = await runCursorTurn({ prompt: "fake", cwd: repo, cursorBin: bin });
    assert.equal(result.status, "success", result.error ?? "");
    assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { author: FAKE_IDENTITY.email, committer: FAKE_IDENTITY.name });
  });
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
