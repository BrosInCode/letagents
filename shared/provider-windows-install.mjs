import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

// Two provider installs whose entry point on Windows is a batch file that is
// no npm script shim, and what each one really runs, so that neither needs
// cmd.exe or PowerShell (see providerLaunchCommand):
//
// - An npm shim whose target is a native program: `npm i -g opencode-ai`.
// - Cursor's own installer: cursor-agent.cmd runs PowerShell, which runs
//   cursor-agent.ps1, which runs a node.exe and index.js of its own.
//
// Neither launcher is ever run to find this out: its text is compared with
// the shape below, and a file that claims to be one of these but differs, or
// whose program is not where the shape says, stops the launch. It must not
// go on to cmd.exe, which would run exactly what was refused.

const { basename, dirname, join } = path.win32;

function isFile(filePath) {
  try { return statSync(filePath).isFile(); } catch { return false; }
}

/** A provider install this module recognizes but cannot start. Nothing was run. */
export class ProviderInstallError extends Error {
  constructor(file, reason) {
    super(`LetAgents cannot start ${file}: ${reason} LetAgents did not run it. `
      + "Reinstall the program, or set its LETAGENTS_*_BIN variable to the program it starts.");
    this.name = "ProviderInstallError";
    this.code = "EPROVIDERINSTALL";
  }
}

/** Windows names are case-free, and a copied environment keeps whichever spelling it had. */
function environmentValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * Refuses `file` unless it is exactly `<base>\<relative>` on disk: a junction,
 * symbolic link or other reparse point anywhere below `base` resolves to some
 * other path. A hard link (OpenCode's binary is one) is the file itself.
 */
function assertNoRedirect(launcher, base, relative, files) {
  const file = join(base, relative);
  let real;
  let expected;
  try {
    real = files.realpath(file);
    expected = join(files.realpath(base), relative);
  } catch {
    throw new ProviderInstallError(launcher, `${file} could not be read.`);
  }
  if (real.toLowerCase() !== expected.toLowerCase()) {
    throw new ProviderInstallError(launcher, `${file} is a link to ${real}, outside the install.`);
  }
  return file;
}

// What cmd-shim writes for a bin with no shebang, which runs the file as it
// is (`prog + " " + args + " " + target + " %*"`, with args and target empty):
const NPM_SHIM_HEAD = ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0"];
// A line that starts a program in the shim's folder claims this shape, on any
// line of the file. A script shim's `"%dp0%\node.exe"` is not such a claim.
const NPM_SHIM_NATIVE_CLAIM = /^[ \t]*"%dp0%\\(?!node\.exe")[^"\r\n]+\.exe"[ \t]/im;
const NPM_SHIM_NATIVE_TARGET = /^"%dp0%\\([^"]+\.exe)"   %\*$/i;
// One path segment, in characters that mean nothing to cmd.exe or to Windows path parsing.
const NPM_TARGET_SEGMENT = /^[A-Za-z0-9@_+-](?:[A-Za-z0-9@._+-]*[A-Za-z0-9@_+-])?$/;

/** The lines of a launcher that do anything. A lone CR ends a line for PowerShell, so no line of such a text can be trusted. */
function significantLines(text) {
  if (/\r(?!\n)/.test(text)) return [];
  return text.split(/\r?\n/).map((line) => line.replace(/^[ \t]+|[ \t]+$/g, "")).filter(Boolean);
}

function isExactly(lines, expected) {
  return lines.length === expected.length && expected.every((line, index) => lines[index] === line);
}

/** True for `node_modules\<name>\...\<file>` or `node_modules\@<scope>\<name>\...\<file>`. */
function namesFileInPackage(segments) {
  const packageDepth = segments[1]?.startsWith("@") ? 3 : 2;
  return segments[0]?.toLowerCase() === "node_modules" && segments.length > packageDepth;
}

/** The native program of an npm shim, or null for a file that does not claim to be one. */
function npmNativeProgram(shim, text, files) {
  if (!NPM_SHIM_NATIVE_CLAIM.test(text)) return null;
  const lines = significantLines(text);
  const target = NPM_SHIM_NATIVE_TARGET.exec(lines.at(-1) ?? "")?.[1];
  if (target === undefined || !isExactly(lines.slice(0, -1), NPM_SHIM_HEAD)) {
    throw new ProviderInstallError(shim, "its text is not the npm shim for a native program.");
  }
  const segments = target.split("\\");
  if (!namesFileInPackage(segments) || !segments.every((segment) => NPM_TARGET_SEGMENT.test(segment))) {
    throw new ProviderInstallError(shim, `its target ${target} is not a file inside an npm package folder beside it.`);
  }
  const directory = dirname(shim);
  if (!files.exists(join(directory, target))) throw new ProviderInstallError(shim, `its program ${join(directory, target)} is missing.`);
  return { file: assertNoRedirect(shim, directory, target, files), args: [], envAdditions: null };
}

// Cursor's launchers, read from cursor-agent 2026.10.22-27dcf5f. A comment
// line can do nothing (`rem` here has no `&` or other cmd.exe character after
// it, and `#requires` is no such comment), so one that changes is no change
// of shape. Any other line that differs stops the launch: it may be a change
// in which program runs.
const CURSOR_CMD_COMMENT = /^rem [\w .,'-]*$/i;
const CURSOR_PS1_COMMENT = /^##? /;

// The updater puts one of these hooks at the top of the launchers in the
// install folder; the launchers inside a version folder have none.
const CURSOR_CMD_PROMOTE_HOOKS = ["if errorlevel 1 exit /b 1", "if errorlevel 1 (call )"].map((end) => [
  "@echo off",
  String.raw`if exist "%~dp0versions\promote-staged.cmd" call "%~dp0versions\promote-staged.cmd"`,
  end,
]);
const CURSOR_PS1_PROMOTE_HOOKS = ["{ exit $LASTEXITCODE }", "{ $LASTEXITCODE = 0 }"].map((end) => [
  String.raw`$promoteStaged = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Definition) "versions\promote-staged.cmd"`,
  "if (Test-Path -LiteralPath $promoteStaged) {",
  "& $promoteStaged",
  `if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) ${end}`,
  "}",
]);
const CURSOR_CMD = significantLines(String.raw`
@echo off
setlocal enabledelayedexpansion
set "CURSOR_INVOKED_AS=%~nx0"
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\cursor-agent.ps1" %*
`);
const CURSOR_PS1 = significantLines(String.raw`
if (-not $env:CURSOR_INVOKED_AS) {
$env:CURSOR_INVOKED_AS = Split-Path -leaf $MyInvocation.MyCommand.Name
}
$scriptPath = Split-Path -parent $MyInvocation.MyCommand.Definition
function Parse-VersionString {
param (
[string]$versionString
)
$datePart = $versionString.Split('-')[0]
$parts = $datePart.Split('.')
if ($parts.Length -ne 3) {
throw "Invalid version format. Expected format: YYYY.MM.DD-commit"
}
$year = $parts[0]
$month = $parts[1].PadLeft(2, '0')
$day = $parts[2].PadLeft(2, '0')
return [int]($year + $month + $day)
}
if (-not $env:NODE_COMPILE_CACHE) {
$env:NODE_COMPILE_CACHE = "$env:LOCALAPPDATA\cursor-compile-cache"
}
if (Test-Path "$scriptPath\node.exe") {
& "$scriptPath\node.exe" "$scriptPath\index.js" $args
exit $LASTEXITCODE
}
$versionDir = Get-ChildItem -Path "$scriptPath\versions" -Directory |
Where-Object {
$name = $_.Name
$name -match '^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$'
} |
Sort-Object { Parse-VersionString $_.Name } -Descending |
Select-Object -First 1
if (-not $versionDir) {
Write-Error "No version directories found in $scriptPath"
exit 1
}
$versionName = $versionDir.Name
$nodePath = "$scriptPath\versions\$versionName\node.exe"
& "$nodePath" "$scriptPath\versions\$versionName\index.js" $args
exit $LASTEXITCODE
`);
// The same pattern as the script's, which .NET matches without case.
const CURSOR_VERSION_FOLDER = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i;

/** `lines` without the updater's hook, when they start with one, compared with the launcher's own lines. */
function matchesLauncher(lines, hooks, expected) {
  const hook = hooks.find((candidate) => isExactly(lines.slice(0, candidate.length), candidate));
  return isExactly(hook ? lines.slice(hook.length) : lines, expected);
}

function isCursorLauncherCmd(text) {
  return matchesLauncher(significantLines(text).filter((line) => !CURSOR_CMD_COMMENT.test(line)), CURSOR_CMD_PROMOTE_HOOKS, CURSOR_CMD);
}

function isCursorLauncherPs1(text) {
  return matchesLauncher(significantLines(text).filter((line) => !CURSOR_PS1_COMMENT.test(line)), CURSOR_PS1_PROMOTE_HOOKS, CURSOR_PS1);
}

/** The script's date, as its Parse-VersionString makes it: a build time in the name is not part of it. */
function cursorVersionDate(name) {
  const [, year, month, day] = CURSOR_VERSION_FOLDER.exec(name);
  return Number(`${year}${month.padStart(2, "0")}${day.padStart(2, "0")}`);
}

/**
 * The version folder cursor-agent.ps1 selects: the one with the latest date.
 * Two folders of one date have no defined order: PowerShell 5.1's Sort-Object
 * is not stable (2, 3 and 5 equal keys gave the 2nd, 3rd and 4th item), so
 * what the script would run cannot be known, and that is refused too.
 */
function selectedCursorVersion(launcher, root, files) {
  const versions = join(root, "versions");
  let entries;
  try {
    entries = files.readdir(versions);
  } catch {
    throw new ProviderInstallError(launcher, `${versions} could not be read.`);
  }
  // Get-ChildItem -Directory lists a junction too. It is selected like a folder, and then refused.
  const candidates = entries
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && CURSOR_VERSION_FOLDER.test(entry.name))
    .map((entry) => entry.name);
  if (candidates.length === 0) throw new ProviderInstallError(launcher, `${versions} holds no Cursor version.`);
  const latest = Math.max(...candidates.map(cursorVersionDate));
  const selected = candidates.filter((name) => cursorVersionDate(name) === latest);
  if (selected.length > 1) {
    throw new ProviderInstallError(launcher, `${versions} holds ${selected.length} versions of one date (${selected.join(", ")}), and Cursor's launcher does not `
      + "define which one it runs. Delete the older one, or point LETAGENTS_CURSOR_AGENT_BIN at the cursor-agent.cmd inside the one you want.");
  }
  return selected[0];
}

/** What a launcher in `root` runs, as its PowerShell script decides it: node.exe beside it, else the selected version's. */
function cursorProgram(launcher, root, files) {
  const folder = files.exists(join(root, "node.exe")) ? "" : join("versions", selectedCursorVersion(launcher, root, files));
  const paths = ["node.exe", "index.js"].map((name) => {
    if (!files.exists(join(root, folder, name))) throw new ProviderInstallError(launcher, `${join(root, folder, name)} is missing.`);
    return assertNoRedirect(launcher, root, join(folder, name), files);
  });
  return { file: paths[0], args: [paths[1]] };
}

/** What the launchers set before Node starts: Cursor reads the first to learn its own name. */
function cursorEnvironment(launcher, env) {
  const localAppData = environmentValue(env, "LOCALAPPDATA");
  return {
    CURSOR_INVOKED_AS: basename(launcher),
    ...(localAppData && !environmentValue(env, "NODE_COMPILE_CACHE")
      ? { NODE_COMPILE_CACHE: join(localAppData, "cursor-compile-cache") }
      : {}),
  };
}

function cursorInstalledProgram(launcher, text, files, env, isNodeShim) {
  // A launcher's name is a claim only when the file is not a script shim, which npm may well
  // name cursor-agent.cmd. Text that names the script is a claim whatever else the file holds.
  const claimed = /cursor-agent\.ps1/i.test(text) || (!isNodeShim && /^(?:cursor-agent|agent)\.cmd$/i.test(basename(launcher)));
  if (!claimed) return null;
  if (!isCursorLauncherCmd(text)) throw new ProviderInstallError(launcher, "its text is not a Cursor launcher this version of LetAgents knows.");
  const root = dirname(launcher);
  const script = join(root, "cursor-agent.ps1");
  let scriptText;
  try {
    scriptText = files.readFile(script);
  } catch {
    throw new ProviderInstallError(launcher, `${script} could not be read.`);
  }
  if (!isCursorLauncherPs1(scriptText)) throw new ProviderInstallError(script, "its text is not a Cursor launcher this version of LetAgents knows.");
  return { ...cursorProgram(launcher, root, files), envAdditions: cursorEnvironment(launcher, env) };
}

/**
 * The real program behind the batch file `program`, whose text is `text`:
 * `{ file, args, envAdditions }`, or null for a batch file that is neither of
 * these installs. Throws ProviderInstallError for one that claims to be and
 * does not hold up, whether or not the caller allows cmd.exe, or the file
 * also has a line that reads as a script shim (`isNodeShim`): that reading
 * is loose, so it must not excuse a file from this one.
 */
export function windowsInstalledProgram(program, text, options = {}) {
  const files = {
    readFile: options.readFile ?? ((filePath) => readFileSync(filePath, "utf8")),
    exists: options.exists ?? isFile,
    realpath: options.realpath ?? realpathSync.native,
    readdir: options.readdir ?? ((folder) => readdirSync(folder, { withFileTypes: true })),
  };
  return npmNativeProgram(program, text, files)
    ?? cursorInstalledProgram(program, text, files, options.env ?? process.env, options.isNodeShim === true);
}
