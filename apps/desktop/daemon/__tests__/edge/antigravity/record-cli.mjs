// Records what crosses stdin and stdout between a daemon and the real `agy`
// program. A developer points the daemon at this file in place of the Antigravity CLI
// (LETAGENTS_ANTIGRAVITY_BIN); it starts the real program with the same
// arguments and passes every byte through unchanged.
//
// It is a manual tool: it spends real model turns, and CI never runs it.
//
//   LETAGENTS_EDGE_AGY_RECORD_DIR  an empty folder outside the repository
//   LETAGENTS_EDGE_AGY_REAL_BIN    the real program (default: `agy` on PATH)
//   LETAGENTS_EDGE_AGY_REAL_HOME   optional: the HOME the real program gets (see below)
//
// For the Nth start it writes `capture-N.ndjson`: the entries of a provider
// replay transcript in wire order, with no header. A capture is raw. It holds
// this machine's paths, ids and prompt text, so it never goes into the
// repository as it is: the fixture is made from it by redaction.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

const recordDir = process.env.LETAGENTS_EDGE_AGY_RECORD_DIR;
const realBin = process.env.LETAGENTS_EDGE_AGY_REAL_BIN || "agy";
const argv = process.argv.slice(2);
if (!recordDir) {
  process.stderr.write("agy record: LETAGENTS_EDGE_AGY_RECORD_DIR is not set\n");
  process.exit(70);
}
mkdirSync(recordDir, { recursive: true });

const env = { ...process.env };
delete env.LETAGENTS_EDGE_AGY_RECORD_DIR;
delete env.LETAGENTS_EDGE_AGY_REAL_BIN;
// On macOS agy finds its keychain sign-in through HOME (seen on agy 1.5.16): under the
// edge harness's scratch HOME, `session/new` answers "Authentication required". The
// 2026-11-25 recording gave the real program the developer's HOME back; its data folder
// stayed the agent's own `--gemini-dir` in the scratch home. A narrower way, which keeps
// the scratch HOME: link only `<scratch>/Library/Keychains` to the developer's
// `Library/Keychains` for the recording, and remove the link before the harness
// deletes its home.
if (process.env.LETAGENTS_EDGE_AGY_REAL_HOME) env.HOME = process.env.LETAGENTS_EDGE_AGY_REAL_HOME;
delete env.LETAGENTS_EDGE_AGY_REAL_HOME;

if (argv.includes("--version")) {
  const probe = spawn(realBin, argv, { env, stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  probe.stdout.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  probe.on("close", (code) => {
    writeFileSync(join(recordDir, "version.txt"), output);
    process.exit(code ?? 1);
  });
} else {
  let index = 1;
  for (; ; index += 1) {
    try {
      writeFileSync(join(recordDir, `capture-${index}.ndjson`), "", { flag: "wx" });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  const capturePath = join(recordDir, `capture-${index}.ndjson`);
  writeFileSync(join(recordDir, `launch-${index}.json`), `${JSON.stringify({ argv, cwd: process.cwd() }, null, 2)}\n`);
  const record = (entry) => appendFileSync(capturePath, `${JSON.stringify(entry)}\n`);
  const recordLine = (type, line) => {
    if (!line.trim()) return;
    try {
      record({ type, frame: JSON.parse(line) });
    } catch {
      // Not a frame. Keep it, so the reader of the capture sees that it happened.
      record({ type, frame: { not_json: line } });
    }
  };

  const child = spawn(realBin, argv, { env, stdio: ["pipe", "pipe", "inherit"] });
  let stopRequested = false;
  let stdoutClosed = false;

  // Each stream is split in two: one copy goes on unchanged, one is read by line.
  const toChild = new PassThrough();
  process.stdin.pipe(toChild);
  process.stdin.pipe(child.stdin);
  createInterface({ input: toChild, crlfDelay: Infinity }).on("line", (line) => recordLine("expect_outbound", line));
  process.stdin.on("end", () => { stopRequested = true; });

  const fromChild = new PassThrough();
  child.stdout.pipe(fromChild);
  child.stdout.pipe(process.stdout);
  createInterface({ input: fromChild, crlfDelay: Infinity }).on("line", (line) => recordLine("emit_inbound", line));
  child.stdout.on("close", () => { stdoutClosed = true; });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      stopRequested = true;
      child.kill(signal);
    });
  }
  child.on("exit", (code, signal) => {
    record({ type: "runtime_exit", requested: stopRequested, transportClosedBeforeExit: stdoutClosed, code, signal });
  });
  child.on("close", (code, signal) => {
    if (signal && process.platform !== "win32") {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });
}
