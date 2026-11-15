import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Whether the module at `moduleUrl` is the process entry point (`argv1`).
 * Resolve the path as Node resolves its main module, then encode it as a URL.
 * Concatenating `file://` fails for Windows paths and for escaped characters
 * such as the space in `LetAgents Preview.app` on macOS.
 */
export function isDaemonEntryPoint(
  moduleUrl: string,
  argv1: string | undefined,
  _platform: NodeJS.Platform = process.platform,
  realpath: (path: string) => string = realpathSync,
): boolean {
  if (!argv1) return false;
  try { return moduleUrl === pathToFileURL(realpath(resolve(argv1))).href; }
  catch { return false; }
}
