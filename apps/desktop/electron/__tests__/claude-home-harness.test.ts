import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";

import { createElectronTestEnv } from "./harness.js";

/**
 * What the installed Claude Code loads at start, with and without the owner's
 * own setup. It runs in a scratch HOME and config directory made for the
 * test, with a made-up API key and an API address nothing listens on, so it
 * needs no sign-in and reaches nothing. The test reads only the CLI's first
 * `init` line, which it prints before it calls any model.
 */

const env = createElectronTestEnv({ prefix: "letagents-claude-home-harness-", paths: [] });
const {
  claudeChildEnvironment, claudeCliLaunchArgs, claudeLaunchPolicyArgs, claudeOwnerSetupReadsProjectInstructionsOnly, claudeOwnerSetupStartEnvironment,
  createManagedClaudeMcpConfig, ownerMcpServerNotices, ownerMcpStartupTimeoutMs,
} = await import("../main/agents/claude-code-provider-adapter.js");
const { inspectClaudeCodeVersion, resolveClaudeCodeExecutable } = await import("../main/agents/claude-code-version.js");

let fixtureSerial = 0;
function fixture(name: string): string {
  const path = join(env.tempDir, `${name}-${fixtureSerial++}`);
  mkdirSync(path, { recursive: true });
  return path;
}

function scratchEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    // Nothing listens on the discard port, and the key is not a key.
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    ANTHROPIC_API_KEY: "sk-ant-fake-not-a-key",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

function installedClaude(): string | null {
  if (process.env.LETAGENTS_SKIP_CLAUDE_CONTRACT === "1") return null;
  const bin = resolveClaudeCodeExecutable(process.env);
  try {
    const version = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000, env: scratchEnvironment(fixture("version-home")) });
    // The room's server is told apart from the owner's by the source Claude reports, which older CLIs do not name.
    return inspectClaudeCodeVersion(version, "Ask before writes").supported ? bin : null;
  } catch {
    return null;
  }
}

const TOOLS = ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"];
/** The policy the daemon stores for Ask before writes, as the adapter attests it. */
function askPolicy(homeHarness: boolean): Record<string, unknown> {
  return {
    permissionMode: "default", dangerouslySkipPermissions: false, allowDangerouslySkipPermissions: false,
    tools: homeHarness ? [...TOOLS, "Skill"] : TOOLS,
    allowedTools: ["mcp__letagents__*"], settingSources: homeHarness ? "user" : "", settings: "{}",
  };
}

function mcpServerScript(directory: string): string {
  const path = join(directory, "mcp.mjs");
  writeFileSync(path, [
    "import { writeFileSync } from 'node:fs';",
    "import { createInterface } from 'node:readline';",
    // A server told where to report records the LetAgents variables it was started with.
    "if (process.env.FAKE_REPORT) writeFileSync(process.env.FAKE_REPORT, JSON.stringify(Object.keys(process.env).filter((key) => key.startsWith('LETAGENTS_') || key.startsWith('PROJECT_ENV')).sort()));",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "const tools = (process.env.FAKE_TOOLS || 'owner_tool').split(',');",
    "createInterface({ input: process.stdin }).on('line', (line) => {",
    "  let m; try { m = JSON.parse(line); } catch { return; }",
    "  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });",
    "  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: tools.map((name) => ({ name, inputSchema: { type: 'object', properties: {} } })) } });",
    "  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });",
    "});",
    "",
  ].join("\n"));
  return path;
}

/** The owner's own Claude setup, a project with its own, and the room's server config. */
function ownerSetup() {
  const home = fixture("owner-home");
  const config = join(home, ".claude");
  const script = mcpServerScript(fixture("mcp"));
  const userHook = join(fixture("hook"), "user-hook-ran");
  const projectHook = join(fixture("hook"), "project-hook-ran");
  const ownerServerReport = join(fixture("report"), "owner-server.json");
  mkdirSync(join(config, "skills", "owner-skill"), { recursive: true });
  writeFileSync(join(config, "skills", "owner-skill", "SKILL.md"), "---\nname: owner-skill\ndescription: Owner test skill.\n---\nBody.\n");
  writeFileSync(join(config, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    mcpServers: {
      owner_browser: { command: "node", args: [script], env: { FAKE_REPORT: ownerServerReport } },
      // The owner's own entry for the room server: the launch's must be the one that runs.
      letagents: { command: "node", args: [script], env: { FAKE_TOOLS: "owner_copy_of_room_tool" } },
    },
  }));
  writeFileSync(join(config, "settings.json"), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: `/usr/bin/env > ${JSON.stringify(userHook)}` }] }] },
  }));

  const project = fixture("project");
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: {
    repo_only: { command: "node", args: [script] },
    letagents: { command: "node", args: [script], env: { FAKE_TOOLS: "project_copy_of_room_tool" } },
  } }));
  mkdirSync(join(project, ".claude"));
  writeFileSync(join(project, "CLAUDE.md"), "PROJECT_ROOT_INSTRUCTIONS_CANARY\n");
  writeFileSync(join(project, ".claude", "CLAUDE.md"), "PROJECT_DOTCLAUDE_INSTRUCTIONS_CANARY\n");
  writeFileSync(join(project, "CLAUDE.local.md"), "PROJECT_LOCAL_INSTRUCTIONS_CANARY\n");
  mkdirSync(join(project, ".claude", "skills", "repo-skill"), { recursive: true });
  writeFileSync(join(project, ".claude", "skills", "repo-skill", "SKILL.md"), "---\nname: repo-skill\ndescription: Repo test skill.\n---\nBody.\n");
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({
    enableAllProjectMcpServers: true,
    env: { PROJECT_ENV_CANARY: "1" },
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${JSON.stringify(projectHook)}` }] }] },
  }));

  const roomConfig = join(fixture("room"), "mcp.json");
  writeFileSync(roomConfig, JSON.stringify({ mcpServers: { letagents: {
    command: "node", args: [script], env: { FAKE_TOOLS: "get_board,read_messages,send_message,room_tool" },
  } } }));
  return { home, project, roomConfig, userHook, projectHook, ownerServerReport, script };
}

type Init = { mcp_servers: Array<{ name: string; status: string; source?: string }>; tools: string[]; skills?: string[] };

/** Start the CLI as the adapter does and return its `init`. The process is always stopped, and never waited on unboundedly. */
async function readInit(
  claudeBin: string, setup: ReturnType<typeof ownerSetup>, homeHarness: boolean,
  launch: { roomConfig?: string; env?: NodeJS.ProcessEnv; ownerMcpStartupMs?: number } = {},
): Promise<Init> {
  const args = claudeCliLaunchArgs({
    approvalProfileLabel: "Ask before writes",
    homeHarness,
    ...(launch.ownerMcpStartupMs === undefined ? {} : { ownerMcpStartupMs: launch.ownerMcpStartupMs }),
    mcpConfigPath: launch.roomConfig ?? setup.roomConfig,
    policyArgs: claudeLaunchPolicyArgs(askPolicy(homeHarness)),
    model: null,
    session: { sessionId: crypto.randomUUID() },
  });
  const child = spawn(claudeBin, args, {
    cwd: setup.project, env: launch.env ?? scratchEnvironment(setup.home), stdio: ["pipe", "pipe", "ignore"], detached: true,
  });
  const stop = () => {
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Init>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Claude Code printed no init line in time")), 60_000);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Claude Code exited before init (${code})`)));
      createInterface({ input: child.stdout! }).on("line", (line) => {
        try {
          const message = JSON.parse(line) as { type?: string; subtype?: string };
          if (message.type === "system" && message.subtype === "init") resolve(message as unknown as Init);
        } catch { /* Not a stream-json line. */ }
      });
      // Claude prints init only after its first input line.
      child.stdin!.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } })}\n`);
    });
  } finally {
    clearTimeout(timer);
    stop();
  }
}

const realClaude = installedClaude();

test("the installed Claude Code loads the owner's MCP server, skill and hooks only with the owner's own setup, and never a project's", {
  skip: realClaude ? false : "a Claude Code that reports MCP server sources is not installed",
  timeout: 180_000,
}, async () => {
  const offSetup = ownerSetup();
  const off = await readInit(realClaude!, offSetup, false);
  assert.deepEqual(off.mcp_servers.map((server) => server.name), ["letagents"], "isolated: only the room's server");
  assert.equal(off.tools.some((tool) => tool.startsWith("mcp__owner_browser__")), false);
  assert.equal((off.skills ?? []).includes("owner-skill"), false, "isolated: the owner's skill is not offered");
  assert.equal(off.tools.includes("Skill"), false);
  assert.equal(existsSync(offSetup.userHook), false, "isolated: the owner's hook does not run");
  assert.equal(existsSync(offSetup.projectHook), false);

  const onSetup = ownerSetup();
  const on = await readInit(realClaude!, onSetup, true);
  const servers = new Map(on.mcp_servers.map((server) => [server.name, server]));
  assert.equal(servers.get("owner_browser")?.status, "connected", "the owner's MCP server starts");
  assert.equal(servers.get("owner_browser")?.source, "user");
  assert.ok(on.tools.includes("mcp__owner_browser__owner_tool"), "and offers its tool");
  assert.ok((on.skills ?? []).includes("owner-skill"), "the owner's skill is offered");
  assert.ok(on.tools.includes("Skill"), "and can be run");
  assert.equal(existsSync(onSetup.userHook), true, "the owner's hook runs");

  // A project's own servers and settings are not the owner's setup.
  assert.equal(servers.has("repo_only"), false, "a project's .mcp.json is not loaded");
  assert.equal(existsSync(onSetup.projectHook), false, "a project's hook does not run");

  // The room's server is the one the launch named, whatever the owner or the project call `letagents`.
  for (const init of [off, on]) {
    const room = init.mcp_servers.filter((server) => server.name === "letagents");
    assert.deepEqual(room.map((server) => [server.status, server.source]), [["connected", "dynamic"]]);
    assert.ok(init.tools.includes("mcp__letagents__room_tool"));
    assert.equal(init.tools.some((tool) => tool.includes("copy_of_room_tool")), false);
  }
  // Approvals still travel to LetAgents, and the agent's built-in tools are otherwise the same.
  assert.deepEqual(on.tools.filter((tool) => !tool.startsWith("mcp__")).sort(), [...TOOLS, "Skill"].sort());
  assert.deepEqual(off.tools.filter((tool) => !tool.startsWith("mcp__")).sort(), [...TOOLS].sort());
});

test("with the owner's own setup the installed Claude Code gives the room agent's coordinates to the room's server and to nothing of the owner's", {
  skip: realClaude ? false : "a Claude Code that reports MCP server sources is not installed",
  timeout: 180_000,
}, async (t) => {
  // What the adapter builds for a daemon-supervised room agent.
  const coordinates = {
    LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_fake", LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/fake/daemon.sock",
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: "attempt", LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "generation",
    LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: "session", LETAGENTS_SUPERVISOR_ROOM_ID: "room",
    LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: "FakeAgent",
    LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1", LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
    LETAGENTS_PERMISSION_PROFILE_ID: "ask_before_write",
  };
  const authority = (names: string[]) => names.filter((name) => name !== "LETAGENTS_API_URL");
  const run = async (input: { coordinatesInCliEnvironment: boolean }) => {
    const setup = ownerSetup();
    const roomServerReport = join(fixture("report"), "room-server.json");
    // The adapter's own room config, pointed at a stand-in for the room's server.
    const roomConfig = await createManagedClaudeMcpConfig(
      "https://letagents.invalid", fixture("room-config"), undefined, () => ({ entryPath: setup.script }) as never,
      { ...(input.coordinatesInCliEnvironment ? {} : coordinates), FAKE_REPORT: roomServerReport, FAKE_TOOLS: "get_board,read_messages,send_message,room_tool" },
    );
    t.after(() => roomConfig.dispose());
    const init = await readInit(realClaude!, setup, true, {
      roomConfig: roomConfig.path,
      env: claudeChildEnvironment(
        input.coordinatesInCliEnvironment ? { env: coordinates } : { env: {}, ownerSetup: true },
        // The desktop app's own environment can carry another agent's coordinates.
        { ...scratchEnvironment(setup.home), ...(input.coordinatesInCliEnvironment ? {} : { LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_ambient" }) },
      ),
    });
    assert.deepEqual(init.mcp_servers.map((server) => [server.name, server.status]).sort(), [["letagents", "connected"], ["owner_browser", "connected"]]);
    return {
      room: authority(JSON.parse(readFileSync(roomServerReport, "utf8")) as string[]),
      ownerServer: authority(JSON.parse(readFileSync(setup.ownerServerReport, "utf8")) as string[]),
      ownerHook: readFileSync(setup.userHook, "utf8").split("\n").map((line) => line.split("=")[0]!).filter((name) => name.startsWith("LETAGENTS_")),
    };
  };

  const scoped = await run({ coordinatesInCliEnvironment: false });
  assert.deepEqual(scoped.room, Object.keys(coordinates).sort(), "the room's server has every coordinate, so it works as before");
  assert.deepEqual(scoped.ownerServer, [], "the owner's MCP server is handed none");
  assert.deepEqual(scoped.ownerHook, [], "nor is the owner's hook");

  // Why they are moved: Claude hands whatever is in its own environment to every server and hook it starts.
  const inherited = await run({ coordinatesInCliEnvironment: true });
  assert.deepEqual(inherited.ownerServer, Object.keys(coordinates).sort());
  assert.deepEqual(inherited.ownerHook.sort(), Object.keys(coordinates).sort());
});

test("one of the owner's MCP servers that never answers does not stop the installed Claude Code starting, and is named", {
  skip: realClaude ? false : "a Claude Code that reports MCP server sources is not installed",
  timeout: 120_000,
}, async () => {
  const setup = ownerSetup();
  // A server that starts and then never says anything.
  const silent = join(fixture("silent"), "silent.mjs");
  writeFileSync(silent, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
  const configFile = join(setup.home, ".claude", ".claude.json");
  const config = JSON.parse(readFileSync(configFile, "utf8")) as { mcpServers: Record<string, unknown> };
  config.mcpServers.owner_silent = { command: "node", args: [silent] };
  writeFileSync(configFile, JSON.stringify(config));

  // The launch tells Claude how long the owner's servers may take. The owner's own smaller limit is kept,
  // which is what keeps this test short; with none it is Claude's own 30 seconds.
  const limit = ownerMcpStartupTimeoutMs("4000");
  assert.equal(limit, 4_000);
  const started = Date.now();
  const init = await readInit(realClaude!, setup, true, {
    ownerMcpStartupMs: limit,
    env: claudeChildEnvironment({ env: claudeOwnerSetupStartEnvironment(limit), ownerSetup: true }, scratchEnvironment(setup.home)),
  });
  const elapsed = Date.now() - started;
  // The adapter waits its usual 30 seconds plus the limit, so init arrives well inside its budget.
  assert.ok(elapsed < limit + 15_000, `init took ${elapsed} ms`);
  const servers = new Map(init.mcp_servers.map((server) => [server.name, server.status]));
  assert.equal(servers.get("letagents"), "connected", "the room's server is up");
  assert.equal(servers.get("owner_browser"), "connected", "and so is the owner's working server");
  assert.notEqual(servers.get("owner_silent"), "connected");
  const notices = ownerMcpServerNotices(init as unknown as Record<string, unknown>);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /^Your MCP server "owner_silent" (did not start, so this agent is running without it|was still starting when this agent began, so its tools may be missing)\.$/);
});

test("however many of the owner's servers never answer, and whatever the owner's own settings say, the room's server connects and the start stays inside its limit", {
  skip: realClaude ? false : "a Claude Code that reports MCP server sources is not installed",
  timeout: 120_000,
}, async (t) => {
  const setup = ownerSetup();
  const silent = join(fixture("silent"), "silent.mjs");
  writeFileSync(silent, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
  // An HTTP endpoint that accepts a connection and then says nothing.
  const dead = createServer((socket) => { socket.on("error", () => {}); });
  await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
  t.after(() => { dead.close(); });
  const port = (dead.address() as { port: number }).port;
  const configFile = join(setup.home, ".claude", ".claude.json");
  const config = JSON.parse(readFileSync(configFile, "utf8")) as { mcpServers: Record<string, unknown> };
  // Claude connects stdio servers three at a time: more than three dead ones used to hold the room's server back.
  for (let index = 0; index < 5; index += 1) config.mcpServers[`dead_stdio_${index}`] = { command: "node", args: [silent] };
  for (let index = 0; index < 6; index += 1) config.mcpServers[`dead_http_${index}`] = { type: "http", url: `http://127.0.0.1:${port}/mcp${index}` };
  writeFileSync(configFile, JSON.stringify(config));
  // The owner's own settings ask for a far longer wait and one connection at a time. Settings replace the environment.
  const settingsFile = join(setup.home, ".claude", "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(readFileSync(settingsFile, "utf8")), env: { MCP_TIMEOUT: "100000", MCP_SERVER_CONNECTION_BATCH_SIZE: "1" } }));

  const limit = 4_000;
  const started = Date.now();
  const init = await readInit(realClaude!, setup, true, {
    ownerMcpStartupMs: limit,
    env: claudeChildEnvironment({ env: claudeOwnerSetupStartEnvironment(limit), ownerSetup: true }, scratchEnvironment(setup.home)),
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < limit + 15_000, `init took ${elapsed} ms: the launch's own limit holds, not the owner's 100 seconds`);
  const servers = new Map(init.mcp_servers.map((server) => [server.name, server.status]));
  assert.equal(servers.get("letagents"), "connected", "the room's server is never queued behind the owner's");
  assert.equal(servers.get("owner_browser"), "connected");
  assert.equal(init.tools.includes("mcp__letagents__room_tool"), true);
  const unconnected = [...servers].filter(([name, status]) => name.startsWith("dead_") && status !== "connected").length;
  assert.equal(unconnected, 11);
  const notices = ownerMcpServerNotices(init as unknown as Record<string, unknown>);
  assert.equal(notices.length, 8, "the owner is told which, up to a bound");
  assert.match(notices[0]!, /^Your MCP server "dead_(stdio|http)_\d" /);
});

/** A stand-in for the model endpoint: every request ends at once with one short answer, and what Claude sent is kept. No account, no network. */
async function standInModel(t: TestContext): Promise<{ url: string; sent: () => string }> {
  let sent = "";
  const server = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (!request.url?.includes("/v1/messages") || request.url.includes("count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      let parsed: { system?: unknown; messages?: unknown; model?: string; stream?: boolean } = {};
      try { parsed = JSON.parse(body); } catch { /* Answered below all the same. */ }
      sent += JSON.stringify(parsed.system ?? "") + JSON.stringify(parsed.messages ?? "");
      const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const model = parsed.model ?? "stand-in";
      if (!parsed.stream) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          id: "msg_1", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage,
        }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } });
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      event("message_stop", {});
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, sent: () => sent };
}

/** Start the CLI with exactly these arguments and environment, run one turn, and return its `init`. Always stopped, never waited on unboundedly. */
async function runOneTurn(claudeBin: string, cwd: string, args: string[], environment: NodeJS.ProcessEnv): Promise<Init> {
  const child = spawn(claudeBin, args, { cwd, env: environment, stdio: ["pipe", "pipe", "ignore"], detached: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Init>((resolve, reject) => {
      let init: Init | null = null;
      timer = setTimeout(() => reject(new Error("Claude Code did not finish its first turn in time")), 90_000);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Claude Code exited before its first turn ended (${code})`)));
      createInterface({ input: child.stdout! }).on("line", (line) => {
        try {
          const message = JSON.parse(line) as { type?: string; subtype?: string };
          if (message.type === "system" && message.subtype === "init") init = message as unknown as Init;
          if (message.type === "result" && init) resolve(init);
        } catch { /* Not a stream-json line. */ }
      });
      child.stdin!.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } })}\n`);
    });
  } finally {
    clearTimeout(timer);
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
}

test("with Full access and the owner's own setup the installed Claude Code loads none of the project's own Claude setup but its CLAUDE.md", {
  skip: realClaude ? false : "a Claude Code that reports MCP server sources is not installed",
  timeout: 240_000,
}, async (t) => {
  // Full access as the daemon stores it: it names no setting sources, so Claude reads the project's too.
  const policyArgs = claudeLaunchPolicyArgs({ permissionMode: "bypassPermissions", dangerouslySkipPermissions: true });
  const run = async (homeHarness: boolean) => {
    const setup = ownerSetup();
    const model = await standInModel(t);
    const args = claudeCliLaunchArgs({
      approvalProfileLabel: null, homeHarness, ...(homeHarness ? { ownerMcpStartupMs: 10_000, cwd: setup.project } : {}),
      mcpConfigPath: setup.roomConfig, policyArgs, model: null, session: { sessionId: crypto.randomUUID() },
    });
    const base = { ...scratchEnvironment(setup.home), ANTHROPIC_BASE_URL: model.url };
    const init = await runOneTurn(realClaude!, setup.project, args, homeHarness
      ? claudeChildEnvironment({ env: claudeOwnerSetupStartEnvironment(10_000, claudeOwnerSetupReadsProjectInstructionsOnly(policyArgs)), ownerSetup: true }, base)
      : claudeChildEnvironment({ env: {} }, base));
    const sent = model.sent();
    return {
      args,
      servers: init.mcp_servers.map((server) => `${server.name}:${server.source ?? ""}`).sort(),
      projectTools: init.tools.filter((tool) => tool.includes("repo_only")),
      projectSkill: (init.skills ?? []).includes("repo-skill"),
      projectHookRan: existsSync(setup.projectHook),
      ownerHookRan: existsSync(setup.userHook),
      ownerServerEnv: existsSync(setup.ownerServerReport) ? JSON.parse(readFileSync(setup.ownerServerReport, "utf8")) as string[] : null,
      instructions: {
        root: sent.includes("PROJECT_ROOT_INSTRUCTIONS_CANARY"), dotClaude: sent.includes("PROJECT_DOTCLAUDE_INSTRUCTIONS_CANARY"),
        local: sent.includes("PROJECT_LOCAL_INSTRUCTIONS_CANARY"),
      },
    };
  };

  // Without the owner's setup, Full access is what it always was: the project's own setup loads, and only the room's server.
  const off = await run(false);
  assert.equal(off.args.includes("--setting-sources"), false);
  assert.equal(off.args.includes("--add-dir"), false);
  assert.deepEqual({ servers: off.servers, projectSkill: off.projectSkill, projectHookRan: off.projectHookRan, instructions: off.instructions }, {
    servers: ["letagents:dynamic"], projectSkill: true, projectHookRan: true, instructions: { root: true, dotClaude: true, local: true },
  });

  // With it, the owner's own setup loads and nothing of the project's runs beside it. The project's CLAUDE.md still loads.
  const on = await run(true);
  assert.deepEqual(on, {
    args: on.args,
    servers: ["letagents:dynamic", "owner_browser:user"],
    projectTools: [],
    projectSkill: false,
    projectHookRan: false,
    ownerHookRan: true,
    // The project's settings `env` does not reach the owner's server.
    ownerServerEnv: [],
    // The work folder's own CLAUDE.local.md is the one instruction file that no longer loads.
    instructions: { root: true, dotClaude: true, local: false },
  });
});

const { attestProviderSpawnPolicy } = await import("../main/agents/provider-spawn-configuration.js");

/**
 * One turn of the installed Claude Code, started with the arguments a launch of a stored Full access
 * policy gets: the adapter attests the policy the daemon hands it, and the arguments are built from that.
 * (The daemon hands a Full access policy on as it is stored; its own test follows that part.)
 */
async function turnFromStoredPolicy(t: TestContext, stored: Record<string, unknown>, homeHarness: boolean) {
  const setup = ownerSetup();
  const model = await standInModel(t);
  const attested = attestProviderSpawnPolicy("claude-code", {
    workAttemptId: "attempt", roomId: "room", cwd: setup.project, agentDisplayName: "Agent", supervisorEntryId: "supervised_owner", deliveryMode: "daemon_inbox",
    model: null, reasoningEffort: null, permissionProfileId: "full_access", configurationRevision: 2, launchPolicy: stored, ...(homeHarness ? { homeHarness: true as const } : {}),
  });
  const policyArgs = claudeLaunchPolicyArgs(attested);
  const args = claudeCliLaunchArgs({
    approvalProfileLabel: null, homeHarness, ...(homeHarness ? { ownerMcpStartupMs: 10_000, cwd: setup.project } : {}),
    mcpConfigPath: setup.roomConfig, policyArgs, model: null, session: { sessionId: crypto.randomUUID() },
  });
  const base = { ...scratchEnvironment(setup.home), ANTHROPIC_BASE_URL: model.url };
  const init = await runOneTurn(realClaude!, setup.project, args, homeHarness
    ? claudeChildEnvironment({ env: claudeOwnerSetupStartEnvironment(10_000, claudeOwnerSetupReadsProjectInstructionsOnly(policyArgs)), ownerSetup: true }, base)
    : claudeChildEnvironment({ env: {} }, base));
  return {
    args,
    servers: init.mcp_servers.map((server) => `${server.name}:${server.source ?? ""}`).sort(),
    projectHookRan: existsSync(setup.projectHook),
    ownerHookRan: existsSync(setup.userHook),
    sent: model.sent(),
  };
}

test("a stored Claude policy that names the project's settings starts nothing of the project's once the owner turns the setup on", {
  skip: realClaude ? false : "a Claude Code that reports MCP server sources is not installed",
  timeout: 300_000,
}, async (t) => {
  // Full access with explicit setting sources: a policy an unsigned creation can store, and a signed toggle keeps.
  const stored = { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true, settingSources: "user,project,local" };
  const flag = (args: string[], name: string) => args.flatMap((arg, index) => args[index - 1] === name ? [arg] : []);

  // Without the owner's setup the policy is passed on as it always was, and the project's hook runs.
  const off = await turnFromStoredPolicy(t, stored, false);
  assert.deepEqual(flag(off.args, "--setting-sources"), ["user,project,local"]);
  assert.deepEqual([off.projectHookRan, off.servers], [true, ["letagents:dynamic"]]);

  // With it the launch reads the owner's settings alone, whatever the policy named.
  const on = await turnFromStoredPolicy(t, stored, true);
  assert.deepEqual(flag(on.args, "--setting-sources"), ["user"]);
  assert.deepEqual({ projectHookRan: on.projectHookRan, ownerHookRan: on.ownerHookRan, servers: on.servers },
    { projectHookRan: false, ownerHookRan: true, servers: ["letagents:dynamic", "owner_browser:user"] },
    "the project's hook did not run and its .mcp.json server did not start; the owner's did");

  // The same under the option's other spelling and with more stored beside it.
  const more = await turnFromStoredPolicy(t, {
    permissionMode: "bypassPermissions", dangerouslySkipPermissions: true,
    "setting-sources": "user,project,local", settings: JSON.stringify({ enableAllProjectMcpServers: true }),
    appendSystemPrompt: "STORED_PROMPT_CANARY", addDir: "/",
  }, true);
  assert.deepEqual(flag(more.args, "--setting-sources"), ["user"]);
  assert.deepEqual(more.args.filter((arg) => arg.startsWith("--")), on.args.filter((arg) => arg.startsWith("--")),
    "the launch names the flags a policy with nothing else stored gets, each once");
  assert.deepEqual([flag(more.args, "--settings"), flag(more.args, "--add-dir").length], [flag(on.args, "--settings"), 1]);
  assert.equal(more.args.includes("/"), false, "the stored folder is not added");
  assert.deepEqual({ projectHookRan: more.projectHookRan, servers: more.servers, prompt: more.sent.includes("STORED_PROMPT_CANARY") },
    { projectHookRan: false, servers: ["letagents:dynamic", "owner_browser:user"], prompt: false });
});

test("the installed Claude Code takes the last of two values given for one flag, so a launch with the owner's own setup names each of its flags once", {
  skip: realClaude ? false : "a Claude Code that reports MCP server sources is not installed",
  timeout: 300_000,
}, async (t) => {
  const twice = async (first: string, second: string) => {
    const setup = ownerSetup();
    const model = await standInModel(t);
    // Without the owner's setup the arguments are passed on untouched, so both values reach the CLI in this order.
    const args = claudeCliLaunchArgs({
      approvalProfileLabel: null, homeHarness: false, mcpConfigPath: setup.roomConfig, model: null, session: { sessionId: crypto.randomUUID() },
      policyArgs: ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions", "--setting-sources", first, "--setting-sources", second],
    });
    await runOneTurn(realClaude!, setup.project, args, claudeChildEnvironment({ env: {} }, { ...scratchEnvironment(setup.home), ANTHROPIC_BASE_URL: model.url }));
    return existsSync(setup.projectHook);
  };
  // Whichever value stands last is the one Claude uses: position alone would decide.
  assert.equal(await twice("user", "user,project,local"), true, "the project's settings are read when they are named last");
  assert.equal(await twice("user,project,local", "user"), false, "and are not when the owner's alone are named last");
});
