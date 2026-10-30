import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { Socket, createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import test from "node:test";

import {
  DAEMON_PROOF_FILE,
  DAEMON_STATE_DIR_ENV,
  acceptDaemonPeer,
  connectDaemon,
  currentWindowsAccount,
  daemonConnectionTransport,
  daemonEndpoint,
  ensureDaemonProof,
  isWindowsPipePath,
  resolveDaemonProofPath,
  windowsPipeName,
} from "../../../shared/daemon-endpoint.mjs";
import { isRetryableSupervisorBridgeError } from "../server/runtime/supervisor-bridge.js";
import {
  assertOwnerPrivate,
  createPrivateDir,
  createWindowsSecurity,
  forgetOwnerPrivateCache,
  type WindowsSecurity,
} from "../../../shared/owner-private-fs.mjs";

const ACCOUNT = "owner";

test("POSIX endpoint is the unchanged socket file and needs no proof", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const endpoint = daemonEndpoint("/Users/owner/.letagents", { platform });
    assert.deepEqual(endpoint, {
      stateDir: "/Users/owner/.letagents",
      transport: "unix",
      listenPath: "/Users/owner/.letagents/daemon.sock",
      connectPath: "/Users/owner/.letagents/daemon.sock",
      proofPath: null,
    });
  }
  assert.throws(() => daemonEndpoint("", { platform: "darwin" }), /state directory is required/);
});

test("POSIX clients get the plain Unix socket connection, unchanged", { skip: process.platform === "win32" && "a Windows pipe always runs the handshake" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-endpoint-"));
  const server = createServer((socket) => socket.end("pong\n"));
  try {
    const path = daemonEndpoint(root).connectPath;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    const client = connectDaemon(path);
    // Exactly createConnection(path): a net.Socket of its own class, no handshake transport under it.
    assert.equal(Object.getPrototypeOf(client), Socket.prototype);
    assert.equal(daemonConnectionTransport(client), null);
    assert.deepEqual(await exchange(client, ""), { connected: true, data: "pong\n", error: null });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows endpoint is a per-user, per-state-root named pipe with a proof file beside the state", () => {
  const stateDir = "C:\\Users\\Owner\\.letagents";
  const endpoint = daemonEndpoint(stateDir, { platform: "win32", account: ACCOUNT });
  assert.equal(endpoint.transport, "pipe");
  assert.match(endpoint.listenPath, /^\\\\\.\\pipe\\letagents-daemon-[0-9a-f]{32}$/);
  assert.equal(endpoint.connectPath, endpoint.listenPath);
  assert.equal(endpoint.proofPath, win32.join(stateDir, DAEMON_PROOF_FILE));
  assert.equal(isWindowsPipePath(endpoint.connectPath), true);
  assert.equal(isWindowsPipePath("\\\\?\\pipe\\x"), true);
  assert.equal(isWindowsPipePath("C:\\Users\\Owner\\.letagents\\daemon.sock"), false);
  assert.equal(isWindowsPipePath("/tmp/daemon.sock"), false);

  // Windows paths compare without case and after resolution.
  assert.equal(daemonEndpoint("c:\\users\\owner\\.LETAGENTS\\", { platform: "win32", account: ACCOUNT }).connectPath, endpoint.connectPath);
  assert.notEqual(daemonEndpoint(stateDir, { platform: "win32", account: "someone-else" }).connectPath, endpoint.connectPath,
    "another user never shares the name");
  assert.notEqual(daemonEndpoint("D:\\state", { platform: "win32", account: ACCOUNT }).connectPath, endpoint.connectPath,
    "another state root never shares the name");
  assert.equal(windowsPipeName("letagents-daemon", win32.resolve(stateDir).toLowerCase(), ACCOUNT), endpoint.connectPath);
  // No subprocess: every process of one user computes the same name.
  assert.equal(daemonEndpoint(stateDir, { platform: "win32" }).connectPath,
    windowsPipeName("letagents-daemon", win32.resolve(stateDir).toLowerCase(), currentWindowsAccount()));
});

test("a worker that knows only the pipe name finds the proof through its state directories", () => {
  const stateDir = join(tmpdir(), "letagents-endpoint-worker-state");
  const pipe = windowsPipeName("letagents-daemon", win32.resolve(stateDir).toLowerCase(), currentWindowsAccount());
  assert.equal(resolveDaemonProofPath(pipe, { env: { [DAEMON_STATE_DIR_ENV]: stateDir }, home: join(tmpdir(), "elsewhere") }),
    win32.join(stateDir, DAEMON_PROOF_FILE));
  assert.equal(resolveDaemonProofPath("\\\\.\\pipe\\letagents-daemon-0123456789abcdef0123456789abcdef", { env: {}, home: join(tmpdir(), "elsewhere") }), null,
    "a pipe no state directory of this user owns has no proof");
});

test("the proof is created once, private, and survives restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-endpoint-"));
  try {
    const proofPath = join(root, DAEMON_PROOF_FILE);
    const first = await ensureDaemonProof(proofPath);
    assert.match(first, /^[a-f0-9]{64}$/);
    // POSIX: mode 0600. Windows: the account owns it, protected DACL for the account and SYSTEM only.
    await assertOwnerPrivate(proofPath, { kind: "file" });
    assert.deepEqual((await readdir(root)).sort(), [DAEMON_PROOF_FILE], "no staging file is left behind");
    assert.equal(await ensureDaemonProof(proofPath), first, "a handoff keeps the proof clients already read");
    await writeFile(proofPath, "not-a-proof\n");
    const replaced = await ensureDaemonProof(proofPath);
    assert.match(replaced, /^[a-f0-9]{64}$/);
    assert.notEqual(replaced, first);
    assert.equal((await readFile(proofPath, "utf8")).trim(), replaced);
    await assertOwnerPrivate(proofPath, { kind: "file" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one failed privacy check does not rotate a valid proof; two do", { skip: process.platform === "win32" && "an injected POSIX check; the Windows read is tested with a fake reader below" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-endpoint-"));
  try {
    const proofPath = join(root, DAEMON_PROOF_FILE);
    const first = await ensureDaemonProof(proofPath);
    // An injected check answers "not private" (as a failed DACL read does) a given number of times.
    let reads = 0;
    const flaky = (failures: number) => ({ checkPrivacy: async () => reads++ >= failures });
    assert.equal(await ensureDaemonProof(proofPath, { ...flaky(1), recheckDelayMs: 1 }), first, "a single failed read keeps the proof");
    reads = 0;
    assert.notEqual(await ensureDaemonProof(proofPath, { ...flaky(2), recheckDelayMs: 1 }).catch(() => "rotation attempted"), first,
      "two failed reads replace it");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a proof others could read is replaced, not reused", { skip: process.platform === "win32" && "POSIX mode bits; the Windows DACL case is covered by the owner-private helper's tests" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-endpoint-"));
  try {
    const proofPath = join(root, DAEMON_PROOF_FILE);
    const leaked = "a".repeat(64);
    await writeFile(proofPath, `${leaked}\n`, { mode: 0o644 });
    await chmod(proofPath, 0o644);
    const proof = await ensureDaemonProof(proofPath);
    assert.notEqual(proof, leaked);
    assert.equal((await stat(proofPath)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

/** A test endpoint: a real pipe on Windows, a Unix socket with the handshake forced elsewhere. */
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "letagents-endpoint-"));
  const endpoint = process.platform === "win32" ? daemonEndpoint(root) : null;
  const path = endpoint?.connectPath ?? join(root, "daemon.sock");
  const proofPath = join(root, DAEMON_PROOF_FILE);
  const proof = await ensureDaemonProof(proofPath);
  const servers: Server[] = [];
  const listen = async (onConnection: (socket: Socket) => void) => {
    const server = createServer(onConnection);
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    return server;
  };
  return {
    root, path, proof, proofPath,
    listen,
    connect: (options: { proofPath?: string } = {}) => connectDaemon(path, { proofPath: options.proofPath ?? proofPath, handshake: true }),
    cleanup: async () => {
      for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function exchange(socket: Socket, request: string): Promise<{ connected: boolean; data: string; error: NodeJS.ErrnoException | null }> {
  return new Promise((resolve) => {
    let connected = false;
    let data = "";
    let error: NodeJS.ErrnoException | null = null;
    socket.setEncoding("utf8");
    socket.once("connect", () => { connected = true; socket.write(request); });
    socket.on("data", (chunk: string) => { data += chunk; if (data.includes("\n")) socket.end(); });
    socket.once("error", (failure) => { error = failure; });
    socket.once("close", () => resolve({ connected, data, error }));
  });
}

test("a client with the proof reaches the daemon; neither side sees the handshake", async () => {
  const env = await harness();
  try {
    const seen: string[] = [];
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => { seen.push(chunk); admitted.write(`pong:${chunk}`); });
    }));
    const result = await exchange(env.connect(), "ping\n");
    assert.deepEqual(result, { connected: true, data: "pong:ping\n", error: null });
    assert.deepEqual(seen, ["ping\n"]);
  } finally { await env.cleanup(); }
});

test("the daemon closes a client without the proof before any request is handled", async () => {
  const env = await harness();
  try {
    let admitted = 0;
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, () => { admitted += 1; }));
    // A client that skips the handshake and sends a request at once.
    const raw = await exchange(createConnection(env.path), `${JSON.stringify({ version: 3, id: "x", method: "daemon.status" })}\n`);
    assert.equal(raw.data, "");
    // A client holding a different proof.
    const wrongProofPath = join(env.root, "wrong.proof");
    await ensureDaemonProof(wrongProofPath);
    const wrong = await exchange(env.connect({ proofPath: wrongProofPath }), "ping\n");
    assert.equal(wrong.connected, false);
    assert.equal(wrong.error?.code, "ERR_LETAGENTS_DAEMON_UNTRUSTED", "the daemon's answer does not match a wrong proof");
    // An oversized first line.
    const oversized = await exchange(createConnection(env.path), `${"x".repeat(4096)}\n`);
    assert.equal(oversized.data, "");
    assert.equal(admitted, 0);
  } finally { await env.cleanup(); }
});

test("a pipe squatter that cannot answer the proof never receives the request", async () => {
  const env = await harness();
  try {
    const received: string[] = [];
    await env.listen((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        received.push(chunk);
        socket.write(`${JSON.stringify({ letagents_daemon_server: "f".repeat(64), letagents_daemon_challenge: "a".repeat(64) })}\n`);
      });
    });
    const result = await exchange(env.connect(), "secret-request\n");
    assert.equal(result.connected, false, "the caller never sees connect");
    assert.equal(result.error?.code, "ERR_LETAGENTS_DAEMON_UNTRUSTED");
    assert.equal(received.join("").includes("secret-request"), false);
    assert.equal(received.join("").includes(env.proof), false, "the proof itself never crosses the connection");
  } finally { await env.cleanup(); }
});

test("a proof the client may not read keeps its access error; retrying cannot help", { skip: process.platform === "win32" && "POSIX mode 000 does not deny the owner on Windows" }, async () => {
  const env = await harness();
  try {
    await env.listen(() => assert.fail("no connection is admitted"));
    const { chmod } = await import("node:fs/promises");
    await chmod(env.proofPath, 0o000);
    const result = await exchange(env.connect(), "ping\n");
    await chmod(env.proofPath, 0o600);
    assert.equal(result.connected, false);
    assert.equal(result.error?.code, process.getuid?.() === 0 ? undefined : "EACCES");
    assert.equal(isRetryableSupervisorBridgeError(result.error), false);
  } finally { await env.cleanup(); }
});

test("a client refuses an exposed proof before it connects", { skip: process.platform === "win32" && "POSIX mode bits; the Windows DACL check is the owner-private helper's" }, async () => {
  const env = await harness();
  try {
    let connections = 0;
    await env.listen(() => { connections += 1; });
    await chmod(env.proofPath, 0o644);
    const result = await exchange(env.connect(), "ping\n");
    assert.equal(result.connected, false);
    assert.equal(result.error?.code, "ERR_LETAGENTS_DAEMON_UNTRUSTED");
    assert.match(result.error?.message ?? "", /not private to this account/);
    assert.equal(isRetryableSupervisorBridgeError(result.error), false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(connections, 0, "the daemon sees nothing from a client holding an exposed proof");
  } finally { await env.cleanup(); }
});

test("a proof that becomes exposed is refused at once, despite the cache", { skip: process.platform === "win32" && "POSIX mode bits" }, async () => {
  const env = await harness();
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
    }));
    assert.equal((await exchange(env.connect(), "ping\n")).data, "pong:ping\n");
    await chmod(env.proofPath, 0o644);
    const refused = await exchange(env.connect(), "ping\n");
    assert.equal(refused.error?.code, "ERR_LETAGENTS_DAEMON_UNTRUSTED");
  } finally { await env.cleanup(); }
});

test("Windows: a proof whose DACL is widened is refused at once, despite the cache", { skip: process.platform !== "win32" && "a Windows DACL" }, async () => {
  const env = await harness();
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
    }));
    assert.equal((await exchange(env.connect(), "ping\n")).data, "pong:ping\n", "a private proof is accepted (and cached)");
    const before = await stat(env.proofPath);
    // Everyone (S-1-1-0) may read: the proof is no longer a secret.
    execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [env.proofPath, "/grant", "*S-1-1-0:R"], { windowsHide: true });
    const after = await stat(env.proofPath);
    assert.notEqual(after.ctimeMs, before.ctimeMs, "NTFS change time moves with the DACL, so the cache key changes");
    const refused = await exchange(env.connect(), "ping\n");
    assert.equal(refused.connected, false);
    assert.equal(refused.error?.code, "ERR_LETAGENTS_DAEMON_UNTRUSTED");
  } finally { await env.cleanup(); }
});

test("unref() on a daemon connection still applies after the deferred connect", async () => {
  const env = await harness();
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, () => undefined));
    const client = env.connect();
    client.unref();
    await new Promise<void>((resolve, reject) => { client.once("connect", () => resolve()); client.once("error", reject); });
    const handle = (daemonConnectionTransport(client) as unknown as { _handle: { hasRef?: () => boolean } | null } | null)?._handle;
    assert.equal(handle?.hasRef?.(), false, "the pipe handle does not keep the process alive");
    client.destroy();
  } finally { await env.cleanup(); }
});

test("a caller may attach its data listener only after connect", async () => {
  const env = await harness();
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
    }));
    const client = env.connect();
    await new Promise<void>((resolve, reject) => { client.once("connect", () => resolve()); client.once("error", reject); });
    assert.equal(client.readableFlowing, null, "the stream is handed back with no consumer");
    const reply = await new Promise<string>((resolve, reject) => {
      let data = "";
      client.setEncoding("utf8");
      client.on("data", (chunk: string) => { data += chunk; });
      client.once("error", reject);
      client.once("close", () => resolve(data));
      client.write("late\n");
    });
    assert.equal(reply, "pong:late\n");
  } finally { await env.cleanup(); }
});

test("a caller that paused the stream before connect gets it back paused", async () => {
  const env = await harness();
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, () => undefined));
    const client = env.connect();
    client.pause();
    client.on("data", () => undefined);
    await new Promise<void>((resolve, reject) => { client.once("connect", () => resolve()); client.once("error", reject); });
    assert.equal(client.readableFlowing, false);
    client.destroy();
  } finally { await env.cleanup(); }
});

test("a reply the caller has not read yet survives the daemon closing the connection", async () => {
  const env = await harness();
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", () => admitted.end("pong\n"));
    }));
    const client = env.connect();
    await new Promise<void>((resolve, reject) => { client.once("connect", () => resolve()); client.once("error", reject); });
    client.pause();
    const transport = daemonConnectionTransport(client);
    assert.ok(transport);
    const transportClosed = new Promise<void>((resolve) => transport.once("close", () => resolve()));
    client.write("ping\n");
    await transportClosed;
    let data = "";
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => { data += chunk; });
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    client.resume();
    await closed;
    assert.equal(data, "pong\n", "the reply waited for the reader, as on a net.Socket");
  } finally { await env.cleanup(); }
});

test("Windows: a proof read once is used again without reading its DACL", async () => {
  const env = await harness();
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
    }));
    const windows = fakeWindows();
    const connect = () => connectDaemon(env.path, { proofPath: env.proofPath, handshake: true, handshakeTimeoutMs: 1_000, ...windows.options });
    assert.equal((await exchange(connect(), "ping\n")).data, "pong:ping\n");
    assert.equal(windows.counts.objects, 1, "the first read checks the proof through its handle");
    // A reader that never answers: a check would hit the deadline.
    windows.hang = true;
    const startedAt = Date.now();
    assert.equal((await exchange(connect(), "ping\n")).data, "pong:ping\n");
    assert.ok(Date.now() - startedAt < 500, "no DACL read on the request path");
    assert.equal(windows.counts.objects, 1);
  } finally { forgetOwnerPrivateCache(); await env.cleanup(); }
});

test("a remembered proof whose permissions change afterwards is checked again", { skip: process.platform === "win32" && "POSIX mode bits" }, async () => {
  const env = await harness();
  try {
    await env.listen(() => assert.fail("no connection is admitted"));
    // ensureDaemonProof remembered the identity it checked; widen the file after that.
    await chmod(env.proofPath, 0o644);
    const result = await exchange(env.connect(), "ping\n");
    assert.equal(result.error?.code, "ERR_LETAGENTS_DAEMON_UNTRUSTED");
  } finally { await env.cleanup(); }
});

test("a failed client privacy check is asked again, not remembered", { skip: process.platform === "win32" && "an injected POSIX check; the Windows version uses the fake reader" }, async () => {
  const env = await harness();
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
    }));
    // A proof this process did not make: the client must check it.
    const foreignPath = join(env.root, "foreign.proof");
    await writeFile(foreignPath, `${env.proof}\n`, { mode: 0o600 });
    // The first check fails (as a slow PowerShell read can); later checks answer "private".
    let reads = 0;
    const flaky = { checkPrivacy: async () => reads++ > 0 };
    const connect = () => connectDaemon(env.path, { proofPath: foreignPath, handshake: true, ...flaky });
    const first = await exchange(connect(), "ping\n");
    assert.equal(first.error?.code, "ERR_LETAGENTS_DAEMON_UNTRUSTED");
    const second = await exchange(connect(), "ping\n");
    assert.equal(second.data, "pong:ping\n", "the next connection checks again and succeeds");
    assert.equal(reads, 2);
  } finally { await env.cleanup(); }
});

test("a missing proof waits like a missing daemon: retryable, then connects once both appear", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-endpoint-"));
  const path = process.platform === "win32" ? daemonEndpoint(root).connectPath : join(root, "daemon.sock");
  const proofPath = join(root, DAEMON_PROOF_FILE);
  const server = createServer();
  try {
    // Neither the daemon nor its proof exists yet.
    const absent = await exchange(connectDaemon(path, { proofPath, handshake: true }), "ping\n");
    assert.equal(absent.error?.code, "ENOENT");
    assert.equal(isRetryableSupervisorBridgeError(absent.error), true, "the bridge keeps waiting, as for an absent socket");
    // The daemon starts: its proof, then its listener.
    const proof = await ensureDaemonProof(proofPath);
    server.on("connection", (socket) => acceptDaemonPeer(socket, proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
    }));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    assert.equal((await exchange(connectDaemon(path, { proofPath, handshake: true }), "ping\n")).data, "pong:ping\n");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("a client whose proof file is missing fails like an absent daemon", async () => {
  const env = await harness();
  try {
    await env.listen(() => assert.fail("no connection is admitted"));
    const result = await exchange(env.connect({ proofPath: join(env.root, "absent.proof") }), "ping\n");
    assert.equal(result.connected, false);
    assert.equal(result.error?.code, "ENOENT");
  } finally { await env.cleanup(); }
});

test("a silent client is closed when the handshake deadline passes", async () => {
  const env = await harness();
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, () => assert.fail("not admitted"), { timeoutMs: 50 }));
    const socket = createConnection(env.path);
    await new Promise<void>((resolve) => { socket.on("error", () => undefined); socket.once("close", () => resolve()); });
  } finally { await env.cleanup(); }
});

test("a client proof and its request may arrive in one write", async () => {
  const env = await harness();
  try {
    const seen: string[] = [];
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => { seen.push(chunk); admitted.end("done\n"); });
    }));
    const client = env.connect();
    const result = await new Promise<string>((resolve, reject) => {
      let data = "";
      client.setEncoding("utf8");
      client.once("error", reject);
      // The proof line and this request leave in the same tick and usually coalesce.
      client.once("connect", () => client.write("é-request\n"));
      client.on("data", (chunk: string) => { data += chunk; });
      client.once("close", () => resolve(data));
    });
    assert.equal(result, "done\n");
    assert.deepEqual(seen, ["é-request\n"]);
  } finally { await env.cleanup(); }
});

test("a write before connect ends the connection instead of hanging", async () => {
  const env = await harness();
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, () => assert.fail("not admitted")));
    const client = env.connect();
    const error = await new Promise<Error>((resolve) => { client.once("error", resolve); client.write("too-early\n"); });
    assert.match(error.message, /write only after the connect event/);
  } finally { await env.cleanup(); }
});

test("a client gives up on a daemon that never finishes the handshake", async () => {
  const env = await harness();
  try {
    await env.listen((socket) => { socket.on("data", () => undefined); /* accepts, never answers */ });
    const client = connectDaemon(env.path, { proofPath: env.proofPath, handshake: true, handshakeTimeoutMs: 100 });
    const result = await exchange(client, "ping\n");
    assert.equal(result.connected, false);
    assert.equal(result.error?.code, "ETIMEDOUT");
  } finally { await env.cleanup(); }
});

test("bridge retries an absent or unreadable proof but never an untrusted pipe", () => {
  assert.equal(isRetryableSupervisorBridgeError(Object.assign(new Error("no proof"), { code: "ENOENT" })), true);
  assert.equal(isRetryableSupervisorBridgeError(Object.assign(new Error("handshake slow"), { code: "ETIMEDOUT" })), true);
  assert.equal(isRetryableSupervisorBridgeError(Object.assign(new Error("The supervisor daemon pipe did not prove it belongs to this user."),
    { code: "ERR_LETAGENTS_DAEMON_UNTRUSTED" })), false);
});

test("Windows refuses a second listener on a pipe name already held (first-instance semantics)", { skip: process.platform !== "win32" && "named pipes exist only on Windows" }, async () => {
  const env = await harness();
  try {
    await env.listen(() => undefined);
    const second = createServer();
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      second.once("error", resolve);
      second.listen(env.path);
    });
    assert.equal(error.code, "EADDRINUSE");
  } finally { await env.cleanup(); }
});

// Windows proof reads (readOwnerPrivateFile: the owner, the DACL and the bytes
// from one handle). The fake reader below answers as the PowerShell reader's
// "object:" request does, so these run on every host; the real-Windows tests
// after them use the real reader.

const FAKE_USER = "S-1-5-21-1004336348-1177238915-682003330-1001";
const FAKE_PRIVATE_FILE = `O:${FAKE_USER}G:${FAKE_USER}D:P(A;;FA;;;SY)(A;;FA;;;${FAKE_USER})`;
const FAKE_PRIVATE_FOLDER = `O:${FAKE_USER}G:${FAKE_USER}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${FAKE_USER})`;
/** Everyone (WD) may read: no longer a secret. */
const FAKE_EXPOSED_FILE = `O:${FAKE_USER}G:${FAKE_USER}D:P(A;;FA;;;SY)(A;;FA;;;${FAKE_USER})(A;;FR;;;WD)`;

/**
 * A fake Windows permissions reader. Folders read as private; a file's
 * "object:" answer is its bytes now and a private DACL, unless its path is in
 * `exposed`. `failures` fails that many object reads (as a slow PowerShell
 * does; with `failureCode`, as an open that fails with it), `busy` answers
 * that many as a file another process holds without
 * sharing it ("error:busy"), `hang` never answers, and `afterRead` runs once
 * an answer is taken (before it is returned), to change the file under the
 * reader.
 */
function fakeWindows() {
  const counts = { objects: 0, protects: 0 };
  const state = {
    counts,
    exposed: new Set<string>(),
    failures: 0,
    failureCode: undefined as string | undefined,
    busy: 0,
    hang: false,
    afterRead: null as null | ((path: string) => void),
    options: null as unknown as { platform: "win32"; windowsSecurity: WindowsSecurity },
  };
  const objects = (paths: readonly string[]) => {
    counts.objects += 1;
    if (state.hang) return new Promise<never>(() => undefined);
    if (state.failures > 0) {
      state.failures -= 1;
      return Promise.reject(Object.assign(new Error("the permissions reader did not answer"), { code: state.failureCode }));
    }
    if (state.busy > 0) { state.busy -= 1; return Promise.resolve(paths.map(() => ({ sddl: "", data: Buffer.alloc(0), busy: true }))); }
    const answers = paths.map((path) => {
      try { return { sddl: state.exposed.has(resolve(path)) ? FAKE_EXPOSED_FILE : FAKE_PRIVATE_FILE, data: readFileSync(path) }; }
      catch { return null; }
    });
    const after = state.afterRead;
    state.afterRead = null;
    for (const path of paths) after?.(path);
    return Promise.resolve(answers);
  };
  const security: WindowsSecurity = {
    async currentUserSid() { return FAKE_USER; },
    currentUserSidSync() { return FAKE_USER; },
    async readSddl(paths) { return paths.map(() => FAKE_PRIVATE_FOLDER); },
    readSddlSync(paths) { return paths.map(() => FAKE_PRIVATE_FOLDER); },
    readObjects: objects,
    readObjectsSync() { throw new Error("the proof is read asynchronously"); },
    async protect() { counts.protects += 1; },
    protectSync() { counts.protects += 1; },
  };
  state.options = { platform: "win32", windowsSecurity: security };
  return state;
}

/** Replace `path` with a new file holding `data` (another file, as a rename by another process leaves it). */
function swapFile(path: string, data: string): void {
  writeFileSync(`${path}.swap`, data);
  renameSync(`${path}.swap`, path);
}

test("Windows: a failed client proof read is asked again, not remembered", async () => {
  const env = await harness();
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
    }));
    const windows = fakeWindows();
    // The first read fails (as a slow PowerShell read can); later reads answer "private".
    windows.failures = 1;
    const connect = () => connectDaemon(env.path, { proofPath: env.proofPath, handshake: true, ...windows.options });
    const first = await exchange(connect(), "ping\n");
    assert.equal(first.error?.code, "ERR_LETAGENTS_DAEMON_UNTRUSTED");
    assert.equal(isRetryableSupervisorBridgeError(first.error), false);
    const second = await exchange(connect(), "ping\n");
    assert.equal(second.data, "pong:ping\n", "the next connection reads again and succeeds");
    assert.equal(windows.counts.objects, 2);
  } finally { forgetOwnerPrivateCache(); await env.cleanup(); }
});

test("Windows: concurrent connections share one proof read; an open Node reports as denied keeps its code", async () => {
  const env = await harness();
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
    }));
    const windows = fakeWindows();
    const connect = () => connectDaemon(env.path, { proofPath: env.proofPath, handshake: true, ...windows.options });
    // The first read is held until all three connections have asked for the proof.
    const held: Array<() => void> = [];
    const answer = windows.options.windowsSecurity.readObjects!;
    windows.options.windowsSecurity.readObjects = (paths) =>
      new Promise<Awaited<ReturnType<typeof answer>>>((resolveRead) => { held.push(() => resolveRead(answer(paths))); });
    const exchanges = [1, 2, 3].map(() => exchange(connect(), "ping\n"));
    await new Promise((resolvePause) => setTimeout(resolvePause, 100));
    assert.equal(held.length, 1, "one handle read for three connections");
    held[0]();
    const results = await Promise.all(exchanges);
    assert.deepEqual(results.map((result) => result.data), ["pong:ping\n", "pong:ping\n", "pong:ping\n"]);
    windows.options.windowsSecurity.readObjects = answer;
    // Access denied on every try (EACCES; EPERM as libuv reports it). In production Node's own open of a remembered
    // proof reports these (the reader's open answers "error:", a refusal); the fake rejects with them. Retrying cannot
    // help, and it is not "absent".
    for (const code of ["EACCES", "EPERM"]) {
      forgetOwnerPrivateCache();
      windows.failures = 3;
      windows.failureCode = code;
      const denied = await exchange(connect(), "ping\n");
      assert.equal(denied.error?.code, code);
      assert.equal(isRetryableSupervisorBridgeError(denied.error), false);
    }
  } finally { forgetOwnerPrivateCache(); await env.cleanup(); }
});

test("Windows: a background renewal whose reader fails drops the lapsed verdict; the next request checks in full", async () => {
  const env = await harness();
  const realNow = Date.now;
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
    }));
    const windows = fakeWindows();
    const connect = () => connectDaemon(env.path, { proofPath: env.proofPath, handshake: true, ...windows.options });
    assert.equal((await exchange(connect(), "ping\n")).data, "pong:ping\n");
    Date.now = () => realNow() + 6 * 60_000;
    // The renewal's read fails (the reader stopped): a refusal, which is not tried again.
    windows.failures = 1;
    assert.equal((await exchange(connect(), "ping\n")).data, "pong:ping\n", "the lapsed verdict serves this request");
    await new Promise((resolvePause) => setTimeout(resolvePause, 150));
    assert.equal(windows.failures, 0, "the renewal ran");
    const objects = windows.counts.objects;
    assert.equal((await exchange(connect(), "ping\n")).data, "pong:ping\n");
    assert.equal(windows.counts.objects, objects + 1, "the dropped verdict made this request check in full");
  } finally { Date.now = realNow; forgetOwnerPrivateCache(); await env.cleanup(); }
});

test("Windows: one failed proof read does not rotate a valid proof; two do", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-endpoint-"));
  try {
    const proofPath = join(root, DAEMON_PROOF_FILE);
    const windows = fakeWindows();
    const options = { ...windows.options, recheckDelayMs: 1 };
    const first = await ensureDaemonProof(proofPath, options);
    assert.equal(windows.counts.protects, 0, "the new proof is private from its create (privateEntryCreated): no icacls");
    forgetOwnerPrivateCache();
    windows.failures = 1;
    assert.equal(await ensureDaemonProof(proofPath, options), first, "a single failed read keeps the proof");
    forgetOwnerPrivateCache();
    windows.failures = 2;
    const rotated = await ensureDaemonProof(proofPath, options);
    assert.notEqual(rotated, first, "two failed reads replace it");
    assert.equal((await readFile(proofPath, "utf8")).trim(), rotated);
    // The daemon reads its own fresh proof back with no check.
    const objects = windows.counts.objects;
    assert.equal(await ensureDaemonProof(proofPath, options), rotated);
    assert.ok(windows.counts.objects - objects <= 1, "at most one handle read (none when the rename kept the change time)");
  } finally { forgetOwnerPrivateCache(); await rm(root, { recursive: true, force: true }); }
});

test("Windows: an exposed or malformed proof is replaced by the daemon, never reused", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-endpoint-"));
  try {
    const proofPath = join(root, DAEMON_PROOF_FILE);
    const windows = fakeWindows();
    const options = { ...windows.options, recheckDelayMs: 1 };
    const leaked = "a".repeat(64);
    await writeFile(proofPath, `${leaked}\n`);
    windows.exposed.add(resolve(proofPath));
    const replaced = await ensureDaemonProof(proofPath, options);
    assert.notEqual(replaced, leaked);
    windows.exposed.clear();
    await writeFile(proofPath, "not-a-proof\n");
    forgetOwnerPrivateCache();
    assert.notEqual(await ensureDaemonProof(proofPath, options), replaced);
  } finally { forgetOwnerPrivateCache(); await rm(root, { recursive: true, force: true }); }
});

test("Windows: a proof swapped in during the client's read is read again, and refused when exposed", async () => {
  const env = await harness();
  try {
    let connections = 0;
    await env.listen((socket) => {
      connections += 1;
      acceptDaemonPeer(socket, env.proof, (admitted) => {
        admitted.setEncoding("utf8");
        admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
      });
    });
    const windows = fakeWindows();
    const connect = () => connectDaemon(env.path, { proofPath: env.proofPath, handshake: true, ...windows.options });
    const real = await readFile(env.proofPath, "utf8");

    // The answer describes the private proof, but another file holding a proof the attacker knows is renamed in
    // before the read settles, and that file is exposed. The bytes from the first answer are not used for it,
    // and the file now at the path is refused.
    windows.afterRead = (path) => { swapFile(path, `${"b".repeat(64)}\n`); windows.exposed.add(resolve(path)); };
    const refused = await exchange(connect(), "ping\n");
    assert.equal(refused.connected, false);
    assert.equal(refused.error?.code, "ERR_LETAGENTS_DAEMON_UNTRUSTED");
    assert.match(refused.error?.message ?? "", /not private to this account/);
    assert.equal(windows.counts.objects, 2, "the swapped-in file was checked through its own handle");
    assert.equal(connections, 0, "the daemon sees nothing from a client holding an exposed proof");

    // A private file swapped in during the read: checked again, and its own bytes are used.
    windows.exposed.clear();
    swapFile(env.proofPath, real);
    windows.afterRead = (path) => swapFile(path, real);
    const objects = windows.counts.objects;
    assert.equal((await exchange(connect(), "ping\n")).data, "pong:ping\n");
    assert.equal(windows.counts.objects - objects, 2, "read again after the swap");
  } finally { forgetOwnerPrivateCache(); await env.cleanup(); }
});

test("Windows: a remembered proof replaced by another file is checked before it is used", async () => {
  const env = await harness();
  try {
    let connections = 0;
    await env.listen((socket) => {
      connections += 1;
      acceptDaemonPeer(socket, env.proof, (admitted) => admitted.end("pong\n"));
    });
    const windows = fakeWindows();
    const connect = () => connectDaemon(env.path, { proofPath: env.proofPath, handshake: true, ...windows.options });
    // The first read remembers the private proof (its identity and the hash of its bytes).
    assert.equal((await exchange(connect(), "ping\n")).data, "pong\n");
    // Another file is renamed over it: it is not what was checked, so its own DACL decides.
    swapFile(env.proofPath, `${env.proof}\n`);
    windows.exposed.add(resolve(env.proofPath));
    const refused = await exchange(connect(), "ping\n");
    assert.equal(refused.error?.code, "ERR_LETAGENTS_DAEMON_UNTRUSTED");
    assert.equal(windows.counts.objects, 2);
    assert.equal(connections, 1, "the daemon sees nothing from a client holding an exposed proof");
  } finally { forgetOwnerPrivateCache(); await env.cleanup(); }
});

test("Windows: a lapsed proof verdict is used while it is renewed in the background; an exposed answer drops it", async () => {
  const env = await harness();
  const realNow = Date.now;
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
    }));
    const windows = fakeWindows();
    const connect = () => connectDaemon(env.path, { proofPath: env.proofPath, handshake: true, handshakeTimeoutMs: 2_000, ...windows.options });
    assert.equal((await exchange(connect(), "ping\n")).data, "pong:ping\n");
    assert.equal(windows.counts.objects, 1);

    // Six minutes later the verdict has lapsed. The reader is slow: the request does not wait for it.
    Date.now = () => realNow() + 6 * 60_000;
    const held: Array<() => void> = [];
    const answer = windows.options.windowsSecurity.readObjects!;
    windows.options.windowsSecurity.readObjects = (paths) =>
      new Promise<Awaited<ReturnType<typeof answer>>>((resolveRead) => { held.push(() => resolveRead(answer(paths))); });
    const startedAt = realNow();
    assert.equal((await exchange(connect(), "ping\n")).data, "pong:ping\n");
    assert.ok(realNow() - startedAt < 1_000, "the lapsed verdict was used, not waited for");
    // The renewal runs in the background (an lstat first): wait until it reaches the reader.
    for (const waitStart = realNow(); held.length < 1 && realNow() - waitStart < 2_000;) await new Promise((resolvePause) => setTimeout(resolvePause, 5));
    assert.equal(held.length, 1, "a background check started");
    // A second request meanwhile starts no second check.
    assert.equal((await exchange(connect(), "ping\n")).data, "pong:ping\n");
    assert.equal(held.length, 1, "one background check at a time");

    // The background check finds the proof exposed: the verdict is dropped, and the next request is refused.
    windows.exposed.add(resolve(env.proofPath));
    held[0]();
    await new Promise((resolvePause) => setTimeout(resolvePause, 50));
    windows.options.windowsSecurity.readObjects = answer;
    assert.equal(windows.counts.objects, 2);
    const refused = await exchange(connect(), "ping\n");
    assert.equal(refused.error?.code, "ERR_LETAGENTS_DAEMON_UNTRUSTED");
  } finally { Date.now = realNow; forgetOwnerPrivateCache(); await env.cleanup(); }
});

test("Windows: a missing proof still reads as an absent daemon, and a locked one is retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-endpoint-"));
  try {
    const windows = fakeWindows();
    const path = process.platform === "win32" ? daemonEndpoint(root).connectPath : join(root, "daemon.sock");
    const proofPath = join(root, DAEMON_PROOF_FILE);
    const connect = () => connectDaemon(path, { proofPath, handshake: true, ...windows.options });
    const absent = await exchange(connect(), "ping\n");
    assert.equal(absent.error?.code, "ENOENT");
    assert.equal(isRetryableSupervisorBridgeError(absent.error), true, "the bridge keeps waiting, as for an absent socket");
    assert.equal(windows.counts.objects, 0);
    // A proof another process holds without sharing it (an antivirus scan) past the reader's own retries.
    await writeFile(proofPath, `${"d".repeat(64)}\n`);
    windows.busy = 3;
    const locked = await exchange(connect(), "ping\n");
    assert.equal(locked.error?.code, "ENOENT");
    assert.equal(isRetryableSupervisorBridgeError(locked.error), true, "a locked proof is waited for too");
    assert.equal(windows.counts.objects, 3);
    // The daemon replaces a proof that stays locked through both reads when the rename can (this fake holds no
    // real lock); the real-Windows lock test below covers a rename the lock stops.
    windows.busy = 6;
    assert.notEqual(await ensureDaemonProof(proofPath, { ...windows.options, recheckDelayMs: 1 }), "d".repeat(64));
  } finally { forgetOwnerPrivateCache(); await rm(root, { recursive: true, force: true }); }
});

/** The real Windows reader, counting each tool use (user lookups aside) by method. */
function countingSecurity() {
  const real = createWindowsSecurity();
  const counts: Record<string, number> = {};
  const security = new Proxy(real, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (!/^currentUser/.test(String(name))) counts[String(name)] = (counts[String(name)] ?? 0) + 1;
        return value.apply(target, args);
      };
    },
  }) as WindowsSecurity;
  return { security, counts };
}

function icacls(...args: string[]): void {
  execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), args, { windowsHide: true });
}

test("real Windows: a fresh proof in the daemon's private state folder costs no icacls, and clients accept it", { skip: process.platform !== "win32" && "a Windows DACL" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-endpoint-"));
  const server = createServer();
  try {
    forgetOwnerPrivateCache();
    const { security, counts } = countingSecurity();
    const options = { windowsSecurity: security };
    // As the daemon's singleton does before the proof: its state folder is made private (and so verified).
    const stateDir = join(root, "state");
    await createPrivateDir(stateDir, {}, options);
    const endpoint = daemonEndpoint(stateDir);
    const before = { ...counts };
    const proof = await ensureDaemonProof(endpoint.proofPath!, options);
    assert.equal(counts.protect ?? 0, before.protect ?? 0, `the new proof ran icacls: ${JSON.stringify(counts)}`);
    await assertOwnerPrivate(endpoint.proofPath!, { kind: "file" });

    server.on("connection", (socket) => acceptDaemonPeer(socket, proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
    }));
    await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(endpoint.listenPath, resolveListen); });
    const afterWrite = { ...counts };
    // The first handle read may start this reader's PowerShell: a generous deadline.
    const connect = (security: WindowsSecurity) => connectDaemon(endpoint.connectPath, { proofPath: endpoint.proofPath, handshakeTimeoutMs: 60_000, windowsSecurity: security });
    assert.equal((await exchange(connect(security), "ping\n")).data, "pong:ping\n");
    assert.equal(await ensureDaemonProof(endpoint.proofPath!, options), proof, "a handoff keeps the fresh proof");
    assert.equal(counts.protect ?? 0, afterWrite.protect ?? 0, "no icacls to read the proof back");
    assert.ok((counts.readObjects ?? 0) - (afterWrite.readObjects ?? 0) <= 1,
      `at most one handle read, none when the rename kept the change time: ${JSON.stringify(counts)}`);

    // Another process (a cold reader) checks it once through its handle and accepts it.
    const other = countingSecurity();
    assert.equal((await exchange(connect(other.security), "ping\n")).data, "pong:ping\n");
    assert.equal(other.counts.readObjects, 1);
    assert.equal(other.counts.protect ?? 0, 0);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    forgetOwnerPrivateCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("real Windows: an exposed file renamed over the proof is refused, despite the cache", { skip: process.platform !== "win32" && "a Windows DACL" }, async () => {
  const env = await harness();
  try {
    let connections = 0;
    await env.listen((socket) => {
      connections += 1;
      acceptDaemonPeer(socket, env.proof, (admitted) => {
        admitted.setEncoding("utf8");
        admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
      });
    });
    assert.equal((await exchange(env.connect(), "ping\n")).data, "pong:ping\n", "a private proof is accepted (and remembered)");
    // A file with the same bytes, readable by Everyone, takes the proof's place.
    const swap = join(env.root, "swap.proof");
    writeFileSync(swap, `${env.proof}\n`);
    icacls(swap, "/grant", "*S-1-1-0:R");
    renameSync(swap, env.proofPath);
    const before = connections;
    const refused = await exchange(env.connect(), "ping\n");
    assert.equal(refused.connected, false);
    assert.equal(refused.error?.code, "ERR_LETAGENTS_DAEMON_UNTRUSTED");
    assert.equal(connections, before, "the daemon sees nothing from a client holding an exposed proof");
    // The daemon replaces it.
    assert.notEqual(await ensureDaemonProof(env.proofPath, { recheckDelayMs: 1 }), env.proof);
  } finally { await env.cleanup(); }
});

/**
 * Another process (a PowerShell) holds `path` open until the returned release
 * runs: `exclusive` opens it with FileShare.None (as a scanner that locks the
 * file does); `range` opens it sharing everything and locks all of it
 * (FileStream.Lock, LockFileEx).
 */
async function holdInAnotherProcess(path: string, mode: "exclusive" | "range"): Promise<() => Promise<void>> {
  const { spawn } = await import("node:child_process");
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const open = mode === "exclusive"
    ? "$fs = [System.IO.File]::Open($env:LETAGENTS_TEST_PROOF, 'Open', 'Read', 'None'); "
    : "$fs = [System.IO.File]::Open($env:LETAGENTS_TEST_PROOF, 'Open', 'Read', 'ReadWrite, Delete'); $fs.Lock(0, $fs.Length); ";
  const script = `${open}[Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); $null = [Console]::In.ReadLine(); $fs.Dispose()`;
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, LETAGENTS_TEST_PROOF: path }, stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
  });
  // Set up at the start: a holder that exits early must not leave the release waiting for an exit already past.
  const exited = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
  // Ending the input of a holder that already exited is EPIPE, not a test failure.
  child.stdin.on("error", () => undefined);
  await new Promise<void>((resolveLocked, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; if (output.includes("locked")) resolveLocked(); });
    void exited.then((code) => reject(new Error(`the lock holder exited (${code}) before it locked`)));
  });
  return async () => {
    child.stdin.end("\n");
    await exited;
  };
}

test("real Windows: a proof another process holds without sharing it is waited for, then accepted", { skip: process.platform !== "win32" && "a Windows share mode" }, async () => {
  const env = await harness();
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
    }));
    forgetOwnerPrivateCache();
    const release = await holdInAnotherProcess(env.proofPath, "exclusive");
    // No Node open checks the lock first: on Windows CI (Server, the built-in Administrator) a Node open of the
    // held file succeeded, though it fails with EBUSY on Windows 11. The client's answer below shows it held: an
    // unlocked proof would connect.
    let locked;
    let rotation: string | Error;
    try {
      locked = await exchange(env.connect(), "ping\n");
      // The daemon tries to replace a proof that stays locked: the rename either fails (the error is thrown and the
      // proof is left as it was) or succeeds (the file is then the whole new proof).
      rotation = await ensureDaemonProof(env.proofPath, { recheckDelayMs: 1 }).catch((error: Error) => error);
    } finally { await release(); }
    assert.equal(locked.connected, false);
    assert.equal(locked.error?.code, "ENOENT", `a lock is not a refusal: ${locked.error?.message}`);
    assert.equal(isRetryableSupervisorBridgeError(locked.error), true);
    const onDisk = (await readFile(env.proofPath, "utf8")).trim();
    assert.equal(onDisk, rotation instanceof Error ? env.proof : rotation, `the proof file matches the daemon's outcome: ${String(rotation)}`);
    if (!(rotation instanceof Error)) return;
    assert.equal((await exchange(env.connect(), "ping\n")).data, "pong:ping\n", "accepted once the lock is gone");
  } finally { forgetOwnerPrivateCache(); await env.cleanup(); }
});

test("real Windows: a proof with a locked byte range is waited for, cold and remembered, then accepted", { skip: process.platform !== "win32" && "a Windows byte-range lock" }, async () => {
  const env = await harness();
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
    }));
    // Cold: the reader opens the proof, and its read hits the locked range (ERROR_LOCK_VIOLATION).
    forgetOwnerPrivateCache();
    let release = await holdInAnotherProcess(env.proofPath, "range");
    const cold = await exchange(env.connect(), "ping\n");
    await release();
    assert.equal(cold.error?.code, "ENOENT", `a locked range is not a refusal: ${cold.error?.message}`);
    assert.equal(isRetryableSupervisorBridgeError(cold.error), true);
    // Remembered: Node's own read of the remembered proof hits the lock.
    assert.equal((await exchange(env.connect(), "ping\n")).data, "pong:ping\n");
    release = await holdInAnotherProcess(env.proofPath, "range");
    const warm = await exchange(env.connect(), "ping\n");
    await release();
    assert.equal(warm.error?.code, "ENOENT", `a locked range is not a refusal: ${warm.error?.code} ${warm.error?.message}`);
    assert.equal((await exchange(env.connect(), "ping\n")).data, "pong:ping\n", "accepted once the lock is gone");
  } finally { forgetOwnerPrivateCache(); await env.cleanup(); }
});
