import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Records how long each test file takes when it runs alone, so
// scripts/select-test-shard.mjs can balance CI shards by time instead of by
// byte size. A file that starts real daemon processes can take a minute while
// a larger file of pure unit tests takes two seconds.
//
//   node scripts/measure-test-weights.mjs --out scripts/electron-test-weights.json \
//     --cwd apps/desktop --run "npm run test:electron:files --" electron/__tests__/*.test.ts
//
// --run is split on spaces; quoted arguments are not supported.
// Each file runs once, in its own process, with HOME on a scratch folder so
// the desktop suites do not write into the real ~/.letagents. The output maps
// each file to whole seconds of wall time. Rerun it after a suite changes a lot;
// the shard selector falls back to a size estimate for files it has no weight for.

export function parseArgs(argv) {
  const options = { out: null, cwd: process.cwd(), run: null, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out" || arg === "--cwd" || arg === "--run") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      options[arg.slice(2)] = value;
      index += 1;
    } else {
      options.files.push(arg);
    }
  }
  if (!options.out || !options.run || options.files.length === 0) {
    throw new Error(
      "Usage: node scripts/measure-test-weights.mjs --out <weights.json> --cwd <dir> --run <command> <test files...>",
    );
  }
  return options;
}

export function mergeWeights(previous, measured) {
  const next = { ...previous };
  for (const [file, seconds] of Object.entries(measured)) {
    next[file] = Math.max(1, Math.round(seconds));
  }
  return Object.fromEntries(Object.entries(next).sort(([left], [right]) => (left < right ? -1 : 1)));
}

// A missing file starts an empty map; a corrupt one is an error, not a reset.
function readWeights(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`${file} is not readable JSON: ${error.message}`);
  }
}

function main() {
  const { out, cwd, run, files } = parseArgs(process.argv.slice(2));
  const [command, ...commandArgs] = run.split(" ").filter(Boolean);
  const measured = {};
  for (const file of files) {
    const home = mkdtempSync(path.join(tmpdir(), "test-weights-home-"));
    const started = Date.now();
    const result = spawnSync(command, [...commandArgs, file], {
      cwd,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, HOME: home, LETAGENTS_API_URL: "http://127.0.0.1:9" },
    });
    const seconds = (Date.now() - started) / 1000;
    measured[file] = seconds;
    const outcome = result.status === 0 ? "ok" : `exit ${result.status ?? result.signal}`;
    console.error(`${seconds.toFixed(1).padStart(7)}s  ${outcome.padEnd(8)} ${file}`);
  }
  const weights = mergeWeights(readWeights(out), measured);
  writeFileSync(out, `${JSON.stringify(weights, null, 2)}\n`);
  console.error(`Wrote ${Object.keys(measured).length} weights to ${out}.`);
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
