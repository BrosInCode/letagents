import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runWithRetries } from "./retry-command.mjs";

// Each run appends one line to the counter file, then exits with the code
// listed for that run (the last code repeats).
function flakyCommand(counterFile, exitCodes) {
  const script = `
    const fs = require("node:fs");
    fs.appendFileSync(${JSON.stringify(counterFile)}, "run\\n");
    const runs = fs.readFileSync(${JSON.stringify(counterFile)}, "utf8").trim().split("\\n").length;
    const codes = ${JSON.stringify(exitCodes)};
    process.exit(codes[Math.min(runs, codes.length) - 1]);
  `;
  return [process.execPath, ["-e", script]];
}

function withCounter(callback) {
  const directory = mkdtempSync(path.join(tmpdir(), "retry-command-"));
  try {
    return callback(path.join(directory, "runs"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function runCount(counterFile) {
  return readFileSync(counterFile, "utf8").trim().split("\n").length;
}

test("a command that succeeds runs once", () => {
  withCounter((counter) => {
    const [command, args] = flakyCommand(counter, [0]);
    const messages = [];
    assert.equal(runWithRetries(command, args, { baseDelayMs: 0, log: (m) => messages.push(m) }), 0);
    assert.equal(runCount(counter), 1);
    assert.deepEqual(messages, []);
  });
});

test("a dropped connection is retried and the later success passes the step", () => {
  withCounter((counter) => {
    const [command, args] = flakyCommand(counter, [152, 0]);
    const messages = [];
    assert.equal(runWithRetries(command, args, { baseDelayMs: 0, log: (m) => messages.push(m) }), 0);
    assert.equal(runCount(counter), 2);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /exited with 152 \(attempt 1 of 3\)/);
  });
});

test("a command that keeps failing stops after the last attempt with its own exit code", () => {
  withCounter((counter) => {
    const [command, args] = flakyCommand(counter, [152, 152, 7]);
    assert.equal(runWithRetries(command, args, { baseDelayMs: 0, log: () => {} }), 7);
    assert.equal(runCount(counter), 3);
  });
});
