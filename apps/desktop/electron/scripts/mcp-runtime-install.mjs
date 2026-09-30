import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The packaged LetAgents MCP runtime is installed from the committed lock at
 * `apps/desktop/electron/runtime/letagents` and sealed into the desktop code
 * as a digest of the whole installed tree. Packaging and CI install it the
 * same way, from here, so that what CI checks is what the release ships.
 */

/** The runtime lock must pin the desktop's declared MCP version and inherit the workspace overrides. */
export function assertLockedMcpRuntimeContract({ runtimePackage, workspacePackage, mcpVersion }) {
  if (runtimePackage.dependencies?.letagents !== mcpVersion) {
    throw new Error(`The locked desktop MCP runtime must depend on letagents@${mcpVersion}.`);
  }
  if (JSON.stringify(runtimePackage.overrides ?? {}) !== JSON.stringify(workspacePackage.overrides ?? {})) {
    throw new Error("The locked desktop MCP runtime must inherit the workspace dependency overrides exactly.");
  }
}

/**
 * Install the committed runtime lock into `destination` under forced,
 * credential-free npm configuration, and strip what the digest excludes:
 * npm's command shims and installation metadata contain symlinks and
 * version-dependent noise, and the direct runtime entry needs neither.
 * Returns the installed node_modules path.
 */
export async function installLockedMcpRuntime({ runtimeSource, destination, env = process.env }) {
  await mkdir(destination, { recursive: true });
  const userConfig = join(destination, "npm-userconfig");
  const globalConfig = join(destination, "npm-globalconfig");
  await writeFile(userConfig, "");
  await writeFile(globalConfig, "");
  await cp(join(runtimeSource, "package.json"), join(destination, "package.json"));
  await cp(join(runtimeSource, "package-lock.json"), join(destination, "package-lock.json"));
  await execFileAsync("npm", [
    "ci",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry=https://registry.npmjs.org/",
  ], {
    cwd: destination,
    env: { ...env, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_USERCONFIG: userConfig },
    maxBuffer: 8 * 1024 * 1024,
  });
  const nodeModules = join(destination, "node_modules");
  await rm(join(nodeModules, ".bin"), { recursive: true, force: true });
  await rm(join(nodeModules, ".package-lock.json"), { force: true });
  return nodeModules;
}

/** The installed package must be the exact MCP version the desktop declares. */
export async function assertInstalledMcpPackage(nodeModules, mcpVersion) {
  const installed = JSON.parse(await readFile(join(nodeModules, "letagents", "package.json"), "utf8"));
  if (installed.name !== "letagents" || installed.version !== mcpVersion) {
    throw new Error(`Packaging requires letagents@${mcpVersion}; found '${installed.name ?? "unknown"}@${installed.version ?? "unknown"}'.`);
  }
}

/**
 * Install the lock and digest the tree, then compare with the sealed value.
 * `install` and `computeTreeSha256` are the real ones unless a test says
 * otherwise. Returns what was found either way; the caller decides how loud
 * a mismatch is.
 */
export async function verifyLockedMcpRuntimeDigest({
  runtimeSource,
  workspacePackage,
  mcpVersion,
  destination,
  sealedDigest,
  computeTreeSha256,
  install = installLockedMcpRuntime,
}) {
  const runtimePackage = JSON.parse(await readFile(join(runtimeSource, "package.json"), "utf8"));
  assertLockedMcpRuntimeContract({ runtimePackage, workspacePackage, mcpVersion });
  const nodeModules = await install({ runtimeSource, destination });
  await assertInstalledMcpPackage(nodeModules, mcpVersion);
  const found = computeTreeSha256(nodeModules);
  return { ok: found === sealedDigest, expected: sealedDigest, found };
}
