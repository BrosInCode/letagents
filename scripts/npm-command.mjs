import { existsSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

// npm's own launchers (`npm` on POSIX, `npm.cmd` on Windows) run
// `node <npm-cli.js>`. This finds that file beside the running Node binary so
// a script can run npm with the plain `spawn` of a path and arguments: on
// Windows `spawn("npm")` finds nothing (the launcher is `npm.cmd`), and Node
// 20.12+/22 refuses `spawn("npm.cmd")` without a shell (EINVAL, CVE-2024-27980).
// When the file is not where either layout puts it, the launcher on PATH is
// used, through a shell on Windows.
export function resolveNpmCommand({
  execPath = process.execPath,
  platform = process.platform,
  exists = existsSync,
  realpath = realpathSync,
} = {}) {
  const { dirname, join } = platform === "win32" ? win32 : posix;
  const binaryDirs = [dirname(execPath)];
  try {
    const realDir = dirname(realpath(execPath));
    if (!binaryDirs.includes(realDir)) binaryDirs.push(realDir);
  } catch {
    // The binary itself is running; a failed realpath only loses one candidate.
  }
  for (const binaryDir of binaryDirs) {
    for (const candidate of [
      // Windows: <node dir>/node_modules/npm/bin/npm-cli.js
      join(binaryDir, "node_modules", "npm", "bin", "npm-cli.js"),
      // POSIX: <prefix>/bin/node and <prefix>/lib/node_modules/npm/bin/npm-cli.js
      join(binaryDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ]) {
      if (exists(candidate)) return { command: execPath, args: [candidate], shell: false };
    }
  }
  if (platform === "win32") return { command: "npm.cmd", args: [], shell: true };
  return { command: "npm", args: [], shell: false };
}
