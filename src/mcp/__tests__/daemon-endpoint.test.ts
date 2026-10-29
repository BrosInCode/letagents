import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";

import {
  DAEMON_PROOF_FILE,
  DAEMON_STATE_DIR_ENV,
  acceptDaemonPeer,
  connectDaemon,
  currentWindowsAccount,
  currentWindowsUserSid,
  daemonEndpoint,
  ensureDaemonProof,
  isWindowsPipePath,
  protectWindowsPrivateFile,
  resolveDaemonProofPath,
  windowsPipeName,
} from "../../../shared/daemon-endpoint.mjs";
import { isRetryableSupervisorBridgeError } from "../server/runtime/supervisor-bridge.js";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
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

test("the Windows user SID comes from System32 whoami and a failure throws", () => {
  const calls: Array<{ file: string; args: string[]; windowsHide: boolean }> = [];
  const sid = currentWindowsUserSid({
    env: { SystemRoot: "C:\\Windows" },
    run: (file, args, options) => { calls.push({ file, args, windowsHide: options.windowsHide }); return `"host\\owner","${SID.toLowerCase()}"\r\n`; },
  });
  assert.equal(sid, SID);
  assert.deepEqual(calls, [{ file: "C:\\Windows\\System32\\whoami.exe", args: ["/user", "/fo", "csv", "/nh"], windowsHide: true }]);
  assert.throws(() => currentWindowsUserSid({ env: {}, run: () => { throw new Error("no whoami"); } }), /no whoami/);
  assert.throws(() => currentWindowsUserSid({ env: {}, run: () => "garbage" }), /SID could not be read/);
});

test("the Windows proof gets an owner-only DACL through System32 icacls, failing closed", () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  protectWindowsPrivateFile("C:\\state\\daemon-endpoint.proof", {
    env: { SystemRoot: "C:\\Windows" }, userSid: SID,
    run: (file, args) => { calls.push({ file, args }); return ""; },
  });
  assert.deepEqual(calls, [
    { file: "C:\\Windows\\System32\\icacls.exe", args: ["C:\\state\\daemon-endpoint.proof", "/setowner", `*${SID}`, "/q"] },
    { file: "C:\\Windows\\System32\\icacls.exe", args: ["C:\\state\\daemon-endpoint.proof", "/inheritance:r", "/grant:r", `*${SID}:F`, "*S-1-5-18:F", "/q"] },
  ]);
  assert.throws(() => protectWindowsPrivateFile("C:\\p", { userSid: "user:owner", run: () => "" }), /SID is unknown/);
  assert.throws(() => protectWindowsPrivateFile("C:\\p", { userSid: SID, run: () => { throw new Error("icacls exited 5"); } }), /icacls exited 5/);
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
    const protectedPaths: string[] = [];
    const first = await ensureDaemonProof(proofPath, { protect: (path) => { protectedPaths.push(path); } });
    assert.equal(protectedPaths.length, 1);
    assert.match(protectedPaths[0]!, /daemon-endpoint\.proof\.\d+\.[0-9a-f]+\.tmp$/, "the DACL is set on the empty temporary file before the secret is written");
    assert.match(first, /^[a-f0-9]{64}$/);
    if (process.platform !== "win32") assert.equal((await stat(proofPath)).mode & 0o777, 0o600);
    assert.equal(await ensureDaemonProof(proofPath, { protect: (path) => { protectedPaths.push(path); } }), first, "a handoff keeps the proof clients already read");
    assert.equal(protectedPaths.at(-1), proofPath, "an existing proof is protected again on every start");
    await assert.rejects(ensureDaemonProof(join(root, "refused.proof"), { protect: () => { throw new Error("no DACL"); } }), /no DACL/);
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("refused")), [], "a proof that could not be protected leaves nothing behind");
    await writeFile(proofPath, "not-a-proof\n");
    const replaced = await ensureDaemonProof(proofPath);
    assert.match(replaced, /^[a-f0-9]{64}$/);
    assert.notEqual(replaced, first);
    assert.equal((await readFile(proofPath, "utf8")).trim(), replaced);
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
    await writeFile(wrongProofPath, `${"0".repeat(64)}\n`);
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
