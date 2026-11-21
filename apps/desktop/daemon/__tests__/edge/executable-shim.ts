import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  /** Override platform for unit testing shim generation. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Override Node executable path. Defaults to `process.execPath`. */
  nodeBin?: string;
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
  const targetUrl = pathToFileURL(resolvedScript).href;
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
  const command = [
    "exec",
    shellQuotePosix(nodeBin),
    ...nodeArgs.map(shellQuotePosix),
    shellQuotePosix(entryPath),
    '"$@"',
  ].join(" ");
  await writeFile(shimPath, `#!/bin/sh\nset -eu\n${command}\n`, { encoding: "utf8", mode: 0o755 });
  await chmod(shimPath, 0o755);
  return shimPath;
}
