import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";

import {
  SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION,
  SUPERVISOR_DAEMON_PROTOCOL_VERSION,
  SupervisorDaemonClient,
  onSupervisorActivity,
  publishSupervisorActivity,
  supervisorDaemonSpawnEnvironment,
  supervisorDaemonClient,
} from "../main/supervisor-daemon.js";

const daemonScriptPath = join(dirname(fileURLToPath(import.meta.url)), "../../daemon/main.ts");
const daemonTypesPath = join(dirname(fileURLToPath(import.meta.url)), "../../daemon/types.ts");
const desktopPackagePath = join(dirname(fileURLToPath(import.meta.url)), "../../package.json");
const daemonClientPath = join(dirname(fileURLToPath(import.meta.url)), "../main/supervisor-daemon.ts");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "letagents-electron-supervisor-"));
  return { root, socketPath: join(root, "daemon.sock"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

function fakeChild(): ChildProcess {
  const child = { once() { return child; }, unref() { return child; } };
  return child as unknown as ChildProcess;
}

async function startWireDaemon(
  socketPath: string,
  version: number,
  generation: number,
  onPrepare?: () => void,
  implementationVersion = SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION,
  controlTurnDelayMs = 0,
) {
  const entries: Array<Record<string, any>> = [];
  const legacyOwners: Array<Record<string, any>> = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as { id: string; method: string; params?: Record<string, any> };
      let result: unknown;
      let responseDelayMs = 0;
      if (request.method === "daemon.negotiate" || request.method === "daemon.status") {
        result = { healthy: true, protocol_version: version, implementation_version: implementationVersion, generation, pid: 77, started_at: "2026-01-01T00:00:00.000Z" };
      } else if (request.method === "daemon.prepare_handoff") {
        result = { accepted: true };
        setTimeout(() => onPrepare?.(), 5);
      } else if (request.method === "manifest.list") {
        result = entries;
      } else if (request.method === "manifest.put") {
        const next = { ...request.params!.entry, workplace_liveness: { state: "unknown", observed_at: null, detail: null }, native_liveness: { state: "unknown", observed_at: null, detail: null }, activity: [] };
        const existing = entries.find((candidate) => candidate.id === next.id);
        if (!existing) entries.push(next);
        result = existing ?? next;
      } else if (request.method === "manifest.set_desired_state") {
        const entry = entries.find((candidate) => candidate.id === request.params!.id)!;
        entry.desired_state = request.params!.desired_state;
        result = entry;
      } else if (request.method === "manifest.compare_and_set_desired_state") {
        const entry = entries.find((candidate) => candidate.id === request.params!.id)!;
        const applied = entry.desired_state === request.params!.expected_desired_state;
        if (applied) entry.desired_state = request.params!.desired_state;
        result = { applied, entry };
      } else if (request.method === "manifest.control_turn") {
        responseDelayMs = controlTurnDelayMs;
        result = {
          entryId: request.params!.id,
          workAttemptId: request.params!.work_attempt_id,
          executionGenerationId: request.params!.execution_generation_id,
          actionId: request.params!.action_id,
          capability: "native_interrupt",
          interrupted: true,
          resumed: Boolean(request.params!.correction),
          state: request.params!.correction ? "working" : "idle",
          duplicate: false,
          stages: ["delivered", "interrupting", "applied", "resumed"],
        };
      } else if (request.method === "lane.reserve_legacy") {
        const owner = {
          reservation_id: request.params!.reservation_id,
          room_id: request.params!.room_id,
          provider: request.params!.provider,
          owner_pid: request.params!.owner_pid,
          owner_process_identity: request.params!.owner_process_identity,
          state: "reserved",
          session_id: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        };
        legacyOwners.push(owner);
        result = owner;
      } else if (request.method === "lane.activate_legacy") {
        const owner = legacyOwners.find((candidate) => candidate.reservation_id === request.params!.reservation_id)!;
        owner.state = "active";
        owner.session_id = request.params!.session_id;
        result = owner;
      } else if (request.method === "lane.release_legacy") {
        const index = legacyOwners.findIndex((candidate) =>
          candidate.reservation_id === request.params!.reservation_id
          || candidate.session_id === request.params!.session_id
          || (candidate.room_id === request.params!.room_id && candidate.provider === request.params!.provider));
        if (index >= 0) legacyOwners.splice(index, 1);
        result = { released: index >= 0 };
      } else if (request.method === "attempt.read") {
        const entry = entries.find((candidate) => candidate.id === request.params!.id)!;
        result = { entry_id: entry.id, work_attempt_id: null, workspace_path: entry.workspace_path, last_terminal: null, restart_count: 0, activity: entry.activity };
      } else if (request.method === "manifest.append_activity") {
        const entry = entries.find((candidate) => candidate.id === request.params!.id)!;
        entry.activity.push(request.params!.event);
        result = entry;
      } else {
        socket.end(`${JSON.stringify({ version, id: request.id, ok: false, error: "unsupported" })}\n`);
        return;
      }
      const response = `${JSON.stringify({ version, id: request.id, ok: true, result })}\n`;
      if (responseDelayMs) setTimeout(() => socket.end(response), responseDelayMs);
      else socket.end(response);
    });
  });
  await mkdir(dirname(socketPath), { recursive: true });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  return { server, entries };
}

async function closeServer(server: Server | null, socketPath: string): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await unlink(socketPath).catch(() => undefined);
}

test("local supervisor activity subscribers receive only the canonical redacted event", async () => {
  const canary = "canary-not-a-real-emitter-secret-123456789";
  const originalAppend = supervisorDaemonClient.appendActivity;
  let sentToDaemon: unknown;
  let emitted: unknown;
  (supervisorDaemonClient as unknown as { appendActivity: (id: string, event: unknown) => Promise<unknown> }).appendActivity = async (_id, event) => {
    sentToDaemon = event;
    return {};
  };
  const unsubscribe = onSupervisorActivity((event) => { emitted = event; });
  try {
    await publishSupervisorActivity({
      entryId: "credential_emitter",
      provider: `provider Authorization: Bearer ${canary}`,
      kind: `kind clientSecret=${canary}`,
      method: `method Authorization: Basic ${canary}`,
      summary: `${"x".repeat(470)} Authorization: Bearer ${canary}`,
      status: "working",
      payload: { output: JSON.stringify({ clientSecret: canary }) },
    });
    assert.doesNotMatch(JSON.stringify(sentToDaemon), new RegExp(canary));
    assert.doesNotMatch(JSON.stringify(emitted), new RegExp(canary));
    assert.match(JSON.stringify(emitted), /REDACTED/i);
    assert.match((emitted as { event: { summary: string } }).event.summary, /Authorization: Bearer \[REDACTED\]/);
  } finally {
    unsubscribe();
    (supervisorDaemonClient as unknown as { appendActivity: typeof originalAppend }).appendActivity = originalAppend;
  }
});

test("turn control keeps the client socket alive beyond the generic request timeout", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  const wire = await startWireDaemon(
    env.socketPath,
    SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    3,
    undefined,
    SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION,
    50,
  );
  try {
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
      requestTimeoutMs: 20,
      turnControlRequestTimeoutMs: 100,
      spawnDaemon: () => { throw new Error("healthy daemon must be reused"); },
    });
    const result = await client.controlTurn({
      entryId: "entry_exact",
      workAttemptId: "attempt_exact",
      executionGenerationId: "generation_exact",
      actionId: "action_exact",
      correction: "Use the corrected direction",
    });
    assert.equal(result.actionId, "action_exact");
    assert.deepEqual(result.stages, ["delivered", "interrupting", "applied", "resumed"]);
  } finally {
    await closeServer(wire.server, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("Electron client uses a healthy daemon and maps manifest/attempt data", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  const wire = await startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 3);
  try {
    const client = new SupervisorDaemonClient({ socketPath: env.socketPath, daemonScriptPath, spawnDaemon: () => { throw new Error("healthy daemon must be reused"); } });
    const status = await client.ensureRunning();
    assert.equal(status.generation, 3);
    const createInput = { creationRequestId: "request_alpha", roomIdentifier: "git-room:github.com:owner/repo", displayName: "Durable Codex", providerId: "codex" as const, charter: "Keep polling.", repoRootPath: "/tmp/work" };
    const created = await client.create(createInput);
    assert.deepEqual([created.desiredState, created.observedState, created.condition], ["paused", "absent", "none"]);
    const retried = await client.create(createInput);
    assert.equal(retried.id, created.id, "one Start request is idempotent across retries");
    const second = await client.create({ ...createInput, creationRequestId: "request_bravo", displayName: "Second durable Codex" });
    assert.notEqual(second.id, created.id, "a new Start request creates an independent same-provider agent");
    assert.equal(wire.entries.length, 2);
    const activityCanary = "canary-not-a-real-renderer-secret-123456789";
    wire.entries[0]!.activity = [{
      observed_at: "2026-01-01T00:00:01.000Z",
      sequence: 1,
      provider: "claude-code",
      kind: "tool_result",
      method: `tool Authorization: Bearer ${activityCanary}`,
      summary: `LETAGENTS_TOKEN=${activityCanary}`,
      status: "working",
      payload: { output: JSON.stringify({ LETAGENTS_TOKEN: activityCanary }) },
      payload_truncated: false,
      payload_redacted: false,
      durable_payload_ref: null,
    }];
    const rendererSafe = (await client.list(created.roomId)).find((candidate) => candidate.id === created.id)!;
    assert.doesNotMatch(JSON.stringify(rendererSafe.activity), new RegExp(activityCanary));
    assert.equal(rendererSafe.activity[0]?.payloadRedacted, true);
    Object.assign(wire.entries[0], {
      work_attempt_id: "attempt_alpha",
      provider_ref: {
        provider_continuation_id: "continuation_alpha",
        execution_generation_id: "generation_alpha",
        provider_connection: { kind: "codex_app_server", pid: 4242 },
      },
      worker_binding: {
        agent_session_id: "agent_session_rebound",
        work_attempt_id: "attempt_alpha",
        execution_generation_id: "generation_alpha",
        updated_at: "2026-07-15T18:00:00.000Z",
      },
      turn_control: {
        action_id: "action_persisted",
        work_attempt_id: "attempt_alpha",
        execution_generation_id: "generation_alpha",
        status: "completed",
        capability: "native_interrupt",
        interrupted: true,
        resumed: true,
        state: "working",
        stages: ["delivered", "interrupting", "applied", "resumed"],
        error: null,
        recorded_at: "2026-07-15T18:00:01.000Z",
        updated_at: "2026-07-15T18:00:02.000Z",
      },
    });
    const rebound = (await client.list(created.roomId)).find((entry) => entry.id === created.id)!;
    assert.equal(rebound.agentSessionId, "agent_session_rebound");
    assert.equal(rebound.agentSessionBindingState, "active");
    assert.equal(rebound.executionGenerationId, "generation_alpha");
    assert.equal(rebound.providerContinuationId, "continuation_alpha");
    assert.equal(rebound.providerPid, 4242);
    assert.equal(rebound.turnControl?.actionId, "action_persisted");
    assert.deepEqual(rebound.turnControl?.stages, ["delivered", "interrupting", "applied", "resumed"]);
    Object.assign(wire.entries[0], {
      worker_binding: null,
      last_worker_binding: {
        agent_session_id: "agent_session_rebound",
        work_attempt_id: "attempt_alpha",
        execution_generation_id: "generation_alpha",
        updated_at: "2026-07-15T18:00:00.000Z",
      },
    });
    const temporarilyUnbound = (await client.list(created.roomId)).find((entry) => entry.id === created.id)!;
    assert.equal(temporarilyUnbound.agentSessionId, "agent_session_rebound", "identity-only history keeps exact controls routed after live credentials unbind");
    assert.equal(temporarilyUnbound.agentSessionBindingState, "historical", "historical control identity never masquerades as an active room binding");
    await assert.rejects(
      () => client.assertLegacyStartAllowed(created.roomId, "codex"),
      /already owns the codex lane through the supervised engine/,
      "the paused transfer claim fences a concurrent legacy start before activation",
    );
    assert.equal((await client.setDesiredState(created.id, "running")).desiredState, "running");
    assert.equal(await client.compareAndSetDesiredState(created.id, "paused", "stopped"), null);
    assert.equal((await client.setDesiredState(second.id, "running")).desiredState, "running");
    assert.equal((await client.setDesiredState(created.id, "stopped")).desiredState, "stopped");
    const listed = await client.list(created.roomId);
    assert.equal(listed.find((entry) => entry.id === second.id)?.desiredState, "running", "stopping one same-provider agent does not affect its peer");
    assert.equal((await client.readAttempt(created.id)).workspacePath, null);
    await client.create({
      roomIdentifier: "git-room:github.com:owner/claude-repo",
      displayName: "Durable Claude",
      providerId: "claude-code",
      charter: "Keep polling.",
      repoRootPath: "/tmp/claude-work",
      launchPolicy: { permissionMode: "acceptEdits", model: "sonnet" },
    });
    assert.deepEqual(
      wire.entries.find((candidate) => candidate.provider === "claude-code")?.provider_launch_policy,
      { permissionMode: "acceptEdits", model: "sonnet" },
    );
    const reservation = await client.reserveLegacyLane("room_legacy_client", "codex", "legacy_client");
    assert.equal(reservation.owner_pid, process.pid);
    assert.equal((await client.activateLegacyLane("legacy_client", "legacy_session_client")).state, "active");
    assert.equal(await client.releaseLegacyLane({ roomIdentifier: "room_legacy_client", provider: "codex" }), true);
  } finally {
    await closeServer(wire.server, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("desktop and daemon implementation identities stay in lockstep", async () => {
  const daemonTypes = await readFile(daemonTypesPath, "utf8");
  const daemonIdentity = daemonTypes.match(/DAEMON_IMPLEMENTATION_VERSION\s*=\s*"([^"]+)"/)?.[1];
  assert.equal(daemonIdentity, SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION);
});

test("desktop dev daemon uses the exact rebuilt repo MCP and packaged launches ignore inherited overrides", () => {
  const sourceRoot = '/tmp/LetAgents source "quoted"';
  const inherited = {
    LETAGENTS_API_URL: "https://letagents.chat",
    LETAGENTS_DEV_MCP_SERVER_ENTRY: "/tmp/unrelated-cwd/stale-cache/server.js",
  };

  const packaged = supervisorDaemonSpawnEnvironment(inherited, sourceRoot);
  assert.equal(packaged.LETAGENTS_DEV_MCP_SERVER_ENTRY, undefined, "packaged launch keeps the installed MCP fallback");
  assert.equal(packaged.LETAGENTS_API_URL, inherited.LETAGENTS_API_URL, "unrelated auth/runtime environment is preserved");

  const development = supervisorDaemonSpawnEnvironment({
    ...inherited,
    LETAGENTS_DESKTOP_DEV_SERVER_URL: "http://127.0.0.1:5174",
  }, sourceRoot);
  assert.equal(
    development.LETAGENTS_DEV_MCP_SERVER_ENTRY,
    join(sourceRoot, "dist", "mcp", "server.js"),
    "dev launch derives the exact repo build instead of trusting inherited cwd or cache state",
  );
  assert.equal(development.ELECTRON_RUN_AS_NODE, "1");
});

test("desktop development watches daemon builds and rejects a stale replacement implementation", async () => {
  const desktopPackage = JSON.parse(await readFile(desktopPackagePath, "utf8")) as { scripts?: Record<string, string> };
  assert.match(desktopPackage.scripts?.dev ?? "", /npm:watch:daemon/);
  assert.match(desktopPackage.scripts?.["watch:daemon"] ?? "", /tsconfig\.daemon\.json --watch/);
  const clientSource = await readFile(daemonClientPath, "utf8");
  const healthCheck = clientSource.slice(
    clientSource.indexOf("private async waitForHealthy"),
    clientSource.indexOf("private async waitForSocketDown"),
  );
  assert.match(healthCheck, /status\.implementationVersion !== SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION/);
  assert.match(healthCheck, /Rebuild the desktop daemon and try again/);
});

test("vN desktop performs negotiated handoff before spawning vN+1 daemon", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  let oldServer: Server | null = null;
  let replacementServer: Server | null = null;
  let spawns = 0;
  const old = await startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION - 1, 7, () => { void closeServer(oldServer, env.socketPath); });
  oldServer = old.server;
  try {
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
      spawnDaemon: () => {
        spawns += 1;
        void startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 8).then((wire) => { replacementServer = wire.server; });
        return fakeChild();
      },
    });
    const status = await client.ensureRunning();
    assert.equal(spawns, 1);
    assert.equal(status.protocolVersion, SUPERVISOR_DAEMON_PROTOCOL_VERSION);
    assert.equal(status.generation, 8);
  } finally {
    await closeServer(replacementServer, env.socketPath);
    await closeServer(oldServer, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("desktop replaces a stale same-protocol daemon and launches the replacement from a stable cwd", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  let oldServer: Server | null = null;
  let replacementServer: Server | null = null;
  let handoffPrepared = false;
  let spawnedCwd: string | null = null;
  const stableCwd = join(env.root, "stable-daemon-cwd");
  const old = await startWireDaemon(
    env.socketPath,
    SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    11,
    () => {
      handoffPrepared = true;
      void closeServer(oldServer, env.socketPath);
    },
    "2.0.0-stale",
  );
  oldServer = old.server;
  try {
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
      daemonWorkingDirectory: stableCwd,
      spawnDaemon: (_scriptPath, cwd) => {
        spawnedCwd = cwd;
        void startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 12)
          .then((wire) => { replacementServer = wire.server; });
        return fakeChild();
      },
    });
    const status = await client.ensureRunning();
    assert.equal(handoffPrepared, true, "implementation mismatch must prepare the running generation for handoff");
    assert.equal(status.generation, 12);
    assert.equal(status.implementationVersion, SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION);
    assert.equal(spawnedCwd, stableCwd);
    assert.equal((await stat(stableCwd)).isDirectory(), true);
  } finally {
    await closeServer(replacementServer, env.socketPath);
    await closeServer(oldServer, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("desktop safely terminates a wedged negotiated daemon while preserving provider work", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  let oldServer: Server | null = null;
  let replacementServer: Server | null = null;
  let terminatedPid: number | null = null;
  const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const old = await startWireDaemon(
    env.socketPath,
    SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    21,
    undefined,
    "2.0.6-wedged",
  );
  oldServer = old.server;
  try {
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
      handoffTimeoutMs: 50,
      terminateDaemon: (pid) => {
        terminatedPid = pid;
        void closeServer(oldServer, env.socketPath);
      },
      spawnDaemon: () => {
        void startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 22)
          .then((wire) => { replacementServer = wire.server; });
        return fakeChild();
      },
    });
    const status = await client.ensureRunning();
    assert.equal(terminatedPid, 77, "only the re-negotiated exact daemon PID is terminated");
    assert.equal(status.generation, 22);
    assert.doesNotThrow(() => process.kill(provider.pid!, 0), "daemon recovery does not kill detached provider work");
  } finally {
    await closeServer(replacementServer, env.socketPath);
    await closeServer(oldServer, env.socketPath);
    provider.kill("SIGKILL");
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});
