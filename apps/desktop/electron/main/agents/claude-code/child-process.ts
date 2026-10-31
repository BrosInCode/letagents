import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawnTree, terminateTree } from "../../../../../../shared/process-tree.mjs";
import { execProviderFile } from "../../../../../../shared/provider-executable.mjs";
import { desktopRuntimeEnvironment } from "../../desktop-shell-environment.js";
import { withoutRoomAuthority } from "../room-authority-environment.js";
import { managedCommitEnvironmentFor } from "../managed-agent-commit-identity.js";
import { isRentalCredentialIsolationRequested, rentalIsolatedChildEnvironment } from "../rental-child-environment.js";
import { defaultGetProcessIdentity, defaultObserveProcessExit, defaultSignalProcess, errorMessage, type ProviderProcessExit, providerTreeExit } from "../provider-evidence.js";
import type { ClaudeEvidenceRecord } from "../claude-room-turn-evidence.js";
import { resolveLetAgentsMcpRuntime, type LetAgentsMcpRuntime } from "../letagents-mcp-runtime.js";
import { apiUrl as desktopApiUrl } from "../../paths.js";
import { ClaudeRoomTurnRecoveryError } from "./errors.js";
import type { ClaudeCliChild, ClaudeCodeProviderAdapterDependencies } from "./types.js";

const VERSION_TIMEOUT_MS = 8_000;

/**
 * The child's environment is the user's own, minus exactly one carve-out the
 * task_36 acceptance spike proved necessary (msg_1382): the CLI refuses to
 * start when CLAUDECODE is set ("cannot be launched inside another Claude Code
 * session"), so a supervisor that itself runs under Claude Code must not leak
 * that marker into the worker. Daemon-owned turns borrow exact-generation
 * authority, so ambient owner and fixed worker credentials are also removed
 * before Claude or provider-started shell commands can inherit them.
 */
export function claudeCliEnv(base: NodeJS.ProcessEnv = desktopRuntimeEnvironment(), overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const combined = { ...base, ...overrides };
  if (isRentalCredentialIsolationRequested(combined)) return rentalIsolatedChildEnvironment(combined);
  const {
    CLAUDECODE: _omitted,
    LETAGENTS_TOKEN: _ownerToken,
    LETAGENTS_AGENT_SESSION_BEARER: _fixedWorkerBearer,
    ...env
  } = combined;
  return env;
}

function defaultReadVersion(claudeBin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execProviderFile(
      claudeBin,
      ["--version"],
      { timeout: VERSION_TIMEOUT_MS, env: claudeCliEnv() },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Claude Code could not be checked: ${errorMessage(error)}`));
          return;
        }
        resolve(String(stdout || stderr || ""));
      },
    );
    child.stdin?.end();
  });
}

/**
 * The environment the CLI itself runs in. Claude hands it to every MCP server,
 * hook and command it starts. With the owner's own setup on those are the
 * owner's programs, so nothing that lets a process act as the room agent may
 * be in it; the room's server is given the coordinates in its own configuration.
 */
export function claudeChildEnvironment(
  input: { env?: NodeJS.ProcessEnv; ownerSetup?: true },
  base: NodeJS.ProcessEnv = desktopRuntimeEnvironment(),
): NodeJS.ProcessEnv {
  const env = claudeCliEnv(base, input.env);
  return input.ownerSetup ? withoutRoomAuthority(env) : env;
}

function defaultLaunchChild(input: { claudeBin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; ownerSetup?: true }): ClaudeCliChild {
  const child = spawnTree(input.claudeBin, input.args, {
    cwd: input.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group: group-signalling (shared defaultSignalProcess
    // targets -pid first) reaps the CLI's descendants too, and the child is not
    // torn down as a side effect of the supervisor's own stdio going away.
    // On Windows the process-tree helper's job holds the descendants instead.
    detached: process.platform !== "win32",
    // The strict launch config supplies the API endpoint; these coordinates
    // make every LetAgents MCP effect borrow the exact daemon generation.
    env: claudeChildEnvironment(input),
  });

  const lineListeners = new Set<(line: string) => void>();
  const disconnectListeners = new Set<() => void>();
  let intentionalClose = false;
  let exitedSettled = false;
  let disconnectNotified = false;
  let stderrBytes = 0;

  const notifyDisconnect = () => {
    if (intentionalClose || exitedSettled || disconnectNotified) return;
    disconnectNotified = true;
    for (const listener of disconnectListeners) listener();
    disconnectListeners.clear();
  };

  let spawned = false;
  let sawPid = child.pid !== undefined;
  let failedToSpawn = false;
  child.once("spawn", () => { spawned = true; sawPid ||= child.pid !== undefined; });
  const exited = new Promise<ProviderProcessExit>((resolve) => {
    child.once("error", (error) => {
      sawPid ||= child.pid !== undefined;
      failedToSpawn = !spawned && !sawPid;
      exitedSettled = true;
      resolve({ type: "error", error });
    });
    child.once("exit", (code, signal) => {
      exitedSettled = true;
      resolve(providerTreeExit("Claude Code", code, signal));
    });
  });

  if (child.stdout) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      for (const listener of lineListeners) listener(line);
    });
    child.stdout.once("close", () => {
      // Give a simultaneous exit event one macrotask to win: a real exit is
      // authoritative evidence and must not be reported as mere control loss.
      setTimeout(notifyDisconnect, 50).unref?.();
    });
  }
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + chunk.byteLength);
  });

  return {
    pid: child.pid ?? null,
    exited,
    stderrBytesRead: () => stderrBytes,
    didNotSpawn: () => failedToSpawn && child.pid === undefined,
    onLine(listener) {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onDisconnect(listener) {
      if (disconnectNotified) {
        queueMicrotask(listener);
        return () => {};
      }
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
    writeLine(json) {
      if (!child.stdin || !child.stdin.writable || child.stdin.writableEnded || child.stdin.destroyed) {
        throw new Error("Claude CLI stdin is unavailable.");
      }
      child.stdin.write(`${json}\n`);
    },
    endInput() {
      try {
        child.stdin?.end();
      } catch {
        // The pipe may already be gone; the exit observation stays authoritative.
      }
    },
    markIntentionalClose() {
      intentionalClose = true;
    },
    terminate({ graceful, graceMs }) {
      return terminateTree(child, { graceful, graceMs, requestStop: () => child.stdin?.end() });
    },
  };
}

export async function createEphemeralClaudeMcpConfig(
  mcpEnv: Record<string, string>,
  runtime: LetAgentsMcpRuntime,
  temporaryRoot = tmpdir(),
): Promise<{ path: string; dispose(): Promise<void> }> {
  const directory = await mkdtemp(join(temporaryRoot, "letagents-claude-mcp-"));
  const configPath = join(directory, "mcp.json");
  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      letagents: {
        command: process.execPath,
        args: [runtime.entryPath],
        env: { ...mcpEnv, ELECTRON_RUN_AS_NODE: "1" },
      },
    },
  }), { encoding: "utf8", mode: 0o600 });
  let disposed = false;
  return {
    path: configPath,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function createManagedClaudeMcpConfig(
  apiBaseUrl = desktopApiUrl,
  temporaryRoot = tmpdir(),
  devEntryPath?: string,
  resolveRuntime: (devEntryPath?: string) => LetAgentsMcpRuntime = entry =>
    resolveLetAgentsMcpRuntime({ devEntryPath: entry, env: desktopRuntimeEnvironment() }),
  roomServerEnvironment: Record<string, string> = {},
): Promise<{ path: string; dispose(): Promise<void> }> {
  const normalizedApiUrl = apiBaseUrl.trim();
  if (!normalizedApiUrl) {
    throw new Error("Claude's managed LetAgents endpoint is unavailable.");
  }
  return createEphemeralClaudeMcpConfig(
    { ...roomServerEnvironment, LETAGENTS_API_URL: normalizedApiUrl },
    resolveRuntime(devEntryPath),
    temporaryRoot,
  );
}

export function claudeSessionTranscriptCandidates(entries: string[], sessionId: string): string[] {
  const suffix = `${sessionId}.jsonl`;
  return entries.filter((entry) => entry.split(/[\\/]/).at(-1) === suffix);
}

/**
 * Where a Claude CLI started with this environment keeps its session
 * transcripts: `CLAUDE_CONFIG_DIR` when it is set, otherwise `.claude` in its
 * home directory, as Claude Code resolves it.
 */
export function claudeTranscriptsRoot(environment: NodeJS.ProcessEnv): string {
  const configDir = environment.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? join(configDir, "projects") : join(environment.HOME?.trim() || homedir(), ".claude", "projects");
}

async function defaultReadSessionRows(sessionId: string, transcriptsRoot = claudeTranscriptsRoot(claudeCliEnv())): Promise<ClaudeEvidenceRecord[] | null> {
  const projectsRoot = transcriptsRoot;
  let entries: string[];
  try {
    entries = await readdir(projectsRoot, { recursive: true });
  } catch {
    return null;
  }
  const matches = claudeSessionTranscriptCandidates(entries, sessionId);
  if (matches.length > 1) {
    throw new ClaudeRoomTurnRecoveryError(
      "Claude room-turn recovery found more than one transcript for the exact continuation.",
    );
  }
  if (!matches[0]) return null;
  const text = await readFile(join(projectsRoot, matches[0]), "utf8");
  return text.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return [];
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? [parsed as ClaudeEvidenceRecord]
        : [];
    } catch {
      return [];
    }
  });
}

export const DEFAULT_DEPENDENCIES: ClaudeCodeProviderAdapterDependencies = {
  readVersion: defaultReadVersion,
  launchChild: defaultLaunchChild,
  resolveCommitEnvironment: managedCommitEnvironmentFor,
  createLetAgentsMcpConfig: (req, roomServerEnvironment) => createManagedClaudeMcpConfig(
    req.supervisorWorkerSession?.apiUrl ?? desktopApiUrl, tmpdir(), req.devMcpServerEntryPath, undefined, roomServerEnvironment,
  ),
  signalProcess: defaultSignalProcess,
  getProcessIdentity: defaultGetProcessIdentity,
  observeProcessExit: defaultObserveProcessExit,
  readSessionRows: defaultReadSessionRows,
  now: () => new Date().toISOString(),
};
