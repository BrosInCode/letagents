import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// CI runs `npm ci` through this script so one dropped registry connection does
// not fail a whole job. npm retries a reset that happens before a response,
// but not one that happens while a tarball streams in; that surfaces as
// `npm error network read ECONNRESET` and exit code 152 (npm exits with the
// errno, -104, which wraps to 152).
//
// The command runs again with the same arguments after a growing pause. A
// command that keeps failing still fails the step, with its own exit code.

export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 15_000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function runWithRetries(
  command,
  args,
  { attempts = DEFAULT_ATTEMPTS, baseDelayMs = DEFAULT_BASE_DELAY_MS, log = console.error } = {},
) {
  let status = 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.error) {
      throw result.error;
    }
    status = result.status ?? 1;
    if (status === 0) {
      return 0;
    }
    if (attempt < attempts) {
      const delayMs = baseDelayMs * attempt;
      log(
        `\`${[command, ...args].join(" ")}\` exited with ${status} (attempt ${attempt} of ${attempts}); retrying in ${delayMs / 1000}s.`,
      );
      sleep(delayMs);
    }
  }
  return status;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("Usage: node scripts/retry-command.mjs <command> [args...]");
    process.exit(2);
  }
  process.exit(runWithRetries(command, args));
}
