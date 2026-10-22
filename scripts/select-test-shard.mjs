import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// CI runs one slow test suite as several parallel jobs. Each job passes the
// same file list and its own shard ("2/3"), and this prints that shard's files.
//
// Each file carries a weight: its measured run time in seconds from a weights
// file (see scripts/measure-test-weights.mjs), or, for a file with no
// measurement, a time estimated from its byte size at the measured files'
// average seconds per byte. Without a weights file, byte size is the weight.
// The heaviest files are placed first, each on the shard with the least weight
// so far, so the few very slow suites land on different shards. Every job of
// one run sees the same files, so the shards together run each file exactly once.

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

// Turns {file, size, seconds?} entries into {file, weight}. Measured seconds
// win; unmeasured files are estimated from size so a new large suite still
// counts for something, and a suite with no measurements at all keeps the old
// size-only behaviour.
export function weighTestFiles(entries) {
  const measured = entries.filter((entry) => Number.isFinite(entry.seconds) && entry.seconds > 0);
  if (measured.length === 0) {
    return entries.map(({ file, size }) => ({ file, weight: size }));
  }
  const measuredSeconds = measured.reduce((sum, entry) => sum + entry.seconds, 0);
  const measuredBytes = measured.reduce((sum, entry) => sum + entry.size, 0);
  const secondsPerByte = measuredBytes > 0 ? measuredSeconds / measuredBytes : 0;
  return entries.map(({ file, size, seconds }) => ({
    file,
    weight: Number.isFinite(seconds) && seconds > 0 ? seconds : Math.max(1, size * secondsPerByte),
  }));
}

export function partitionTestFiles(entries, total) {
  const names = entries.map(({ file }) => file);
  if (new Set(names).size !== names.length) {
    throw new Error("The test file list names a file more than once.");
  }
  if (entries.length < total) {
    throw new Error(`${entries.length} test files cannot fill ${total} shards.`);
  }

  const shards = Array.from({ length: total }, () => ({ weight: 0, files: [] }));
  const heaviestFirst = weighTestFiles(entries).sort(
    (left, right) => right.weight - left.weight || byName(left.file, right.file),
  );
  for (const { file, weight } of heaviestFirst) {
    let target = shards[0];
    for (const shard of shards) {
      if (shard.weight < target.weight) target = shard;
    }
    target.weight += weight;
    target.files.push(file);
  }

  const partition = shards.map((shard) => shard.files.sort(byName));
  const placed = partition.flat();
  if (placed.length !== names.length || new Set(placed).size !== names.length) {
    throw new Error("The shards do not cover every test file exactly once.");
  }
  return partition;
}

export function readWeights(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must map test files to seconds.`);
  }
  const weights = new Map();
  for (const [name, seconds] of Object.entries(parsed)) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`${file}: '${name}' must have a positive number of seconds.`);
    }
    weights.set(path.normalize(name), seconds);
  }
  return weights;
}

function takeFlag(args, flag) {
  const position = args.indexOf(flag);
  if (position === -1) return { value: undefined, rest: args };
  const value = args[position + 1];
  return { value, rest: args.filter((_, index) => index !== position && index !== position + 1) };
}

function main() {
  const shard = takeFlag(process.argv.slice(2), "--shard");
  if (shard.value === undefined) {
    throw new Error(
      "Usage: node scripts/select-test-shard.mjs --shard <index>/<total> [--weights <seconds.json>] <test files...>",
    );
  }
  const { index, total } = parseShard(shard.value);
  const weightsFlag = takeFlag(shard.rest, "--weights");
  if (weightsFlag.rest.includes("--weights") || (weightsFlag.value === undefined && shard.rest.includes("--weights"))) {
    throw new Error("--weights needs a file.");
  }
  const weights = weightsFlag.value === undefined ? new Map() : readWeights(weightsFlag.value);
  const entries = weightsFlag.rest.map((file) => ({
    file,
    size: statSync(file).size,
    seconds: weights.get(path.normalize(file)),
  }));
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
