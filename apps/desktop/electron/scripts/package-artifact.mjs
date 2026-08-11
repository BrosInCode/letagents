import { chmod, cp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { assertSquareImageDimensions, parseSipsDimensions } from "./packaging-validation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const release = join(root, "release", "LetAgents-darwin");
const bundle = join(release, "LetAgents.app");
const app = join(bundle, "Contents", "Resources", "app");
const contents = join(bundle, "Contents");
const resources = join(contents, "Resources");
const frameworks = join(contents, "Frameworks");
const bundleIdentifier = "chat.letagents.desktop";
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const workspacePackageJson = JSON.parse(await readFile(join(root, "..", "..", "package.json"), "utf8"));
const desktopVersion = packageJson.version;
const openCodeVersion = packageJson.letagentsRuntime?.openCodeVersion;
const mcpVersion = packageJson.letagentsRuntime?.mcpVersion;
const execFileAsync = promisify(execFile);
if (process.platform !== "darwin") throw new Error("The macOS application artifact must be built on macOS.");
if (typeof desktopVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(desktopVersion)) {
  throw new Error("package.json must declare a numeric x.y.z desktop version.");
}
if (typeof openCodeVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(openCodeVersion)) {
  throw new Error("package.json must declare letagentsRuntime.openCodeVersion.");
}
if (typeof mcpVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(mcpVersion)) {
  throw new Error("package.json must declare letagentsRuntime.mcpVersion.");
}

async function replacePlistString(plistPath, key, value) {
  await execFileAsync("plutil", ["-remove", key, plistPath]).catch(() => undefined);
  await execFileAsync("plutil", ["-insert", key, "-string", value, plistPath]);
}

async function removePlistKey(plistPath, key) {
  await execFileAsync("plutil", ["-remove", key, plistPath]).catch(() => undefined);
}

async function rebrandHelper({ qualifier = "", bundleIdSuffix = "" }) {
  const oldName = `Electron Helper${qualifier}`;
  const newName = `LetAgents Helper${qualifier}`;
  const oldBundle = join(frameworks, `${oldName}.app`);
  const newBundle = join(frameworks, `${newName}.app`);
  const plist = join(oldBundle, "Contents", "Info.plist");
  await rename(join(oldBundle, "Contents", "MacOS", oldName), join(oldBundle, "Contents", "MacOS", newName));
  await replacePlistString(plist, "CFBundleExecutable", newName);
  await replacePlistString(plist, "CFBundleName", newName);
  await replacePlistString(plist, "CFBundleDisplayName", newName);
  await replacePlistString(plist, "CFBundleIdentifier", `${bundleIdentifier}.helper${bundleIdSuffix}`);
  await rename(oldBundle, newBundle);
}

async function createApplicationIcon() {
  const source = join(root, "..", "..", "docs", "logo.png");
  const iconset = join(release, "LetAgents.iconset");
  const { stdout: sourceMetadata } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", source]);
  assertSquareImageDimensions(parseSipsDimensions(sourceMetadata), source);
  const iconFiles = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  await mkdir(iconset, { recursive: true });
  for (const [pixels, name] of iconFiles) {
    await execFileAsync("sips", ["-s", "format", "png", "-z", String(pixels), String(pixels), source, "--out", join(iconset, name)]);
  }
  await execFileAsync("iconutil", ["-c", "icns", "-o", join(resources, "letagents.icns"), iconset]);
  await rm(iconset, { recursive: true, force: true });
}

await rm(release, { recursive: true, force: true });
await cp(join(root, "node_modules", "electron", "dist", "Electron.app"), bundle, {
  recursive: true,
  verbatimSymlinks: true,
});

await rename(join(contents, "MacOS", "Electron"), join(contents, "MacOS", "LetAgents"));
await Promise.all([
  rebrandHelper({}),
  rebrandHelper({ qualifier: " (GPU)", bundleIdSuffix: ".GPU" }),
  rebrandHelper({ qualifier: " (Plugin)", bundleIdSuffix: ".Plugin" }),
  rebrandHelper({ qualifier: " (Renderer)", bundleIdSuffix: ".Renderer" }),
]);
const infoPlist = join(contents, "Info.plist");
for (const [key, value] of [
  ["CFBundleExecutable", "LetAgents"],
  ["CFBundleIdentifier", bundleIdentifier],
  ["CFBundleName", "LetAgents"],
  ["CFBundleDisplayName", "LetAgents"],
  ["CFBundleShortVersionString", desktopVersion],
  ["CFBundleVersion", desktopVersion],
  ["CFBundleIconFile", "letagents.icns"],
  ["LSApplicationCategoryType", "public.app-category.developer-tools"],
  ["NSUserNotificationAlertStyle", "alert"],
  ["NSHumanReadableCopyright", "Copyright © LetAgents"],
]) {
  await replacePlistString(infoPlist, key, value);
}
for (const key of [
  "NSAppTransportSecurity",
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
]) {
  await removePlistKey(infoPlist, key);
}
await createApplicationIcon();
await mkdir(app, { recursive: true });
for (const directory of ["dist-electron", "dist-daemon", "dist-renderer"]) {
  await cp(join(root, directory), join(app, directory), { recursive: true });
}
// Protocol/domain contracts are repository-neutral, but compiled desktop
// imports resolve them from Contents/shared in the packaged application.
await cp(join(root, "..", "..", "shared"), join(contents, "shared"), { recursive: true });
await writeFile(join(app, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
await cp(join(root, "package-lock.json"), join(app, "package-lock.json"));
await cp(join(root, "..", "..", "LICENSE"), join(app, "LICENSE"));
await execFileAsync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--prefer-offline"], { cwd: app, maxBuffer: 8 * 1024 * 1024 });
await rm(join(app, "node_modules", ".bin"), { recursive: true, force: true });
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
await execFileAsync("npm", [
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
  : await realpath((await execFileAsync("which", [requestedOpenCode])).stdout.trim());
const openCodeReportedVersion = (await execFileAsync(openCodePath, ["--version"])).stdout.trim();
if (!openCodeReportedVersion.includes(openCodeVersion)) {
  throw new Error(`Packaging requires OpenCode ${openCodeVersion}; found '${openCodeReportedVersion || "unknown"}'.`);
}
await mkdir(join(app, "runtime"), { recursive: true });
await cp(openCodePath, join(app, "runtime", "opencode"));
await chmod(join(app, "runtime", "opencode"), 0o755);

const requiredAppFiles = [
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
  "LICENSE",
  "node_modules/vue/package.json",
  "runtime/letagents/node_modules/letagents/dist/mcp/server.js",
  "runtime/letagents/node_modules/letagents/package.json",
  "runtime/letagents/package-lock.json",
  "runtime/opencode",
];
const required = [
  ...requiredAppFiles.map((relative) => ({
    absolutePath: join(app, relative),
    manifestPath: relative,
  })),
  ...[
    "shared/message-contracts.mjs",
    "shared/routing-aliases.mjs",
    "shared/sqlite-thread-routing.mjs",
  ].map((relative) => ({
    absolutePath: join(contents, relative),
    manifestPath: `Contents/${relative}`,
  })),
];
const files = [];
for (const entry of required) {
  const info = await stat(entry.absolutePath);
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Packaged runtime is missing ${entry.manifestPath}`);
  }
  const bytes = await readFile(entry.absolutePath);
  files.push({
    path: entry.manifestPath,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const packagedLocalStore = await import(pathToFileURL(join(
  app,
  "dist-electron",
  "main",
  "rooms",
  "messages",
  "local-store.js",
)).href);
if (typeof packagedLocalStore.addLocalChatMessage !== "function") {
  throw new Error("Packaged local chat failed to import its external shared contracts.");
}
await writeFile(join(app, "package-artifact-manifest.json"), `${JSON.stringify({
  format: 2,
  product: "LetAgents",
  version: desktopVersion,
  platform: process.platform,
  arch: process.arch,
  bundle: "LetAgents.app",
  bundleIdentifier,
  runtimeTreeSha256,
  files,
}, null, 2)}\n`);
console.log(JSON.stringify({ bundle, version: desktopVersion, platform: process.platform, arch: process.arch, required: files }, null, 2));
