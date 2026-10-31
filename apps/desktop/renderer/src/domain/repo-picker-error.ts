import { isWindowsPlatform } from "./local-path";
import { safeUserVisibleErrorDetail } from "./user-visible-error";

export const GIT_NOT_FOUND_WINDOWS_MESSAGE = "Git is not installed or not found. "
  + "Install Git for Windows from https://git-scm.com/download/win, then try again.";
export const GIT_NOT_FOUND_MESSAGE = "Git is not installed or not found. Install Git, then try again.";

// Node's error when the git program itself is missing: "spawn git ENOENT", or
// "spawn C:\...\git.exe ENOENT" for an absolute path.
const GIT_SPAWN_ENOENT = /\bspawn\s+(?:.*[\\/])?git(?:\.exe)?\s+ENOENT\b/i;

/**
 * The message a repo picker shows for a failed open: without Electron's
 * "Error invoking remote method …" prefix, and a missing Git as a step the
 * person can take instead of `spawn git ENOENT`.
 */
export function repoPickerErrorMessage(error: unknown, fallback: string, platform?: string | null): string {
  const detail = safeUserVisibleErrorDetail(error, fallback);
  if (!GIT_SPAWN_ENOENT.test(detail)) return detail;
  return isWindowsPlatform(platform) ? GIT_NOT_FOUND_WINDOWS_MESSAGE : GIT_NOT_FOUND_MESSAGE;
}
