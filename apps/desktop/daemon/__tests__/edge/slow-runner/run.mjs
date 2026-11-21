// Runs the daemon edge suite against a daemon that is slow in the way a busy
// CI runner is (see stall.mjs). Use it before a push: it finds timing faults
// that a clean run on a developer machine does not.
//
//   npm --prefix apps/desktop run test:daemon:edge:slow
//
// The settings come from the environment, with the values that reproduced a
// real CI race as the defaults: STALL_MS=400 STALL_EVERY_MS=500
// STALL_JITTER_MS=1000 SLOW_SQLITE_MS=3. For a harder model, raise them, for
// example STALL_MS=600 SLOW_SQLITE_MS=20.
//
// The slow daemon starts through LETAGENTS_EDGE_DAEMON_CMD, the route for a
// daemon that the harness does not start itself. That route has no Node IPC
// channel, so the scenarios that need the host approval key are skipped.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "../../../..");
const daemonEntry = join(desktopRoot, "dist-daemon", "main.js");
if (!existsSync(daemonEntry)) {
  console.error(`Built daemon not found at ${daemonEntry}. Run "npm --prefix apps/desktop run build:dev" first.`);
  process.exit(1);
}

// The harness gives the daemon an allowlisted environment only, so the settings
// travel as `--import data:` code that sets them in the daemon process itself.
const settings = {};
for (const name of ["STALL_MS", "STALL_EVERY_MS", "STALL_JITTER_MS", "SLOW_SQLITE_MS", "SLOW_AFTER_MS", "SLOW_FOR_MS"]) {
  if (process.env[name] !== undefined) settings[name] = process.env[name];
}
const setSettings = `data:text/javascript,${encodeURIComponent(`Object.assign(process.env, ${JSON.stringify(settings)});`)}`;

const testsDir = join(desktopRoot, "daemon", "__tests__");
const files = readdirSync(testsDir).filter((name) => /^daemon-edge-.*\.test\.ts$/.test(name)).sort()
  .map((name) => join("daemon", "__tests__", name));

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-timeout=180000", ...files, ...process.argv.slice(2)],
  {
    cwd: desktopRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      LETAGENTS_EDGE_DAEMON_CMD: process.execPath,
      LETAGENTS_EDGE_DAEMON_ARGS: JSON.stringify([
        "--import", setSettings,
        "--import", pathToFileURL(join(here, "stall.mjs")).href,
        daemonEntry,
      ]),
    },
  },
);
process.exit(result.status ?? 1);
