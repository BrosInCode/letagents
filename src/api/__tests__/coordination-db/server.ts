import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
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

async function waitForServer(
  port: number,
  child: ChildProcessWithoutNullStreams,
  stderrBuffer: () => string,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`coordination test server exited early: ${stderrBuffer()}`.trim());
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling until ready
    }

    await sleep(250);
  }

  throw new Error(`coordination test server did not become ready: ${stderrBuffer()}`.trim());
}

export async function startApiServer(): Promise<{
  child: ChildProcessWithoutNullStreams;
  port: number;
}> {
  if (!testDatabaseUrl) {
    throw new Error(`DB-backed coordination tests require ${databaseSkipReason}`);
  }

  const port = 4100 + Math.floor(Math.random() * 500);
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

  await waitForServer(port, child, () => stderr);
  return { child, port };
}

export async function stopChildProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(5000)]);

  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}
