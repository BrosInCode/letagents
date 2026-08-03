import { chmod, cp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const release = join(root, "release", "LetAgents-darwin");
const bundle = join(release, "LetAgents.app");
const app = join(bundle, "Contents", "Resources", "app");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const workspacePackageJson = JSON.parse(await readFile(join(root, "..", "..", "package.json"), "utf8"));
const openCodeVersion = packageJson.letagentsRuntime?.openCodeVersion;
const mcpVersion = packageJson.letagentsRuntime?.mcpVersion;
if (typeof openCodeVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(openCodeVersion)) {
  throw new Error("package.json must declare letagentsRuntime.openCodeVersion.");
}
if (typeof mcpVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(mcpVersion)) {
  throw new Error("package.json must declare letagentsRuntime.mcpVersion.");
}
await rm(release, { recursive: true, force: true });
await cp(join(root, "node_modules", "electron", "dist", "Electron.app"), bundle, { recursive: true });
await mkdir(app, { recursive: true });
for (const directory of ["dist-electron", "dist-daemon", "dist-renderer"]) {
  await cp(join(root, directory), join(app, directory), { recursive: true });
}
await writeFile(join(app, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
await cp(join(root, "package-lock.json"), join(app, "package-lock.json"));
await promisify(execFile)("npm", ["ci", "--omit=dev", "--ignore-scripts", "--prefer-offline"], { cwd: app, maxBuffer: 8 * 1024 * 1024 });
// Supervised Cursor must never download executable bridge code at turn time.
// Install the exact public MCP package into the desktop artifact under forced,
// credential-free npm configuration; runtime resolution validates its version
// and uses its absolute entrypoint directly.
const letAgentsRuntime = join(app, "runtime", "letagents");
const letAgentsRuntimeSource = join(root, "electron", "runtime", "letagents");
await mkdir(letAgentsRuntime, { recursive: true });
const runtimeUserConfig = join(letAgentsRuntime, "npm-userconfig");
const runtimeGlobalConfig = join(letAgentsRuntime, "npm-globalconfig");
await writeFile(runtimeUserConfig, "");
await writeFile(runtimeGlobalConfig, "");
const runtimePackage = JSON.parse(await readFile(join(letAgentsRuntimeSource, "package.json"), "utf8"));
if (runtimePackage.dependencies?.letagents !== mcpVersion) {
  throw new Error(`The locked desktop MCP runtime must depend on letagents@${mcpVersion}.`);
}
if (JSON.stringify(runtimePackage.overrides ?? {}) !== JSON.stringify(workspacePackageJson.overrides ?? {})) {
  throw new Error("The locked desktop MCP runtime must inherit the workspace dependency overrides exactly.");
}
await cp(join(letAgentsRuntimeSource, "package.json"), join(letAgentsRuntime, "package.json"));
await cp(join(letAgentsRuntimeSource, "package-lock.json"), join(letAgentsRuntime, "package-lock.json"));
await promisify(execFile)("npm", [
  "ci",
  "--omit=dev",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--registry=https://registry.npmjs.org/",
], {
  cwd: letAgentsRuntime,
  env: {
    ...process.env,
    NPM_CONFIG_GLOBALCONFIG: runtimeGlobalConfig,
    NPM_CONFIG_USERCONFIG: runtimeUserConfig,
  },
  maxBuffer: 8 * 1024 * 1024,
});
const runtimeNodeModules = join(letAgentsRuntime, "node_modules");
// npm's command shims and installation metadata are not required by the
// direct runtime entry and contain symlinks/version-dependent noise. The
// remaining complete tree is deterministic and sealed into the desktop code.
await rm(join(runtimeNodeModules, ".bin"), { recursive: true, force: true });
await rm(join(runtimeNodeModules, ".package-lock.json"), { force: true });
const installedMcpPackage = JSON.parse(await readFile(
  join(letAgentsRuntime, "node_modules", "letagents", "package.json"),
  "utf8",
));
if (installedMcpPackage.name !== "letagents" || installedMcpPackage.version !== mcpVersion) {
  throw new Error(`Packaging requires letagents@${mcpVersion}; found '${installedMcpPackage.name ?? "unknown"}@${installedMcpPackage.version ?? "unknown"}'.`);
}
const runtimeIntegrity = await import(pathToFileURL(join(
  root,
  "dist-electron",
  "main",
  "agents",
  "letagents-mcp-runtime.js",
)).href);
const runtimeTreeSha256 = runtimeIntegrity.computeLetAgentsMcpRuntimeTreeSha256(runtimeNodeModules);
if (runtimeTreeSha256 !== runtimeIntegrity.LETAGENTS_MCP_RUNTIME_TREE_SHA256) {
  throw new Error(
    `The locked LetAgents MCP runtime tree digest changed: expected ${runtimeIntegrity.LETAGENTS_MCP_RUNTIME_TREE_SHA256}, found ${runtimeTreeSha256}.`,
  );
}
const requestedOpenCode = process.env.LETAGENTS_OPENCODE_BIN?.trim() || "opencode";
const openCodePath = requestedOpenCode.includes("/")
  ? await realpath(requestedOpenCode)
  : (await promisify(execFile)("which", [requestedOpenCode])).stdout.trim();
const openCodeReportedVersion = (await promisify(execFile)(openCodePath, ["--version"])).stdout.trim();
if (!openCodeReportedVersion.includes(openCodeVersion)) {
  throw new Error(`Packaging requires OpenCode ${openCodeVersion}; found '${openCodeReportedVersion || "unknown"}'.`);
}
await mkdir(join(app, "runtime"), { recursive: true });
await cp(openCodePath, join(app, "runtime", "opencode"));
await chmod(join(app, "runtime", "opencode"), 0o755);

const required = [
  "dist-electron/main.js",
  "dist-electron/main/agents/codex-provider-adapter.js",
  "dist-electron/main/agents/claude-code-provider-adapter.js",
  "dist-electron/main/agents/cursor-provider-adapter.js",
  "dist-electron/main/agents/cursor-managed-profile.js",
  "dist-electron/main/agents/cursor-mcp-authority.js",
  "dist-electron/main/agents/letagents-mcp-runtime.js",
  "dist-electron/main/agents/open-model-provider-adapter.js",
  "dist-daemon/main.js",
  "dist-daemon/provider-action-port-router.js",
  "dist-renderer/index.html",
  "node_modules/vue/package.json",
  "runtime/letagents/node_modules/letagents/dist/mcp/server.js",
  "runtime/letagents/node_modules/letagents/package.json",
  "runtime/letagents/package-lock.json",
  "runtime/opencode",
];
const files = [];
for (const relative of required) {
  const path = join(app, relative);
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`Packaged runtime is missing ${relative}`);
  const bytes = await readFile(path);
  files.push({ path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(join(app, "package-artifact-manifest.json"), `${JSON.stringify({
  format: 1,
  bundle,
  runtimeTreeSha256,
  files,
}, null, 2)}\n`);
console.log(JSON.stringify({ bundle, app, required: files }, null, 2));
