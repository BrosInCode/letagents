import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseShard, partitionTestFiles } from "./select-test-shard.mjs";

const script = path.resolve("scripts/select-test-shard.mjs");

test("the largest files go to different shards and the rest fill the smallest shard", () => {
  const partition = partitionTestFiles(
    [
      { file: "a.test.ts", size: 10 },
      { file: "b-adapter.test.ts", size: 600 },
      { file: "c.test.ts", size: 40 },
      { file: "d-adapter.test.ts", size: 500 },
      { file: "e-adapter.test.ts", size: 450 },
      { file: "f.test.ts", size: 30 },
    ],
    3,
  );

  assert.deepEqual(partition, [
    ["b-adapter.test.ts"],
    ["a.test.ts", "d-adapter.test.ts"],
    ["c.test.ts", "e-adapter.test.ts", "f.test.ts"],
  ]);
});

test("every file runs exactly once, whatever the shard count", () => {
  const entries = Array.from({ length: 29 }, (_, index) => ({
    file: `suite-${String(index).padStart(2, "0")}.test.ts`,
    size: (index * 7919) % 1000,
  }));

  for (const total of [1, 2, 3, 4, 7, 29]) {
    const placed = partitionTestFiles(entries, total).flat().sort();
    assert.deepEqual(placed, entries.map(({ file }) => file).sort(), `${total} shards`);
  }
});

test("the split does not depend on the order the files are given in", () => {
  const entries = [
    { file: "x.test.ts", size: 5 },
    { file: "y.test.ts", size: 5 },
    { file: "z.test.ts", size: 9 },
    { file: "w.test.ts", size: 1 },
  ];
  assert.deepEqual(partitionTestFiles([...entries].reverse(), 2), partitionTestFiles(entries, 2));
});

test("a shard that would be empty, a repeated file, or a malformed shard is refused", () => {
  assert.throws(() => partitionTestFiles([{ file: "only.test.ts", size: 1 }], 2), /cannot fill 2 shards/);
  assert.throws(
    () => partitionTestFiles([{ file: "a.test.ts", size: 1 }, { file: "a.test.ts", size: 1 }], 1),
    /more than once/,
  );
  for (const value of [undefined, "", "0/3", "4/3", "1", "1/0", "a/b", "1/3/5", " 1/3"]) {
    assert.throws(() => parseShard(value), /--shard must look like/, String(value));
  }
  assert.deepEqual(parseShard("2/3"), { index: 2, total: 3 });
});

test("the command prints one shard's files, one per line, from file sizes on disk", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "select-test-shard-"));
  try {
    const sizes = { "big.test.ts": 300, "mid.test.ts": 200, "small.test.ts": 150 };
    for (const [file, size] of Object.entries(sizes)) {
      writeFileSync(path.join(directory, file), "x".repeat(size));
    }
    const run = (shard) =>
      execFileSync(process.execPath, [script, "--shard", shard, ...Object.keys(sizes)], {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

    assert.equal(run("1/2"), "big.test.ts\n");
    assert.equal(run("2/2"), "mid.test.ts\nsmall.test.ts\n");
    assert.throws(() => run("3/2"), /--shard must look like/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("measured seconds outweigh byte size, and unmeasured files are estimated from size", () => {
  // slow.test.ts is small but starts real processes; big.test.ts is large but
  // quick. With seconds known, the two slow files must not share a shard.
  const entries = [
    { file: "big.test.ts", size: 900, seconds: 4 },
    { file: "slow.test.ts", size: 100, seconds: 60 },
    { file: "slow-too.test.ts", size: 120, seconds: 55 },
    { file: "quick.test.ts", size: 50, seconds: 1 },
  ];
  // 60 s on one shard; 55 + 4 + 1 = 60 s on the other.
  assert.deepEqual(partitionTestFiles(entries, 2), [
    ["slow.test.ts"],
    ["big.test.ts", "quick.test.ts", "slow-too.test.ts"],
  ]);

  // Measured files run 120 s over 1170 bytes; an unmeasured 1170-byte file is
  // estimated at 120 s and so lands on its own shard ahead of the 60 s file.
  const withUnmeasured = [...entries, { file: "new.test.ts", size: 1170 }];
  assert.deepEqual(partitionTestFiles(withUnmeasured, 2), [
    ["new.test.ts"],
    ["big.test.ts", "quick.test.ts", "slow-too.test.ts", "slow.test.ts"],
  ]);

  // Without any measurement, size alone decides, as before.
  assert.deepEqual(
    partitionTestFiles(entries.map(({ file, size }) => ({ file, size })), 2),
    [["big.test.ts"], ["quick.test.ts", "slow-too.test.ts", "slow.test.ts"]],
  );
});

test("the command reads --weights and refuses a weights file with bad numbers", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "select-test-shard-weights-"));
  try {
    const sizes = { "big.test.ts": 300, "slow.test.ts": 100, "small.test.ts": 150 };
    for (const [file, size] of Object.entries(sizes)) {
      writeFileSync(path.join(directory, file), "x".repeat(size));
    }
    writeFileSync(path.join(directory, "weights.json"), JSON.stringify({ "./slow.test.ts": 90, "big.test.ts": 3 }));
    writeFileSync(path.join(directory, "bad.json"), JSON.stringify({ "big.test.ts": 0 }));
    const run = (shard, weights) =>
      execFileSync(process.execPath, [script, "--shard", shard, "--weights", weights, ...Object.keys(sizes)], {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

    // slow.test.ts (90 s, matched despite the "./" spelling) takes one shard;
    // small.test.ts is unmeasured and estimated at 150 bytes * (93 s / 400 bytes).
    assert.equal(run("1/2", "weights.json"), "slow.test.ts\n");
    assert.equal(run("2/2", "weights.json"), "big.test.ts\nsmall.test.ts\n");
    assert.throws(() => run("1/2", "bad.json"), /positive number of seconds/);
    assert.throws(() => run("1/2", "missing.json"), /ENOENT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
