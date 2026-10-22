import type { ChildProcess, SpawnSyncReturns } from "child_process";
import { createServer } from "net";

import { spawnCodex, terminateCodexProcessTree } from "../../../shared/codex-executable.mjs";
import { codexOwnerIsolationOverrides } from "../../../shared/codex-owner-isolation.mjs";

const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 15_000;

// App-servers this process started, by pid, so a Windows stop can see whether
// the child has already exited (its pid may then belong to another process).
// Entries stay after exit, so a repeated stop of the same stored pid never
// ends a stranger's tree.
const launchedAppServers = new Map<number, ChildProcess>();

export type TerminateDeps = {
  platform: NodeJS.Platform;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  runSync?: (file: string, args: string[]) => Pick<SpawnSyncReturns<Buffer>, "error"> | undefined;
};

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

export function codexAppServerArgs(serverUrl: string, configOverrides: readonly string[]): string[] {
  return ["app-server", ...configOverrides.flatMap((override) => ["-c", override]), "--listen", serverUrl];
}

/**
 * The session works for the room, so its app-server gets none of the owner's
 * Codex plugins, connectors, hooks, personal skills or MCP servers. It keeps
 * the owner's LetAgents server, which it joins the room with. A launch that
 * cannot list the owner's servers, or whose project changes the LetAgents
 * server, fails rather than starting.
 */
export async function launchAppServer(
  serverUrl: string,
  codexBin: string,
  options: { cwd?: string } = {},
): Promise<number | null> {
  const overrides = await codexOwnerIsolationOverrides(codexBin, { cwd: options.cwd, env: process.env });
  // spawnCodex runs a Windows codex.cmd through its node script and hides the console window.
  const child = spawnCodex(codexBin, codexAppServerArgs(serverUrl, overrides), {
    // Start where the servers were listed, so the project config matches.
    ...(options.cwd ? { cwd: options.cwd } : {}),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (child.pid) launchedAppServers.set(child.pid, child);
  return child.pid ?? null;
}

export function terminateSpawnedProcess(
  pid: number,
  deps: TerminateDeps = { platform: process.platform, kill: (target, signal) => process.kill(target, signal) },
): void {
  if (deps.platform === "win32") {
    // The pid is a shim wrapper; its whole tree must go. A child this
    // process started is checked for exit first, because its pid may since
    // belong to another process. A pid read from the state file (an
    // app-server from an earlier run) has no child to check, so it is ended
    // as it is.
    const child = launchedAppServers.get(pid);
    if (child && (child.exitCode !== null || child.signalCode !== null)) return;
    if (terminateCodexProcessTree(pid, { platform: "win32", ...(child ? { child } : {}), ...(deps.runSync ? { runSync: deps.runSync } : {}) })) return;
    try {
      deps.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    return;
  }

  // POSIX: the app-server leads its own process group, which can outlive
  // it, so the group is signalled whether or not the leader has exited.
  try {
    deps.kill(-pid, "SIGTERM");
    return;
  } catch {
    // Fall back to the direct process below.
  }

  try {
    deps.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

/** For tests: remember a child as if launchAppServer had started it. */
export function rememberLaunchedAppServerForTest(pid: number, child: ChildProcess): void {
  launchedAppServers.set(pid, child);
}
