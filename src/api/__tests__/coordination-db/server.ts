import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";

import { databaseSkipReason, testDatabaseUrl } from "./database.js";

const tsxBinary = path.resolve(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long a cold `tsx src/api/server.ts` may take to answer /api/health. It usually answers in about
 * 4 s on a CI runner, but a loaded shared runner took more than 15 s, the old bound (staging run
 * 42796605821, both attempts). The loop returns as soon as the server answers, so a healthy start
 * does not wait longer; a child that exits still fails at once.
 */
export const SERVER_READY_TIMEOUT_MS = 60_000;
const SERVER_READY_POLL_MS = 250;

export async function waitForServer(
  port: number,
  child: ChildProcessWithoutNullStreams,
  stderrBuffer: () => string,
): Promise<void> {
  try {
    for (let attempt = 0; attempt < SERVER_READY_TIMEOUT_MS / SERVER_READY_POLL_MS; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`coordination test server exited early: ${stderrBuffer()}`.trim());
      }

      try {
        // A port that accepts and never answers must not stall the loop past its bound.
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) {
          return;
        }
      } catch {
        // keep polling until ready
      }

      await sleep(SERVER_READY_POLL_MS);
    }

    throw new Error(`coordination test server did not become ready in ${SERVER_READY_TIMEOUT_MS / 1000} s: ${stderrBuffer()}`.trim());
  } catch (error) {
    await stopChildProcess(child);
    throw error;
  }
}

export async function startApiServer(): Promise<{
  child: ChildProcessWithoutNullStreams;
  port: number;
}> {
  if (!testDatabaseUrl) {
    throw new Error(`DB-backed coordination tests require ${databaseSkipReason}`);
  }

  // The system picks a free port. Another process can still take it before the server listens,
  // so a start that fails with EADDRINUSE is tried again on a new port.
  for (let attempt = 1; ; attempt += 1) {
    const port = await freeLoopbackPort();
    let stderr = "";

    const child = spawn(tsxBinary, ["src/api/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB_URL: testDatabaseUrl,
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    try {
      await waitForServer(port, child, () => stderr);
      return { child, port };
    } catch (error) {
      if (attempt >= 3 || !stderr.includes("EADDRINUSE")) throw error;
    }
  }
}

async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("could not get a free loopback port for the coordination test server");
  return address.port;
}

export async function stopChildProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  let observedExit = false;
  const exited = once(child, "exit").then(() => { observedExit = true; });
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    graceTimer = setTimeout(resolve, 5000);
  });

  try {
    child.kill("SIGTERM");
    await Promise.race([exited, grace]);
    if (observedExit || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    child.kill("SIGKILL");
    await exited;
  } finally {
    clearTimeout(graceTimer);
  }
}
