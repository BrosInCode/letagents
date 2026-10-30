import "./isolated-home.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ClaudeCodeProviderAdapter,
  claudeChildEnvironment,
  claudeCliEnv,
  claudeCliLaunchArgs,
  claudeLaunchPolicyArgs,
  claudeOwnerSetupReadsProjectInstructionsOnly,
  claudeOwnerSetupStartEnvironment,
  claudeStartWithoutModelText,
  createManagedClaudeMcpConfig,
  ownerMcpServerNotices,
  ownerMcpStartupTimeoutMs,
} from "../main/agents/claude-code-provider-adapter.js";
import type { ProviderSpawnRequest } from "../main/agents/provider-adapter.js";
import { assertOwnerPrivateFile } from "./harness.js";
import { CLAUDE_REAL_CAPTURES, realClaudeCapture, realClaudeResult } from "./claude-result-shapes.js";
import {
  ProviderSchedulerFailureCoordinator,
  type HarnessOptions,
  argValue,
  createHarness,
  spawnRequest,
  withLoopAlive,
  claudeDaemonFixture,
  ROOM_SERVER,
  OWNER_SERVER,
  OWNER_START_ENV,
  OWNER_START_SETTINGS,
  SUPERVISED,
  OWN_SETUP,
  ownSetupAskPolicy,
  STORED_CLAUDE_OPTIONS,
  pause,
} from "./claude-code-provider-adapter.fixture.js";

test("Claude starts exactly as before without the owner's own setup, and reads the owner's servers and settings with it", async () => {
  const launch = async (homeHarness: boolean, permissionProfileId: string, launchPolicy: Record<string, unknown>) => {
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [OWNER_SERVER, ROOM_SERVER],
      initPermissionMode: String(launchPolicy.permissionMode), commitEnvironment: { GIT_AUTHOR_NAME: "octo-fake" } });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    await adapter.spawn(spawnRequest({
      configurationRevision: 4, permissionProfileId, launchPolicy,
      ...SUPERVISED,
      supervisorWorkerSession: { agentSessionId: "session-1", roomCursor: null, apiUrl: "https://letagents.invalid" },
      ...(homeHarness ? { homeHarness: true } : {}),
    }));
    return { ...harness.launches[0]!, launch: harness.launches[0]!, mcpConfig: harness.mcpConfigRequests[0]! };
  };
  // What makes a process on this machine the room agent: the daemon answers whoever holds these.
  const coordinates = {
    LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_owner",
    LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/fake-daemon.sock",
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: "wa-claude-1",
    LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "generation-1",
    LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: "session-1",
    LETAGENTS_SUPERVISOR_ROOM_ID: "github.com/example/repo",
    LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: "LanternRook",
    LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
    LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
    LETAGENTS_PERMISSION_PROFILE_ID: "ask_before_write",
  };

  const off = await launch(false, "ask_before_write", ownSetupAskPolicy(false));
  const session = argValue(off.args, "--session-id")!;
  assert.deepEqual(off.args, [
    "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--permission-prompt-tool", "stdio",
    "--strict-mcp-config",
    "--mcp-config", "/private/tmp/letagents-claude-mcp-test/mcp.json",
    "--permission-mode", "default",
    "--tools", "Read,Glob,Grep,Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch",
    "--allowed-tools", "mcp__letagents__*",
    "--setting-sources", "",
    "--settings", "{}",
    "--session-id", session,
  ], "without the owner's setup the launch is exactly the isolated one");

  const on = await launch(true, "ask_before_write", ownSetupAskPolicy(true));
  assert.deepEqual(on.args, [
    "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--permission-prompt-tool", "stdio",
    "--mcp-config", "/private/tmp/letagents-claude-mcp-test/mcp.json",
    "--permission-mode", "default",
    "--tools", "Read,Glob,Grep,Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Skill",
    "--allowed-tools", "mcp__letagents__*",
    "--setting-sources", "user",
    // Given on the command line so that the owner's own settings cannot replace them.
    "--settings", OWNER_START_SETTINGS,
    "--session-id", argValue(on.args, "--session-id")!,
  ], "the room's server is still named, approvals still travel over stdio, and no project settings are read");
  assert.equal(on.cwd, off.cwd);

  // Without the owner's setup the coordinates are in the CLI's environment, where only the room's server inherits them.
  assert.deepEqual(off.env, { GIT_AUTHOR_NAME: "octo-fake", ...coordinates });
  assert.deepEqual(off.launch, { claudeBin: off.claudeBin, args: off.args, cwd: off.cwd, env: off.env }, "and the launch is marked in no other way");
  assert.equal(off.mcpConfig.length, 1, "the room server's config is asked for exactly as before");
  // With it, Claude hands its environment to the owner's servers and hooks too, so the coordinates go to the room's server alone.
  assert.deepEqual(on.env, { GIT_AUTHOR_NAME: "octo-fake", ...OWNER_START_ENV },
    "beside the commit identity, only how Claude is to start the owner's servers");
  for (const name of Object.keys(OWNER_START_ENV)) assert.equal(Object.hasOwn(off.env ?? {}, name), false, name);
  assert.equal(on.launch.ownerSetup, true);
  assert.deepEqual(on.mcpConfig[1], coordinates);

  // Full access names no setting sources: it reads the owner's, the project's and the folder's own.
  const fullAccess = { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true };
  const fullOff = await launch(false, "full_access", fullAccess);
  const fullOn = await launch(true, "full_access", fullAccess);
  assert.deepEqual(fullOff.args, [
    "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--strict-mcp-config",
    "--mcp-config", "/private/tmp/letagents-claude-mcp-test/mcp.json",
    "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions",
    "--session-id", argValue(fullOff.args, "--session-id")!,
  ], "without the owner's setup a Full access launch is exactly what it was");
  assert.deepEqual(fullOff.env, { GIT_AUTHOR_NAME: "octo-fake", ...coordinates, LETAGENTS_PERMISSION_PROFILE_ID: "full_access" });
  // With the owner's setup it reads the owner's settings alone, so nothing of the project's runs beside the owner's tools,
  // and it is given its own work folder as an added directory so that the project's CLAUDE.md still loads.
  const withInstructions = { ...OWNER_START_ENV, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" };
  assert.deepEqual(fullOn.args, [
    "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--mcp-config", "/private/tmp/letagents-claude-mcp-test/mcp.json",
    "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions",
    "--settings", JSON.stringify({ env: withInstructions }),
    "--setting-sources", "user",
    "--add-dir", fullOn.cwd,
    "--session-id", argValue(fullOn.args, "--session-id")!,
  ]);
  assert.equal(fullOn.cwd, spawnRequest().cwd, "the added directory is the agent's own work folder and nothing else");
  assert.deepEqual(fullOn.env, { GIT_AUTHOR_NAME: "octo-fake", ...withInstructions });
  // The other access levels never read a project's instructions, so they are given no added directory.
  assert.equal(on.args.includes("--add-dir"), false);
  assert.equal(Object.hasOwn(on.env ?? {}, "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"), false);
});

test("with the owner's own setup the Claude CLI's environment carries nothing that lets a process act as the room agent", () => {
  const ambient = {
    PATH: "/usr/bin", HOME: "/Users/fake", LETAGENTS_API_URL: "https://letagents.invalid",
    // A desktop app started from inside an agent's shell has these in its own environment.
    LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_other", LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/other.sock",
    LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn", LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
    LETAGENTS_PERMISSION_PROFILE_ID: "full_access", LETAGENTS_TOKEN: "fake-owner-token", LETAGENTS_AGENT_SESSION_BEARER: "fake-bearer",
  };
  assert.deepEqual(claudeChildEnvironment({ env: { GIT_AUTHOR_NAME: "octo-fake" }, ownerSetup: true }, ambient), {
    PATH: "/usr/bin", HOME: "/Users/fake", LETAGENTS_API_URL: "https://letagents.invalid", GIT_AUTHOR_NAME: "octo-fake",
  });
  // Without the owner's setup the environment is the one every launch had before.
  assert.deepEqual(claudeChildEnvironment({ env: { GIT_AUTHOR_NAME: "octo-fake" } }, ambient), claudeCliEnv(ambient, { GIT_AUTHOR_NAME: "octo-fake" }));
  assert.equal(claudeChildEnvironment({}, ambient).LETAGENTS_SUPERVISOR_ENTRY_ID, "supervised_other");
});

test("the room server's config carries the coordinates only when the launch hands them over", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-claude-room-config-"));
  try {
    const runtime = () => ({ entryPath: "/fake/letagents-mcp.js" }) as never;
    const read = async (roomServerEnvironment?: Record<string, string>) => {
      const config = await createManagedClaudeMcpConfig("https://letagents.invalid", directory, undefined, runtime, roomServerEnvironment);
      try {
        assertOwnerPrivateFile(config.path, directory); // only the owner can read it
        return { text: await readFile(config.path, "utf8") };
      } finally {
        await config.dispose();
      }
    };
    const isolated = await read();
    assert.equal(isolated.text, JSON.stringify({ mcpServers: { letagents: {
      command: process.execPath, args: ["/fake/letagents-mcp.js"], env: { LETAGENTS_API_URL: "https://letagents.invalid", ELECTRON_RUN_AS_NODE: "1" },
    } } }), "without the owner's setup the file is byte for byte the one written before");
    const ownSetup = await read({ LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_owner", LETAGENTS_API_URL: "https://elsewhere.invalid" });
    assert.deepEqual(JSON.parse(ownSetup.text).mcpServers.letagents.env, {
      LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_owner", LETAGENTS_API_URL: "https://letagents.invalid", ELECTRON_RUN_AS_NODE: "1",
    }, "the endpoint is always the launch's own");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude is refused the owner's own setup outside a daemon-supervised room agent", async () => {
  const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [ROOM_SERVER] });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(adapter.spawn(spawnRequest({
    configurationRevision: 4, permissionProfileId: "ask_before_write", launchPolicy: ownSetupAskPolicy(true), homeHarness: true,
  })), /only as a daemon-supervised room agent/);
  assert.equal(harness.launches.length, 0);
  assert.equal(harness.mcpConfigRequests.length, 0);
});

test("the owner's MCP servers get Claude's own time to start, a smaller limit of the owner's is kept, and a larger one is capped", () => {
  for (const [configured, expected] of [
    [undefined, 30_000], ["", 30_000], ["5000", 5_000], [" 7000 ", 7_000], ["30000", 30_000], ["45000", 45_000],
    ["45001", 45_000], ["600000", 45_000], ["999999999", 45_000],
    // Anything that is not a plain positive number of milliseconds is not the owner's limit.
    ["0", 30_000], ["-1", 30_000], ["1e3", 30_000], ["3000ms", 30_000], ["0x10", 30_000], ["3000.5", 30_000], ["1234567890", 30_000],
  ] as const) assert.equal(ownerMcpStartupTimeoutMs(configured), expected, String(configured));
});

test("each of the owner's MCP servers that did not connect is named, and the room's own never is", () => {
  assert.deepEqual(ownerMcpServerNotices({ mcp_servers: [
    { name: "owner_ok", status: "connected", source: "user" },
    { name: "owner_silent", status: "failed", source: "user" },
    { name: "owner_slow", status: "pending", source: "user" },
    { name: "owner_login", status: "needs-auth", source: "user" },
    { name: "owner_other", status: "disabled", source: "user" },
    { name: "letagents", status: "failed", source: "dynamic" },
    { name: "  ", status: "failed" }, { status: "failed" }, null, "owner_text",
  ] }), [
    'Your MCP server "owner_silent" did not start, so this agent is running without it.',
    'Your MCP server "owner_slow" was still starting when this agent began, so its tools may be missing.',
    'Your MCP server "owner_login" needs you to sign in, so this agent is running without it.',
    'Your MCP server "owner_other" did not start, so this agent is running without it.',
  ]);
  assert.deepEqual(ownerMcpServerNotices({}), []);
  assert.deepEqual(ownerMcpServerNotices({ mcp_servers: "none" }), []);
  // A name is the owner's own text: it is shown short and printable, and the list is bounded.
  const [long] = ownerMcpServerNotices({ mcp_servers: [{ name: `bad\u0007name-${"x".repeat(200)}`, status: "failed" }] });
  assert.match(long!, /^Your MCP server "bad\?name-x{55}" did not start/);
  assert.equal(ownerMcpServerNotices({ mcp_servers: Array.from({ length: 20 }, (_, index) => ({ name: `s${index}`, status: "failed" })) }).length, 8);
});

test("with the owner's own setup no stored Claude option reaches the command line, and without it every one still does", async () => {
  const launch = async (homeHarness: boolean, permissionProfileId: string, launchPolicy: Record<string, unknown>) => {
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [OWNER_SERVER, ROOM_SERVER], initPermissionMode: String(launchPolicy.permissionMode) });
    const handle = await new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest({
      configurationRevision: 4, permissionProfileId, launchPolicy, ...SUPERVISED,
      supervisorWorkerSession: { agentSessionId: "session-1", roomCursor: null, apiUrl: "https://letagents.invalid" },
      ...(homeHarness ? { homeHarness: true } : {}),
    }));
    const args = harness.launches[0]!.args;
    // The session is new at every launch; everything else is compared exactly.
    return { args: args.map((arg, index) => args[index - 1] === "--session-id" ? "<session>" : arg), env: harness.launches[0]!.env, notices: handle.launchNotices ?? [] };
  };
  const flagged = (args: readonly string[]) => args.filter((arg) => arg.startsWith("--"));
  const levels: Array<[string, (homeHarness: boolean) => Record<string, unknown>]> = [
    ["full_access", () => ({ permissionMode: "bypassPermissions", dangerouslySkipPermissions: true })],
    ["read_only", (on) => ({ permissionMode: "dontAsk", dangerouslySkipPermissions: false, tools: ["Read", "Glob", "Grep"], allowedTools: ["mcp__letagents__*"], settingSources: on ? "user" : "" })],
    ["ask_before_write", (on) => ownSetupAskPolicy(on)],
  ];
  for (const [permissionProfileId, level] of levels) {
    // The launch an agent with nothing else stored gets, with and without the owner's setup.
    const on = await launch(true, permissionProfileId, level(true));
    const off = await launch(false, permissionProfileId, level(false));
    assert.deepEqual(on.notices, [], permissionProfileId);
    // With the owner's setup every flag is there once, and these three are what the launch says they are.
    assert.equal(new Set(flagged(on.args)).size, flagged(on.args).length, `${permissionProfileId}: no flag is given twice`);
    assert.equal(argValue(on.args, "--setting-sources"), "user", permissionProfileId);
    assert.equal(on.args.includes("--strict-mcp-config"), false, permissionProfileId);
    assert.equal(argValue(on.args, "--mcp-config"), "/private/tmp/letagents-claude-mcp-test/mcp.json", permissionProfileId);
    assert.deepEqual(JSON.parse(argValue(on.args, "--settings")!), { env: on.env }, `${permissionProfileId}: the launch's own start settings`);
    assert.equal(argValue(on.args, "--add-dir") ?? null, permissionProfileId === "full_access" ? spawnRequest().cwd : null, permissionProfileId);

    for (const [option, value, what] of STORED_CLAUDE_OPTIONS) {
      // The asking levels refuse the other spelling of their own options at any launch, as they always did.
      if (permissionProfileId === "ask_before_write" && ["settings", "setting-sources", "allowed-tools", "permission-mode", "dangerously-skip-permissions"].includes(option)) continue;
      const name = `${permissionProfileId}: ${option} (${what})`;
      // An option the level decides itself stays the level's.
      const stored = (homeHarness: boolean) => ({ [option]: value, ...level(homeHarness) });
      const withOption = await launch(true, permissionProfileId, stored(true));
      assert.deepEqual(withOption.args, on.args, `${name}: the launch is the one with nothing else stored`);
      assert.deepEqual(withOption.env, on.env, name);
      assert.deepEqual(withOption.notices, Object.hasOwn(level(true), option) ? [] : [
        `With your own setup on, this agent starts with its access level's own Claude Code options only. These saved options were not used: ${JSON.stringify(option)}.`,
      ], `${name}: and the owner is told what was left out`);
      // Without the owner's setup the option is passed on exactly as it always was.
      const passedOn = await launch(false, permissionProfileId, stored(false));
      assert.deepEqual(passedOn.args, [
        ...off.args.slice(0, off.args.indexOf("--mcp-config") + 2),
        ...claudeLaunchPolicyArgs(stored(false)),
        ...off.args.slice(off.args.indexOf("--session-id")),
      ], `${name}: unchanged without the owner's setup`);
      assert.deepEqual(passedOn.notices, [], name);
    }
  }
});

test("a Claude agent is told which saved options were left out when they change, not at every start, and a failed start does not use the line up", async () => {
  const level = { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true };
  const told = async (agent: string, stored: Record<string, unknown>, over: { fails?: boolean; servers?: unknown[] } = {}) => {
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: (over.servers ?? [OWNER_SERVER, ROOM_SERVER]) as never, initPermissionMode: "bypassPermissions",
      ...(over.fails ? { bootstrapResultSubtype: "error_max_turns" } : {}) });
    return new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest({
      configurationRevision: 4, permissionProfileId: "full_access", launchPolicy: { ...level, ...stored }, ...OWN_SETUP, supervisorEntryId: agent,
      supervisorWorkerSession: { agentSessionId: "session-1", roomCursor: null, apiUrl: "https://letagents.invalid" },
    })).then((handle) => handle.launchNotices ?? [], (error: Error) => error);
  };
  const line = (...options: string[]) => `With your own setup on, this agent starts with its access level's own Claude Code options only. These saved options were not used: ${options.map((option) => JSON.stringify(option)).join(", ")}.`;
  const stored = { settingSources: "user,project,local" };
  assert.deepEqual(await told("supervised_said_once", stored), [line("settingSources")], "its first start says it");
  assert.deepEqual(await told("supervised_said_once", stored), [], "the same again says nothing");
  assert.deepEqual(await told("supervised_said_once", { settingSources: "project" }), [], "another value under the same name is not a change");
  assert.deepEqual(await told("supervised_said_once", { ...stored, pluginDir: "/repo" }), [line("settingSources", "pluginDir")], "a change is said");
  // What one of the owner's servers did is still said at every start.
  const silent = [OWNER_SERVER, { name: "owner_silent", status: "failed", source: "user" }, ROOM_SERVER];
  const serverLine = 'Your MCP server "owner_silent" did not start, so this agent is running without it.';
  assert.deepEqual(await told("supervised_said_once", { ...stored, pluginDir: "/repo" }, { servers: silent }), [serverLine]);
  assert.deepEqual(await told("supervised_said_once", { ...stored, pluginDir: "/repo" }, { servers: silent }), [serverLine]);
  // A start that failed after it was given the line never showed it, so the next one says it.
  assert.ok(await told("supervised_said_once_failed", stored, { fails: true }) instanceof Error);
  assert.deepEqual(await told("supervised_said_once_failed", stored), [line("settingSources")]);
  // One that failed without being given it, the line having been said before, changes nothing.
  assert.ok(await told("supervised_said_once_failed", stored, { fails: true, servers: silent }) instanceof Error);
  assert.deepEqual(await told("supervised_said_once_failed", stored), []);
  // What one agent was told says nothing about another.
  assert.deepEqual(await told("supervised_said_once_other", stored), [line("settingSources")]);
});

test("a flag the launch with the owner's own setup decides is set once, wherever it stood before", () => {
  const base = { approvalProfileLabel: null, homeHarness: true, ownerMcpStartupMs: 30_000, cwd: "/work/attempt", mcpConfigPath: "/room/mcp.json", session: { sessionId: "s-1" } };
  const clean = claudeCliLaunchArgs({ ...base, policyArgs: ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"] });
  const settings = argValue(clean, "--settings")!;
  // Arguments that already name the launch's own flags, first, last and twice: the answer is the same.
  for (const policyArgs of [
    ["--setting-sources", "user,project,local", "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"],
    ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions", "--setting-sources", "user,project,local"],
    ["--setting-sources", "project", "--permission-mode", "bypassPermissions", "--setting-sources", "local", "--dangerously-skip-permissions", "--setting-sources", "user,project,local"],
    ["--settings", '{"hooks":{}}', "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions", "--settings", '{"env":{"MCP_TIMEOUT":"1"}}'],
    ["--add-dir", "/somewhere/else", "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions", "--add-dir", "/another"],
  ]) {
    const args = claudeCliLaunchArgs({ ...base, policyArgs });
    for (const flag of ["--setting-sources", "--settings", "--add-dir", "--mcp-config"]) {
      assert.equal(args.filter((arg) => arg === flag).length <= 1, true, `${flag} in ${policyArgs.join(" ")}`);
    }
    assert.equal(argValue(args, "--setting-sources"), "user", policyArgs.join(" "));
    assert.equal(args.join(" ").includes("project"), false, policyArgs.join(" "));
    assert.equal(args.includes("/somewhere/else") || args.includes("/another"), false);
    assert.equal(argValue(args, "--settings")?.includes("hooks"), false);
    assert.equal(JSON.parse(argValue(args, "--settings")!).env.MCP_TIMEOUT, "30000");
    // Arguments that named the settings to read are not Full access as stored, so no folder is added for them.
    assert.equal(argValue(args, "--add-dir") ?? null, policyArgs.includes("--setting-sources") ? null : "/work/attempt");
  }
  assert.equal(argValue(clean, "--settings"), settings);
  // Without the owner's setup the arguments are passed on untouched, twice-named flags included.
  const off = claudeCliLaunchArgs({ ...base, homeHarness: false, policyArgs: ["--setting-sources", "user", "--setting-sources", "project", "--add-dir", "/x"] });
  assert.deepEqual(off.slice(off.indexOf("--mcp-config") + 2, -2), ["--setting-sources", "user", "--setting-sources", "project", "--add-dir", "/x"]);
});

test("an owner MCP server that did not start is reported on the handle, only for a launch with the owner's setup", async () => {
  const servers = [OWNER_SERVER, { name: "owner_silent", status: "failed", source: "user" }, { name: "owner_slow", status: "pending", source: "user" }, ROOM_SERVER];
  const launch = async (over: Partial<ProviderSpawnRequest>) => {
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: servers });
    return new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest({
      configurationRevision: 4, permissionProfileId: "ask_before_write", ...over,
    }));
  };
  const on = await launch({ launchPolicy: ownSetupAskPolicy(true), ...OWN_SETUP });
  assert.deepEqual(on.launchNotices, [
    'Your MCP server "owner_silent" did not start, so this agent is running without it.',
    'Your MCP server "owner_slow" was still starting when this agent began, so its tools may be missing.',
  ]);
  // The agent started all the same.
  assert.equal(on.observedState(), "idle");
  // Its handle says the process has the owner's setup: that is what later ends it when the owner turns it off.
  assert.equal(on.ownerSetup, true);
  const off = await launch({ launchPolicy: ownSetupAskPolicy(false), ...SUPERVISED });
  assert.deepEqual(off.launchNotices ?? [], []);
  assert.equal(off.ownerSetup, false);
});

test("the start waits for the owner's MCP servers on top of its usual budget, and only with the owner's setup", async () => {
  const start = (over: Partial<ProviderSpawnRequest>, ownerMcpTimeout?: string) => {
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", noInit: true });
    const adapter = new ClaudeCodeProviderAdapter({
      dependencies: { ...harness.dependencies, ownerMcpTimeout: () => ownerMcpTimeout }, initTimeoutMs: 40,
    });
    let settled: "pending" | Error = "pending";
    const spawned = adapter.spawn(spawnRequest({ configurationRevision: 4, permissionProfileId: "ask_before_write", ...over }));
    spawned.catch((error: Error) => { settled = error; });
    return { harness, spawned, state: () => settled };
  };
  // Without the owner's setup the budget is the one it always was.
  const offStarted = Date.now();
  const off = start({ launchPolicy: ownSetupAskPolicy(false), ...SUPERVISED }, "400");
  await assert.rejects(withLoopAlive(off.spawned), (error: Error) => {
    assert.ok(Date.now() - offStarted < 300, "it gives up after its usual 40 ms, not after the owner's limit as well");
    assert.match(error.message, /did not report its stream-json init/);
    assert.doesNotMatch(error.message, /your MCP servers/);
    return true;
  });
  assert.equal(Object.hasOwn(off.harness.launches[0]!.env ?? {}, "MCP_TIMEOUT"), false);

  // With it, Claude is told the limit and the launch waits that much longer for init.
  const on = start({ launchPolicy: ownSetupAskPolicy(true), ...OWN_SETUP }, "400");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(on.state(), "pending", "the usual 40 ms have long passed and the launch is still waiting");
  assert.equal(on.harness.launches[0]!.env?.MCP_TIMEOUT, "400");
  await assert.rejects(withLoopAlive(on.spawned), (error: Error) => {
    assert.match(error.message, /did not report its stream-json init/);
    assert.match(error.message, /This agent starts with your own Claude Code setup, so one of your MCP servers or hooks may be holding the start up\./);
    return true;
  });
  assert.equal(on.harness.children[0]!.alive, false, "a launch that still never reports is stopped, as before");
});

test("a start that ran out of time after Claude came up names the owner's servers that did not start", async () => {
  const servers = [OWNER_SERVER, { name: "owner_silent", status: "failed", source: "user" }, ROOM_SERVER];
  const start = (over: Partial<ProviderSpawnRequest>) => {
    // Claude reports init, and then the first turn never finishes.
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: servers, omitBootstrapResult: true });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: { ...harness.dependencies, ownerMcpTimeout: () => "60" }, initTimeoutMs: 40 });
    return adapter.spawn(spawnRequest({ configurationRevision: 4, permissionProfileId: "ask_before_write", ...over }));
  };
  await assert.rejects(withLoopAlive(start({ launchPolicy: ownSetupAskPolicy(true), ...OWN_SETUP })), (error: Error) => {
    assert.match(error.message, /did not complete its daemon-safe bootstrap turn \(deadline\)/);
    assert.match(error.message, /Your MCP server "owner_silent" did not start, so this agent is running without it\.$/);
    return true;
  });
  await assert.rejects(withLoopAlive(start({ launchPolicy: ownSetupAskPolicy(false), ...SUPERVISED })), (error: Error) => {
    assert.match(error.message, /did not complete its daemon-safe bootstrap turn \(deadline\)/);
    assert.doesNotMatch(error.message, /Your MCP server/, "an isolated agent's failure says nothing about the owner's servers");
    return true;
  });
});

test("a UserPromptSubmit hook that stops the prompt that starts a Claude agent fails the start in plain words, with what the owner can do and no word of the hook or of the prompt, and the start waits for the owner", async () => {
  const { ownerSetupRefusalReason } = await import(new URL("../../renderer/src/domain/agent-home-harness.ts", import.meta.url).href);
  const fullAccess = { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true };
  const stopped = "A UserPromptSubmit hook stopped the prompt that LetAgents sends to start this agent";
  const change = "Change the hook so that it lets this prompt through, then try again.";
  const withOwnSetup = `${stopped}, so the agent cannot start with your own setup while the hook stops that prompt. With your own setup on, Claude Code runs the hooks of your own Claude Code settings and plugins. ${change}`;
  // Real lines: what the CLI wrote for a prompt that a hook stopped. Here it is the prompt that starts the agent.
  const hookStops = (sessionId: string, turnId: string) => realClaudeCapture(CLAUDE_REAL_CAPTURES.hook_blocks_prompt!, sessionId, turnId).stream;
  const clisWords = ["PROMPT_HOOK_BLOCKS_THE_PROMPT", "/PATH", "Original prompt", "PROBE_OK", "blocked by hook"];
  assert.ok(clisWords.every((words) => JSON.stringify(hookStops("s", "t")).includes(words)));
  const launches: Array<{ name: string; over: Partial<ProviderSpawnRequest>; mode: string; lines?: typeof hookStops; reads: string }> = [
    // With the owner's setup, an access level that names its settings reads the owner's alone, and none with the setup off.
    { name: "the owner's setup, Ask before writes", over: { permissionProfileId: "ask_before_write", launchPolicy: ownSetupAskPolicy(true), ...OWN_SETUP }, mode: "default",
      reads: `${withOwnSetup} Or turn off "Use your own Claude Code setup" for this agent: it then reads none of your Claude Code settings, so their hooks do not run.` },
    // Full access names no settings: with the setup off it reads the owner's settings too, so that is no way out.
    { name: "the owner's setup, Full access", over: { permissionProfileId: "full_access", launchPolicy: fullAccess, ...OWN_SETUP }, mode: "bypassPermissions", reads: withOwnSetup },
    { name: "no owner's setup, Full access", over: { permissionProfileId: "full_access", launchPolicy: fullAccess, ...SUPERVISED }, mode: "bypassPermissions",
      reads: `${stopped}, so the agent cannot start while the hook stops that prompt. This agent runs the hooks of your Claude Code settings and of the project's settings. ${change}` },
    { name: "no owner's setup, Ask before writes", over: { permissionProfileId: "ask_before_write", launchPolicy: ownSetupAskPolicy(false), ...SUPERVISED }, mode: "default",
      reads: `${stopped}, so the agent cannot start while the hook stops that prompt. ${change}` },
    // A line of the stream that names a failure of the provider's that passes: the hook's stop is still no such failure.
    { name: "the owner's setup, after a line that names an overloaded provider", over: { permissionProfileId: "full_access", launchPolicy: fullAccess, ...OWN_SETUP }, mode: "bypassPermissions", reads: withOwnSetup,
      lines: (sessionId, turnId) => [{ type: "assistant", session_id: sessionId, error: "overloaded", message: { content: [{ type: "text", text: "busy" }] } }, ...hookStops(sessionId, turnId)] },
  ];
  for (const { name, over, mode, lines, reads } of launches) {
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [OWNER_SERVER, ROOM_SERVER], initPermissionMode: mode,
      omitBootstrapResult: true, bootstrapMessages: lines ?? hookStops });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 2_000 });
    const request = spawnRequest({ configurationRevision: 4, ...over });
    let rejected!: Error & { phase?: string; reason?: string; transientProviderStart?: true; providerQuotaExhausted?: true };
    await assert.rejects(withLoopAlive(adapter.spawn(request)), (error: Error) => { rejected = error; return true; });
    assert.equal(rejected.message, reads, name);
    assert.deepEqual([rejected.name, rejected.phase, rejected.reason], ["ClaudeBootstrapError", "bootstrap_turn", "failed_response"], name);
    for (const words of [...clisWords, "Startup observations", "result=", "failed_response", "bootstrap"]) assert.ok(!rejected.message.includes(words), `${name}: ${words}`);
    assert.equal(harness.children[0]!.alive, false, `${name}: the process that could not start is ended`);
    assert.equal(harness.launches.length, 1, name);

    // The hook stops the prompt at each start: nothing marks the failure as one that passes, so the daemon
    // tries no start again by itself. It saves the reason, and the agent waits for its owner.
    assert.deepEqual([rejected.transientProviderStart, rejected.providerQuotaExhausted], [undefined, undefined], name);
    const saved: Array<{ condition: string; message: string }> = [];
    const entry = { id: "entry-hook", desired_state: "running", observed_state: "recovering", condition: "none", work_attempt_id: request.workAttemptId };
    await new ProviderSchedulerFailureCoordinator({
      nativeHeartbeatIntervalMs: 1000, currentDaemonGeneration: () => 1, nowMs: () => 0,
      serializeEntry: async (_id: string, operation: () => Promise<unknown>) => operation(),
      serializeManifest: async (operation: () => Promise<unknown>) => operation(),
      manifest: { load: async () => ({ entries: [entry] }), updateEntry: async () => { throw new Error("the saved conversation is kept"); } },
      transitionOnce: async (_id: string, _state: string, condition: string, message: string) => { saved.push({ condition, message }); },
      audit: { append: async () => {} },
      scheduleRecovery: () => { throw new Error("no start is tried again by itself"); },
    }).record(entry.id, rejected, "test");
    assert.deepEqual(saved, [{ condition: "coordination_blocked", message: `convergence scheduler failure: ${reads}` }], name);
    // With the owner's setup the desktop shows the launch's own words, and nothing before them.
    assert.equal(ownerSetupRefusalReason(saved[0]!.message), over.homeHarness ? reads : null, name);
  }

  // A text of the CLI's own that is not its words for a hook: the cause is not known. The owner reads that the
  // model was not called, and the observations of the start, and nothing of the CLI's text.
  const harness = createHarness({ omitBootstrapResult: true, bootstrapMessages: (sessionId, turnId) =>
    [{ type: "result", subtype: "success", is_error: false, num_turns: 0, session_id: sessionId, user_message_uuid: turnId, result: "A text that the CLI wrote by itself." }] });
  await assert.rejects(withLoopAlive(new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 2_000 }).spawn(spawnRequest())), (error: Error & { transientProviderStart?: true; providerQuotaExhausted?: true }) => {
    assert.match(error.message, /^Claude Code ended the prompt that LetAgents sends to start this agent without a call to the model, so the agent did not start\. Startup observations: .*result=success/);
    assert.ok(!error.message.includes("A text that the CLI wrote"));
    assert.deepEqual([error.transientProviderStart, error.providerQuotaExhausted], [undefined, undefined]);
    return true;
  });

  // With a call to the model the same text is an answer, and the agent starts as before. So does it on a result with no text.
  for (const result of [{ num_turns: 1, result: String(realClaudeResult(CLAUDE_REAL_CAPTURES.hook_blocks_prompt!).result) }, { num_turns: 0, result: "" }]) {
    const started = createHarness({ omitBootstrapResult: true, bootstrapMessages: (sessionId, turnId) =>
      [{ type: "result", subtype: "success", is_error: false, session_id: sessionId, user_message_uuid: turnId, ...result }] });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: started.dependencies, initTimeoutMs: 2_000 });
    const handle = await adapter.spawn(spawnRequest());
    assert.equal(handle.observedState(), "idle", JSON.stringify(result));
    await adapter.stop(handle);
  }
});

test("a Claude agent whose start a UserPromptSubmit hook stops is not started again by itself: the daemon saves the reason and the agent waits for its owner, where a start that the provider's load failed is tried again", async () => {
  const launchesAfter = async (cli: Pick<HarnessOptions, "bootstrapMessages" | "bootstrapResultSubtype" | "omitBootstrapResult">, triedAgain = 0) => {
    const agent = await claudeDaemonFixture();
    try {
      // From here on a process of this agent starts as `cli` says. Its process ends, and the daemon starts another.
      Object.assign(agent.cli, cli);
      agent.exitProcess();
      await agent.eventually(async () => (await agent.view()).condition === "coordination_blocked", "the start that failed is saved").catch(async (error) => {
        const current = await agent.view();
        throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error}); ${agent.harness.children.length} processes`);
      });
      // The daemon of this fixture looks at its agents every 50 ms: a start that it tries again is tried long before this.
      await agent.eventually(() => agent.harness.children.length === 2 + triedAgain, `the start is tried again ${triedAgain} times`);
      await pause(1_500);
      const current = await agent.view();
      return { processes: agent.harness.children.length, alive: agent.harness.children.filter((child) => child.alive).length, condition: current.condition, reads: current.last_error,
        namesSettingSources: agent.harness.launches[0]!.args.includes("--setting-sources"), resumed: agent.harness.launches.slice(1).every((launch) => launch.args.includes("--resume")) };
    } finally {
      await agent.cleanup();
    }
  };
  // Real lines: what the CLI wrote for a prompt that a hook stopped. Here it is the prompt that starts the agent's next process.
  const stopped = await launchesAfter({ omitBootstrapResult: true,
    bootstrapMessages: (sessionId, turnId) => realClaudeCapture(CLAUDE_REAL_CAPTURES.hook_blocks_prompt!, sessionId, turnId).stream });
  assert.deepEqual([stopped.processes, stopped.alive, stopped.condition, stopped.resumed], [2, 0, "coordination_blocked", true],
    "one process was started in place of the one that ended. The hook stopped its prompt, and no other was started");
  assert.equal(stopped.reads, `convergence scheduler failure: ${claudeStartWithoutModelText({ modelNotCalled: "hook_stopped_prompt", ownerSetup: false, namesSettingSources: stopped.namesSettingSources })}`);
  assert.match(stopped.reads ?? "", /^convergence scheduler failure: A UserPromptSubmit hook stopped the prompt that LetAgents sends to start this agent, so the agent cannot start while the hook stops that prompt\. .*Change the hook so that it lets this prompt through, then try again\.$/);
  for (const words of ["PROMPT_HOOK_BLOCKS_THE_PROMPT", "/PATH", "Original prompt", "PROBE_OK", "blocked by hook"]) assert.ok(!stopped.reads!.includes(words), words);

  // The provider was overloaded: such a start is tried again, three times.
  const overloaded = await launchesAfter({ bootstrapResultSubtype: "success",
    bootstrapMessages: (sessionId) => [{ type: "assistant", session_id: sessionId, error: "overloaded", message: { content: [{ type: "text", text: "busy" }] } }] }, 3);
  assert.deepEqual([overloaded.processes, overloaded.alive, overloaded.condition], [5, 0, "coordination_blocked"], "the same fixture does start an agent again by itself, when the failure can pass");
});

test("the Claude launch arguments differ only in what the owner's setup needs", () => {
  // An access level that names its setting sources, as Read-only, Ask before writes and Auto do.
  const input = { approvalProfileLabel: "Ask before writes", mcpConfigPath: "/tmp/mcp.json", policyArgs: ["--permission-mode", "default", "--setting-sources", "user"], model: "opus" };
  const off = claudeCliLaunchArgs({ ...input, homeHarness: false, session: { sessionId: "s-1" } });
  const on = claudeCliLaunchArgs({ ...input, homeHarness: true, cwd: "/work/attempt", session: { sessionId: "s-1" } });
  assert.deepEqual(off, ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--permission-prompt-tool", "stdio", "--strict-mcp-config", "--mcp-config", "/tmp/mcp.json",
    "--permission-mode", "default", "--setting-sources", "user", "--model", "opus", "--session-id", "s-1"]);
  assert.deepEqual(on, ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--permission-prompt-tool", "stdio", "--mcp-config", "/tmp/mcp.json",
    "--permission-mode", "default", "--setting-sources", "user", "--settings", OWNER_START_SETTINGS, "--model", "opus", "--session-id", "s-1"],
  "the strict MCP flag is dropped and the start settings are added; no directory is added");
  assert.deepEqual(claudeCliLaunchArgs({ ...input, approvalProfileLabel: null, model: null, homeHarness: true, ownerMcpStartupMs: 4_000, session: { resume: "s-2" } }),
    ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
      "--mcp-config", "/tmp/mcp.json", "--permission-mode", "default", "--setting-sources", "user",
      "--settings", JSON.stringify({ env: { ...OWNER_START_ENV, MCP_TIMEOUT: "4000" } }), "--resume", "s-2"]);
  // A policy that already carries settings has them replaced where they stand, never given twice.
  const replaced = claudeCliLaunchArgs({ ...input, policyArgs: ["--permission-mode", "default", "--setting-sources", "user", "--settings", "{}", "--tools", "Read"], homeHarness: true, session: { sessionId: "s-1" } });
  assert.deepEqual(replaced.filter((arg) => arg === "--settings").length, 1);
  assert.equal(replaced[replaced.indexOf("--settings") + 1], OWNER_START_SETTINGS);
  assert.deepEqual(claudeCliLaunchArgs({ ...input, policyArgs: ["--permission-mode", "default", "--settings", "{}", "--tools", "Read"], homeHarness: false, ownerMcpStartupMs: 4_000, cwd: "/work/attempt", session: { sessionId: "s-1" } })
    .filter((arg, index, all) => all[index - 1] === "--settings"), ["{}"], "without the owner's setup the policy's own settings are passed as they are");
  // The saved effort follows the model on a fresh start and on a resume alike.
  assert.deepEqual(claudeCliLaunchArgs({ ...input, effort: "max", homeHarness: false, session: { resume: "s-2" } }).slice(-6),
    ["--model", "opus", "--effort", "max", "--resume", "s-2"]);
  assert.equal(claudeCliLaunchArgs({ ...input, effort: null, homeHarness: false, session: { sessionId: "s-1" } }).includes("--effort"), false);

  // An access level that names no setting sources reads the project's too: Full access.
  const full = { approvalProfileLabel: null, mcpConfigPath: "/tmp/mcp.json", policyArgs: ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"], model: null };
  assert.equal(claudeOwnerSetupReadsProjectInstructionsOnly(full.policyArgs), true);
  assert.equal(claudeOwnerSetupReadsProjectInstructionsOnly(input.policyArgs), false);
  assert.equal(claudeOwnerSetupReadsProjectInstructionsOnly(["--permission-mode", "dontAsk", "--setting-sources", ""]), false);
  const fullOff = claudeCliLaunchArgs({ ...full, homeHarness: false, cwd: "/work/attempt", session: { sessionId: "s-1" } });
  assert.deepEqual(fullOff, ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--strict-mcp-config", "--mcp-config", "/tmp/mcp.json",
    "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions", "--session-id", "s-1"], "without the owner's setup nothing is added, whatever folder is named");
  const instructions = JSON.stringify({ env: { ...OWNER_START_ENV, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" } });
  assert.deepEqual(claudeCliLaunchArgs({ ...full, homeHarness: true, cwd: "/work/attempt", session: { sessionId: "s-1" } }),
    ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--mcp-config", "/tmp/mcp.json",
      "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions",
      "--settings", instructions, "--setting-sources", "user", "--add-dir", "/work/attempt", "--session-id", "s-1"]);
  // With no folder to add, the launch still reads the owner's settings alone.
  for (const cwd of [undefined, "", "  "]) {
    const args = claudeCliLaunchArgs({ ...full, homeHarness: true, ...(cwd === undefined ? {} : { cwd }), session: { sessionId: "s-1" } });
    assert.equal(args.includes("--add-dir"), false, String(cwd));
    assert.equal(args[args.indexOf("--setting-sources") + 1], "user", String(cwd));
  }
  assert.deepEqual(claudeOwnerSetupStartEnvironment(30_000), OWNER_START_ENV);
  assert.deepEqual(claudeOwnerSetupStartEnvironment(30_000, true), { ...OWNER_START_ENV, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" });
});

test("with the owner's own setup, Claude must report the room's server as the one this launch named", async () => {
  for (const [servers, starts] of [
    [[OWNER_SERVER, ROOM_SERVER], true],
    [[{ name: "letagents", status: "connected", source: "user" }], false],
    [[{ name: "letagents", status: "connected", source: "project" }], false],
    [[{ name: "letagents", status: "connected" }], false],
    [[ROOM_SERVER, { name: "letagents", status: "connected", source: "user" }], false],
  ] as const) {
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [...servers] });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    const spawned = adapter.spawn(spawnRequest({
      configurationRevision: 4, permissionProfileId: "ask_before_write", launchPolicy: ownSetupAskPolicy(true), ...OWN_SETUP,
    }));
    if (starts) {
      await spawned;
    } else {
      await assert.rejects(withLoopAlive(spawned), /did not report the room's LetAgents server as the one this launch started/);
      assert.equal(harness.mcpConfigDisposals, 1, "the refused launch leaves no room config behind");
    }
  }
  // Without the owner's setup only the room's server can load, so an older CLI that names no source still starts.
  const isolated = createHarness({ versionOutput: "2.1.278 (Claude Code)" });
  await new ClaudeCodeProviderAdapter({ dependencies: isolated.dependencies }).spawn(spawnRequest({
    configurationRevision: 4, permissionProfileId: "ask_before_write", launchPolicy: ownSetupAskPolicy(false),
  }));
});

test("a rented Claude agent is refused the owner's own setup before anything starts", async () => {
  const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [ROOM_SERVER] });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(adapter.spawn(spawnRequest({
    configurationRevision: 4, permissionProfileId: "ask_before_write", launchPolicy: ownSetupAskPolicy(true), ...OWN_SETUP,
    supervisorEntryId: "supervised_rental_0123", supervisorSocketPath: "/tmp/fake-daemon.sock", supervisorExecutionGenerationId: "generation-1",
  })), /a rented agent never uses its owner's own setup/);
  assert.equal(harness.launches.length, 0);
});

test("a saved Claude effort reaches the CLI as --effort", async () => {
  const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [ROOM_SERVER], initPermissionMode: "default" });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await adapter.spawn(spawnRequest({
    configurationRevision: 4, permissionProfileId: "ask_before_write", launchPolicy: ownSetupAskPolicy(false),
    model: "claude-fable-5-1", reasoningEffort: "xhigh",
    ...SUPERVISED,
    supervisorWorkerSession: { agentSessionId: "session-1", roomCursor: null, apiUrl: "https://letagents.invalid" },
  }));
  const args = harness.launches[0]!.args;
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 4), ["--model", "claude-fable-5-1", "--effort", "xhigh"]);
});
