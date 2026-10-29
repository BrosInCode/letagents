import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Whether the module at `moduleUrl` is the process entry point (`argv1`).
 * POSIX keeps the plain comparison. On Windows `file://C:\…` never equals a
 * module URL (`file:///C:/…`), so the entry path is resolved the way Node
 * resolves its main module (absolute, then real path) and turned into a URL.
 */
export function isDaemonEntryPoint(
  moduleUrl: string,
  argv1: string | undefined,
  platform: NodeJS.Platform = process.platform,
  realpath: (path: string) => string = realpathSync,
): boolean {
  if (!argv1) return false;
  if (platform !== "win32") return moduleUrl === `file://${argv1}`;
  try { return moduleUrl === pathToFileURL(realpath(resolve(argv1))).href; }
  catch { return false; }
}
