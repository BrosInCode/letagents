import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { npmInvocation, resolveNpmCommand } from "./npm-command.mjs";

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

test("on Windows an npm.cmd on PATH lends its npm-cli.js to the running node", () => {
  const onPath = layout("C:/Program Files/nodejs/npm.cmd", "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js");
  const resolved = resolveNpmCommand({
    execPath: "C:\\Tools\\node\\node.exe",
    platform: "win32",
    env: { PATH: "C:\\Windows\\system32;C:\\Program Files\\nodejs" },
    exists: onPath,
    realpath: (path) => path,
  });
  assert.equal(resolved.command, "C:\\Tools\\node\\node.exe");
  assert.deepEqual(resolved.args.map(slashes), ["C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js"]);
  assert.equal(resolved.shell, false);
});

test("without any npm-cli.js the launcher on PATH is used, through a shell only on Windows", () => {
  const none = () => false;
  assert.deepEqual(
    resolveNpmCommand({ execPath: "/opt/node/bin/node", platform: "linux", exists: none, realpath: (p) => p }),
    { command: "npm", args: [], shell: false },
  );
  assert.deepEqual(
    resolveNpmCommand({ execPath: "C:\\node\\node.exe", platform: "win32", env: { PATH: "C:\\x" }, exists: none, realpath: (p) => p }),
    { command: "npm.cmd", args: [], shell: true },
  );
});

test("the resolved command runs the real npm", () => {
  const { command, args, options } = npmInvocation(["--version"]);
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("the cmd.exe fallback quotes every argument, so a path with a space arrives whole", () => {
  const fallback = { command: "npm.cmd", args: [], shell: true };
  const spawn = npmInvocation(["ci", "--prefix", "C:\\Users\\Jane Doe\\repo\\apps\\desktop", "100%"], fallback, { ComSpec: "C:\\Windows\\System32\\cmd.exe" });
  assert.equal(spawn.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(spawn.args.slice(0, 5), ["/d", "/e:on", "/v:off", "/s", "/c"]);
  assert.equal(spawn.args[5], '""npm.cmd" "ci" "--prefix" "C:\\Users\\Jane Doe\\repo\\apps\\desktop" "100%%cd:~0,0%""');
  assert.deepEqual(spawn.options, { argv0: '"C:\\Windows\\System32\\cmd.exe"', windowsVerbatimArguments: true });
  assert.throws(() => npmInvocation(['say "hi"'], fallback, {}), /double quote/);
  const direct = npmInvocation(["--version"], { command: "/opt/node/bin/node", args: ["/opt/node/lib/node_modules/npm/bin/npm-cli.js"], shell: false });
  assert.deepEqual(direct, { command: "/opt/node/bin/node", args: ["/opt/node/lib/node_modules/npm/bin/npm-cli.js", "--version"], options: {} });
});
