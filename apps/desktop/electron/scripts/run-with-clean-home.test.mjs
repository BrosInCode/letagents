import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ALLOWED,
  LEFTOVER_EXIT_STATUS,
  USAGE_EXIT_STATUS,
  listLeftovers,
  parseArguments,
} from "./run-with-clean-home.mjs";

const script = fileURLToPath(new URL("./run-with-clean-home.mjs", import.meta.url));

/** Run the guard around `node -e <code>`; the code sees the guard's scratch HOME. */
function guard(code, options = []) {
  return spawnSync(process.execPath, [script, ...options, "--", process.execPath, "-e", code], {
    encoding: "utf8",
    env: { ...process.env, TEST_GUARD_PARENT_HOME: process.env.HOME ?? "" },
  });
}

const writeBelowHome = `
  const { mkdirSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  mkdirSync(join(process.env.HOME, ".letagents", "local-files", "a-room"), { recursive: true });
  writeFileSync(join(process.env.HOME, ".letagents", "local-files", "a-room", "note.txt"), "abc");
`;

test("a command that leaves HOME empty passes", () => {
  const result = guard("process.exit(0)");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("a command that writes below HOME fails and names the entry", () => {
  const result = guard(writeBelowHome);
  assert.equal(result.status, LEFTOVER_EXIT_STATUS);
  assert.match(result.stderr, /left 1 entry in its scratch HOME/);
  assert.match(result.stderr, new RegExp(`\\.letagents[/\\\\]local-files[/\\\\]a-room[/\\\\]note\\.txt`));
});

test("an empty folder that the command creates counts as a leftover", () => {
  const result = guard(`require("node:fs").mkdirSync(require("node:path").join(process.env.HOME, ".letagents"))`);
  assert.equal(result.status, LEFTOVER_EXIT_STATUS);
  assert.match(result.stderr, /\.letagents/);
});

test("npm's own folder is allowed, and --allow adds more names", () => {
  const writeNpm = `
    const { mkdirSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    mkdirSync(join(process.env.HOME, ".npm", "_logs"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".npm", "_logs", "debug.log"), "x");
  `;
  assert.equal(guard(writeNpm).status, 0);
  assert.equal(guard(writeBelowHome).status, LEFTOVER_EXIT_STATUS);
  assert.equal(guard(writeBelowHome, ["--allow", ".letagents"]).status, 0);
});

test("the command gets its own HOME, and the guard removes it afterwards", () => {
  const result = guard(`
    console.log(process.env.HOME);
    console.log(process.env.USERPROFILE);
    console.log(process.env.TEST_GUARD_PARENT_HOME);
  `);
  assert.equal(result.status, 0, result.stderr);
  const [home, profile, parentHome] = result.stdout.trim().split("\n");
  assert.equal(profile, home);
  assert.notEqual(home, parentHome, "the command must not see the caller's HOME");
  assert.match(home, /letagents-clean-home-/);
  assert.equal(existsSync(home), false, "the scratch HOME is removed");
});

test("--keep leaves the scratch HOME in place and says where", () => {
  const result = guard(`console.log(process.env.HOME)`, ["--keep"]);
  assert.equal(result.status, 0, result.stderr);
  const home = result.stdout.trim();
  try {
    assert.match(result.stderr, /kept /);
    assert.ok(existsSync(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failing command keeps its own status", () => {
  assert.equal(guard("process.exit(7)").status, 7);
  const leaked = guard(`${writeBelowHome}; process.exit(9)`);
  assert.equal(leaked.status, 9, "the command's failure wins over the leftover status");
  assert.match(leaked.stderr, /note\.txt/);
});

test("a missing command or a bad argument is a usage error", () => {
  const none = spawnSync(process.execPath, [script, "--"], { encoding: "utf8" });
  assert.equal(none.status, USAGE_EXIT_STATUS);
  assert.match(none.stderr, /no command/);
  const unknown = spawnSync(process.execPath, [script, "--nope", "--", "true"], { encoding: "utf8" });
  assert.equal(unknown.status, USAGE_EXIT_STATUS);
  assert.match(unknown.stderr, /unknown argument: --nope/);
  assert.deepEqual(parseArguments(["--allow", "x", "--", "a", "b"]).command, ["a", "b"]);
  assert.deepEqual(parseArguments(["--allow", "x", "--", "a"]).allowed, [...DEFAULT_ALLOWED, "x"]);
});

test("listLeftovers matches allowed names exactly, not by prefix", () => {
  const home = mkdtempSync(join(tmpdir(), "letagents-clean-home-unit-"));
  try {
    mkdirSync(join(home, ".npm", "_logs"), { recursive: true });
    writeFileSync(join(home, ".npm", "_logs", "a.log"), "x");
    writeFileSync(join(home, ".npmrc"), "x");
    mkdirSync(join(home, ".letagents", "empty"), { recursive: true });
    assert.deepEqual(listLeftovers(home), [join(".letagents", "empty"), ".npmrc"]);
    assert.deepEqual(listLeftovers(home, [".npm", ".npmrc", ".letagents"]), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
