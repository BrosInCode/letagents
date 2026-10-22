import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Where the Codex executable is and how to start it. Shared by the desktop
// and the published MCP package, so it uses nothing but Node, and every input
// (env, platform, home, file checks) can be injected for tests.

function pathFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

// On Windows access(X_OK) only checks that the path exists, so a file is required too.
function isExecutableFile(filePath) {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function executableNames(platform, env) {
  if (platform !== "win32") return ["codex"];
  // Only names with a PATHEXT extension, as cmd.exe resolves them: npm writes
  // an extensionless `codex` sh script beside `codex.cmd`, which must not win.
  const extensions = (env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  return extensions.map((extension) => `codex${extension}`);
}

function resolveFromPath(env, platform, isExecutable) {
  const pathDelimiter = platform === "win32" ? ";" : path.posix.delimiter;
  const pathEntries = (env.PATH || "").split(pathDelimiter).filter(Boolean);
  for (const entry of pathEntries) {
    for (const name of executableNames(platform, env)) {
      const candidate = pathFor(platform).resolve(entry, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** Where the official Codex installer puts the standalone binary. */
export function installedCodexExecutablePath(options = {}) {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const { join } = pathFor(platform);
  const defaultInstallDirectory = platform === "win32"
    ? join(env.LOCALAPPDATA?.trim() || join(homeDirectory, "AppData", "Local"), "Programs", "OpenAI", "Codex", "bin")
    : join(homeDirectory, ".local", "bin");
  const installDirectory = env.CODEX_INSTALL_DIR?.trim() || defaultInstallDirectory;
  return join(installDirectory, platform === "win32" ? "codex.exe" : "codex");
}

/**
 * Resolve the exact Codex executable used by checks and launches.
 *
 * PATH remains ahead of the standalone fallback so an existing npm, Homebrew,
 * or custom installation keeps the same precedence it has in the user's
 * terminal. The fallback covers the official installer when the already-
 * running process has not inherited its newly-added PATH entry. On Windows
 * the PATH walk honours PATHEXT, so an npm-installed `codex.cmd` is found.
 */
export function resolveCodexExecutable(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isExecutable = options.isExecutable ?? isExecutableFile;
  const configured = env.LETAGENTS_CODEX_BIN?.trim();
  if (configured) return configured;

  const fromPath = resolveFromPath(env, platform, isExecutable);
  if (fromPath) return fromPath;

  const installed = installedCodexExecutablePath(options);
  if (isExecutable(installed)) return installed;

  const homeDirectory = options.homeDirectory ?? homedir();
  const commonCandidates = platform === "win32"
    ? []
    : [
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        path.posix.join(homeDirectory, ".volta", "bin", "codex"),
      ];
  return commonCandidates.find(isExecutable) ?? "codex";
}

/** True when the executable is a Windows batch script (`codex.cmd` from npm, or a `.bat`). */
export function isWindowsBatchExecutable(executable, platform = process.platform) {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
}

// The last line of an npm (cmd-shim) or pnpm shim. Current cmd-shim writes
//   "%_prog%" <shebang args> "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
// after `SET "_prog=%dp0%\node.exe"` or `SET "_prog=node"`; older shims wrote
//   "%~dp0\node.exe" "%~dp0\node_modules\...\codex.js" %*   or
//   node "%~dp0\node_modules\...\codex.js" %*
const SHIM_LAUNCH_LINE = /(?:^\s*|&\s*)("%_prog%"|"%~dp0\\node(?:\.exe)?"|node(?:\.exe)?)\s+(.*?)\s*"%(?:~)?dp0%?\\([^"]+\.(?:c|m)?js)"\s+%\*\s*$/i;
const SHIM_PROG_NODE = /^\s*SET\s+"_prog=(?:%dp0%\\node\.exe|node)"\s*$/im;

/**
 * The `node <script.js>` command an npm or pnpm `.cmd` shim runs, or null
 * when the file is some other batch script. Pure: the shim text is given.
 */
export function parseNodeShim(shimPath, shimText, options = {}) {
  const { dirname, join } = path.win32;
  const line = shimText.split(/\r?\n/).find((entry) => SHIM_LAUNCH_LINE.test(entry));
  const match = line ? SHIM_LAUNCH_LINE.exec(line) : null;
  if (!match) return null;
  const [, program, shebangArgs, relativeScript] = match;
  if (/^"%_prog%"$/i.test(program) && !SHIM_PROG_NODE.test(shimText)) return null;
  const shimDirectory = dirname(shimPath);
  const localNode = join(shimDirectory, "node.exe");
  const exists = options.exists ?? existsSync;
  const node = exists(localNode) ? localNode : (options.execPath ?? process.execPath);
  return {
    file: node,
    args: [...shebangArgs.split(/\s+/).filter(Boolean), join(shimDirectory, relativeScript)],
  };
}

/** `%` for a cmd.exe command line: expands back to one `%` (see quoteCmdBatchArgument). */
const CMD_PERCENT = "%%cd:~0,0%";

/**
 * A Windows system program by absolute path. A bare name would be searched
 * in the current directory first, which is the user's repository, so a file
 * named taskkill.exe or cmd.exe in a clone must never be what runs.
 */
export function windowsSystemExecutable(name, env = process.env) {
  const systemRoot = env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", name);
}

const NO_CMD_SAFE_QUOTE = "LetAgents cannot pass an argument that contains a double quote through cmd.exe to a batch file, "
  + "because cmd.exe reads the quote as the end of the argument. Install Codex with npm, or point LETAGENTS_CODEX_BIN at codex.exe.";

/**
 * One argument for `cmd.exe /d /s /c "<line>"` that starts a batch file.
 *
 * cmd.exe expands `%NAME%` before it reads quotes, and the batch file parses
 * its `%*` a second time, so the only characters that stay literal through
 * both passes are those inside double quotes. Every argument is therefore
 * quoted. A `%` becomes `%%cd:~0,0%`: the first `%` has no closing name and
 * stays, and `%cd:~0,0%` is a zero-length slice of the always-set CD
 * variable (an extensions feature, hence /e:on), so the command line
 * expands it back to one `%` and the batch file gets `%`. Rust's standard
 * library starts batch files the same way.
 * A double quote inside an argument would end the quoted span for cmd.exe
 * and cannot be escaped on both passes, so it is refused. Node's C runtime
 * reads backslashes before the closing quote as escapes, so those double.
 */
export function quoteCmdBatchArgument(argument) {
  if (/[\r\n]/.test(argument)) {
    throw new Error("LetAgents cannot pass an argument with a line break through cmd.exe to a batch file.");
  }
  if (argument.includes('"')) throw new Error(NO_CMD_SAFE_QUOTE);
  const body = argument.replace(/%/g, CMD_PERCENT);
  const trailingBackslashes = /\\+$/.exec(body)?.[0] ?? "";
  return `"${body}${trailingBackslashes}"`;
}

/**
 * What to spawn for `codex <args>`: on POSIX exactly the given executable and
 * arguments. On Windows a `.cmd` or `.bat` cannot be spawned directly (Node
 * refuses with EINVAL), so an npm or pnpm shim is replaced by the
 * `node <script.js>` it would run. That is chosen over cmd.exe because Node
 * then quotes the arguments itself and every argument (quotes, `%`, `^`,
 * spaces) arrives unchanged, and no console window exists. Only a batch file
 * that is not such a shim goes through cmd.exe, with the restrictions of
 * `quoteCmdBatchArgument`.
 */
export function codexLaunchCommand(executable, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (!isWindowsBatchExecutable(executable, platform)) {
    return { file: executable, args: [...args] };
  }
  const readFile = options.readFile ?? ((filePath) => readFileSync(filePath, "utf8"));
  let shimText = null;
  try {
    shimText = readFile(executable);
  } catch {
    // Not readable: run it as a batch file below.
  }
  const shim = shimText === null ? null : parseNodeShim(executable, shimText, options);
  if (shim) return { file: shim.file, args: [...shim.args, ...args] };

  const env = options.env ?? process.env;
  const comSpec = env.ComSpec?.trim() || windowsSystemExecutable("cmd.exe", env);
  const line = [executable, ...args].map(quoteCmdBatchArgument).join(" ");
  return {
    file: comSpec,
    // Verbatim arguments are joined as given, so argv[0] is quoted here.
    argv0: `"${comSpec}"`,
    // /d: no AutoRun; /e:on: command extensions, which the `%cd:~0,0%`
    // rewrite needs, whatever the registry says; /v:off: no delayed `!NAME!`
    // expansion; /s: strip exactly the outer quotes of the /c string.
    args: ["/d", "/e:on", "/v:off", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * `spawn` for Codex: resolves batch files on Windows and never opens a
 * console window. `launchOptions` are those of `codexLaunchCommand`; in
 * Electron pass `execPath` of a real Node (or set ELECTRON_RUN_AS_NODE), as
 * `process.execPath` there is Electron itself.
 */
export function spawnCodex(executable, args, spawnOptions = {}, launchOptions = {}) {
  const launch = codexLaunchCommand(executable, args, launchOptions);
  return spawn(launch.file, launch.args, {
    ...spawnOptions,
    windowsHide: true,
    ...(launch.argv0 ? { argv0: launch.argv0 } : {}),
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

/**
 * Stops a Codex process and what it started. On Windows the spawned pid is
 * the shim's node.exe or cmd.exe and killing it alone leaves the native
 * Codex running, so the whole tree is ended with taskkill. Elsewhere the
 * caller's own group or pid signal is used. Returns true when taskkill ran.
 *
 * Pass the ChildProcess as `child` when there is one: while Node holds its
 * process handle Windows does not reuse the pid, and once the child has
 * exited the pid may belong to a stranger, so taskkill is then not run.
 * A caller that only has a stored pid (an app-server from an earlier run
 * of this process) cannot make that check and says so at its call.
 */
export function terminateCodexProcessTree(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !pid) return false;
  const child = options.child;
  if (child && (child.exitCode !== null || child.signalCode !== null)) return false;
  const run = options.runSync ?? ((file, args) => spawnSync(file, args, { stdio: "ignore", windowsHide: true }));
  const result = run(windowsSystemExecutable("taskkill.exe", options.env ?? process.env), ["/pid", String(pid), "/T", "/F"]);
  return !result?.error;
}
