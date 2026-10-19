import { statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// CI runs one slow test suite as several parallel jobs. Each job passes the
// same file list and its own shard ("2/3"), and this prints that shard's files.
//
// A file's size stands in for its run time. The largest files are placed
// first, each on the shard with the fewest bytes so far, so the few very
// large suites land on different shards. Every job of one run sees the same
// files, so the shards together run each file exactly once.

function byName(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseShard(value) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value ?? "");
  if (!match || Number(match[1]) > Number(match[2])) {
    throw new Error(`--shard must look like 2/3 (index/total); received '${value ?? ""}'.`);
  }
  return { index: Number(match[1]), total: Number(match[2]) };
}

export function partitionTestFiles(entries, total) {
  const names = entries.map(({ file }) => file);
  if (new Set(names).size !== names.length) {
    throw new Error("The test file list names a file more than once.");
  }
  if (entries.length < total) {
    throw new Error(`${entries.length} test files cannot fill ${total} shards.`);
  }

  const shards = Array.from({ length: total }, () => ({ bytes: 0, files: [] }));
  const largestFirst = [...entries].sort((left, right) => right.size - left.size || byName(left.file, right.file));
  for (const { file, size } of largestFirst) {
    let target = shards[0];
    for (const shard of shards) {
      if (shard.bytes < target.bytes) target = shard;
    }
    target.bytes += size;
    target.files.push(file);
  }

  const partition = shards.map((shard) => shard.files.sort(byName));
  const placed = partition.flat();
  if (placed.length !== names.length || new Set(placed).size !== names.length) {
    throw new Error("The shards do not cover every test file exactly once.");
  }
  return partition;
}

function main() {
  const args = process.argv.slice(2);
  const shardFlag = args.indexOf("--shard");
  if (shardFlag === -1) {
    throw new Error("Usage: node scripts/select-test-shard.mjs --shard <index>/<total> <test files...>");
  }
  const { index, total } = parseShard(args[shardFlag + 1]);
  const files = args.filter((_, position) => position !== shardFlag && position !== shardFlag + 1);
  const entries = files.map((file) => ({ file, size: statSync(file).size }));
  process.stdout.write(`${partitionTestFiles(entries, total)[index - 1].join("\n")}\n`);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
