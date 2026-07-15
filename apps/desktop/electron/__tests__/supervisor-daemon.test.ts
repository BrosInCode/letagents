import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ChildProcess } from "node:child_process";

import {
  SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION,
  SUPERVISOR_DAEMON_PROTOCOL_VERSION,
  SupervisorDaemonClient,
} from "../main/supervisor-daemon.js";

const daemonScriptPath = join(dirname(fileURLToPath(import.meta.url)), "../../daemon/main.ts");

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
      if (request.method === "daemon.negotiate" || request.method === "daemon.status") {
        result = { healthy: true, protocol_version: version, implementation_version: implementationVersion, generation, pid: 77, started_at: "2026-01-01T00:00:00.000Z" };
      } else if (request.method === "daemon.prepare_handoff") {
        result = { accepted: true };
        setTimeout(() => onPrepare?.(), 5);
      } else if (request.method === "manifest.list") {
        result = entries;
      } else if (request.method === "manifest.put") {
        const next = { ...request.params!.entry, workplace_liveness: { state: "unknown", observed_at: null, detail: null }, native_liveness: { state: "unknown", observed_at: null, detail: null }, activity: [] };
        entries.push(next);
        result = next;
      } else if (request.method === "manifest.set_desired_state") {
        const entry = entries.find((candidate) => candidate.id === request.params!.id)!;
        entry.desired_state = request.params!.desired_state;
        result = entry;
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
      socket.end(`${JSON.stringify({ version, id: request.id, ok: true, result })}\n`);
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

test("Electron client uses a healthy daemon and maps manifest/attempt data", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  const wire = await startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 3);
  try {
    const client = new SupervisorDaemonClient({ socketPath: env.socketPath, daemonScriptPath, spawnDaemon: () => { throw new Error("healthy daemon must be reused"); } });
    const status = await client.ensureRunning();
    assert.equal(status.generation, 3);
    const created = await client.create({ roomIdentifier: "git-room:github.com:owner/repo", displayName: "Durable Codex", providerId: "codex", charter: "Keep polling.", repoRootPath: "/tmp/work" });
    assert.deepEqual([created.desiredState, created.observedState, created.condition], ["paused", "absent", "none"]);
    await assert.rejects(
      () => client.assertLegacyStartAllowed(created.roomId, "codex"),
      /already owns the codex lane through the supervised engine/,
      "the paused transfer claim fences a concurrent legacy start before activation",
    );
    assert.equal((await client.setDesiredState(created.id, "running")).desiredState, "running");
    assert.equal((await client.setDesiredState(created.id, "paused")).desiredState, "paused");
    assert.equal((await client.readAttempt(created.id)).workspacePath, null);
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
  let spawnedCwd: string | null = null;
  const stableCwd = join(env.root, "stable-daemon-cwd");
  const old = await startWireDaemon(
    env.socketPath,
    SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    11,
    () => { void closeServer(oldServer, env.socketPath); },
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
