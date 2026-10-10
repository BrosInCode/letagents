import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { basename, dirname, join, parse } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

const env = createElectronTestEnv({
  prefix: "letagents-codex-agent-home-",
  paths: [],
  extraEnvFiles: { LETAGENTS_AGENT_COMMIT_IDENTITY_PATH: "agent-commit-identity.json" },
});
// Every Git probe and provider in this file sees a scratch HOME, never the owner's.
const scratchHome = join(env.tempDir, "scratch-home");
mkdirSync(scratchHome, { recursive: true });
writeFileSync(join(scratchHome, ".gitconfig"), "[user]\n\tname = Fake Owner\n\temail = owner@example.invalid\n");
process.env.HOME = scratchHome;
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.CODEX_HOME;
writeFileSync(process.env.LETAGENTS_AGENT_COMMIT_IDENTITY_PATH!, JSON.stringify({
  version: 1,
  useHostGitIdentity: false,
  githubAccount: { login: "octo-fake", id: "424242" },
}));

const {
  CODEX_TOKEN_SERVICE_OVERRIDES, CodexAgentHomeError, CodexAgentHomeSignInError, checkCodexKeepsLinkedSignIn, codexAgentHomeDirectory, codexHomeForSandboxedLaunch,
  folderHolds, linkCodexAgentHome, sandboxedCodexHomeRefusal, sandboxedCodexLoadRefusal, sandboxedCodexProjectRefusal,
} = await import("../main/agents/codex-agent-home.js");
const {
  SANDBOXED_PROJECT_KEYS, SANDBOX_KEYS_A_PROJECT_MAY_SET, assertLayersAddNoCommandRules, assertLiveCodexIsolationUnchanged, firstFolderEntries, inspectCodexSettings, pathFrom,
  projectCommandRulesRefusal, projectKeysRefusal, projectRuleFolders,
} = await import("../main/agents/codex-home-harness.js");
const { codexOwnerIsolationOverrides } = await import("../../../../shared/codex-owner-isolation.mjs");
const { codexAppServerEnvironment, launchManagedCodexAppServer, terminateSpawnedProcess, waitForLaunchedCodexAppServer } = await import("../main/agents/codex-app-server.js");
const { CodexProviderAdapter } = await import("../main/agents/codex-provider-adapter.js");
const { CodexRpcClient } = await import("../main/agents/codex-rpc-client.js");
const { resolveCodexExecutable } = await import("../main/agents/codex-executable.js");

let fixtureSerial = 0;
function fixture(name: string): string {
  const path = join(env.tempDir, `${name}-${fixtureSerial++}`);
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}

const ALLOW_RULE = 'prefix_rule(pattern=["touch"], decision="allow")\n';

/** A stand-in owner Codex home: a sign-in, a config, instructions, conversations and one saved rule. */
function ownerHome(options: { rules?: boolean } = {}): { home: string; codexHome: string; agentHome: string; env: Record<string, string> } {
  const home = fixture("owner");
  const codexHome = join(home, ".codex");
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), '{"pretend":"owner sign-in"}\n', { mode: 0o600 });
  writeFileSync(join(codexHome, "config.toml"), 'model = "owner-model"\n');
  writeFileSync(join(codexHome, "AGENTS.md"), "Owner instructions.\n");
  if (options.rules !== false) {
    mkdirSync(join(codexHome, "rules"));
    writeFileSync(join(codexHome, "rules", "default.rules"), ALLOW_RULE);
  }
  return { home, codexHome, agentHome: join(home, ".letagents", "codex-agent-home"), env: { HOME: home, CODEX_HOME: codexHome } };
}

/** Every entry of a folder with what it is: `name@` a link, `name/` a folder, `name` a file. */
function entries(folder: string): string[] {
  return readdirSync(folder).sort().map((name) => {
    const entry = lstatSync(join(folder, name));
    return `${name}${entry.isSymbolicLink() ? "@" : entry.isDirectory() ? "/" : ""}`;
  });
}

/** Every file below a folder with its content, to show that a folder was only read. */
function snapshot(folder: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(folder, { recursive: true }).map(String).sort()) {
    const path = join(folder, name);
    const entry = lstatSync(path);
    files[name] = entry.isFile() ? `${(entry.mode & 0o777).toString(8)} ${readFileSync(path, "utf8")}` : entry.isDirectory() ? "folder" : "other";
  }
  return files;
}

test("the agents' Codex home links every entry of the owner's home except its saved rules, and only reads the owner's home", () => {
  const owner = ownerHome();
  const before = snapshot(owner.codexHome);

  linkCodexAgentHome(owner.codexHome, owner.agentHome);

  assert.deepEqual(entries(owner.agentHome), ["AGENTS.md@", "auth.json@", "config.toml@", "rules/", "sessions@"]);
  for (const name of ["AGENTS.md", "auth.json", "config.toml", "sessions"]) {
    assert.equal(readlinkSync(join(owner.agentHome, name)), join(owner.codexHome, name), name);
  }
  assert.deepEqual(readdirSync(join(owner.agentHome, "rules")), [], "no saved rule reaches the agents' home");
  assert.equal(lstatSync(join(owner.agentHome, "rules")).mode & 0o222, 0, "nothing can be saved into its rules folder");
  assert.equal(lstatSync(owner.agentHome).mode & 0o077, 0, "the folder is the user's alone");
  // The sign-in is the owner's own file, reached through the link: what is written there is written to the owner's.
  writeFileSync(join(owner.agentHome, "auth.json"), '{"pretend":"refreshed"}\n');
  assert.equal(readFileSync(join(owner.codexHome, "auth.json"), "utf8"), '{"pretend":"refreshed"}\n');
  assert.deepEqual(snapshot(owner.codexHome), { ...before, "auth.json": '600 {"pretend":"refreshed"}\n' });
});

test("linking the agents' home again follows the owner's home: new entries, removed ones, and a link under the wrong name", () => {
  const owner = ownerHome();
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  assert.deepEqual(entries(owner.agentHome), ["AGENTS.md@", "auth.json@", "config.toml@", "rules/", "sessions@"]);

  // The owner's home gains an entry and loses one, and one link leads to another entry of the same home.
  writeFileSync(join(owner.codexHome, "models_cache.json"), "{}");
  execFileSync("rm", [join(owner.codexHome, "AGENTS.md")]);
  execFileSync("ln", ["-sfn", join(owner.codexHome, "auth.json"), join(owner.agentHome, "config.toml")]);

  linkCodexAgentHome(owner.codexHome, owner.agentHome);

  assert.deepEqual(entries(owner.agentHome), ["auth.json@", "config.toml@", "models_cache.json@", "rules/", "sessions@"]);
  assert.equal(readFileSync(join(owner.agentHome, "config.toml"), "utf8"), 'model = "owner-model"\n');
});

test("nothing with content is deleted from the agents' home: an empty entry of its own becomes the link, one with content is kept and named", () => {
  const owner = ownerHome();
  mkdirSync(join(owner.codexHome, "shell_snapshots"));
  writeFileSync(join(owner.codexHome, "state_5.sqlite"), "owner state");
  writeFileSync(join(owner.codexHome, "history.jsonl"), "owner history\n");
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  // Codex replaced two links with files of its own and one with a folder, and made things the owner's home does not have.
  const own = (name: string, content: string | null) => {
    execFileSync("rm", [join(owner.agentHome, name)]);
    if (content === null) mkdirSync(join(owner.agentHome, name));
    else writeFileSync(join(owner.agentHome, name), content);
  };
  own("config.toml", 'model = "a-copy"\n');
  own("state_5.sqlite", "a conversation index");
  own("history.jsonl", "");
  own("shell_snapshots", null);
  own("sessions", null);
  writeFileSync(join(owner.agentHome, "sessions", "rollout.jsonl"), "a conversation\n");
  mkdirSync(join(owner.agentHome, "made-here"));
  writeFileSync(join(owner.agentHome, "made-here.json"), "{}");

  const linked = linkCodexAgentHome(owner.codexHome, owner.agentHome);

  // The empty file and the empty folder are the owner's again. Everything with content is still there, as it was.
  assert.deepEqual(entries(owner.agentHome), [
    "AGENTS.md@", "auth.json@", "config.toml", "history.jsonl@", "made-here/", "made-here.json", "rules/", "sessions/", "shell_snapshots@", "state_5.sqlite",
  ]);
  assert.equal(readFileSync(join(owner.agentHome, "state_5.sqlite"), "utf8"), "a conversation index");
  assert.equal(readFileSync(join(owner.agentHome, "sessions", "rollout.jsonl"), "utf8"), "a conversation\n");
  assert.equal(readFileSync(join(owner.agentHome, "config.toml"), "utf8"), 'model = "a-copy"\n');
  assert.deepEqual(linked, {
    own: ["config.toml", "made-here", "made-here.json", "sessions", "state_5.sqlite"],
    inPlaceOfOwners: ["config.toml", "sessions", "state_5.sqlite"],
  });
  assert.equal(readFileSync(join(owner.codexHome, "config.toml"), "utf8"), 'model = "owner-model"\n', "the owner's config was not written");
  assert.deepEqual(linkCodexAgentHome(ownerHome().codexHome, join(fixture("fresh"), "agent-home")), { own: [], inPlaceOfOwners: [] });
});

test("a rule saved into the agents' home is gone at the next launch, whatever its rules entry had become", () => {
  const owner = ownerHome();
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  const rules = join(owner.agentHome, "rules");
  execFileSync("chmod", ["755", rules]);
  writeFileSync(join(rules, "default.rules"), ALLOW_RULE);
  mkdirSync(join(rules, "nested"));
  writeFileSync(join(rules, "nested", ".hidden.rules"), ALLOW_RULE);
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  assert.deepEqual(readdirSync(rules), []);

  // A rules entry that is a link to the owner's rules is not followed, and the owner's rules stay.
  execFileSync("rmdir", [rules]);
  symlinkSync(join(owner.codexHome, "rules"), rules);
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  assert.ok(lstatSync(rules).isDirectory());
  assert.deepEqual(readdirSync(rules), []);
  assert.equal(readFileSync(join(owner.codexHome, "rules", "default.rules"), "utf8"), ALLOW_RULE);
});

test("a sign-in file of its own in the agents' home is never removed, and nothing is linked past it", () => {
  const owner = ownerHome();
  mkdirSync(owner.agentHome, { recursive: true });
  writeFileSync(join(owner.agentHome, "auth.json"), '{"pretend":"a second sign-in"}\n');

  assert.throws(() => linkCodexAgentHome(owner.codexHome, owner.agentHome), (error: Error) => {
    assert.ok(error instanceof CodexAgentHomeSignInError);
    assert.equal(error.message,
      "LetAgents found a Codex sign-in file of its own (auth.json) in the folder it keeps for sandboxed agents (codex-agent-home in your .letagents folder). "
      + "Two sign-in files can sign you out of Codex, so LetAgents will not start a sandboxed Codex agent. "
      + "Open Codex and check that it is still signed in, then delete that file and start the agent again. "
      + "If Codex asks you to sign in, sign in again: your conversations and settings are kept.");
    return true;
  });
  assert.equal(readFileSync(join(owner.agentHome, "auth.json"), "utf8"), '{"pretend":"a second sign-in"}\n');
  assert.equal(readFileSync(join(owner.codexHome, "auth.json"), "utf8"), '{"pretend":"owner sign-in"}\n');
});

test("the agents' home is a folder apart from the owner's home", () => {
  const owner = ownerHome();
  for (const agentHome of [owner.codexHome, join(owner.codexHome, "agents"), owner.home]) {
    assert.throws(() => linkCodexAgentHome(owner.codexHome, agentHome), /must be a folder apart from the owner's Codex home/);
  }
  assert.deepEqual(entries(owner.codexHome), ["AGENTS.md", "auth.json", "config.toml", "rules/", "sessions/"]);
  assert.equal(codexAgentHomeDirectory({ HOME: owner.home }), owner.agentHome);
});

const noProject = { projectLayers: [], credentialStore: "file", otherRuleFolders: [], writableRoots: [] as string[], userAgent: "codex-stand-in/1.0" as string | null };
/** What the owner is told about a project that has command rules of its own: what was found, what it would do, and the two ways out. */
const projectRulesRefusal = (folder: string, names: string) =>
  `Codex reads command rules from ${folder} in this agent's work folder once it trusts the project, and that folder is not empty (${names}). `
  + "LetAgents does not read the files in it. If one of them allows a command, a sandboxed Codex agent runs that command with no sandbox and no approval. "
  + "So LetAgents does not start Codex here, or give it work, at this access level. "
  + `Remove or rename ${folder} in the agent's work folder, which can differ from your own copy of the project, or give this agent Full access if you accept that.`;
/** The same when the folder is the owner's own saved rules, because the agent's repository top is the folder that holds their Codex home. */
const savedRulesAsProjectRefusal = (names: string) =>
  "This agent's work folder is in a repository whose top is the folder that holds your Codex home. "
  + `So Codex reads your saved command rules (the rules folder in your Codex home) as this project's own once it trusts the project, and that folder is not empty (${names}). `
  + "LetAgents does not read the files in it. If one of them allows a command, a sandboxed Codex agent runs that command with no sandbox and no approval. "
  + "So LetAgents does not start Codex here, or give it work, at this access level. "
  + "Give the agent a work folder in a repository of its own, remove your saved rules, or give this agent Full access if you accept that.";
const useAgentsHome = (codexHome: string) => ({ codexHome, notices: [] });
const useOwnersHome = { codexHome: null, notices: [] };

test("a sandboxed launch gets the agents' home when Codex keeps its sign-in in a file and rewrites it in place", async () => {
  const owner = ownerHome();
  const project = fixture("project");
  const asked: string[] = [];
  const deps = {
    inspect: async (_bin: string, options: { cwd: string; env: NodeJS.ProcessEnv }) => { asked.push(`inspect ${options.cwd} ${options.env.CODEX_HOME}`); return noProject; },
    keepsLinkedSignIn: async () => { asked.push("sign-in check"); return true; },
  };
  const home = await codexHomeForSandboxedLaunch("codex", { cwd: project, env: owner.env }, deps);
  assert.deepEqual(home, useAgentsHome(owner.agentHome));
  assert.deepEqual(asked, [`inspect ${project} ${owner.codexHome}`, "sign-in check"], "Codex is asked about the owner's home, before any link is made");
  // An agent that works in the user's own folder has the owner's saved rules as its project's: Codex reads them as the project's once it trusts that folder.
  await assert.rejects(codexHomeForSandboxedLaunch("codex", { cwd: owner.home, env: owner.env }, deps), (error: Error) => {
    assert.equal(error.message, savedRulesAsProjectRefusal("default.rules"));
    return true;
  });
  assert.deepEqual(entries(owner.agentHome), ["AGENTS.md@", "auth.json@", "config.toml@", "rules/", "sessions@"]);
});

test("when the agents' home cannot be used, a sandboxed launch runs with the owner's home only if it holds no saved rule", async () => {
  // An owner whose sign-in is in the keychain has a third way out: Codex keeps it in a file when its config says so.
  const USE_A_FILE = ' Or set cli_auth_credentials_store = "file" in your Codex config.toml, and sign in to Codex again if it asks.';
  const cases: Array<{ name: string; deps: Parameters<typeof codexHomeForSandboxedLaunch>[2]; why: RegExp; otherWayOut?: string }> = [
    { name: "a sign-in kept in the keychain", why: /Codex does not keep its sign-in in a file in its home folder/, otherWayOut: USE_A_FILE,
      deps: { inspect: async () => ({ ...noProject, credentialStore: "keyring" }), keepsLinkedSignIn: async () => { throw new Error("not asked"); } } },
    { name: "a sign-in kept in the keychain when there is one", why: /Codex does not keep its sign-in in a file in its home folder/, otherWayOut: USE_A_FILE,
      deps: { inspect: async () => ({ ...noProject, credentialStore: "auto" }), keepsLinkedSignIn: async () => { throw new Error("not asked"); } } },
    { name: "a Codex that does not say where its sign-in is", why: /Codex did not say where it keeps its sign-in/,
      deps: { inspect: async () => ({ ...noProject, credentialStore: null }), keepsLinkedSignIn: async () => { throw new Error("not asked"); } } },
    { name: "a Codex that does not rewrite a linked sign-in in place", why: /could not confirm that this Codex version keeps a shared sign-in file in place/,
      deps: { inspect: async () => noProject, keepsLinkedSignIn: async () => false, link: () => { throw new Error("not linked"); } } },
    { name: "a folder that cannot hold links", why: /the folder for it could not be prepared \(EPERM\)/,
      deps: { inspect: async () => noProject, keepsLinkedSignIn: async () => true, link: () => { throw Object.assign(new Error("no"), { code: "EPERM" }); } } },
  ];
  for (const testCase of cases) {
    const withRules = ownerHome();
    await assert.rejects(codexHomeForSandboxedLaunch("codex", { env: withRules.env }, testCase.deps), (error: Error) => {
      assert.match(error.message, /^Codex has saved command rules \(the rules folder in your Codex home\), and a command that matches one runs outside this agent's sandbox\./, testCase.name);
      assert.match(error.message, testCase.why, testCase.name);
      assert.ok(error.message.endsWith(`So it will not start Codex at this access level. Remove the saved rules, or give this agent Full access.${testCase.otherWayOut ?? ""}`), testCase.name);
      assert.ok(!error.message.includes(withRules.home), "the message names no folder of this machine");
      return true;
    });
    assert.equal(existsSync(withRules.agentHome), false, testCase.name);

    const withoutRules = ownerHome({ rules: false });
    assert.deepEqual(await codexHomeForSandboxedLaunch("codex", { env: withoutRules.env }, testCase.deps), useOwnersHome, testCase.name);
    // An empty rules folder holds no rule; one that cannot be listed counts as holding one.
    mkdirSync(join(withoutRules.codexHome, "rules"));
    assert.deepEqual(await codexHomeForSandboxedLaunch("codex", { env: withoutRules.env }, testCase.deps), useOwnersHome, testCase.name);
    writeFileSync(join(withoutRules.codexHome, "rules", "README"), "not a rule\n");
    await assert.rejects(codexHomeForSandboxedLaunch("codex", { env: withoutRules.env }, testCase.deps), /Codex has saved command rules/, testCase.name);
  }
});

test("a sandboxed launch does not start when Codex cannot be asked, when the agents' home holds a sign-in, or when the project ships command rules", async () => {
  const owner = ownerHome({ rules: false });
  await assert.rejects(
    codexHomeForSandboxedLaunch("codex", { env: owner.env }, { inspect: async () => { throw new Error("Codex stopped before it answered\nsecond line"); } }),
    (error: Error) => {
      assert.equal(error.message,
        "Codex did not answer when LetAgents asked for its settings (Codex stopped before it answered), so LetAgents will not start it at a sandboxed access level. "
        + "Start the agent again. If it happens again, check that the codex command runs on this computer, and update Codex.");
      return true;
    },
  );

  // Even with no saved rule in the owner's home, a second sign-in file is never started past.
  mkdirSync(owner.agentHome, { recursive: true });
  writeFileSync(join(owner.agentHome, "auth.json"), "{}");
  await assert.rejects(
    codexHomeForSandboxedLaunch("codex", { env: owner.env }, { inspect: async () => noProject, keepsLinkedSignIn: async () => true }),
    CodexAgentHomeSignInError,
  );

  const project = fixture("project");
  execFileSync("git", ["init", "-q"], { cwd: project });
  mkdirSync(join(project, "packages", "app", ".codex", "rules"), { recursive: true });
  writeFileSync(join(project, "packages", "app", ".codex", "rules", "allow.rules"), ALLOW_RULE);
  const layers = { ...noProject, projectLayers: [{ dotCodexFolder: join(project, ".codex"), config: {} }, { dotCodexFolder: join(project, "packages", "app", ".codex"), config: {} }] };
  const clean = ownerHome({ rules: false });
  await assert.rejects(
    codexHomeForSandboxedLaunch("codex", { cwd: join(project, "packages", "app"), env: clean.env }, { inspect: async () => layers, keepsLinkedSignIn: async () => true }),
    (error: Error) => {
      assert.equal(error.message, projectRulesRefusal("packages/app/.codex/rules", "allow.rules"));
      return true;
    },
  );
  assert.equal(existsSync(clean.agentHome), false, "nothing is linked for a launch that is refused");
  // A project layer Codex does not apply is not in the answer, and a rules folder with nothing in it holds no rule.
  execFileSync("rm", [join(project, "packages", "app", ".codex", "rules", "allow.rules")]);
  assert.deepEqual(await codexHomeForSandboxedLaunch("codex", { cwd: project, env: clean.env }, { inspect: async () => layers, keepsLinkedSignIn: async () => true }), useAgentsHome(clean.agentHome));
});

/**
 * A stand-in Codex binary. It records every invocation next to itself, answers
 * the questions a launch asks a short-lived app-server, and refreshes a
 * sign-in file the way its `signIn` setting says: `in-place` rewrites the
 * file, `replace` writes a new file over the name, `none` leaves it.
 */
function fakeCodex(settings: {
  signIn?: "in-place" | "replace" | "none"; store?: string; layers?: unknown[];
  /**
   * The MCP servers it lists besides the room's own, and what a project does to the room's own: add a key, which no launch
   * override takes back, or set only keys that a launch's own override for that server sets too.
   */
  servers?: string[]; projectChangesRoomServer?: boolean; projectSetsRoomServerKeys?: boolean; listFails?: boolean;
  /** What it says it is when it is asked for its settings, and the folders its config lets a sandboxed command write. */
  userAgent?: string; writableRoots?: string[];
} = {}): {
  bin: string; calls: () => Array<{ args: string[]; cwd: string; codexHome: string | null; refreshUrl: string | null; revokeUrl: string | null; room: string | null }>;
} {
  const directory = fixture("fake-codex");
  const bin = join(directory, "codex");
  const report = join(directory, "calls.jsonl");
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ signIn: "in-place", store: "file", ...settings }));
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const settings = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'));",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ args, cwd: process.cwd(), codexHome: process.env.CODEX_HOME ?? null,",
    "  refreshUrl: process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? null, revokeUrl: process.env.CODEX_REVOKE_TOKEN_URL_OVERRIDE ?? null,",
    "  room: process.env.LETAGENTS_SUPERVISOR_ROOM_ID ?? null }) + '\\n');",
    "if (args[0] === 'mcp') {",
    "  if (settings.listFails) process.exit(3);",
    "  const overridden = args.some((arg) => arg.startsWith('mcp_servers.letagents='));",
    "  const changed = process.cwd() !== '/' && (settings.projectChangesRoomServer || (settings.projectSetsRoomServerKeys && !overridden));",
    "  const off = (name) => args.join(' ').includes(JSON.stringify(name) + ' = { enabled = false }');",
    "  process.stdout.write(JSON.stringify([{ name: 'letagents', enabled: true, transport: { type: 'stdio', command: 'npx', args: changed ? ['./from-the-project.js'] : ['-y', 'letagents'], env: null } },",
    "    ...(settings.servers ?? []).map((name) => ({ name, enabled: !off(name) }))]));",
    "}",
    "if (args[0] === 'app-server' && args.includes('stdio://')) {",
    "  const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "  require('node:readline').createInterface({ input: process.stdin }).on('line', async (line) => {",
    "    const m = JSON.parse(line);",
    "    if (m.method === 'initialize') send({ id: m.id, result: settings.userAgent ? { userAgent: settings.userAgent } : {} });",
    "    if (m.method === 'config/read') send({ id: m.id, result: { config: { cli_auth_credentials_store: settings.store, sandbox_workspace_write: { writable_roots: settings.writableRoots ?? [] } }, layers: settings.layers ?? [] } });",
    "    if (m.method === 'hooks/list') send({ id: m.id, result: { data: m.params.cwds.map((cwd) => ({ cwd, hooks: [] })) } });",
    "    if (m.method === 'account/read') {",
    "      const file = path.join(process.env.CODEX_HOME, 'auth.json');",
    "      const auth = JSON.parse(fs.readFileSync(file, 'utf8'));",
    "      const answer = await fetch(process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE, { method: 'POST', body: JSON.stringify({ refresh_token: auth.tokens.refresh_token }) });",
    "      auth.tokens = { ...auth.tokens, ...(await answer.json()) };",
    "      if (settings.signIn === 'in-place') fs.writeFileSync(file, JSON.stringify(auth));",
    "      if (settings.signIn === 'replace') { fs.writeFileSync(file + '.new', JSON.stringify(auth)); fs.renameSync(file + '.new', file); }",
    "      send({ id: m.id, result: { account: null } });",
    "    }",
    "  });",
    "}",
    "",
  ].join("\n"), { mode: 0o755 });
  return {
    bin,
    calls: () => existsSync(report) ? readFileSync(report, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [],
  };
}

async function waitForExit(launch: { pid: number | null; exited: Promise<unknown> }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    launch.exited.then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 10_000); }),
  ]);
  clearTimeout(timer);
  if (!exited && launch.pid !== null) terminateSpawnedProcess(launch.pid);
}

test("a Codex that writes a new sign-in file over the linked one is found out with a made-up sign-in, before the owner's is linked", async () => {
  const run = { PATH: process.env.PATH };
  const beside = () => fixture("beside-the-agents-home");
  assert.equal(await checkCodexKeepsLinkedSignIn(fakeCodex({ signIn: "in-place" }).bin, run, beside()), true);
  assert.equal(await checkCodexKeepsLinkedSignIn(fakeCodex({ signIn: "replace" }).bin, run, beside()), false, "the link became a file of its own");
  assert.equal(await checkCodexKeepsLinkedSignIn(fakeCodex({ signIn: "none" }).bin, run, beside()), false, "the linked file never got the new token");
  assert.equal(await checkCodexKeepsLinkedSignIn(join(fixture("no-codex"), "codex"), run, beside()), false, "a Codex that cannot be run is not trusted");
  assert.equal(await checkCodexKeepsLinkedSignIn(fakeCodex().bin, { PATH: "" }, beside()), false, "a Codex that needs a PATH it is not given cannot be run");

  // The check gives Codex a made-up home and a token service on this machine, and nothing of the owner's.
  const codex = fakeCodex({ signIn: "in-place" });
  const parent = beside();
  await checkCodexKeepsLinkedSignIn(codex.bin, { ...run, LETAGENTS_TOKEN: "owner-token-fake", CODEX_HOME: "/owner/home" }, parent);
  const [call] = codex.calls();
  assert.match(call!.refreshUrl!, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/token$/);
  assert.equal(call!.room, null);
  assert.equal(join(call!.codexHome!, "..", ".."), parent, "its home is made in the folder it was given");
  assert.deepEqual(readdirSync(parent), [], "and removed afterwards");

  // Codex is found through the launch's own PATH, and the check's folder is beside the agents' home of that launch.
  const asked: string[] = [];
  const owner = ownerHome();
  await codexHomeForSandboxedLaunch("codex", { env: { ...owner.env, PATH: "launch-path" } }, {
    inspect: async () => noProject, keepsLinkedSignIn: async (_bin, launchEnv) => { asked.push(String(launchEnv.PATH)); return true; },
  });
  assert.deepEqual(asked, ["launch-path"]);
});

test("the sign-in check never runs Codex in a temp folder, nor with anything in its home that the check did not put there", async (t) => {
  // An agent at a sandboxed level can write the temp folder. A config it put in the check's home would be obeyed by a Codex with no sandbox.
  const owner = ownerHome();
  const temp = fixture("the-temp-folder");
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; });
  assert.equal(realpathSync(tmpdir()), temp);
  const codex = fakeCodex();
  const launch = await launchManagedCodexAppServer("ws://127.0.0.1:1", codex.bin, { trustedProjectPath: fixture("project"), configOverrides: [], env: owner.env, sandboxed: true });
  await waitForExit(launch);
  const check = codex.calls().find((call) => call.refreshUrl !== null)!;
  assert.equal(join(check.codexHome!, "..", ".."), join(owner.home, ".letagents"), "the check ran beside the agents' home");
  assert.deepEqual(readdirSync(temp), [], "nothing was made in the temp folder");
  assert.deepEqual(readdirSync(join(owner.home, ".letagents")), ["codex-agent-home"], "the check's folder is removed");

  // Something appears in the check's folder after it is made and before Codex starts: Codex is not started, and the answer is no.
  for (const planted of ["home/config.toml", "home/rules", "config.toml", "anything-else"]) {
    const parent = fixture("beside");
    const planting = fakeCodex();
    // The check reads PATH from the launch's environment between making its folder and looking at it again.
    const env = Object.defineProperty({} as NodeJS.ProcessEnv, "PATH", { enumerable: true, get: () => {
      const path = join(parent, readdirSync(parent)[0]!, planted);
      if (!existsSync(path)) writeFileSync(path, "planted\n");
      return process.env.PATH;
    } });
    assert.equal(await checkCodexKeepsLinkedSignIn(planting.bin, env, parent), false, planted);
    assert.deepEqual(planting.calls(), [], `${planted}: Codex was never started`);
    assert.deepEqual(readdirSync(parent), [], `${planted}: the folder is removed all the same`);
  }
  // A failed check is not remembered: the same Codex is checked again at the next launch, and a pass is.
  const changing = fakeCodex({ signIn: "replace" });
  const launchWith = () => codexHomeForSandboxedLaunch(changing.bin, { env: { ...ownerHome().env, PATH: process.env.PATH } }, { inspect: async () => noProject });
  await assert.rejects(launchWith(), /could not confirm that this Codex version keeps a shared sign-in file in place/);
  await assert.rejects(launchWith(), /could not confirm that this Codex version keeps a shared sign-in file in place/);
  assert.equal(changing.calls().length, 2, "each launch checked again");
  writeFileSync(join(changing.bin, "..", "settings.json"), JSON.stringify({ signIn: "in-place", store: "file" }));
  assert.notEqual((await launchWith()).codexHome, null);
  assert.notEqual((await launchWith()).codexHome, null);
  assert.equal(changing.calls().length, 3, "a pass is remembered for this Codex binary");
});

test("a managed launch at a sandboxed access level starts Codex with the agents' home, and at Full access with the owner's", async () => {
  const owner = ownerHome();
  const project = fixture("project");
  execFileSync("git", ["init", "-q"], { cwd: project });

  const sandboxed = fakeCodex();
  const launch = await launchManagedCodexAppServer("ws://127.0.0.1:1", sandboxed.bin, { trustedProjectPath: project, configOverrides: [], env: owner.env, sandboxed: true });
  await waitForExit(launch);
  assert.equal(launch.codexHome, owner.agentHome);
  const calls = sandboxed.calls();
  const kind = (call: { args: string[] }) => call.args[0] === "mcp" ? "list" : call.args.includes("stdio://") ? "ask" : "launch";
  // Codex is asked about the owner's home, then checked with a scratch home; every listing and the launch read the agents' home.
  assert.deepEqual(calls.map(kind), ["ask", "ask", "list", "list", "launch"]);
  assert.equal(calls[0]!.codexHome, owner.codexHome);
  assert.equal(join(calls[1]!.codexHome!, "..", ".."), join(owner.home, ".letagents"));
  assert.deepEqual(calls.slice(2).map((call) => call.codexHome), [owner.agentHome, owner.agentHome, owner.agentHome]);
  assert.deepEqual(readdirSync(join(owner.agentHome, "rules")), []);
  assert.equal(readFileSync(join(owner.codexHome, "auth.json"), "utf8"), '{"pretend":"owner sign-in"}\n', "the owner's sign-in was not written");

  const fullAccess = fakeCodex();
  const plain = await launchManagedCodexAppServer("ws://127.0.0.1:1", fullAccess.bin, { trustedProjectPath: project, configOverrides: [], env: owner.env });
  await waitForExit(plain);
  assert.equal(plain.codexHome, undefined);
  assert.deepEqual(fullAccess.calls().map(kind), ["list", "list", "launch"]);
  assert.deepEqual(fullAccess.calls().map((call) => call.codexHome), [owner.codexHome, owner.codexHome, owner.codexHome]);
});

test("no agent is started with a variable that tells Codex where to send its sign-in tokens, whatever the background service was started with", async () => {
  // Codex sends its refresh token to the first address, and the token it gives up to the second.
  assert.deepEqual([...CODEX_TOKEN_SERVICE_OVERRIDES].sort(), ["CODEX_REFRESH_TOKEN_URL_OVERRIDE", "CODEX_REVOKE_TOKEN_URL_OVERRIDE"]);
  const inherited = { CODEX_REFRESH_TOKEN_URL_OVERRIDE: "http://elsewhere.invalid/token", CODEX_REVOKE_TOKEN_URL_OVERRIDE: "http://elsewhere.invalid/revoke" };
  const project = fixture("project");
  for (const launchOptions of [{ sandboxed: true }, {}, { homeHarness: true, sandboxed: true }]) {
    const owner = ownerHome();
    const codex = fakeCodex();
    const launch = await launchManagedCodexAppServer("ws://127.0.0.1:1", codex.bin, {
      trustedProjectPath: project, configOverrides: [], env: { ...owner.env, ...inherited }, ...launchOptions,
    });
    await waitForExit(launch);
    const calls = codex.calls();
    // Only the sign-in check, which has a made-up sign-in, names a token service, and that one is on this machine.
    const withService = calls.filter((call) => call.refreshUrl !== null || call.revokeUrl !== null);
    assert.equal(withService.length, launchOptions.sandboxed ? 1 : 0, JSON.stringify(launchOptions));
    for (const call of withService) {
      assert.match(call.refreshUrl!, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/token$/);
      assert.equal(call.revokeUrl, null);
      assert.match(call.codexHome!, /codex-sign-in-check-/);
    }
    const started = calls.at(-1)!;
    assert.ok(started.args.includes("ws://127.0.0.1:1"));
    assert.deepEqual([started.refreshUrl, started.revokeUrl], [null, null]);
  }
  const rental = codexAppServerEnvironment({ env: { ...ownerHome().env, ...inherited, LETAGENTS_RENTAL_CREDENTIAL_ISOLATION: "1" } }).env;
  assert.deepEqual([rental.CODEX_REFRESH_TOKEN_URL_OVERRIDE, rental.CODEX_REVOKE_TOKEN_URL_OVERRIDE], [undefined, undefined]);
});

test("a sandboxed launch that cannot get the agents' home does not start Codex while the owner has saved rules", async () => {
  const project = fixture("project");
  for (const settings of [{ signIn: "replace" as const }, { store: "keyring" }]) {
    const owner = ownerHome();
    const codex = fakeCodex(settings);
    await assert.rejects(
      launchManagedCodexAppServer("ws://127.0.0.1:1", codex.bin, { trustedProjectPath: project, configOverrides: [], env: owner.env, sandboxed: true }),
      /Codex has saved command rules .* So it will not start Codex at this access level\./,
    );
    assert.equal(codex.calls().some((call) => call.args[0] === "mcp" || !call.args.includes("stdio://")), false, "Codex was only asked, never listed or launched");
    assert.equal(existsSync(join(owner.agentHome, "auth.json")), false, "the owner's sign-in was never linked");

    // With no saved rule there is nothing for a command to match, so the launch runs as it did before, with the owner's home.
    const clean = ownerHome({ rules: false });
    const launch = await launchManagedCodexAppServer("ws://127.0.0.1:1", codex.bin, { trustedProjectPath: project, configOverrides: [], env: clean.env, sandboxed: true });
    await waitForExit(launch);
    assert.equal(launch.codexHome, undefined);
    assert.equal(codex.calls().at(-1)!.codexHome, clean.codexHome);
  }
});

test("the agents' home is set for a rental and for an agent with its owner's own setup, after their environments are built", async () => {
  const owner = ownerHome();
  const rental = codexAppServerEnvironment({
    env: { ...owner.env, LETAGENTS_RENTAL_CREDENTIAL_ISOLATION: "1", LETAGENTS_TOKEN: "owner-token-fake" }, codexHome: owner.agentHome,
  });
  assert.equal(rental.rental, true);
  assert.equal(rental.env.CODEX_HOME, owner.agentHome);
  assert.equal(rental.env.LETAGENTS_TOKEN, undefined);
  assert.equal(codexAppServerEnvironment({ env: { ...owner.env, LETAGENTS_RENTAL_CREDENTIAL_ISOLATION: "1" } }).env.CODEX_HOME, undefined, "a rental is given no home but this one");

  const ownerSetup = codexAppServerEnvironment({
    env: { ...owner.env, LETAGENTS_SUPERVISOR_ROOM_ID: "room_fake" }, homeHarness: true, codexHome: owner.agentHome,
  });
  assert.equal(ownerSetup.env.CODEX_HOME, owner.agentHome);
  assert.equal(ownerSetup.env.LETAGENTS_SUPERVISOR_ROOM_ID, undefined);

  // The launch itself: the owner's own setup stays on, and Codex still gets the home without the rules.
  const codex = fakeCodex();
  const project = fixture("project");
  const launch = await launchManagedCodexAppServer("ws://127.0.0.1:1", codex.bin, {
    trustedProjectPath: project, configOverrides: [], env: { ...owner.env, LETAGENTS_SUPERVISOR_ROOM_ID: "room_fake" }, homeHarness: true, sandboxed: true,
  });
  await waitForExit(launch);
  const started = codex.calls().at(-1)!;
  assert.equal(started.codexHome, owner.agentHome);
  assert.equal(started.room, null);
  assert.ok(!started.args.includes("features.plugins=false"), "the owner's extensions are left on");

  // A rental at a sandboxed level: its isolated environment names no Codex home, and the launch still gives it the agents' own.
  const rented = ownerHome();
  const rentalCodex = fakeCodex();
  const rentalLaunch = await launchManagedCodexAppServer("ws://127.0.0.1:1", rentalCodex.bin, {
    trustedProjectPath: project, configOverrides: [], env: { HOME: rented.home, LETAGENTS_RENTAL_CREDENTIAL_ISOLATION: "1" }, sandboxed: true,
  });
  await waitForExit(rentalLaunch);
  assert.equal(rentalLaunch.codexHome, join(rented.home, ".letagents", "codex-agent-home"));
  assert.equal(rentalCodex.calls().at(-1)!.codexHome, rentalLaunch.codexHome);
  assert.deepEqual(readdirSync(join(rentalLaunch.codexHome!, "rules")), []);
});

const spawnRequest = {
  workAttemptId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  roomId: "room_fake",
  agentDisplayName: "FakeAgent",
};

test("the Codex adapter asks for the agents' home at every access level but an exact Full access", async () => {
  const project = fixture("project");
  const cases: Array<{ name: string; sandboxed: boolean; request: Record<string, unknown> }> = [
    { name: "Full access", sandboxed: false, request: { launchPolicy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } } },
    { name: "Full access, named", sandboxed: false, request: { permissionProfileId: "full_access", configurationRevision: 1, launchPolicy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } } },
    { name: "Ask before writes", sandboxed: true, request: { permissionProfileId: "ask_before_write", configurationRevision: 1, launchPolicy: { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } } } },
    { name: "Auto", sandboxed: true, request: { permissionProfileId: "auto_review", configurationRevision: 1,
      launchPolicy: { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" } } },
    { name: "a read-only policy that asks no one", sandboxed: true, request: { launchPolicy: { approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } } } },
  ];
  for (const testCase of cases) {
    const launches: Array<{ sandboxed?: boolean }> = [];
    const adapter = new CodexProviderAdapter({
      codexBin: "codex",
      dependencies: {
        resolveServerUrl: async () => "ws://127.0.0.1:1",
        launchServer: (_url, _bin, options) => { launches.push(options); return { pid: null, exited: Promise.resolve({ type: "exit", code: 0, signal: null }) }; },
        waitForServer: async () => false,
        signalProcess: () => {},
      },
    });
    await assert.rejects(adapter.spawn({ ...spawnRequest, cwd: project, ...testCase.request } as never), /Timed out waiting for Codex app-server/, testCase.name);
    assert.deepEqual(launches.map((launch) => launch.sandboxed === true), [testCase.sandboxed], testCase.name);
  }
});

test("the Codex adapter stops a Codex that says it runs with another home than the one it was given", async () => {
  const project = fixture("project");
  const given = fixture("given-home");
  const signals: string[] = [];
  const closed: string[] = [];
  const spawnWith = (reported: string | null) => new CodexProviderAdapter({
    codexBin: "codex",
    dependencies: {
      resolveServerUrl: async () => "ws://127.0.0.1:1",
      launchServer: () => ({ pid: 4242, exited: new Promise(() => {}), codexHome: given }),
      waitForServer: async () => true,
      signalProcess: (pid, signal) => { signals.push(`${pid} ${signal}`); },
      getProcessIdentity: () => "birth-fake",
      observeProcessExit: () => new Promise(() => {}),
      createRpcClient: () => ({
        connect: async () => {},
        reportedCodexHome: () => reported,
        request: async () => { throw new Error("asked nothing past the home"); },
        close: () => { closed.push("closed"); },
        onDisconnect: () => () => {},
        currentConnectionId: () => "connection-fake",
        listPendingRequests: () => [],
        onPendingRequestsChanged: () => () => {},
        onRequestResolved: () => () => {},
        respond: () => {},
      }),
    },
  }).spawn({ ...spawnRequest, cwd: project, launchPolicy: { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } } } as never);

  await assert.rejects(spawnWith(fixture("owner-home")), /^Error: Codex did not start with the home folder LetAgents gave it for this access level, so LetAgents stopped it\. Check that nothing sets CODEX_HOME for the codex command \(a wrapper script or a shell alias\), update Codex, then start the agent again\.$/);
  assert.deepEqual(signals, ["4242 SIGTERM"]);
  assert.deepEqual(closed, ["closed"]);
  signals.length = 0;
  // The same folder under another name is the same home.
  const alias = join(fixture("alias"), "home");
  symlinkSync(given, alias);
  for (const reported of [given, alias]) {
    await assert.rejects(spawnWith(reported), /asked nothing past the home/);
  }
  // A Codex that does not say is not used at a sandboxed level. Codex 0.153.4 always says.
  await assert.rejects(spawnWith(null), /^Error: Codex did not say which home folder it runs with, so LetAgents cannot tell that your saved command rules stay away from this agent, and stopped it\. Update Codex, then start the agent again\.$/);
});

function installedCodex(): string | null {
  if (process.env.LETAGENTS_SKIP_CODEX_CONTRACT === "1") return null;
  const bin = resolveCodexExecutable();
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 10_000, env: { ...process.env, CODEX_HOME: fixture("version-home") } });
    return bin;
  } catch {
    return null;
  }
}
const realCodex = installedCodex();

test("the installed Codex rewrites a linked sign-in file in place when it refreshes it", {
  skip: realCodex ? false : "Codex is not installed",
  timeout: 60_000,
}, async () => {
  const parent = fixture("beside-the-agents-home");
  assert.equal(await checkCodexKeepsLinkedSignIn(realCodex!, { PATH: process.env.PATH }, parent), true);
  assert.deepEqual(readdirSync(parent), []);
});

test("the installed Codex names the machine's own config folder as a layer, and its rules folder is one a sandboxed launch looks in", {
  skip: realCodex && process.platform !== "win32" ? false : "Codex is not installed",
  timeout: 60_000,
}, async () => {
  const owner = ownerHome({ rules: false });
  const inspection = await inspectCodexSettings(realCodex!, { cwd: fixture("project"), env: { PATH: process.env.PATH, ...owner.env }, configOverrides: [] });
  assert.equal(inspection.credentialStore, "file");
  assert.deepEqual(inspection.projectLayers, []);
  // The system layer is listed whether its file is there or not. Codex names no file for the layers a device manager or the cloud sends.
  assert.ok(inspection.otherRuleFolders.includes(join("/etc/codex", "rules")), JSON.stringify(inspection.otherRuleFolders));
  assert.ok(!inspection.otherRuleFolders.some((folder) => folder.startsWith(owner.codexHome)), "the user's own layer is the home, which the launch replaces");
});

type ModelItem = Record<string, unknown>;
/** A stand-in model service on this machine, so a turn needs no sign-in. `plan` holds one answer for each model request. */
async function stubModel(): Promise<{ port: number; plan: Array<() => ModelItem[]>; requests: Array<Record<string, unknown>>; others: string[]; close(): void }> {
  const plan: Array<() => ModelItem[]> = [];
  const requests: Array<Record<string, unknown>> = [];
  /** Every other address that was asked for here: a command that reached the network asks for one. */
  const others: string[] = [];
  const server = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (request.method !== "POST" || !String(request.url).endsWith("/responses")) {
        others.push(String(request.url));
        response.statusCode = 404;
        response.end("{}");
        return;
      }
      requests.push(JSON.parse(body) as Record<string, unknown>);
      const id = `resp_${requests.length}`;
      const items = plan.shift()?.() ?? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "nothing planned" }] }];
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: Record<string, unknown>) => response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: "response.created", response: { id } });
      for (const item of items) send({ type: "response.output_item.done", item });
      send({ type: "response.completed", response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { port: (server.address() as { port: number }).port, plan, requests, others, close: () => server.close() };
}

test("the installed Codex lets a saved rule's command out of its sandbox with the owner's home and not with the agents' home, and each home resumes the other's conversation", {
  skip: realCodex ? false : "Codex is not installed",
  timeout: 180_000,
}, async (t) => {
  const model = await stubModel();
  t.after(() => model.close());
  const owner = ownerHome();
  const workspace = fixture("workspace");
  writeFileSync(join(owner.codexHome, "config.toml"), [
    'model = "stand-in"', 'model_provider = "standin"', "",
    "[model_providers.standin]", 'name = "standin"', `base_url = "http://127.0.0.1:${model.port}/v1"`,
    'wire_api = "responses"', "requires_openai_auth = false", "supports_websockets = false", "",
  ].join("\n"));
  writeFileSync(join(owner.codexHome, "AGENTS.md"), "OWNER-INSTRUCTIONS-MARKER\n");
  execFileSync("rm", [join(owner.codexHome, "auth.json")]);
  const baseEnv = { PATH: process.env.PATH, HOME: owner.home, TMPDIR: fixture("tmp") };
  const readOnly = { approvalPolicy: "never", sandbox: "read-only" };
  const overrides = ["features.plugins=false", "features.apps=false", "features.memories=false", "analytics.enabled=false"];

  type Ask = (method: string, params: unknown) => Promise<unknown>;
  const thread = (answer: unknown) => (answer as { thread: { id: string; turns?: unknown[] } }).thread;
  /** Start the installed Codex with one home, ask it things over its own protocol, and stop it. */
  const withCodex = async <T>(codexHome: string, use: (ask: Ask, turnEnded: () => Promise<void>) => Promise<T>): Promise<T> => {
    const child = spawn(realCodex!, ["app-server", ...overrides.flatMap((override) => ["-c", override]), "--listen", "stdio://"], {
      cwd: workspace, env: { ...baseEnv, CODEX_HOME: codexHome }, stdio: ["pipe", "pipe", "ignore"],
    });
    const answers = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    let turnEnds: Array<() => void> = [];
    let serial = 0;
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as { id?: number; method?: string; result?: unknown; error?: { message?: string } };
      if (message.method === "turn/completed") turnEnds.splice(0).forEach((ended) => ended());
      if (typeof message.id !== "number" || message.method) return;
      const answer = answers.get(message.id);
      answers.delete(message.id);
      if (message.error) answer?.reject(new Error(String(message.error.message)));
      else answer?.resolve(message.result);
    });
    const ask: Ask = (method, params) => new Promise((resolve, reject) => {
      answers.set(++serial, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id: serial, method, params })}\n`);
    });
    try {
      await ask("initialize", { clientInfo: { name: "letagents-test", title: "test", version: "1" }, capabilities: { experimentalApi: true } });
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      return await use(ask, () => new Promise<void>((resolve) => { turnEnds.push(resolve); }));
    } finally {
      turnEnds = [];
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  };
  /** One turn in which the model runs `touch <marker>`; resolves once Codex has ended the turn. */
  const touchTurn = async (ask: Ask, turnEnded: () => Promise<void>, threadId: string, marker: string) => {
    model.plan.push(
      () => [{ type: "function_call", call_id: `call_${model.requests.length}`, name: "exec_command", arguments: JSON.stringify({ cmd: `touch ${marker}`, login: false }) }],
      () => [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
    );
    const ended = turnEnded();
    await ask("turn/start", { threadId, input: [{ type: "text", text: "Run the command." }] });
    await ended;
    assert.equal(model.plan.length, 0, "the model was asked for the command and for its last word");
  };

  // With the owner's home the saved rule applies: the command writes in a read-only sandbox.
  const byRule = join(workspace, "written-with-the-owner-home");
  const first = await withCodex(owner.codexHome, async (ask, turnEnded) => {
    const id = thread(await ask("thread/start", { cwd: workspace, ...readOnly, historyMode: "legacy" })).id;
    await touchTurn(ask, turnEnded, id, byRule);
    return id;
  });
  assert.equal(existsSync(byRule), true, "the saved rule let the command out of the sandbox");

  // The launch's own decision, asked of the installed Codex: its sign-in store is a file and is rewritten in place.
  const { codexHome: agentHome } = await codexHomeForSandboxedLaunch(realCodex!, { cwd: workspace, env: { ...baseEnv, CODEX_HOME: owner.codexHome } });
  assert.equal(agentHome, owner.agentHome);

  // With the agents' home the same command stays in the sandbox, in the owner's conversation, under the owner's settings.
  const sandboxedMarker = join(workspace, "written-with-the-agents-home");
  const requestsBefore = model.requests.length;
  const second = await withCodex(agentHome!, async (ask, turnEnded) => {
    assert.equal(thread(await ask("thread/resume", { threadId: first, cwd: workspace, ...readOnly })).turns?.length, 1, "the owner's conversation resumes with its turn");
    await touchTurn(ask, turnEnded, first, sandboxedMarker);
    const id = thread(await ask("thread/start", { cwd: workspace, ...readOnly, historyMode: "legacy" })).id;
    await touchTurn(ask, turnEnded, id, sandboxedMarker);
    return id;
  });
  assert.equal(existsSync(sandboxedMarker), false, "no rule applies, so the command stayed in the read-only sandbox");
  const sent = JSON.stringify(model.requests.slice(requestsBefore));
  assert.match(sent, /Operation not permitted|Read-only file system|ermission denied/, "the model was told the command was blocked");
  assert.match(sent, /OWNER-INSTRUCTIONS-MARKER/, "the owner's instructions still reach the model");
  assert.equal(model.requests.at(-1)!.model, "stand-in", "the owner's config still chooses the model");

  // Nothing is kept apart from the owner's home: every entry is a link, and both conversations are the owner's files.
  assert.deepEqual(entries(agentHome!).filter((entry) => !entry.endsWith("@")), ["rules/"]);
  assert.deepEqual(readdirSync(join(agentHome!, "rules")), []);
  const rollouts = readdirSync(join(owner.codexHome, "sessions"), { recursive: true }).map(String).filter((name) => name.endsWith(".jsonl"));
  assert.equal(rollouts.filter((name) => name.includes(first) || name.includes(second)).length, 2);
  assert.equal(readFileSync(join(owner.codexHome, "rules", "default.rules"), "utf8"), ALLOW_RULE);

  // Back with the owner's home, as an agent given Full access again: both conversations resume.
  await withCodex(owner.codexHome, async (ask) => {
    assert.equal(thread(await ask("thread/resume", { threadId: first, cwd: workspace, ...readOnly })).turns?.length, 2);
    assert.equal(thread(await ask("thread/resume", { threadId: second, cwd: workspace, ...readOnly })).turns?.length, 1);
  });
});

async function freeLoopbackUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `ws://127.0.0.1:${port}`;
}

test("the installed Codex, started by a managed launch at a sandboxed access level, says it runs with the agents' home", {
  skip: realCodex ? false : "Codex is not installed",
  timeout: 120_000,
}, async (t) => {
  const owner = ownerHome();
  execFileSync("rm", [join(owner.codexHome, "auth.json")]);
  writeFileSync(join(owner.codexHome, "config.toml"), "");
  const project = fixture("project");
  const serverUrl = await freeLoopbackUrl();
  const launch = await launchManagedCodexAppServer(serverUrl, realCodex!, { trustedProjectPath: project, configOverrides: [], env: owner.env, sandboxed: true });
  const client = new CodexRpcClient(serverUrl);
  t.after(async () => {
    client.close();
    if (launch.pid !== null) terminateSpawnedProcess(launch.pid);
    await waitForExit(launch);
  });
  assert.equal(launch.codexHome, owner.agentHome);
  assert.equal(await waitForLaunchedCodexAppServer(serverUrl, launch), true);
  await client.connect();
  assert.equal(realpathSync(client.reportedCodexHome()!), realpathSync(owner.agentHome));
});

test("a sandboxed launch is refused while the machine's own Codex config folder holds a command rule", async () => {
  const machine = fixture("machine-codex");
  mkdirSync(join(machine, "rules"));
  const withFolder = { ...noProject, otherRuleFolders: [join(machine, "rules")] };
  const owner = ownerHome({ rules: false });
  const deps = { inspect: async () => withFolder, keepsLinkedSignIn: async () => true };
  assert.deepEqual(await codexHomeForSandboxedLaunch("codex", { env: owner.env }, deps), useAgentsHome(owner.agentHome), "an empty rules folder holds no rule");

  writeFileSync(join(machine, "rules", "site.rules"), ALLOW_RULE);
  const refused = ownerHome({ rules: false });
  await assert.rejects(codexHomeForSandboxedLaunch("codex", { env: refused.env }, deps), (error: Error) => {
    assert.equal(error.message,
      `Codex also reads command rules from ${join(machine, "rules")}, a folder of this computer's own Codex settings that applies to every Codex on it, and that folder is not empty (site.rules). `
      + "LetAgents does not read the files in it. If one of them allows a command, a sandboxed Codex agent runs that command with no sandbox and no approval. "
      + "So LetAgents starts no Codex agent at a sandboxed access level on this computer while that folder holds anything. "
      + "Only someone who may change that folder can empty it: on a computer that your organization manages, that is its administrator. "
      + "Until then, give this agent Full access if you accept that.");
    return true;
  });
  assert.equal(existsSync(refused.agentHome), false, "nothing is linked for a launch that is refused");
  // A folder in the user's own home is named from there.
  const inHome = join(process.env.HOME!, "codex-defaults", "rules");
  assert.throws(() => assertLayersAddNoCommandRules(undefined, { projectLayers: [], otherRuleFolders: [inHome] }, () => [join(inHome, "x.rules")]),
    /^Error: Codex also reads command rules from ~\/codex-defaults\/rules, a folder of this computer's own Codex settings/);

  // What Codex reports is what is looked in: every applied layer with a file, but the user's own and the project's.
  const layers = [
    { name: { type: "user", file: join(owner.codexHome, "config.toml") }, config: {} },
    { name: { type: "system", file: join(machine, "config.toml") }, config: {} },
    { name: { type: "legacyManagedConfigTomlFromFile", file: join(machine, "managed_config.toml") }, config: {} },
    { name: { type: "packagedDefaults", file: join(fixture("packaged"), "config.toml") }, config: {}, disabledReason: "not used" },
    { name: { type: "mdm", domain: "com.example", key: "config" }, config: {} },
    { name: { type: "sessionFlags" }, config: {} },
  ];
  const reported = await inspectCodexSettings(fakeCodex({ layers }).bin, { cwd: fixture("project"), env: { PATH: process.env.PATH, ...owner.env }, configOverrides: [] });
  assert.deepEqual(reported.otherRuleFolders, [join(machine, "rules")]);
});

test("a home that holds anything of its own is asked about again as the agents' home, and what Codex kept there is said, never deleted", async () => {
  const owner = ownerHome({ rules: false });
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  execFileSync("rm", [join(owner.agentHome, "config.toml")]);
  writeFileSync(join(owner.agentHome, "config.toml"), 'model = "a-copy"\n');
  const asked: Array<string | undefined> = [];
  const answers: Array<typeof noProject> = [];
  const deps = {
    inspect: async (_bin: string, options: { env: NodeJS.ProcessEnv }) => { asked.push(options.env.CODEX_HOME); return answers.shift() ?? noProject; },
    keepsLinkedSignIn: async () => true,
  };

  const kept = await codexHomeForSandboxedLaunch("codex", { env: owner.env }, deps);
  assert.deepEqual(asked, [owner.codexHome, owner.agentHome], "once as the owner's home, once as the home the launch will use");
  assert.equal(kept.codexHome, owner.agentHome);
  assert.deepEqual(kept.notices, [
    "The folder LetAgents keeps for sandboxed Codex agents (codex-agent-home in your .letagents folder) holds entries of its own with the same names as entries of your Codex home: config.toml. "
    + "That happens when a sandboxed agent's Codex makes an entry before your Codex home has it, for example the first time after a Codex update adds one. "
    + "Sandboxed agents use those, not yours, so they do not see what you or your own Codex later put in yours. "
    + "LetAgents never deletes them, because they can hold conversations; an empty one it replaces with a link to yours by itself. "
    + "To use your own again, stop the sandboxed Codex agents and delete those entries from that folder.",
  ]);
  assert.equal(readFileSync(join(owner.agentHome, "config.toml"), "utf8"), 'model = "a-copy"\n');

  // Its own config trusts a project that ships rules: the owner's home did not, so only the second answer shows it.
  const project = fixture("project");
  mkdirSync(join(project, ".codex", "rules"), { recursive: true });
  writeFileSync(join(project, ".codex", "rules", "allow.rules"), ALLOW_RULE);
  mkdirSync(join(project, "inner"));
  answers.push(noProject, { ...noProject, projectLayers: [{ dotCodexFolder: join(project, ".codex"), config: {} }] } as typeof noProject);
  // The project is no repository, and the rules are in a folder above the agent's: only Codex's own answer names that folder.
  await assert.rejects(codexHomeForSandboxedLaunch("codex", { cwd: join(project, "inner"), env: owner.env }, deps), (error: Error) => error.message.startsWith("Codex reads command rules from "));

  // Its own config moves the sign-in: a refreshed token would be saved apart from the owner's file.
  answers.push(noProject, { ...noProject, credentialStore: "keyring" });
  await assert.rejects(codexHomeForSandboxedLaunch("codex", { env: owner.env }, deps), (error: Error) => {
    assert.equal(error.message,
      "The folder LetAgents keeps for sandboxed Codex agents (codex-agent-home in your .letagents folder) has settings of its own that move Codex's sign-in out of its home folder. "
      + "A second place for the sign-in can sign you out of Codex, so LetAgents will not start a sandboxed Codex agent. "
      + "Stop the sandboxed Codex agents, delete config.toml in that folder, and start the agent again.");
    return true;
  });

  // A home that is the owner's files and nothing else is asked about once.
  asked.length = 0;
  const pure = ownerHome({ rules: false });
  assert.deepEqual(await codexHomeForSandboxedLaunch("codex", { env: pure.env }, deps), useAgentsHome(pure.agentHome));
  assert.deepEqual(asked, [pure.codexHome]);
});

test("a running sandboxed Codex may start or load a conversation only when nothing it would read holds a command rule", async () => {
  const owner = ownerHome({ rules: false });
  const project = fixture("project");
  const asked: Array<{ cwd: string; codexHome: string | undefined }> = [];
  let answer = noProject;
  const deps = { inspect: async (_bin: string, options: { cwd: string; env: NodeJS.ProcessEnv }) => { asked.push({ cwd: options.cwd, codexHome: options.env.CODEX_HOME }); return answer; } };
  const refusal = (codexHome: string | null) => sandboxedCodexLoadRefusal("codex", { cwd: project, codexHome, env: { ...owner.env, CODEX_HOME: "/another/home" } }, deps);

  assert.equal(await refusal(owner.codexHome), null);
  assert.deepEqual(asked, [{ cwd: project, codexHome: owner.codexHome }], "Codex is asked with the home the process runs with, in the agent's folder");

  // The project gained a rules folder since the launch, for example through a pull. Codex is not even asked: trusted or not, it is refused.
  mkdirSync(join(project, ".codex", "rules"), { recursive: true });
  writeFileSync(join(project, ".codex", "rules", "allow.rules"), ALLOW_RULE);
  asked.length = 0;
  assert.equal(await refusal(owner.codexHome), projectRulesRefusal(".codex/rules", "allow.rules"));
  assert.deepEqual(asked, []);
  execFileSync("rm", ["-r", join(project, ".codex")]);
  // A rule folder only Codex's own answer names, as when the owner's settings put the top of the project elsewhere.
  const elsewhere = fixture("elsewhere");
  mkdirSync(join(elsewhere, ".codex", "rules"), { recursive: true });
  writeFileSync(join(elsewhere, ".codex", "rules", "allow.rules"), ALLOW_RULE);
  answer = { ...noProject, projectLayers: [{ dotCodexFolder: join(elsewhere, ".codex"), config: {} }] } as typeof noProject;
  assert.match((await refusal(owner.codexHome))!, /^Codex reads command rules from .*\.codex[\\/]rules in this agent's work folder once it trusts the project, and that folder is not empty \(allow\.rules\)\./);
  answer = noProject;

  // The owner saved a rule in the home this process runs with: nothing more needs asking.
  asked.length = 0;
  mkdirSync(join(owner.codexHome, "rules"));
  writeFileSync(join(owner.codexHome, "rules", "default.rules"), ALLOW_RULE);
  const HOME_HAS_RULES = "This agent's Codex runs with a home folder that holds saved command rules, and a command that matches one runs outside its sandbox. "
    + "So LetAgents gives it no work. Pause the agent and resume it: it then starts with a home folder without those rules.";
  assert.equal(await refusal(owner.codexHome), HOME_HAS_RULES);
  assert.equal(sandboxedCodexHomeRefusal(owner.codexHome), HOME_HAS_RULES);
  assert.deepEqual(asked, []);
  assert.equal(sandboxedCodexHomeRefusal(null),
    "Codex did not say which home folder it runs with, so LetAgents cannot tell that saved command rules stay away from this agent, and gives it no work. "
    + "Update Codex, then pause the agent and resume it.");
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  assert.equal(sandboxedCodexHomeRefusal(owner.agentHome), null, "the agents' home never holds one");

  // A Codex that cannot be asked is a refusal, never a yes.
  assert.match((await sandboxedCodexLoadRefusal("codex", { cwd: project, codexHome: owner.agentHome, env: owner.env }, { inspect: async () => { throw new Error("Codex did not answer in time"); } }))!,
    /^Codex did not answer when LetAgents asked for its settings \(Codex did not answer in time\)/);
});

/** Where every link of an agents' home leads. */
function linkTargets(agentHome: string): Record<string, string> {
  return Object.fromEntries(readdirSync(agentHome).filter((name) => lstatSync(join(agentHome, name)).isSymbolicLink()).sort()
    .map((name) => [name, readlinkSync(join(agentHome, name))]));
}

/** A second Codex home of the same user, as an owner who sets CODEX_HOME has. */
function customCodexHome(): string {
  const codexHome = fixture("custom-codex-home");
  mkdirSync(join(codexHome, "sessions"));
  writeFileSync(join(codexHome, "auth.json"), '{"pretend":"another sign-in"}\n', { mode: 0o600 });
  writeFileSync(join(codexHome, "config.toml"), 'model = "custom-model"\n');
  return codexHome;
}

test("each owner Codex home has an agents' home of its own: the usual one keeps its name, and a launch for one never changes the links of another", async () => {
  const owner = ownerHome();
  const custom = customCodexHome();
  const usualAgents = join(owner.home, ".letagents", "codex-agent-home");
  const customAgents = join(owner.home, ".letagents", `codex-agent-home-${createHash("sha256").update(custom).digest("hex").slice(0, 12)}`);

  // The usual home keeps the usual folder, named or not. Another home is named by its real path, under any name it is reached by.
  assert.equal(owner.agentHome, usualAgents);
  assert.equal(codexAgentHomeDirectory({ HOME: owner.home }), usualAgents);
  assert.equal(codexAgentHomeDirectory({ HOME: owner.home, CODEX_HOME: owner.codexHome }), usualAgents);
  assert.equal(codexAgentHomeDirectory({ HOME: owner.home, CODEX_HOME: custom }), customAgents);
  const alias = join(fixture("alias"), "codex");
  symlinkSync(custom, alias);
  assert.equal(codexAgentHomeDirectory({ HOME: owner.home, CODEX_HOME: alias }), customAgents, "two names for one home give one folder");
  assert.equal(codexAgentHomeDirectory({ HOME: owner.home, CODEX_HOME: `${custom}/` }), customAgents);
  const notThereYet = join(fixture("later"), "codex");
  assert.match(codexAgentHomeDirectory({ HOME: owner.home, CODEX_HOME: notThereYet }), /[\\/]codex-agent-home-[0-9a-f]{12}$/);
  assert.equal(codexAgentHomeDirectory({ HOME: owner.home, CODEX_HOME: notThereYet }), codexAgentHomeDirectory({ HOME: owner.home, CODEX_HOME: notThereYet }));
  assert.notEqual(codexAgentHomeDirectory({ HOME: owner.home, CODEX_HOME: notThereYet }), customAgents);

  const project = fixture("project");
  const launch = async (env: Record<string, string>) => {
    const codex = fakeCodex();
    const started = await launchManagedCodexAppServer("ws://127.0.0.1:1", codex.bin, { trustedProjectPath: project, configOverrides: [], env, sandboxed: true });
    await waitForExit(started);
    assert.equal(codex.calls().at(-1)!.codexHome, started.codexHome, "Codex was started with the home the launch names");
    return started.codexHome;
  };
  // An owner who sets CODEX_HOME, an agent with the usual home, and a rental, which is given no CODEX_HOME at all.
  assert.equal(await launch({ HOME: owner.home, CODEX_HOME: custom }), customAgents);
  const customLinks = linkTargets(customAgents);
  assert.deepEqual(customLinks, { "auth.json": join(custom, "auth.json"), "config.toml": join(custom, "config.toml"), sessions: join(custom, "sessions") });
  assert.equal(await launch({ HOME: owner.home }), usualAgents);
  const usualLinks = linkTargets(usualAgents);
  assert.ok(Object.values(usualLinks).every((target) => target.startsWith(`${owner.codexHome}/`)));
  assert.equal(await launch({ HOME: owner.home, CODEX_HOME: custom, LETAGENTS_RENTAL_CREDENTIAL_ISOLATION: "1" }), usualAgents, "a rental reads the usual home, so it gets that home's folder");
  assert.equal(await launch({ HOME: owner.home, CODEX_HOME: custom }), customAgents);
  assert.deepEqual(linkTargets(customAgents), customLinks, "no launch for the usual home turned these links");
  assert.deepEqual(linkTargets(usualAgents), usualLinks, "and no launch for the other home turned those");
  assert.deepEqual(readdirSync(join(owner.home, ".letagents")).sort(), [basename(usualAgents), basename(customAgents)].sort(), "the sign-in check ran beside them and left nothing");
});

test("an agents' home whose links lead into another Codex home is never turned to this one under an agent: the launch is refused and the folder is left as it was", async () => {
  const owner = ownerHome({ rules: false });
  const other = customCodexHome();
  // A folder made before each owner home had one of its own: the usual folder, linked to the other home.
  linkCodexAgentHome(other, owner.agentHome);
  const before = linkTargets(owner.agentHome);
  const REFUSED = "The folder LetAgents keeps for sandboxed Codex agents (codex-agent-home in your .letagents folder) is linked to another Codex home than the one this agent uses. "
    + "LetAgents does not change its links while an agent may be running with them, so it will not start a sandboxed Codex agent. "
    + "Pause every sandboxed Codex agent, delete that folder, and resume the agents: LetAgents makes it again. ";
  assert.throws(() => linkCodexAgentHome(owner.codexHome, owner.agentHome), (error: Error) => {
    assert.ok(error instanceof CodexAgentHomeError && !(error instanceof CodexAgentHomeSignInError));
    assert.equal(error.message, `${REFUSED}It holds only links, so nothing of yours is deleted with it.`);
    return true;
  });
  assert.deepEqual(linkTargets(owner.agentHome), before);

  // The launch says the same, and does not fall back to the owner's home although that home holds no saved rule.
  const deps = { inspect: async () => noProject, keepsLinkedSignIn: async () => true };
  writeFileSync(join(owner.agentHome, "made-here.json"), "{}");
  await assert.rejects(codexHomeForSandboxedLaunch("codex", { env: owner.env }, deps), (error: Error) => {
    assert.ok(error instanceof CodexAgentHomeError);
    assert.equal(error.message, `${REFUSED}Besides links, the folder holds made-here.json: keep a copy if you need them.`);
    return true;
  });
  assert.deepEqual(linkTargets(owner.agentHome), before);
  assert.equal(existsSync(join(owner.agentHome, "made-here.json")), true);

  // One link that leads elsewhere is enough: nobody can say which agent runs with it.
  const mixed = ownerHome({ rules: false });
  linkCodexAgentHome(mixed.codexHome, mixed.agentHome);
  execFileSync("ln", ["-sfn", join(other, "config.toml"), join(mixed.agentHome, "config.toml")]);
  assert.throws(() => linkCodexAgentHome(mixed.codexHome, mixed.agentHome), CodexAgentHomeError);
  assert.equal(readlinkSync(join(mixed.agentHome, "config.toml")), join(other, "config.toml"));

  // The owner does what the words say: the folder is made again, for this home.
  execFileSync("rm", ["-rf", owner.agentHome]);
  assert.deepEqual(await codexHomeForSandboxedLaunch("codex", { env: owner.env }, deps), useAgentsHome(owner.agentHome));
  assert.ok(Object.values(linkTargets(owner.agentHome)).every((target) => target.startsWith(`${owner.codexHome}/`)));
  assert.equal(readFileSync(join(other, "auth.json"), "utf8"), '{"pretend":"another sign-in"}\n', "the other home's files were only ever linked");
});

test("a sandboxed Codex is not started, and loads no conversation, in a project that has command rules of its own, whether Codex trusts the project or not", async () => {
  const above = fixture("above");
  const project = join(above, "project");
  const cwd = join(project, "packages", "app");
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(project, "packages", "other"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: project });
  const rules = (folder: string, name = "allow.rules") => {
    mkdirSync(join(folder, ".codex", "rules"), { recursive: true });
    writeFileSync(join(folder, ".codex", "rules", name), ALLOW_RULE);
    return () => execFileSync("rm", ["-r", join(folder, ".codex")]);
  };
  // The folders Codex 0.153.4 reads a project's rules from: the agent's own and each one above it up to the top of the repository.
  assert.deepEqual(projectRuleFolders(cwd), [cwd, join(project, "packages"), project].map((folder) => join(folder, ".codex", "rules")));
  const plain = fixture("no-repository");
  assert.deepEqual(projectRuleFolders(join(plain, "not-there-yet")), [join(plain, "not-there-yet", ".codex", "rules")], "with no repository, the folder's own only");

  const owner = ownerHome({ rules: false });
  const asked: string[] = [];
  const untrusted = { inspect: async () => { asked.push("codex"); return noProject; }, keepsLinkedSignIn: async () => true };
  const trusted = { ...untrusted, inspect: async () => { asked.push("codex"); return { ...noProject, projectLayers: [project, join(project, "packages"), cwd].map((folder) => ({ dotCodexFolder: join(folder, ".codex"), config: {} })) }; } };
  type Deps = NonNullable<Parameters<typeof codexHomeForSandboxedLaunch>[2]>;
  const launch = (deps: Deps) => codexHomeForSandboxedLaunch("codex", { cwd, env: owner.env }, deps);
  const load = (deps: Deps) => sandboxedCodexLoadRefusal("codex", { cwd, codexHome: owner.codexHome, env: owner.env }, deps);

  // Nothing in the way: no .codex at all, an empty rules folder, and rules where Codex does not read them.
  mkdirSync(join(project, ".codex", "rules"), { recursive: true });
  const notRead = [rules(above), rules(join(project, "packages", "other")), rules(join(cwd, "src"))];
  for (const deps of [untrusted, trusted] as Deps[]) {
    assert.deepEqual(await launch(deps), useAgentsHome(owner.agentHome));
    assert.equal(await load(deps), null);
  }
  assert.equal(sandboxedCodexProjectRefusal(cwd), null);
  for (const remove of notRead) remove();

  // A rules folder with anything in it, at each place Codex reads: in the repository or only on this disk makes no difference.
  for (const [folder, shown, name] of [[project, ".codex/rules", "allow.rules"], [join(project, "packages"), "packages/.codex/rules", "README.md"], [cwd, "packages/app/.codex/rules", ".hidden"]] as const) {
    const remove = rules(folder, name);
    const refusal = projectRulesRefusal(shown, name);
    for (const deps of [untrusted, trusted] as Deps[]) {
      asked.length = 0;
      await assert.rejects(launch(deps), (error: Error) => { assert.equal(error.message, refusal); return true; });
      assert.equal(await load(deps), refusal);
      assert.deepEqual(asked, [], "Codex is not asked whether it trusts the project: the folder is enough");
    }
    assert.equal(sandboxedCodexProjectRefusal(cwd), refusal);
    remove();
  }
  assert.equal(sandboxedCodexProjectRefusal(null),
    "Codex did not say which folder this agent works in, so LetAgents cannot look for command rules in its project, and gives it no work. Pause the agent and resume it.");
});

/** A work folder two folders below `inner`, which is below `outer`, a real repository. Each folder has rules of its own. `git` makes what `inner` has as its `.git`. */
function nestedProject(git: (inner: string) => void): { outer: string; inner: string; work: string; all: string[] } {
  const outer = join(fixture("nested"), "outer");
  const inner = join(outer, "mid", "inner");
  const work = join(inner, "packages", "work");
  mkdirSync(work, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: outer });
  const all = [work, join(inner, "packages"), inner, join(outer, "mid"), outer];
  for (const folder of all) {
    mkdirSync(join(folder, ".codex", "rules"), { recursive: true });
    writeFileSync(join(folder, ".codex", "rules", "allow.rules"), ALLOW_RULE);
  }
  git(inner);
  return { outer, inner, work, all };
}
/** What `.git` can be, and whether Codex 0.153.4 takes its folder as the top of a repository. */
const GIT_KINDS: Array<{ name: string; top: boolean; make(inner: string): void }> = [
  { name: "a real repository", top: true, make: (inner) => { execFileSync("git", ["init", "-q"], { cwd: inner }); } },
  { name: "a worktree's .git file", top: true, make: (inner) => writeFileSync(join(inner, ".git"), "gitdir: /nowhere/at/all\n") },
  { name: "an empty .git file", top: true, make: (inner) => writeFileSync(join(inner, ".git"), "") },
  { name: "a .git folder that holds only HEAD", top: true, make: (inner) => { mkdirSync(join(inner, ".git")); writeFileSync(join(inner, ".git", "HEAD"), "ref: refs/heads/main\n"); } },
  { name: "an empty .git folder", top: false, make: (inner) => mkdirSync(join(inner, ".git")) },
  { name: "a .git folder without HEAD", top: false, make: (inner) => { mkdirSync(join(inner, ".git", "objects"), { recursive: true }); writeFileSync(join(inner, ".git", "config"), ""); } },
  { name: "a .git link that leads nowhere", top: false, make: (inner) => symlinkSync(join(inner, "nowhere"), join(inner, ".git")) },
  { name: "no .git at all", top: false, make: () => {} },
  // HEAD only has to be there, with its links followed: a folder counts, a link that leads nowhere does not.
  { name: "a .git folder whose HEAD is a folder", top: true, make: (inner) => mkdirSync(join(inner, ".git", "HEAD"), { recursive: true }) },
  { name: "a .git folder whose HEAD is a link to a folder", top: true, make: (inner) => { mkdirSync(join(inner, ".git")); mkdirSync(join(inner, "elsewhere")); symlinkSync(join(inner, "elsewhere"), join(inner, ".git", "HEAD")); } },
  { name: "a .git folder whose HEAD is a link to a file", top: true, make: (inner) => { mkdirSync(join(inner, ".git")); writeFileSync(join(inner, "a-file"), "x"); symlinkSync(join(inner, "a-file"), join(inner, ".git", "HEAD")); } },
  { name: "a .git folder whose HEAD is a link that leads nowhere", top: false, make: (inner) => { mkdirSync(join(inner, ".git")); symlinkSync(join(inner, "nowhere"), join(inner, ".git", "HEAD")); } },
  { name: "a .git link to a folder with HEAD", top: true, make: (inner) => { mkdirSync(join(inner, "elsewhere")); writeFileSync(join(inner, "elsewhere", "HEAD"), "x"); symlinkSync(join(inner, "elsewhere"), join(inner, ".git")); } },
  { name: "a .git link to an empty folder", top: false, make: (inner) => { mkdirSync(join(inner, "elsewhere")); symlinkSync(join(inner, "elsewhere"), join(inner, ".git")); } },
  { name: "a .git link to a file", top: true, make: (inner) => { writeFileSync(join(inner, "a-file"), "gitdir: x\n"); symlinkSync(join(inner, "a-file"), join(inner, ".git")); } },
];

test("the walk for a project's rule folders stops where Codex stops: an empty .git folder or a dangling .git link is no repository top, and the walk reads on above it", () => {
  for (const kind of GIT_KINDS) {
    const project = nestedProject(kind.make);
    const expected = kind.top ? project.all.slice(0, 3) : project.all;
    assert.deepEqual(projectRuleFolders(project.work), expected.map((folder) => join(folder, ".codex", "rules")), kind.name);
  }
  // What sits above a folder that is no top is found, and named from the top Codex takes.
  const above = nestedProject((inner) => mkdirSync(join(inner, ".git")));
  for (const folder of above.all.slice(0, 4)) execFileSync("rm", ["-r", join(folder, ".codex")]);
  assert.equal(projectCommandRulesRefusal(above.work), projectRulesRefusal(".codex/rules", "allow.rules"));
  // A .git that cannot be looked at is no top either: the walk goes on, never short.
  const locked = nestedProject((inner) => { mkdirSync(join(inner, ".git")); writeFileSync(join(inner, ".git", "HEAD"), "x"); chmodSync(join(inner, ".git"), 0o000); });
  try {
    assert.equal(projectRuleFolders(locked.work).length, 5);
  } finally {
    chmodSync(join(locked.inner, ".git"), 0o700);
  }
});

test("the installed Codex applies exactly the project layers the walk names, for every kind of .git", {
  skip: realCodex ? false : "Codex is not installed",
  timeout: 180_000,
}, async () => {
  for (const kind of GIT_KINDS) {
    const project = nestedProject(kind.make);
    const owner = ownerHome({ rules: false });
    // Every folder is trusted, so only where Codex puts the top of the project decides what it reads.
    writeFileSync(join(owner.codexHome, "config.toml"), project.all.map((folder) => `[projects.${JSON.stringify(folder)}]\ntrust_level = "trusted"\n`).join(""));
    const inspection = await inspectCodexSettings(realCodex!, { cwd: project.work, env: { PATH: process.env.PATH, ...owner.env }, configOverrides: [] });
    assert.deepEqual(inspection.projectLayers.map((layer) => join(layer.dotCodexFolder, "rules")).sort(), projectRuleFolders(project.work).sort(), kind.name);
  }
});

test("the refusal for a project's rule folder says only what is known: the folder is not empty, it is in the agent's own work folder, and what an allow rule there would do", () => {
  const project = fixture("project");
  mkdirSync(join(project, ".git"));
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(project, ".codex", "rules"), { recursive: true });
  // A README is no rule, and LetAgents does not read it: the words must hold for it too.
  writeFileSync(join(project, ".codex", "rules", "README.md"), "nothing here allows a command\n");
  const refusal = projectCommandRulesRefusal(project)!;
  assert.equal(refusal, projectRulesRefusal(".codex/rules", "README.md"));
  assert.ok(!/every command that matches|has command rules/.test(refusal), "nothing is said about what the files hold");
  // More entries than are shown are not counted: the folder is not listed to its end.
  for (const name of ["a.rules", "b.rules", "c.rules", "d.rules"]) writeFileSync(join(project, ".codex", "rules", name), ALLOW_RULE);
  assert.match(projectCommandRulesRefusal(project)!, /and that folder is not empty \((?:[A-Za-z.]+, ){2}[A-Za-z.]+ and more\)\./);

  // An agent whose repository top is the folder that holds the owner's Codex home: the folder is the owner's saved rules, and is called that.
  const owner = ownerHome();
  mkdirSync(join(owner.home, ".git"));
  writeFileSync(join(owner.home, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(owner.home, "work", "here"), { recursive: true });
  assert.equal(projectCommandRulesRefusal(join(owner.home, "work", "here"), undefined, undefined, join(owner.codexHome, "rules")), savedRulesAsProjectRefusal("default.rules"));
});

test("a rules folder is read no further than its first entries, whatever its size", () => {
  const folder = fixture("many");
  for (let index = 0; index < 40; index += 1) writeFileSync(join(folder, `rule-${index}.rules`), "");
  assert.equal(firstFolderEntries(folder).length, 4);
  assert.equal(firstFolderEntries(folder, 1).length, 1);
  assert.ok(firstFolderEntries(folder).every((entry) => entry.startsWith(`${folder}/rule-`)));
  // It means what a full listing means: nothing for no folder and for an empty one, something for one that cannot be listed.
  assert.deepEqual(firstFolderEntries(join(folder, "not-there")), []);
  assert.deepEqual(firstFolderEntries(fixture("empty")), []);
  const locked = fixture("locked");
  chmodSync(locked, 0o000);
  try {
    assert.deepEqual(firstFolderEntries(locked), [locked]);
  } finally {
    chmodSync(locked, 0o700);
  }
  const linked = join(fixture("link"), "rules");
  symlinkSync(folder, linked);
  assert.equal(firstFolderEntries(linked).length, 4, "a folder that is a link is read through it");
});

/** The words of the refusal for a folder the Codex config lets a sandboxed command write. */
const writableRootText = (shown: string, touches: string) =>
  `Your Codex config lets a sandboxed command write ${shown} (sandbox_workspace_write.writable_roots), and that folder ${touches}. `
  + "A command could change what Codex reads there and leave its sandbox, so LetAgents will not start Codex at this access level. "
  + `Take ${shown} out of writable_roots in your Codex config.toml, or give this agent Full access if you accept that.`;
const AGENTS_HOME = "the Codex home LetAgents keeps for sandboxed agents";

test("a launch whose sandbox lets a command write the project is refused when the Codex config lets it write where Codex reads its settings or rules", async () => {
  const owner = ownerHome({ rules: false });
  const elsewhere = fixture("elsewhere");
  const launch = (writableRoots: string[], writableSandbox: boolean, more: { cwd?: string; otherRuleFolders?: string[] } = {}) =>
    codexHomeForSandboxedLaunch("codex", { env: owner.env, writableSandbox, ...(more.cwd ? { cwd: more.cwd } : {}) }, {
      inspect: async () => ({ ...noProject, writableRoots, otherRuleFolders: more.otherRuleFolders ?? [] }), keepsLinkedSignIn: async () => true,
    });
  const refused = async (root: string, shown: string, touches: string, more: { cwd?: string; otherRuleFolders?: string[] } = {}) => {
    await assert.rejects(launch([elsewhere, root], true, more), (error: Error) => { assert.equal(error.message, writableRootText(shown, touches)); return true; });
    // A read-only sandbox writes nowhere, and the folders do not apply to it.
    assert.equal((await launch([elsewhere, root], false, more)).codexHome, owner.agentHome, root);
  };
  // Each line says how the folder and the home lie: the folder is the home, holds it, or is in it.
  const disk = parse(owner.home).root;
  await refused(disk, disk, `holds ${AGENTS_HOME}`);
  await refused(dirname(owner.home), dirname(owner.home), `holds ${AGENTS_HOME}`);
  await refused(owner.home, "~", `holds ${AGENTS_HOME}`);
  await refused(`${owner.home}/`, "~", `holds ${AGENTS_HOME}`);
  await refused(join(owner.home, ".letagents"), "~/.letagents", `holds ${AGENTS_HOME}`);
  await refused(`${join(owner.home, ".letagents")}/`, "~/.letagents", `holds ${AGENTS_HOME}`);
  await refused(owner.agentHome, "~/.letagents/codex-agent-home", `is ${AGENTS_HOME}`);
  await refused(join(owner.agentHome, "rules"), "~/.letagents/codex-agent-home/rules", `is in ${AGENTS_HOME}`);
  // Another owner home's agents' home in the same data folder, there or not there yet.
  await refused(join(owner.home, ".letagents", "codex-agent-home-0123456789ab"), "~/.letagents/codex-agent-home-0123456789ab", "is a Codex home LetAgents keeps for sandboxed agents");
  await refused(join(owner.home, ".letagents", "codex-agent-home-0123456789ab", "rules"), "~/.letagents/codex-agent-home-0123456789ab/rules", "is in a Codex home LetAgents keeps for sandboxed agents");
  // The owner's own home: all of it. Nothing in it is left out.
  await refused(owner.codexHome, "~/.codex", "is your Codex home");
  await refused(join(owner.codexHome, "rules"), "~/.codex/rules", "is in your Codex home");
  await refused(join(owner.codexHome, "worktrees", "one"), "~/.codex/worktrees/one", "is in your Codex home");

  // One folder under another name: in another case, through a link, and with a link in the middle.
  const shouted = join(owner.home, ".LETAGENTS");
  await refused(shouted, "~/.LETAGENTS", `holds ${AGENTS_HOME}`);
  await refused(join(owner.home, ".Codex", "Rules"), "~/.Codex/Rules", "is in your Codex home");
  const link = join(fixture("links"), "to-the-data-folder");
  symlinkSync(join(owner.home, ".letagents"), link);
  await refused(link, link, `holds ${AGENTS_HOME}`);
  await refused(join(link, "codex-agent-home", "rules"), join(link, "codex-agent-home", "rules"), `is in ${AGENTS_HOME}`);
  // A second path that the disk itself gives the folder, where it has one: macOS shows every folder below this one too.
  const second = join("/System/Volumes/Data", owner.home);
  const same = (left: string, right: string) => { try { const [a, b] = [statSync(left), statSync(right)]; return a.dev === b.dev && a.ino === b.ino; } catch { return false; } };
  if (same(second, owner.home)) {
    await refused(join(second, ".letagents"), join(second, ".letagents"), `holds ${AGENTS_HOME}`);
    await refused(join(second, ".codex"), join(second, ".codex"), "is your Codex home");
    // And another owner home's agents' home that is there, named by that second path.
    const other = join(owner.home, ".letagents", "codex-agent-home-ba9876543210");
    mkdirSync(other, { recursive: true });
    await refused(join(second, ".letagents", basename(other), "rules"), join(second, ".letagents", basename(other), "rules"), "is in a Codex home LetAgents keeps for sandboxed agents");
    execFileSync("rm", ["-r", join(owner.home, ".letagents")]);
  }

  // A folder that touches none of them changes nothing: beside the homes, and one whose name only starts like one.
  for (const apart of [elsewhere, join(owner.home, "projects"), join(owner.home, ".letagents-other"), join(owner.home, ".codex-backup"), join(owner.home, ".letagents", "workspaces")]) {
    assert.equal((await launch([apart], true)).codexHome, owner.agentHome, apart);
  }

  // The rules folder of another layer Codex reads rules from: the computer's own settings.
  const machine = fixture("machine-settings");
  mkdirSync(join(machine, "rules"));
  const layers = { otherRuleFolders: [join(machine, "rules")] };
  const from = `a folder that Codex reads command rules from (${join(machine, "rules")})`;
  await refused(join(machine, "rules"), join(machine, "rules"), `is ${from}`, layers);
  await refused(machine, machine, `holds ${from}`, layers);
  await refused(join(machine, "rules", "more"), join(machine, "rules", "more"), `is in ${from}`, layers);
  assert.equal((await launch([join(machine, "cache")], true, layers)).codexHome, owner.agentHome, "a folder beside that rules folder");

  // An owner whose Codex home is not in the user folder: the folder above it holds it.
  const above = fixture("apart");
  mkdirSync(join(above, "codex"));
  writeFileSync(join(above, "codex", "auth.json"), '{"pretend":"owner sign-in"}\n', { mode: 0o600 });
  await assert.rejects(codexHomeForSandboxedLaunch("codex", { env: { HOME: fixture("apart-user"), CODEX_HOME: join(above, "codex") }, writableSandbox: true },
    { inspect: async () => ({ ...noProject, writableRoots: [above] }), keepsLinkedSignIn: async () => true }),
  (error: Error) => { assert.equal(error.message, writableRootText(above, "holds your Codex home")); return true; });

  // The same before a running process starts or loads a conversation, with the home it runs with.
  const project = fixture("project");
  const load = (writableRoots: string[], writableSandbox: boolean, codexHome = owner.agentHome) => sandboxedCodexLoadRefusal("codex", { cwd: project, codexHome, env: owner.env, writableSandbox },
    { inspect: async () => ({ ...noProject, writableRoots }) });
  assert.equal(await load([join(owner.home, ".letagents")], true), writableRootText("~/.letagents", `holds ${AGENTS_HOME}`));
  assert.equal(await load([disk], true), writableRootText(disk, `holds ${AGENTS_HOME}`));
  assert.equal(await load([join(owner.home, ".letagents")], false), null);
  assert.equal(await load([elsewhere], true), null);
  const custom = fixture("another-agents-home");
  assert.equal(await load([custom], true, custom), writableRootText(custom, `is ${AGENTS_HOME}`), "the home the process says it runs with");

  // What Codex reports is what is looked at: the installed stand-in names its config's writable folders.
  const reported = await inspectCodexSettings(fakeCodex({ writableRoots: [elsewhere, "/"], userAgent: "codex-stand-in/2.0" }).bin, { cwd: project, env: { PATH: process.env.PATH, ...owner.env }, configOverrides: [] });
  assert.deepEqual([reported.writableRoots, reported.userAgent], [[elsewhere, "/"], "codex-stand-in/2.0"]);

  // Folders that Codex names in a form this code cannot place are not taken as none: a sandbox that can write is refused, and one that cannot is not.
  // Codex 0.153.4 names each by its full path, so a "~", a "..", or a path from some other folder is such a form.
  const UNREADABLE = "Codex named the folders its config lets a sandboxed command write (sandbox_workspace_write.writable_roots) in a form LetAgents cannot read. "
    + "LetAgents cannot tell whether a command could write a Codex home and leave its sandbox, so it will not start Codex at this access level. "
    + "Give this agent an access level that does not let it write the project, or Full access if you accept that.";
  for (const odd of [[{ path: elsewhere }], [elsewhere, 7], "everything", ["~/.letagents"], ["~"], [`${elsewhere}/../${basename(owner.home)}`], ["relative/folder"], [""]] as unknown[]) {
    const inspected = await inspectCodexSettings(fakeCodex({ writableRoots: odd as string[] }).bin, { cwd: project, env: { PATH: process.env.PATH, ...owner.env }, configOverrides: [] });
    assert.equal(inspected.writableRoots, null, JSON.stringify(odd));
    const asked = (writableSandbox: boolean) => codexHomeForSandboxedLaunch("codex", { env: owner.env, writableSandbox }, { inspect: async () => inspected, keepsLinkedSignIn: async () => true });
    await assert.rejects(asked(true), (error: Error) => error.message === UNREADABLE);
    assert.equal((await asked(false)).codexHome, owner.agentHome);
    assert.equal(await sandboxedCodexLoadRefusal("codex", { cwd: project, codexHome: owner.agentHome, env: owner.env, writableSandbox: true }, { inspect: async () => inspected }), UNREADABLE);
  }
});

test("a writable folder is refused when it leaves a project layer's .codex folder open to a command, and not when Codex itself keeps that folder", async () => {
  const owner = ownerHome({ rules: false });
  // A repository whose work folder is two folders below its top: three project layers.
  const outer = fixture("outer");
  const repo = join(outer, "repo");
  const work = join(repo, "packages", "work");
  mkdirSync(work, { recursive: true });
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  const launch = (writableRoots: string[], cwd: string, writableSandbox = true) => codexHomeForSandboxedLaunch("codex", { env: owner.env, cwd, writableSandbox }, {
    inspect: async () => ({ ...noProject, writableRoots }), keepsLinkedSignIn: async () => true,
  });
  const from = (shown: string) => `this project's ${shown} folder, where Codex reads command rules and settings`;
  const refused = (root: string, touches: string, cwd = work) => assert.rejects(launch([root], cwd), (error: Error) => { assert.equal(error.message, writableRootText(root, touches)); return true; });

  // A folder above the repository: the .codex of each layer above the work folder is open to a command there.
  await refused(outer, `holds ${from("packages/.codex")}`);
  // The top of the repository: its own .codex is directly in the root, which Codex keeps. The layer between is open.
  await refused(repo, `holds ${from("packages/.codex")}`);
  // A .codex folder itself, and a folder in one: the work folder's own too.
  await refused(join(repo, ".codex"), `is ${from(".codex")}`);
  await refused(join(repo, ".codex", "rules"), `is in ${from(".codex")}`);
  await refused(join(work, ".codex"), `is ${from("packages/work/.codex")}`);
  await refused(join(work, ".codex", "rules"), `is in ${from("packages/work/.codex")}`);
  // The folder between, as a root: its own .codex is directly in it, and the work folder's own is kept whatever the roots are.
  assert.equal((await launch([join(repo, "packages")], work)).codexHome, owner.agentHome);
  // A folder beside the project, and the work folder itself.
  assert.equal((await launch([fixture("beside"), work], work)).codexHome, owner.agentHome);
  // Nothing of this at a sandbox that writes nowhere.
  assert.equal((await launch([outer], work, false)).codexHome, owner.agentHome);

  // An agent that works at the top of its repository has one layer, its own, and Codex keeps that one: a folder above it is not refused.
  assert.equal((await launch([outer], repo)).codexHome, owner.agentHome);
  assert.equal((await launch([repo], repo)).codexHome, owner.agentHome);
  await refused(join(repo, ".codex"), `is ${from(".codex")}`, repo);

  // The same before a running process starts or loads a conversation.
  assert.equal(await sandboxedCodexLoadRefusal("codex", { cwd: work, codexHome: owner.agentHome, env: owner.env, writableSandbox: true },
    { inspect: async () => ({ ...noProject, writableRoots: [outer] }) }), writableRootText(outer, `holds ${from("packages/.codex")}`));
  assert.equal(await sandboxedCodexLoadRefusal("codex", { cwd: repo, codexHome: owner.agentHome, env: owner.env, writableSandbox: true },
    { inspect: async () => ({ ...noProject, writableRoots: [outer] }) }), null);
});

test("the folders the Codex config lets a command write are handed on to be looked at again, and a folder that has become a way into a home is found then", async () => {
  const owner = ownerHome({ rules: false });
  const base = fixture("named-folders");
  const named = join(base, "cache");
  mkdirSync(named);
  const inspect = async () => ({ ...noProject, writableRoots: [named] });
  // A launch whose sandbox writes hands on a look at the folders as it named them. One whose sandbox does not write has none to look at.
  const launch = await codexHomeForSandboxedLaunch("codex", { env: owner.env, writableSandbox: true }, { inspect, keepsLinkedSignIn: async () => true });
  assert.equal(launch.codexHome, owner.agentHome);
  assert.equal(launch.writableFoldersCheck!(), null);
  assert.equal(Object.hasOwn(await codexHomeForSandboxedLaunch("codex", { env: owner.env }, { inspect, keepsLinkedSignIn: async () => true }), "writableFoldersCheck"), false);
  // And so does a load, when it refuses nothing.
  const project = fixture("project");
  const kept: Array<() => string | null> = [];
  const load = (writableSandbox: boolean, roots = [named]) => sandboxedCodexLoadRefusal("codex",
    { cwd: project, codexHome: owner.agentHome, env: owner.env, writableSandbox, keepWritableFoldersCheck: (check) => { kept.push(check); } }, { inspect: async () => ({ ...noProject, writableRoots: roots }) });
  assert.equal(await load(true), null);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!(), null);
  assert.equal(await load(false), null);
  assert.match(String(await load(true, [owner.home])), /holds the Codex home LetAgents keeps for sandboxed agents/);
  assert.equal(kept.length, 1, "no look is handed on for a sandbox that writes nowhere, or for a load that is refused");

  // The named folder is now a link into the LetAgents data folder: both looks find it, in the words of the refusal.
  execFileSync("rmdir", [named]);
  symlinkSync(join(owner.home, ".letagents"), named);
  const found = writableRootText(named, `holds ${AGENTS_HOME}`);
  assert.equal(launch.writableFoldersCheck!(), found);
  assert.equal(kept[0]!(), found);
  // And a link to a folder that is no one's home is nothing to find.
  execFileSync("rm", [named]);
  symlinkSync(fixture("harmless"), named);
  assert.equal(launch.writableFoldersCheck!(), null);

  // The managed launch hands the look on with the process it started, for the level that writes and for no other.
  const managedOwner = ownerHome({ rules: false });
  const cache = join(fixture("managed"), "cache");
  mkdirSync(cache);
  const codex = fakeCodex({ writableRoots: [cache] });
  const managed = async (writableSandbox: boolean) => {
    const started = await launchManagedCodexAppServer("ws://127.0.0.1:1", codex.bin, { trustedProjectPath: project, configOverrides: [], env: managedOwner.env, sandboxed: true, writableSandbox });
    await waitForExit(started);
    return started;
  };
  assert.equal(Object.hasOwn(await managed(false), "writableFoldersCheck"), false);
  const writes = await managed(true);
  assert.equal(writes.writableFoldersCheck!(), null);
  execFileSync("rmdir", [cache]);
  symlinkSync(managedOwner.codexHome, cache);
  assert.equal(writes.writableFoldersCheck!(), writableRootText(cache, "is your Codex home"));
});

test("the installed Codex keeps a command out of the work folder's own .codex and out of the .codex directly in a writable root, not out of one below a root, and holds a named sandbox against a project's config", {
  skip: realCodex ? false : "Codex is not installed",
  timeout: 240_000,
}, async (t) => {
  const model = await stubModel();
  t.after(() => model.close());
  /**
   * One turn of the installed Codex in `work`, started as LetAgents starts one, in which the model runs a command that
   * writes each of `targets`. Answers which of them are there afterwards.
   */
  const written = async (scene: { outer: string; repo: string; work: string; roots: string[]; projectConfig?: string; sandbox: "workspace-write" | "read-only" }, targets: string[]) => {
    const home = fixture("contract-home");
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), [
      'model = "stand-in"', 'model_provider = "standin"', "",
      "[model_providers.standin]", 'name = "standin"', `base_url = "http://127.0.0.1:${model.port}/v1"`,
      'wire_api = "responses"', "requires_openai_auth = false", "supports_websockets = false", "",
      ...(scene.roots.length ? ["[sandbox_workspace_write]", `writable_roots = ${JSON.stringify(scene.roots)}`, ""] : []),
      ...[...new Set([scene.repo, scene.work])].flatMap((folder) => [`[projects.${JSON.stringify(folder)}]`, 'trust_level = "trusted"', ""]),
    ].join("\n"));
    if (scene.projectConfig) {
      mkdirSync(join(scene.repo, ".codex"), { recursive: true });
      writeFileSync(join(scene.repo, ".codex", "config.toml"), scene.projectConfig);
    }
    const overrides = ["features.plugins=false", "features.apps=false", "features.hooks=false", "features.memories=false", "notify=[]", "analytics.enabled=false"];
    const child = spawn(realCodex!, ["app-server", ...overrides.flatMap((override) => ["-c", override]), "--listen", "stdio://"], {
      cwd: scene.work, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, ".codex"), TMPDIR: fixture("tmp") }, stdio: ["pipe", "pipe", "ignore"],
    });
    const answers = new Map<number, (answer: { result?: unknown; error?: { message?: string } }) => void>();
    let turnEnded: (() => void) | null = null;
    let serial = 0;
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as { id?: number; method?: string; result?: unknown; error?: { message?: string } };
      if (message.method === "turn/completed") turnEnded?.();
      // Nobody is there to approve anything.
      if (typeof message.id === "number" && message.method) child.stdin.write(`${JSON.stringify({ id: message.id, result: { decision: "decline" } })}\n`);
      else if (typeof message.id === "number") answers.get(message.id)?.(message);
    });
    const ask = (method: string, params: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
      answers.set(++serial, (answer) => (answer.error ? reject(new Error(String(answer.error.message))) : resolve(answer.result as Record<string, unknown>)));
      child.stdin.write(`${JSON.stringify({ id: serial, method, params })}\n`);
    });
    try {
      await ask("initialize", { clientInfo: { name: "letagents-test", title: "test", version: "1" }, capabilities: { experimentalApi: true } });
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      const approvalPolicy = scene.sandbox === "read-only" ? "on-request" : "never";
      const started = await ask("thread/start", { cwd: scene.work, approvalPolicy, sandbox: scene.sandbox, approvalsReviewer: "user" });
      const cmd = `${targets.map((file) => `mkdir -p ${JSON.stringify(dirname(file))} 2>/dev/null; echo x > ${JSON.stringify(file)} 2>/dev/null`).join(" ; ")} ; true`;
      model.plan.push(
        () => [{ type: "function_call", call_id: `call_${model.requests.length}`, name: "exec_command", arguments: JSON.stringify({ cmd, login: false }) }],
        () => [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      );
      const ended = new Promise<void>((resolve) => { turnEnded = resolve; });
      // The temp folders are left out of the sandbox: these scratch folders are below one.
      const sandboxPolicy = scene.sandbox === "read-only" ? { type: "readOnly", networkAccess: false }
        : { type: "workspaceWrite", networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true };
      await ask("turn/start", { threadId: (started.thread as { id: string }).id, input: [{ type: "text", text: "Run the command." }], approvalPolicy, approvalsReviewer: "user", sandboxPolicy });
      await ended;
      assert.equal(model.plan.length, 0, "the model was asked for the command and for its last word");
      return { started, written: targets.filter((file) => existsSync(file)) };
    } finally {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  };
  const project = () => {
    const outer = fixture("contract-outer");
    const repo = join(outer, "repo");
    const work = join(repo, "sub");
    mkdirSync(work, { recursive: true });
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    return { outer, repo, work, own: join(work, ".codex", "rules", "a.rules"), above: join(repo, ".codex", "rules", "b.rules"), plain: join(work, "plain-file") };
  };

  // No folder besides the project: the work folder is written, its own .codex is not, and nothing above it is.
  const alone = project();
  assert.deepEqual((await written({ ...alone, roots: [], sandbox: "workspace-write" }, [alone.own, alone.above, alone.plain])).written, [alone.plain]);
  // A root that is the top of the repository: the .codex directly in it is kept too.
  const atTop = project();
  assert.deepEqual((await written({ ...atTop, roots: [atTop.repo], sandbox: "workspace-write" }, [atTop.own, atTop.above, atTop.plain])).written, [atTop.plain]);
  // A root above the repository: the work folder's own .codex is still kept, and the one of the layer above is open. That root is refused.
  const below = project();
  assert.deepEqual((await written({ ...below, roots: [below.outer], sandbox: "workspace-write" }, [below.own, below.above, below.plain])).written, [below.above, below.plain]);
  // An agent that works at the top of its repository, with the same root above it: its one .codex is its own, and is kept.
  const top = project();
  const ownAtTop = join(top.repo, ".codex", "rules", "c.rules");
  assert.deepEqual((await written({ ...top, work: top.repo, roots: [top.outer], sandbox: "workspace-write" }, [ownAtTop, join(top.repo, "plain-file")])).written, [join(top.repo, "plain-file")]);

  // A trusted project's config asks for no sandbox, no approvals and the network. The sandbox the conversation and the turn name holds.
  const wide = project();
  const outside = join(fixture("contract-outside"), "planted");
  const named = await written({ ...wide, roots: [], sandbox: "read-only",
    projectConfig: 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n[sandbox_workspace_write]\nnetwork_access = true\n' }, [outside, wide.plain]);
  assert.deepEqual(named.written, []);
  assert.deepEqual([named.started.approvalPolicy, named.started.sandbox], ["on-request", { type: "readOnly", networkAccess: false }]);
});

/**
 * The installed Codex at an access level, started by the real adapter: the adapter's own conversation start, and turns that carry
 * the adapter's own turn policy. `asCodexDoes` starts it past the launch's refusals, with the home it names, to see what Codex
 * itself does with a config the launch would refuse.
 */
async function adapterStartedCodex(t: { after(cleanup: () => Promise<void> | void): void }, model: Awaited<ReturnType<typeof stubModel>>, options: {
  level?: "auto" | "ask";
  ownerRoots?: (scene: Record<string, string>) => string[];
  projectConfig?: (scene: Record<string, string>) => string;
  asCodexDoes?: "the owner's home" | "the agents' home";
}) {
  const owner = ownerHome({ rules: false });
  execFileSync("rm", [join(owner.codexHome, "auth.json")]);
  const base = fixture("adapter-started");
  const scene: Record<string, string> = { base, project: join(base, "project"), ownerRoot: join(base, "owner-root"), projectRoot: join(base, "project-root"),
    control: join(base, "control"), data: join(owner.home, ".letagents"), agentHome: owner.agentHome };
  // The temp folder is one of its own, so that no folder of the scene is written for being below it.
  const tmp = join(base, "tmp");
  for (const dir of [tmp, join(scene.project!, ".git"), join(scene.project!, ".codex"), scene.ownerRoot!, scene.projectRoot!, scene.control!]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(scene.project!, ".git", "HEAD"), "ref: refs/heads/main\n");
  const roomServer = join(base, "room-server.mjs");
  writeFileSync(roomServer, [
    "import { createInterface } from 'node:readline';",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "createInterface({ input: process.stdin }).on('line', (line) => {",
    "  let m; try { m = JSON.parse(line); } catch { return; }",
    "  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stand-in', version: '1' } } });",
    "  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'room_tool', inputSchema: { type: 'object', properties: {} } }] } });",
    "  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });",
    "});", "",
  ].join("\n"));
  const projectConfig = options.projectConfig?.(scene);
  writeFileSync(join(owner.codexHome, "config.toml"), [
    'model = "stand-in"', 'model_provider = "standin"', "",
    "[model_providers.standin]", 'name = "standin"', `base_url = "http://127.0.0.1:${model.port}/v1"`, 'wire_api = "responses"', "requires_openai_auth = false", "supports_websockets = false", "",
    "[mcp_servers.letagents]", 'command = "node"', `args = [${JSON.stringify(roomServer)}]`, "",
    ...(options.ownerRoots ? ["[sandbox_workspace_write]", `writable_roots = ${JSON.stringify(options.ownerRoots(scene))}`, ""] : []),
    ...(projectConfig ? [`[projects.${JSON.stringify(scene.project)}]`, 'trust_level = "trusted"', ""] : []),
  ].join("\n"));
  if (projectConfig) writeFileSync(join(scene.project!, ".codex", "config.toml"), projectConfig);
  if (options.asCodexDoes === "the agents' home") linkCodexAgentHome(owner.codexHome, owner.agentHome);
  const launches: Array<{ pid: number | null; exited: Promise<unknown> }> = [];
  const clients: InstanceType<typeof CodexRpcClient>[] = [];
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  let turnEnded: (() => void) | null = null;
  t.after(async () => {
    for (const client of clients) client.close();
    for (const launch of launches) {
      if (launch.pid !== null) terminateSpawnedProcess(launch.pid);
      await waitForExit(launch);
    }
  });
  const adapter = new CodexProviderAdapter({
    codexBin: realCodex!,
    dependencies: {
      resolveServerUrl: freeLoopbackUrl,
      launchServer: async (serverUrl, bin, launchOptions) => {
        const launch = await launchManagedCodexAppServer(serverUrl, bin, {
          ...launchOptions,
          ...(options.asCodexDoes ? { sandboxed: false } : {}),
          env: { HOME: owner.home, CODEX_HOME: options.asCodexDoes === "the agents' home" ? owner.agentHome : owner.codexHome, TMPDIR: tmp },
        });
        launches.push(launch);
        return launch;
      },
      createRpcClient: (serverUrl, notify) => {
        const client = new CodexRpcClient(serverUrl, (notification) => { if (notification.method === "turn/completed") turnEnded?.(); notify?.(notification); });
        const request = client.request.bind(client);
        client.request = async <T>(method: string, params?: unknown, requestOptions?: { timeoutMs?: number }): Promise<T> => {
          if (method === "thread/start" || method === "turn/start") sent.push({ method, params: params as Record<string, unknown> });
          return request<T>(method, params, requestOptions);
        };
        clients.push(client);
        return client;
      },
    },
  });
  const level = options.level === "ask"
    ? { permissionProfileId: "ask_before_write", configurationRevision: 1, launchPolicy: { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } } }
    : { permissionProfileId: "auto_review", configurationRevision: 1, launchPolicy: { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" } };
  const handle = await adapter.spawn({ ...spawnRequest, cwd: scene.project, deliveryMode: "daemon_inbox", ...level } as never);
  return {
    scene, sent, handle,
    /** One turn in which the model runs each command, sent with the adapter's own turn policy, or with `sandboxPolicy` in its place. */
    turn: async (commands: string[], sandboxPolicy?: Record<string, unknown>) => {
      model.plan.push(
        ...commands.map((cmd) => () => [{ type: "function_call", call_id: `call_${model.requests.length}`, name: "exec_command", arguments: JSON.stringify({ cmd, login: false }) }]),
        () => [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      );
      const turnPolicy = (handle as unknown as { requireTurnPolicy(): Record<string, unknown> }).requireTurnPolicy();
      const ended = new Promise<void>((resolve) => { turnEnded = resolve; });
      await clients[0]!.request("turn/start", { ...turnPolicy, ...(sandboxPolicy ? { sandboxPolicy } : {}), threadId: handle.providerContinuationId,
        input: [{ type: "text", text: "Run the commands.", text_elements: [] }] });
      await ended;
      assert.equal(model.plan.length, 0, "the model was asked for each command and for its last word");
    },
  };
}
/** A command that makes each file and never fails, so nothing is asked of a reviewer. */
const touchEach = (...files: string[]) => `${files.map((file) => `touch ${JSON.stringify(file)} 2>/dev/null`).join("; ")}; true`;

test("the installed Codex, asked as the adapter asks it at the Auto level, lets a command write each folder the Codex config names, whatever sandbox the turn names", {
  skip: realCodex ? false : "Codex is not installed",
  timeout: 300_000,
}, async (t) => {
  const model = await stubModel();
  t.after(() => model.close());

  // A folder the owner's config names, beside the homes: the launch does not refuse it, and a command writes it.
  const owned = await adapterStartedCodex(t, model, { ownerRoots: (scene) => [scene.ownerRoot!] });
  const first = { control: join(owned.scene.control!, "x"), project: join(owned.scene.project!, "in-project"), named: join(owned.scene.ownerRoot!, "x") };
  await owned.turn([touchEach(...Object.values(first))]);
  assert.deepEqual(Object.values(first).filter((file) => existsSync(file)), [first.project, first.named], "the project and the named folder are written, and nothing else");
  // These are the adapter's own requests: the conversation start names the level's sandbox, and each turn names it again with no folder beside the project.
  const started = owned.sent.find((call) => call.method === "thread/start")!.params;
  assert.deepEqual({ approvalPolicy: started.approvalPolicy, sandbox: started.sandbox, approvalsReviewer: started.approvalsReviewer },
    { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" });
  const turned = owned.sent.find((call) => call.method === "turn/start")!.params;
  assert.deepEqual({ approvalPolicy: turned.approvalPolicy, sandboxPolicy: turned.sandboxPolicy, approvalsReviewer: turned.approvalsReviewer },
    { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" });
  // A turn that names an empty list of folders does not take the config's folder away either: nothing a turn names does.
  const again = join(owned.scene.ownerRoot!, "with-an-empty-list");
  await owned.turn([touchEach(again)], { type: "workspaceWrite", networkAccess: false, writableRoots: [] });
  assert.equal(existsSync(again), true);

  // A folder that a trusted project's config names (the launch refuses that project, so Codex is started past the launch here).
  // The project also asks for the network, which the turn's own "no network" withholds.
  const repository = await adapterStartedCodex(t, model, { asCodexDoes: "the owner's home",
    projectConfig: (scene) => `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(scene.projectRoot)}]\nnetwork_access = true\n` });
  const second = { control: join(repository.scene.control!, "x"), named: join(repository.scene.projectRoot!, "x"), before: join(repository.scene.project!, "before"), after: join(repository.scene.project!, "after") };
  await repository.turn([`touch ${JSON.stringify(second.control)} ${JSON.stringify(second.named)} ${JSON.stringify(second.before)} 2>/dev/null; curl -s -m 3 http://127.0.0.1:${model.port}/reached-the-network >/dev/null 2>&1; touch ${JSON.stringify(second.after)}; true`]);
  assert.deepEqual(Object.values(second).filter((file) => existsSync(file)), [second.named, second.before, second.after], "the project's folder is written; the command ran to its end");
  assert.deepEqual(model.others, [], "and it did not reach the network");

  // The agents' home below a named folder (the launch refuses that folder too): its rules folder is made writable, and a rule is put in it.
  const covered = await adapterStartedCodex(t, model, { asCodexDoes: "the agents' home", ownerRoots: (scene) => [scene.data!] });
  const rules = join(covered.scene.agentHome!, "rules");
  await covered.turn([`chmod u+w ${JSON.stringify(rules)} 2>/dev/null; ${touchEach(join(rules, "planted.rules"))}`]);
  assert.deepEqual(readdirSync(rules), ["planted.rules"]);

  // At a level whose sandbox writes nowhere, the same named folder is not written, and neither is the project.
  const asking = await adapterStartedCodex(t, model, { level: "ask", ownerRoots: (scene) => [scene.ownerRoot!] });
  const third = [join(asking.scene.ownerRoot!, "x"), join(asking.scene.project!, "in-project")];
  await asking.turn([touchEach(...third)]);
  assert.deepEqual(third.filter((file) => existsSync(file)), []);
});

test("the installed Codex keeps a command from turning a folder it may write into another one: it cannot remove it or move the folder above it, and runs nothing more once it is a link", {
  skip: realCodex ? false : "Codex is not installed",
  timeout: 180_000,
}, async (t) => {
  const model = await stubModel();
  t.after(() => model.close());
  // Three named folders in the project, where a command can write all around them: two that are there, and one that is not there yet.
  const agent = await adapterStartedCodex(t, model, { ownerRoots: (scene) => [join(scene.project!, "kept"), join(scene.project!, "a", "below"), join(scene.project!, "b", "later")] });
  const { project, control } = agent.scene as { project: string; control: string };
  mkdirSync(join(project, "kept"));
  mkdirSync(join(project, "a", "below"), { recursive: true });
  await agent.turn([
    `rmdir ${JSON.stringify(join(project, "kept"))} 2>/dev/null; mv ${JSON.stringify(join(project, "a"))} ${JSON.stringify(join(project, "a-moved"))} 2>/dev/null; true`,
    // The one that is not there yet can be made as a link to a folder outside the project.
    `mkdir -p ${JSON.stringify(join(project, "b"))}; ln -s ${JSON.stringify(control)} ${JSON.stringify(join(project, "b", "later"))}; ${touchEach(join(control, "through-the-link"))}`,
    touchEach(join(project, "after-the-link"), join(control, "after-the-link")),
  ]);
  assert.equal(lstatSync(join(project, "kept")).isDirectory(), true, "a named folder is not removed");
  assert.deepEqual([existsSync(join(project, "a", "below")), existsSync(join(project, "a-moved"))], [true, false], "the folder above a named folder is not moved");
  assert.equal(lstatSync(join(project, "b", "later")).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(control), [], "the folder the link leads to is not written, by that command or by a later one");
  assert.equal(existsSync(join(project, "after-the-link")), false, "Codex runs no command while a named folder is a link");
  assert.match(JSON.stringify(model.requests.at(-1)), /symlinked writable roots are not supported/);
});

test("one folder is told from another name by name and by what it is on disk, so a disk's top, another spelling and a second path are all found", () => {
  const base = fixture("holds");
  mkdirSync(join(base, "a", "b"), { recursive: true });
  mkdirSync(join(base, "ab"));
  const top = parse(base).root;
  // Name by name: the top holds everything, and a name that only starts like another is another folder.
  assert.equal(folderHolds(top, join(base, "a", "b")), true);
  assert.equal(folderHolds(top, top), true);
  assert.equal(folderHolds(join(base, "a"), join(base, "a", "b")), true);
  assert.equal(folderHolds(`${join(base, "a")}/`, join(base, "a", "b")), true);
  assert.equal(folderHolds(join(base, "a"), join(base, "a")), true);
  assert.equal(folderHolds(join(base, "a"), join(base, "ab")), false);
  assert.equal(folderHolds(join(base, "a", "b"), join(base, "a")), false);
  assert.equal(folderHolds(join(base, "a"), top), false);
  // A folder that is not there yet is compared by name, without regard to case.
  assert.equal(folderHolds(join(base, "a"), join(base, "a", "not", "there")), true);
  assert.equal(folderHolds(join(base, "NEW"), join(base, "new", "x")), true);
  assert.equal(folderHolds(join(base, "new"), join(base, "newer")), false);
  // A link: by what it leads to.
  symlinkSync(join(base, "a"), join(base, "link"));
  assert.equal(folderHolds(join(base, "link"), join(base, "a", "b")), true);
  assert.equal(folderHolds(join(base, "a"), join(base, "link", "b")), true);
  assert.equal(folderHolds(join(base, "link", "b"), join(base, "a")), false);

  // The same test of names for a path that is only shown.
  assert.equal(pathFrom("/", "/home/someone"), "home/someone");
  assert.equal(pathFrom("/a", "/a"), "");
  assert.equal(pathFrom("/a/", "/a/b"), "b");
  assert.equal(pathFrom("/a", "/ab"), null);
  assert.equal(pathFrom("/a/b", "/a"), null);
  assert.equal(pathFrom("/a", "/a/..b/c"), "..b/c");

  // The agents' home must be apart from the owner's home whatever the two are: a home at the disk's top holds every folder.
  assert.throws(() => linkCodexAgentHome(top, join(base, "agents-home")), /must be a folder apart from the owner's Codex home/);
  assert.equal(existsSync(join(base, "agents-home")), false, "nothing is made before the two are known to be apart");
  const ownerInside = join(base, "agents", "owner");
  mkdirSync(ownerInside, { recursive: true });
  assert.throws(() => linkCodexAgentHome(ownerInside, `${join(base, "agents")}/`), /must be a folder apart/);
  assert.throws(() => linkCodexAgentHome(ownerInside, join(base, "AGENTS", "OWNER", "inside")), /must be a folder apart/);
});

test("a project's Codex config may set only what is known to be harmless for a sandboxed agent, and the refusal names the key and the file", async () => {
  const owner = ownerHome({ rules: false });
  const repo = fixture("repo");
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  const work = join(repo, "packages", "work");
  mkdirSync(work, { recursive: true });
  const layer = (folder: string, config: Record<string, unknown>) => ({ dotCodexFolder: join(folder, ".codex"), config });
  const text = (file: string, keys: string, one: boolean) =>
    `This project's Codex config (${file}) sets ${keys}. `
    + `LetAgents does not know that ${one ? "this setting is" : "these settings are"} harmless for a sandboxed agent, so it will not start Codex here at this access level. `
    + `Remove ${one ? "it" : "them"} from that file, stop trusting the project in Codex, or give this agent Full access if you accept that.`;

  // An ordinary project: a model, how it thinks, its instructions, the defaults for approval and sandbox, its MCP servers.
  const ordinary = {
    model: "gpt-x", model_reasoning_effort: "high", model_reasoning_summary: "auto", model_verbosity: "low", personality: "friendly",
    approval_policy: "on-request", sandbox_mode: "workspace-write", sandbox_workspace_write: { network_access: true },
    instructions: "Be brief.", developer_instructions: "Use pnpm.", project_doc_max_bytes: 4096, project_doc_fallback_filenames: ["CLAUDE.md"],
    mcp_servers: { docs: { command: "docs-server" } }, hooks: {},
  };
  assert.deepEqual(Object.keys(ordinary).sort(), [...SANDBOXED_PROJECT_KEYS].sort(), "the list is exactly these keys");
  assert.equal(projectKeysRefusal(work, [layer(repo, ordinary), layer(work, { model: "gpt-y" })]), null);
  assert.equal(projectKeysRefusal(work, []), null);

  // Every other key refuses, one by one: the two that name a program, and each one Codex 0.153.4 takes from a project.
  for (const key of ["zsh_path", "js_repl_node_path", "project_root_markers", "features", "tools", "web_search", "shell_environment_policy", "agents", "apps",
    "projects", "permissions", "default_permissions", "cli_auth_credentials_store", "mcp_oauth_credentials_store", "forced_login_method", "sqlite_home", "log_dir",
    "history", "file_opener", "model_instructions_file", "analytics", "profiles", "profile", "model_provider", "model_providers", "notify", "otel",
    "a_key_a_later_codex_adds"]) {
    assert.equal(projectKeysRefusal(work, [layer(repo, { ...ordinary, [key]: "anything" })]), text(".codex/config.toml", key, true), key);
  }
  // Every key is named, sorted, with the file of the layer that sets them, from the top of the repository.
  assert.equal(projectKeysRefusal(work, [layer(repo, ordinary), layer(work, { zsh_path: "/x", model: "m", features: { a: true } })]),
    text("packages/work/.codex/config.toml", "features, zsh_path", false));
  const many = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`key_${index}`, 1]));
  assert.equal(projectKeysRefusal(repo, [layer(repo, many)]), text(".codex/config.toml", "key_0, key_1, key_2, key_3, key_4, key_5, key_6, key_7 and 2 more", false));
  assert.equal(projectKeysRefusal(repo, [layer(repo, { "odd\nkey\u202e": 1 })]), text(".codex/config.toml", "odd?key?", true));

  // Under sandbox_workspace_write a project may say whether its commands use the network and the temp folders. The turn's own
  // "no network" holds against the first, and the temp folders are the access level's as they are.
  assert.deepEqual([...SANDBOX_KEYS_A_PROJECT_MAY_SET].sort(), ["exclude_slash_tmp", "exclude_tmpdir_env_var", "network_access"]);
  const may = { network_access: true, exclude_tmpdir_env_var: false, exclude_slash_tmp: false };
  for (const writableSandbox of [true, false]) assert.equal(projectKeysRefusal(repo, [layer(repo, { sandbox_workspace_write: may })], { writableSandbox }), null);
  // It may not name folders to write: Codex adds them to a turn whatever the turn names, so the repository would choose where an
  // agent's commands write. Refused where the sandbox can write at all; an empty list names none.
  const folders = { ...may, writable_roots: ["/somewhere/outside/the/project"] };
  assert.equal(projectKeysRefusal(repo, [layer(repo, { sandbox_workspace_write: folders })], { writableSandbox: true }), text(".codex/config.toml", "sandbox_workspace_write.writable_roots", true));
  assert.equal(projectKeysRefusal(repo, [layer(repo, { model: "m" }), layer(work, { sandbox_workspace_write: folders })], { writableSandbox: true }),
    text("packages/work/.codex/config.toml", "sandbox_workspace_write.writable_roots", true));
  assert.equal(projectKeysRefusal(repo, [layer(repo, { sandbox_workspace_write: folders })], { writableSandbox: false }), null, "a sandbox that writes nowhere takes no folders");
  assert.equal(projectKeysRefusal(repo, [layer(repo, { sandbox_workspace_write: folders })]), null);
  assert.equal(projectKeysRefusal(repo, [layer(repo, { sandbox_workspace_write: { writable_roots: [] } })], { writableSandbox: true }), null);
  assert.equal(projectKeysRefusal(repo, [layer(repo, { sandbox_workspace_write: { writable_roots: "/one/folder" } })], { writableSandbox: true }),
    text(".codex/config.toml", "sandbox_workspace_write.writable_roots", true), "a list in a form this code does not know is not taken as empty");
  // Any other key there, and a value that is no table, is not looked into.
  for (const writableSandbox of [true, false]) {
    assert.equal(projectKeysRefusal(repo, [layer(repo, { sandbox_workspace_write: { ...may, something_new: 1 }, zsh_path: "/x" })], { writableSandbox }),
      text(".codex/config.toml", "sandbox_workspace_write.something_new, zsh_path", false));
    assert.equal(projectKeysRefusal(repo, [layer(repo, { sandbox_workspace_write: "everything" })], { writableSandbox }), text(".codex/config.toml", "sandbox_workspace_write", true));
  }
  // At a launch and at a load: for the level that writes, and not for one that does not.
  const namesFolders = { ...noProject, projectLayers: [layer(repo, { sandbox_workspace_write: folders })] };
  const FOLDERS = text(".codex/config.toml", "sandbox_workspace_write.writable_roots", true);
  await assert.rejects(codexHomeForSandboxedLaunch("codex", { env: owner.env, cwd: repo, writableSandbox: true }, { inspect: async () => namesFolders, keepsLinkedSignIn: async () => true }),
    (error: Error) => { assert.equal(error.message, FOLDERS); return true; });
  assert.equal(await sandboxedCodexLoadRefusal("codex", { cwd: repo, codexHome: owner.agentHome, env: owner.env, writableSandbox: true }, { inspect: async () => namesFolders }), FOLDERS);
  assert.equal(await sandboxedCodexLoadRefusal("codex", { cwd: repo, codexHome: owner.agentHome, env: owner.env, writableSandbox: false }, { inspect: async () => namesFolders }), null);
  assert.equal((await codexHomeForSandboxedLaunch("codex", { env: owner.env, cwd: repo }, { inspect: async () => namesFolders, keepsLinkedSignIn: async () => true })).codexHome, owner.agentHome);
  execFileSync("rm", ["-r", join(owner.home, ".letagents")]);

  // At a launch, for a sandbox that writes and one that does not, and before a running process starts or loads a conversation.
  const setsAKey = { ...noProject, projectLayers: [layer(repo, { model: "m", js_repl_node_path: "/some/program" })] };
  for (const writableSandbox of [true, false]) {
    await assert.rejects(codexHomeForSandboxedLaunch("codex", { env: owner.env, cwd: repo, writableSandbox }, { inspect: async () => setsAKey, keepsLinkedSignIn: async () => true }),
      (error: Error) => { assert.equal(error.message, text(".codex/config.toml", "js_repl_node_path", true)); return true; });
  }
  assert.equal(existsSync(owner.agentHome), false, "a refused launch makes nothing");
  assert.equal(await sandboxedCodexLoadRefusal("codex", { cwd: repo, codexHome: owner.agentHome, env: owner.env }, { inspect: async () => setsAKey }), text(".codex/config.toml", "js_repl_node_path", true));
  const ordinaryProject = { ...noProject, projectLayers: [layer(repo, ordinary)] };
  assert.equal((await codexHomeForSandboxedLaunch("codex", { env: owner.env, cwd: repo, writableSandbox: true }, { inspect: async () => ordinaryProject, keepsLinkedSignIn: async () => true })).codexHome, owner.agentHome);
  assert.equal(await sandboxedCodexLoadRefusal("codex", { cwd: repo, codexHome: owner.agentHome, env: owner.env, writableSandbox: true }, { inspect: async () => ordinaryProject }), null);

  // An agents' home with a config of its own can trust a project that the owner's home does not. Codex is asked again as it reads
  // that home, and that answer is held to the same list.
  const kept = ownerHome({ rules: false });
  mkdirSync(kept.agentHome, { recursive: true });
  writeFileSync(join(kept.agentHome, "config.toml"), "# of its own\n");
  const askedWith: string[] = [];
  await assert.rejects(codexHomeForSandboxedLaunch("codex", { env: kept.env, cwd: repo }, {
    inspect: async (_codexBin, options) => { askedWith.push(String(options.env.CODEX_HOME)); return options.env.CODEX_HOME === kept.agentHome ? setsAKey : noProject; },
    keepsLinkedSignIn: async () => true,
  }), (error: Error) => { assert.equal(error.message, text(".codex/config.toml", "js_repl_node_path", true)); return true; });
  assert.deepEqual(askedWith, [kept.codexHome, kept.agentHome]);

  // From what a Codex answers to the refusal: the layers it applies are read, and one it does not apply (a project its owner has not trusted) sets nothing.
  const applied = { name: { type: "project", dotCodexFolder: join(repo, ".codex") }, config: { model: "m", zsh_path: "/some/shell" }, disabledReason: null };
  const env = { ...owner.env, PATH: process.env.PATH };
  await assert.rejects(codexHomeForSandboxedLaunch(fakeCodex({ layers: [applied] }).bin, { env, cwd: repo }, { keepsLinkedSignIn: async () => true }),
    (error: Error) => { assert.equal(error.message, text(".codex/config.toml", "zsh_path", true)); return true; });
  assert.equal((await codexHomeForSandboxedLaunch(fakeCodex({ layers: [{ ...applied, disabledReason: "untrusted" }] }).bin, { env, cwd: repo }, { keepsLinkedSignIn: async () => true })).codexHome, owner.agentHome);
});

test("the installed Codex reports the keys of a trusted project's config, the two that name a program among them, and each one that is not known to be harmless is refused", {
  skip: realCodex ? false : "Codex is not installed",
  timeout: 60_000,
}, async () => {
  const owner = ownerHome({ rules: false });
  const repo = fixture("keys-repo");
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(repo, ".codex"));
  writeFileSync(join(repo, ".codex", "config.toml"), [
    'model = "some-model"', 'model_reasoning_effort = "high"', 'approval_policy = "on-request"', 'sandbox_mode = "workspace-write"', 'developer_instructions = "Use pnpm."',
    'zsh_path = "/some/shell"', 'js_repl_node_path = "/some/node"', 'project_root_markers = [".hg"]', 'web_search = "live"',
    "[sandbox_workspace_write]", "network_access = true", `writable_roots = [${JSON.stringify(fixture("outside-the-project"))}]`,
    "[features]", "shell_zsh_fork = true", "[mcp_servers.docs]", 'command = "docs-server"', "",
  ].join("\n"));
  const env = { PATH: process.env.PATH, ...owner.env };
  const trust = (level: string) => writeFileSync(join(owner.codexHome, "config.toml"), `[projects.${JSON.stringify(repo)}]\ntrust_level = "${level}"\n`);
  trust("trusted");
  const inspection = await inspectCodexSettings(realCodex!, { cwd: repo, env, configOverrides: [] });
  assert.deepEqual(Object.keys(inspection.projectLayers[0]!.config).sort(), [
    "approval_policy", "developer_instructions", "features", "js_repl_node_path", "mcp_servers", "model", "model_reasoning_effort",
    "project_root_markers", "sandbox_mode", "sandbox_workspace_write", "web_search", "zsh_path",
  ]);
  assert.deepEqual(Object.keys(inspection.projectLayers[0]!.config.sandbox_workspace_write as object).sort(), ["network_access", "writable_roots"]);
  const refusal = (keys: string) => `This project's Codex config (.codex/config.toml) sets ${keys}. `
    + "LetAgents does not know that these settings are harmless for a sandboxed agent, so it will not start Codex here at this access level. "
    + "Remove them from that file, stop trusting the project in Codex, or give this agent Full access if you accept that.";
  assert.equal(projectKeysRefusal(repo, inspection.projectLayers), refusal("features, js_repl_node_path, project_root_markers, web_search, zsh_path"));
  // Where the sandbox writes, the folders the project names to write are one more.
  assert.equal(projectKeysRefusal(repo, inspection.projectLayers, { writableSandbox: true }),
    refusal("features, js_repl_node_path, project_root_markers, sandbox_workspace_write.writable_roots, web_search, zsh_path"));
  // To stop trusting the project is a way out that leaves the file as it is: Codex then does not apply the layer, and nothing is refused for its keys.
  trust("untrusted");
  const untrusted = await inspectCodexSettings(realCodex!, { cwd: repo, env, configOverrides: [] });
  assert.deepEqual(untrusted.projectLayers, []);
  assert.deepEqual(untrusted.writableRoots, []);
  assert.equal(projectKeysRefusal(repo, untrusted.projectLayers, { writableSandbox: true }), null);
});

test("the remembered sign-in check is kept for what Codex says it is, so a Codex that is replaced behind the same command is checked again", async () => {
  const codex = fakeCodex({ signIn: "in-place" });
  const launch = (userAgent: string | null) => codexHomeForSandboxedLaunch(codex.bin, { env: { ...ownerHome({ rules: false }).env, PATH: process.env.PATH } },
    { inspect: async () => ({ ...noProject, userAgent }) });
  await launch("codex/0.153.4");
  await launch("codex/0.153.4");
  assert.equal(codex.calls().length, 1, "one check for one version");
  // The command on disk is the same file; the program behind it is another one.
  await launch("codex/0.154.0");
  assert.equal(codex.calls().length, 2, "another version is checked");
  await launch("codex/0.153.4");
  await launch("codex/0.154.0");
  assert.equal(codex.calls().length, 2);
  // A Codex that does not say what it is cannot be told from another one: it is checked at every launch.
  await launch(null);
  await launch(null);
  assert.equal(codex.calls().length, 4);
});

test("before a running Codex without its owner's setup loads a conversation, what a launch would turn off now is compared with what it was started with", async () => {
  const owner = ownerHome({ rules: false });
  const project = fixture("project");
  const env = { ...owner.env, PATH: process.env.PATH };
  const codex = fakeCodex({ servers: ["owner_browser"] });
  const settle = (settings: Record<string, unknown>) => writeFileSync(join(codex.bin, "..", "settings.json"), JSON.stringify({ signIn: "in-place", store: "file", ...settings }));
  // What the process was started with: its launch's own override for the room's server, and every other server turned off by name.
  const ROOM = 'mcp_servers.letagents={ command = "node", args = ["/room/server.js"], enabled = true }';
  const startedWith = await codexOwnerIsolationOverrides(codex.bin, { cwd: project, env, configOverrides: [ROOM] });
  assert.ok(startedWith.includes('mcp_servers={ "owner_browser" = { enabled = false } }'));
  const commandLine = `codex app-server ${[...startedWith, ROOM].map((override) => `-c ${override}`).join(" ")} --listen ws://127.0.0.1:1`;
  // Started by this service, so its launch's own overrides are known; and found running, when they are not.
  const live = { commandLine, cwd: project, launchOverrides: [ROOM] };
  const found = { commandLine, cwd: project, launchOverrides: null };
  await assertLiveCodexIsolationUnchanged(codex.bin, live, env);
  await assertLiveCodexIsolationUnchanged(codex.bin, found, env);

  // The project the owner trusts gained a server since then: Codex would start it, with no sandbox, at the next load.
  const GAINED = "This project's Codex config, or your own, now has an MCP server or a skill that was not there when this agent started, "
    + "so LetAgents stopped the agent before Codex could load it. It starts again with it turned off, unless you paused it.";
  settle({ servers: ["owner_browser", "added_by_the_project"] });
  for (const process of [live, found]) await assert.rejects(assertLiveCodexIsolationUnchanged(codex.bin, process, env), (error: Error) => error.message === GAINED);
  // A server that is gone is no reason to stop: nothing new would start.
  settle({ servers: [] });
  await assertLiveCodexIsolationUnchanged(codex.bin, live, env);
  // The same when one of several is gone, and a skill: each is compared by its own name, not as one list.
  const several = ["first", 'odd"name', "third"];
  settle({ servers: several });
  for (const name of ["one", "two"]) {
    mkdirSync(join(owner.codexHome, "skills", name), { recursive: true });
    writeFileSync(join(owner.codexHome, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: test.\n---\n`);
  }
  const withSeveral = await codexOwnerIsolationOverrides(codex.bin, { cwd: project, env, configOverrides: [ROOM] });
  assert.equal(withSeveral.filter((override) => override.startsWith("mcp_servers={ ") || override.startsWith("skills.config=[")).length, 2);
  const startedWithSeveral = { cwd: project, launchOverrides: [ROOM], commandLine: `codex app-server ${[...withSeveral, ROOM].map((override) => `-c ${override}`).join(" ")}` };
  await assertLiveCodexIsolationUnchanged(codex.bin, startedWithSeveral, env);
  settle({ servers: ["third"] });
  execFileSync("rm", ["-r", join(owner.codexHome, "skills", "one")]);
  await assertLiveCodexIsolationUnchanged(codex.bin, startedWithSeveral, env);
  // A name is not found inside another one: a new server "name" is not taken for the 'odd"name' the process was started without.
  settle({ servers: ["third", "name"] });
  await assert.rejects(assertLiveCodexIsolationUnchanged(codex.bin, startedWithSeveral, env), (error: Error) => error.message === GAINED);
  // And one more skill is one more thing the process was not started without.
  settle({ servers: ["third"] });
  mkdirSync(join(owner.codexHome, "skills", "three"));
  writeFileSync(join(owner.codexHome, "skills", "three", "SKILL.md"), "---\nname: three\ndescription: test.\n---\n");
  await assert.rejects(assertLiveCodexIsolationUnchanged(codex.bin, startedWithSeveral, env), (error: Error) => error.message === GAINED);
  execFileSync("rm", ["-r", join(owner.codexHome, "skills")]);

  // The project now adds a key to the room's own server. No launch override takes that back, so a launch refuses it, and so does this.
  settle({ servers: ["owner_browser"], projectChangesRoomServer: true });
  await assert.rejects(assertLiveCodexIsolationUnchanged(codex.bin, live, env), /^Error: This project's Codex config changes the LetAgents MCP server, so LetAgents will not start Codex here\./);
  // The project sets only keys of that server that the launch's own override sets too. Codex gives the override the last word,
  // so a launch accepts that project, and the server is listed for the comparison as that launch listed it: with the override.
  settle({ servers: ["owner_browser"], projectSetsRoomServerKeys: true });
  const before = codex.calls().length;
  await assertLiveCodexIsolationUnchanged(codex.bin, live, env);
  const listings = codex.calls().slice(before).filter((call) => call.args[0] === "mcp");
  assert.equal(listings.length, 2);
  for (const listing of listings) assert.ok(listing.args.includes(ROOM), "listed with the launch's own override");
  // For a process that was found running the override is not known. Its project may then not name the room's server at all,
  // and its owner is told what is known: the next start compares.
  const NOT_COMPARED = "This project's Codex config has settings of its own for the LetAgents MCP server. This agent's Codex was started before LetAgents last restarted, "
    + "so LetAgents cannot compare those settings with what the agent was started with, and stopped the agent before Codex could load them. "
    + "LetAgents starts it again and compares them then, unless you paused it.";
  for (const settings of [{ projectSetsRoomServerKeys: true }, { projectChangesRoomServer: true }]) {
    settle({ servers: ["owner_browser"], ...settings });
    await assert.rejects(assertLiveCodexIsolationUnchanged(codex.bin, found, env), (error: Error) => { assert.equal(error.message, NOT_COMPARED); return true; });
  }

  // A personal skill the owner added is turned off at a launch, so it is one more thing the process was not started without.
  settle({ servers: ["owner_browser"] });
  mkdirSync(join(owner.codexHome, "skills", "new-skill"), { recursive: true });
  writeFileSync(join(owner.codexHome, "skills", "new-skill", "SKILL.md"), "---\nname: new-skill\ndescription: test.\n---\n");
  await assert.rejects(assertLiveCodexIsolationUnchanged(codex.bin, live, env), (error: Error) => error.message === GAINED);
  execFileSync("rm", ["-r", join(owner.codexHome, "skills")]);
  // A Codex that cannot list its servers, or a folder that is not known, is never taken as unchanged.
  settle({ servers: ["owner_browser"], listFails: true });
  for (const process of [live, found]) await assert.rejects(assertLiveCodexIsolationUnchanged(codex.bin, process, env), /Codex could not list its MCP servers/);
  settle({ servers: ["owner_browser"] });
  await assert.rejects(assertLiveCodexIsolationUnchanged(codex.bin, { ...live, cwd: null }, env), /could not tell which folder this Codex agent runs in/);
});
