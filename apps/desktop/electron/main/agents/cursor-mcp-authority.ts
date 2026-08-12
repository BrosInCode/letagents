import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";

import {
  defaultGetProcessIdentity,
} from "./provider-evidence.js";

export type CursorMcpListResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  errorCode: string | null;
};

const CURSOR_MCP_INSPECTION_TIMEOUT_MS = 8_000;
const CURSOR_MCP_INSPECTION_REAP_GRACE_MS = 500;
const CURSOR_MCP_INSPECTION_PARENT_TERMINAL_GRACE_MS = 3_000;
const CURSOR_MCP_INSPECTION_GROUP_RETIRE_TIMEOUT_MS = 3_000;
const MAX_CURSOR_MCP_LIST_BYTES = 64 * 1024;
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

export type CursorMcpInspectionDependencies = {
  /** null is proven absent; undefined is ambiguous. */
  getProcessIdentity(pid: number): string | null | undefined;
  processGroupAlive(pid: number): boolean;
  wait(ms: number): Promise<void>;
};

const DEFAULT_CURSOR_MCP_INSPECTION_DEPENDENCIES: CursorMcpInspectionDependencies = {
  getProcessIdentity: defaultGetProcessIdentity,
  processGroupAlive(pid) {
    if (process.platform === "win32") return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// The wrapper is the durable process-group leader and deliberately stays alive
// until its native `cursor-agent mcp list` child and every inherited descendant
// have left that group. Parent-side cleanup therefore uses only the exact IPC
// channel to the birth-fenced wrapper. TERM/KILL of the group happens from
// inside its still-live leader, so a post-close recycled numeric PGID is never
// authority.
const CURSOR_MCP_INSPECTION_WRAPPER_SOURCE = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const command = process.argv[1];
const graceMs = Number(process.argv[2]) || 500;
const maxOutputBytes = Number(process.argv[3]) || 65536;
const writableRoots = JSON.parse(process.argv[4]);
const readableRoots = JSON.parse(process.argv[5]);
const executablePaths = JSON.parse(process.argv[6]);
const commandArgs = JSON.parse(process.argv[7]);
const allowedNetworkRemotes = JSON.parse(process.argv[8]);
let started = false;
let native = null;
let nativeTerminal = null;
let reaping = null;
let outputBroken = false;
let outputBytes = 0;
let outputOverflow = false;
let pendingOutputWrites = 0;
let outputWaiters = [];
let nativeClosed = false;
let resolveNativeClosed = () => {};
const nativeClose = new Promise((resolve) => { resolveNativeClosed = resolve; });
let hardFailureTimer = null;

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function ownGroupMembers() {
  if (process.platform === "win32") return [];
  try {
    // The inspector is detached so this probe never joins the wrapper's group
    // and therefore never appears as a false surviving descendant.
    const inspected = spawnSync("/bin/ps", ["-axo", "pid=,pgid="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], detached: true,
      timeout: 250, maxBuffer: 1024 * 1024,
    });
    if (inspected.error || inspected.status !== 0 || typeof inspected.stdout !== "string") return null;
    return inspected.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) return [];
      const pid = Number(match[1]);
      const pgid = Number(match[2]);
      return pgid === process.pid && pid !== process.pid ? [pid] : [];
    });
  } catch { return null; }
}
function signalOwnGroup(signal) {
  if (process.platform === "win32") {
    try { native && native.kill(signal); } catch {}
    return;
  }
  try { process.kill(-process.pid, signal); }
  catch (error) { if (!error || error.code !== "ESRCH") throw error; }
}
function reportWrapperError(code) {
  if (!process.send) return Promise.resolve();
  return new Promise((resolve) => {
    try { process.send({ type: "wrapper_error", code }, () => resolve()); }
    catch { resolve(); }
  });
}
function reportSafeForcedReap() {
  if (!process.send) return Promise.resolve();
  return new Promise((resolve) => {
    try { process.send({ type: "reap_evidence_complete" }, () => resolve()); }
    catch { resolve(); }
  });
}
function finishOutputWrite() {
  pendingOutputWrites = Math.max(0, pendingOutputWrites - 1);
  if (pendingOutputWrites !== 0) return;
  const waiters = outputWaiters;
  outputWaiters = [];
  for (const resolve of waiters) resolve();
}
function awaitOutputWrites() {
  if (outputBroken || pendingOutputWrites === 0) return Promise.resolve();
  return new Promise((resolve) => outputWaiters.push(resolve));
}
function forwardOutput(source, target, chunk) {
  if (outputBroken || outputOverflow) return;
  outputBytes += chunk.length;
  if (outputBytes > maxOutputBytes) {
    outputOverflow = true;
    source.pause();
    void reportWrapperError("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    void beginReaping();
    return;
  }
  pendingOutputWrites += 1;
  const accepted = target.write(chunk, finishOutputWrite);
  if (!accepted) {
    source.pause();
    target.once("drain", () => { if (!outputBroken && !outputOverflow) source.resume(); });
  }
}
async function publishTerminal() {
  // Native exit starts cleanup, but inherited descendant descriptors can keep
  // these pipes open. Terminal publication waits for close and for every
  // forwarded write callback, which orders all authority evidence before IPC.
  await nativeClose;
  await awaitOutputWrites();
  if (outputBroken || outputOverflow || !nativeTerminal || !process.send) return;
  return new Promise((resolve) => {
    try { process.send({ type: "terminal", terminal: nativeTerminal }, () => resolve()); }
    catch { resolve(); }
  });
}
function beginReaping() {
  if (reaping) return reaping;
  // Independent of the normal reap promise: an escaped descendant can retain
  // inherited native pipes after leaving this process group. Never let that
  // make timeout/abort or attestation completion unbounded, and never publish
  // success without native close.
  hardFailureTimer = setTimeout(
    () => process.exit(1),
    Math.max(3_000, graceMs + 1_000),
  );
  reaping = (async () => {
    if (!started || !native) {
      process.exit(1);
      return;
    }
    let members = ownGroupMembers();
    if (members === null || members.length > 0) {
      signalOwnGroup("SIGTERM");
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline) {
        await wait(25);
        members = ownGroupMembers();
        if (members !== null && members.length === 0) break;
      }
    }
    if (members === null || members.length > 0) {
      // A forced group KILL also kills this leader. Preserve native success only
      // when close already proved every inherited evidence pipe ended and every
      // forwarded write callback completed. Otherwise fail before KILL rather
      // than accepting potentially truncated authority evidence.
      if (nativeClosed && !outputBroken && !outputOverflow) {
        await publishTerminal();
        await reportSafeForcedReap();
      } else {
        await reportWrapperError("ERR_CHILD_PROCESS_REAP");
      }
      signalOwnGroup("SIGKILL");
      return;
    }
    if (outputBroken || outputOverflow) {
      await reportWrapperError(outputOverflow
        ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        : "ERR_CHILD_PROCESS_STDIO");
      process.exit(1);
      return;
    }
    await publishTerminal();
    if (hardFailureTimer) clearTimeout(hardFailureTimer);
    process.exit(!outputBroken && !outputOverflow && nativeTerminal && nativeTerminal.type === "exit" && nativeTerminal.code === 0 ? 0 : 1);
  })();
  return reaping;
}
function start() {
  if (started) return;
  started = true;
  const nativeEnv = { ...process.env };
  // Wrapper-only: leaving this set could change an Electron-backed Cursor
  // executable into Node mode.
  delete nativeEnv.ELECTRON_RUN_AS_NODE;
  const nativeCommand = process.platform === "darwin" ? "/usr/bin/sandbox-exec" : command;
  const nativeArgs = process.platform === "darwin"
    ? [
      "-p",
      [
        "(version 1)",
        "(allow default)",
        // The disposable inspection process may manage itself and child
        // helpers, but may not signal its trusted wrapper or unrelated
        // same-UID processes even if it already knows their PIDs.
        "(deny signal (require-not (require-any (target self) (target children))))",
        ...(allowedNetworkRemotes.length > 0
          ? ["(deny network* (require-not (require-any "
            + allowedNetworkRemotes.map((remote) =>
              "(remote ip " + JSON.stringify(remote) + ")"
            ).join(" ")
            + ")))"]
          : ["(deny network*)"]),
        // Deny data reads globally, including credentials in alternate homes,
        // mounts, and temporary trees. Reading the root directory itself is
        // required by Node's loader but reveals only top-level names; the
        // exact system/runtime/profile subpaths below are the only data roots.
        "(deny file-read-data (require-not (require-any "
          + "(literal \"/\") "
          + readableRoots.map((root) =>
            "(subpath " + JSON.stringify(root) + ")"
          ).join(" ")
          + ")))",
        // Prevent delegation through arbitrary helpers such as open/osascript.
        // Cursor, its bundled runtime, npm/node, shell launchers, and files in
        // the disposable profile are the only executable authorities.
        "(deny process-exec (require-not (require-any "
          + executablePaths.map((path) =>
            "(literal " + JSON.stringify(path) + ")"
          ).join(" ")
          + " "
          + writableRoots.map((root) =>
            "(subpath " + JSON.stringify(root) + ")"
          ).join(" ")
          + ")))",
        "(deny file-write* (require-not (require-any "
          + "(literal \"/dev/null\") "
          + writableRoots.map((root) =>
            "(subpath " + JSON.stringify(root) + ")"
          ).join(" ")
          + ")))",
      ].join("\n"),
      command,
      ...commandArgs,
    ]
    : commandArgs;
  native = spawn(nativeCommand, nativeArgs, {
    cwd: process.cwd(), env: nativeEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  native.stdout.on("data", (chunk) => forwardOutput(native.stdout, process.stdout, chunk));
  native.stderr.on("data", (chunk) => forwardOutput(native.stderr, process.stderr, chunk));
  native.stdout.on("error", breakOutput);
  native.stderr.on("error", breakOutput);
  native.once("error", (error) => {
    nativeTerminal = { type: "error", error: error && error.message ? error.message : String(error) };
    void beginReaping();
  });
  native.once("exit", (code, signal) => {
    if (!nativeTerminal) nativeTerminal = { type: "exit", code, signal };
    void beginReaping();
  });
  native.once("close", (code, signal) => {
    if (!nativeTerminal) nativeTerminal = { type: "exit", code, signal };
    nativeClosed = true;
    resolveNativeClosed();
  });
}
process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "start") start();
  if (message.type === "terminate") { if (started) void beginReaping(); else process.exit(1); }
});
process.on("disconnect", () => { if (started) void beginReaping(); else process.exit(1); });
process.on("SIGTERM", () => { if (started) void beginReaping(); else process.exit(1); });
process.on("SIGINT", () => { if (started) void beginReaping(); else process.exit(1); });
function breakOutput() {
  if (outputBroken) return;
  outputBroken = true;
  const waiters = outputWaiters;
  outputWaiters = [];
  for (const resolve of waiters) resolve();
  void reportWrapperError("ERR_CHILD_PROCESS_STDIO");
  if (started) void beginReaping();
}
process.stdout.on("error", breakOutput);
process.stderr.on("error", breakOutput);
if (process.send) process.send({ type: "prepared" });
`;

/**
 * Treat `cursor-agent mcp list` as an authority attestation and fail closed
 * unless the isolated global profile reports exactly the daemon bridge. The
 * real launch deliberately omits Cursor's blanket `--approve-mcps`: global
 * profile servers load directly, while a project server added after this
 * check remains unapproved instead of gaining turn authority.
 */
export function cursorSupervisedMcpAuthorityError(
  result: CursorMcpListResult,
  expectedServerName = "letagents",
): string | null {
  if (!result.ok) {
    const safeCode = result.errorCode && /^[A-Z0-9_]+$/.test(result.errorCode)
      ? ` (${result.errorCode})`
      : "";
    return `Cursor failed while inspecting the effective supervised MCP registry${safeCode}.`;
  }
  if (result.stderr.trim()) {
    return "Cursor emitted diagnostics while inspecting the supervised MCP registry, so exact authority could not be proved.";
  }
  const lines = result.stdout
    .replace(ANSI_ESCAPE_PATTERN, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1 || lines[0] !== `${expectedServerName}: ready`) {
    return `Supervised Cursor requires exactly one effective MCP entry reported as '${expectedServerName}: ready'; extra, unavailable, or ambiguous servers are rejected.`;
  }
  return null;
}

/**
 * Registry inspection proves what Cursor would approve, but is not itself a
 * supervised turn. Keep its native process and any daemonized descendants
 * unable to exercise a turn capability before the real launch is admitted.
 */
export function cursorMcpInspectionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inspectionEnv = { ...env };
  for (const key of Object.keys(inspectionEnv)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === "CURSOR_API_KEY"
      || normalizedKey === "CURSOR_AUTH_TOKEN"
      || normalizedKey === "LETAGENTS_TOKEN"
      || normalizedKey === "LETAGENTS_AGENT_SESSION_BEARER"
      || normalizedKey.startsWith("LETAGENTS_SUPERVISOR_")
      || normalizedKey === "LETAGENTS_SUPERVISED_BOUNDED_TURNS"
      || normalizedKey === "LETAGENTS_EXECUTION_PROFILE"
      || normalizedKey === "LETAGENTS_PERMISSION_PROFILE_ID"
      || normalizedKey === "NODE_EXTRA_CA_CERTS"
      || normalizedKey === "SSL_CERT_DIR"
      || normalizedKey === "SSL_CERT_FILE") {
      delete inspectionEnv[key];
    }
  }
  return inspectionEnv;
}

export async function assertCursorSupervisedMcpAuthority(input: {
  cursorBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Disposable profile root; the macOS inspection sandbox can write only here. */
  writableProfileRoot: string;
  /** Immutable runtime trees needed by the configured MCP server. */
  requiredReadableRoots?: string[];
  /** Exact per-attempt alias configured in the isolated Cursor profile. */
  expectedServerName?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injectable process evidence for adversarial PID/PGID lifecycle tests. */
  dependencies?: Partial<CursorMcpInspectionDependencies>;
}): Promise<void> {
  const result = await runCursorSandboxedInspection({
    ...input,
    commandArgs: ["--disable-project-configs", "mcp", "list"],
  });
  const expectedServerName = input.expectedServerName?.trim() || "letagents";
  if (!/^[a-z0-9_]{1,96}$/.test(expectedServerName)) {
    throw new Error("Supervised Cursor MCP attestation requires a bounded safe server name.");
  }
  const detail = cursorSupervisedMcpAuthorityError(result, expectedServerName);
  if (detail) throw new Error(detail);
}

/**
 * Execute a non-authoritative Cursor inspection in a disposable, write-confined
 * profile. The caller supplies the exact native argv and any loopback remotes;
 * all other network, data-read, process-exec, and write authority is denied on
 * macOS. The durable wrapper bounds output, timeout/abort, and group cleanup.
 */
export async function runCursorSandboxedInspection(input: {
  cursorBin: string;
  commandArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  writableProfileRoot: string;
  requiredReadableRoots?: string[];
  allowedNetworkRemotes?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  dependencies?: Partial<CursorMcpInspectionDependencies>;
}): Promise<CursorMcpListResult> {
  if (process.platform === "win32") {
    throw new Error("Supervised Cursor inspection requires POSIX process-group cleanup; Windows is not supported.");
  }
  if (process.platform !== "darwin" && process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON !== "1") {
    throw new Error("Supervised Cursor inspection requires macOS write confinement.");
  }
  if (!input.writableProfileRoot.trim()) {
    throw new Error("Supervised Cursor inspection requires a disposable writable profile root.");
  }
  if (input.commandArgs.length === 0
    || input.commandArgs.length > 32
    || input.commandArgs.some((arg) => arg.includes("\0") || Buffer.byteLength(arg, "utf8") > 8_192)) {
    throw new Error("Supervised Cursor inspection requires bounded native arguments.");
  }
  const allowedNetworkRemotes = [...new Set(input.allowedNetworkRemotes ?? [])];
  if (allowedNetworkRemotes.length > 4
    || allowedNetworkRemotes.some((remote) => !/^(?:127\.0\.0\.1|localhost):[1-9]\d{0,4}$/.test(remote))) {
    throw new Error("Supervised Cursor inspection permits only bounded loopback remotes.");
  }
  const logicalWritableRoot = resolve(input.writableProfileRoot);
  const writableStat = lstatSync(logicalWritableRoot);
  if (!writableStat.isDirectory() || writableStat.isSymbolicLink()) {
    throw new Error("Supervised Cursor MCP attestation refuses a redirected writable profile root.");
  }
  const writableRoot = realpathSync(logicalWritableRoot);
  if (writableRoot === "/") {
    throw new Error("Supervised Cursor MCP attestation refuses an unbounded writable root.");
  }
  const inspectionEnv = cursorMcpInspectionEnv(input.env);
  const cursorExecutable = resolveExecutablePath(input.cursorBin, input.cwd, inspectionEnv);
  // The wrapper itself runs under process.execPath, and both the inert probe
  // and npm's shebang may legitimately re-exec that same runtime. Admit it
  // explicitly even when the caller needs no additional child executable.
  const childExecutables = [process.execPath].map((command) =>
    resolveExecutablePath(command, input.cwd, inspectionEnv));
  const executablePaths = uniqueExistingPaths([
    cursorExecutable.logical,
    cursorExecutable.canonical,
    ...childExecutables.flatMap((path) => [path.logical, path.canonical]),
    ...cursorBundledRuntimePaths(cursorExecutable.canonical),
    "/bin/bash",
    "/bin/realpath",
    "/bin/sh",
    "/usr/bin/basename",
    "/usr/bin/dirname",
    "/usr/bin/env",
    "/usr/bin/readlink",
    "/usr/bin/realpath",
    "/usr/bin/security",
  ]);
  const readableRoots = uniqueExistingPaths([
    writableRoot,
    dirname(cursorExecutable.logical),
    dirname(cursorExecutable.canonical),
    ...macAppBundleRootPaths(cursorExecutable.canonical),
    ...childExecutables.flatMap((path) => [dirname(path.logical), dirname(path.canonical)]),
    ...childExecutables.flatMap((path) => macAppBundleRootPaths(path.canonical)),
    ...(input.requiredReadableRoots ?? []).map((path) => resolve(path)),
    "/System",
    "/Library",
    "/bin",
    "/sbin",
    "/usr",
    "/private/etc",
    "/private/var/db",
    "/private/var/run",
    "/dev",
  ]).map((path) => realpathSync(path));
  return execCursorInspection(
    input.cursorBin,
    input.commandArgs,
    input.cwd,
    inspectionEnv,
    [writableRoot],
    readableRoots,
    executablePaths,
    allowedNetworkRemotes,
    input.timeoutMs,
    input.signal,
    { ...DEFAULT_CURSOR_MCP_INSPECTION_DEPENDENCIES, ...input.dependencies },
  );
}

function execCursorInspection(
  command: string,
  commandArgs: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  writableRoots: string[],
  readableRoots: string[],
  executablePaths: string[],
  allowedNetworkRemotes: string[],
  timeoutMs = CURSOR_MCP_INSPECTION_TIMEOUT_MS,
  signal?: AbortSignal,
  dependencies: CursorMcpInspectionDependencies = DEFAULT_CURSOR_MCP_INSPECTION_DEPENDENCIES,
): Promise<CursorMcpListResult> {
  return new Promise((resolveResult) => {
    if (signal?.aborted) {
      resolveResult({ ok: false, stdout: "", stderr: "", errorCode: "ABORT_ERR" });
      return;
    }
    let errorCode: string | null = null;
    const child = spawn(process.execPath, [
      "-e",
      CURSOR_MCP_INSPECTION_WRAPPER_SOURCE,
      command,
      String(CURSOR_MCP_INSPECTION_REAP_GRACE_MS),
      String(MAX_CURSOR_MCP_LIST_BYTES),
      JSON.stringify(writableRoots),
      JSON.stringify(readableRoots),
      JSON.stringify(executablePaths),
      JSON.stringify(commandArgs),
      JSON.stringify(allowedNetworkRemotes),
    ], {
      cwd,
      env: {
        ...env,
        // In packaged Electron, process.execPath is the Electron binary. The
        // wrapper must execute as Node just like the production turn wrapper.
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const wrapperPid = child.pid ?? null;
    let wrapperIdentity: string | null | undefined;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let commandTimer: ReturnType<typeof setTimeout> | null = null;
    let terminalTimer: ReturnType<typeof setTimeout> | null = null;
    let wrapperStarted = false;
    let wrapperPreparing = false;
    let terminationRequested = false;
    let safeForcedReap = false;
    let nativeTerminal: { type: "exit"; code: number | null; signal: NodeJS.Signals | null } | { type: "error"; error: string } | null = null;

    const settleWithoutClose = () => {
      if (terminalTimer) clearTimeout(terminalTimer);
      if (commandTimer) clearTimeout(commandTimer);
      signal?.removeEventListener("abort", abort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      try {
        if (child.connected) child.disconnect();
      } catch {
        // The inspection environment is non-authoritative and write-confined;
        // a nonresponsive wrapper must not retain the caller indefinitely.
      }
      child.unref();
      resolveResult({
        ok: false,
        stdout,
        stderr,
        errorCode: errorCode ?? "ERR_CHILD_PROCESS_REAP",
      });
    };

    const requestTermination = (code: string) => {
      if (!errorCode) errorCode = code;
      if (terminationRequested) return;
      terminationRequested = true;
      terminalTimer = setTimeout(
        settleWithoutClose,
        CURSOR_MCP_INSPECTION_PARENT_TERMINAL_GRACE_MS,
      );
      // IPC is an exact capability to this ChildProcess. Unlike a numeric PID,
      // it cannot be recycled between a birth check and signal dispatch.
      const disconnectExactChannel = () => {
        try {
          if (child.connected) child.disconnect();
        } catch {
          // Close remains the only safe terminal proof.
        }
      };
      try {
        if (!child.connected) return;
        child.send({ type: "terminate" }, (error) => {
          if (error) disconnectExactChannel();
        });
      } catch (error) {
        disconnectExactChannel();
      }
    };
    const appendOutput = (target: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_CURSOR_MCP_LIST_BYTES) {
        requestTermination("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendOutput("stderr", chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (!errorCode) errorCode = error.code ? String(error.code) : "ERR_CHILD_PROCESS";
    });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const payload = message as { type?: unknown; terminal?: unknown };
      if (payload.type === "reap_evidence_complete") {
        safeForcedReap = true;
        return;
      }
      if (payload.type === "wrapper_error") {
        const code = (payload as { code?: unknown }).code;
        if (!errorCode) errorCode = typeof code === "string" && code ? code : "ERR_CHILD_PROCESS_REAP";
        return;
      }
      if (payload.type === "terminal" && payload.terminal && typeof payload.terminal === "object") {
        nativeTerminal = payload.terminal as typeof nativeTerminal;
        return;
      }
      if (payload.type !== "prepared" || wrapperStarted || wrapperPreparing) return;
      wrapperPreparing = true;
      void (async () => {
        if (wrapperPid === null) {
          requestTermination("ERR_CHILD_PROCESS_IDENTITY");
          return;
        }
        wrapperIdentity = dependencies.getProcessIdentity(wrapperPid);
        if (wrapperIdentity === undefined) {
          // The prepared IPC message proves this exact paused wrapper reached
          // its no-native boundary. Permit one bounded evidence retry without
          // ever using the result to signal a PID.
          await dependencies.wait(10);
          wrapperIdentity = dependencies.getProcessIdentity(wrapperPid);
        }
        if (typeof wrapperIdentity !== "string") {
          requestTermination("ERR_CHILD_PROCESS_IDENTITY");
          return;
        }
        if (errorCode || signal?.aborted) {
          requestTermination(errorCode ?? "ABORT_ERR");
          return;
        }
        wrapperStarted = true;
        try {
          child.send({ type: "start" }, (error) => {
            if (error) {
              const nodeError = error as NodeJS.ErrnoException;
              requestTermination(nodeError.code ? String(nodeError.code) : "ERR_CHILD_PROCESS");
            }
          });
        } catch (error) {
          const nodeError = error as NodeJS.ErrnoException;
          requestTermination(nodeError.code ? String(nodeError.code) : "ERR_CHILD_PROCESS");
        }
      })();
    });
    const abort = () => requestTermination("ABORT_ERR");
    signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs > 0) {
      commandTimer = setTimeout(() => requestTermination("ETIMEDOUT"), timeoutMs);
    }
    child.once("close", (code) => {
      if (commandTimer) clearTimeout(commandTimer);
      if (terminalTimer) clearTimeout(terminalTimer);
      signal?.removeEventListener("abort", abort);
      void awaitCursorMcpInspectionGroupRetired(
        wrapperPid,
        wrapperStarted ? wrapperIdentity : null,
        dependencies,
      ).then(() => {
        resolveResult({
          ok: (code === 0 || safeForcedReap)
            && !errorCode
            && nativeTerminal?.type === "exit"
            && nativeTerminal.code === 0
            && nativeTerminal.signal === null,
          stdout,
          stderr,
          errorCode,
        });
      }, () => {
        resolveResult({
          ok: false,
          stdout,
          stderr,
          errorCode: errorCode ?? "ERR_CHILD_PROCESS_REAP",
        });
      });
    });
  });
}

function resolveExecutablePath(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): { logical: string; canonical: string } {
  const candidates = isAbsolute(command) || command.includes("/")
    ? [resolve(cwd, command)]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((entry) => resolve(entry, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return { logical: candidate, canonical: realpathSync(candidate) };
    } catch {
      // Continue through PATH without executing a shell or inheriting aliases.
    }
  }
  throw new Error(`Supervised Cursor MCP attestation could not resolve required executable '${command}'.`);
}

function cursorBundledRuntimePaths(cursorExecutable: string): string[] {
  const runtime = resolve(dirname(cursorExecutable), "node");
  return existsSync(runtime) ? [runtime] : [];
}

function macAppBundleRootPaths(executable: string): string[] {
  let current = dirname(executable);
  for (;;) {
    if (current.endsWith(".app")) return [current];
    const parent = dirname(current);
    if (parent === current) return [];
    current = parent;
  }
}

function uniqueExistingPaths(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => existsSync(path)))];
}

async function awaitCursorMcpInspectionGroupRetired(
  pid: number | null,
  processIdentity: string | null | undefined,
  dependencies: CursorMcpInspectionDependencies,
): Promise<void> {
  if (pid === null || typeof processIdentity !== "string" || process.platform === "win32") return;
  // The live wrapper already signalled its own group before it exited. After
  // close, this parent only observes retirement; it never treats the reusable
  // numeric PGID as signal authority. ChildProcess close proves the original
  // leader was reaped, so any process now occupying its PID is necessarily a
  // recycled leader and proves the old group retired.
  const deadline = Date.now() + CURSOR_MCP_INSPECTION_GROUP_RETIRE_TIMEOUT_MS;
  while (dependencies.processGroupAlive(pid)) {
    const current = dependencies.getProcessIdentity(pid);
    if (typeof current === "string") return;
    if (Date.now() >= deadline) {
      throw new Error("Cursor MCP inspection process-group retirement remained ambiguous.");
    }
    await dependencies.wait(25);
  }
}
