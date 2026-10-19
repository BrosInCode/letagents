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
