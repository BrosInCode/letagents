import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { basename, join } from "node:path";
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
  linkCodexAgentHome, sandboxedCodexHomeRefusal, sandboxedCodexLoadRefusal, sandboxedCodexProjectRefusal,
} = await import("../main/agents/codex-agent-home.js");
const { assertLayersAddNoCommandRules, inspectCodexSettings, projectRuleFolders } = await import("../main/agents/codex-home-harness.js");
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

const noProject = { projectLayers: [], credentialStore: "file", otherRuleFolders: [] };
/** What the owner is told about a project that has command rules of its own: what was found, what it would do, and the two ways out. */
const projectRulesRefusal = (folder: string, names: string) =>
  `This project has command rules for Codex in ${folder} (${names}). `
  + "A sandboxed Codex agent would run every command that matches one with no sandbox and no approval, "
  + "so LetAgents does not start Codex here, or give it work, at this access level. "
  + `Remove or rename ${folder}, or give this agent Full access if you accept that.`;
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
    assert.equal(error.message, projectRulesRefusal(".codex/rules", "default.rules"));
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
function fakeCodex(settings: { signIn?: "in-place" | "replace" | "none"; store?: string; layers?: unknown[] } = {}): {
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
    "if (args[0] === 'mcp') process.stdout.write(JSON.stringify([{ name: 'letagents', enabled: true, transport: { type: 'stdio', command: 'npx', args: ['-y', 'letagents'], env: null } }]));",
    "if (args[0] === 'app-server' && args.includes('stdio://')) {",
    "  const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "  require('node:readline').createInterface({ input: process.stdin }).on('line', async (line) => {",
    "    const m = JSON.parse(line);",
    "    if (m.method === 'initialize') send({ id: m.id, result: {} });",
    "    if (m.method === 'config/read') send({ id: m.id, result: { config: { cli_auth_credentials_store: settings.store }, layers: settings.layers ?? [] } });",
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
async function stubModel(): Promise<{ port: number; plan: Array<() => ModelItem[]>; requests: Array<Record<string, unknown>>; close(): void }> {
  const plan: Array<() => ModelItem[]> = [];
  const requests: Array<Record<string, unknown>> = [];
  const server = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (request.method !== "POST" || !String(request.url).endsWith("/responses")) {
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
  return { port: (server.address() as { port: number }).port, plan, requests, close: () => server.close() };
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
      `Codex also reads command rules from ${join(machine, "rules")}, a folder of this computer's own Codex settings, and a command that matches one runs outside this agent's sandbox. `
      + "That folder has entries LetAgents cannot check (site.rules), so LetAgents will not start Codex at this access level. "
      + `Remove the rules from ${join(machine, "rules")} (this can need an administrator), or give this agent Full access.`);
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
    "Codex wrote files of its own in the folder LetAgents keeps for sandboxed Codex agents (codex-agent-home in your .letagents folder): config.toml. "
    + "Sandboxed agents use those, not the ones in your Codex home, so they do not see your later changes there. "
    + "LetAgents does not delete them, because they can hold conversations. To use your own again, stop the sandboxed Codex agents and delete them.",
  ]);
  assert.equal(readFileSync(join(owner.agentHome, "config.toml"), "utf8"), 'model = "a-copy"\n');

  // Its own config trusts a project that ships rules: the owner's home did not, so only the second answer shows it.
  const project = fixture("project");
  mkdirSync(join(project, ".codex", "rules"), { recursive: true });
  writeFileSync(join(project, ".codex", "rules", "allow.rules"), ALLOW_RULE);
  mkdirSync(join(project, "inner"));
  answers.push(noProject, { ...noProject, projectLayers: [{ dotCodexFolder: join(project, ".codex"), config: {} }] } as typeof noProject);
  // The project is no repository, and the rules are in a folder above the agent's: only Codex's own answer names that folder.
  await assert.rejects(codexHomeForSandboxedLaunch("codex", { cwd: join(project, "inner"), env: owner.env }, deps), (error: Error) => error.message.startsWith("This project has command rules for Codex in "));

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
  assert.match((await refusal(owner.codexHome))!, /^This project has command rules for Codex in .*\.codex[\\/]rules \(allow\.rules\)\./);
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
