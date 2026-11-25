/** The `agy acp` child process, and the adapter's replaceable dependencies. */
import { createInterface } from "node:readline";
import { spawnTree, terminateTree } from "../../../../../shared/process-tree.mjs";
import { execProviderFile } from "../../../../../shared/provider-executable.mjs";
import { desktopRuntimeEnvironment } from "../../desktop-shell-environment.js";
import { apiUrl as desktopApiUrl } from "../../paths.js";
import { resolveLetAgentsMcpRuntime } from "../letagents-mcp-runtime.js";
import { managedCommitEnvironmentFor } from "../managed-agent-commit-identity.js";
import { defaultGetProcessIdentity, defaultObserveProcessExit, defaultSignalProcess, errorMessage, type ProviderProcessExit, providerTreeExit } from "../provider-evidence.js";
import type { ProviderSpawnRequest } from "../provider-adapter.js";
import { antigravityChildEnvironment, antigravityRoomServer } from "./launch.js";
import { readAntigravityLastStepError } from "./turn-errors.js";
import { prepareAntigravityOwnerSetup } from "./owner-setup.js";
import { shareAntigravitySignIn } from "./sign-in.js";
import { antigravityWorkspaceRefusal } from "./workspace-customizations.js";
import { withoutRoomAuthority } from "../room-authority-environment.js";

const VERSION_TIMEOUT_MS = 15_000;

export interface AntigravityChild {
  pid: number | null;
  exited: Promise<ProviderProcessExit>;
  didNotSpawn?(): boolean;
  /** Ordered stdout lines. */
  onLine(listener: (line: string) => void): () => void;
  /** stdout closed while the child was not stopped by this adapter. */
  onDisconnect(listener: () => void): () => void;
  writeLine(json: string): void;
  /** The last few KB of stderr, for a launch failure the owner reads. Sign-in links are removed. */
  stderrTail(): string;
  markIntentionalClose(): void;
  /** Windows, which has no SIGTERM: end the whole tree through its job. */
  terminate?(options: { graceful: boolean; graceMs: number }): Promise<boolean>;
}

export type AntigravityRoomServerSpec = ReturnType<typeof antigravityRoomServer>;

export interface AntigravityProviderAdapterDependencies {
  readVersion(agyBin: string): Promise<string>;
  /** `agy -p /quota --output-format json`: the account's limits, read with no conversation. */
  readQuota(agyBin: string): Promise<string>;
  /** The error of a conversation's last step (agy's step type 17), or null. */
  readLastStepError(databasePath: string): Promise<string | null>;
  /** Place the owner's own setup in the agent's folder, or take it out. */
  prepareOwnerSetup(agentDir: string, enabled: boolean): { notices: string[] };
  /** Mirror the owner's file sign-in (agy's token file) into the agent's folder. */
  shareSignIn(agentDir: string): void;
  /** Why an agent below Full access must not run in this workspace (hooks, plugins, MCP servers agy runs unasked), or null. */
  workspaceRefusal(cwd: string, when: "start" | "turn"): string | null;
  launchChild(input: { agyBin: string; args: string[]; cwd: string; env: Record<string, string> }): AntigravityChild;
  /** The room's MCP server for this agent's sessions. `roomServerEnvironment` holds its supervisor coordinates. */
  roomServer(req: ProviderSpawnRequest, roomServerEnvironment: Record<string, string>): AntigravityRoomServerSpec;
  resolveCommitEnvironment(req: ProviderSpawnRequest): Promise<Record<string, string>>;
  signalProcess(pid: number, signal: NodeJS.Signals, identity?: string | null): void;
  getProcessIdentity(pid: number): string | null | undefined;
  observeProcessExit(pid: number, processIdentity: string): Promise<ProviderProcessExit>;
  now(): string;
}

function defaultReadVersion(agyBin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execProviderFile(
      agyBin,
      ["--version"],
      { timeout: VERSION_TIMEOUT_MS, env: antigravityChildEnvironment(desktopRuntimeEnvironment()) },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`The Antigravity CLI (agy) could not be checked: ${errorMessage(error)}`));
          return;
        }
        resolve(String(stdout || stderr || ""));
      },
    );
    child.stdin?.end();
  });
}

const QUOTA_TIMEOUT_MS = 20_000;

function defaultReadQuota(agyBin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execProviderFile(
      agyBin,
      ["-p", "/quota", "--output-format", "json"],
      { timeout: QUOTA_TIMEOUT_MS, env: antigravityChildEnvironment(desktopRuntimeEnvironment()), maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Antigravity limits could not be read: ${errorMessage(error)}`));
          return;
        }
        resolve(String(stdout || ""));
      },
    );
    child.stdin?.end();
  });
}

const STDERR_TAIL_BYTES = 4 * 1024;

function defaultLaunchChild(input: { agyBin: string; args: string[]; cwd: string; env: Record<string, string> }): AntigravityChild {
  const child = spawnTree(input.agyBin, input.args, {
    cwd: input.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group, so a group signal also ends the agent's commands.
    detached: process.platform !== "win32",
    env: antigravityChildEnvironment(withoutRoomAuthority(desktopRuntimeEnvironment()), input.env),
  });
  const lineListeners = new Set<(line: string) => void>();
  const disconnectListeners = new Set<() => void>();
  let intentionalClose = false;
  let exitedSettled = false;
  let disconnectNotified = false;
  let stderr = "";
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
      resolve(providerTreeExit("Antigravity", code, signal));
    });
  });
  if (child.stdout) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => { for (const listener of lineListeners) listener(line); });
    child.stdout.once("close", () => { setTimeout(notifyDisconnect, 50).unref?.(); });
  }
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  return {
    pid: child.pid ?? null,
    exited,
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
        throw new Error("Antigravity stdin is unavailable.");
      }
      child.stdin.write(`${json}\n`);
    },
    stderrTail: () => stderr
      .replace(/https?:\/\/\S+/gi, "[link]")
      .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
      .trim(),
    markIntentionalClose() { intentionalClose = true; },
    terminate({ graceful, graceMs }) {
      return terminateTree(child, { graceful, graceMs, requestStop: () => child.stdin?.end() });
    },
  };
}

export const DEFAULT_ANTIGRAVITY_DEPENDENCIES: AntigravityProviderAdapterDependencies = {
  readVersion: defaultReadVersion,
  readQuota: defaultReadQuota,
  readLastStepError: readAntigravityLastStepError,
  prepareOwnerSetup: (agentDir, enabled) => prepareAntigravityOwnerSetup(agentDir, enabled),
  shareSignIn: (agentDir) => shareAntigravitySignIn(agentDir),
  workspaceRefusal: antigravityWorkspaceRefusal,
  launchChild: defaultLaunchChild,
  roomServer: (req, roomServerEnvironment) => {
    const runtime = resolveLetAgentsMcpRuntime({ devEntryPath: req.devMcpServerEntryPath, env: desktopRuntimeEnvironment() });
    const apiUrl = (req.supervisorWorkerSession?.apiUrl ?? desktopApiUrl).trim();
    if (!apiUrl) throw new Error("Antigravity's managed LetAgents endpoint is unavailable.");
    return antigravityRoomServer({
      command: process.execPath,
      entryPath: runtime.entryPath,
      env: { ...roomServerEnvironment, LETAGENTS_API_URL: apiUrl },
    });
  },
  resolveCommitEnvironment: managedCommitEnvironmentFor,
  signalProcess: defaultSignalProcess,
  getProcessIdentity: defaultGetProcessIdentity,
  observeProcessExit: defaultObserveProcessExit,
  now: () => new Date().toISOString(),
};
