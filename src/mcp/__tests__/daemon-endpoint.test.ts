import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { Socket, createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
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
import { assertOwnerPrivate } from "../../../shared/owner-private-fs.mjs";

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

test("one failed privacy check does not rotate a valid proof; two do", async () => {
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

test("a proof this process made private is used without reading its DACL again", async () => {
  const env = await harness();
  try {
    await env.listen((socket) => acceptDaemonPeer(socket, env.proof, (admitted) => {
      admitted.setEncoding("utf8");
      admitted.on("data", (chunk: string) => admitted.end(`pong:${chunk}`));
    }));
    // A Windows privacy backend that never answers: a check would hit the deadline.
    const neverAnswers = {
      platform: "win32" as const,
      windowsSecurity: {
        currentUserSid: () => new Promise<string>(() => undefined),
        currentUserSidSync: () => { throw new Error("not used"); },
        readSddl: () => new Promise<(string | null)[]>(() => undefined),
        readSddlSync: () => { throw new Error("not used"); },
        protect: async () => undefined,
        protectSync: () => undefined,
      },
    };
    const startedAt = Date.now();
    const client = connectDaemon(env.path, { proofPath: env.proofPath, handshake: true, handshakeTimeoutMs: 1_000, ...neverAnswers });
    const result = await exchange(client, "ping\n");
    assert.equal(result.data, "pong:ping\n", "ensureDaemonProof recorded the proof as private in this process");
    assert.ok(Date.now() - startedAt < 500, "no DACL read on the request path");
  } finally { await env.cleanup(); }
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

test("a failed client privacy check is asked again, not remembered", async () => {
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
