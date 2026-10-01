import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

const env = createElectronTestEnv({
  prefix: "letagents-codex-launch-isolation-",
  paths: [],
  extraEnvFiles: { LETAGENTS_AGENT_COMMIT_IDENTITY_PATH: "agent-commit-identity.json" },
});
const FAKE_NOREPLY = "424242+octo-fake@users.noreply.github.com";
// Every Git probe and provider in this file sees a scratch HOME, never the owner's.
const scratchHome = join(env.tempDir, "scratch-home");
mkdirSync(scratchHome, { recursive: true });
writeFileSync(join(scratchHome, ".gitconfig"), "[user]\n\tname = Fake Owner\n\temail = owner@example.invalid\n");
process.env.HOME = scratchHome;
process.env.GIT_CONFIG_NOSYSTEM = "1";
writeFileSync(process.env.LETAGENTS_AGENT_COMMIT_IDENTITY_PATH!, JSON.stringify({
  version: 1,
  useHostGitIdentity: false,
  githubAccount: { login: "octo-fake", id: "424242" },
}));

const {
  CODEX_OWNER_FEATURE_OVERRIDES,
  codexMcpServerDisableOverride,
  codexPersonalSkillFiles,
  codexSkillDisableOverride,
  listCodexMcpServerNames,
} = await import("../main/agents/codex-launch-isolation.js");
const {
  codexAppServerEnvironment,
  codexCommitIdentityOverrides,
  launchManagedCodexAppServer,
  terminateSpawnedProcess,
  waitForLaunchedCodexAppServer,
} = await import("../main/agents/codex-app-server.js");
const { CodexProviderAdapter } = await import("../main/agents/codex-provider-adapter.js");
const { CodexRpcClient } = await import("../main/agents/codex-rpc-client.js");
const { resolveCodexExecutable } = await import("../main/agents/codex-executable.js");

let fixtureSerial = 0;
function fixture(name: string): string {
  const path = join(env.tempDir, `${name}-${fixtureSerial++}`);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A repository whose commits would otherwise use the scratch global identity. */
function githubRepo(name: string): string {
  const repo = fixture(name);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/fake-org/fake-repo.git"], { cwd: repo });
  return repo;
}

function writeSkill(directory: string, name: string, marker = name): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  writeFileSync(path, `---\nname: ${name}\ndescription: ${marker} test skill.\n---\nBody.\n`);
  return path;
}

/** A stand-in Codex binary: lists MCP servers and records every invocation. */
function fakeCodex(): { bin: string; report: string; calls: () => Array<{ args: string[]; cwd: string; env: Record<string, string | null> }> } {
  const directory = fixture("fake-codex");
  const bin = join(directory, "codex");
  const report = join(directory, "calls.jsonl");
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    "const { appendFileSync } = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const pick = (key) => process.env[key] ?? null;",
    "appendFileSync(process.env.FAKE_CODEX_REPORT, JSON.stringify({ args, cwd: process.cwd(), env: {",
    "  CODEX_HOME: pick('CODEX_HOME'), GIT_AUTHOR_NAME: pick('GIT_AUTHOR_NAME'), GIT_AUTHOR_EMAIL: pick('GIT_AUTHOR_EMAIL'),",
    "  GIT_COMMITTER_NAME: pick('GIT_COMMITTER_NAME'), GIT_COMMITTER_EMAIL: pick('GIT_COMMITTER_EMAIL'),",
    "} }) + '\\n');",
    "if (args[0] === 'mcp') {",
    "  if (process.env.FAKE_CODEX_MCP_FAIL === '1') { process.stderr.write('config is broken\\n'); process.exit(3); }",
    "  process.stdout.write(JSON.stringify([{ name: 'owner_browser' }, { name: 'owner.dotted' }, { name: 'letagents' }]));",
    "}",
    "",
  ].join("\n"), { mode: 0o755 });
  return {
    bin,
    report,
    calls: () => existsSync(report)
      ? readFileSync(report, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [],
  };
}

function overridesOf(args: string[]): string[] {
  return args.flatMap((arg, index) => args[index - 1] === "-c" ? [arg] : []);
}

async function waitForExit(launch: { exited: Promise<unknown> }): Promise<void> {
  const keepAlive = setInterval(() => {}, 50);
  try {
    await launch.exited;
  } finally {
    clearInterval(keepAlive);
  }
}

test("personal Codex skills are found in CODEX_HOME and ~/.agents, but not Codex's bundled ones", () => {
  const home = fixture("home");
  const codexHome = join(home, ".codex");
  const personal = writeSkill(join(codexHome, "skills", "scope-guard"), "scope-guard");
  const grouped = writeSkill(join(codexHome, "skills", "design", "motion"), "motion");
  writeSkill(join(codexHome, "skills", ".system", "imagegen"), "imagegen");
  const agents = writeSkill(join(home, ".agents", "skills", "notes"), "notes");
  const linkedTarget = writeSkill(join(fixture("elsewhere"), "linked"), "linked");
  symlinkSync(join(linkedTarget, ".."), join(codexHome, "skills", "linked"));

  const files = codexPersonalSkillFiles({ HOME: home, CODEX_HOME: codexHome });

  assert.ok(files.includes(personal));
  assert.ok(files.includes(grouped));
  assert.ok(files.includes(agents));
  assert.ok(files.includes(join(codexHome, "skills", "linked", "SKILL.md")));
  assert.ok(files.includes(realpathSync(linkedTarget)));
  assert.equal(files.some((file) => file.includes(".system")), false);
  const deepest = writeSkill(join(codexHome, "skills", "d1", "d2", "d3", "d4", "d5", "d6"), "deepest");
  const tooDeep = writeSkill(join(codexHome, "skills", "e1", "e2", "e3", "e4", "e5", "e6", "e7"), "too-deep");
  const deepFiles = codexPersonalSkillFiles({ HOME: home, CODEX_HOME: codexHome });
  assert.ok(deepFiles.includes(deepest), "Codex still finds a skill six directories down");
  assert.equal(deepFiles.includes(tooDeep), false, "Codex stops looking below that");
  assert.deepEqual(codexPersonalSkillFiles({ HOME: fixture("empty-home") }), []);
});

test("Codex override builders disable named skills and every MCP server but LetAgents", () => {
  assert.equal(codexSkillDisableOverride([]), null);
  assert.equal(
    codexSkillDisableOverride(["/home/fake/.codex/skills/a/SKILL.md"]),
    'skills.config=[{ path = "/home/fake/.codex/skills/a/SKILL.md", enabled = false }]',
  );
  assert.equal(codexMcpServerDisableOverride(["letagents"]), null);
  assert.equal(
    codexMcpServerDisableOverride(["owner.dotted", "letagents", "owner_browser", "owner_browser"]),
    'mcp_servers={ "owner.dotted" = { enabled = false }, "owner_browser" = { enabled = false } }',
  );
  assert.deepEqual([...CODEX_OWNER_FEATURE_OVERRIDES], [
    "features.plugins=false",
    "features.apps=false",
    "features.computer_use=false",
    "features.browser_use=false",
    "features.browser_use_external=false",
    "features.hooks=false",
    "features.memories=false",
    "notify=[]",
  ]);
});

test("the MCP server list fails closed when Codex cannot produce it", async () => {
  await assert.rejects(
    listCodexMcpServerNames("codex", { env: {}, configOverrides: [] }, async () => { throw new Error("spawn codex ENOENT"); }),
    /Codex could not list its MCP servers.*ENOENT/,
  );
  await assert.rejects(
    listCodexMcpServerNames("codex", { env: {}, configOverrides: [] }, async () => "Usage: codex mcp list"),
    /unreadable MCP server list/,
  );
  await assert.rejects(
    listCodexMcpServerNames("codex", { env: {}, configOverrides: [] }, async () => JSON.stringify([{ command: "x" }])),
    /unreadable MCP server list/,
  );
  assert.deepEqual(
    await listCodexMcpServerNames("codex", { env: {}, configOverrides: [] }, async () => JSON.stringify([{ name: "a" }])),
    ["a"],
  );
});

test("a managed Codex launch turns off the owner's extensions and commits as the GitHub noreply identity", async () => {
  const codex = fakeCodex();
  const home = fixture("launch-home");
  const codexHome = join(home, ".codex");
  const personal = writeSkill(join(codexHome, "skills", "scope-guard"), "scope-guard");
  const project = githubRepo("launch-project");

  const launch = await launchManagedCodexAppServer("ws://127.0.0.1:1", codex.bin, {
    trustedProjectPath: project,
    configOverrides: ['model="caller-model"'],
    env: { HOME: home, CODEX_HOME: codexHome, FAKE_CODEX_REPORT: codex.report },
  });
  await waitForExit(launch);

  const [list, server] = codex.calls();
  assert.deepEqual(list!.args.slice(0, 3), ["mcp", "list", "--json"]);
  assert.equal(realpathSync(list!.cwd), realpathSync(project));
  assert.deepEqual(overridesOf(list!.args), [
    `projects.${JSON.stringify(project)}.trust_level="trusted"`,
    ...CODEX_OWNER_FEATURE_OVERRIDES,
  ]);
  assert.equal(server!.args[0], "app-server");
  assert.deepEqual(overridesOf(server!.args), [
    `projects.${JSON.stringify(project)}.trust_level="trusted"`,
    ...CODEX_OWNER_FEATURE_OVERRIDES,
    codexSkillDisableOverride([...new Set([personal, realpathSync(personal)])]),
    'shell_environment_policy.set.GIT_AUTHOR_NAME="octo-fake"',
    `shell_environment_policy.set.GIT_AUTHOR_EMAIL=${JSON.stringify(FAKE_NOREPLY)}`,
    'shell_environment_policy.set.GIT_COMMITTER_NAME="octo-fake"',
    `shell_environment_policy.set.GIT_COMMITTER_EMAIL=${JSON.stringify(FAKE_NOREPLY)}`,
    'mcp_servers={ "owner.dotted" = { enabled = false }, "owner_browser" = { enabled = false } }',
    'model="caller-model"',
  ]);
  assert.deepEqual(server!.env, {
    CODEX_HOME: codexHome,
    GIT_AUTHOR_NAME: "octo-fake",
    GIT_AUTHOR_EMAIL: FAKE_NOREPLY,
    GIT_COMMITTER_NAME: "octo-fake",
    GIT_COMMITTER_EMAIL: FAKE_NOREPLY,
  });
});

test("a managed Codex launch does not start when its MCP servers cannot be listed", async () => {
  const codex = fakeCodex();
  await assert.rejects(
    launchManagedCodexAppServer("ws://127.0.0.1:1", codex.bin, {
      trustedProjectPath: fixture("failing-project"),
      env: { FAKE_CODEX_REPORT: codex.report, FAKE_CODEX_MCP_FAIL: "1" },
    }),
    /Codex could not list its MCP servers/,
  );
  assert.deepEqual(codex.calls().map((call) => call.args[0]), ["mcp"]);
});

test("rental Codex launches keep their isolated environment without the owner's commit identity", () => {
  const repo = githubRepo("environment-project");
  const ordinary = codexAppServerEnvironment({ trustedProjectPath: repo, env: { FAKE_CANARY: "kept" } });
  assert.equal(ordinary.env.GIT_AUTHOR_EMAIL, FAKE_NOREPLY);
  assert.equal(ordinary.env.FAKE_CANARY, "kept");
  assert.deepEqual(codexCommitIdentityOverrides(ordinary.commitEnvironment), [
    'shell_environment_policy.set.GIT_AUTHOR_NAME="octo-fake"',
    `shell_environment_policy.set.GIT_AUTHOR_EMAIL=${JSON.stringify(FAKE_NOREPLY)}`,
    'shell_environment_policy.set.GIT_COMMITTER_NAME="octo-fake"',
    `shell_environment_policy.set.GIT_COMMITTER_EMAIL=${JSON.stringify(FAKE_NOREPLY)}`,
  ]);

  const rental = codexAppServerEnvironment({
    trustedProjectPath: repo,
    env: { LETAGENTS_RENTAL_CREDENTIAL_ISOLATION: "1", FAKE_CANARY: "dropped" },
  });
  assert.deepEqual(rental.commitEnvironment, {});
  assert.equal(rental.env.GIT_AUTHOR_EMAIL, undefined);
  assert.equal(rental.env.FAKE_CANARY, undefined);
});

test("the Codex provider adapter launches its app-server through the managed launch", async () => {
  const codex = fakeCodex();
  const project = githubRepo("adapter-project");
  const adapter = new CodexProviderAdapter({
    codexBin: codex.bin,
    dependencies: {
      resolveServerUrl: async () => "ws://127.0.0.1:1",
      waitForServer: async (_url, launch) => { await waitForExit(launch); return false; },
      signalProcess: () => {},
    },
  });
  const previousReport = process.env.FAKE_CODEX_REPORT;
  process.env.FAKE_CODEX_REPORT = codex.report;
  try {
    await assert.rejects(adapter.spawn({
      workAttemptId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      roomId: "room_fake",
      agentDisplayName: "FakeAgent",
      cwd: project,
      launchPolicy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
    }), /Timed out waiting for Codex app-server/);
  } finally {
    if (previousReport === undefined) delete process.env.FAKE_CODEX_REPORT;
    else process.env.FAKE_CODEX_REPORT = previousReport;
  }
  const [list, server] = codex.calls();
  assert.deepEqual(list!.args.slice(0, 3), ["mcp", "list", "--json"]);
  const overrides = overridesOf(server!.args);
  for (const override of CODEX_OWNER_FEATURE_OVERRIDES) assert.ok(overrides.includes(override), override);
  assert.ok(overrides.includes('mcp_servers={ "owner.dotted" = { enabled = false }, "owner_browser" = { enabled = false } }'));
  assert.equal(server!.env.GIT_AUTHOR_EMAIL, FAKE_NOREPLY);
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

async function freeLoopbackUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `ws://127.0.0.1:${port}`;
}

const realCodex = installedCodex();

test("the installed Codex loads none of the owner's plugins, personal skills or MCP servers", {
  skip: realCodex ? false : "Codex is not installed",
  timeout: 120_000,
}, async () => {
  const codexBin = realCodex!;
  const home = fixture("contract-home");
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const fakeMcp = join(fixture("contract-mcp"), "owner-mcp.mjs");
  writeFileSync(fakeMcp, [
    "import { createInterface } from 'node:readline';",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "createInterface({ input: process.stdin }).on('line', (line) => {",
    "  let m; try { m = JSON.parse(line); } catch { return; }",
    "  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'owner', version: '1' } } });",
    "  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'owner_tool', inputSchema: { type: 'object', properties: {} } }] } });",
    "  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });",
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(codexHome, "config.toml"), [
    // Drops inherited variables from commands, so only the shell policy can deliver the identity.
    "[shell_environment_policy]",
    'inherit = "core"',
    "",
    "[mcp_servers.owner_browser]",
    'command = "node"',
    `args = [${JSON.stringify(fakeMcp)}]`,
    "",
    '[mcp_servers."owner.dotted"]',
    'command = "node"',
    `args = [${JSON.stringify(fakeMcp)}]`,
    "",
  ].join("\n"));
  writeSkill(join(codexHome, "skills", "owner-skill"), "owner-skill");
  const hookMarker = join(fixture("contract-hook"), "ran");
  writeFileSync(join(codexHome, "hooks.json"), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: `touch ${hookMarker}` }] }],
    PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `touch ${hookMarker}-pre` }] }],
  } }));
  writeSkill(join(home, ".agents", "skills", "owner-agents-skill"), "owner-agents-skill");

  const market = fixture("contract-market");
  mkdirSync(join(market, ".agents", "plugins"), { recursive: true });
  writeFileSync(join(market, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "fake-market",
    interface: { displayName: "Fake" },
    plugins: [{ name: "fake-cu", source: { source: "local", path: "./plugins/fake-cu" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }],
  }));
  const plugin = join(market, "plugins", "fake-cu");
  mkdirSync(join(plugin, ".codex-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "fake-cu", version: "1.0.0", description: "Fake computer use", author: { name: "Test" },
    skills: "./skills/", mcpServers: "./.mcp.json", interface: { displayName: "Fake CU" },
  }));
  writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { fake_cua: { command: "node", args: [fakeMcp] } } }));
  writeSkill(join(plugin, "skills", "fake-cu-skill"), "fake-cu-skill");
  const codexEnv = { ...process.env, HOME: home, CODEX_HOME: codexHome };
  execFileSync(codexBin, ["plugin", "marketplace", "add", market], { env: codexEnv, stdio: "ignore", timeout: 30_000 });
  execFileSync(codexBin, ["plugin", "add", "fake-cu@fake-market"], { env: codexEnv, stdio: "ignore", timeout: 30_000 });

  const project = githubRepo("contract-project");
  writeSkill(join(project, ".agents", "skills", "repo-skill"), "repo-skill");

  const serverUrl = await freeLoopbackUrl();
  const launch = await launchManagedCodexAppServer(serverUrl, codexBin, {
    trustedProjectPath: project,
    // Shaped like the supervised launch's own room server.
    configOverrides: [`mcp_servers.letagents={ command = "node", args = [${JSON.stringify(fakeMcp)}], enabled = true }`],
    env: { HOME: home, CODEX_HOME: codexHome },
  });
  const client = new CodexRpcClient(serverUrl, () => {});
  try {
    assert.equal(await waitForLaunchedCodexAppServer(serverUrl, launch, 60_000), true);
    await client.connect();
    const skills = await client.request<{ data: Array<{ skills: Array<{ name: string; enabled: boolean; scope: string }> }> }>(
      "skills/list", { cwds: [project], forceReload: true });
    const byName = new Map(skills.data.flatMap((entry) => entry.skills).map((skill) => [skill.name, skill]));
    assert.equal(byName.get("repo-skill")?.enabled, true, "the project's own skill still loads");
    assert.equal(byName.get("owner-skill")?.enabled, false);
    assert.equal(byName.get("owner-agents-skill")?.enabled, false);
    assert.equal([...byName.keys()].some((name) => name.includes("fake-cu")), false, "plugin skills are gone");

    const hooks = await client.request<{ data: Array<{ hooks: unknown[] }> }>("hooks/list", { cwds: [project] });
    assert.ok(hooks.data.length > 0);
    assert.deepEqual(hooks.data.flatMap((entry) => entry.hooks), [], "the owner's hooks are not loaded");

    const mcp = await client.request<{ data: Array<{ name: string; tools?: Record<string, unknown> }> }>("mcpServerStatus/list", {});
    const servers = new Map(mcp.data.map((server) => [server.name, Object.keys(server.tools ?? {})]));
    assert.equal(servers.has("fake_cua"), false, "plugin MCP servers are gone");
    assert.deepEqual(servers.get("letagents"), ["owner_tool"], "the room's own server still starts");
    assert.deepEqual(servers.get("owner_browser"), []);
    assert.deepEqual(servers.get("owner.dotted"), []);

    const commandEnv = await client.request<{ stdout: string }>("command/exec", {
      command: ["/usr/bin/env"], cwd: project, sandboxPolicy: { type: "dangerFullAccess" },
    });
    assert.match(commandEnv.stdout, new RegExp(`^GIT_AUTHOR_EMAIL=${FAKE_NOREPLY.replace(/[+.]/g, "\\$&")}$`, "m"));
    assert.match(commandEnv.stdout, /^GIT_COMMITTER_NAME=octo-fake$/m);
  } finally {
    client.close();
    if (launch.pid !== null) terminateSpawnedProcess(launch.pid);
    await waitForExit(launch);
  }
});
