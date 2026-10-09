import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
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
  CodexAgentHomeSignInError, checkCodexKeepsLinkedSignIn, codexAgentHomeDirectory, codexHomeForSandboxedLaunch, linkCodexAgentHome,
} = await import("../main/agents/codex-agent-home.js");
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

test("linking the agents' home again follows the owner's home: new entries, removed ones, and links that lead elsewhere", () => {
  const owner = ownerHome();
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  assert.deepEqual(entries(owner.agentHome), ["AGENTS.md@", "auth.json@", "config.toml@", "rules/", "sessions@"]);

  // The owner's home gains an entry and loses one, and one link was pointed at another folder.
  writeFileSync(join(owner.codexHome, "models_cache.json"), "{}");
  execFileSync("rm", [join(owner.codexHome, "AGENTS.md")]);
  const elsewhere = fixture("elsewhere");
  writeFileSync(join(elsewhere, "config.toml"), 'model = "not-the-owner"\n');
  execFileSync("ln", ["-sfn", join(elsewhere, "config.toml"), join(owner.agentHome, "config.toml")]);

  linkCodexAgentHome(owner.codexHome, owner.agentHome);

  assert.deepEqual(entries(owner.agentHome), ["auth.json@", "config.toml@", "models_cache.json@", "rules/", "sessions@"]);
  assert.equal(readFileSync(join(owner.agentHome, "config.toml"), "utf8"), 'model = "owner-model"\n');
});

test("a file Codex wrote over a link is the owner's file again at the next launch; what Codex made of its own is left alone", () => {
  const owner = ownerHome();
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  // Codex replaces its config by writing a new file over the old name.
  execFileSync("rm", [join(owner.agentHome, "config.toml")]);
  writeFileSync(join(owner.agentHome, "config.toml"), 'model = "a-copy"\n');
  mkdirSync(join(owner.agentHome, "made-here"));
  writeFileSync(join(owner.agentHome, "made-here.json"), "{}");

  linkCodexAgentHome(owner.codexHome, owner.agentHome);

  assert.deepEqual(entries(owner.agentHome), ["AGENTS.md@", "auth.json@", "config.toml@", "made-here/", "made-here.json", "rules/", "sessions@"]);
  assert.equal(readFileSync(join(owner.codexHome, "config.toml"), "utf8"), 'model = "owner-model"\n', "the owner's config was not written");
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
      + "Check that Codex is still signed in, then delete that file.");
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

const noProject = { projectLayers: [], credentialStore: "file" };

test("a sandboxed launch gets the agents' home when Codex keeps its sign-in in a file and rewrites it in place", async () => {
  const owner = ownerHome();
  const asked: string[] = [];
  const home = await codexHomeForSandboxedLaunch("codex", { cwd: owner.home, env: owner.env }, {
    inspect: async (_bin, options) => { asked.push(`inspect ${options.cwd} ${options.env.CODEX_HOME}`); return noProject; },
    keepsLinkedSignIn: async () => { asked.push("sign-in check"); return true; },
  });
  assert.equal(home, owner.agentHome);
  assert.deepEqual(asked, [`inspect ${owner.home} ${owner.codexHome}`, "sign-in check"], "Codex is asked about the owner's home, before any link is made");
  assert.deepEqual(entries(owner.agentHome), ["AGENTS.md@", "auth.json@", "config.toml@", "rules/", "sessions@"]);
});

test("when the agents' home cannot be used, a sandboxed launch runs with the owner's home only if it holds no saved rule", async () => {
  const cases: Array<{ name: string; deps: Parameters<typeof codexHomeForSandboxedLaunch>[2]; why: RegExp }> = [
    { name: "a sign-in kept in the keychain", why: /Codex does not keep its sign-in in a file in its home folder/,
      deps: { inspect: async () => ({ projectLayers: [], credentialStore: "keyring" }), keepsLinkedSignIn: async () => { throw new Error("not asked"); } } },
    { name: "a Codex that does not say where its sign-in is", why: /Codex does not keep its sign-in in a file in its home folder/,
      deps: { inspect: async () => ({ projectLayers: [], credentialStore: null }), keepsLinkedSignIn: async () => { throw new Error("not asked"); } } },
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
      assert.match(error.message, /So it will not start Codex at this access level\. Remove the saved rules, or give this agent Full access\.$/, testCase.name);
      assert.ok(!error.message.includes(withRules.home), "the message names no folder of this machine");
      return true;
    });
    assert.equal(existsSync(withRules.agentHome), false, testCase.name);

    const withoutRules = ownerHome({ rules: false });
    assert.equal(await codexHomeForSandboxedLaunch("codex", { env: withoutRules.env }, testCase.deps), null, testCase.name);
    // An empty rules folder holds no rule; one that cannot be listed counts as holding one.
    mkdirSync(join(withoutRules.codexHome, "rules"));
    assert.equal(await codexHomeForSandboxedLaunch("codex", { env: withoutRules.env }, testCase.deps), null, testCase.name);
    writeFileSync(join(withoutRules.codexHome, "rules", "README"), "not a rule\n");
    await assert.rejects(codexHomeForSandboxedLaunch("codex", { env: withoutRules.env }, testCase.deps), /Codex has saved command rules/, testCase.name);
  }
});

test("a sandboxed launch does not start when Codex cannot be asked, when the agents' home holds a sign-in, or when the project ships command rules", async () => {
  const owner = ownerHome({ rules: false });
  await assert.rejects(
    codexHomeForSandboxedLaunch("codex", { env: owner.env }, { inspect: async () => { throw new Error("Codex stopped before it answered\nsecond line"); } }),
    /^Error: Codex could not report its settings, so LetAgents will not start it at a sandboxed access level: Codex stopped before it answered$/,
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
  const layers = { projectLayers: [{ dotCodexFolder: join(project, ".codex"), config: {} }, { dotCodexFolder: join(project, "packages", "app", ".codex"), config: {} }], credentialStore: "file" };
  const clean = ownerHome({ rules: false });
  await assert.rejects(
    codexHomeForSandboxedLaunch("codex", { cwd: join(project, "packages", "app"), env: clean.env }, { inspect: async () => layers, keepsLinkedSignIn: async () => true }),
    (error: Error) => {
      assert.equal(error.message,
        "Codex reads command rules from this project's packages/app/.codex/rules, and a command that matches one runs outside this agent's sandbox. "
        + "That folder has entries LetAgents cannot check (allow.rules), so LetAgents will not start Codex here at this access level. "
        + "Remove packages/app/.codex/rules from the repository and commit the removal, stop trusting the project in Codex, or give this agent Full access.");
      return true;
    },
  );
  assert.equal(existsSync(clean.agentHome), false, "nothing is linked for a launch that is refused");
  // A project layer Codex does not apply is not in the answer, and a rules folder with nothing in it holds no rule.
  execFileSync("rm", [join(project, "packages", "app", ".codex", "rules", "allow.rules")]);
  assert.equal(await codexHomeForSandboxedLaunch("codex", { cwd: project, env: clean.env }, { inspect: async () => layers, keepsLinkedSignIn: async () => true }), clean.agentHome);
});

/**
 * A stand-in Codex binary. It records every invocation next to itself, answers
 * the questions a launch asks a short-lived app-server, and refreshes a
 * sign-in file the way its `signIn` setting says: `in-place` rewrites the
 * file, `replace` writes a new file over the name, `none` leaves it.
 */
function fakeCodex(settings: { signIn?: "in-place" | "replace" | "none"; store?: string; reportsHome?: string } = {}): {
  bin: string; calls: () => Array<{ args: string[]; cwd: string; codexHome: string | null; refreshUrl: string | null; room: string | null }>;
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
    "  refreshUrl: process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? null, room: process.env.LETAGENTS_SUPERVISOR_ROOM_ID ?? null }) + '\\n');",
    "if (args[0] === 'mcp') process.stdout.write(JSON.stringify([{ name: 'letagents', enabled: true, transport: { type: 'stdio', command: 'npx', args: ['-y', 'letagents'], env: null } }]));",
    "if (args[0] === 'app-server' && args.includes('stdio://')) {",
    "  const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "  require('node:readline').createInterface({ input: process.stdin }).on('line', async (line) => {",
    "    const m = JSON.parse(line);",
    "    if (m.method === 'initialize') send({ id: m.id, result: {} });",
    "    if (m.method === 'config/read') send({ id: m.id, result: { config: { cli_auth_credentials_store: settings.store }, layers: [] } });",
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
  assert.equal(await checkCodexKeepsLinkedSignIn(fakeCodex({ signIn: "in-place" }).bin), true);
  assert.equal(await checkCodexKeepsLinkedSignIn(fakeCodex({ signIn: "replace" }).bin), false, "the link became a file of its own");
  assert.equal(await checkCodexKeepsLinkedSignIn(fakeCodex({ signIn: "none" }).bin), false, "the linked file never got the new token");
  assert.equal(await checkCodexKeepsLinkedSignIn(join(fixture("no-codex"), "codex")), false, "a Codex that cannot be run is not trusted");

  // The check gives Codex a scratch home and a token service on this machine, and nothing of the owner's.
  const codex = fakeCodex({ signIn: "in-place" });
  await checkCodexKeepsLinkedSignIn(codex.bin);
  const [call] = codex.calls();
  assert.match(call!.codexHome!, /letagents-codex-sign-in-check-/);
  assert.match(call!.refreshUrl!, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/token$/);
  assert.equal(existsSync(join(call!.codexHome!, "..")), false, "the scratch home is removed");
  // Codex is found through the launch's own PATH, and nothing else of the launch's environment reaches the check.
  assert.equal(await checkCodexKeepsLinkedSignIn(fakeCodex().bin, { PATH: "" }), false, "a Codex that needs a PATH it is not given cannot be run");
  const asked: string[] = [];
  const owner = ownerHome();
  await codexHomeForSandboxedLaunch("codex", { env: { ...owner.env, PATH: "launch-path" } }, {
    inspect: async () => noProject, keepsLinkedSignIn: async (_bin, launchEnv) => { asked.push(String(launchEnv.PATH)); return true; },
  });
  assert.deepEqual(asked, ["launch-path"]);
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
  assert.match(calls[1]!.codexHome!, /letagents-codex-sign-in-check-/);
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

  await assert.rejects(spawnWith(fixture("owner-home")), /Codex did not start with the home LetAgents gave it for this access level, so LetAgents stopped it\./);
  assert.deepEqual(signals, ["4242 SIGTERM"]);
  assert.deepEqual(closed, ["closed"]);
  // The same folder under another name is the same home, and so is a Codex too old to say.
  const alias = join(fixture("alias"), "home");
  symlinkSync(given, alias);
  for (const reported of [given, alias, null]) {
    await assert.rejects(spawnWith(reported), /asked nothing past the home/);
  }
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
  assert.equal(await checkCodexKeepsLinkedSignIn(realCodex!), true);
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
  const agentHome = await codexHomeForSandboxedLaunch(realCodex!, { cwd: workspace, env: { ...baseEnv, CODEX_HOME: owner.codexHome } });
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
