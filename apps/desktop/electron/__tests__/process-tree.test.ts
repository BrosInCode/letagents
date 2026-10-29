// shared/process-tree.mjs with the platform injected: every Windows branch
// runs here on any host, against a recorded helper. The real helper is proved
// on Windows by apps/desktop/native/win-process-tree/process-tree.windows.test.mjs.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import test from "node:test";

import {
  isBirthEvidence,
  parseWindowsCommandLine,
  processBirth,
  processTreeHelperPath,
  quoteWindowsArgument,
  resolveWindowsCommand,
  signalTree,
  spawnTree,
  terminateTree,
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
  assert.equal(processTreeHelperPath({ platform: "win32", env: { LETAGENTS_PROCESS_TREE_HELPER: HELPER }, exists }), HELPER);
  // A configured helper that is missing is not replaced by another.
  assert.equal(processTreeHelperPath({ platform: "win32", env: { LETAGENTS_PROCESS_TREE_HELPER: "C:\\gone.exe" }, resourcesPath: "C:\\Program Files\\LetAgents\\resources", exists }), null);
  assert.equal(processTreeHelperPath({ platform: "win32", env: {}, resourcesPath: "C:\\Program Files\\LetAgents\\resources", exists, includeLocalBuild: false }), HELPER);
  assert.equal(processTreeHelperPath({ platform: "win32", env: {}, resourcesPath: "", exists, includeLocalBuild: false }), null);
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
  const ended = (pid: number, signal: NodeJS.Signals, options?: { identity?: string | null }) => { calls.push([pid, signal, options?.identity]); return true; };
  signalDaemonProcess(50, "SIGTERM", "win32-ft:123", "win32", ended);
  assert.deepEqual(calls, [[50, "SIGTERM", "win32-ft:123"]]);
  const refused = () => false;
  assert.throws(() => signalDaemonProcess(50, "SIGKILL", "win32-ft:124", "win32", refused), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
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
