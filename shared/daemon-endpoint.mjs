import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { Socket, createConnection } from "node:net";
import { userInfo } from "node:os";
import { posix, win32 } from "node:path";

import { loadDaemonPipeAddon } from "./daemon-pipe-native.mjs";
import { letagentsHome } from "./letagents-home.mjs";
import { isOwnerPrivate, writePrivateFileAtomically } from "./owner-private-fs.mjs";

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
//   3. A client opens the pipe only through letagents-daemon-pipe.node
//      (shared/daemon-pipe-native.mjs), never with libuv's connect: with
//      SECURITY_IDENTIFICATION, so whatever serves the name cannot act as the
//      client (libuv's default lets it impersonate), and only when the server
//      process runs as this user, before the client writes a byte.

export const DAEMON_SOCKET_FILE = "daemon.sock";
export const DAEMON_PROOF_FILE = "daemon-endpoint.proof";
/** Optional state directory for a worker whose own home differs from the daemon's. */
export const DAEMON_STATE_DIR_ENV = "LETAGENTS_SUPERVISOR_DAEMON_STATE_DIR";
const PROOF_PATTERN = /^[a-f0-9]{64}$/;
const MAX_HANDSHAKE_LINE_BYTES = 512;
const PIPE_PATTERN = /^\\\\[.?]\\pipe\\/i;

/** Proof paths of endpoints this process computed, by connect path. */
const knownProofPaths = new Map();

export function isWindowsPipePath(path) {
  return typeof path === "string" && PIPE_PATTERN.test(path);
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
 * Read the proof, or create it. A valid proof survives restarts and handoffs,
 * so a client never races a rotation. It is reused only while it is a regular
 * file private to this account (mode 0600 on POSIX; on Windows the account as
 * owner and a protected DACL for only the account and SYSTEM). Anything else
 * is replaced: a proof that others could read is no longer a secret. A new
 * proof is written in a private staging folder before it is renamed into
 * place, so no other account can hold a handle to it.
 */
export async function ensureDaemonProof(proofPath, { recheckDelayMs = 250, checkPrivacy = isOwnerPrivate, ...options } = {}) {
  try {
    const info = await lstat(proofPath);
    // On Windows a failed DACL read and a "not private" answer look the same.
    // A rotation mid-handoff fails clients holding the old proof, so a valid
    // proof is replaced only when a second check agrees.
    // The proof is a high-value secret: its own DACL is read every time (see checkObject).
    const objectOptions = { ...options, checkObject: true };
    const isPrivate = async () => await checkPrivacy(proofPath, info, objectOptions)
      || (await new Promise((resolve) => setTimeout(resolve, recheckDelayMs)), await checkPrivacy(proofPath, info, objectOptions));
    if (info.isFile() && await isPrivate()) {
      const existing = parseProof(await readFile(proofPath, "utf8"));
      if (existing) {
        rememberPrivateDaemonProof(proofPath, info);
        return existing;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const proof = randomBytes(32).toString("hex");
  await writePrivateFileAtomically(proofPath, `${proof}\n`, options);
  // Only a new or rotated proof pays for this check; it binds the record to
  // the file as it is after the rename.
  const written = await lstat(proofPath);
  if (written.isFile() && await checkPrivacy(proofPath, written, { ...options, checkObject: true })) rememberPrivateDaemonProof(proofPath, written);
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

const PRIVATE_PROOF_REFRESH_MS = 5 * 60_000;
/**
 * Proofs this process found private, by path: the file identity the verdict
 * is for (path, inode, mtime, ctime, size; ctime moves with the mode or the
 * DACL) and when to check it again. Only "private" is kept: a "not private"
 * answer may be a failed DACL read, so it is asked again next time.
 */
const privateProofs = new Map();
/** One check in flight per file identity, shared by concurrent connections. */
const pendingChecks = new Map();

function proofIdentity(path, info) {
  return `${path}\0${info.ino}\0${info.mtimeMs}\0${info.ctimeMs}\0${info.size}`;
}

function checkProofPrivacy(path, info, identity, options) {
  let pending = pendingChecks.get(identity);
  if (!pending) {
    pending = (async () => {
      const { checkPrivacy = isOwnerPrivate, ...privacy } = options;
      // checkObject: the proof's own DACL is read even when owner-private-fs knows the file.
      const isPrivate = info.isFile() && await checkPrivacy(path, info, { ...privacy, checkObject: true });
      if (isPrivate) privateProofs.set(path, { identity, refreshAt: Date.now() + PRIVATE_PROOF_REFRESH_MS });
      else if (privateProofs.get(path)?.identity === identity) privateProofs.delete(path);
      return isPrivate;
    })().finally(() => pendingChecks.delete(identity));
    pendingChecks.set(identity, pending);
  }
  return pending;
}

/**
 * Record a proof this process has just found private (the daemon's own
 * ensureDaemonProof, a test fake that wrote it privately), so clients in the
 * same process need not read its DACL again. `checkedInfo` is the lstat result
 * the privacy check ran on: the record binds to that identity, so a change
 * after the check (a widened DACL moves ctime) is checked again.
 */
export function rememberPrivateDaemonProof(path, checkedInfo) {
  privateProofs.set(path, { identity: proofIdentity(path, checkedInfo), refreshAt: Date.now() + PRIVATE_PROOF_REFRESH_MS });
}

/**
 * The proof a client may use: a regular file private to this account (POSIX
 * mode 0600 and owner; on Windows the account as owner and a protected DACL
 * for only the account and SYSTEM). An exposed proof could let another
 * account squat the pipe and answer the handshake, so it is refused, never
 * used.
 *
 * A Windows check reads the DACL through PowerShell (about a second), which
 * request budgets as short as 250 ms cannot absorb. So a client waits for the
 * check only when this process has no verdict for the file as it is now (first
 * contact, a rotated proof, or a mode or DACL change, which moves ctime). A
 * verdict older than five minutes is still used while a background check
 * renews it; a "not private" answer drops it, so the next connection checks
 * again and is refused while the proof stays exposed.
 */
async function readClientProof(path, options) {
  if (!path) throw untrusted("no LetAgents state directory of this user owns this pipe");
  const info = await lstat(path);
  const identity = proofIdentity(path, info);
  const known = privateProofs.get(path);
  if (known?.identity === identity) {
    if (known.refreshAt <= Date.now()) {
      known.refreshAt = Date.now() + PRIVATE_PROOF_REFRESH_MS;
      void checkProofPrivacy(path, info, identity, options).catch(() => { privateProofs.delete(path); });
    }
  } else if (!await checkProofPrivacy(path, info, identity, options)) {
    throw untrusted("the proof file is not private to this account");
  }
  const proof = parseProof(await readFile(path, "utf8"));
  if (!proof) throw untrusted("the proof file is malformed");
  return proof;
}

/**
 * Start the client's proof check, and load and check the pipe addon, ahead of
 * the first request, so a short first budget does not pay for either. Errors
 * surface on the request itself.
 */
export function prepareDaemonConnection(connectPath, { proofPath, ...options } = {}) {
  if (!isWindowsPipePath(connectPath)) return;
  void Promise.resolve().then(() => readClientProof(proofPath ?? resolveDaemonProofPath(connectPath), options)).catch(() => undefined);
  setImmediate(() => { try { loadDaemonPipeAddon(); } catch { /* the request reports it */ } }).unref?.();
}

const PIPE_BUSY_RETRY_MS = 20;
const kTransport = Symbol("letagents.daemonTransport");

/**
 * Open a Windows daemon pipe through letagents-daemon-pipe.node (see
 * shared/daemon-pipe-native.mjs): with SECURITY_IDENTIFICATION, so the server
 * end cannot act as this user, and only when the process serving it runs as
 * this user, before this process writes anything. libuv's own connect has
 * neither property and is never used for this pipe. Every instance busy: try
 * again until `cancelled()`.
 */
async function openDaemonPipe(connectPath, cancelled) {
  const addon = loadDaemonPipeAddon();
  for (;;) {
    let opened;
    try {
      opened = addon.open(connectPath);
    } catch (error) {
      if (error?.code !== "EBUSY" || cancelled()) throw error;
      await new Promise((resolve) => setTimeout(resolve, PIPE_BUSY_RETRY_MS));
      continue;
    }
    // A failed N-API call returns nothing; never wrap a socket without the pipe.
    if (!Number.isInteger(opened?.fd) || opened.fd < 0) throw Object.assign(new Error("The daemon pipe addon returned no descriptor."), { code: "EIO" });
    try {
      return new Socket({ fd: opened.fd, readable: true, writable: true });
    } catch (error) {
      closeSync(opened.fd);
      throw error;
    }
  }
}

/** A Unix socket for the handshake in tests, once it connected. */
function openUnixSocket(connectPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(connectPath);
    socket.once("error", reject);
    socket.once("connect", () => { socket.off("error", reject); resolve(socket); });
  });
}

/**
 * What connectDaemon returns for a handshake connection: a net.Socket the
 * caller uses as any other, whose bytes travel over a transport opened after
 * the proof was read (the addon's pipe, or a Unix socket in tests). It emits
 * "connect" (and "ready") only after both sides proved themselves; the
 * handshake lines never reach the caller.
 */
class DaemonConnection extends Socket {
  #transport = null;
  #open = false;
  #referenced = true;
  #ended = false;

  constructor() {
    super();
    this.connecting = true;
  }

  /** The transport socket, for tests that look at its handle. */
  get [kTransport]() { return this.#transport; }

  attach(transport) {
    if (this.destroyed) { transport.destroy(); return false; }
    this.#transport = transport;
    if (!this.#referenced) transport.unref();
    transport.on("error", (error) => this.destroy(error));
    transport.on("end", () => this.#pushEnd());
    transport.once("close", () => {
      this.#pushEnd();
      // A consumer reads the end and the stream closes itself; otherwise close now.
      if (!this.#open || this.readableFlowing !== true) this.destroy();
    });
    return true;
  }

  /** The handshake passed: hand the stream to the caller. */
  admit() {
    const transport = this.#transport;
    this.#open = true;
    transport.on("data", (chunk) => {
      this._unrefTimer();
      if (!this.push(chunk)) transport.pause();
    });
    this.connecting = false;
    this.emit("connect");
    this.emit("ready");
  }

  #pushEnd() {
    if (this.#ended || !this.#open) return;
    this.#ended = true;
    this.push(null);
  }

  _read() {
    if (this.#open) this.#transport.resume();
  }

  _write(chunk, encoding, callback) {
    if (!this.#open) { callback(new Error("connectDaemon: write only after the connect event.")); return; }
    this._unrefTimer();
    this.#transport.write(chunk, encoding, callback);
  }

  _writev(chunks, callback) {
    if (!this.#open) { callback(new Error("connectDaemon: write only after the connect event.")); return; }
    this._unrefTimer();
    this.#transport.cork();
    chunks.forEach(({ chunk, encoding }, index) => this.#transport.write(chunk, encoding, index === chunks.length - 1 ? callback : undefined));
    this.#transport.uncork();
  }

  _final(callback) {
    const transport = this.#transport;
    if (!this.#open || !transport || transport.destroyed || transport.writableFinished) { callback(); return; }
    // A transport error reaches the caller through its "error" listener.
    transport.end(() => callback());
  }

  _destroy(error, callback) {
    this.#transport?.destroy();
    super._destroy(error, callback);
  }

  ref() {
    this.#referenced = true;
    this.#transport?.ref();
    return this;
  }

  unref() {
    this.#referenced = false;
    this.#transport?.unref();
    return this;
  }
}

/** The transport of a handshake connection (tests only). */
export function daemonConnectionTransport(socket) {
  return socket instanceof DaemonConnection ? socket[kTransport] : null;
}

/**
 * Connect to the daemon. On POSIX this is exactly `createConnection(path)`.
 * On a Windows pipe the proof is read and found private first, then the pipe
 * is opened through letagents-daemon-pipe.node (never by libuv), then the
 * handshake runs: the caller's "connect" (and "ready") fire only after both
 * sides proved themselves, and the handshake lines never reach the caller's
 * "data" listeners. A missing proof file or pipe reads as ENOENT (no daemon
 * has run here); an exposed proof, a pipe served by another account or a
 * daemon that fails its proof is ERR_LETAGENTS_DAEMON_UNTRUSTED; a missing or
 * unsealed addon is ERR_LETAGENTS_DAEMON_PIPE_ADDON. `handshake: true` runs
 * the handshake over a Unix socket too, for tests on hosts without pipes.
 */
export function connectDaemon(connectPath, { proofPath, handshake = false, handshakeTimeoutMs = 10_000, ...privacy } = {}) {
  const pipe = isWindowsPipePath(connectPath);
  if (!handshake && !pipe) return createConnection(connectPath);
  const socket = new DaemonConnection();
  // An absolute bound on proof, connect and handshake. A caller's own timeout
  // may be unlimited (handoff, configuration apply) or reset by trickled
  // bytes; this one is not. It ends once the daemon proved itself or the
  // socket closed.
  const deadline = setTimeout(() => socket.destroy(Object.assign(
    new Error("The supervisor daemon did not complete its handshake in time."), { code: "ETIMEDOUT" })), handshakeTimeoutMs);
  deadline.unref?.();
  socket.once("close", () => clearTimeout(deadline));
  void (async () => {
    let proof;
    try {
      // The transport opens only after the proof is read and found private
      // (see readClientProof); until then the daemon sees nothing from this client.
      proof = await readClientProof(proofPath ?? resolveDaemonProofPath(connectPath), privacy);
    } catch (error) {
      // A missing or briefly locked proof (no daemon yet; an antivirus scan is a
      // sharing violation, EBUSY) reads as an absent daemon, which callers retry.
      // Denied access (EACCES, or EPERM as libuv reports it on Windows) and an
      // untrusted or exposed proof keep their own codes: retrying cannot help.
      const code = error?.code === "ENOENT" || error?.code === "EBUSY" ? "ENOENT" : error?.code ?? "ENOENT";
      socket.destroy(Object.assign(new Error(`Cannot prove this client to the supervisor daemon: ${error.message}`), { code, cause: error }));
      return;
    }
    if (socket.destroyed) return;
    let transport;
    try {
      transport = pipe ? await openDaemonPipe(connectPath, () => socket.destroyed) : await openUnixSocket(connectPath);
    } catch (error) {
      socket.destroy(error);
      return;
    }
    if (!socket.attach(transport)) return;
    const clientNonce = nonce();
    const read = lineReader((line, rest) => {
      const frame = handshakeFrame(line, ["letagents_daemon_server", "letagents_daemon_challenge"]);
      if (!frame || rest.length || !sameHex(frame.letagents_daemon_server, answer(proof, "server", clientNonce))) {
        socket.destroy(untrusted("The supervisor daemon pipe did not prove it belongs to this user."));
        return false;
      }
      transport.off("data", read);
      transport.write(`${JSON.stringify({ letagents_daemon_client: answer(proof, "client", frame.letagents_daemon_challenge) })}\n`);
      clearTimeout(deadline);
      socket.admit();
      return false;
    }, () => socket.destroy(untrusted("The supervisor daemon handshake is too large.")));
    transport.on("data", read);
    transport.write(`${JSON.stringify({ letagents_daemon_hello: clientNonce })}\n`);
  })();
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
