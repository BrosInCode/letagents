// How Claude Code, Codex and OpenCode are started on Windows: the provider
// program resolver, the environment allowlist and shadow profile, and the
// daemon state folder a worker is told. The platform is injected, so every
// Windows branch runs here on any host; the real-Windows effects (junctions,
// hard links, the read-only rules folder) are in codex-agent-home-windows.test.ts.
import "./isolated-home.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess, ExecFileOptions, SpawnOptions } from "node:child_process";
import test from "node:test";

import { execProviderFile, ProviderBatchFileError, providerLaunchCommand } from "../../../../shared/provider-executable.mjs";
import { parseWindowsCommandLine, spawnTree, windowsCommandLine } from "../../../../shared/process-tree.mjs";
import { daemonEndpoint } from "../../../../shared/daemon-endpoint.mjs";
import {
  daemonStateDirEnvironment,
  environmentValue,
  shadowProfileEnvironment,
  windowsSystemEnvironment,
} from "../main/agents/windows-child-environment.js";
import { minimalOpenCodeEnvironment } from "../main/agents/opencode-launch-contract.js";
import { openCodeMcpLaunch } from "../main/agents/open-model/adapter-launch.js";
import { windowsCodexArguments } from "../main/agents/codex-home-harness.js";
import { providerTreeExit } from "../main/agents/provider-evidence.js";
import { rentalIsolatedChildEnvironment } from "../main/agents/rental-child-environment.js";
import { icaclsReadOnlyFolderArguments, sddlIsReadOnlyFolderFor } from "../main/agents/codex-agent-home.js";
import { cursorWindowsProgram } from "../main/agents/cursor/windows-turn.js";
import { buildCursorChildEnv } from "../main/agents/cursor-runner.js";

const ELECTRON = "C:\\Program Files\\LetAgents\\LetAgents.exe";
const SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  "IF EXIST \"%dp0%\\node.exe\" (",
  "  SET \"_prog=%dp0%\\node.exe\"",
  ") ELSE (",
  "  SET \"_prog=node\"",
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*",
  "",
].join("\r\n");
const windowsEnv = { Path: "C:\\npm;C:\\Windows\\System32", PATHEXT: ".COM;.EXE;.BAT;.CMD", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
const shimLaunch = (files: Set<string>, electron: boolean) => providerLaunchCommand("claude", ["--version"], {
  platform: "win32", env: windowsEnv, exists: (file: string) => files.has(file), electron,
  launchOptions: { execPath: ELECTRON, readFile: () => SHIM, exists: (file: string) => files.has(file) },
});

test("POSIX: a provider program is started exactly as named, and its checks run as plain execFile", () => {
  assert.deepEqual(providerLaunchCommand("claude", ["--version"], { platform: "darwin" }),
    { file: "claude", args: ["--version"], resolved: "claude", envAdditions: null });
  const calls: Array<[string, readonly string[], ExecFileOptions]> = [];
  const options = { timeout: 5, env: { PATH: "/usr/bin" } };
  execProviderFile("claude", ["--version"], options, () => {}, {
    platform: "linux",
    execFile: (file, args, given) => { calls.push([file, args, given]); return new EventEmitter() as ChildProcess; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], "claude");
  assert.deepEqual(calls[0]![1], ["--version"]);
  assert.equal(calls[0]![2], options, "the caller's own options object, unchanged");
});

test("Windows: an npm shim runs its script on this Electron only with ELECTRON_RUN_AS_NODE, and on a node.exe beside it without", () => {
  const onElectron = shimLaunch(new Set(["C:\\npm\\claude.cmd"]), true);
  assert.equal(onElectron.resolved, "C:\\npm\\claude.cmd");
  assert.equal(onElectron.file, ELECTRON);
  assert.deepEqual(onElectron.args, ["C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js", "--version"]);
  assert.deepEqual(onElectron.envAdditions, { ELECTRON_RUN_AS_NODE: "1" });

  const besideNode = shimLaunch(new Set(["C:\\npm\\claude.cmd", "C:\\npm\\node.exe"]), true);
  assert.equal(besideNode.file, "C:\\npm\\node.exe");
  assert.equal(besideNode.envAdditions, null);

  // Under plain Node, process.execPath is a real node: nothing to add.
  assert.equal(shimLaunch(new Set(["C:\\npm\\claude.cmd"]), false).envAdditions, null);

  // A native program is started as it is.
  const native = providerLaunchCommand("claude", [], { platform: "win32", env: windowsEnv, exists: (file) => file === "C:\\npm\\claude.exe", electron: true });
  assert.deepEqual(native, { file: "C:\\npm\\claude.exe", args: [], resolved: "C:\\npm\\claude.exe", envAdditions: null });
});

test("Windows: a provider check runs the shim's script with no console window and the Electron variable added", () => {
  const calls: Array<[string, readonly string[], ExecFileOptions]> = [];
  execProviderFile("claude", ["--version"], { timeout: 5, env: windowsEnv }, () => {}, {
    platform: "win32", electron: true, exists: (file) => file === "C:\\npm\\claude.cmd",
    launchOptions: { execPath: ELECTRON, readFile: () => SHIM, exists: () => false },
    execFile: (file, args, given) => { calls.push([file, args, given]); return new EventEmitter() as ChildProcess; },
  });
  assert.equal(calls[0]![0], ELECTRON);
  assert.deepEqual(calls[0]![1], ["C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js", "--version"]);
  assert.equal(calls[0]![2].windowsHide, true);
  assert.equal(calls[0]![2].timeout, 5);
  assert.deepEqual(calls[0]![2].env, { ...windowsEnv, ELECTRON_RUN_AS_NODE: "1" });
});

test("Windows: spawnTree gives the Electron variable to the shim's script, through the helper and without it", () => {
  const calls: Array<{ command: string; options: SpawnOptions }> = [];
  const spawn = (command: string, _args: readonly string[], options: SpawnOptions) => {
    calls.push({ command, options });
    return Object.assign(new EventEmitter(), { pid: undefined }) as unknown as ChildProcess;
  };
  const treeOptions = {
    platform: "win32" as const, electron: true, spawn, exists: (file: string) => file === "C:\\npm\\claude.cmd",
    launchOptions: { execPath: ELECTRON, readFile: () => SHIM, exists: () => false },
  };
  spawnTree("claude", ["-p"], { env: windowsEnv }, { ...treeOptions, helperPath: "C:\\helper.exe" });
  spawnTree("claude", ["-p"], { env: windowsEnv }, { ...treeOptions, helperPath: null });
  assert.equal(calls[0]!.command, "C:\\helper.exe");
  assert.equal(calls[1]!.command, ELECTRON);
  for (const call of calls) assert.deepEqual(call.options.env, { ...windowsEnv, ELECTRON_RUN_AS_NODE: "1" });
  // A program that is no shim keeps the caller's environment object.
  calls.length = 0;
  spawnTree("claude", [], { env: windowsEnv }, { ...treeOptions, exists: (file: string) => file === "C:\\npm\\claude.exe", helperPath: null });
  assert.equal(calls[0]!.options.env, windowsEnv);
});

test("the Windows system variables are kept under their usual names, matched without case, and none is added off Windows", () => {
  const source = { Path: "C:\\bin", systemroot: "C:\\Windows", COMSPEC: "C:\\Windows\\System32\\cmd.exe", TEMP: "C:\\t", LETAGENTS_TOKEN: "secret", USERPROFILE: "C:\\Users\\a" };
  assert.deepEqual(windowsSystemEnvironment(source, "win32"), {
    SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", TEMP: "C:\\t", USERPROFILE: "C:\\Users\\a",
  });
  assert.deepEqual(windowsSystemEnvironment(source, "darwin"), {});
  assert.equal(environmentValue(source, "PATH", "win32"), "C:\\bin");
  assert.equal(environmentValue(source, "PATH", "linux"), undefined);
});

test("a shadow profile points every name of the user's home at one folder; POSIX keeps HOME and TMPDIR only", () => {
  assert.deepEqual(shadowProfileEnvironment("/var/check", "darwin"), { HOME: "/var/check", TMPDIR: "/var/check" });
  assert.deepEqual(shadowProfileEnvironment("C:\\Users\\a\\.letagents\\check", "win32"), {
    HOME: "C:\\Users\\a\\.letagents\\check",
    TMPDIR: "C:\\Users\\a\\.letagents\\check",
    USERPROFILE: "C:\\Users\\a\\.letagents\\check",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\a\\.letagents\\check",
    APPDATA: "C:\\Users\\a\\.letagents\\check",
    LOCALAPPDATA: "C:\\Users\\a\\.letagents\\check",
    TEMP: "C:\\Users\\a\\.letagents\\check",
    TMP: "C:\\Users\\a\\.letagents\\check",
  });
});

test("an OpenCode runtime and a rental keep what Windows needs, and no token, on Windows only", () => {
  const source = { Path: "C:\\bin", SystemRoot: "C:\\Windows", APPDATA: "C:\\Users\\a\\AppData\\Roaming", LETAGENTS_TOKEN: "secret", OPENAI_API_KEY: "key" };
  const openCode = minimalOpenCodeEnvironment(source, {}, {}, "win32");
  assert.equal(openCode.PATH, "C:\\bin");
  assert.equal(openCode.SystemRoot, "C:\\Windows");
  assert.equal(openCode.APPDATA, "C:\\Users\\a\\AppData\\Roaming");
  assert.equal(openCode.LETAGENTS_TOKEN, undefined);
  assert.equal(openCode.OPENAI_API_KEY, undefined);
  const posix = minimalOpenCodeEnvironment(source, {}, {}, "darwin");
  assert.equal(posix.PATH, undefined, "POSIX reads PATH by its exact name, as before");
  assert.equal(posix.SystemRoot, undefined);

  assert.deepEqual(rentalIsolatedChildEnvironment(source, "win32"), { Path: "C:\\bin", SystemRoot: "C:\\Windows", APPDATA: "C:\\Users\\a\\AppData\\Roaming" });
  assert.deepEqual(rentalIsolatedChildEnvironment(source, "linux"), {});
});

test("Windows: a worker is told the daemon's state folder for the daemon's own pipe, and nothing for anything else", () => {
  const stateDir = "C:\\Users\\a\\.letagents";
  const pipe = daemonEndpoint(stateDir, { platform: "win32", account: "a" }).connectPath;
  assert.deepEqual(daemonStateDirEnvironment(pipe, "win32"), { LETAGENTS_SUPERVISOR_DAEMON_STATE_DIR: stateDir });
  assert.deepEqual(daemonStateDirEnvironment(pipe, "darwin"), {});
  assert.deepEqual(daemonStateDirEnvironment("/tmp/daemon.sock", "win32"), {});
  assert.deepEqual(daemonStateDirEnvironment(undefined, "win32"), {});
});

test("the read-only rules folder lets the account list and read it, change it back, and save nothing", () => {
  const sid = "S-1-5-21-1-2-3-1001";
  const args = icaclsReadOnlyFolderArguments("C:\\Users\\a\\.letagents\\codex-agent-home\\rules", sid);
  assert.equal(args[0], "C:\\Users\\a\\.letagents\\codex-agent-home\\rules");
  assert.ok(args.includes("/inheritance:r"));
  const grants = args.slice(args.indexOf("/grant:r") + 1, -1);
  assert.deepEqual(grants, [`*${sid}:(OI)(CI)(RD,REA,X,RA,RC,S,WDAC,WO)`, "*S-1-5-18:(OI)(CI)F"]);
  assert.ok(!/\b(?:W|WD|AD|M|F)\b/.test(grants[0]!.split(":")[1]!.replace(/\(OI\)\(CI\)/, "")), "no right to write or add");
  assert.throws(() => icaclsReadOnlyFolderArguments("C:\\x", "Everyone"));
});

test("Windows: a batch file that is no npm shim is refused, never handed to cmd.exe, unless the caller allows it", () => {
  const batch = (allowCmd?: boolean) => providerLaunchCommand("sometool", ["-p", "line one\nline \"two\""], {
    platform: "win32", env: windowsEnv, exists: (file) => file === "C:\\npm\\sometool.cmd", allowCmd,
    launchOptions: { execPath: ELECTRON, readFile: () => "@echo off\r\nC:\\tools\\agent.exe %*\r\n", exists: () => false },
  });
  assert.throws(() => batch(), (error: Error & { code?: string }) => error.code === "EPROVIDERBATCH" && !error.message.includes("line one"));
  assert.throws(() => batch(false), ProviderBatchFileError);
  // spawnTree's earlier path for such a file: cmd.exe, which itself refuses a quote or a line break.
  assert.throws(() => batch(true), /cannot pass an argument with a line break/);
  const plain = providerLaunchCommand("sometool", ["-p", "hello"], {
    platform: "win32", env: windowsEnv, exists: (file) => file === "C:\\npm\\sometool.cmd", allowCmd: true,
    launchOptions: { execPath: ELECTRON, readFile: () => "@echo off\r\nC:\\tools\\agent.exe %*\r\n", exists: () => false },
  });
  assert.equal(plain.windowsVerbatimArguments, true);
  assert.equal(plain.envAdditions, null);
});

test("Windows: a program that is on no PATH entry is never looked for in the working directory", () => {
  const missing = providerLaunchCommand("claude", ["--version"], { platform: "win32", env: windowsEnv, cwd: "C:\\repo", exists: () => false });
  assert.equal(missing.resolved, null);
  assert.equal(missing.file, "C:\\Windows\\letagents-not-on-path\\claude");
  assert.deepEqual(missing.args, ["--version"]);
  // A missing batch name too: ENOENT, never a cmd.exe error.
  const missingShim = providerLaunchCommand("claude.cmd", [], { platform: "win32", env: windowsEnv, exists: () => false, allowCmd: true });
  assert.deepEqual(missingShim, { file: "C:\\Windows\\letagents-not-on-path\\claude.cmd", args: [], resolved: null, envAdditions: null });
  // A path the caller gave keeps its meaning.
  assert.equal(providerLaunchCommand(".\\bin\\claude.exe", [], { platform: "win32", env: windowsEnv, cwd: "C:\\repo", exists: () => false }).file, ".\\bin\\claude.exe");
});

test("the read-only rules folder is accepted only as exactly the account's read-only entry and SYSTEM", () => {
  const sid = "S-1-5-21-1-2-3-1001";
  const readOnly = `O:${sid}G:${sid}D:PAI(A;OICI;FA;;;SY)(A;OICI;0x1e00a9;;;${sid})`;
  assert.equal(sddlIsReadOnlyFolderFor(readOnly, sid), true);
  assert.equal(sddlIsReadOnlyFolderFor(readOnly.replace("0x1e00a9", "0x1f01ff"), sid), false, "full access");
  assert.equal(sddlIsReadOnlyFolderFor(readOnly.replace("0x1e00a9", "0x1e00ab"), sid), false, "add a file");
  assert.equal(sddlIsReadOnlyFolderFor(readOnly.replace("0x1e00a9", "FR"), sid), false, "a right that is not a number is not read");
  assert.equal(sddlIsReadOnlyFolderFor(readOnly.replace("D:PAI", "D:AI"), sid), false, "inheritance on");
  assert.equal(sddlIsReadOnlyFolderFor(`${readOnly}(A;OICI;0x1200a9;;;S-1-5-5-0-123)`, sid), false, "a logon session's entry");
  assert.equal(sddlIsReadOnlyFolderFor(readOnly.replace(`O:${sid}`, "O:BA"), sid), false, "owned by Administrators");
  assert.equal(sddlIsReadOnlyFolderFor(`${readOnly}(D;OICI;FA;;;WD)`, sid), true, "a deny entry only takes away");
  assert.equal(sddlIsReadOnlyFolderFor(null, sid), false);
  assert.equal(sddlIsReadOnlyFolderFor(readOnly.replace(sid + ")", "LA)"), { sid, aliases: ["LA"] }), true, "the account by its alias");
});

test("an object allow entry of the account is held to the same read-only rights", () => {
  const sid = "S-1-5-21-1-2-3-1001";
  const base = `O:${sid}G:${sid}D:PAI(A;OICI;FA;;;SY)(A;OICI;0x1e00a9;;;${sid})`;
  assert.equal(sddlIsReadOnlyFolderFor(`${base}(OA;OICI;0x1e00a9;;;${sid})`, sid), true);
  assert.equal(sddlIsReadOnlyFolderFor(`${base}(OA;OICI;0x1f01ff;;;${sid})`, sid), false);
});

test("Cursor on Windows takes its program from the shared resolver: no cmd.exe, no shim on Electron, and a missing one named", () => {
  const at = (files: string[]) => (file: string) => files.includes(file);
  const shim = SHIM.replace("@anthropic-ai\\claude-code\\cli.js", "cursor-agent\\index.js");
  const native = cursorWindowsProgram("cursor-agent", { env: windowsEnv, exists: at(["C:\\npm\\cursor-agent.exe"]) });
  assert.deepEqual(native, { file: "C:\\npm\\cursor-agent.exe", args: [], environment: {} });
  const besideNode = cursorWindowsProgram("cursor-agent", {
    env: windowsEnv, exists: at(["C:\\npm\\cursor-agent.cmd"]), electron: true,
    launchOptions: { execPath: ELECTRON, readFile: () => shim, exists: at(["C:\\npm\\node.exe"]) },
  });
  assert.deepEqual(besideNode, { file: "C:\\npm\\node.exe", args: ["C:\\npm\\node_modules\\cursor-agent\\index.js"], environment: {} });
  assert.throws(() => cursorWindowsProgram("cursor-agent", {
    env: windowsEnv, exists: at(["C:\\npm\\cursor-agent.cmd"]), electron: true,
    launchOptions: { execPath: ELECTRON, readFile: () => shim, exists: () => false },
  }), /runs Node\.js, and no node\.exe is beside it/);
  assert.throws(() => cursorWindowsProgram("sometool", {
    env: windowsEnv, exists: at(["C:\\npm\\sometool.cmd"]),
    launchOptions: { execPath: ELECTRON, readFile: () => "@echo off\r\nC:\\tools\\agent.exe %*\r\n", exists: () => false },
  }), /C:\\npm\\sometool\.cmd is a batch file that only cmd\.exe can run/);
  assert.throws(() => cursorWindowsProgram("cursor-agent", { env: windowsEnv, exists: () => false }), /'cursor-agent' was not found on this computer/);
});

test("Cursor's environment keeps ComSpec and windir as Windows spells them, and still nothing outside its allowlist", () => {
  const overrides = { ComSpec: "C:\\Windows\\System32\\cmd.exe", windir: "C:\\Windows", LETAGENTS_TOKEN: "secret" };
  // Each half names its platform, so the test means the same on every host.
  const as = (value: NodeJS.Platform) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value });
    try {
      return buildCursorChildEnv(overrides);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  };
  const windows = as("win32");
  assert.equal(windows.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(windows.windir, "C:\\Windows");
  assert.equal(windows.LETAGENTS_TOKEN, undefined);
  const posix = as("darwin");
  assert.equal(posix.ComSpec, undefined, "POSIX matches names exactly, as before");
  assert.equal(posix.windir, undefined);
});

test("Windows: a missing program named by path is ENOENT as it is, never a batch-file refusal", () => {
  const missing = providerLaunchCommand("C:\\x\\agent.cmd", ["-p", "line\n\"two\""], { platform: "win32", env: windowsEnv, exists: () => false });
  assert.deepEqual(missing, { file: "C:\\x\\agent.cmd", args: ["-p", "line\n\"two\""], resolved: null, envAdditions: null });
  assert.throws(() => cursorWindowsProgram("C:\\x\\agent.cmd", { env: windowsEnv, exists: () => false }), /'C:\\x\\agent\.cmd' was not found on this computer/);
});

test("Open Model's MCP server is the sealed runtime on Windows, and macOS keeps npx", () => {
  const runtime = { entryPath: "C:\\LetAgents\\resources\\app\\runtime\\letagents\\node_modules\\letagents\\dist\\mcp\\server.js", readRoots: [] };
  assert.deepEqual(openCodeMcpLaunch(undefined, "win32", () => runtime), {
    command: [process.execPath, runtime.entryPath],
    environment: { ELECTRON_RUN_AS_NODE: "1" },
  });
  assert.throws(() => openCodeMcpLaunch(undefined, "win32", () => { throw new Error("no runtime"); }), /no runtime/);
  assert.deepEqual(openCodeMcpLaunch(undefined, "darwin", () => assert.fail("macOS does not read the runtime")).command.slice(0, 2), ["npx", "-y"]);
  assert.deepEqual(openCodeMcpLaunch("/dev/entry.js", "win32", () => assert.fail("a development entry wins")), {
    command: [process.execPath, "/dev/entry.js"],
    environment: {},
  });
});

test("a Windows Codex's own arguments are read through the helper that started it", () => {
  const codex = windowsCommandLine("C:\\app\\LetAgents.exe", ["C:\\npm\\codex.js", "app-server", "-c", 'mcp_servers={ "github" = { enabled = false } }']);
  const helper = windowsCommandLine("C:\\app\\letagents-process-tree.exe", ["spawn", "C:\\app\\LetAgents.exe", codex]);
  assert.deepEqual(windowsCodexArguments(helper), parseWindowsCommandLine(codex));
  assert.match(windowsCodexArguments(helper).join(" "), /mcp_servers=\{ "github" = \{ enabled = false \} \}/);
  assert.deepEqual(windowsCodexArguments(codex), parseWindowsCommandLine(codex));
});

test("the helper's unkillable exit is no exit of the provider's", () => {
  const unkillable = providerTreeExit("Codex", 0xE04C5401, null);
  assert.equal(unkillable.type, "error");
  assert.match(unkillable.type === "error" ? unkillable.error.message : "", /Codex's processes did not end/);
  assert.deepEqual(providerTreeExit("Codex", 1, null), { type: "exit", code: 1, signal: null });
  assert.deepEqual(providerTreeExit("Codex", null, "SIGKILL"), { type: "exit", code: null, signal: "SIGKILL" });
});
