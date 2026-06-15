import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";

const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 15_000;

export type CodexAppServerExit =
  | { type: "error"; error: Error }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };

export interface CodexAppServerLaunch {
  pid: number | null;
  exited: Promise<CodexAppServerExit>;
}

function readyUrlFromServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/readyz";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function isCodexAppServerReady(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(readyUrlFromServerUrl(serverUrl), {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForCodexAppServer(
  serverUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isCodexAppServerReady(serverUrl)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function describeCodexAppServerExit(exit: CodexAppServerExit): string {
  if (exit.type === "error") {
    return exit.error.message;
  }
  if (exit.signal) {
    return `signal ${exit.signal}`;
  }
  return `code ${exit.code ?? "unknown"}`;
}

export async function waitForLaunchedCodexAppServer(
  serverUrl: string,
  launch: CodexAppServerLaunch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  let exit: CodexAppServerExit | null = null;
  const exitPromise = launch.exited.then((value) => {
    exit = value;
    return false;
  });
  const ready = await Promise.race([
    waitForCodexAppServer(serverUrl, timeoutMs),
    exitPromise,
  ]);
  if (ready) {
    return true;
  }
  if (exit) {
    throw new Error(`Codex app-server exited before it became ready: ${describeCodexAppServerExit(exit)}`);
  }
  return false;
}

async function allocateLoopbackServerUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, DEFAULT_SERVER_HOST, () => resolve());
  });

  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  if (!address || typeof address === "string") {
    throw new Error("Unable to allocate a loopback Codex app-server port.");
  }

  return `ws://${DEFAULT_SERVER_HOST}:${address.port}`;
}

export async function resolveCodexAppServerUrl(explicitServerUrl?: string | null): Promise<string> {
  if (explicitServerUrl?.trim()) {
    return explicitServerUrl.trim();
  }

  const configuredServerUrl = process.env.LETAGENTS_CODEX_SERVER_URL?.trim();
  if (configuredServerUrl) {
    return configuredServerUrl;
  }

  return allocateLoopbackServerUrl();
}

function childExitPromise(child: ChildProcess): Promise<CodexAppServerExit> {
  return new Promise((resolve) => {
    child.once("error", (error) => {
      resolve({ type: "error", error });
    });
    child.once("exit", (code, signal) => {
      resolve({ type: "exit", code, signal });
    });
  });
}

export function launchCodexAppServer(serverUrl: string, codexBin: string): CodexAppServerLaunch {
  const child = spawn(codexBin, ["app-server", "--listen", serverUrl], {
    detached: true,
    stdio: "ignore",
  });
  const exited = childExitPromise(child);
  child.unref();
  return {
    pid: child.pid ?? null,
    exited,
  };
}

export function terminateSpawnedProcess(pid: number): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, "SIGTERM");
      return;
    }
  } catch {
    // Fall through to direct process termination.
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}
