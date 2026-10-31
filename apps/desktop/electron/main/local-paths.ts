import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/**
 * Folder paths typed by the user or printed by Git, read the way the current
 * operating system reads them. Every function takes `platform` so Windows
 * rules can be tested on any machine.
 */

export interface LocalPathOptions {
  platform?: NodeJS.Platform;
  home?: string;
}

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

/** `~`, `~/x`, and on Windows also `~\x`, become paths in the home folder. */
export function expandHomePath(path: string, options: LocalPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  if (path === "~") return home;
  const prefixed = path.startsWith("~/") || (platform === "win32" && path.startsWith("~\\"));
  return prefixed ? pathFor(platform).join(home, path.slice(2)) : path;
}

/**
 * Only a full path names one folder. On Windows that is a drive path
 * (`C:\work`) or a network path (`\\server\share`); `C:work` and `\work`
 * depend on the current drive and folder, so they are refused.
 */
export function isFullFolderPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return posix.isAbsolute(path);
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(path);
}

export function fullFolderPathHint(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? "Enter the full path to the folder, starting with a drive letter (C:\\), \\\\ or ~\\."
    : "Enter the full path to the folder, starting with / or ~/.";
}

/**
 * Git for Windows prints `C:/Users/me/repo`. Give it the separators and the
 * upper-case drive letter that Node and the folder picker use, so the same
 * folder is one string everywhere. Other platforms keep Git's output.
 */
export function normalizeGitPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32" || !path) return path;
  const resolved = win32.resolve(path);
  return /^[a-z]:/.test(resolved) ? resolved[0]!.toUpperCase() + resolved.slice(1) : resolved;
}

/**
 * Same folder? Windows resolves both paths and compares without case, as its
 * file systems do. Elsewhere the strings must match, as before.
 */
export function sameLocalPath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return left === right;
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/** One new folder name, or the sentence to show. Windows refuses more names. */
export function newFolderNameError(name: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!name || name === "." || name === ".." || /[\\/:\u0000-\u001f\u007f]/.test(name)) {
    return "Enter a folder name without slashes or control characters.";
  }
  if (platform === "win32" && (/[<>"|?*]/.test(name) || /[. ]$/.test(name) || WINDOWS_RESERVED_NAME.test(name))) {
    return "Enter a folder name that Windows allows: no < > \" | ? *, no dot or space at the end, and not a reserved name such as CON or NUL.";
  }
  return null;
}
