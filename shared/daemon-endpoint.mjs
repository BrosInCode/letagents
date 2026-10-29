import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { Socket, createConnection } from "node:net";
import { userInfo } from "node:os";
import { posix, win32 } from "node:path";

import { letagentsHome } from "./letagents-home.mjs";

// Where the desktop, the supervisor daemon and MCP workers meet.
//
// POSIX: a Unix socket file `<stateDir>/daemon.sock` (mode 0600 in a 0700
// directory), exactly as before this module existed.
//
// Windows: a named pipe `\\.\pipe\letagents-daemon-<hash>`. The hash binds the
// state directory and the account name, so two users (or two state roots)
// never share a name. Every process computes it without a subprocess, so the
// desktop, the daemon and workers always agree. Node cannot give a pipe a security descriptor, so two checks
// stand in for one:
//   1. libuv creates the first pipe instance with FILE_FLAG_FIRST_PIPE_INSTANCE.
//      A name another process already holds fails `listen` with EADDRINUSE, and
//      the daemon fails closed instead of serving beside it.
//   2. Both ends prove they can read `<stateDir>/daemon-endpoint.proof`, a
//      random secret in the private state directory, before any request
//      flows (see the handshake below). The secret itself never crosses the
//      pipe, so a pipe squatted by another user learns nothing, and the client
//      sends it no request. The daemon closes every connection that fails.
//      The check is pluggable (DaemonControlSocket's `peerProofPath`), so a
//      native peer-SID check can replace it later.

export const DAEMON_SOCKET_FILE = "daemon.sock";
export const DAEMON_PROOF_FILE = "daemon-endpoint.proof";
/** Optional state directory for a worker whose own home differs from the daemon's. */
export const DAEMON_STATE_DIR_ENV = "LETAGENTS_SUPERVISOR_DAEMON_STATE_DIR";
const PROOF_PATTERN = /^[a-f0-9]{64}$/;
const MAX_HANDSHAKE_LINE_BYTES = 512;
const PIPE_PATTERN = /^\\\\[.?]\\pipe\\/i;

/** Proof paths of endpoints this process computed, by connect path. */
const knownProofPaths = new Map();
let cachedUserSid = null;

export function isWindowsPipePath(path) {
  return typeof path === "string" && PIPE_PATTERN.test(path);
}

/**
 * The current user's SID on Windows, from whoami in System32 (not PATH).
 * Only the owner-only DACL needs it; a failure throws, so that fails closed.
 */
export function currentWindowsUserSid({ env = process.env, run } = {}) {
  if (cachedUserSid && !run) return cachedUserSid;
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  const output = String((run ?? execFileSync)(win32.join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  }));
  const sid = /"(S-1-[0-9]+(?:-[0-9]+)+)"\s*$/i.exec(output.trim())?.[1]?.toUpperCase();
  if (!sid) throw new Error("The current Windows account's SID could not be read.");
  if (!run) cachedUserSid = sid;
  return sid;
}

/** The account name the pipe name binds: GetUserNameW through os.userInfo(), no subprocess, no environment. */
export function currentWindowsAccount() {
  return userInfo().username.toLowerCase();
}

/** A pipe name for `key`, unique to this user. Windows paths compare without case. */
export function windowsPipeName(prefix, key, account) {
  const digest = createHash("sha256").update(`${key}\0${account}`, "utf8").digest("hex").slice(0, 32);
  return `\\\\.\\pipe\\${prefix}-${digest}`;
}

/**
 * The daemon endpoint for `stateDir`. `listenPath` is what the daemon listens
 * on, `connectPath` what clients and the worker environment use, and
 * `proofPath` the client proof (Windows only). No caller derives a directory
 * from either path: `stateDir` is returned for that.
 */
export function daemonEndpoint(stateDir, { platform = process.platform, account } = {}) {
  if (typeof stateDir !== "string" || !stateDir) throw new Error("The daemon state directory is required.");
  if (platform !== "win32") {
    // A Unix socket path is POSIX; this equals join() on every POSIX host.
    const socketPath = posix.join(stateDir, DAEMON_SOCKET_FILE);
    return { stateDir, transport: "unix", listenPath: socketPath, connectPath: socketPath, proofPath: null };
  }
  const normalized = win32.resolve(stateDir).toLowerCase();
  const pipe = windowsPipeName("letagents-daemon", normalized, account ?? currentWindowsAccount());
  const proofPath = win32.join(stateDir, DAEMON_PROOF_FILE);
  knownProofPaths.set(pipe, proofPath);
  return { stateDir, transport: "pipe", listenPath: pipe, connectPath: pipe, proofPath };
}

/**
 * The proof file for a pipe this user's daemon serves. A worker knows only the
 * pipe name, so the state directories it may belong to are tried in turn.
 */
export function resolveDaemonProofPath(connectPath, { env = process.env, home } = {}) {
  const known = knownProofPaths.get(connectPath);
  if (known) return known;
  const candidates = [env[DAEMON_STATE_DIR_ENV]?.trim(), letagentsHome(home ? { homedir: () => home } : {})].filter(Boolean);
  for (const stateDir of candidates) {
    const endpoint = daemonEndpoint(stateDir, { platform: "win32" });
    if (endpoint.connectPath === connectPath) return endpoint.proofPath;
  }
  return null;
}

function parseProof(raw) {
  const value = raw.trim();
  return PROOF_PATTERN.test(value) ? value : null;
}

/**
 * Give a Windows file an owner-only DACL: the current user owns it, and only
 * that user and SYSTEM have access, with inheritance removed. Mirrors the
 * shared owner-private helper (PR #1794), which replaces this once it lands.
 * A missing SID or a failed icacls throws: the caller fails closed.
 */
export function protectWindowsPrivateFile(path, { env = process.env, run, userSid } = {}) {
  const sid = userSid ?? currentWindowsUserSid({ env, ...(run ? { run } : {}) });
  if (!/^S-1-[0-9]+(?:-[0-9]+)+$/i.test(sid)) throw new Error("The current Windows account's SID is unknown; refusing to protect the daemon proof.");
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  const icacls = win32.join(systemRoot, "System32", "icacls.exe");
  const options = { encoding: "utf8", windowsHide: true, timeout: 10_000 };
  (run ?? execFileSync)(icacls, [path, "/setowner", `*${sid}`, "/q"], options);
  (run ?? execFileSync)(icacls, [path, "/inheritance:r", "/grant:r", `*${sid}:F`, "*S-1-5-18:F", "/q"], options);
}

/**
 * Read the proof, or create it once. A valid proof survives restarts and
 * handoffs, so a client never races a rotation. `protect` makes a file
 * owner-private; it runs on Windows (where mode 0600 means nothing) before the
 * secret is written, and again on every start for a proof that exists.
 */
export async function ensureDaemonProof(proofPath, { protect = process.platform === "win32" ? protectWindowsPrivateFile : null } = {}) {
  try {
    const existing = parseProof(await readFile(proofPath, "utf8"));
    if (existing) {
      protect?.(proofPath);
      return existing;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const proof = randomBytes(32).toString("hex");
  const temporary = `${proofPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    // The DACL is in place before the secret exists; a rename keeps it.
    protect?.(temporary);
    await handle.writeFile(`${proof}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try { await rename(temporary, proofPath); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  return proof;
}

// Handshake on a Windows pipe, one JSON line each, before any request:
//   client -> {"letagents_daemon_hello": <client nonce>}
//   daemon -> {"letagents_daemon_server": HMAC(proof, "server:" + client nonce),
//              "letagents_daemon_challenge": <daemon nonce>}
//   client -> {"letagents_daemon_client": HMAC(proof, "client:" + daemon nonce)}
// Nonces are 32 random bytes in hex. Each side checks the other's HMAC in
// constant time; a wrong, malformed, oversized or late line ends the connection.

function answer(proof, role, nonce) {
  return createHmac("sha256", proof).update(`${role}:${nonce}`, "utf8").digest("hex");
}

function nonce() {
  return randomBytes(32).toString("hex");
}

function sameHex(candidate, expected) {
  if (typeof candidate !== "string" || !PROOF_PATTERN.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(expected, "utf8"));
}

/** Parse one handshake line holding exactly `keys`, or null. */
function handshakeFrame(line, keys) {
  if (line.length > MAX_HANDSHAKE_LINE_BYTES) return null;
  let frame;
  try { frame = JSON.parse(line.toString("utf8")); } catch { return null; }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
  const present = Object.keys(frame).sort();
  if (present.join(",") !== [...keys].sort().join(",")) return null;
  return keys.every((key) => typeof frame[key] === "string" && PROOF_PATTERN.test(frame[key])) ? frame : null;
}

/** Collect newline-terminated lines from a stream that may already be decoding strings. */
function lineReader(onLine, onOverflow) {
  let received = Buffer.alloc(0);
  return (chunk) => {
    received = Buffer.concat([received, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
    for (;;) {
      const newline = received.indexOf(0x0a);
      if (newline < 0) {
        if (received.length > MAX_HANDSHAKE_LINE_BYTES) onOverflow();
        return;
      }
      const line = received.subarray(0, newline);
      received = received.subarray(newline + 1);
      if (onLine(line, received) === false) return;
    }
  };
}

function untrusted(message) {
  return Object.assign(new Error(message), { code: "ERR_LETAGENTS_DAEMON_UNTRUSTED" });
}

/**
 * Connect to the daemon. On POSIX this is exactly `createConnection(path)`.
 * On a Windows pipe the handshake runs first: the caller's "connect" (and
 * "ready") fire only after both sides proved themselves, and the daemon's
 * handshake line never reaches the caller's "data" listeners. A missing proof
 * file reads as ENOENT (no daemon has run here); a daemon that fails its proof
 * is ERR_LETAGENTS_DAEMON_UNTRUSTED. `handshake: true` runs it over a Unix
 * socket too, for tests on hosts without pipes.
 */
export function connectDaemon(connectPath, { proofPath, handshake = false, handshakeTimeoutMs = 10_000 } = {}) {
  if (!handshake && !isWindowsPipePath(connectPath)) return createConnection(connectPath);
  let proof;
  try {
    const path = proofPath ?? resolveDaemonProofPath(connectPath);
    if (!path) throw untrusted("no LetAgents state directory of this user owns this pipe");
    proof = parseProof(readFileSync(path, "utf8"));
    if (!proof) throw untrusted("the proof file is malformed");
  } catch (error) {
    // A missing or briefly locked proof (no daemon yet; an antivirus scan is a
    // sharing violation, EBUSY) reads as an absent daemon, which callers retry.
    // Denied access (EACCES, or EPERM as libuv reports it on Windows) and an
    // untrusted pipe keep their own codes: retrying cannot help.
    const code = error?.code === "ENOENT" || error?.code === "EBUSY" ? "ENOENT" : error?.code ?? "ENOENT";
    const failure = Object.assign(new Error(`Cannot prove this client to the supervisor daemon: ${error.message}`), { code, cause: error });
    // Never connected: the daemon sees nothing from a client without a proof.
    const unconnected = new Socket();
    process.nextTick(() => unconnected.destroy(failure));
    return unconnected;
  }
  const socket = createConnection(connectPath);
  const emit = socket.emit;
  const write = socket.write;
  const held = [];
  let open = false;
  // An absolute bound on connect + handshake. A caller's own timeout may be
  // unlimited (handoff, configuration apply) or reset by trickled bytes; this
  // one is not. It ends once the daemon proved itself or the socket closed.
  const deadline = setTimeout(() => socket.destroy(Object.assign(
    new Error("The supervisor daemon did not complete its handshake in time."), { code: "ETIMEDOUT" })), handshakeTimeoutMs);
  deadline.unref?.();
  socket.once("close", () => clearTimeout(deadline));
  const clientNonce = nonce();
  const read = lineReader((line, rest) => {
    const frame = handshakeFrame(line, ["letagents_daemon_server", "letagents_daemon_challenge"]);
    if (!frame || rest.length || !sameHex(frame.letagents_daemon_server, answer(proof, "server", clientNonce))) {
      socket.destroy(untrusted("The supervisor daemon pipe did not prove it belongs to this user."));
      return false;
    }
    write.call(socket, `${JSON.stringify({ letagents_daemon_client: answer(proof, "client", frame.letagents_daemon_challenge) })}\n`);
    open = true;
    clearTimeout(deadline);
    for (const [event, args] of held) emit.call(socket, event, ...args);
    return false;
  }, () => socket.destroy(untrusted("The supervisor daemon handshake is too large.")));
  // Node queues a write made before "connect" behind that event, which the
  // handshake holds, so such a write would wait forever. Callers write from
  // their "connect" listener; anything earlier ends the connection loudly.
  socket.write = function writeAfterHandshake(...args) {
    if (open) return write.apply(this, args);
    socket.destroy(new Error("connectDaemon: write only after the connect event."));
    return false;
  };
  socket.emit = function emitAfterHandshake(event, ...args) {
    if (open) return emit.call(this, event, ...args);
    if (event === "connect") {
      write.call(socket, `${JSON.stringify({ letagents_daemon_hello: clientNonce })}\n`);
      held.push([event, args]);
      // net.Socket defers its first read to a "connect" listener, which runs
      // only when the held event is replayed. Start reading now; the deferred
      // call is a no-op once the handle reads.
      socket._read(socket.readableHighWaterMark);
      return true;
    }
    if (event === "ready") { held.push([event, args]); return true; }
    if (event === "data") { read(args[0]); return true; }
    return emit.call(this, event, ...args);
  };
  return socket;
}

/**
 * Run the daemon's side of the handshake, then hand the connection to
 * `onAccepted` with any bytes after the client's proof returned to the stream.
 */
export function acceptDaemonPeer(socket, proof, onAccepted, { timeoutMs = 10_000 } = {}) {
  const daemonNonce = nonce();
  let expectClient = false;
  const reject = () => { cleanup(); socket.destroy(); };
  const timer = setTimeout(reject, timeoutMs);
  timer.unref?.();
  const read = lineReader((line, rest) => {
    if (!expectClient) {
      const hello = handshakeFrame(line, ["letagents_daemon_hello"]);
      if (!hello || rest.length) { reject(); return false; }
      expectClient = true;
      socket.write(`${JSON.stringify({
        letagents_daemon_server: answer(proof, "server", hello.letagents_daemon_hello),
        letagents_daemon_challenge: daemonNonce,
      })}\n`);
      return true;
    }
    const client = handshakeFrame(line, ["letagents_daemon_client"]);
    if (!client || !sameHex(client.letagents_daemon_client, answer(proof, "client", daemonNonce))) { reject(); return false; }
    cleanup();
    socket.pause();
    if (rest.length) socket.unshift(rest);
    onAccepted(socket);
    // An explicit pause outlives new "data" listeners; flow resumes here.
    socket.resume();
    return false;
  }, reject);
  const cleanup = () => {
    clearTimeout(timer);
    socket.off("data", read);
    socket.off("close", cleanup);
  };
  socket.on("data", read);
  socket.once("close", cleanup);
}
