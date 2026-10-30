// The two provider installs whose entry point on Windows is a batch file with
// no script shim behind it: OpenCode's npm shim of a native program, and
// Cursor's official launcher. The fixtures are the real files of opencode-ai
// 1.18.20 and cursor-agent 2026.10.22-27dcf5f. The first part runs on any
// host, over a small in-memory disk; the second uses real junctions and starts
// real processes, so it runs on Windows only.
import "./isolated-home.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { ChildProcess, ExecFileOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import test from "node:test";

import { execProviderFile, ProviderBatchFileError, ProviderInstallError, providerLaunchCommand } from "../../../../shared/provider-executable.mjs";
import { spawnTree } from "../../../../shared/process-tree.mjs";
import { cursorWindowsNativeLaunch, cursorWindowsProgram } from "../main/agents/cursor/windows-turn.js";

const windowsOnly = { skip: process.platform === "win32" ? false : "needs Windows" };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/windows-provider-installs/${name}`, import.meta.url), "utf8")
  .replace(/\r?\n/g, "\r\n");
const OPENCODE_CMD = fixture("opencode.cmd.txt");
const CURSOR_CMD = fixture("root-cursor-agent.cmd.txt");
const CURSOR_PS1 = fixture("root-cursor-agent.ps1.txt");
const VERSIONED_CMD = fixture("versioned-cursor-agent.cmd.txt");
const VERSIONED_PS1 = fixture("versioned-cursor-agent.ps1.txt");
const REFUSED = (pattern: RegExp) => (error: Error & { code?: string }) => error instanceof ProviderInstallError
  && error.code === "EPROVIDERINSTALL" && pattern.test(error.message);

/** A little Windows disk: files with their text, folders, and links as `path -> real path`. */
class Disk {
  files = new Map<string, string>();
  folders = new Set<string>();
  links = new Map<string, string>();

  file(path: string, text = "") {
    this.files.set(path, text);
    for (let folder = win32.dirname(path); !this.folders.has(folder) && folder !== win32.dirname(folder); folder = win32.dirname(folder)) this.folders.add(folder);
    return this;
  }

  real(path: string): string {
    const parts = path.split("\\");
    for (let end = parts.length; end > 0; end -= 1) {
      const link = this.links.get(parts.slice(0, end).join("\\"));
      if (link) return this.real([link, ...parts.slice(end)].join("\\"));
    }
    if (!this.files.has(path) && !this.folders.has(path)) throw new Error(`ENOENT ${path}`);
    return path;
  }

  options(env: NodeJS.ProcessEnv, extra: object = {}) {
    const present = (path: string) => { try { return this.files.has(this.real(path)); } catch { return false; } };
    return {
      platform: "win32" as const, env, exists: present, electron: true,
      launchOptions: {
        execPath: "C:\\App\\LetAgents.exe", exists: present,
        present: (path: string) => this.files.has(path) || this.folders.has(path) || this.links.has(path),
        readFile: (path: string) => {
          const text = this.files.get(this.real(path));
          if (text === undefined) throw new Error(`ENOENT ${path}`);
          return text;
        },
        realpath: (path: string) => this.real(path),
        readdir: (folder: string) => {
          const real = this.real(folder);
          const names = new Set<string>();
          for (const path of [...this.files.keys(), ...this.folders, ...this.links.keys()]) {
            if (win32.dirname(path) === real && path !== real) names.add(win32.basename(path));
          }
          return [...names].map((name) => {
            const path = win32.join(real, name);
            return { name, isDirectory: () => this.folders.has(path), isSymbolicLink: () => this.links.has(path) };
          });
        },
      },
      ...extra,
    };
  }
}

const NPM = "C:\\Users\\A B\\AppData\\Roaming\\npm";
const OPENCODE_EXE = `${NPM}\\node_modules\\opencode-ai\\bin\\opencode.exe`;
const npmEnv = { Path: `${NPM};C:\\Windows\\System32`, SystemRoot: "C:\\Windows" };
const openCodeDisk = (shim = OPENCODE_CMD) => new Disk().file(`${NPM}\\opencode.cmd`, shim).file(OPENCODE_EXE);

const INSTALL = "C:\\Users\\A B\\AppData\\Local\\cursor-agent";
const LOCAL = "C:\\Users\\A B\\AppData\\Local";
const cursorEnv = { Path: `${INSTALL};C:\\Windows\\System32`, SystemRoot: "C:\\Windows", LOCALAPPDATA: LOCAL };
function cursorDisk(versions: string[] = ["2026.10.22-27dcf5f"], launcher = CURSOR_CMD, script = CURSOR_PS1) {
  const disk = new Disk().file(`${INSTALL}\\cursor-agent.cmd`, launcher).file(`${INSTALL}\\agent.cmd`, launcher).file(`${INSTALL}\\cursor-agent.ps1`, script)
    .file(`${INSTALL}\\versions\\promote-staged.cmd`, "@echo off");
  for (const version of versions) disk.file(`${INSTALL}\\versions\\${version}\\node.exe`).file(`${INSTALL}\\versions\\${version}\\index.js`);
  return disk;
}
const nodeOf = (version: string) => `${INSTALL}\\versions\\${version}\\node.exe`;
const scriptOf = (version: string) => `${INSTALL}\\versions\\${version}\\index.js`;

test("an npm shim of a native program starts that program, with the arguments unchanged and no cmd.exe", () => {
  const prompt = "line one\nline \"two\" 100% ^&|";
  for (const allowCmd of [false, true]) {
    const launch = providerLaunchCommand("opencode", ["serve", prompt], openCodeDisk().options(npmEnv, { allowCmd }));
    assert.deepEqual(launch, { file: OPENCODE_EXE, args: ["serve", prompt], resolved: `${NPM}\\opencode.cmd`, envAdditions: null });
  }
});

test("a scoped package's native program is found too, and a path into a package is required", () => {
  const scoped = `${NPM}\\node_modules\\@acme\\tool\\tool.exe`;
  const disk = new Disk().file(`${NPM}\\tool.cmd`, OPENCODE_CMD.replace("node_modules\\opencode-ai\\bin\\opencode.exe", "node_modules\\@acme\\tool\\tool.exe")).file(scoped);
  assert.equal(providerLaunchCommand("tool", [], disk.options(npmEnv)).file, scoped);
  for (const target of ["opencode.exe", "node_modules\\opencode.exe", "node_modules\\@acme\\opencode.exe", "bin\\node_modules\\x\\opencode.exe"]) {
    const shim = OPENCODE_CMD.replace("node_modules\\opencode-ai\\bin\\opencode.exe", target);
    assert.throws(() => providerLaunchCommand("opencode", [], openCodeDisk(shim).options(npmEnv)), REFUSED(/is not a file inside an npm package folder/), target);
  }
});

test("a native-program shim that names a path out of its package fails closed, and never reaches cmd.exe", () => {
  for (const target of [
    "node_modules\\opencode-ai\\..\\..\\..\\evil.exe",
    "node_modules\\..\\evil.exe",
    "node_modules\\opencode-ai\\.\\opencode.exe",
    "node_modules\\opencode-ai\\bin\\.\\opencode.exe",
    "node_modules/opencode-ai/bin/opencode.exe",
    "node_modules\\opencode-ai\\bin\\opencode.txt:evil.exe",
    "node_modules\\opencode-ai\\bin\\%OTHER%.exe",
    "node_modules\\opencode-ai\\bin\\a^b.exe",
    "node_modules\\opencode-ai\\bin\\!x!.exe",
    "node_modules\\opencode-ai\\bin\\ opencode.exe",
    "node_modules\\opencode-ai\\bin\\opencode..exe\\x..\\a.exe",
    "C:\\Windows\\System32\\calc.exe",
    "\\\\server\\share\\evil.exe",
    "node.exe-evil.exe",
    "node.exe\\evil.exe",
    "node.exe evil.exe",
  ]) {
    const shim = OPENCODE_CMD.replace("node_modules\\opencode-ai\\bin\\opencode.exe", target);
    for (const allowCmd of [false, true]) {
      assert.throws(() => providerLaunchCommand("opencode", [], openCodeDisk(shim).options(npmEnv, { allowCmd })), REFUSED(/opencode\.cmd: its target/), target);
    }
  }
});

test("a native-program shim whose program is a link out of the package fails closed", () => {
  const outside = "C:\\Temp\\evil.exe";
  const asFile = openCodeDisk().file(outside);
  asFile.files.delete(OPENCODE_EXE);
  asFile.links.set(OPENCODE_EXE, outside);
  const asPackage = new Disk().file(`${NPM}\\opencode.cmd`, OPENCODE_CMD).file("C:\\Temp\\pkg\\bin\\opencode.exe");
  asPackage.links.set(`${NPM}\\node_modules\\opencode-ai`, "C:\\Temp\\pkg");
  const asFolder = new Disk().file(`${NPM}\\opencode.cmd`, OPENCODE_CMD).file("C:\\Temp\\bin\\opencode.exe");
  asFolder.folders.add(`${NPM}\\node_modules\\opencode-ai`);
  asFolder.links.set(`${NPM}\\node_modules\\opencode-ai\\bin`, "C:\\Temp\\bin");
  for (const disk of [asFile, asPackage, asFolder]) {
    for (const allowCmd of [false, true]) {
      assert.throws(() => providerLaunchCommand("opencode", [], disk.options(npmEnv, { allowCmd })), REFUSED(/is a link to C:\\Temp/));
    }
  }
});

test("a link above the shim's own folder is no escape, and a different letter case is the same file", () => {
  const disk = new Disk().file("D:\\real\\npm\\opencode.cmd", OPENCODE_CMD).file("D:\\real\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe");
  disk.links.set("C:\\npm", "D:\\real\\npm");
  const env = { Path: "C:\\npm", SystemRoot: "C:\\Windows" };
  assert.equal(providerLaunchCommand("opencode", [], disk.options(env)).file, "C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe");
  const cased = disk.options(env);
  cased.launchOptions.realpath = (path: string) => disk.real(path).replace("opencode.exe", "OpenCode.EXE");
  assert.equal(providerLaunchCommand("opencode", [], cased).file, "C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe");
});

test("a native-program shim with anything else in it, or with its program gone, fails closed", () => {
  for (const shim of [
    `calc.exe\r\n${OPENCODE_CMD}`,
    `${OPENCODE_CMD}C:\\Temp\\evil.exe\r\n`,
    `${OPENCODE_CMD}node "%~dp0\\..\\evil.js" %*\r\n`,
    `${OPENCODE_CMD}node "%~dp0\\node_modules\\evil\\run.js" %*\r\n`,
    OPENCODE_CMD.replace("\"%dp0%\\node_modules", "@\"%dp0%\\node_modules"),
    OPENCODE_CMD.replace("\"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe\"", "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"),
    OPENCODE_CMD.replace("%dp0%\\node_modules", "%~dp0node_modules"),
    OPENCODE_CMD.replace("\"%dp0%\\node_modules", "start \"\" \"%dp0%\\node_modules"),
    OPENCODE_CMD.replace("@ECHO off", "@ECHO on"),
    OPENCODE_CMD.replace("SETLOCAL", "SETLOCAL\r\nSET PATH=C:\\evil"),
    OPENCODE_CMD.replace("   %*", " %*"),
    OPENCODE_CMD.replace("   %*", " --flag %*"),
    OPENCODE_CMD.replace("SETLOCAL\r\n", "SETLOCAL\rcalc.exe\r\n"),
  ]) {
    for (const allowCmd of [false, true]) {
      assert.throws(() => providerLaunchCommand("opencode", [], openCodeDisk(shim).options(npmEnv, { allowCmd })), REFUSED(/is not the npm shim/), shim);
    }
  }
  const gone = openCodeDisk();
  gone.files.delete(OPENCODE_EXE);
  assert.throws(() => providerLaunchCommand("opencode", [], gone.options(npmEnv, { allowCmd: true })), REFUSED(/opencode\.exe is missing/));
});

test("Cursor's official launcher starts its own node.exe and index.js, with the arguments unchanged and what the launcher sets", () => {
  const prompt = "line one\nline \"two\" 100% ^&|";
  const version = "2026.10.22-27dcf5f";
  for (const allowCmd of [false, true]) {
    const launch = providerLaunchCommand("cursor-agent", ["-p", prompt], cursorDisk().options(cursorEnv, { allowCmd }));
    assert.deepEqual(launch, {
      file: nodeOf(version), args: [scriptOf(version), "-p", prompt], resolved: `${INSTALL}\\cursor-agent.cmd`,
      envAdditions: { CURSOR_INVOKED_AS: "cursor-agent.cmd", NODE_COMPILE_CACHE: `${LOCAL}\\cursor-compile-cache` },
    });
  }
  const alias = providerLaunchCommand("agent", [], cursorDisk().options(cursorEnv));
  assert.equal(alias.file, nodeOf(version));
  assert.equal(alias.envAdditions?.CURSOR_INVOKED_AS, "agent.cmd", "as %~nx0 is");
});

test("Cursor's environment keeps a compile cache already chosen, in any letter case, and adds none with no LOCALAPPDATA", () => {
  const chosen = providerLaunchCommand("cursor-agent", [], cursorDisk().options({ ...cursorEnv, node_compile_cache: "C:\\cache" }));
  assert.deepEqual(chosen.envAdditions, { CURSOR_INVOKED_AS: "cursor-agent.cmd" });
  const { LOCALAPPDATA: _absent, ...withoutLocal } = cursorEnv;
  assert.deepEqual(providerLaunchCommand("cursor-agent", [], cursorDisk().options(withoutLocal)).envAdditions, { CURSOR_INVOKED_AS: "cursor-agent.cmd" });
});

test("Cursor's version is the latest date, as the script orders them, not the last by name", () => {
  const date = (versions: string[]) => providerLaunchCommand("cursor-agent", [], cursorDisk(versions).options(cursorEnv)).file;
  assert.equal(date(["2026.9.30-aaa", "2026.10.2-bbb"]), nodeOf("2026.10.2-bbb"), "by number: 9 sorts after 10 by name");
  assert.equal(date(["2026.10.21-fff", "2026.10.22-000"]), nodeOf("2026.10.22-000"));
  assert.equal(date(["2026.10.21-23-59-59-fff", "2026.10.22-00-00-00-000"]), nodeOf("2026.10.22-00-00-00-000"), "the newer name form");
  assert.equal(date(["2026.10.21-fff", "2026.10.22-ABCDEF"]), nodeOf("2026.10.22-ABCDEF"), "-match has no case");
  // Names the script's filter leaves out, whatever they hold.
  const ignored = cursorDisk(["2026.10.21-fff"]);
  for (const name of ["2027.01.01-aaa.new", "2027.01.01-aaa.previous", "2027.01.01", "latest", "2027.1.1-xyz", "2027.01.01-01-02-aaa"]) {
    ignored.file(`${INSTALL}\\versions\\${name}\\node.exe`).file(`${INSTALL}\\versions\\${name}\\index.js`);
  }
  ignored.file(`${INSTALL}\\versions\\2027.01.01-bbb`);
  assert.equal(providerLaunchCommand("cursor-agent", [], ignored.options(cursorEnv)).file, nodeOf("2026.10.21-fff"));
});

test("Cursor's folder pattern is .NET's: any digit counts, so a date no number can be made of fails closed", () => {
  const timestamp = "2026.10.22-\u0661\u0662-\u0660\u0660-\u0660\u0660-bbb";
  assert.throws(() => providerLaunchCommand("cursor-agent", [], cursorDisk(["2026.10.22-aaa", timestamp]).options(cursorEnv)), REFUSED(/versions of one date/));
  assert.throws(() => providerLaunchCommand("cursor-agent", [], cursorDisk(["2026.10.22-aaa", "\u0662\u0660\u0662\u0667.1.1-bbb"]).options(cursorEnv)), REFUSED(/whose date LetAgents cannot read/));
});

test("two Cursor versions of one date fail closed and name both: the script has no defined order for them", () => {
  for (const versions of [["2026.10.22-aaa", "2026.10.22-bbb"], ["2026.10.22-27dcf5f", "2026.10.22-10-00-00-aaa"], ["2026.10.2-aaa", "2026.10.02-bbb"]]) {
    assert.throws(() => providerLaunchCommand("cursor-agent", [], cursorDisk(versions).options(cursorEnv, { allowCmd: true })), (error: Error) =>
      REFUSED(/versions of one date/)(error) && versions.every((version) => error.message.includes(version)) && /LETAGENTS_CURSOR_AGENT_BIN/.test(error.message));
  }
});

test("a launcher inside a version folder runs the node.exe beside it, which is the way out of a tie", () => {
  const version = "2026.10.22-aaa";
  const folder = `${INSTALL}\\versions\\${version}`;
  const disk = cursorDisk([version, "2026.10.22-bbb"]).file(`${folder}\\cursor-agent.cmd`, VERSIONED_CMD).file(`${folder}\\cursor-agent.ps1`, VERSIONED_PS1);
  const launch = providerLaunchCommand(`${folder}\\cursor-agent.cmd`, ["--version"], disk.options(cursorEnv));
  assert.equal(launch.file, nodeOf(version));
  assert.deepEqual(launch.args, [scriptOf(version), "--version"]);
});

test("a node.exe beside the install's launcher wins, as the script's first check says", () => {
  const disk = cursorDisk().file(`${INSTALL}\\node.exe`).file(`${INSTALL}\\index.js`);
  const launch = providerLaunchCommand("cursor-agent", [], disk.options(cursorEnv));
  assert.equal(launch.file, `${INSTALL}\\node.exe`);
  assert.deepEqual(launch.args, [`${INSTALL}\\index.js`]);
});

test("a folder named node.exe beside the launcher takes the script's first branch, and fails closed there", () => {
  const disk = cursorDisk().file(`${INSTALL}\\node.exe\\inner.txt`).file(`${INSTALL}\\index.js`);
  assert.throws(() => providerLaunchCommand("cursor-agent", [], disk.options(cursorEnv, { allowCmd: true })), REFUSED(/cursor-agent\\node\.exe is missing/));
});

test("a dangling link named node.exe also takes the script's first branch, and fails closed there", () => {
  const disk = cursorDisk().file(`${INSTALL}\\index.js`);
  disk.links.set(`${INSTALL}\\node.exe`, "C:\\Temp\\gone.exe");
  assert.throws(() => providerLaunchCommand("cursor-agent", [], disk.options(cursorEnv, { allowCmd: true })), REFUSED(/cursor-agent\\node\.exe is missing/));
});

test("every promote hook Cursor's updater writes is accepted, and a launcher with none", () => {
  const cmdHook = CURSOR_CMD.slice(0, CURSOR_CMD.indexOf("@echo off\r\nsetlocal"));
  const ps1Hook = CURSOR_PS1.slice(0, CURSOR_PS1.indexOf("if (-not $env:CURSOR_INVOKED_AS)"));
  const launchers = [CURSOR_CMD, CURSOR_CMD.replace("if errorlevel 1 exit /b 1", "if errorlevel 1 (call )"), CURSOR_CMD.slice(cmdHook.length), VERSIONED_CMD];
  const scripts = [CURSOR_PS1, CURSOR_PS1.replace("{ exit $LASTEXITCODE }\r\n}\r\nif (-not", "{ $LASTEXITCODE = 0 }\r\n}\r\nif (-not"), CURSOR_PS1.slice(ps1Hook.length), VERSIONED_PS1];
  for (const launcher of launchers) {
    for (const script of scripts) {
      assert.equal(providerLaunchCommand("cursor-agent", [], cursorDisk(undefined, launcher, script).options(cursorEnv)).file, nodeOf("2026.10.22-27dcf5f"));
    }
  }
});

test("a comment that changes is no change of shape, and a line that only looks like one is", () => {
  const launch = (launcher: string, script: string) => providerLaunchCommand("cursor-agent", [], cursorDisk(undefined, launcher, script).options(cursorEnv, { allowCmd: true }));
  assert.equal(launch(CURSOR_CMD.replace("REM Get the directory of this script", "REM Find the folder, of this script"), CURSOR_PS1).file, nodeOf("2026.10.22-27dcf5f"));
  assert.equal(launch(CURSOR_CMD, CURSOR_PS1.replace("## Enable Node.js compile cache", "## Turn on the compile cache")).file, nodeOf("2026.10.22-27dcf5f"));
  assert.throws(() => launch(CURSOR_CMD.replace("REM Get the directory of this script", "REM x & calc.exe"), CURSOR_PS1), REFUSED(/cursor-agent\.cmd: its text/));
  assert.throws(() => launch(CURSOR_CMD, `#requires -RunAsAdministrator\r\n${CURSOR_PS1}`), REFUSED(/cursor-agent\.ps1: its text/));
  assert.throws(() => launch(CURSOR_CMD, `<# block #>\r\n${CURSOR_PS1}`), REFUSED(/cursor-agent\.ps1: its text/));
});

test("a Cursor launcher of any other shape fails closed, names the file, and never reaches cmd.exe", () => {
  const cases: Array<[string, string, string, RegExp]> = [
    ["an added command", CURSOR_CMD.replace("setlocal enabledelayedexpansion", "setlocal enabledelayedexpansion\r\ncalc.exe"), CURSOR_PS1, /cursor-agent\.cmd: its text/],
    ["another script", CURSOR_CMD.replace("\\cursor-agent.ps1", "\\other.ps1"), CURSOR_PS1, /cursor-agent\.cmd: its text/],
    ["another PowerShell", CURSOR_CMD.replace("%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell.exe"), CURSOR_PS1, /cursor-agent\.cmd: its text/],
    ["a named launcher with no link to the script", "@echo off\r\nC:\\tools\\agent.exe %*\r\n", CURSOR_PS1, /cursor-agent\.cmd: its text/],
    ["a changed folder pattern", CURSOR_CMD, CURSOR_PS1.replace("-[a-f0-9]+$'", "-.+$'"), /cursor-agent\.ps1: its text/],
    ["another order", CURSOR_CMD, CURSOR_PS1.replace("-Descending |", "|"), /cursor-agent\.ps1: its text/],
    ["a changed program", CURSOR_CMD, CURSOR_PS1.replace('& "$nodePath" "$scriptPath', '& "C:\\evil.exe" "$scriptPath'), /cursor-agent\.ps1: its text/],
    ["a second run", CURSOR_CMD, `${CURSOR_PS1}calc.exe\r\n`, /cursor-agent\.ps1: its text/],
    ["a half hook", CURSOR_CMD, CURSOR_PS1.replace("& $promoteStaged\r\n", ""), /cursor-agent\.ps1: its text/],
    ["a script shim line after it", `${CURSOR_CMD}node "%~dp0\\..\\evil.js" %*\r\n`, CURSOR_PS1, /cursor-agent\.cmd: its text/],
    ["a lone CR in the launcher", CURSOR_CMD.replace("REM Remove trailing backslash\r\n", "REM Remove trailing backslash\rcalc.exe\r\n"), CURSOR_PS1, /cursor-agent\.cmd: its text/],
    ["a statement after a lone CR in a comment", CURSOR_CMD, CURSOR_PS1.replace("## Enable Node.js compile cache", "# harmless\r$scriptPath = \"C:\\Other\"\r\n## Enable Node.js compile cache"), /cursor-agent\.ps1: its text/],
    ["a space that is not a space", `\u00a0${CURSOR_CMD}`, CURSOR_PS1, /cursor-agent\.cmd: its text/],
  ];
  for (const [name, launcher, script, message] of cases) {
    for (const allowCmd of [false, true]) {
      assert.throws(() => providerLaunchCommand("cursor-agent", ["-p", "x"], cursorDisk(undefined, launcher, script).options(cursorEnv, { allowCmd })), REFUSED(message), name);
    }
  }
  // A script-shim line must not excuse a file that names the script, under any name.
  const shimmed = cursorDisk().file("C:\\npm\\tool.cmd", `${CURSOR_CMD}node "%~dp0\\..\\evil.js" %*\r\n`);
  assert.throws(() => providerLaunchCommand("C:\\npm\\tool.cmd", [], shimmed.options(cursorEnv)), REFUSED(/tool\.cmd: its text/));
  // A file of another name that points at the same script claims to be this launcher too.
  const other = cursorDisk().file(`${INSTALL}\\wrapper.cmd`, `@echo off\r\ncalc.exe\r\ncall "%~dp0cursor-agent.ps1"\r\n`);
  assert.throws(() => providerLaunchCommand(`${INSTALL}\\wrapper.cmd`, [], other.options(cursorEnv, { allowCmd: true })), REFUSED(/wrapper\.cmd: its text/));
});

test("a script shim keeps its own path: its node.exe check claims nothing, and npm may name it cursor-agent.cmd", () => {
  const shim = [
    "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
    "IF EXIST \"%dp0%\\node.exe\" (", "  SET \"_prog=%dp0%\\node.exe\"", ") ELSE (", "  SET \"_prog=node\"", "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
    "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\cursor-agent\\index.js\" %*", "",
  ].join("\r\n");
  const disk = new Disk().file(`${NPM}\\cursor-agent.cmd`, shim).file(`${NPM}\\node.exe`);
  const launch = providerLaunchCommand("cursor-agent", ["-p"], disk.options(npmEnv));
  assert.equal(launch.file, `${NPM}\\node.exe`);
  assert.deepEqual(launch.args, [`${NPM}\\node_modules\\cursor-agent\\index.js`, "-p"]);
  assert.equal(launch.envAdditions, null);
});

test("a batch file that cannot be read fails closed: every check depends on its text, and cmd.exe would skip them", () => {
  const disk = cursorDisk();
  const options = disk.options(cursorEnv, { allowCmd: true });
  options.launchOptions.readFile = () => { throw new Error("EBUSY"); };
  assert.throws(() => providerLaunchCommand("cursor-agent", [], options), REFUSED(/cursor-agent\.cmd: it could not be read/));
});

test("a script shim is read once, so a read that fails afterwards cannot turn it into a cmd.exe launch", () => {
  const shim = "@ECHO off\r\nnode \"%~dp0\\node_modules\\tool\\cli.js\" %*\r\n";
  const disk = new Disk().file(`${NPM}\\tool.cmd`, shim).file(`${NPM}\\node.exe`);
  const options = disk.options(npmEnv);
  let reads = 0;
  options.launchOptions.readFile = () => {
    reads += 1;
    if (reads > 1) throw new Error("EBUSY");
    return shim;
  };
  const launch = providerLaunchCommand("tool", ["-p"], options);
  assert.equal(reads, 1);
  assert.equal(launch.file, `${NPM}\\node.exe`);
  assert.equal(launch.windowsVerbatimArguments, undefined);
});

test("a script path that only holds .exe inside a longer name claims nothing", () => {
  for (const script of ["node_modules\\foo\\bin\\run.exec.js", "node_modules\\foo.exe\\bin\\cli.js"]) {
    const shim = `@ECHO off\r\nnode "%~dp0\\${script}" %*\r\n`;
    const disk = new Disk().file(`${NPM}\\tool.cmd`, shim).file(`${NPM}\\node.exe`);
    assert.deepEqual(providerLaunchCommand("tool", [], disk.options(npmEnv)).args, [`${NPM}\\${script}`]);
  }
});

test("a batch file that claims neither install is still refused as a batch file", () => {
  const disk = new Disk().file(`${NPM}\\sometool.cmd`, "@echo off\r\nC:\\tools\\agent.exe %*\r\n");
  assert.throws(() => providerLaunchCommand("sometool", [], disk.options(npmEnv)), ProviderBatchFileError);
});

test("a Cursor install with a part missing or redirected fails closed", () => {
  const version = "2026.10.22-27dcf5f";
  const launch = (disk: Disk) => () => providerLaunchCommand("cursor-agent", [], disk.options(cursorEnv, { allowCmd: true }));
  const noScript = cursorDisk();
  noScript.files.delete(`${INSTALL}\\cursor-agent.ps1`);
  assert.throws(launch(noScript), REFUSED(/cursor-agent\.ps1 could not be read/));
  const noFolder = cursorDisk([]);
  noFolder.files.delete(`${INSTALL}\\versions\\promote-staged.cmd`);
  noFolder.folders.delete(`${INSTALL}\\versions`);
  assert.throws(launch(noFolder), REFUSED(/versions could not be read/));
  assert.throws(launch(cursorDisk([])), REFUSED(/holds no Cursor version/));
  for (const part of ["node.exe", "index.js"]) {
    const missing = cursorDisk();
    missing.files.delete(`${INSTALL}\\versions\\${version}\\${part}`);
    assert.throws(launch(missing), REFUSED(new RegExp(`${part.replace(".", "\\.")} is missing`)));
  }

  // A junction is selected as the script would select it, and refused.
  const junction = cursorDisk(["2026.10.21-fff"]).file("C:\\Temp\\evil\\node.exe").file("C:\\Temp\\evil\\index.js");
  junction.links.set(`${INSTALL}\\versions\\${version}`, "C:\\Temp\\evil");
  assert.throws(launch(junction), REFUSED(/is a link to C:\\Temp\\evil/));
  const allVersions = cursorDisk([]).file(`C:\\Temp\\evil\\${version}\\node.exe`).file(`C:\\Temp\\evil\\${version}\\index.js`);
  allVersions.files.delete(`${INSTALL}\\versions\\promote-staged.cmd`);
  allVersions.folders.delete(`${INSTALL}\\versions`);
  allVersions.links.set(`${INSTALL}\\versions`, "C:\\Temp\\evil");
  assert.throws(launch(allVersions), REFUSED(/is a link to C:\\Temp\\evil/));
  for (const part of ["node.exe", "index.js"]) {
    const file = cursorDisk().file(`C:\\Temp\\evil\\${part}`);
    file.files.delete(`${INSTALL}\\versions\\${version}\\${part}`);
    file.links.set(`${INSTALL}\\versions\\${version}\\${part}`, `C:\\Temp\\evil\\${part}`);
    assert.throws(launch(file), REFUSED(/is a link to C:\\Temp\\evil/));
  }
  const besideLauncher = cursorDisk().file("C:\\Temp\\evil\\node.exe").file(`${INSTALL}\\index.js`);
  besideLauncher.links.set(`${INSTALL}\\node.exe`, "C:\\Temp\\evil\\node.exe");
  assert.throws(launch(besideLauncher), REFUSED(/is a link to C:\\Temp\\evil/));
});

test("a link above Cursor's install folder is no escape", () => {
  const disk = new Disk().file("D:\\c\\cursor-agent.cmd", CURSOR_CMD).file("D:\\c\\cursor-agent.ps1", CURSOR_PS1)
    .file("D:\\c\\versions\\2026.10.22-aaa\\node.exe").file("D:\\c\\versions\\2026.10.22-aaa\\index.js");
  disk.links.set("C:\\c", "D:\\c");
  assert.equal(providerLaunchCommand("cursor-agent", [], disk.options({ Path: "C:\\c", SystemRoot: "C:\\Windows" })).file, "C:\\c\\versions\\2026.10.22-aaa\\node.exe");
});

test("a check of a refused install fails through its callback with the reason, and nothing starts", async () => {
  const disk = cursorDisk(["2026.10.22-aaa", "2026.10.22-bbb"]);
  const { launchOptions } = disk.options(cursorEnv);
  const calls: string[] = [];
  const result = await new Promise<{ error: Error | null; stderr: string | Buffer }>((resolve) => {
    const child = execProviderFile("cursor-agent", ["--version"], { env: cursorEnv }, (error, _stdout, stderr) => resolve({ error, stderr }), {
      platform: "win32", launchOptions, exists: launchOptions.exists,
      execFile: (file) => { calls.push(file); return new EventEmitter() as ChildProcess; },
    });
    (child as ChildProcess).stdin?.end();
  });
  assert.equal(calls.length, 0);
  assert.equal((result.error as Error & { code?: string }).code, "EPROVIDERINSTALL");
  assert.match(String(result.stderr), /versions of one date/);
});

test("a check and a tree start of Cursor's install run its node with what the launcher sets", () => {
  const disk = cursorDisk();
  const { launchOptions } = disk.options(cursorEnv);
  const checks: Array<[string, readonly string[], ExecFileOptions]> = [];
  execProviderFile("cursor-agent", ["--version"], { env: cursorEnv, timeout: 5 }, () => {}, {
    platform: "win32", launchOptions, exists: launchOptions.exists,
    execFile: (file, args, options) => { checks.push([file, args, options]); return new EventEmitter() as ChildProcess; },
  });
  assert.equal(checks[0]![0], nodeOf("2026.10.22-27dcf5f"));
  assert.deepEqual(checks[0]![1], [scriptOf("2026.10.22-27dcf5f"), "--version"]);
  assert.equal(checks[0]![2].env!.CURSOR_INVOKED_AS, "cursor-agent.cmd");
  assert.equal(checks[0]![2].windowsVerbatimArguments, undefined);

  const spawned: Array<[string, readonly string[], { env?: NodeJS.ProcessEnv }]> = [];
  spawnTree("cursor-agent", ["-p", "a \"b\""], { env: cursorEnv }, {
    platform: "win32", helperPath: "C:\\App\\letagents-process-tree.exe", launchOptions, exists: launchOptions.exists,
    spawn: (file: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawned.push([file, args, options]);
      return new EventEmitter() as ChildProcess;
    },
  });
  assert.equal(spawned[0]![0], "C:\\App\\letagents-process-tree.exe");
  assert.equal(spawned[0]![1][1], nodeOf("2026.10.22-27dcf5f"));
  assert.equal(spawned[0]![2].env!.CURSOR_INVOKED_AS, "cursor-agent.cmd");
});

test("a Cursor turn's program, command line and environment come from the official install", () => {
  const options = cursorDisk().options(cursorEnv);
  const program = cursorWindowsProgram("cursor-agent", options);
  assert.deepEqual(program, {
    file: nodeOf("2026.10.22-27dcf5f"), args: [scriptOf("2026.10.22-27dcf5f")],
    environment: { CURSOR_INVOKED_AS: "cursor-agent.cmd", NODE_COMPILE_CACHE: `${LOCAL}\\cursor-compile-cache` },
  });
  const native = cursorWindowsNativeLaunch("cursor-agent", ["-p", "hi"], { ...options, cwd: "C:\\repo", helper: "C:\\App\\helper.exe" });
  assert.equal(native.application, program.file);
  assert.equal(native.head, `"${program.file}" "${program.args[0]}"`);
  assert.equal(native.tail, "-p hi");
  assert.deepEqual(native.environment, program.environment);
  const bad = cursorDisk(undefined, CURSOR_CMD.replace("%*", "--evil %*")).options(cursorEnv);
  assert.throws(() => cursorWindowsProgram("cursor-agent", bad), REFUSED(/cursor-agent\.cmd: its text/));
});

test("POSIX is untouched: a batch-looking name is not read, and the program is the one given", () => {
  const launch = providerLaunchCommand("opencode.cmd", ["serve"], {
    platform: "darwin",
    launchOptions: { readFile: () => { throw new Error("must not be read"); } },
  });
  assert.deepEqual(launch, { file: "opencode.cmd", args: ["serve"], resolved: "opencode.cmd", envAdditions: null });
});

function windowsInstallRoot(): { root: string; remove(): void } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "provider install ")));
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/** A real program that prints what it was given, as a hard link of this node (a copy across volumes). */
function realNode(destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  try { linkSync(process.execPath, destination); } catch { copyFileSync(process.execPath, destination); }
}

const PRINT_ARGS = "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), invoked: process.env.CURSOR_INVOKED_AS, cache: process.env.NODE_COMPILE_CACHE }));";

test("Windows: a real npm shim's native program runs with hostile arguments intact", windowsOnly, () => {
  const { root, remove } = windowsInstallRoot();
  try {
    const exe = join(root, "node_modules", "opencode-ai", "bin", "opencode.exe");
    realNode(exe);
    writeFileSync(join(root, "print.js"), PRINT_ARGS);
    writeFileSync(join(root, "opencode.cmd"), OPENCODE_CMD);
    const env = { ...process.env, Path: root, PATH: root };
    const hostile = ["a \"quoted\" arg", "100%PATH%", "x^&|<>", "two\nlines"];
    const launch = providerLaunchCommand("opencode", [join(root, "print.js"), ...hostile], { platform: "win32", env });
    assert.equal(launch.file.toLowerCase(), exe.toLowerCase());
    const printed = JSON.parse(execFileSync(launch.file, launch.args, { encoding: "utf8" })) as { argv: string[] };
    assert.deepEqual(printed.argv, hostile);
  } finally {
    remove();
  }
});

test("Windows: a real junction out of the package, or out of Cursor's versions, is refused", windowsOnly, () => {
  const { root, remove } = windowsInstallRoot();
  try {
    const outside = join(root, "outside");
    realNode(join(outside, "bin", "opencode.exe"));
    const npm = join(root, "npm");
    mkdirSync(join(npm, "node_modules", "opencode-ai"), { recursive: true });
    writeFileSync(join(npm, "opencode.cmd"), OPENCODE_CMD);
    symlinkSync(join(outside, "bin"), join(npm, "node_modules", "opencode-ai", "bin"), "junction");
    assert.throws(() => providerLaunchCommand("opencode", [], { platform: "win32", allowCmd: true, env: { Path: npm } }), REFUSED(/is a link to/));

    const cursor = join(root, "cursor-agent");
    mkdirSync(join(cursor, "versions"), { recursive: true });
    writeFileSync(join(cursor, "cursor-agent.cmd"), CURSOR_CMD);
    writeFileSync(join(cursor, "cursor-agent.ps1"), CURSOR_PS1);
    realNode(join(outside, "version", "node.exe"));
    writeFileSync(join(outside, "version", "index.js"), PRINT_ARGS);
    symlinkSync(join(outside, "version"), join(cursor, "versions", "2026.10.22-aaa"), "junction");
    assert.throws(() => providerLaunchCommand("cursor-agent", [], { platform: "win32", allowCmd: true, env: { Path: cursor } }), REFUSED(/is a link to/));
  } finally {
    remove();
  }
});

function realCursorInstall(root: string): { folder: string; env: NodeJS.ProcessEnv } {
  const cursor = join(root, "cursor-agent");
  const folder = join(cursor, "versions", "2026.10.22-27dcf5f");
  realNode(join(folder, "node.exe"));
  writeFileSync(join(folder, "index.js"), PRINT_ARGS);
  writeFileSync(join(cursor, "cursor-agent.cmd"), CURSOR_CMD);
  writeFileSync(join(cursor, "cursor-agent.ps1"), CURSOR_PS1);
  const env: NodeJS.ProcessEnv = { ...process.env, Path: cursor, PATH: cursor, LOCALAPPDATA: root };
  delete env.NODE_COMPILE_CACHE;
  return { folder, env };
}

test("Windows: Cursor's real layout starts through the resolver with no shell", windowsOnly, () => {
  const { root, remove } = windowsInstallRoot();
  try {
    const { folder, env } = realCursorInstall(root);
    const hostile = ["a \"quoted\" arg", "100%PATH%", "x^&|<>", "two\nlines"];
    const launch = providerLaunchCommand("cursor-agent", hostile, { platform: "win32", env });
    assert.equal(launch.file.toLowerCase(), join(folder, "node.exe").toLowerCase());
    const ran = spawnSync(launch.file, launch.args, { encoding: "utf8", env: { ...env, ...launch.envAdditions } });
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(JSON.parse(ran.stdout), { argv: hostile, invoked: "cursor-agent.cmd", cache: join(root, "cursor-compile-cache") });
  } finally {
    remove();
  }
});

test("Windows: Cursor's real layout starts inside the process-tree helper's job", {
  skip: process.platform === "win32" && process.env.LETAGENTS_TEST_PROCESS_TREE_HELPER ? false : "needs Windows and the built helper",
}, async () => {
  const { root, remove } = windowsInstallRoot();
  try {
    const { env } = realCursorInstall(root);
    const hostile = ["a \"quoted\" arg", "100%PATH%", "x^&|<>", "two\nlines"];
    const child = spawnTree("cursor-agent", hostile, { env, stdio: ["ignore", "pipe", "inherit"] }, { helperPath: process.env.LETAGENTS_TEST_PROCESS_TREE_HELPER });
    let printed = "";
    child.stdout!.on("data", (chunk) => { printed += String(chunk); });
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(printed), { argv: hostile, invoked: "cursor-agent.cmd", cache: join(root, "cursor-compile-cache") });
  } finally {
    remove();
  }
});
