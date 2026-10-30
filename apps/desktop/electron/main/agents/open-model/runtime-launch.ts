/** OpenCode runtime launch ownership, process launch, port and connection discovery, deadlines, runtime control files and default dependencies. */
import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { spawnTree } from "../../../../../../shared/process-tree.mjs";
import { probeScratchWorkspaceGit } from "../../../../../../shared/scratch-workspace-repository.mjs";
import { synthesizeTerminalPayload, type ProviderTerminalPayload } from "../provider-adapter.js";
import { defaultGetProcessIdentity, defaultObserveProcessExit, defaultSignalProcess, providerTreeExit, type ProviderProcessExit } from "../provider-evidence.js";
import type { OpenCodeEvent, OpenCodeRuntimeAuth } from "../opencode-server-client.js";
import { OpenCodeBoundedTurnError } from "./errors.js";
import type { OpenModelProviderAdapterDependencies } from "./types.js";
import { ownerPrivatePlatform, protectOwnerPrivate, readOwnerPrivateFile, writePrivateFileAtomically } from "../../../../../../shared/owner-private-fs.mjs";

export function safeRuntimeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
}

export const runtimeLaunchTails = new Map<string, Promise<void>>();

export async function withRuntimeLaunchOwnership<T>(
  runtimePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = runtimeLaunchTails.get(runtimePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  runtimeLaunchTails.set(runtimePath, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (runtimeLaunchTails.get(runtimePath) === current) runtimeLaunchTails.delete(runtimePath);
  }
}

export type OpenCodeRuntimeControl = OpenCodeRuntimeAuth & {
  lifecycleAuthorityMode?: "legacy" | "typed_shadow" | "typed";
  startupIntent?: {
    url: string;
  };
  startupProcess?: {
    url: string;
    pid: number;
    processIdentity: string | null;
  };
  connection?: {
    url: string;
    pid: number;
    processIdentity: string;
  };
};

export function defaultLaunch(input: {
  binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
}): { child: ChildProcess; exited: Promise<ProviderProcessExit> } {
  const child = spawnTree(input.binary, input.args, {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const exited = new Promise<ProviderProcessExit>((resolve) => {
    child.once("error", (error) => resolve({ type: "error", error }));
    child.once("exit", (code, signal) => resolve(providerTreeExit("OpenCode", code, signal)));
  });
  child.unref();
  return { child, exited };
}

export async function defaultAllocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export async function defaultDiscoverRuntimeConnection(
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ pid: number; url: string } | null> {
  // Windows has no lsof, and the pid that holds the database there is the
  // native server inside the helper's job, not a pid whose job could end it:
  // recovery uses only the connection recorded in the runtime control file.
  if (platform === "win32") return null;
  let owners: string;
  try {
    owners = await execFileText(
      "/usr/sbin/lsof",
      ["-t", "--", join(runtimeRoot, "data", "opencode", "opencode.db")],
    );
  } catch {
    return null;
  }
  const pids = [...new Set(owners.split(/\s+/)
    .filter((value) => /^\d+$/.test(value))
    .map(Number)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  const candidates: Array<{ pid: number; url: string }> = [];
  for (const pid of pids) {
    let command: string;
    try {
      command = (await execFileText("/bin/ps", ["-p", String(pid), "-o", "command="])).trim();
    } catch {
      continue;
    }
    if (!/(?:^|\s)serve(?:\s|$)/.test(command)
      || !/(?:^|\s)--hostname(?:=|\s+)127\.0\.0\.1(?:\s|$)/.test(command)) continue;
    const port = Number(command.match(/(?:^|\s)--port(?:=|\s+)(\d+)(?:\s|$)/)?.[1]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) continue;
    candidates.push({ pid, url: `http://127.0.0.1:${port}` });
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

export async function nextEventBefore(
  events: AsyncIterator<OpenCodeEvent>,
  deadline: number,
): Promise<IteratorResult<OpenCodeEvent>> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new OpenCodeBoundedTurnError("OpenCode bounded turn timed out.");
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      events.next(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new OpenCodeBoundedTurnError("OpenCode bounded turn timed out.")),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Bound a single in-flight operation to a wall-clock deadline. A hung server
 * response must never stretch a turn-control budget past its ceiling, so the
 * losing operation is abandoned (its late rejection is swallowed to avoid an
 * unhandled rejection).
 */
export async function resolveBeforeDeadline<T>(operation: Promise<T>, deadline: number, message: string): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) { void operation.catch(() => undefined); throw new Error(message); }
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), remainingMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    void operation.catch(() => undefined);
  }
}

export const defaultDependencies: OpenModelProviderAdapterDependencies = {
  launch: defaultLaunch,
  getProcessIdentity: defaultGetProcessIdentity,
  observeProcessExit: defaultObserveProcessExit,
  signalProcess: defaultSignalProcess,
  allocatePort: defaultAllocatePort,
  probeGit: (workspace, environment) => probeScratchWorkspaceGit(workspace, environment),
  discoverRuntimeConnection: defaultDiscoverRuntimeConnection,
  fetch: (input, init) => fetch(input, init),
  now: () => new Date().toISOString(),
};

export async function readRuntimeControl(path: string): Promise<OpenCodeRuntimeControl> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8_192) {
    throw new Error("OpenCode server authentication sidecar is invalid.");
  }
  // The server password: Windows reads it only while its own DACL is private (POSIX: readFile).
  const value = JSON.parse(await readOwnerPrivateFile(path, "utf8")) as Partial<OpenCodeRuntimeControl>;
  if (typeof value.username !== "string" || !value.username
    || typeof value.password !== "string" || !value.password) {
    throw new Error("OpenCode server authentication sidecar is malformed.");
  }
  if (value.lifecycleAuthorityMode !== undefined
    && value.lifecycleAuthorityMode !== "legacy"
    && value.lifecycleAuthorityMode !== "typed_shadow"
    && value.lifecycleAuthorityMode !== "typed") {
    throw new Error("OpenCode server authentication sidecar contains an invalid lifecycle authority.");
  }
  if (value.startupIntent !== undefined
    && (typeof value.startupIntent !== "object"
      || typeof value.startupIntent.url !== "string"
      || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.startupIntent.url))) {
    throw new Error("OpenCode server authentication sidecar contains an invalid startup intent.");
  }
  if (value.startupProcess !== undefined
    && (typeof value.startupProcess !== "object"
      || typeof value.startupProcess.url !== "string"
      || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.startupProcess.url)
      || !Number.isSafeInteger(value.startupProcess.pid)
      || value.startupProcess.pid < 1
      || (value.startupProcess.processIdentity !== null
        && (typeof value.startupProcess.processIdentity !== "string"
          || !value.startupProcess.processIdentity)))) {
    throw new Error("OpenCode server authentication sidecar contains invalid startup process evidence.");
  }
  if (value.connection !== undefined
    && (typeof value.connection !== "object"
      || typeof value.connection.url !== "string"
      || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.connection.url)
      || !Number.isSafeInteger(value.connection.pid)
      || value.connection.pid < 1
      || typeof value.connection.processIdentity !== "string"
      || !value.connection.processIdentity)) {
    throw new Error("OpenCode server authentication sidecar contains invalid connection evidence.");
  }
  return {
    username: value.username,
    password: value.password,
    ...(value.lifecycleAuthorityMode ? { lifecycleAuthorityMode: value.lifecycleAuthorityMode } : {}),
    ...(value.startupIntent ? { startupIntent: value.startupIntent } : {}),
    ...(value.startupProcess ? { startupProcess: value.startupProcess } : {}),
    ...(value.connection ? { connection: value.connection } : {}),
  };
}

export async function writeRuntimeControl(path: string, value: OpenCodeRuntimeControl): Promise<void> {
  // Windows: in the private runtime folder the file is private from its exclusive create; no tool runs per write.
  if (ownerPrivatePlatform() === "win32") {
    await writePrivateFileAtomically(path, `${JSON.stringify(value)}\n`, { syncDirectory: false });
    return;
  }
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await protectOwnerPrivate(temporaryPath, "file");
  await rename(temporaryPath, path);
}

export function terminalFromExit(
  exit: ProviderProcessExit,
  continuationId: string,
  endedAt: string,
  stopRequested: boolean,
): ProviderTerminalPayload {
  return synthesizeTerminalPayload({
    exitCode: exit.type === "exit" ? exit.code : null,
    signal: exit.type === "exit" ? exit.signal : null,
    providerContinuationId: continuationId,
    endedAt,
    stopRequested,
  });
}
