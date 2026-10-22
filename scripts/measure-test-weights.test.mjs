import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { mergeWeights, parseArgs } from "./measure-test-weights.mjs";

const script = path.resolve("scripts/measure-test-weights.mjs");

test("the arguments name the output, the folder, the command and the files", () => {
  assert.deepEqual(parseArgs(["--out", "w.json", "--cwd", "apps/desktop", "--run", "npm run t --", "a.ts", "b.ts"]), {
    out: "w.json",
    cwd: "apps/desktop",
    run: "npm run t --",
    files: ["a.ts", "b.ts"],
  });
  assert.throws(() => parseArgs(["--out", "w.json", "a.ts"]), /Usage/);
  assert.throws(() => parseArgs(["--out"]), /needs a value/);
});

test("new measurements replace old ones, round to whole seconds, never drop below one, and sort by name", () => {
  assert.deepEqual(mergeWeights({ "z.ts": 9, "a.ts": 2 }, { "z.ts": 3.4, "m.ts": 0.2 }), {
    "a.ts": 2,
    "m.ts": 1,
    "z.ts": 3,
  });
});

test("the command times each file alone and writes the weights file", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "measure-test-weights-"));
  try {
    writeFileSync(path.join(directory, "fast.mjs"), "");
    writeFileSync(path.join(directory, "slow.mjs"), "await new Promise((r) => setTimeout(r, 1200));");
    const out = path.join(directory, "weights.json");
    writeFileSync(out, JSON.stringify({ "old.mjs": 7 }));
    execFileSync(
      process.execPath,
      [script, "--out", out, "--cwd", directory, "--run", process.execPath, "fast.mjs", "slow.mjs"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const weights = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(Object.keys(weights), ["fast.mjs", "old.mjs", "slow.mjs"]);
    assert.equal(weights["old.mjs"], 7);
    assert.ok(weights["fast.mjs"] >= 1 && weights["fast.mjs"] <= weights["slow.mjs"]);
    assert.ok(weights["slow.mjs"] >= 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupt weights file stops the run instead of being replaced", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "measure-test-weights-corrupt-"));
  try {
    writeFileSync(path.join(directory, "fast.mjs"), "");
    const out = path.join(directory, "weights.json");
    writeFileSync(out, "{not json");
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, "--out", out, "--cwd", directory, "--run", process.execPath, "fast.mjs"], {
          stdio: ["ignore", "pipe", "pipe"],
        }),
      /not readable JSON/,
    );
    assert.equal(readFileSync(out, "utf8"), "{not json");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
