import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";

import {
  codexLaunchCommand,
  parseNodeShim,
  quoteCmdBatchArgument,
  resolveCodexExecutable,
  spawnCodex,
} from "../../../shared/codex-executable.mjs";

/** The text npm's cmd-shim writes for a `#!/usr/bin/env node` bin, byte for byte. */
function npmShim(relativeScript: string, shebangArgs = ""): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" ${shebangArgs} "%dp0%\\${relativeScript}" %*`,
    "",
  ].join("\r\n");
}

const CODEX_SCRIPT = "node_modules\\@openai\\codex\\bin\\codex.js";
const SHIM = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\codex.cmd";
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const TRICKY_ARGS = [
  "app-server",
  "-c",
  'skills.config=[{ path = "C:\\\\Users\\\\Ada\\\\.codex\\\\skills\\\\a b\\\\SKILL.md", enabled = false }]',
  "-c",
  'mcp_servers={ "chrome-devtools" = { enabled = false } }',
  "--listen",
  "ws://127.0.0.1:4321",
  "100% ^sure & done | not <that> (yet)",
  "trailing\\",
];

test("a POSIX launch spawns the executable and arguments unchanged", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const launch = codexLaunchCommand("/opt/homebrew/bin/codex", TRICKY_ARGS, { platform });
    assert.deepEqual(launch, { file: "/opt/homebrew/bin/codex", args: TRICKY_ARGS });
    assert.equal("windowsVerbatimArguments" in launch, false);
  }
  // A .cmd name means nothing off Windows.
  assert.deepEqual(codexLaunchCommand("/tmp/codex.cmd", ["--version"], { platform: "linux" }),
    { file: "/tmp/codex.cmd", args: ["--version"] });
});

test("a Windows .exe is spawned directly", () => {
  const exe = "C:\\Users\\Ada\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
  assert.deepEqual(codexLaunchCommand(exe, TRICKY_ARGS, { platform: "win32" }), { file: exe, args: TRICKY_ARGS });
});

test("an npm codex.cmd shim is replaced by node and its script, arguments untouched", () => {
  const launch = codexLaunchCommand(SHIM, TRICKY_ARGS, {
    platform: "win32",
    execPath: NODE,
    readFile: (filePath) => {
      assert.equal(filePath, SHIM);
      return npmShim(CODEX_SCRIPT);
    },
    exists: () => false,
  });
  assert.deepEqual(launch, {
    file: NODE,
    args: [win32.join(win32.dirname(SHIM), CODEX_SCRIPT), ...TRICKY_ARGS],
  });
  assert.equal("windowsVerbatimArguments" in launch, false);
});

test("a shim prefers the node.exe beside it, as the shim itself does", () => {
  const localNode = win32.join(win32.dirname(SHIM), "node.exe");
  const launch = codexLaunchCommand(SHIM, ["--version"], {
    platform: "win32",
    execPath: NODE,
    readFile: () => npmShim(CODEX_SCRIPT),
    exists: (filePath) => filePath === localNode,
  });
  assert.equal(launch.file, localNode);
});

test("shebang arguments in a shim stay ahead of the script", () => {
  const shim = parseNodeShim(SHIM, npmShim(CODEX_SCRIPT, "--no-warnings"), { execPath: NODE, exists: () => false });
  assert.deepEqual(shim, { file: NODE, args: ["--no-warnings", win32.join(win32.dirname(SHIM), CODEX_SCRIPT)] });
});

test("older npm shim shapes are recognised too", () => {
  const legacy = `@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\${CODEX_SCRIPT}" %*\r\n) ELSE (\r\n  node  "%~dp0\\${CODEX_SCRIPT}" %*\r\n)\r\n`;
  const shim = parseNodeShim(SHIM, legacy, { execPath: NODE, exists: () => false });
  assert.deepEqual(shim, { file: NODE, args: [win32.join(win32.dirname(SHIM), CODEX_SCRIPT)] });
});

test("a shim that does not run node is not treated as one", () => {
  const python = npmShim("node_modules\\tool\\main.py").replace('SET "_prog=node"', 'SET "_prog=python"');
  assert.equal(parseNodeShim(SHIM, python, { execPath: NODE, exists: () => false }), null);
  assert.equal(parseNodeShim(SHIM, "@ECHO off\r\n@codex-real.exe %*\r\n", { execPath: NODE, exists: () => false }), null);
});

test("another batch file runs through cmd.exe with every argument quoted", () => {
  const bat = "C:\\Tools\\my codex\\codex.bat";
  const launch = codexLaunchCommand(bat, ["app-server", "--listen", "ws://127.0.0.1:1", "100% ^sure & done", "end\\"], {
    platform: "win32",
    env: { ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" },
    readFile: () => "@ECHO off\r\n@codex-real.exe %*\r\n",
  });
  assert.deepEqual(launch, {
    file: "C:\\WINDOWS\\system32\\cmd.exe",
    args: [
      "/d", "/s", "/c",
      '""C:\\Tools\\my codex\\codex.bat" "app-server" "--listen" "ws://127.0.0.1:1" "100%%cd:~,% ^sure & done" "end\\\\""',
    ],
    windowsVerbatimArguments: true,
  });
  // A batch file that cannot be read is still run as one.
  const unreadable = codexLaunchCommand(bat, [], { platform: "win32", env: {}, readFile: () => { throw new Error("EACCES"); } });
  assert.deepEqual(unreadable.args, ["/d", "/s", "/c", '""C:\\Tools\\my codex\\codex.bat""']);
  assert.equal(unreadable.file, "cmd.exe");
});

test("cmd.exe quoting covers spaces, percent, caret and backslashes, and refuses quotes and line breaks", () => {
  assert.equal(quoteCmdBatchArgument("plain"), '"plain"');
  assert.equal(quoteCmdBatchArgument(""), '""');
  assert.equal(quoteCmdBatchArgument("a b\tc"), '"a b\tc"');
  assert.equal(quoteCmdBatchArgument("50%"), '"50%%cd:~,%"');
  assert.equal(quoteCmdBatchArgument("%PATH%"), '"%%cd:~,%PATH%%cd:~,%"');
  assert.equal(quoteCmdBatchArgument("a^b^^c"), '"a^b^^c"');
  assert.equal(quoteCmdBatchArgument("C:\\a\\b"), '"C:\\a\\b"');
  assert.equal(quoteCmdBatchArgument("C:\\a\\b\\"), '"C:\\a\\b\\\\"');
  assert.equal(quoteCmdBatchArgument("x\\\\"), '"x\\\\\\\\"');
  assert.throws(() => quoteCmdBatchArgument('say "hi"'), /double quote/);
  assert.throws(() => quoteCmdBatchArgument("one\ntwo"), /line break/);
  assert.throws(() => quoteCmdBatchArgument("one\r"), /line break/);
});

test("Windows resolution walks PATH with PATHEXT and finds codex.cmd", () => {
  const present = new Set(["C:\\Users\\Ada\\AppData\\Roaming\\npm\\codex.cmd"]);
  const resolved = resolveCodexExecutable({
    platform: "win32",
    env: { PATH: "C:\\WINDOWS\\system32;C:\\Users\\Ada\\AppData\\Roaming\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    homeDirectory: "C:\\Users\\Ada",
    isExecutable: (filePath) => present.has(filePath),
  });
  assert.equal(resolved, "C:\\Users\\Ada\\AppData\\Roaming\\npm\\codex.cmd");
  assert.equal(resolveCodexExecutable({
    platform: "win32", env: { PATH: "C:\\nowhere" }, homeDirectory: "C:\\Users\\Ada", isExecutable: () => false,
  }), "codex");
});

// The checks above fix the command line without cmd.exe. These run the real
// thing on a Windows host (the Windows CI job) and are skipped elsewhere.
const onWindows = process.platform === "win32";

function printArgsFixture(): { directory: string; script: string } {
  const directory = mkdtempSync(join(tmpdir(), "letagents-codex-shim-"));
  const script = join(directory, "node_modules", "fake-codex", "bin", "codex.js");
  mkdirSync(join(directory, "node_modules", "fake-codex", "bin"), { recursive: true });
  writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  return { directory, script };
}

function runToArgv(executable: string, args: string[]): string[] {
  const output = spawnSync("node", ["--input-type=module", "-e", [
    'import { spawnCodex } from "./shared/codex-executable.mjs";',
    "const child = spawnCodex(process.argv[1], process.argv.slice(2), { stdio: ['ignore', 'pipe', 'inherit'] });",
    "let out = ''; child.stdout.on('data', (c) => { out += c; });",
    "child.on('close', () => process.stdout.write(out));",
  ].join("\n"), "--", executable, ...args], { encoding: "utf8", cwd: process.cwd() });
  assert.equal(output.status, 0, output.stderr);
  return JSON.parse(output.stdout) as string[];
}

test("on Windows, spawnCodex runs an npm shim and passes tricky arguments through unchanged", { skip: !onWindows }, () => {
  const { directory } = printArgsFixture();
  try {
    const shim = join(directory, "codex.cmd");
    writeFileSync(shim, npmShim("node_modules\\fake-codex\\bin\\codex.js"));
    assert.deepEqual(runToArgv(shim, TRICKY_ARGS), TRICKY_ARGS);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("on Windows, spawnCodex runs another batch file through cmd.exe with arguments intact", { skip: !onWindows }, () => {
  const { directory, script } = printArgsFixture();
  try {
    const bat = join(directory, "codex.bat");
    writeFileSync(bat, `@node ${script} %*\r\n`);
    const args = ["app-server", "-c", "features.plugins=false", "two words", "100% ^sure & done | not <that> (yet)", "x\\", ""];
    assert.deepEqual(runToArgv(bat, args), args);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("spawnCodex on this platform runs the executable with the given arguments", { skip: onWindows }, () => {
  const directory = mkdtempSync(join(tmpdir(), "letagents-codex-posix-"));
  try {
    const bin = join(directory, "codex");
    writeFileSync(bin, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    chmodSync(bin, 0o755);
    assert.deepEqual(runToArgv(bin, TRICKY_ARGS), TRICKY_ARGS);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
