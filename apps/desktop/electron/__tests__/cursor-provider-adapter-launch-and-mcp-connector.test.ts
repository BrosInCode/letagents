import "./isolated-home.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  boundedCursorRoomTurnPrompt,
  CursorProviderAdapter,
  cursorCliEnv,
  cursorLaunchPolicyArgs,
  defaultLaunchTurn,
} from "../main/agents/cursor-provider-adapter.js";
import { boundedClaudeRoomTurnPrompt } from "../main/agents/claude-code-provider-adapter.js";
import { cursorMcpConnectorListenPath } from "../main/agents/cursor/windows-turn.js";
import { cursorSupervisedMcpServerName } from "../main/agents/cursor-managed-profile.js";
import { prepareCursorResumeOwnershipLock } from "../main/agents/cursor-sandbox-policy.js";
import { LETAGENTS_MCP_RUNTIME_VERSION } from "../main/agents/letagents-mcp-runtime.js";
import {
  birthIdentity,
  argValue,
  productionPersonalIdentityDependencies,
  wrapperHostedMcpFixture,
  cursorMcpAttestationFixtureSource,
  createHarness,
  spawnRequest,
  daemonSpawnRequest,
  supervisedAdapter,
  spawnDaemonLane,
  roomTurnRequest,
  flush,
  waitForPath,
  waitFor,
  withLoopAlive,
  verifyMcpConnectorRetirement,
  verifyMcpRuntimeSignalFence,
  runSupervisedWorkerSocketProbe,
  WA_CURSOR_CWD,
  cursorTmp,
  endsWithPath,
} from "./cursor-provider-adapter.fixture.js";
import { macOsSandboxOnly, needsPosixProcessGroups, needsWindowsFakeCursorAgent, writeFakeProvider } from "./platform.js";
import { CURSOR_REAL_MCP_VALIDATION_TIMEOUT_MS } from "../main/agents/cursor-provider-constants.js";

/** A turn's private local-worker root: under /tmp on POSIX (/private/tmp on macOS), under the temporary folder on Windows. */
const RUNTIME_DATA_DIR = process.platform === "win32"
  ? new RegExp(`^${cursorTmp.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}\\\\letagents-cursor-data-[A-Za-z0-9]{6}$`, "i")
  : /^\/(?:private\/)?tmp\/letagents-cursor-data-[A-Za-z0-9]{6}$/;

test("spawn runs one per-turn child with verbatim policy flags and the prompt as a positional argument", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());

  assert.equal(harness.launches.length, 1);
  const args = harness.launches[0]!.args;
  assert.equal(args[0], "-p");
  assert.ok(args.join(" ").includes("--output-format stream-json"));
  assert.ok(args.includes("--trust"), "headless workspace-trust suppression is adapter-owned");
  assert.equal(args.includes("--disable-project-configs"), false, "legacy Cursor keeps project config enabled");
  assert.equal(args.includes("--approve-mcps"), false, "legacy Cursor has no sealed profile to scope approval, so it never blanket-approves MCPs");
  assert.ok(args.join(" ").includes(`--workspace ${WA_CURSOR_CWD}`));
  assert.ok(args.join(" ").includes("--mode ask"), "native policy flag passed verbatim");
  assert.ok(args.join(" ").includes("--sandbox enabled"));
  assert.equal(args.includes("--resume"), false);
  const prompt = args[args.length - 1]!;
  assert.ok(prompt.includes("Cursor worker"), "prompt is provider-labelled and positional");
  assert.ok(prompt.includes('"cursor:'), "register_agent_session runtime uses the cursor key");

  // spawn resolves while the turn is still RUNNING: live pid, working state.
  assert.equal(handle.observedState(), "working");
  assert.equal(handle.pid, 5200);
  assert.deepEqual(handle.providerConnection, {
    kind: "cursor_cli",
    pid: 5200,
    processIdentity: birthIdentity(5200),
  });
  assert.equal(handle.providerContinuationId, "sess-cursor-1", "session id captured from the stream");
});

test("Cursor resume ownership rejects occupied or unsafe structures without changing native state", { skip: macOsSandboxOnly }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cursor-resume-ownership-")));
  const id = randomUUID();
  try {
    assert.throws(() => prepareCursorResumeOwnershipLock("../escape", root), /exact native conversation UUID/);
    const lock = prepareCursorResumeOwnershipLock(id.toUpperCase(), root);
    const shared = dirname(dirname(lock));
    assert.equal(lock, join(shared, "claim-locks", `${id}.lock`));
    assert.equal(existsSync(lock), false);
    mkdirSync(lock, { mode: 0o700 });
    assert.throws(() => prepareCursorResumeOwnershipLock(id, root), /ownership is already recorded/);
    assert.equal(existsSync(lock), true);
    fs.rmdirSync(lock);
    const binding = join(shared, "bindings", `${id}.json`);
    symlinkSync(join(root, "absent"), binding);
    assert.throws(() => prepareCursorResumeOwnershipLock(id, root), /ownership is already recorded/);
    fs.unlinkSync(binding);
    chmodSync(join(shared, "bindings"), 0o755);
    assert.throws(() => prepareCursorResumeOwnershipLock(id, root), /not private/);
    assert.equal(fs.statSync(join(shared, "bindings")).mode & 0o777, 0o755);
    fs.rmdirSync(join(shared, "bindings"));
    symlinkSync(join(root, "elsewhere"), join(shared, "bindings"));
    assert.throws(() => prepareCursorResumeOwnershipLock(id, root), /not private/);
    assert.equal(existsSync(join(root, "elsewhere")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("supervised Cursor room turns say there is no network and git fails from the sandbox only for sandboxed writes", () => {
  const limit = /In this mode there is no network\. git and gh usually fail inside the workspace/;
  const sandboxed = boundedCursorRoomTurnPrompt(roomTurnRequest(), "turn_cursor_1", "sandboxed_write");
  if (process.platform === "win32") {
    // Windows has no sandbox: its prompt names that, not the macOS sandbox's git failure.
    assert.match(sandboxed, /This computer runs Windows, where no operating-system sandbox limits your commands\./);
    assert.doesNotMatch(sandboxed, limit);
  } else {
    assert.match(sandboxed, limit);
    assert.match(sandboxed, /This is caused by the sandbox, so do not report it as a problem with the owner's Mac\./);
  }
  assert.doesNotMatch(boundedCursorRoomTurnPrompt(roomTurnRequest(), "turn_cursor_2", "full_access"), limit);
  assert.doesNotMatch(boundedClaudeRoomTurnPrompt(roomTurnRequest()), limit);
});

test("cursorLaunchPolicyArgs maps mechanically and rejects adapter-owned flags", () => {
  assert.deepEqual(
    cursorLaunchPolicyArgs({ mode: "plan", force: true, sandbox: "disabled" }),
    ["--mode", "plan", "--force", "--sandbox", "disabled"],
  );
  assert.throws(() => cursorLaunchPolicyArgs({ resume: "sess-x" }), /unsupported or adapter-owned flag 'resume'/);
  assert.throws(() => cursorLaunchPolicyArgs({ workspace: "/elsewhere" }), /unsupported or adapter-owned flag 'workspace'/);
  assert.throws(() => cursorLaunchPolicyArgs({ model: "shadow-model" }), /unsupported or adapter-owned flag 'model'/);
  assert.throws(() => cursorLaunchPolicyArgs({ approveMcps: false }), /unsupported or adapter-owned flag 'approveMcps'/);
  assert.throws(() => cursorLaunchPolicyArgs({ yolo: true }), /unsupported or adapter-owned flag 'yolo'/);
  assert.throws(() => cursorLaunchPolicyArgs("yolo"), /native CLI options object/);
  assert.throws(
    () => defaultLaunchTurn({
      cursorBin: process.execPath,
      args: [],
      cwd: process.cwd(),
      testAgentUpstreamEndpoint: "http://127.0.0.1:65536",
    }),
    /exact loopback HTTP\/2 origin/,
  );
  assert.throws(
    () => defaultLaunchTurn({
      cursorBin: process.execPath,
      args: [],
      cwd: process.cwd(),
      testControlPlaneUpstreamEndpoint: "http://127.0.0.1:99999",
    }),
    /exact loopback HTTP origin/,
  );
  assert.throws(
    () => defaultLaunchTurn({
      cursorBin: process.execPath,
      args: [],
      cwd: process.cwd(),
      restrictRemoteAuthority: true,
      testAgentUpstreamEndpoint: "https://api2.cursor.sh",
      testControlPlaneUpstreamEndpoint: "https://api2.cursor.sh",
      testStartupBarrier: {
        path: join(cursorTmp, "letagents-cursor-startup-barrier-Abc123", "mcp_listen"),
        stage: "mcp_listen",
      },
    }),
    /startup barrier is restricted to exact loopback unit tests/,
  );
  const supervisedBoundary = {
    cursorBin: process.execPath,
    args: [],
    cwd: process.cwd(),
    restrictRemoteAuthority: true,
    providerAuthorization: "Bearer sandbox-allow-list-test",
    mcpConnectorSocketPath: join(cursorTmp, `letagents-cursor-mcp-${randomUUID()}`, "stdio.sock"),
    mcpRuntimeEntryPath: "/usr/bin/true",
    mcpRuntimeCwd: process.cwd(),
    mcpRuntimeEnv: {},
  };
  assert.throws(
    () => defaultLaunchTurn({
      ...supervisedBoundary,
      allowedReadSubpaths: [process.cwd()],
      allowedWriteSubpaths: [process.cwd()],
      nativeResumeSessionId: randomUUID(),
      args: [`--resume=${randomUUID()}`],
    }),
    /ownership access must match the exact supervised resume session/,
  );
  assert.throws(
    () => defaultLaunchTurn({
      cursorBin: process.execPath,
      args: [],
      cwd: process.cwd(),
      nativeResumeSessionId: randomUUID(),
    }),
    /ownership access must match the exact supervised resume session/,
  );
  // Windows has no sandbox, so no allow-lists to require (turn-launcher.ts).
  if (process.platform !== "win32") {
    assert.throws(
      () => defaultLaunchTurn({
        ...supervisedBoundary,
        allowedReadSubpaths: [process.cwd()],
      }),
      /non-empty read and write sandbox allow-lists/,
    );
    assert.throws(
      () => defaultLaunchTurn({
        ...supervisedBoundary,
        allowedWriteSubpaths: [process.cwd()],
      }),
      /non-empty read and write sandbox allow-lists/,
    );
  }
  assert.throws(
    () => defaultLaunchTurn({
      ...supervisedBoundary,
      testAgentUpstreamEndpoint: "http://127.0.0.1:9",
      testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
      testMcpCapabilityTimeoutMs: 0,
    }),
    /live MCP capability timeout seam is restricted to bounded exact-loopback unit tests/,
  );
  assert.throws(
    () => defaultLaunchTurn({
      ...supervisedBoundary,
      testMcpCapabilityTimeoutMs: 100,
    }),
    /live MCP capability timeout seam is restricted to bounded exact-loopback unit tests/,
  );
});

test("the inline Cursor wrapper remains plain JavaScript when Node type stripping is disabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-wrapper-plain-js-"));
  try {
    const child = defaultLaunchTurn({
      cursorBin: process.execPath,
      args: ["-e", `
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-plain-js" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "plain-js", session_id: "sess-plain-js" }) + "\\n");
`],
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        NODE_OPTIONS: "--no-experimental-strip-types",
      },
      deferStart: true,
    });
    const lines: string[] = [];
    child.onLine((line) => lines.push(line));

    await child.prepared;
    child.release();
    const exit = await withLoopAlive(child.exited);

    assert.deepEqual(exit, { type: "exit", code: 0, signal: null });
    assert.equal(child.stderrTail(), "");
    assert.equal(lines.some((line) => line.includes('"session_id":"sess-plain-js"')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cursorCliEnv passes the environment through without curation (v10 §3 — diverges from the legacy allowlist)", () => {
  const env = cursorCliEnv({ HOME: "/Users/someone", SOME_RANDOM_VAR: "kept", CURSOR_API_KEY: "kept-too" });
  assert.equal(env.SOME_RANDOM_VAR, "kept", "no allowlist: unknown vars survive");
  assert.equal(env.HOME, "/Users/someone");
  assert.equal(env.CURSOR_API_KEY, "kept-too");
});

test("daemon-owned Cursor starts idle without inference and gives only the first journaled turn exact bridge authority", async () => {
  const harness = createHarness();
  const previousOwnerToken = process.env.LETAGENTS_TOKEN;
  const previousBearer = process.env.LETAGENTS_AGENT_SESSION_BEARER;
  const previousStaleEntry = process.env.LETAGENTS_SUPERVISOR_ENTRY_ID;
  const previousGithubToken = process.env.GITHUB_TOKEN;
  const previousAwsSecret = process.env.AWS_SECRET_ACCESS_KEY;
  const previousNpmToken = process.env.NPM_TOKEN;
  process.env.LETAGENTS_TOKEN = "owner-token-must-not-leak";
  process.env.LETAGENTS_AGENT_SESSION_BEARER = "fixed-bearer-must-not-leak";
  process.env.LETAGENTS_SUPERVISOR_ENTRY_ID = "stale-entry";
  process.env.GITHUB_TOKEN = "github-must-not-leak";
  process.env.AWS_SECRET_ACCESS_KEY = "aws-must-not-leak";
  process.env.NPM_TOKEN = "npm-must-not-leak";
  try {
    const adapter = supervisedAdapter(harness);
    const handle = await spawnDaemonLane(adapter, harness, daemonSpawnRequest({
      supervisorWorkerSession: { agentSessionId: "agent_session_cursor_1", roomCursor: "msg_7", apiUrl: "letagents-local://rooms" },
    }));

    assert.deepEqual(adapter.capabilities().deliveryModes, ["mcp_polling", "daemon_inbox"]);
    assert.equal(adapter.capabilities().midTurnCorrection, false);
    assert.equal(harness.launches.length, 0, "lane creation performs no unjournaled bootstrap inference");
    assert.equal(handle.observedState(), "idle");
    assert.equal(handle.pid, null);
    assert.match(handle.providerContinuationId!, /^cursor-pending:/);

    let turnId = "";
    const turn = withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest(), {
      checkpointTurnStarted: async (value) => { turnId = value; },
    }));
    await waitFor(() => harness.children[0]?.isReleased === true);
    const launch = harness.launches[0]!;
    assert.equal(launch.args.includes("--force"), false, "daemon read-only Cursor never receives --force");
    assert.equal(harness.mcpAttestations.length, 2, "both registry shape and the real bridge are attested at the native turn boundary");
    const inspectionEnv = harness.mcpAttestations[0]!.env;
    const inspectionPreparations = harness.profilePreparations.filter((entry) => entry.profileRoot !== undefined);
    assert.equal(inspectionPreparations.length, 4);
    assert.equal(inspectionPreparations[0]?.includeAuth, false);
    assert.equal(inspectionPreparations[0]?.inspectionOnly, true);
    assert.equal(inspectionPreparations[1]?.includeAuth, false);
    assert.equal(inspectionPreparations[1]?.inspectionOnly, false);
    assert.deepEqual(inspectionPreparations[1]?.supervisorMcpEnv, {
      LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
      LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
      LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
    }, "the credentialless packaged-bridge pass discovers the exact Cursor completion tool surface");
    assert.equal(inspectionPreparations[2]?.includeAuth, true);
    assert.equal(inspectionPreparations[2]?.inspectionOnly, true);
    assert.equal(inspectionPreparations[3]?.includeAuth, true);
    assert.equal(inspectionPreparations[3]?.inspectionOnly, true);
    assert.equal(inspectionPreparations[0]?.profileRoot, harness.mcpAttestations[0]!.writableProfileRoot);
    assert.equal(inspectionPreparations[1]?.profileRoot, harness.mcpAttestations[1]!.writableProfileRoot);
    assert.notEqual(
      harness.mcpAttestations[1]!.writableProfileRoot,
      harness.mcpAttestations[0]!.writableProfileRoot,
      "the networked bridge never reuses the root exposed to pass one",
    );
    assert.equal(harness.mcpAttestations[0]!.cwd, harness.mcpAttestations[0]!.writableProfileRoot);
    assert.equal(harness.mcpAttestations[1]!.cwd, harness.mcpAttestations[1]!.writableProfileRoot);
    assert.equal(
      harness.mcpAttestations[0]!.expectedServerName,
      cursorSupervisedMcpServerName(inspectionPreparations[0]!.workAttemptId),
    );
    assert.equal(
      harness.mcpAttestations[1]!.expectedServerName,
      cursorSupervisedMcpServerName(inspectionPreparations[1]!.workAttemptId),
    );
    assert.equal(
      inspectionPreparations[1]?.mcpWorkingDirectory,
      harness.mcpAttestations[1]!.writableProfileRoot,
    );
    assert.deepEqual(
      harness.mcpAttestations[1]!.requiredReadableRoots,
      ["/Applications/LetAgents.app/runtime/letagents"],
    );
    assert.equal(harness.mcpAttestations[1]!.timeoutMs, CURSOR_REAL_MCP_VALIDATION_TIMEOUT_MS);
    assert.equal(inspectionEnv.HOME, `${harness.mcpAttestations[0]!.writableProfileRoot}/home`);
    assert.equal(
      inspectionEnv.CURSOR_CONFIG_DIR,
      `${harness.mcpAttestations[0]!.writableProfileRoot}/config/cursor`,
    );
    assert.notEqual(inspectionEnv.HOME, launch.env?.HOME, "inspection and real turns never share a profile");
    assert.equal(inspectionEnv.CURSOR_API_KEY, undefined);
    assert.equal(inspectionEnv.CURSOR_AUTH_TOKEN, undefined);
    assert.equal(inspectionEnv.LETAGENTS_TOKEN, undefined);
    assert.equal(inspectionEnv.LETAGENTS_AGENT_SESSION_BEARER, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISOR_ENTRY_ID, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISOR_DAEMON_SOCKET, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISOR_AGENT_SESSION_ID, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISOR_PROVIDER, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISED_BOUNDED_TURNS, undefined);
    assert.equal(inspectionEnv.LETAGENTS_EXECUTION_PROFILE, undefined);
    assert.equal(inspectionEnv.LETAGENTS_PERMISSION_PROFILE_ID, undefined);
    const bridgeEnv = harness.mcpAttestations[1]!.env;
    assert.notEqual(bridgeEnv.HOME, inspectionEnv.HOME);
    assert.equal(bridgeEnv.HOME, `${harness.mcpAttestations[1]!.writableProfileRoot}/home`);
    assert.equal(bridgeEnv.NPM_CONFIG_CACHE, undefined);
    assert.equal(bridgeEnv.CURSOR_API_KEY, undefined);
    assert.equal(bridgeEnv.CURSOR_AUTH_TOKEN, undefined);
    assert.equal(bridgeEnv.LETAGENTS_TOKEN, undefined);
    assert.equal(bridgeEnv.LETAGENTS_AGENT_SESSION_BEARER, undefined);
    assert.equal(bridgeEnv.LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID, undefined);
    assert.equal(bridgeEnv.LETAGENTS_SUPERVISED_BOUNDED_TURNS, undefined, "supervised mode is confined to the packaged MCP child config");
    assert.equal(bridgeEnv.LETAGENTS_EXECUTION_PROFILE, undefined, "supervised mode is confined to the packaged MCP child config");
    assert.equal(harness.identityAttestations.length, 1);
    assert.equal(harness.identityAttestations[0]!.cwd, inspectionPreparations[2]!.profileRoot);
    assert.equal(harness.identityAttestations[0]!.env.CURSOR_API_KEY, undefined);
    assert.equal(harness.identityAttestations[0]!.env.CURSOR_AUTH_TOKEN, undefined);
    assert.equal(harness.identityAttestations[0]!.env.LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID, undefined);
    const finalPreparation = harness.profilePreparations.find((entry) =>
      entry.mcpConnectorSocketPath !== undefined
    )!;
    assert.equal(harness.profilePreparations.length, 6);
    assert.ok(harness.profilePreparations.every(input => input.apiBaseUrl === "letagents-local://rooms"));
    assert.equal(launch.mcpRuntimeEnv?.LETAGENTS_API_URL, "letagents-local://rooms");
    assert.equal(finalPreparation.authSourceHomeDir, `${inspectionPreparations[3]!.profileRoot}/home`);
    assert.equal(finalPreparation.supervisorMcpEnv, undefined, "native-readable MCP config contains no supervisor coordinates");
    assert.deepEqual(Object.fromEntries(Object.entries(launch.mcpRuntimeEnv ?? {}).filter(([key]) =>
      key.startsWith("LETAGENTS_SUPERVISOR_")
        || key === "LETAGENTS_SUPERVISED_BOUNDED_TURNS"
        || key === "LETAGENTS_EXECUTION_PROFILE"
        || key === "LETAGENTS_PERMISSION_PROFILE_ID"
    )), {
      LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_cursor_1",
      LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/letagents-supervisor.sock",
      LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: "wa-cursor-1",
      LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "generation_cursor_1",
      LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
      LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: turnId,
      LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: "agent_session_cursor_1",
      LETAGENTS_SUPERVISOR_ROOM_ID: "github.com/example/repo",
      LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: "TidalHare",
      LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
      LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
      LETAGENTS_PERMISSION_PROFILE_ID: "read_only",
    });
    assert.equal(launch.mcpConnectorSocketPath, finalPreparation.mcpConnectorSocketPath);
    assert.deepEqual(launch.allowedNetworkUnixSockets, [finalPreparation.mcpConnectorSocketPath]);
    assert.equal(launch.args.includes("--approve-mcps"), true, "the sealed HOME letagents MCP is approved so complete_room_turn loads and the turn can attest; cursor-agent has no headless per-server approval, and the native sandbox denies every workspace .cursor/mcp.json read, so this approves exactly that one server");
    assert.equal(launch.args.includes("--disable-project-configs"), true, "native project permissions stay disabled");
    assert.equal(launch.args.includes("--disable-auto-update"), true, "native background updater stays disabled");
    assert.equal(argValue(launch.args, "--sandbox"), "enabled", "supervised read-only turns keep Cursor's native sandbox enabled");
    assert.equal(launch.cwd, "/private/cursor/wa-cursor-1", "project MCP discovery is isolated from --workspace");
    assert.equal(argValue(launch.args, "--workspace"), WA_CURSOR_CWD);
    assert.equal(launch.args.includes("--resume"), false, "the first durable turn establishes the native session");
    assert.equal(launch.env?.HOME, "/private/cursor/wa-cursor-1/home");
    assert.equal(launch.env?.CURSOR_API_KEY, undefined);
    assert.equal(launch.env?.CURSOR_AUTH_TOKEN, undefined, "the native environment contains no provider or placeholder token");
    assert.equal(launch.env?.AGENT_CLI_CREDENTIAL_STORE, "file", "the public argv placeholder stays in the private profile and never reaches Keychain");
    assert.equal(launch.env?.NPM_CONFIG_CACHE, undefined);
    assert.equal(launch.env?.LETAGENTS_TOKEN, undefined);
    assert.equal(launch.env?.LETAGENTS_AGENT_SESSION_BEARER, undefined);
    assert.equal(launch.env?.GITHUB_TOKEN, undefined);
    assert.equal(launch.env?.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(launch.env?.NPM_TOKEN, undefined);
    assert.equal(launch.env?.LETAGENTS_SUPERVISOR_ENTRY_ID, undefined);
    assert.equal(launch.env?.LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID, undefined);
    assert.equal(launch.env?.LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID, undefined);
    assert.equal(launch.env?.LETAGENTS_SUPERVISOR_AGENT_SESSION_ID, undefined);
    assert.equal(launch.env?.LETAGENTS_SUPERVISOR_PROVIDER, undefined);
    assert.equal(launch.env?.LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID, undefined);
    assert.equal(launch.env?.LETAGENTS_SUPERVISED_BOUNDED_TURNS, undefined);
    assert.equal(launch.env?.LETAGENTS_EXECUTION_PROFILE, undefined);
    assert.equal(launch.env?.LETAGENTS_PERMISSION_PROFILE_ID, undefined);
    const firstRuntimeDataDir = launch.env?.CURSOR_DATA_DIR;
    assert.match(firstRuntimeDataDir ?? "", RUNTIME_DATA_DIR);
    assert.equal(existsSync(firstRuntimeDataDir!), true, "the live turn owns one private local-worker root");
    harness.children[0]!.emit({
      type: "result", subtype: "success", is_error: false,
      result: "ready through real work", session_id: "sess-cursor-1",
    });
    harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await flush();
    await turn;
    await flush();
    assert.equal(existsSync(firstRuntimeDataDir!), false, "turn terminal retirement removes the local-worker root");
    assert.equal(handle.observedState(), "idle");
    assert.equal(handle.pid, null, "a completed per-turn lane claims no idle process");
    assert.equal(handle.providerContinuationId, "sess-cursor-1");

    const resumeTurn = withLoopAlive(adapter.runRoomTurn(
      handle,
      roomTurnRequest({ inboxItemId: "inbox-cursor-private-data-resume" }),
    ));
    for (let index = 0; index < 100 && !harness.children[1]?.isReleased; index += 1) await flush();
    assert.equal(harness.children[1]?.isReleased, true);
    const resumeLaunch = harness.launches[1]!;
    assert.equal(harness.profilePreparations.length, 11);
    assert.ok(harness.profilePreparations.every(input => input.apiBaseUrl === "letagents-local://rooms"));
    assert.equal(resumeLaunch.mcpRuntimeEnv?.LETAGENTS_API_URL, "letagents-local://rooms");
    const resumeRuntimeDataDir = resumeLaunch.env?.CURSOR_DATA_DIR;
    assert.match(resumeRuntimeDataDir ?? "", RUNTIME_DATA_DIR);
    assert.notEqual(resumeRuntimeDataDir, firstRuntimeDataDir, "each resumed turn gets a fresh worker socket namespace");
    assert.equal(argValue(resumeLaunch.args, "--resume"), "sess-cursor-1");
    harness.children[1]!.emit({
      type: "result", subtype: "success", is_error: false,
      result: "resumed through private data", session_id: "sess-cursor-1",
    });
    harness.children[1]!.resolveExit({ type: "exit", code: 0, signal: null });
    await resumeTurn;
    await flush();
    assert.equal(existsSync(resumeRuntimeDataDir!), false);
  } finally {
    if (previousOwnerToken === undefined) delete process.env.LETAGENTS_TOKEN;
    else process.env.LETAGENTS_TOKEN = previousOwnerToken;
    if (previousBearer === undefined) delete process.env.LETAGENTS_AGENT_SESSION_BEARER;
    else process.env.LETAGENTS_AGENT_SESSION_BEARER = previousBearer;
    if (previousStaleEntry === undefined) delete process.env.LETAGENTS_SUPERVISOR_ENTRY_ID;
    else process.env.LETAGENTS_SUPERVISOR_ENTRY_ID = previousStaleEntry;
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithubToken;
    if (previousAwsSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = previousAwsSecret;
    if (previousNpmToken === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = previousNpmToken;
  }
});

test("the production Cursor profile keeps supervisor coordinates out of native config and passes them only to the wrapper MCP", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-production-profile-"));
  const workspace = join(root, "workspace");
  const sourceHome = join(root, "source-home");
  const statePath = join(root, "state", "mcp-state.json");
  const runtimePackage = join(root, "runtime", "node_modules", "letagents");
  const runtimeEntry = join(runtimePackage, "dist", "mcp", "server.js");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  mkdirSync(dirname(runtimeEntry), { recursive: true });
  writeFileSync(join(runtimePackage, "package.json"), JSON.stringify({
    name: "letagents",
    version: LETAGENTS_MCP_RUNTIME_VERSION,
  }));
  writeFileSync(runtimeEntry, "// exact development MCP fixture\n");

  const previousStatePath = process.env.LETAGENTS_STATE_PATH;
  const previousSourceHome = process.env.LETAGENTS_CURSOR_SOURCE_HOME;
  const previousDevMode = process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL;
  process.env.LETAGENTS_STATE_PATH = statePath;
  process.env.LETAGENTS_CURSOR_SOURCE_HOME = sourceHome;
  process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL = "http://127.0.0.1:5174";
  try {
    const harness = createHarness();
    const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
    const request = daemonSpawnRequest({
      workAttemptId: "wa-cursor-production-profile",
      cwd: workspace,
      devMcpServerEntryPath: runtimeEntry,
    });
    const handle = await adapter.spawn(request);
    let turnId = "";
    const turn = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "inbox-production-profile" }), {
      checkpointTurnStarted: async (value) => { turnId = value; },
    });
    await waitFor(() => harness.children[0]?.isReleased === true);

    const profileRoot = join(
      dirname(statePath),
      "cursor-supervised",
      createHash("sha256").update(request.workAttemptId).digest("hex").slice(0, 32),
    );
    const serverName = cursorSupervisedMcpServerName(request.workAttemptId);
    const server = JSON.parse(
      readFileSync(join(profileRoot, "home", ".cursor", "mcp.json"), "utf8"),
    ).mcpServers[serverName];
    assert.deepEqual(server.env, { ELECTRON_RUN_AS_NODE: "1" });
    assert.equal(JSON.stringify(server).includes("LETAGENTS_SUPERVISOR_"), false);
    // Windows: the connector gets the named pipe the wrapper listens on, then its proof file and the pipe addon.
    assert.equal(
      process.platform === "win32" ? server.args[2] : server.args.at(-1),
      process.platform === "win32"
        ? cursorMcpConnectorListenPath(harness.launches[0]!.mcpConnectorSocketPath!)
        : harness.launches[0]!.mcpConnectorSocketPath,
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(harness.launches[0]!.mcpRuntimeEnv ?? {})
        .filter(([key]) => key.startsWith("LETAGENTS_SUPERVISOR_")
          || key === "LETAGENTS_SUPERVISED_BOUNDED_TURNS"
          || key === "LETAGENTS_EXECUTION_PROFILE"
          || key === "LETAGENTS_PERMISSION_PROFILE_ID")),
      {
        LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_cursor_1",
        LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/letagents-supervisor.sock",
        LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: request.workAttemptId,
        LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "generation_cursor_1",
        LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
        LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: turnId,
        LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: "agent_session_cursor_1",
        LETAGENTS_SUPERVISOR_ROOM_ID: "github.com/example/repo",
        LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: "TidalHare",
        LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
        LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
        LETAGENTS_PERMISSION_PROFILE_ID: "read_only",
      },
    );
    assert.equal(harness.launches[0]!.env?.LETAGENTS_SUPERVISOR_ENTRY_ID, undefined);
    assert.ok(
      harness.launches[0]!.deniedReadPaths?.some((path) => endsWithPath(path, "/workspace/.cursor/hooks.json")),
      "the final native process receives exact project hook read denials",
    );
    assert.ok(
      harness.launches[0]!.deniedReadSubpaths?.some((path) => endsWithPath(path, "/home/.cursor/plugins")),
      "the final native process cannot load profile-persisted plugins",
    );
    assert.equal(
      harness.launches[0]!.restrictRemoteAuthority,
      true,
      "the final native process receives the remote-authority control-plane fence",
    );

    harness.children[0]!.emit({
      type: "result", subtype: "success", is_error: false,
      result: "ready", session_id: "sess-cursor-1",
    });
    harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await flush();
    await turn;
  } finally {
    if (previousStatePath === undefined) delete process.env.LETAGENTS_STATE_PATH;
    else process.env.LETAGENTS_STATE_PATH = previousStatePath;
    if (previousSourceHome === undefined) delete process.env.LETAGENTS_CURSOR_SOURCE_HOME;
    else process.env.LETAGENTS_CURSOR_SOURCE_HOME = previousSourceHome;
    if (previousDevMode === undefined) delete process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL;
    else process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL = previousDevMode;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production wrapper hosts one exact MCP connector across fresh and resume turns, then revokes it", { skip: needsWindowsFakeCursorAgent },
  () => verifyMcpConnectorRetirement());

test("MCP retirement escalates a live exact runtime despite slow process-table scans", {
  skip: needsPosixProcessGroups,
}, () => verifyMcpConnectorRetirement(true));

test("MCP retirement preserves the grace window after its leader exits before a descendant", {
  skip: needsPosixProcessGroups,
}, () => verifyMcpConnectorRetirement(false, true));

test("the production wrapper refuses a recycled MCP runtime process group before signaling", {
  skip: needsPosixProcessGroups,
}, () => verifyMcpRuntimeSignalFence("recycled"));

test("MCP cleanup retries distinguish unavailable identity from lost process-group signal authority", {
  skip: needsPosixProcessGroups,
}, async (t) => {
  await t.test("TERM identity timeout then success", () => verifyMcpRuntimeSignalFence("ambiguous_identity"));
  await t.test("KILL identity timeout then success", () => verifyMcpRuntimeSignalFence("ambiguous_kill_identity"));
  await t.test("confirmed absence permanently revokes signals", () => verifyMcpRuntimeSignalFence("absent"));
  await t.test("group probe ambiguity that outlasts every retry", () => verifyMcpRuntimeSignalFence("ambiguous_group"));
});

test("the wrapper retries a timed-out process-group probe with a longer bound and never reports closed without an answer", {
  skip: needsPosixProcessGroups,
}, async (t) => {
  await t.test("a timeout then an answer proves the group closed", () => verifyMcpRuntimeSignalFence("group_timeout_then_empty"));
  await t.test("a timeout on every try leaves the group unproven", () => verifyMcpRuntimeSignalFence("group_timeout_always"));
  await t.test("a definite still-alive answer is final and is not retried", () => verifyMcpRuntimeSignalFence("group_alive"));
});

test("the exact live Cursor connector rejects a swapped runtime with a missing or malformed completion contract", async () => {
  for (const completionContract of ["missing", "wrong_type", "enum_superset", "required_text"] as const) {
    const root = mkdtempSync(join(tmpdir(), `letagents-cursor-live-contract-${completionContract}-`));
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    let cursorBin = join(root, "fake-cursor-agent");
    const connectorRoots: string[] = [];
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    cursorBin = writeFakeProvider(cursorBin, `const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
attestFixtureMcp().then(() => {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "unexpected" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "unexpected", session_id: "unexpected" }) + "\\n");
}).catch(() => process.exit(81));
`);
    chmodSync(cursorBin, 0o700);
    try {
      const adapter = new CursorProviderAdapter({
        cursorBin,
        dependencies: {
          ...productionPersonalIdentityDependencies,
          launchTurn(input) {
            connectorRoots.push(dirname(input.mcpConnectorSocketPath!));
            return defaultLaunchTurn(input);
          },
        },
        supervisedProfileFactory: (input) => ({
          homeDir,
          configDir,
          dataDir: join(root, "data"),
          cacheDir: join(root, "cache"),
          env: { HOME: homeDir },
          ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, completionContract, true),
        }),
      });
      const handle = await adapter.spawn(daemonSpawnRequest({
        workAttemptId: `wa-cursor-live-contract-${completionContract}`,
        cwd: root,
      }));
      await assert.rejects(
        withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
          inboxItemId: `live-contract-${completionContract}`,
        }))),
        /live MCP runtime does not expose the required complete_room_turn contract/,
      );
      assert.equal(connectorRoots.length, 1, "the earlier registry preflight passed before the exact live swap was rejected");
      assert.equal(existsSync(connectorRoots[0]!), false, "the failed exact connector capability is revoked");
      const runtimePid = Number(readFileSync(join(root, "bridge", "runtime.pid"), "utf8"));
      assert.throws(
        () => process.kill(runtimePid, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
        "the rejected live runtime is reaped before the adapter reports failure",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the exact live Cursor connector rejects bounded capability-attestation floods", async () => {
  // Client-side floods no longer exist as an attestation concern: the wrapper
  // proves the contract against its hosted runtime before Cursor launches, and
  // client traffic is piped only after attestation settles. A runtime that
  // floods the wrapper's own bounded handshake still fails before launch.
  for (const floodMode of ["runtime_frames", "runtime_bytes"] as const) {
    const root = mkdtempSync(join(tmpdir(), `letagents-cursor-live-flood-${floodMode}-`));
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    let cursorBin = join(root, "fake-cursor-agent");
    const connectorRoots: string[] = [];
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    cursorBin = writeFakeProvider(cursorBin, `const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
attestFixtureMcp().then(() => {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "unexpected" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "unexpected", session_id: "unexpected" }) + "\\n");
}).catch(() => process.exit(82));
`);
    chmodSync(cursorBin, 0o700);
    try {
      const adapter = new CursorProviderAdapter({
        cursorBin,
        dependencies: {
          ...productionPersonalIdentityDependencies,
          launchTurn(input) {
            connectorRoots.push(dirname(input.mcpConnectorSocketPath!));
            return defaultLaunchTurn(input);
          },
        },
        supervisedProfileFactory: (input) => ({
          homeDir,
          configDir,
          dataDir: join(root, "data"),
          cacheDir: join(root, "cache"),
          env: { HOME: homeDir },
          ...wrapperHostedMcpFixture(
            root,
            input.mcpConnectorSocketPath,
            floodMode === "runtime_frames"
              ? "frame_flood"
              : floodMode === "runtime_bytes"
                ? "byte_flood"
                : "valid",
            true,
          ),
        }),
      });
      const handle = await adapter.spawn(daemonSpawnRequest({
        workAttemptId: `wa-cursor-live-flood-${floodMode}`,
        cwd: root,
      }));
      await assert.rejects(
        withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
          inboxItemId: `live-flood-${floodMode}`,
        }))),
        /bounded capability-attestation exchange/,
      );
      assert.equal(connectorRoots.length, 1);
      assert.equal(existsSync(connectorRoots[0]!), false, "the flooded connector capability is revoked");
      const runtimePidPath = join(root, "bridge", "runtime.pid");
      if (existsSync(runtimePidPath)) {
        const runtimePid = Number(readFileSync(runtimePidPath, "utf8"));
        assert.throws(
          () => process.kill(runtimePid, 0),
          (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
          "the flooded live runtime is reaped before the adapter reports failure",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the exact live Cursor connector accepts a cold native MCP handshake within the turn-start deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-live-contract-delayed-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  let cursorBin = join(root, "fake-cursor-agent");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  cursorBin = writeFakeProvider(cursorBin, `const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
setTimeout(() => {
  attestFixtureMcp().then((connector) => {
    detachFixtureMcp(connector);
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-delayed-mcp" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "delayed-mcp-ok", session_id: "sess-delayed-mcp" }) + "\\n");
  }).catch(() => process.exit(83));
}, 100);
`);
  chmodSync(cursorBin, 0o700);
  try {
    const adapter = new CursorProviderAdapter({
      cursorBin,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          return defaultLaunchTurn({
            ...input,
            testAgentUpstreamEndpoint: "http://127.0.0.1:9",
            testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
          });
        },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({
      workAttemptId: "wa-cursor-live-contract-delayed",
      cwd: root,
    }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
      inboxItemId: "live-contract-delayed",
    })));
    assert.equal(result.text, "delayed-mcp-ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("supervised Cursor binds its private worker socket only inside its per-turn data dir", {
  // The network sandbox that admits this bind is macOS seatbelt only (see the
  // `sandboxed = process.platform === "darwin"` gate in the adapter).
  skip: process.platform !== "darwin",
}, async () => {
  const dataRoot = mkdtempSync(join(cursorTmp, "letagents-cursor-data-"));
  const outsideRoot = mkdtempSync(join(cursorTmp, "letagents-cursor-outside-"));
  try {
    const result = await runSupervisedWorkerSocketProbe({ label: "solo", dataRoot, outsideRoot });
    assert.equal(result.inside, "OK",
      `Cursor's headless worker binds its private stdio socket under CURSOR_DATA_DIR (stderr: ${result.stderrTail})`);
    assert.equal(result.outside, "EPERM",
      "a unix-socket listen() outside the per-turn data dir stays denied even where file writes are permitted");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("concurrent supervised Cursor turns keep isolated worker-socket namespaces and a slow worker still binds", {
  // macOS seatbelt only — the network-inbound boundary does not exist off darwin.
  skip: process.platform !== "darwin",
}, async () => {
  // Random per-turn data dirs (different paths). Each turn's "outside" root is
  // the OTHER turn's data root, so a pass proves one supervised turn can never
  // bind inside a peer's private namespace. One worker starts late to show the
  // static rule does not depend on startup timing.
  const dataRootA = mkdtempSync(join(cursorTmp, "letagents-cursor-data-"));
  const dataRootB = mkdtempSync(join(cursorTmp, "letagents-cursor-data-"));
  try {
    const [a, b] = await Promise.all([
      runSupervisedWorkerSocketProbe({ label: "concurrent-a", dataRoot: dataRootA, outsideRoot: dataRootB, probeBeforeBindMs: 300 }),
      runSupervisedWorkerSocketProbe({ label: "concurrent-b", dataRoot: dataRootB, outsideRoot: dataRootA }),
    ]);
    assert.equal(a.inside, "OK", `slow-starting turn A still binds its own worker socket (stderr: ${a.stderrTail})`);
    assert.equal(a.outside, "EPERM", "turn A cannot bind inside turn B's per-turn namespace");
    assert.equal(b.inside, "OK", `turn B binds its own worker socket (stderr: ${b.stderrTail})`);
    assert.equal(b.outside, "EPERM", "turn B cannot bind inside turn A's per-turn namespace");
  } finally {
    rmSync(dataRootA, { recursive: true, force: true });
    rmSync(dataRootB, { recursive: true, force: true });
  }
});

test("the exact live Cursor connector times out and reaps native work when Cursor never connects", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-live-contract-no-connector-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  let cursorBin = join(root, "fake-cursor-agent");
  const nativePidPath = join(root, "tmp", "native.pid");
  const connectorRoots: string[] = [];
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(dirname(nativePidPath), { recursive: true });
  cursorBin = writeFakeProvider(cursorBin, `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(nativePidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`);
  chmodSync(cursorBin, 0o700);
  try {
    const adapter = new CursorProviderAdapter({
      cursorBin,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          connectorRoots.push(dirname(input.mcpConnectorSocketPath!));
          return defaultLaunchTurn({
            ...input,
            testAgentUpstreamEndpoint: "http://127.0.0.1:9",
            testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
            // Budgets BOTH the wrapper's verify handshake and the connect
            // wait; too tight and a slow node cold-start times verify out
            // first, changing the expected failure message. A node cold start
            // on Windows takes several times longer.
            testMcpCapabilityTimeoutMs: process.platform === "win32" ? 5_000 : 500,
          });
        },
      },
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({
      workAttemptId: "wa-cursor-live-contract-no-connector",
      cwd: root,
    }));
    await assert.rejects(
      withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "live-contract-no-connector" }))),
      /never connected the attested MCP runtime before model authority/,
    );
    assert.equal(await waitForPath(nativePidPath), true);
    const nativePid = Number(readFileSync(nativePidPath, "utf8"));
    assert.throws(
      () => process.kill(nativePid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      "the connector deadline reaps native work that never initialized MCP",
    );
    assert.equal(connectorRoots.length, 1);
    assert.equal(existsSync(connectorRoots[0]!), false, "the unclaimed connector capability is removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a wedged hosted runtime fails the verify deadline before any native launch and is reaped", async () => {
  // The verify-phase timeout is the only bound between wrapper start and
  // connector listen; this pins it so a mutation that drops the deadline
  // (reintroducing an unbounded startup wait) fails loudly.
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-live-wedged-runtime-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  let cursorBin = join(root, "fake-cursor-agent");
  const nativePidPath = join(root, "tmp", "native.pid");
  const wedgedRuntime = join(root, "wedged-runtime.cjs");
  const wedgedPidPath = join(root, "wedged-runtime.pid");
  const connectorRoots: string[] = [];
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(dirname(nativePidPath), { recursive: true });
  writeFileSync(wedgedRuntime, `
require("node:fs").writeFileSync(${JSON.stringify(wedgedPidPath)}, String(process.pid));
process.stdin.on("data", () => {});
setInterval(() => {}, 1000);
`);
  cursorBin = writeFakeProvider(cursorBin, `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(nativePidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`);
  chmodSync(cursorBin, 0o700);
  try {
    const adapter = new CursorProviderAdapter({
      cursorBin,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          connectorRoots.push(dirname(input.mcpConnectorSocketPath!));
          return defaultLaunchTurn({
            ...input,
            mcpRuntimeEntryPath: wedgedRuntime,
            testAgentUpstreamEndpoint: "http://127.0.0.1:9",
            testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
            // A node cold start on Windows takes several times longer: the wedged runtime must still start.
            testMcpCapabilityTimeoutMs: process.platform === "win32" ? 3_000 : 300,
          });
        },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({
      workAttemptId: "wa-cursor-live-wedged-runtime",
      cwd: root,
    }));
    await assert.rejects(
      withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "live-wedged-runtime" }))),
      /did not prove the complete_room_turn contract before launch/,
    );
    assert.equal(existsSync(nativePidPath), false, "native Cursor must never launch after a wedged verify phase");
    assert.equal(await waitForPath(wedgedPidPath), true);
    const wedgedPid = Number(readFileSync(wedgedPidPath, "utf8"));
    await waitFor(() => {
      try { process.kill(wedgedPid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    });
    assert.equal(connectorRoots.length, 1);
    await waitFor(() => !existsSync(connectorRoots[0]!));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
