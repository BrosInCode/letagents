import { existsSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export interface MaterializeNodeShimOptions {
  /**
   * Environment variables baked directly into the generated `.entry.mjs`
   * wrapper before importing `scriptPath`. Because they are applied in JS
   * inside the child process, they survive provider adapters that scrub
   * `process.env` (for example `minimalOpenCodeEnvironment` or
   * `withoutRoomAuthority`).
   */
  env?: Record<string, string>;
  /** Extra Node flags passed before the entry script (for example `["--import", "tsx"]`). */
  nodeArgs?: readonly string[];
  /**
   * Copy `scriptPath` into `binDir` and import the local copy. Useful for
   * sandboxed provider probes (such as Cursor) that can read only inside the
   * shim directory.
   */
  copyScript?: boolean;
  /** Override platform for unit testing shim generation. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * Override Node executable path. Defaults to `process.execPath`. POSIX only: a Windows shim names
   * `node`, and the daemon resolves that name to its own program (`parseNodeShim`).
   */
  nodeBin?: string;
}

/** Environment override: the program that runs the stand-in providers. */
export const EDGE_STAND_IN_RUNTIME_ENV = "LETAGENTS_EDGE_STAND_IN_RUNTIME";

function isScriptArgument(value: string): boolean {
  return /\.(?:c|m)?js$/i.test(value);
}

function locateProgram(command: string, env: NodeJS.ProcessEnv): string | null {
  if (isAbsolute(command) || command.includes("/") || command.includes(sep)) {
    const candidate = resolve(command);
    return existsSync(candidate) ? candidate : null;
  }
  for (const folder of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!folder) continue;
    const candidate = join(folder, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The program that must run the stand-in providers of a daemon.
 *
 * The daemon admits its own program (`process.execPath`) in the sandbox of a
 * provider check, and no other. A stand-in is a script, so it must run under
 * that same program. With the default daemon command that is the program of
 * the test process. With an overridden command that starts a script (a copy
 * of Node, or a packaged app in Node mode) it is the program of that command,
 * as the daemon sees it: an absolute path with links resolved. A command that
 * starts no script (a daemon in another language) cannot run a stand-in, so
 * the program of the test process stays.
 */
export function resolveStandInRuntime(
  daemonCommand: { command: string; args: readonly string[] },
  options: { execPath?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const explicit = env[EDGE_STAND_IN_RUNTIME_ENV]?.trim();
  if (explicit) return explicit;
  if (!daemonCommand.args.some(isScriptArgument)) return execPath;
  const located = locateProgram(daemonCommand.command, env);
  if (!located) return execPath;
  try {
    return realpathSync(located);
  } catch {
    return located;
  }
}

function shellQuotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stripBatchExtension(name: string): string {
  return name.replace(/\.(?:cmd|bat)$/i, "");
}

/**
 * Materialize a cross-platform executable shim in `binDir` that runs a Node
 * script.
 *
 * - Writes `<binDir>/<base>.entry.mjs` which installs any baked `env` values
 *   and imports `scriptPath`.
 * - On POSIX: writes `<binDir>/<base>` (mode 0755) invoking `nodeBin`.
 * - On Windows: writes `<binDir>/<base>.cmd` in the exact npm cmd-shim format
 *   that `shared/provider-executable.mjs` (`parseNodeShim`) unwraps directly to
 *   `node <entry.mjs> <args>` without `cmd.exe` (avoiding `ProviderBatchFileError`).
 *
 * Returns the exact executable path suitable for both PATH discovery and
 * provider binary env vars (`LETAGENTS_CODEX_BIN`, `LETAGENTS_OPENCODE_BIN`,
 * `LETAGENTS_CLAUDE_CODE_BIN`, `LETAGENTS_CURSOR_AGENT_BIN`).
 */
export async function materializeNodeShim(
  binDir: string,
  name: string,
  scriptPath: string,
  options: MaterializeNodeShimOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const nodeBin = options.nodeBin ?? process.execPath;
  const baseName = stripBatchExtension(name);
  const resolvedScript = resolve(scriptPath);
  const nodeArgs = options.nodeArgs ?? [];
  const bakedEnv = options.env ?? {};
  await mkdir(binDir, { recursive: true });

  const entryFileName = `${baseName}.entry.mjs`;
  const entryPath = join(binDir, entryFileName);
  let targetScript = resolvedScript;
  if (options.copyScript) {
    const ext = extname(resolvedScript) || ".mjs";
    targetScript = join(binDir, `${baseName}.script${ext}`);
    await copyFile(resolvedScript, targetScript);
  }
  const targetUrl = pathToFileURL(targetScript).href;
  const entrySource = [
    `const bakedEnv = ${JSON.stringify(bakedEnv)};`,
    "for (const [key, value] of Object.entries(bakedEnv)) {",
    "  if (process.env[key] === undefined) process.env[key] = value;",
    "}",
    `await import(${JSON.stringify(targetUrl)});`,
    "",
  ].join("\n");
  await writeFile(entryPath, entrySource, "utf8");

  if (platform === "win32") {
    const shimPath = join(binDir, `${baseName}.cmd`);
    const flagPart = nodeArgs.length > 0 ? ` ${nodeArgs.join(" ")} ` : "  ";
    // Matches SHIM_PROG_NODE and SHIM_LAUNCH_LINE in shared/codex-executable.mjs.
    const lines = [
      "@ECHO off",
      'SET "_prog=node"',
      `"%_prog%"${flagPart}"%dp0%\\${entryFileName}" %*`,
    ];
    await writeFile(shimPath, `${lines.join("\r\n")}\r\n`, "utf8");
    return shimPath;
  }

  const shimPath = join(binDir, baseName);
  // A runtime that is not the program of the test process can be a packaged app. It runs a script
  // only in Node mode, and the daemon does not pass its environment into each provider check.
  // The variable has no effect on a plain Node program.
  const nodeMode = nodeBin === process.execPath ? "" : "ELECTRON_RUN_AS_NODE=1\nexport ELECTRON_RUN_AS_NODE\n";
  const command = [
    "exec",
    shellQuotePosix(nodeBin),
    ...nodeArgs.map(shellQuotePosix),
    shellQuotePosix(entryPath),
    '"$@"',
  ].join(" ");
  await writeFile(shimPath, `#!/bin/sh\nset -eu\n${nodeMode}${command}\n`, { encoding: "utf8", mode: 0o755 });
  await chmod(shimPath, 0o755);
  return shimPath;
}
