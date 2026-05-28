import { spawn } from "child_process";
import { createServer } from "net";

const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 15_000;

function readyUrlFromServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/readyz";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function isServerReady(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(readyUrlFromServerUrl(serverUrl), {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForServer(serverUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isServerReady(serverUrl)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
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

export async function resolveCodexServerUrl(explicitServerUrl?: string): Promise<string> {
  if (explicitServerUrl) {
    return explicitServerUrl;
  }

  const configuredServerUrl = process.env.LETAGENTS_CODEX_SERVER_URL?.trim();
  if (configuredServerUrl) {
    return configuredServerUrl;
  }

  return allocateLoopbackServerUrl();
}

export function launchAppServer(serverUrl: string, codexBin: string): number | null {
  const child = spawn(codexBin, ["app-server", "--listen", serverUrl], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? null;
}

export function terminateSpawnedProcess(pid: number): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, "SIGTERM");
      return;
    }
  } catch {
    // Fall back to the direct process below.
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}
