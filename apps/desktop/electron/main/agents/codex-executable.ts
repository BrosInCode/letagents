import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export interface CodexExecutableResolutionOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNames(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== "win32") return ["codex"];
  const extensions = (env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  return ["codex", ...extensions.map((extension) => `codex${extension}`)];
}

function resolveFromPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const pathEntries = (env.PATH || "").split(pathDelimiter).filter(Boolean);
  for (const entry of pathEntries) {
    for (const name of executableNames(platform, env)) {
      const candidate = resolve(entry, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export function installedCodexExecutablePath(
  options: CodexExecutableResolutionOptions = {},
): string {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const defaultInstallDirectory = platform === "win32"
    ? join(env.LOCALAPPDATA?.trim() || join(homeDirectory, "AppData", "Local"), "Programs", "OpenAI", "Codex", "bin")
    : join(homeDirectory, ".local", "bin");
  const installDirectory = env.CODEX_INSTALL_DIR?.trim() || defaultInstallDirectory;
  return join(installDirectory, platform === "win32" ? "codex.exe" : "codex");
}

/**
 * Resolve the exact Codex executable used by desktop checks and launches.
 *
 * PATH remains ahead of the standalone fallback so an existing npm, Homebrew,
 * or custom installation keeps the same precedence it has in the user's
 * terminal. The fallback covers the official installer when the already-
 * running Electron process has not inherited its newly-added PATH entry.
 */
export function resolveCodexExecutable(
  options: CodexExecutableResolutionOptions = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configured = env.LETAGENTS_CODEX_BIN?.trim();
  if (configured) return configured;

  const fromPath = resolveFromPath(env, platform);
  if (fromPath) return fromPath;

  const installed = installedCodexExecutablePath(options);
  if (isExecutable(installed)) return installed;

  const homeDirectory = options.homeDirectory ?? homedir();
  const commonCandidates = platform === "win32"
    ? []
    : [
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        join(homeDirectory, ".volta", "bin", "codex"),
      ];
  return commonCandidates.find(isExecutable) ?? "codex";
}
