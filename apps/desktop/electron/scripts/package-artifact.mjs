import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const release = join(root, "release", "LetAgents-darwin");
const bundle = join(release, "LetAgents.app");
const app = join(bundle, "Contents", "Resources", "app");
await rm(release, { recursive: true, force: true });
await cp(join(root, "node_modules", "electron", "dist", "Electron.app"), bundle, { recursive: true });
await mkdir(app, { recursive: true });
for (const directory of ["dist-electron", "dist-daemon", "dist-renderer"]) {
  await cp(join(root, directory), join(app, directory), { recursive: true });
}
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await writeFile(join(app, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
await cp(join(root, "package-lock.json"), join(app, "package-lock.json"));
await promisify(execFile)("npm", ["ci", "--omit=dev", "--ignore-scripts", "--prefer-offline"], { cwd: app, maxBuffer: 8 * 1024 * 1024 });

const required = [
  "dist-electron/main.js",
  "dist-electron/main/agents/codex-provider-adapter.js",
  "dist-daemon/main.js",
  "dist-daemon/codex-provider-port.js",
  "dist-renderer/index.html",
  "node_modules/vue/package.json",
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
