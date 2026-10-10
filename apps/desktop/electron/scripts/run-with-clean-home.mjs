#!/usr/bin/env node
// Runs a command with HOME set to a new, empty folder. When the command ends,
// the script lists what it left below that folder and fails if anything is
// there, except for names on the allow list (npm's own cache by default).
//
//   node electron/scripts/run-with-clean-home.mjs [--allow <path>]... [--keep] -- <command> [args...]
//
// Why: a desktop test that writes to the real home folder (for example
// ~/.letagents/local-files) is easy to miss, because the test still passes.
// Tests isolate HOME themselves (see electron/__tests__/harness.ts), so a
// leftover here means a test or a new code path escaped that isolation.
//
// Exit status: the command's own status when it fails; 3 when it succeeds but
// leaves entries; 2 for a usage error; 0 otherwise.
import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const LEFTOVER_EXIT_STATUS = 3;
export const USAGE_EXIT_STATUS = 2;
/** npm writes its own cache and logs below HOME when the command starts with `npm`. */
export const DEFAULT_ALLOWED = [".npm"];

function isAllowed(relativePath, allowed) {
  return allowed.some((name) => relativePath === name || relativePath.startsWith(`${name}${sep}`));
}

/** Paths below `home`, relative to it, that are not allowed. Empty folders count. */
export function listLeftovers(home, allowed = DEFAULT_ALLOWED) {
  const found = [];
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const relativePath = prefix ? join(prefix, name) : name;
      if (isAllowed(relativePath, allowed)) continue;
      const path = join(directory, name);
      const isDirectory = lstatSync(path).isDirectory();
      if (isDirectory && readdirSync(path).length > 0) walk(path, relativePath);
      else found.push(relativePath);
    }
  };
  walk(home, "");
  return found;
}

export function parseArguments(argv) {
  const allowed = [...DEFAULT_ALLOWED];
  let keep = false;
  let index = 0;
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") { index += 1; break; }
    if (argument === "--keep") keep = true;
    else if (argument === "--allow" && argv[index + 1]) allowed.push(argv[(index += 1)]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  const command = argv.slice(index);
  if (command.length === 0) throw new Error("no command after --");
  return { allowed, keep, command };
}

function run(command, home) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: "inherit",
      env: { ...process.env, HOME: home, USERPROFILE: home },
      shell: process.platform === "win32",
    });
    const forward = (signal) => () => child.kill(signal);
    const handlers = ["SIGINT", "SIGTERM"].map((signal) => [signal, forward(signal)]);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const finish = (status) => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(status);
    };
    child.on("error", (error) => {
      console.error(`run-with-clean-home: cannot start ${command[0]}: ${error.message}`);
      finish(127);
    });
    child.on("close", (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`run-with-clean-home: ${error.message}`);
    console.error("usage: run-with-clean-home.mjs [--allow <path>]... [--keep] -- <command> [args...]");
    return USAGE_EXIT_STATUS;
  }
  const home = mkdtempSync(join(tmpdir(), "letagents-clean-home-"));
  try {
    const status = await run(options.command, home);
    const leftovers = listLeftovers(home, options.allowed);
    if (leftovers.length > 0) {
      console.error(`\nrun-with-clean-home: the command left ${leftovers.length} entr${leftovers.length === 1 ? "y" : "ies"} in its scratch HOME:`);
      for (const path of leftovers.slice(0, 40)) console.error(`  ${path}`);
      if (leftovers.length > 40) console.error(`  ... and ${leftovers.length - 40} more`);
      console.error("A test wrote below HOME. Use createElectronTestEnv, or import \"./isolated-home.js\" first (electron/__tests__).");
    }
    if (status !== 0) return status;
    return leftovers.length > 0 ? LEFTOVER_EXIT_STATUS : 0;
  } finally {
    if (options.keep) console.error(`run-with-clean-home: kept ${home}`);
    else rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
