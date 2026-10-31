import { execSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { currentSessionScope, requireScopeWhenHosted } from "./runtime/session-scope.js";

/** What `git rev-parse --show-toplevel` printed for a directory. */
export type GitTopLevelReader = (dir: string) => string;

const readGitTopLevel: GitTopLevelReader = (dir) =>
  execSync("git rev-parse --show-toplevel", {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
  });

export function resolveGitRoot(dir: string, readTopLevel: GitTopLevelReader = readGitTopLevel): string | null {
  // A remote session has no checkout on the API server.
  if (currentSessionScope()) return null;
  requireScopeWhenHosted("git");
  try {
    const root = readTopLevel(dir).trim();
    // git prints the root with forward slashes on every platform (`C:/x/y` on
    // Windows); callers join and compare native paths, so return that form.
    return root ? resolve(root) : null;
  } catch {
    return null;
  }
}

export function findExistingConfig(startDir: string): string | null {
  if (currentSessionScope()) return null;
  let current = startDir;
  while (true) {
    if (existsSync(join(current, ".letagents.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
