// Workspace authority discovery for supervised Cursor: project config directories,
// Git metadata read roots, submodule topology, and canonical sandbox paths.

import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitSpawnFile } from "../../../../../../shared/git-executable.mjs";
import { pathEntryExists, readRegularFileNoFollow } from "./profile-filesystem.js";
import { SUPERVISED_CURSOR_PROJECT_AUTHORITY_FILES } from "./profile-types.js";

export function cursorExactWorkspaceDirectory(workspaceRoot: string): string {
  const logicalWorkspace = resolve(workspaceRoot);
  const workspaceStat = lstatSync(logicalWorkspace);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error(`Cursor supervised workspace must be a real directory: ${logicalWorkspace}`);
  }
  return realpathSync(logicalWorkspace);
}

/**
 * Reject every Cursor-owned project file that can widen its effective
 * execution or extension policy. Cursor's hidden --disable-project-configs
 * flag covers the cli.json chain, but not project MCP discovery, so this check
 * is independently required and re-run before every native turn. Compatible
 * settings owned by other providers remain in place and are hidden by the
 * native sandbox instead.
 */
export function assertWorkspaceDoesNotConfigureSupervisedCursorAuthority(
  workspaceRoot: string,
  projectDirectories = cursorEffectiveProjectDirectories(workspaceRoot),
): void {
  for (const directory of projectDirectories) {
    for (const components of SUPERVISED_CURSOR_PROJECT_AUTHORITY_FILES) {
      const configPath = join(directory, ...components);
      if (!pathEntryExists(configPath)) continue;
      const relativeConfig = relative(resolve(workspaceRoot), configPath) || components.join("/");
      const kind = components.at(-1) === "mcp.json"
        ? "MCP"
        : components.at(-1)?.includes("cli") || components.at(-1) === "permissions.json"
          ? "permission"
          : "authority";
      throw new Error(
        `Cursor workspace ${kind} config is not allowed with supervised Cursor (${relativeConfig}). Remove it before starting the agent.`,
      );
    }
  }
}

/** Canonicalize the nearest existing parent without following the authority entry itself. */
export function canonicalizeAuthorityPath(path: string): string {
  const suffix = [dirname(path) === path ? "" : path.slice(dirname(path).length + 1)].filter(Boolean);
  let parent = dirname(path);
  for (;;) {
    try {
      const stat = lstatSync(parent);
      if (!stat.isDirectory()) {
        throw new Error(`Cursor authority parent is not a directory: ${parent}`);
      }
      return join(realpathSync(parent), ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      suffix.push(parent.slice(next.length + 1));
      parent = next;
    }
  }
}

/** Seatbelt regex/literal matching can observe either lexical or vnode paths. */
export function sandboxPathVariants(path: string): string[] {
  return [...new Set([resolve(path), canonicalizeAuthorityPath(path)])];
}

/**
 * The system's own final spelling of a path. Git and Node's realpathSync disagree on Windows where a
 * folder has an 8.3 short name (RUNNER~1): Git reports the long name. Two paths to compare, one of
 * them from Git, are compared in this form. Elsewhere it is realpathSync.
 */
function finalPath(path: string): string {
  return process.platform === "win32" ? realpathSync.native(path) : realpathSync(path);
}

/**
 * Windows: Git reports the long name of a folder (runneradmin) where the
 * workspace, canonicalized by Node's own realpath, may still hold its 8.3
 * short name (RUNNER~1). When the two roots differ only that
 * way, the project root is the workspace's own ancestor with the same
 * number of folders left over, in the workspace's own spelling. A root that
 * is not an ancestor by the system's final names is returned as it was, and
 * the caller's check then refuses it.
 */
function sameNameFormAncestor(projectRoot: string, workspace: string): string {
  if (!relative(projectRoot, workspace).startsWith("..")) return projectRoot;
  let rootFinal: string;
  let workspaceFinal: string;
  try {
    rootFinal = realpathSync.native(projectRoot);
    workspaceFinal = realpathSync.native(workspace);
  } catch {
    return projectRoot;
  }
  const rest = relative(rootFinal, workspaceFinal);
  if (rest.startsWith("..") || isAbsolute(rest)) return projectRoot;
  let ancestor = workspace;
  for (const _component of rest.split(/[\\/]+/).filter(Boolean)) ancestor = dirname(ancestor);
  return ancestor;
}

/** Cursor uses Git's resolved top-level, then walks root -> selected workspace. */
export function cursorEffectiveProjectDirectories(workspaceRoot: string): string[] {
  const workspace = cursorExactWorkspaceDirectory(workspaceRoot);
  let hasGitMarker = false;
  for (let cursor = workspace;; cursor = dirname(cursor)) {
    if (pathEntryExists(join(cursor, ".git"))) {
      hasGitMarker = true;
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
  }
  let projectRoot = workspace;
  if (hasGitMarker) {
    let reportedRoot: string;
    try {
      reportedRoot = execFileSync(
        gitSpawnFile(),
        ["-C", workspace, "rev-parse", "--show-toplevel"],
        {
          encoding: "utf8",
          timeout: 2_000,
          maxBuffer: 16 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.platform === "win32"
              ? process.env.PATH || ""
              : "/usr/bin:/bin:/usr/sbin:/sbin",
            HOME: workspace,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
          },
        },
      ).trim();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cursor could not resolve the workspace Git root safely: ${detail}`);
    }
    if (!reportedRoot) {
      throw new Error("Cursor resolved an empty workspace Git root.");
    }
    const logicalProjectRoot = resolve(workspace, reportedRoot);
    const projectRootStat = lstatSync(logicalProjectRoot);
    if (!projectRootStat.isDirectory() || projectRootStat.isSymbolicLink()) {
      throw new Error(`Cursor resolved Git root is not a real directory: ${logicalProjectRoot}`);
    }
    projectRoot = realpathSync(logicalProjectRoot);
    if (process.platform === "win32") projectRoot = sameNameFormAncestor(projectRoot, workspace);
  }
  const suffix = relative(projectRoot, workspace);
  if (suffix.startsWith("..") || resolve(projectRoot, suffix) !== workspace) {
    throw new Error("Cursor workspace escaped its resolved Git project root.");
  }
  const directories = [projectRoot];
  let cursor = projectRoot;
  for (const component of suffix.split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, component);
    directories.push(cursor);
  }
  return directories;
}

/** Resolve only Git's administrative directories, never the broader parent checkout. */
export function cursorGitMarkerPath(workspaceRoot: string): string | null {
  const workspace = realpathSync(resolve(workspaceRoot));
  for (let cursor = workspace;; cursor = dirname(cursor)) {
    if (pathEntryExists(join(cursor, ".git"))) {
      return join(cursor, ".git");
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
  }
  return null;
}

/** Resolve only Git's administrative directories, never the broader parent checkout. */
export function cursorGitMetadataReadRoots(workspaceRoot: string): string[] {
  const workspace = realpathSync(resolve(workspaceRoot));
  const gitMarker = cursorGitMarkerPath(workspace);
  if (!gitMarker) return [];
  let output: string;
  try {
    output = execFileSync(
      gitSpawnFile(),
      ["-C", workspace, "rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"],
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 32 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.platform === "win32"
            ? process.env.PATH || ""
            : "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: workspace,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
      },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cursor could not resolve Git metadata safely: ${detail}`);
  }
  const roots = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (roots.length !== 2) {
    throw new Error("Cursor resolved an ambiguous set of Git metadata roots.");
  }
  const canonicalRoots = roots.map((root) => {
    const logical = resolve(workspace, root);
    const stat = lstatSync(logical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Cursor Git metadata root is not a real directory: ${logical}`);
    }
    const canonical = realpathSync(logical);
    if (canonical === "/") throw new Error("Cursor refuses an unbounded Git metadata root.");
    return canonical;
  });
  const [gitDirectory, commonDirectory] = canonicalRoots;
  const markerStat = lstatSync(gitMarker);
  if (markerStat.isSymbolicLink()) {
    throw new Error("Cursor supervised Git marker may not be a symlink.");
  }
  if (markerStat.isDirectory()) {
    const markerDirectory = finalPath(gitMarker);
    for (const root of canonicalRoots.map(finalPath)) {
      const suffix = relative(markerDirectory, root);
      if (suffix.startsWith("..") || resolve(markerDirectory, suffix) !== root) {
        throw new Error("Cursor Git metadata escaped the selected repository marker.");
      }
    }
  } else if (markerStat.isFile()) {
    const markerText = readRegularFileNoFollow(gitMarker, 16 * 1024).toString("utf8").trim();
    const markerMatch = /^gitdir:\s*(.+)$/i.exec(markerText);
    if (!markerMatch) throw new Error("Cursor linked-worktree Git marker is invalid.");
    const markerGitDirectory = realpathSync(resolve(dirname(gitMarker), markerMatch[1]!));
    if (finalPath(markerGitDirectory) !== finalPath(gitDirectory!)) {
      throw new Error("Cursor linked-worktree Git metadata topology is invalid.");
    }
    if (dirname(dirname(gitDirectory)) === commonDirectory
      && dirname(gitDirectory) === join(commonDirectory, "worktrees")) {
      const backlinkPath = resolve(
        gitDirectory,
        readRegularFileNoFollow(join(gitDirectory, "gitdir"), 16 * 1024).toString("utf8").trim(),
      );
      if (finalPath(backlinkPath) !== finalPath(gitMarker)) {
        throw new Error("Cursor linked-worktree Git metadata does not point back to the selected worktree.");
      }
      const commondirPath = realpathSync(resolve(
        gitDirectory,
        readRegularFileNoFollow(join(gitDirectory, "commondir"), 16 * 1024).toString("utf8").trim(),
      ));
      if (finalPath(commondirPath) !== finalPath(commonDirectory!)) {
        throw new Error("Cursor linked-worktree common Git metadata is inconsistent.");
      }
    } else if (gitDirectory === commonDirectory) {
      assertCursorSubmoduleGitMetadataTopology(workspace, gitDirectory);
    } else {
      throw new Error("Cursor linked-worktree Git metadata topology is invalid.");
    }
  } else {
    throw new Error("Cursor supervised Git marker must be a file or directory.");
  }
  return [...new Set(canonicalRoots)];
}

function assertCursorSubmoduleGitMetadataTopology(workspace: string, gitDirectory: string): void {
  let reportedSuperproject: string;
  let configuredWorktree: string;
  try {
    const safeGitEnv = {
      PATH: process.platform === "win32"
        ? process.env.PATH || ""
        : "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: workspace,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    };
    reportedSuperproject = execFileSync(
      gitSpawnFile(),
      ["-C", workspace, "rev-parse", "--show-superproject-working-tree"],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 16 * 1024, stdio: ["ignore", "pipe", "pipe"], env: safeGitEnv },
    ).trim();
    configuredWorktree = execFileSync(
      gitSpawnFile(),
      ["config", "--file", join(gitDirectory, "config"), "--no-includes", "--type=path", "--get", "core.worktree"],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 16 * 1024, stdio: ["ignore", "pipe", "pipe"], env: safeGitEnv },
    ).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cursor could not validate submodule Git metadata safely: ${detail}`);
  }
  if (!reportedSuperproject || !configuredWorktree) {
    throw new Error("Cursor submodule Git metadata omitted its superproject or worktree binding.");
  }
  const superprojectStat = lstatSync(resolve(reportedSuperproject));
  if (!superprojectStat.isDirectory() || superprojectStat.isSymbolicLink()) {
    throw new Error("Cursor submodule superproject is not a real directory.");
  }
  const superproject = realpathSync(resolve(reportedSuperproject));
  const finalWorkspace = finalPath(workspace);
  if (finalPath(superproject) === finalWorkspace || !pathIsWithin(finalPath(superproject), finalWorkspace)) {
    throw new Error("Cursor submodule escaped its reported superproject.");
  }
  const resolvedWorktree = realpathSync(resolve(gitDirectory, configuredWorktree));
  if (finalPath(resolvedWorktree) !== finalWorkspace) {
    throw new Error("Cursor submodule Git metadata does not point back to the selected workspace.");
  }
  const superprojectMetadataRoots = cursorGitMetadataReadRoots(superproject);
  if (!superprojectMetadataRoots.some((root) => pathIsWithin(join(root, "modules"), gitDirectory))) {
    throw new Error("Cursor submodule Git metadata is outside its superproject modules namespace.");
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}
