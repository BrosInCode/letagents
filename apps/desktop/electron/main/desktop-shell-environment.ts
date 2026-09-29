import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const PATH_START = "__LETAGENTS_PATH_START__";
const PATH_END = "__LETAGENTS_PATH_END__";
const SHELL_ENV_TIMEOUT_MS = 5_000;

type CommandRunner = (command: string, args: string[]) => Promise<string>;

export interface DesktopShellEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  shell?: string | null;
  runCommand?: CommandRunner;
}

export interface DesktopShellEnvironmentRefresh {
  environment: NodeJS.ProcessEnv;
  changed: boolean;
}

let resolvedDesktopPath: string | null = null;
let initialHydration: Promise<DesktopShellEnvironmentRefresh> | null = null;
let activeHydration: Promise<DesktopShellEnvironmentRefresh> | null = null;

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      env: process.env,
      timeout: SHELL_ENV_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 512 * 1024,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || ""));
    });
    // Login shells must never wait for input from a GUI process.
    child.stdin?.end();
  });
}

function extractMarkedPath(output: string): string | null {
  const start = output.lastIndexOf(PATH_START);
  if (start < 0) return null;
  const valueStart = start + PATH_START.length;
  const end = output.indexOf(PATH_END, valueStart);
  if (end < 0) return null;
  const value = output.slice(valueStart, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "").trim();
  return value || null;
}

function splitPathEntries(value: string, pathDelimiter: string): string[] {
  if (pathDelimiter !== ";") return value.split(pathDelimiter);
  const entries: string[] = [];
  let entry = "";
  let quoted = false;
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    if (character === pathDelimiter && !quoted) {
      entries.push(entry);
      entry = "";
    } else {
      entry += character;
    }
  }
  entries.push(entry);
  return entries;
}

export function mergeDesktopPath(
  values: Array<string | null | undefined>,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const value of values) {
    for (const rawEntry of splitPathEntries(String(value || ""), pathDelimiter)) {
      const entry = rawEntry.trim();
      const unquoted = entry.startsWith('"') && entry.endsWith('"')
        ? entry.slice(1, -1)
        : entry;
      const key = platform === "win32" ? unquoted.toLowerCase() : unquoted;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries.join(pathDelimiter);
}

async function readPosixLoginShellPath(shell: string, runner: CommandRunner): Promise<string | null> {
  const output = await runner(shell, [
    "-ilc",
    `printf '%s\\n' '${PATH_START}'; printenv PATH || true; printf '%s\\n' '${PATH_END}'`,
  ]);
  return extractMarkedPath(output);
}

async function readWindowsPath(runner: CommandRunner): Promise<string | null> {
  const script = [
    `$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')`,
    `$user = [Environment]::GetEnvironmentVariable('Path', 'User')`,
    `Write-Output '${PATH_START}'`,
    `Write-Output (($machine, $user, $env:Path | Where-Object { $_ }) -join ';')`,
    `Write-Output '${PATH_END}'`,
  ].join("; ");
  for (const command of ["pwsh.exe", "powershell.exe"]) {
    try {
      const output = await runner(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
      const path = extractMarkedPath(output);
      if (path) return path;
    } catch {
      // Try the next installed PowerShell host.
    }
  }
  return null;
}

async function discoverDesktopPath(options: DesktopShellEnvironmentOptions): Promise<string> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const runner = options.runCommand ?? runCommand;
  let discoveredPath: string | null = null;

  if (platform === "win32") {
    discoveredPath = await readWindowsPath(runner).catch(() => null);
    return mergeDesktopPath([
      discoveredPath,
      env.APPDATA ? join(env.APPDATA, "npm") : null,
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs", "nodejs") : null,
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Volta", "bin") : null,
      join(homeDirectory, ".local", "bin"),
      join(homeDirectory, ".bun", "bin"),
      join(homeDirectory, "scoop", "shims"),
      env.PATH,
      env.Path,
      env.path,
    ], platform);
  }

  if (platform === "darwin" || platform === "linux") {
    const shells = [...new Set([
      options.shell?.trim(),
      env.SHELL?.trim(),
      platform === "darwin" ? "/bin/zsh" : "/bin/bash",
    ].filter((value): value is string => Boolean(value)))];
    for (const shell of shells) {
      try {
        discoveredPath = await readPosixLoginShellPath(shell, runner);
        if (discoveredPath) break;
      } catch {
        // Try the next shell candidate, then preserve the inherited PATH.
      }
    }
    return mergeDesktopPath([
      env.NVM_BIN,
      discoveredPath,
      join(homeDirectory, ".local", "bin"),
      join(homeDirectory, ".volta", "bin"),
      join(homeDirectory, ".bun", "bin"),
      platform === "darwin" ? "/opt/homebrew/bin" : null,
      "/usr/local/bin",
      env.PATH,
    ], platform);
  }

  return env.PATH || "";
}

export function desktopRuntimeEnvironment(
  base: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    ...(resolvedDesktopPath ? { PATH: resolvedDesktopPath } : {}),
  };
}

async function performHydration(options: DesktopShellEnvironmentOptions): Promise<DesktopShellEnvironmentRefresh> {
  const nextPath = await discoverDesktopPath(options);
  const changed = resolvedDesktopPath !== null && resolvedDesktopPath !== nextPath;
  resolvedDesktopPath = nextPath;
  return { environment: desktopRuntimeEnvironment(options.env), changed };
}

function runHydration(options: DesktopShellEnvironmentOptions): Promise<DesktopShellEnvironmentRefresh> {
  if (!activeHydration) {
    activeHydration = performHydration(options).finally(() => {
      activeHydration = null;
    });
  }
  return activeHydration;
}

/** Start one non-blocking initial import. Consumers may await the same promise. */
export function startDesktopShellEnvironmentHydration(
  options: DesktopShellEnvironmentOptions = {},
): Promise<DesktopShellEnvironmentRefresh> {
  if (!initialHydration) initialHydration = runHydration(options);
  return initialHydration;
}

/** Re-read the user's shell once, coalescing impatient repeated checks. */
export function refreshDesktopShellEnvironment(
  options: DesktopShellEnvironmentOptions = {},
): Promise<DesktopShellEnvironmentRefresh> {
  return runHydration(options);
}

export function desktopShellEnvironmentReady(): Promise<DesktopShellEnvironmentRefresh> {
  return startDesktopShellEnvironmentHydration();
}

/** Backward-compatible explicit hydration entrypoint. */
export function hydrateDesktopShellEnvironment(
  options: DesktopShellEnvironmentOptions = {},
): Promise<DesktopShellEnvironmentRefresh> {
  return refreshDesktopShellEnvironment(options);
}

export function resetDesktopShellEnvironmentForTests(): void {
  resolvedDesktopPath = null;
  initialHydration = null;
  activeHydration = null;
}
