import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { resolveNpmCommand } from "./npm-command.mjs";

// path.join writes the separator of the platform the test runs on, so the
// fixtures compare with forward slashes everywhere.
const slashes = (path) => path.replaceAll("\\", "/");
const layout = (...paths) => {
  const files = new Set(paths);
  return (path) => files.has(slashes(path));
};
const posixLayout = layout("/opt/node/lib/node_modules/npm/bin/npm-cli.js");
const windowsLayout = layout("C:/node/node_modules/npm/bin/npm-cli.js");

test("npm runs as node plus the npm-cli.js that ships with it", () => {
  const posix = resolveNpmCommand({
    execPath: "/opt/node/bin/node",
    platform: "linux",
    exists: posixLayout,
    realpath: (path) => path,
  });
  assert.equal(posix.command, "/opt/node/bin/node");
  assert.deepEqual(posix.args.map(slashes), ["/opt/node/lib/node_modules/npm/bin/npm-cli.js"]);
  assert.equal(posix.shell, false);

  const windows = resolveNpmCommand({
    execPath: "C:\\node\\node.exe",
    platform: "win32",
    exists: windowsLayout,
    realpath: (path) => path,
  });
  assert.equal(windows.command, "C:\\node\\node.exe");
  assert.deepEqual(windows.args.map(slashes), ["C:/node/node_modules/npm/bin/npm-cli.js"]);
  assert.equal(windows.shell, false);
});

test("a symlinked node binary is followed to its real install", () => {
  const resolved = resolveNpmCommand({
    execPath: "/usr/local/bin/node",
    platform: "darwin",
    exists: posixLayout,
    realpath: (path) => (path === "/usr/local/bin/node" ? "/opt/node/bin/node" : path),
  });
  assert.deepEqual(resolved.args.map(slashes), ["/opt/node/lib/node_modules/npm/bin/npm-cli.js"]);
});

test("without npm-cli.js the launcher on PATH is used, through a shell only on Windows", () => {
  const none = () => false;
  assert.deepEqual(
    resolveNpmCommand({ execPath: "/opt/node/bin/node", platform: "linux", exists: none, realpath: (p) => p }),
    { command: "npm", args: [], shell: false },
  );
  assert.deepEqual(
    resolveNpmCommand({ execPath: "C:\\node\\node.exe", platform: "win32", exists: none, realpath: (p) => p }),
    { command: "npm.cmd", args: [], shell: true },
  );
});

test("the resolved command runs the real npm", () => {
  const { command, args, shell } = resolveNpmCommand();
  const result = spawnSync(command, [...args, "--version"], { encoding: "utf8", shell });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});
