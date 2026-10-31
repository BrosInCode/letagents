/** Shared adapter contracts: the RPC surface, dependencies, options and permission reply types. */
import type { CodexAppServerExit, CodexAppServerLaunch } from "../codex-app-server.js";
import type { CodexLiveProcess } from "../codex-home-harness.js";
import type { RpcNotification, RpcServerRequest } from "../codex-rpc-client.js";
import type { LetAgentsMcpRuntime } from "../letagents-mcp-runtime.js";
import type { ProviderActivityEvent, ProviderStreamEvent } from "../provider-adapter.js";

export interface CodexAdapterRpc {
  connect(): Promise<void>;
  request<T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
  close(): void;
  onDisconnect(listener: () => void): () => void;
  currentConnectionId(): string | null;
  /** The Codex home the app-server said it runs with. Null when it did not say. */
  reportedCodexHome?(): string | null;
  listPendingRequests(): readonly RpcServerRequest[];
  /** Told of each server request as it arrives, before any observer of the pending set. */
  onRequest?(listener: (request: RpcServerRequest) => void): () => void;
  onPendingRequestsChanged(listener: () => void): () => void;
  onRequestResolved(listener: (request: RpcServerRequest) => void): () => void;
  respond(request: RpcServerRequest, result: unknown): void;
}

/** Native approval payloads stay host-ephemeral, outside execution facts and room projections. */
export type CodexPermissionObservation =
  | { type: "snapshot"; connectionId: string; requests: readonly RpcServerRequest[] }
  | { type: "request_closed"; request: RpcServerRequest }
  | { type: "degraded" }
  | { type: "unavailable" };

export class CodexPermissionReplyError extends Error {
  constructor(readonly outcome: "not_dispatched" | "uncertain") {
    super(`Codex permission decision ${outcome}.`);
    this.name = "CodexPermissionReplyError";
  }
}

export interface CodexProviderAdapterDependencies {
  resolveMcpRuntime(devEntryPath?: string): LetAgentsMcpRuntime;
  readMcpRuntimeContract(entryPath: string, apiUrl?: string): Promise<unknown>;
  resolveServerUrl(): Promise<string>;
  launchServer(
    serverUrl: string,
    codexBin: string,
    options: {
      trustedProjectPath: string; configOverrides: string[]; env?: Record<string, string>; homeHarness?: boolean; sandboxed?: boolean; writableSandbox?: boolean;
      /** A Read-only launch: the name of the permission profile the launch must define, with the sign-in file denied. */
      hideSignInProfile?: string;
      /** The policy is the Read-only level's own. The launch starts nothing for it without that profile. */
      readOnlySandbox?: boolean;
    },
  ): CodexAppServerLaunch | Promise<CodexAppServerLaunch>;
  waitForServer(serverUrl: string, launch: CodexAppServerLaunch): Promise<boolean>;
  createRpcClient(
    serverUrl: string,
    onNotification: (notification: RpcNotification) => void,
  ): CodexAdapterRpc;
  /** `identity`: the recorded birth; on Windows a pid this process does not hold is ended only with it. */
  signalProcess(pid: number, signal: NodeJS.Signals, identity?: string | null): void;
  /** null means verified absent; undefined means liveness could not be verified. */
  getProcessIdentity(pid: number): string | null | undefined;
  observeProcessExit(pid: number, processIdentity: string): Promise<CodexAppServerExit>;
  /**
   * A running app-server's command line. Null when it cannot be read in time.
   * Asked only for a process that has its owner's setup.
   */
  readCommandLine(pid: number): Promise<string | null>;
  /**
   * Throws when a running app-server that has its owner's setup would load
   * project configuration it was not started with turned off.
   */
  assertLiveProjectUnchanged(codexBin: string, live: CodexLiveProcess): Promise<void>;
  /**
   * Why a running app-server at a sandboxed access level may not start or
   * load a conversation: a command rule it would read with its home, in its
   * project or from the machine. Null when it may.
   */
  sandboxedLoadRefusal(
    codexBin: string,
    live: { cwd: string; codexHome: string | null; writableSandbox: boolean },
    /** Given the folders the Codex config lets a command write, as they are named now: asked again before each turn. */
    keepWritableFoldersCheck?: (check: () => string | null) => void,
  ): Promise<string | null>;
  /**
   * Throws when a running app-server that was started without its owner's
   * setup would now start an MCP server, or load a skill, that it was not
   * started with turned off, or when the project changes the room's own
   * server. `codexHome` is the home the process runs with, and
   * `launchOverrides` are its launch's own overrides: null for a process that
   * was found running, whose launch is not known.
   */
  assertLiveIsolationUnchanged(codexBin: string, live: CodexLiveProcess & { codexHome: string | null; launchOverrides: readonly string[] | null }): Promise<void>;
  writeSupervisorBridgeContext(
    cwd: string,
    context: {
      entry_id: string;
      room_id: string;
      work_attempt_id: string;
      execution_generation_id: string;
    },
  ): Promise<void>;
  now(): string;
  sleep(ms: number): Promise<void>;
}

/**
 * How long a command's output is added up before it is recorded, when no
 * other fact comes first. The record keeps only how many bytes a command
 * printed, so nothing is lost by waiting, and a byte budget would bound
 * nothing; the wait only bounds how stale the shown byte count may be. Five
 * seconds keeps a command that streams for an hour at about 720 facts, where
 * one fact per chunk filled the record's 10,000 facts within minutes. A
 * command's end, its turn's end and its process's exit record it at once.
 */
export const COMMAND_OUTPUT_WINDOW_MS = 5_000;

export interface CodexProviderAdapterOptions {
  codexBin?: string;
  /** See COMMAND_OUTPUT_WINDOW_MS; tests shorten it. */
  commandOutputWindowMs?: number;
  dependencies?: Partial<CodexProviderAdapterDependencies>;
  activitySink?: (event: ProviderActivityEvent) => void;
  streamSink?: (event: ProviderStreamEvent) => void;
}
