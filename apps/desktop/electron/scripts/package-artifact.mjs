import { chmod, cp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const release = join(root, "release", "LetAgents-darwin");
const bundle = join(release, "LetAgents.app");
const app = join(bundle, "Contents", "Resources", "app");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const openCodeVersion = packageJson.letagentsRuntime?.openCodeVersion;
if (typeof openCodeVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(openCodeVersion)) {
  throw new Error("package.json must declare letagentsRuntime.openCodeVersion.");
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
  "dist-electron/main/agents/open-model-provider-adapter.js",
  "dist-daemon/main.js",
  "dist-daemon/provider-action-port-router.js",
  "dist-renderer/index.html",
  "node_modules/vue/package.json",
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
await writeFile(join(app, "package-artifact-manifest.json"), `${JSON.stringify({ format: 1, bundle, files }, null, 2)}\n`);
console.log(JSON.stringify({ bundle, app, required: files }, null, 2));
