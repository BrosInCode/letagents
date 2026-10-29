// shared/process-tree.mjs with the platform injected: every Windows branch
// runs here on any host, against a recorded helper. The real helper is proved
// on Windows by apps/desktop/native/win-process-tree/process-tree.windows.test.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import test from "node:test";

import {
  isBirthEvidence,
  parseWindowsCommandLine,
  PROCESS_TREE_UNKILLABLE_EXIT_CODE,
  processBirth,
  processTreeHelperPath,
  processTreeHelperRefusal,
  quoteWindowsArgument,
  resolveWindowsCommand,
  sealedProcessTreeHelperSha256,
  signalTree,
  signalTreeOutcome,
  spawnTree,
  terminateTree,
  terminateTreeOutcome,
  windowsCommandLine,
  windowsProcessInfo,
  windowsTreeSize,
} from "../../../../shared/process-tree.mjs";
import { defaultInspectDaemonProcess, signalDaemonProcess } from "../main/supervisor-daemon/process-identity.js";

const HELPER = "C:\\Program Files\\LetAgents\\resources\\app\\runtime\\letagents-process-tree.exe";
const LSTART = "Tue Oct 29 01:02:03 2026";

type HelperCall = [string, string[]];
function recordingHelper(answers: Record<string, { status: number; stdout?: string }>) {
  const calls: HelperCall[] = [];
  const runHelper = (file: string, args: string[]) => {
    calls.push([file, args]);
    const answer = answers[args.join(" ")] ?? answers[args[0]!] ?? { status: 121 };
    return { status: answer.status, stdout: answer.stdout ?? "", error: undefined };
  };
  return { calls, runHelper };
}

function info(pid: number, creationTime: string, extra: Record<string, unknown> = {}) {
  return { status: 0, stdout: `${JSON.stringify({ pid, parentPid: 4, creationTime, exited: false, image: "C:\\x\\node.exe", commandLine: null, ...extra })}\n` };
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: Array<NodeJS.Signals | number | undefined> = [];
  constructor(readonly pid: number) { super(); }
  kill(signal?: NodeJS.Signals | number) { this.kills.push(signal); return true; }
  send(message: unknown) { this.emit("sent", message); return true; }
  exit(code: number) { this.exitCode = code; this.emit("exit", code, null); }
}

function recordingSpawn(pid = 4242) {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const children: FakeChild[] = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    const child = new FakeChild(pid + children.length);
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return { calls, children, spawn };
}

// The helper's bytes as the seal names them: processTreeHelperPath uses a file only when it is the sealed build.
const SEALED_BYTES = Buffer.from("MZ sealed helper");
const SEAL = { builds: { x64: { sha256: createHash("sha256").update(SEALED_BYTES).digest("hex") } } };
const sealedHelper = { seal: SEAL, readFile: () => SEALED_BYTES };

const windowsEnv = { PATH: "C:\\Tools;relative\\bin;C:\\Windows\\System32", ComSpec: "C:\\Windows\\System32\\cmd.exe", SystemRoot: "C:\\Windows" };
const files = new Set(["C:\\Tools\\codex.cmd", "C:\\Tools\\cursor-agent.exe", "C:\\Windows\\System32\\git.exe", HELPER]);
const exists = (file: string) => files.has(file);

test("POSIX: a tree signal is the old group-then-pid signal, and groupOnly never falls back to the pid", () => {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const kill = (pid: number, signal: NodeJS.Signals | 0) => { sent.push([pid, signal]); };
  assert.equal(signalTree(77, "SIGTERM", { platform: "darwin", kill }), true);
  assert.deepEqual(sent, [[-77, "SIGTERM"]]);

  sent.length = 0;
  const groupGone = (pid: number, signal: NodeJS.Signals | 0) => {
    sent.push([pid, signal]);
    if (pid < 0) throw Object.assign(new Error("no group"), { code: "ESRCH" });
  };
  assert.equal(signalTree(77, "SIGKILL", { platform: "linux", kill: groupGone }), true);
  assert.deepEqual(sent, [[-77, "SIGKILL"], [77, "SIGKILL"]]);

  sent.length = 0;
  assert.equal(signalTree(77, "SIGKILL", { platform: "darwin", kill: groupGone, groupOnly: true }), false);
  assert.deepEqual(sent, [[-77, "SIGKILL"]]);
});

test("POSIX: a process birth is `ps -o lstart=`, and only ESRCH proves absence", () => {
  const calls: Array<[string, string[]]> = [];
  const execFileSync = (file: string, args: string[]) => { calls.push([file, args]); return `${LSTART}\n`; };
  assert.equal(processBirth(12, { platform: "darwin", execFileSync }), LSTART);
  assert.deepEqual(calls, [["/bin/ps", ["-p", "12", "-o", "lstart="]]]);
  const failing = () => { throw new Error("ps failed"); };
  assert.equal(processBirth(12, { platform: "darwin", execFileSync: failing, probe: () => { throw Object.assign(new Error(), { code: "ESRCH" }); } }), null);
  assert.equal(processBirth(12, { platform: "darwin", execFileSync: failing, probe: () => { throw Object.assign(new Error(), { code: "EPERM" }); } }), undefined);
  assert.equal(processBirth(12, { platform: "darwin", execFileSync: failing, probe: () => {} }), undefined);
});

test("POSIX: spawnTree is exactly spawn, options untouched", () => {
  const { calls, spawn } = recordingSpawn();
  const options = { detached: true, stdio: "ignore" as const, cwd: "/repo" };
  spawnTree("codex", ["app-server"], options, { platform: "darwin", spawn, helperPath: HELPER });
  assert.deepEqual(calls, [{ command: "codex", args: ["app-server"], options }]);
});

test("Windows: spawnTree starts the resolved program inside the helper's job, the command line quoted as Node quotes it", () => {
  const { calls, spawn } = recordingSpawn();
  spawnTree("cursor-agent", ["two words", 'a "quote"'], { detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"], env: windowsEnv, cwd: "C:\\repo", argv0: "x", windowsVerbatimArguments: true }, { platform: "win32", spawn, helperPath: HELPER, exists });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, HELPER);
  assert.deepEqual(calls[0]!.args, ["spawn", "C:\\Tools\\cursor-agent.exe", 'C:\\Tools\\cursor-agent.exe "two words" "a \\"quote\\""']);
  // The helper's own spawn: hidden, the caller's stdio, cwd, env and detachment; no argv0 or verbatim flag of the program's.
  assert.deepEqual(calls[0]!.options, { detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"], env: windowsEnv, cwd: "C:\\repo", windowsHide: true });
});

test("Windows: a batch file runs through cmd.exe inside the job, never as a bare name from the working directory", () => {
  const { calls, spawn } = recordingSpawn();
  const shimText = "@echo off\r\nsomething that is not an npm shim\r\n";
  spawnTree("codex", ["exec", "50%"], { env: windowsEnv }, { platform: "win32", spawn, helperPath: HELPER, exists, launchOptions: { readFile: () => shimText } });
  assert.equal(calls[0]!.args[1], "C:\\Windows\\System32\\cmd.exe");
  assert.equal(calls[0]!.args[2], '"C:\\Windows\\System32\\cmd.exe" /d /e:on /v:off /s /c ""C:\\Tools\\codex.cmd" "exec" "50%%cd:~0,0%""');
  // A relative PATH entry is not searched, and a missing program spawns at a path that cannot exist, so
  // Node reports ENOENT and never runs a program of that name from the working directory (the repository).
  assert.equal(resolveWindowsCommand("tool", { env: { PATH: "relative\\bin" }, exists: () => true }), null);
  const missing = recordingSpawn();
  spawnTree("nothing-here", ["x"], { env: windowsEnv }, { platform: "win32", spawn: missing.spawn, helperPath: HELPER, exists });
  assert.equal(missing.calls[0]!.command, "C:\\Windows\\letagents-not-on-path\\nothing-here");
  assert.equal(missing.calls[0]!.options.windowsHide, true);
});

test("Windows: without the helper the program is spawned directly, as before, and hidden", () => {
  const { calls, spawn } = recordingSpawn();
  spawnTree("git", ["fetch"], { env: windowsEnv, stdio: "ignore" }, { platform: "win32", spawn, helperPath: null, exists });
  assert.deepEqual(calls, [{ command: "C:\\Windows\\System32\\git.exe", args: ["fetch"], options: { env: windowsEnv, stdio: "ignore", windowsHide: true } }]);
});

test("Windows: the helper is the configured one, then the packaged runtime/ copy", () => {
  assert.equal(processTreeHelperPath({ platform: "darwin", env: {} }), null);
  assert.equal(processTreeHelperPath({ platform: "win32", env: { LETAGENTS_PROCESS_TREE_HELPER: HELPER }, exists, arch: "x64", ...sealedHelper }), HELPER);
  // A configured helper that is missing is not replaced by another.
  assert.equal(processTreeHelperPath({ platform: "win32", env: { LETAGENTS_PROCESS_TREE_HELPER: "C:\\gone.exe" }, resourcesPath: "C:\\Program Files\\LetAgents\\resources", exists, arch: "x64", ...sealedHelper }), null);
  assert.equal(processTreeHelperPath({ platform: "win32", env: {}, resourcesPath: "C:\\Program Files\\LetAgents\\resources", exists, includeLocalBuild: false, arch: "x64", ...sealedHelper }), HELPER);
  assert.equal(processTreeHelperPath({ platform: "win32", env: {}, resourcesPath: "", exists, includeLocalBuild: false, arch: "x64", ...sealedHelper }), null);
});

test("Windows: a process birth is the helper's creation time; absent is null; anything unproved is undefined", () => {
  const helper = recordingHelper({ "info 31": info(31, "133752345678901234"), "info 32": { status: 2 }, "info 33": { status: 3 }, "info 34": { status: 0, stdout: "not json" } });
  const options = { platform: "win32" as const, helperPath: HELPER, runHelper: helper.runHelper };
  assert.equal(processBirth(31, options), "win32-ft:133752345678901234");
  assert.equal(processBirth(32, options), null);
  assert.equal(processBirth(33, { ...options, probe: () => {} }), undefined);
  assert.equal(processBirth(33, { ...options, probe: () => { throw Object.assign(new Error(), { code: "ESRCH" }); } }), null);
  assert.equal(processBirth(34, { ...options, probe: () => {} }), undefined);
  assert.deepEqual(helper.calls[0], [HELPER, ["info", "31"]]);
  // An answer about another pid, or without a creation time, is not evidence.
  const wrong = recordingHelper({ info: info(99, "1") });
  assert.equal(windowsProcessInfo(31, { helperPath: HELPER, runHelper: wrong.runHelper }), undefined);
  // No helper: nothing to read, and the kill(0) probe decides absence alone.
  assert.equal(processBirth(31, { platform: "win32", helperPath: null, probe: () => {} }), undefined);
});

test("Windows: a pid this process does not hold is ended only through its recorded birth", () => {
  const helper = recordingHelper({ "kill 500 133752345678901234": { status: 0 }, "kill 501 133752345678901234": { status: 5 } });
  const options = { platform: "win32" as const, helperPath: HELPER, runHelper: helper.runHelper, liveTrees: new Map() };
  assert.equal(signalTree(500, "SIGTERM", { ...options, identity: "win32-ft:133752345678901234" }), true);
  assert.equal(signalTree(501, "SIGKILL", { ...options, identity: " win32-ft:133752345678901234\n" }), true);
  assert.deepEqual(helper.calls.map(([, args]) => args), [["kill", "500", "133752345678901234"], ["kill", "501", "133752345678901234"]]);
});

test("Windows: a reused pid is refused: the helper finds no process with the recorded birth and nothing is ended", () => {
  // The helper answers 2 when neither a job nor a process with that pid and creation time exists.
  const helper = recordingHelper({ kill: { status: 2 } });
  const options = { platform: "win32" as const, helperPath: HELPER, runHelper: helper.runHelper, liveTrees: new Map() };
  assert.equal(signalTree(600, "SIGKILL", { ...options, identity: "win32-ft:133752345678901234" }), false);
  helper.calls.length = 0;
  // Without a recorded birth, or with a POSIX one, the helper is not even asked.
  assert.equal(signalTree(600, "SIGKILL", options), false);
  assert.equal(signalTree(600, "SIGKILL", { ...options, identity: LSTART }), false);
  assert.equal(signalTree(600, "SIGKILL", { ...options, identity: "win32-ft:0" }), false);
  assert.deepEqual(helper.calls, []);
});

test("Windows: a tree this process holds is ended through its job, with its birth read while Node holds it", () => {
  const helper = recordingHelper({ "info 700": info(700, "55"), "kill 700 55": { status: 0 } });
  const child = new FakeChild(700);
  const liveTrees = new Map([[700, { child: child as unknown as ChildProcess, helper: HELPER }]]);
  assert.equal(signalTree(700, "SIGTERM", { platform: "win32", runHelper: helper.runHelper, liveTrees }), true);
  assert.deepEqual(helper.calls.map(([, args]) => args), [["info", "700"], ["kill", "700", "55"]]);
  assert.deepEqual(child.kills, []);

  // The helper could not be asked: killing the held helper process still closes its job.
  const failing = recordingHelper({});
  assert.equal(signalTree(700, "SIGTERM", { platform: "win32", runHelper: failing.runHelper, liveTrees }), true);
  assert.deepEqual(child.kills, [undefined]);

  // Once it exited, the pid is no longer the child's: nothing is ended without a birth.
  child.exit(1);
  const after = recordingHelper({});
  assert.equal(signalTree(700, "SIGTERM", { platform: "win32", runHelper: after.runHelper, liveTrees, helperPath: HELPER }), false);
  assert.deepEqual(after.calls, []);
});

test("Windows: a child spawned without the helper is ended alone, as before", () => {
  const child = new FakeChild(800);
  const liveTrees = new Map([[800, { child: child as unknown as ChildProcess, helper: null as unknown as string }]]);
  const helper = recordingHelper({});
  assert.equal(signalTree(800, "SIGKILL", { platform: "win32", runHelper: helper.runHelper, liveTrees, helperPath: null }), true);
  assert.deepEqual(child.kills, [undefined]);
  assert.deepEqual(helper.calls, []);
});

test("Windows: the size of a tree's job comes from the helper; a closed job is empty", () => {
  const helper = recordingHelper({ "query 900 77": { status: 0, stdout: "3\n" }, "query 901 77": { status: 2 } });
  assert.equal(windowsTreeSize(900, "win32-ft:77", { helperPath: HELPER, runHelper: helper.runHelper }), 3);
  assert.equal(windowsTreeSize(901, "win32-ft:77", { helperPath: HELPER, runHelper: helper.runHelper }), 0);
  assert.equal(windowsTreeSize(901, LSTART, { helperPath: HELPER, runHelper: helper.runHelper }), undefined);
});

test("Windows: a graceful stop sends the stop message, waits, and only then ends the tree", async () => {
  const child = new FakeChild(1000);
  const sent: unknown[] = [];
  child.on("sent", (message) => sent.push(message));
  const helper = recordingHelper({ "info 1000": info(1000, "9"), "kill 1000 9": { status: 0 } });
  const liveTrees = new Map([[1000, { child: child as unknown as ChildProcess, helper: HELPER }]]);
  // The child obeys: no kill at all.
  const stopping = terminateTree(child as unknown as ChildProcess, {
    platform: "win32", graceful: true, graceMs: 5_000, runHelper: helper.runHelper, liveTrees,
    requestStop: () => { child.send({ type: "stop" }); setImmediate(() => child.exit(0)); },
  });
  assert.equal(await stopping, true);
  assert.deepEqual(sent, [{ type: "stop" }]);
  assert.equal(helper.calls.length, 0);

  // The child ignores it: the tree is ended after the grace period.
  const deaf = new FakeChild(1000);
  liveTrees.set(1000, { child: deaf as unknown as ChildProcess, helper: HELPER });
  const started = Date.now();
  const result = terminateTree(deaf as unknown as ChildProcess, {
    platform: "win32", graceful: true, graceMs: 50, killWaitMs: 50, runHelper: (file, args) => {
      const answer = helper.runHelper(file, args);
      if (args[0] === "kill") deaf.exit(1);
      return answer;
    }, liveTrees, requestStop: () => {},
  });
  assert.equal(await result, true);
  assert.ok(Date.now() - started >= 45);
  assert.deepEqual(helper.calls.map(([, args]) => args), [["info", "1000"], ["kill", "1000", "9"]]);
});

test("POSIX: a graceful stop is SIGTERM to the group, then SIGKILL to the group (never the pid alone)", async () => {
  const child = new FakeChild(1100);
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const kill = (pid: number, signal: NodeJS.Signals | 0) => {
    sent.push([pid, signal]);
    if (signal === "SIGTERM") setImmediate(() => child.exit(0));
  };
  assert.equal(await terminateTree(child as unknown as ChildProcess, { platform: "darwin", graceful: true, graceMs: 1_000, kill }), true);
  assert.deepEqual(sent, [[-1100, "SIGTERM"], [-1100, "SIGKILL"]]);
});

test("a recorded birth is evidence only in its own platform's format", () => {
  assert.equal(isBirthEvidence(LSTART, "darwin"), true);
  assert.equal(isBirthEvidence("win32-ft:133752345678901234", "darwin"), false);
  assert.equal(isBirthEvidence("win32-ft:133752345678901234", "win32"), true);
  assert.equal(isBirthEvidence(LSTART, "win32"), false);
  assert.equal(isBirthEvidence("win32-ft:0123", "win32"), false);
  // A FILETIME is an unsigned 64-bit value.
  assert.equal(isBirthEvidence("win32-ft:18446744073709551615", "win32"), true);
  assert.equal(isBirthEvidence("win32-ft:18446744073709551616", "win32"), false);
  assert.equal(isBirthEvidence(null, "win32"), false);
});

test("Windows: the supervisor reads a daemon's identity as ps would show it", () => {
  const read = (pid: number) => pid === 40
    ? { pid, parentPid: 1, creationTime: "123", exited: false, image: "C:\\LetAgents\\LetAgents.exe", commandLine: '"C:\\LetAgents\\LetAgents.exe" "C:\\Program Files\\LetAgents\\resources\\app\\dist-daemon\\main.js"' }
    : pid === 41 ? { pid, parentPid: 1, creationTime: "124", exited: true, image: null, commandLine: "x.exe" } : null;
  assert.deepEqual(defaultInspectDaemonProcess(40, "win32", read), {
    pid: 40,
    kernelStartTime: "win32-ft:123",
    state: "live",
    command: "C:\\LetAgents\\LetAgents.exe C:\\Program Files\\LetAgents\\resources\\app\\dist-daemon\\main.js",
  });
  assert.equal(defaultInspectDaemonProcess(41, "win32", read)?.state, "zombie");
  assert.equal(defaultInspectDaemonProcess(42, "win32", read), null);
});

test("Windows command lines round-trip through Node's quoting and the C runtime's parsing", () => {
  const args = ["plain", "", "two words", 'a "quote"', "trailing\\", "back\\\\slash \\\"", "tab\there", "ünï"];
  assert.deepEqual(parseWindowsCommandLine(windowsCommandLine("C:\\Program Files\\x.exe", args)), ["C:\\Program Files\\x.exe", ...args]);
  assert.equal(quoteWindowsArgument("plain"), "plain");
  assert.equal(quoteWindowsArgument('say "hi"'), '"say \\"hi\\""');
  assert.throws(() => quoteWindowsArgument("nul\0"));
  assert.deepEqual(parseWindowsCommandLine('"C:\\a.exe" "x""y" z'), ["C:\\a.exe", 'x"y', "z"]);
  // The program name toggles quotes anywhere and reads backslashes literally, as the MSVC runtime does.
  assert.deepEqual(parseWindowsCommandLine('"C:\\Program Files"\\node.exe C:\\daemon.js'), ["C:\\Program Files\\node.exe", "C:\\daemon.js"]);
  assert.deepEqual(parseWindowsCommandLine('C:\\a\\"b c"\\x.exe y'), ["C:\\a\\b c\\x.exe", "y"]);
});

test("a failed stop message is not an exit: the tree is still ended after the grace period", async () => {
  const child = new FakeChild(1200);
  const helper = recordingHelper({ "info 1200": info(1200, "8"), "kill 1200 8": { status: 0 } });
  const liveTrees = new Map([[1200, { child: child as unknown as ChildProcess, helper: HELPER }]]);
  const result = await terminateTree(child as unknown as ChildProcess, {
    platform: "win32", graceful: true, graceMs: 20, killWaitMs: 20, liveTrees,
    runHelper: (file, args) => { const answer = helper.runHelper(file, args); if (args[0] === "kill") child.exit(1); return answer; },
    // The IPC channel is gone: Node reports it as an 'error' on the live child, on the next tick.
    requestStop: () => { process.nextTick(() => child.emit("error", Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" }))); },
  });
  assert.equal(result, true);
  assert.deepEqual(helper.calls.map(([, args]) => args), [["info", "1200"], ["kill", "1200", "8"]]);
});

test("Windows: a retired daemon is signalled only through its recorded birth; a refusal reads as ESRCH", () => {
  const calls: Array<[number, string, unknown]> = [];
  const ended = (pid: number, signal: NodeJS.Signals, options?: { identity?: string | null }) => { calls.push([pid, signal, options?.identity]); return "ended" as const; };
  signalDaemonProcess(50, "SIGTERM", "win32-ft:123", "win32", ended);
  assert.deepEqual(calls, [[50, "SIGTERM", "win32-ft:123"]]);
  const refused = () => "none" as const;
  assert.throws(() => signalDaemonProcess(50, "SIGKILL", "win32-ft:124", "win32", refused), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  // Ended, but still there when the helper's wait ran out: not gone, and not "no such process" either.
  const unkillable = () => "unkillable" as const;
  assert.throws(() => signalDaemonProcess(50, "SIGKILL", "win32-ft:123", "win32", unkillable), (error: NodeJS.ErrnoException) => error.code === "EUNKILLABLE");
});

test("Windows: a helper found on disk is used only when its bytes are the sealed build", () => {
  const resourcesPath = "C:\\Program Files\\LetAgents\\resources";
  const other = { seal: SEAL, readFile: () => Buffer.from("MZ another build") };
  // The packaged helper is not the sealed build: refused, as if it were absent, and the reason is kept.
  assert.equal(processTreeHelperPath({ platform: "win32", env: {}, resourcesPath, exists, includeLocalBuild: false, arch: "x64", ...other }), null);
  assert.match(String(processTreeHelperRefusal()), /is not the sealed letagents-process-tree\.exe/);
  // A configured helper that is not sealed is refused too, with no fallback to another one.
  assert.equal(processTreeHelperPath({ platform: "win32", env: { LETAGENTS_PROCESS_TREE_HELPER: HELPER }, resourcesPath, exists, arch: "x64", ...other }), null);
  assert.equal(processTreeHelperPath({ platform: "win32", env: { LETAGENTS_PROCESS_TREE_HELPER: HELPER }, resourcesPath, exists, arch: "x64", ...sealedHelper }), HELPER);
  // An unreadable file, an architecture with no sealed build, or no seal at all: refused.
  const unreadable = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
  assert.equal(processTreeHelperPath({ platform: "win32", env: {}, resourcesPath, exists, includeLocalBuild: false, arch: "x64", seal: SEAL, readFile: unreadable }), null);
  assert.equal(processTreeHelperPath({ platform: "win32", env: {}, resourcesPath, exists, includeLocalBuild: false, arch: "arm64", ...sealedHelper }), null);
  assert.match(String(processTreeHelperRefusal()), /No arm64 build/);
  assert.equal(processTreeHelperPath({ platform: "win32", env: {}, resourcesPath, exists, includeLocalBuild: false, arch: "x64", seal: null, readFile: () => SEALED_BYTES }), null);
  // The committed seal is the one the app checks against.
  const committed = JSON.parse(readFileSync(new URL("../../../../shared/letagents-process-tree.seal.json", import.meta.url), "utf8"));
  assert.equal(sealedProcessTreeHelperSha256("x64"), committed.builds.x64.sha256);
  assert.match(String(sealedProcessTreeHelperSha256("x64")), /^[0-9a-f]{64}$/);
});

test("Windows: the helper's bytes are read again on every use, so an edit in place is refused", () => {
  const folder = mkdtempSync(join(tmpdir(), "letagents-helper-seal-"));
  try {
    const file = join(folder, "letagents-process-tree.exe");
    writeFileSync(file, SEALED_BYTES);
    const options = { platform: "win32" as const, env: { LETAGENTS_PROCESS_TREE_HELPER: file }, arch: "x64", seal: SEAL };
    assert.equal(processTreeHelperPath(options), file);
    // Same size, same file, its time put back: still not the sealed bytes.
    const { atime, mtime } = statSync(file);
    const edited = Buffer.from(SEALED_BYTES);
    edited[edited.length - 1] ^= 1;
    writeFileSync(file, edited);
    utimesSync(file, atime, mtime);
    assert.equal(processTreeHelperPath(options), null);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("Windows: a tree still there when the helper's bounded wait ran out is unkillable, not ended and not an error", () => {
  // 4: the helper ended the job (or the one process), but processes remained when its wait ran out.
  const helper = recordingHelper({ "kill 1400 133752345678901234": { status: 4 } });
  const options = { platform: "win32" as const, helperPath: HELPER, runHelper: helper.runHelper, liveTrees: new Map(), identity: "win32-ft:133752345678901234" };
  assert.equal(signalTreeOutcome(1400, "SIGKILL", options), "unkillable");
  assert.equal(signalTree(1400, "SIGKILL", options), false);

  // A tree this process holds: the helper process is left to report it with its exit code, not killed.
  const child = new FakeChild(1401);
  const held = recordingHelper({ "info 1401": info(1401, "21"), "kill 1401 21": { status: 4 } });
  const liveTrees = new Map([[1401, { child: child as unknown as ChildProcess, helper: HELPER }]]);
  assert.equal(signalTreeOutcome(1401, "SIGTERM", { platform: "win32", runHelper: held.runHelper, liveTrees }), "unkillable");
  assert.deepEqual(child.kills, []);

});

test("Windows: the helper's wait bound is passed on only when a caller names one", () => {
  const helper = recordingHelper({ kill: { status: 0 } });
  const options = { platform: "win32" as const, helperPath: HELPER, runHelper: helper.runHelper, liveTrees: new Map(), identity: "win32-ft:133752345678901234" };
  signalTree(1500, "SIGKILL", options);
  signalTree(1500, "SIGKILL", { ...options, unkillableAfterMs: 0 });
  assert.deepEqual(helper.calls.map(([, args]) => args), [["kill", "1500", "133752345678901234"], ["kill", "1500", "133752345678901234", "0"]]);
  assert.throws(() => signalTree(1500, "SIGKILL", { ...options, unkillableAfterMs: -1 }), RangeError);
  assert.throws(() => signalTree(1500, "SIGKILL", { ...options, unkillableAfterMs: 600_001 }), RangeError);

  const spawned = recordingSpawn(1600);
  spawnTree("git", ["status"], {}, { platform: "win32", env: windowsEnv, exists, helperPath: HELPER, spawn: spawned.spawn, unkillableAfterMs: 2_500 });
  assert.deepEqual(spawned.calls[0]!.args.slice(-1), ["2500"]);
  const plain = recordingSpawn(1700);
  spawnTree("git", ["status"], {}, { platform: "win32", env: windowsEnv, exists, helperPath: HELPER, spawn: plain.spawn });
  assert.equal(plain.calls[0]!.args.length, 3);
});

test("Windows: terminateTreeOutcome names an unkillable tree; terminateTree resolves false for it", async () => {
  // The kill reports unkillable; the helper process exits later with its unkillable code.
  const child = new FakeChild(1800);
  const helper = recordingHelper({ "info 1800": info(1800, "31"), "kill 1800 31": { status: 4 } });
  const liveTrees = new Map([[1800, { child: child as unknown as ChildProcess, helper: HELPER }]]);
  const outcome = terminateTreeOutcome(child as unknown as ChildProcess, {
    platform: "win32", killWaitMs: 50, liveTrees,
    runHelper: (file, args) => {
      const answer = helper.runHelper(file, args);
      if (args[0] === "kill") setImmediate(() => child.exit(PROCESS_TREE_UNKILLABLE_EXIT_CODE));
      return answer;
    },
  });
  assert.equal(await outcome, "unkillable");
  assert.deepEqual(child.kills, []);
  // The answer stays for this child, whatever exit code its helper reports later.
  const later = new FakeChild(1804);
  const laterHelper = recordingHelper({ "info 1804": info(1804, "51"), "kill 1804 51": { status: 4 } });
  liveTrees.set(1804, { child: later as unknown as ChildProcess, helper: HELPER });
  assert.equal(signalTreeOutcome(1804, "SIGKILL", { platform: "win32", runHelper: laterHelper.runHelper, liveTrees }), "unkillable");
  later.exit(1);
  assert.equal(await terminateTreeOutcome(later as unknown as ChildProcess, { platform: "win32", liveTrees }), "unkillable");
  assert.equal(await terminateTree(later as unknown as ChildProcess, { platform: "win32", liveTrees }), false);

  // The program obeyed the stop message, but what it left behind could not be ended: the helper says so.
  const obeys = new FakeChild(1801);
  liveTrees.set(1801, { child: obeys as unknown as ChildProcess, helper: HELPER });
  assert.equal(await terminateTree(obeys as unknown as ChildProcess, {
    platform: "win32", graceful: true, graceMs: 1_000, liveTrees, runHelper: recordingHelper({}).runHelper,
    requestStop: () => setImmediate(() => obeys.exit(PROCESS_TREE_UNKILLABLE_EXIT_CODE)),
  }), false);
  assert.equal(await terminateTreeOutcome(obeys as unknown as ChildProcess, { platform: "win32", liveTrees }), "unkillable");

  // The same when the birth could not be read and the recorded one decided the kill.
  const unread = new FakeChild(1805);
  liveTrees.set(1805, { child: unread as unknown as ChildProcess, helper: HELPER });
  const byRecord = recordingHelper({ "info 1805": { status: 121 }, "kill 1805 61": { status: 4 } });
  assert.equal(signalTreeOutcome(1805, "SIGKILL", { platform: "win32", runHelper: byRecord.runHelper, liveTrees, identity: "win32-ft:61", probe: () => {} }), "unkillable");
  unread.exit(0);
  assert.equal(await terminateTreeOutcome(unread as unknown as ChildProcess, { platform: "win32", liveTrees }), "unkillable");

  // A child that never exits is "running"; a normal exit is "exited".
  const stuck = new FakeChild(1802);
  liveTrees.set(1802, { child: stuck as unknown as ChildProcess, helper: HELPER });
  const answered = recordingHelper({ "info 1802": info(1802, "41"), "kill 1802 41": { status: 0 } });
  assert.equal(await terminateTreeOutcome(stuck as unknown as ChildProcess, { platform: "win32", killWaitMs: 20, liveTrees, runHelper: answered.runHelper }), "running");
  stuck.exit(1);
  assert.equal(await terminateTreeOutcome(stuck as unknown as ChildProcess, { platform: "win32", liveTrees }), "exited");
  // POSIX has no unkillable outcome: the same exit code there is the program's own.
  const posix = new FakeChild(1803);
  posix.exit(PROCESS_TREE_UNKILLABLE_EXIT_CODE);
  assert.equal(await terminateTreeOutcome(posix as unknown as ChildProcess, { platform: "darwin", kill: () => {} }), "exited");
});

test("Windows: a pid reused by another tree of ours is not ended for a caller whose own child exited, or whose birth differs", () => {
  // Tree B now holds pid 1300; the caller's child A (same pid number) has exited.
  const treeB = new FakeChild(1300);
  const childA = new FakeChild(1300);
  childA.exit(0);
  const helper = recordingHelper({ "info 1300": info(1300, "99"), "kill 1300 99": { status: 0 }, "kill 1300 11": { status: 2 } });
  const liveTrees = new Map([[1300, { child: treeB as unknown as ChildProcess, helper: HELPER }]]);
  const options = { platform: "win32" as const, runHelper: helper.runHelper, liveTrees, helperPath: HELPER };
  assert.equal(signalTree(1300, "SIGKILL", { ...options, child: childA as unknown as ChildProcess }), false);
  assert.equal(signalTree(1300, "SIGKILL", { ...options, child: childA as unknown as ChildProcess, identity: "win32-ft:11" }), false);
  // A pid-only caller with A's recorded birth: B's birth differs, so B is not ended.
  assert.equal(signalTree(1300, "SIGKILL", { ...options, identity: "win32-ft:11" }), false);
  assert.deepEqual(treeB.kills, []);
  assert.equal(helper.calls.some(([, args]) => args.join(" ") === "kill 1300 99"), false);
  // B's own birth still ends B.
  assert.equal(signalTree(1300, "SIGKILL", { ...options, identity: "win32-ft:99" }), true);
});

test("Windows: a recorded birth that cannot be proved never ends a tree found only by its pid", () => {
  // B (a helper tree) holds the pid, but its birth cannot be read now.
  const treeB = new FakeChild(1400);
  const unreadable = recordingHelper({ "info 1400": { status: 3 }, "kill 1400 11": { status: 2 }, "kill 1400 99": { status: 0 } });
  const helperTrees = new Map([[1400, { child: treeB as unknown as ChildProcess, helper: HELPER }]]);
  // The helper's own check of the recorded birth decides, and refuses A's.
  assert.equal(signalTree(1400, "SIGKILL", { platform: "win32", runHelper: unreadable.runHelper, liveTrees: helperTrees, identity: "win32-ft:11", probe: () => {} }), false);
  // B's own recorded birth still ends B through that check.
  assert.equal(signalTree(1400, "SIGKILL", { platform: "win32", runHelper: unreadable.runHelper, liveTrees: helperTrees, identity: "win32-ft:99", probe: () => {} }), true);
  assert.deepEqual(unreadable.calls.filter(([, args]) => args[0] === "kill").map(([, args]) => args), [["kill", "1400", "11"], ["kill", "1400", "99"]]);
  // C was spawned without the helper, so nothing can read its birth.
  const treeC = new FakeChild(1401);
  const directTrees = new Map([[1401, { child: treeC as unknown as ChildProcess, helper: null as unknown as string }]]);
  assert.equal(signalTree(1401, "SIGKILL", { platform: "win32", liveTrees: directTrees, helperPath: null, identity: "win32-ft:11", probe: () => {} }), false);
  assert.deepEqual(treeB.kills, []);
  assert.deepEqual(treeC.kills, []);
  // Without a recorded birth, a held tree is still ended as before.
  assert.equal(signalTree(1401, "SIGKILL", { platform: "win32", liveTrees: directTrees, helperPath: null }), true);
  assert.deepEqual(treeC.kills, [undefined]);
});

test("Windows: a kill that is still waiting for the job to empty is not replaced by a kill of the helper alone", () => {
  const child = new FakeChild(1500);
  const liveTrees = new Map([[1500, { child: child as unknown as ChildProcess, helper: HELPER }]]);
  const runHelper = (_file: string, args: string[]) => args[0] === "info"
    ? info(1500, "7")
    : { status: null as unknown as number, stdout: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };
  assert.equal(signalTree(1500, "SIGKILL", { platform: "win32", runHelper, liveTrees }), true);
  assert.deepEqual(child.kills, []);
});

test("an exited child gets no stop request (its failure could only arrive after the call)", async () => {
  const child = new FakeChild(1600);
  child.exit(0);
  let asked = false;
  assert.equal(await terminateTree(child as unknown as ChildProcess, { platform: "win32", graceful: true, requestStop: () => { asked = true; } }), true);
  assert.equal(asked, false);
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  assert.equal(await terminateTree(child as unknown as ChildProcess, { platform: "darwin", graceful: true, kill: (pid, signal) => { sent.push([pid, signal]); } }), true);
  assert.deepEqual(sent, [[-1600, "SIGKILL"]]);
});
