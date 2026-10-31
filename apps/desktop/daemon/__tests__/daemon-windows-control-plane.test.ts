import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { connectDaemon, isWindowsPipePath } from "../../../../shared/daemon-endpoint.mjs";
import { DaemonControlSocket, DaemonEndpointInUseError } from "../control-socket.js";
import { DaemonAlreadyRunningError, DaemonSingleton, defaultDaemonPaths } from "../singleton.js";
import { DAEMON_PROTOCOL_VERSION } from "../types.js";
import { daemonRequest, fixture, testDaemonEndpoint, within } from "./helpers/daemon-fixture.js";

const windowsOnly = process.platform !== "win32" && "needs a real Windows host (named pipes, unshared file handles)";

/** An in-memory stand-in for CreateFileW with share mode 0. */
function fakeExclusiveFiles() {
  const held = new Set<string>();
  const opened: string[] = [];
  return {
    held,
    opened,
    openExclusive: async (path: string) => {
      opened.push(path);
      if (held.has(path)) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      held.add(path);
      return { close: async () => { held.delete(path); } };
    },
  };
}

test("a Windows host takes the unshared-handle lock; a second holder is refused and release hands it on", async () => {
  const env = await fixture();
  try {
    const files = fakeExclusiveFiles();
    const lock = join(env.root, "daemon.lock");
    // Tests inject "darwin" for the daemon itself; a Windows host still locks for real.
    const first = new DaemonSingleton(lock, "darwin", { platform: "win32", openExclusive: files.openExclusive });
    const second = new DaemonSingleton(lock, "win32", { platform: "win32", openExclusive: files.openExclusive });
    assert.equal(await first.acquire(), 1);
    await assert.rejects(() => second.acquire(), DaemonAlreadyRunningError);
    assert.throws(() => second.currentGeneration);
    await first.release();
    assert.equal(files.held.size, 0);
    assert.equal(await second.acquire(), 2, "the generation fence still advances across a handoff");
    assert.deepEqual(files.opened, [lock, lock, lock]);
    assert.equal((await readFile(`${lock}.generation`, "utf8")).trim(), "2");
    await second.release();
  } finally { await env.cleanup(); }
});

test("only a sharing violation means another daemon; other open errors propagate", async () => {
  const env = await fixture();
  try {
    const denied = new DaemonSingleton(join(env.root, "daemon.lock"), "win32", {
      platform: "win32",
      openExclusive: async () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); },
    });
    await assert.rejects(() => denied.acquire(), (error: unknown) => !(error instanceof DaemonAlreadyRunningError) && /EACCES/.test(String(error)));
    // On a non-Windows host, EBUSY is not a lock answer at all.
    const files = fakeExclusiveFiles();
    const posix = new DaemonSingleton(join(env.root, "posix.lock"), "darwin", { platform: "linux", openExclusive: files.openExclusive });
    await posix.acquire();
    assert.deepEqual(files.opened, [], "only a Windows host opens the unshared handle");
    await posix.release();
  } finally { await env.cleanup(); }
});

test("the singleton accepts macOS and Windows and refuses other platforms", async () => {
  const env = await fixture();
  try {
    await assert.rejects(() => new DaemonSingleton(join(env.root, "daemon.lock"), "linux").acquire(), /macOS and Windows only/);
  } finally { await env.cleanup(); }
});

test("default daemon paths come from the state directory, with a pipe and proof on Windows", () => {
  const posix = defaultDaemonPaths("/Users/owner/.letagents", "darwin");
  assert.equal(posix.stateDir, "/Users/owner/.letagents");
  assert.equal(posix.socketPath, "/Users/owner/.letagents/daemon.sock");
  assert.equal(posix.peerProofPath, null);
  assert.equal(posix.lockPath, join("/Users/owner/.letagents", "daemon.lock"));
  const windows = defaultDaemonPaths("C:\\Users\\Owner\\.letagents", "win32");
  assert.equal(isWindowsPipePath(windows.socketPath), true);
  assert.match(windows.peerProofPath ?? "", /daemon-endpoint\.proof$/);
});

test("a pipe endpoint without a client proof refuses to listen", async () => {
  const socket = new DaemonControlSocket("\\\\.\\pipe\\letagents-daemon-test-no-proof", () => ({}));
  await assert.rejects(() => socket.start(), /needs a client proof/);
});

test("a proof-gated control socket serves a proven client and never handles an unproven request", async () => {
  const env = await fixture();
  const { socketPath, peerProofPath } = testDaemonEndpoint(env.root);
  const proofPath = peerProofPath ?? join(env.root, "daemon-endpoint.proof");
  const handled: string[] = [];
  const socket = new DaemonControlSocket(socketPath, (request) => { handled.push(request.method); return { healthy: true }; }, undefined, undefined, { peerProofPath: proofPath });
  try {
    await socket.start();
    const proven = await new Promise<string>((resolve, reject) => {
      const client = connectDaemon(socketPath, { proofPath, handshake: true });
      let received = "";
      client.setEncoding("utf8");
      client.once("error", reject);
      client.on("data", (chunk: string) => { received += chunk; if (received.includes("\n")) { client.end(); resolve(received); } });
      client.once("connect", () => client.write(`${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: "proven", method: "daemon.status" })}\n`));
    });
    assert.equal(JSON.parse(proven).ok, true);
    const unproven = await new Promise<string>((resolve) => {
      const client = createConnection(socketPath);
      let received = "";
      client.setEncoding("utf8");
      client.on("error", () => undefined);
      client.on("data", (chunk: string) => { received += chunk; });
      client.once("connect", () => client.write(`${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: "raw", method: "manifest.list" })}\n`));
      client.once("close", () => resolve(received));
    });
    assert.equal(unproven, "");
    assert.deepEqual(handled, ["daemon.status"]);
  } finally {
    await socket.stop();
    await env.cleanup();
  }
});

test("Windows: a daemon pipe name held by another listener fails closed; a released name is taken over", { skip: windowsOnly }, async () => {
  const env = await fixture();
  const { socketPath, peerProofPath } = testDaemonEndpoint(env.root);
  const squatter = createServer(() => undefined);
  try {
    await new Promise<void>((resolve, reject) => { squatter.once("error", reject); squatter.listen(socketPath, resolve); });
    const blocked = new DaemonControlSocket(socketPath, () => ({}), undefined, undefined, { peerProofPath, pipeReleaseWaitMs: 200 });
    await assert.rejects(() => blocked.start(), DaemonEndpointInUseError);
    // A handoff: the previous daemon closes its pipe while the next one waits.
    const successor = new DaemonControlSocket(socketPath, () => ({ healthy: true }), undefined, undefined, { peerProofPath, pipeReleaseWaitMs: 5_000 });
    const started = successor.start();
    setTimeout(() => squatter.close(), 100);
    await within(started, "successor listen after the name is released", 5_000);
    assert.equal((await daemonRequest(socketPath, "daemon.status")).ok, true);
    await successor.stop();
  } finally {
    squatter.close();
    await env.cleanup();
  }
});

test("Windows: a successor takes the pipe name while a slow client still holds the old one", { skip: windowsOnly }, async (t) => {
  const env = await fixture();
  const { socketPath, peerProofPath } = testDaemonEndpoint(env.root);
  const first = new DaemonControlSocket(socketPath, () => ({ healthy: true }), undefined, undefined, { peerProofPath });
  let successor: DaemonControlSocket | null = null;
  let lingering: ReturnType<typeof createConnection> | null = null;
  try {
    await first.start();
    // allowHalfOpen: the client does not close its handle when the daemon ends the connection.
    const client = createConnection({ path: socketPath, allowHalfOpen: true });
    lingering = client;
    await within(new Promise<void>((resolve, reject) => { client.once("connect", () => resolve()); client.once("error", reject); }), "lingering client connect", 5_000);
    client.on("error", () => undefined);
    await first.stop();
    successor = new DaemonControlSocket(socketPath, () => ({ healthy: true }), undefined, undefined, { peerProofPath, pipeReleaseWaitMs: 10_000 });
    const startedAt = Date.now();
    const releaseAt = 500;
    const release = setTimeout(() => client.destroy(), releaseAt);
    await within(successor.start(), "successor listen while an old client handle lingers", 10_000);
    clearTimeout(release);
    t.diagnostic(`successor listened after ${Date.now() - startedAt} ms (the old client handle closed at ${releaseAt} ms)`);
    assert.equal((await daemonRequest(socketPath, "daemon.status")).ok, true);
  } finally {
    lingering?.destroy();
    await successor?.stop();
    await env.cleanup();
  }
});

test("Windows: the singleton excludes another process until that process exits", { skip: windowsOnly }, async () => {
  const env = await fixture();
  const lock = join(env.root, "daemon.lock");
  const singletonUrl = pathToFileURL(join(process.cwd(), "daemon/singleton.ts")).href;
  const script = `
    const { DaemonSingleton } = await import(${JSON.stringify(singletonUrl)});
    const singleton = new DaemonSingleton(${JSON.stringify(lock)}, "win32");
    process.send({ generation: await singleton.acquire() });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  try {
    const message = await within(new Promise<{ generation: number }>((resolve, reject) => {
      child.once("message", (value) => resolve(value as { generation: number }));
      child.once("exit", (code) => reject(new Error(`holder exited ${code}: ${stderr}`)));
    }), "holder process lock", 20_000);
    assert.equal(message.generation, 1);
    const contender = new DaemonSingleton(lock, "win32");
    await assert.rejects(() => contender.acquire(), DaemonAlreadyRunningError);
    assert.equal((await stat(lock)).isFile(), true);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await within(exited, "holder exit", 10_000);
    // The kernel closed the dead holder's handle; no stale-lock cleanup is needed.
    assert.equal(await contender.acquire(), 2);
    await contender.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await env.cleanup();
  }
});

test("across processes: a daemon starts, a second start is refused, a client connects, and a handoff completes", {
  // Linux CI models the lock in-process only, so cross-process exclusion is real on macOS and Windows.
  skip: process.platform !== "darwin" && process.platform !== "win32" ? "the host lock is simulated on this platform" : false,
}, async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    ...testDaemonEndpoint(env.root),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
  };
  const mainUrl = pathToFileURL(join(process.cwd(), "daemon/main.ts")).href;
  const script = `
    const { SupervisorDaemon } = await import(${JSON.stringify(mainUrl)});
    const daemon = new SupervisorDaemon(${JSON.stringify(paths)}, "darwin");
    // This fixture has no Electron signing custodian.
    await daemon.start({ getHostApprovalPublicKey: async () => null });
    process.send({ type: "ready" });
    await daemon.waitForHandoff();
    process.send({ type: "handed_off" });
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const message = (type: string, timeoutMs: number) => within(new Promise<void>((resolve, reject) => {
    const listener = (value: unknown) => { if ((value as { type?: string })?.type === type) { child.off("message", listener); resolve(); } };
    child.on("message", listener);
    void exited.then((code) => reject(new Error(`daemon process exited ${code} before ${type}: ${stderr}`)));
  }), `daemon process ${type}`, timeoutMs);
  let successor: InstanceType<typeof import("../main.js").SupervisorDaemon> | null = null;
  try {
    await message("ready", 30_000);
    const { SupervisorDaemon } = await import("../main.js");
    successor = new SupervisorDaemon(paths, "darwin");
    await assert.rejects(() => successor!.start({ getHostApprovalPublicKey: async () => null }), DaemonAlreadyRunningError,
      "a second daemon is refused while the first process holds the lock");
    const status = await daemonRequest(paths.socketPath, "daemon.status");
    assert.equal(status.ok, true);
    assert.equal((status.result as { generation: number }).generation, 1);
    const handedOff = message("handed_off", 15_000);
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    await handedOff;
    assert.equal(await within(exited, "first daemon exit", 15_000), 0);
    successor = new SupervisorDaemon(paths, "darwin");
    await within(successor.start({ getHostApprovalPublicKey: async () => null }), "successor start after handoff", 15_000);
    assert.equal(((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation, 2);
  } finally {
    await successor?.stop().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await env.cleanup();
  }
});
