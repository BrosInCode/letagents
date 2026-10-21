// Shared fixtures for the codex-provider-adapter tests, split out of
// codex-provider-adapter.test.ts. It is not a test file: the *.test.ts glob does not match it.
import "./isolated-home.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAppServerExit, CodexAppServerLaunch } from "../main/agents/codex-app-server.js";
import { CodexProviderAdapter, type CodexAdapterRpc, type CodexProviderAdapterDependencies } from "../main/agents/codex-provider-adapter.js";
import { codexReadOnlyProfileId } from "../main/agents/codex-agent-home.js";
import { type RpcNotification, type RpcServerRequest } from "../main/agents/codex-rpc-client.js";
import { CODEX_OWNER_FEATURE_OVERRIDES } from "../../../../shared/codex-owner-isolation.mjs";
import type { ProviderHandle, ProviderRoomTurnRequest, ProviderSpawnRequest } from "../main/agents/provider-adapter.js";

// Cross-layer assertions load the daemon at test runtime without pulling its
// separately compiled source tree into Electron's production rootDir.
export const { providerStreamLifecycle } = await import(new URL("../../daemon/provider-stream-policy.ts", import.meta.url).href);
export const { emptyExecutionProjection, reduceExecutionFact } = await import(new URL("../../daemon/execution-reducer.ts", import.meta.url).href);
export const { ProviderActionPortRouter } = await import(new URL("../../daemon/provider-action-port-router.ts", import.meta.url).href);
export const { HostApprovalBroker } = await import(new URL("../../daemon/host-approval-broker.ts", import.meta.url).href);
export const { ManifestStore } = await import(new URL("../../daemon/manifest-store.ts", import.meta.url).href);
export const { SupervisedAgentInboxStore } = await import(new URL("../../daemon/supervised-agent-inbox-store.ts", import.meta.url).href);

export type RecordedRequest = { method: string; params: unknown };

export function roomReadiness(tools = ["claim_task", "get_board", "read_messages", "send_message"]) {
  return { contents: [{ uri: "letagents://runtime/readiness", mimeType: "application/json",
    text: JSON.stringify({ format: 1, profile: "supervised_room_turn", provider: "codex", tools }) }] };
}

export function assertProviderHandle(
  value: ProviderHandle | { state: "terminal" } | null,
): asserts value is ProviderHandle {
  assert.ok(value && !("state" in value && value.state === "terminal"), "expected a live provider handle");
}

/** `model` is the name a thread is started with; it is the entry's `id` unless a test says otherwise. */
export type FakeCodexModel = { id: string; model?: string; efforts: readonly string[] };
/** Two models with the efforts a real Codex 0.153 lists for them: a current one, and an older one that takes no `max`. */
export const FAKE_CODEX_MODELS: readonly FakeCodexModel[] = [
  { id: "gpt-5.6-sol", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"] },
];

/** What one conversation of a stand-in app-server was given: its approval policy, its sandbox, and its permission profile when it names one. */
export type HeldThreadPolicy = { approvalPolicy?: unknown; sandbox?: unknown; activePermissionProfile?: { id: string; extends: string | null } | null };

export class FakeRpc implements CodexAdapterRpc {
  /** Set for a stand-in that says which Codex home it runs with, as the real app-server does. */
  reportedCodexHome?: () => string | null;
  readonly requests: RecordedRequest[] = [];
  readonly threadReadCounts = new Map<string, number>();
  readonly threadResumeCounts = new Map<string, number>();
  connected = false;
  closed = false;
  turnStatus: string | { status?: string } = "completed";
  /** What `thread/read` reports. A real app-server leaves `systemError` after a failed turn until the thread's next turn. */
  threadStatus: "idle" | "active" | "systemError" = "idle";
  permissionChanges = [{ path: "/repo/file.ts", kind: { type: "add" as const }, diff: "+file" }];
  private threadStartCount = 0;
  private readonly missingThreadReads = new Map<string, number>();
  private readonly missingThreadResumes = new Map<string, number>();
  private readonly disconnectListeners = new Set<() => void>();
  readonly pendingPermissions = new Map<RpcServerRequest["id"], RpcServerRequest>();
  readonly permissionResponses: Array<{ request: RpcServerRequest; result: unknown }> = [];
  readonly permissionListeners = new Set<() => void>();
  connectionEpoch = "initial";
  responseError = false;

  constructor(
    readonly threadId: string,
    private readonly notify: (notification: RpcNotification) => void,
    private readonly options: {
      resumeSupported: boolean;
      placeholderResumeIsFatal: boolean;
      workplacePresent: boolean;
      workplaceProbeTimesOut: boolean;
      threadReadFails: boolean;
      threadReadTimesOut: boolean;
      threadReadUnmaterialized: boolean;
      reviewerFromOwnSettings: string | null;
      /** The folder a new thread reports: where its app-server was launched, unless a test says otherwise. */
      threadDirectory: string | null;
      /** What `model/list` reports; null is an app-server that cannot list its models, "timeout" one that does not answer in time. */
      models: readonly FakeCodexModel[] | null | "timeout";
      /** The list has more pages than the one `model/list` returns. */
      moreModelPages: boolean;
      effortFromOwnSettings: string | null | undefined;
      /** Every thread reports `reasoningEffort: null`, whatever it was given: Codex has no effort for it. */
      effortReportedAsNull: boolean;
    },
  ) {
    this.reviewerFromOwnSettings = options.reviewerFromOwnSettings;
    this.effortFromOwnSettings = options.effortFromOwnSettings;
  }

  /** The time limit each request was given, for the requests that were given one. */
  readonly requestTimeouts: Array<{ method: string; timeoutMs: number }> = [];

  /**
   * A current app-server reports the effort a thread was given. Set when it
   * reports this one instead: it ignored the effort, or the thread is already
   * loaded and keeps its own. Null is an app-server whose reply has no effort field.
   */
  effortFromOwnSettings: string | null | undefined;

  private reportedEffort(params: unknown): { reasoningEffort?: string | null } {
    if (this.options.effortReportedAsNull) return { reasoningEffort: null };
    const given = (params as { config?: { model_reasoning_effort?: unknown } } | undefined)?.config?.model_reasoning_effort;
    const reported = this.effortFromOwnSettings === undefined ? given : this.effortFromOwnSettings;
    return typeof reported === "string" ? { reasoningEffort: reported } : {};
  }

  /** Set when the app-server ignores the requested reviewer and reports this one. */
  reviewerFromOwnSettings: string | null;

  /** A current app-server applies the reviewer it was asked for; one that ignores the request uses its own. */
  private appliedReviewer(params: unknown): string {
    const requested = (params as { approvalsReviewer?: unknown } | undefined)?.approvalsReviewer;
    return this.reviewerFromOwnSettings ?? (typeof requested === "string" ? requested : "user");
  }

  /** Set when the app-server keeps a sandbox of its own instead of the one a thread was asked to have. */
  sandboxFromOwnSettings: unknown = undefined;
  /** Set when the app-server keeps an approval policy of its own. */
  approvalPolicyFromOwnSettings: unknown = undefined;
  /** An older app-server: its thread replies say nothing about the sandbox or the approval policy. */
  omitsThreadPolicy = false;
  /**
   * Set when the app-server reports a permission profile of its own for every conversation, whatever it was asked
   * for: null is one that reports none, as a Codex without profiles does and as Codex does after a sandbox was named.
   */
  profileFromOwnSettings: { id: string; extends: string | null } | null | undefined = undefined;

  /** The policy each conversation of this app-server has, shared by every connection to it. */
  threadPolicies = new Map<string, HeldThreadPolicy>();

  /**
   * What a thread reply says the thread got. The sandbox is reported in its full form, not by the name it was asked for.
   * A request that names no policy, as a subscription to a loaded conversation does, is told the one the conversation has.
   *
   * A conversation is given a named sandbox or a named permission profile, and Codex refuses both together. This
   * stand-in knows one kind of profile, the one a Read-only launch defines: Codex's read-only sandbox, extended.
   * It reports that sandbox for it, and the profile's name, as Codex 0.153.4 does.
   */
  private appliedThreadPolicy(params: unknown, threadId: string): Record<string, unknown> {
    const requested = (params ?? {}) as { approvalPolicy?: unknown; sandbox?: unknown; permissions?: unknown };
    if (typeof requested.permissions === "string" && requested.sandbox !== undefined) throw new Error("`permissions` cannot be combined with `sandbox`");
    if (typeof requested.permissions === "string") {
      this.threadPolicies.set(threadId, {
        approvalPolicy: requested.approvalPolicy, sandbox: { type: "readOnly", networkAccess: false },
        activePermissionProfile: { id: requested.permissions, extends: ":read-only" },
      });
    } else if (requested.approvalPolicy !== undefined || requested.sandbox !== undefined) {
      this.threadPolicies.set(threadId, { approvalPolicy: requested.approvalPolicy, activePermissionProfile: null, sandbox: ({
        "read-only": { type: "readOnly", networkAccess: false },
        "workspace-write": { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        "danger-full-access": { type: "dangerFullAccess" },
      } as Record<string, unknown>)[String(requested.sandbox)] });
    }
    if (this.omitsThreadPolicy) return {};
    const held = this.threadPolicies.get(threadId) ?? {};
    const sandbox = this.sandboxFromOwnSettings ?? held.sandbox;
    const approvalPolicy = this.approvalPolicyFromOwnSettings ?? held.approvalPolicy;
    const activePermissionProfile = this.profileFromOwnSettings === undefined ? held.activePermissionProfile ?? null : this.profileFromOwnSettings;
    return { ...(approvalPolicy === undefined ? {} : { approvalPolicy }), ...(sandbox === undefined ? {} : { sandbox }), activePermissionProfile };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async request<T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T> {
    this.requests.push({ method, params });
    if (options?.timeoutMs !== undefined) this.requestTimeouts.push({ method, timeoutMs: options.timeoutMs });
    if (method === "thread/turns/list") return { data: [{ id: `turn-${this.threadId}`, status: this.turnStatus, itemsView: "full",
      items: [{ id: "item-1", type: "fileChange", status: "inProgress", changes: this.permissionChanges }] }], nextCursor: null, backwardsCursor: null } as T;
    if (method === "mcpServerStatus/list") {
      if (this.options.workplaceProbeTimesOut) {
        throw new Error("Codex app-server request timed out: mcpServerStatus/list");
      }
      return {
        data: this.options.workplacePresent ? [{ name: "letagents", runtimeStatus: "connected",
          tools: Object.fromEntries(["claim_task", "get_board", "read_messages", "send_message"].map(name => [name, { name }])) }] : [],
      } as T;
    }
    if (method === "mcpServer/resource/read") {
      if (this.options.workplaceProbeTimesOut) throw new Error("Codex app-server request timed out: mcpServer/resource/read");
      return (this.options.workplacePresent ? roomReadiness() : { contents: [] }) as T;
    }
    if (method === "model/list") {
      if (this.options.models === "timeout") throw new Error("Codex app-server request timed out: model/list");
      if (!this.options.models) throw new Error("JSON-RPC -32601: method not found");
      return {
        data: this.options.models.map(({ id, model, efforts }) => ({
          id, model: model ?? id, hidden: false,
          supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: "" })),
        })),
        nextCursor: this.options.moreModelPages ? "page-2" : null,
      } as T;
    }
    if (method === "thread/start") {
      this.threadStartCount += 1;
      const startedThreadId = this.threadStartCount === 1 ? this.threadId : `${this.threadId}-replacement-${this.threadStartCount - 1}`;
      return {
        thread: { id: startedThreadId },
        approvalsReviewer: this.appliedReviewer(params),
        ...this.reportedEffort(params),
        ...this.appliedThreadPolicy(params, startedThreadId),
        ...(this.options.threadDirectory === null ? {} : { cwd: this.options.threadDirectory }),
      } as T;
    }
    if (method === "thread/resume") {
      const threadId = (params as { threadId: string }).threadId;
      this.threadResumeCounts.set(threadId, (this.threadResumeCounts.get(threadId) ?? 0) + 1);
      if (!this.options.resumeSupported) throw new Error("JSON-RPC -32601: method not found");
      if (threadId === "00000000-0000-0000-0000-000000000000") {
        if (this.options.placeholderResumeIsFatal) {
          throw new Error("protocol error: invalid placeholder continuation");
        }
        throw new Error("thread not found");
      }
      const missingResumes = this.missingThreadResumes.get(threadId) ?? 0;
      if (missingResumes > 0) {
        if (Number.isFinite(missingResumes)) this.missingThreadResumes.set(threadId, missingResumes - 1);
        throw new Error(`thread not found: ${threadId}`);
      }
      return { thread: { id: threadId }, approvalsReviewer: this.appliedReviewer(params), ...this.reportedEffort(params), ...this.appliedThreadPolicy(params, threadId) } as T;
    }
    if (method === "turn/start") {
      const threadId = (params as { threadId?: string } | undefined)?.threadId ?? this.threadId;
      const turn = (params ?? {}) as { sandboxPolicy?: unknown; permissions?: unknown };
      if (typeof turn.permissions === "string" && turn.sandboxPolicy !== undefined) throw new Error("`permissions` cannot be combined with `sandboxPolicy`");
      // As Codex 0.153.4: a turn that names a sandbox takes the profile's name off the conversation.
      const held = this.threadPolicies.get(threadId);
      if (held && turn.sandboxPolicy !== undefined) held.activePermissionProfile = null;
      return { turn: { id: `turn-${threadId}` } } as T;
    }
    if (method === "turn/interrupt") {
      this.turnStatus = "interrupted";
      return {} as T;
    }
    if (method === "thread/read") {
      const requestedThreadId = (params as { threadId?: string } | undefined)?.threadId ?? this.threadId;
      this.threadReadCounts.set(requestedThreadId, (this.threadReadCounts.get(requestedThreadId) ?? 0) + 1);
      if (this.options.threadReadTimesOut) {
        throw new Error("Codex app-server request timed out: thread/read");
      }
      if (this.options.threadReadFails) throw new Error("thread endpoint unavailable");
      const missingReads = this.missingThreadReads.get(requestedThreadId) ?? 0;
      if (missingReads > 0) {
        if (Number.isFinite(missingReads)) this.missingThreadReads.set(requestedThreadId, missingReads - 1);
        throw new Error(`thread not found: ${requestedThreadId}`);
      }
      if (
        this.options.threadReadUnmaterialized
        && (params as { includeTurns?: boolean } | undefined)?.includeTurns !== false
      ) {
        throw new Error(
          `thread ${this.threadId} is not materialized yet; includeTurns is unavailable before first user message`,
        );
      }
      return {
        thread: {
          id: requestedThreadId,
          // A real app-server says the folder a conversation works in.
          ...(this.options.threadDirectory ? { cwd: this.options.threadDirectory } : {}),
          status: { type: this.threadStatus },
          turns: [{
            id: `turn-${requestedThreadId}`,
            status: this.turnStatus,
            items: [{ type: "agentMessage", text: "Transcript checkpoint persisted." }],
          }],
        },
      } as T;
    }
    throw new Error(`Unexpected fake RPC request: ${method}`);
  }

  close(): void {
    this.closed = true;
    this.pendingPermissions.clear();
    this.permissionsChanged();
  }

  currentConnectionId(): string | null { return this.connected && !this.closed ? `${this.threadId}-${this.connectionEpoch}` : null; }
  listPendingRequests(): readonly RpcServerRequest[] { return [...this.pendingPermissions.values()]; }
  onRequestResolved(_listener: (request: RpcServerRequest) => void): () => void { return () => {}; }
  onPendingRequestsChanged(listener: () => void): () => void {
    this.permissionListeners.add(listener);
    return () => { this.permissionListeners.delete(listener); };
  }
  readonly requestListeners = new Set<(request: RpcServerRequest) => void>();
  onRequest(listener: (request: RpcServerRequest) => void): () => void {
    this.requestListeners.add(listener);
    return () => { this.requestListeners.delete(listener); };
  }
  private permissionsChanged(): void {
    queueMicrotask(() => { for (const listener of this.permissionListeners) listener(); });
  }
  askPermission(params: Record<string, unknown>, id: RpcServerRequest["id"] = 1,
    method = "item/commandExecution/requestApproval"): RpcServerRequest {
    const request = Object.freeze({ id, method, params: Object.freeze(structuredClone(params)), connectionId: this.currentConnectionId()! });
    this.pendingPermissions.set(id, request);
    this.permissionsChanged();
    // Like the real client: told at arrival, before the pending set's observers.
    for (const listener of this.requestListeners) listener(request);
    return request;
  }
  respond(request: RpcServerRequest, result: unknown): void {
    if (request.connectionId !== this.currentConnectionId() || this.pendingPermissions.get(request.id) !== request) throw new Error("not pending");
    this.pendingPermissions.delete(request.id);
    this.permissionResponses.push({ request, result });
    this.permissionsChanged();
    if (this.responseError) throw new Error("uncertain send");
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  disconnect(): void {
    this.close();
    for (const listener of this.disconnectListeners) listener();
    this.disconnectListeners.clear();
  }

  emit(notification: RpcNotification): void {
    if (notification.method === "serverRequest/resolved") {
      this.pendingPermissions.delete((notification.params as { requestId: RpcServerRequest["id"] }).requestId);
      this.permissionsChanged();
    }
    this.notify(notification);
  }

  markThreadMissing(threadId: string, resumeCount = Number.POSITIVE_INFINITY): void {
    this.missingThreadResumes.set(threadId, resumeCount);
  }
}

export type FakeLaunch = CodexAppServerLaunch & {
  alive: boolean;
  processIdentity: string;
  resolveExit(exit: CodexAppServerExit): void;
};

export const custodialRuntimeContract = {
  format: 1,
  profiles: { cursor_supervised_room_turn: { tools: ["claim_task", "get_board", "read_messages", "send_message", "send_thread_message", "set_reply_thread", "complete_room_turn"] }, supervised_mcp_polling: {
    contract: "custodial_polling_v1", tools: ["wait_for_messages", "read_messages", "send_message"],
  } },
};

export function createHarness(harnessOptions: {
  resumeSupported?: boolean;
  placeholderResumeIsFatal?: boolean;
  workplacePresent?: boolean;
  workplaceProbeTimesOut?: boolean;
  threadReadFails?: boolean;
  threadReadTimesOut?: boolean;
  threadReadUnmaterialized?: boolean;
  identityUnavailableAtLaunch?: boolean;
  processIdentity?: string;
  exitOnSignal?: boolean;
  /** With `exitOnSignal`, the process exits this long after its signal instead of in the same tick. */
  exitAfterMs?: number;
  /** Set when the app-server ignores the requested reviewer and reports this one. */
  reviewerFromOwnSettings?: string;
  /** The folder new threads report instead of the launch folder; null reports none. */
  threadDirectory?: string | null;
  /** The running process's command line cannot be read, as when `ps` does not answer in time. */
  processUnreadable?: boolean;
  /** The running process's command line carries every isolation override, whatever it was started with. */
  commandLineClaimsIsolation?: boolean;
  /** The models the app-server lists instead of the usual two; null is one that cannot list its models, "timeout" one that does not answer in time. */
  models?: readonly FakeCodexModel[] | null | "timeout";
  /** The model list has more pages than the first. */
  moreModelPages?: boolean;
  /** The effort every thread reports instead of the one it was given; null leaves the field out of the reply. */
  effortFromOwnSettings?: string | null;
  /** Every thread reports `reasoningEffort: null`: Codex says that the conversation has no effort. */
  effortReportedAsNull?: boolean;
  /** The Codex home the app-server says it runs with; null is an app-server that does not say. Left out, it cannot be asked. */
  reportedCodexHome?: string | null;
  /** The Codex home each launch is given in place of the owner's. */
  launchCodexHome?: string;
} = {}) {
  const options = harnessOptions;
  const reported = { codexHome: options.reportedCodexHome };
  /** One app-server's conversations keep their policy across the connections of a test. */
  const threadPolicies = new Map<string, HeldThreadPolicy>();
  /** Each time a running process was asked whether a conversation it loaded now would read a command rule, and the answer. */
  const ruleLoadChecks: Array<{ cwd: string; codexHome: string | null }> = [];
  /** For each of those, whether the process's sandbox lets a command write the project. */
  const writableSandboxAsked: boolean[] = [];
  /** Each time a running process without its owner's setup was compared with what a launch would turn off now. */
  const isolationChecks: Array<{ commandLine: string; cwd: string | null; codexHome: string | null; launchOverrides: readonly string[] | null }> = [];
  const isolation: { changed: string | null } = { changed: null };
  const ruleLoad: { refusal: string | null } = { refusal: null };
  const launches: FakeLaunch[] = [];
  const clients: FakeRpc[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const launchOptions: Array<{
    serverUrl: string;
    codexBin: string;
    options: { trustedProjectPath: string; configOverrides: string[]; env?: Record<string, string>; homeHarness?: boolean };
  }> = [];
  /** Each time a running process with the owner's setup was checked against its project, and what the check answers. */
  const liveChecks: Array<{ commandLine: string; cwd: string | null }> = [];
  /** Each time a running process's command line was read. */
  const commandLineReads: number[] = [];
  const project: { changed: string | null } = { changed: null };
  const supervisorBridgeContexts: Array<{
    cwd: string;
    context: Parameters<CodexProviderAdapterDependencies["writeSupervisorBridgeContext"]>[1];
  }> = [];
  const sleeps: number[] = [];
  const mcpRuntimeProbes: string[] = [];
  let nextPid = 4100;
  let nextThread = 1;
  let clock = 0;
  let identityObservable = !(options.identityUnavailableAtLaunch ?? false);
  const processIdentity = options.processIdentity;

  const dependencies: CodexProviderAdapterDependencies = {
    resolveMcpRuntime: (devEntryPath) => ({ entryPath: devEntryPath ?? "/verified/runtime/dist/mcp/server.js", readRoots: ["/verified/runtime"] }),
    readMcpRuntimeContract: async (entryPath) => { mcpRuntimeProbes.push(entryPath); return custodialRuntimeContract; },
    resolveServerUrl: async () => `ws://127.0.0.1:${4700 + launches.length}`,
    launchServer: (serverUrl, codexBin, options) => {
      let resolveExit!: (exit: CodexAppServerExit) => void;
      const launch: FakeLaunch = {
        pid: nextPid++,
        alive: true,
        processIdentity: "",
        exited: new Promise((resolve) => { resolveExit = resolve; }),
        resolveExit: (exit) => {
          launch.alive = false;
          resolveExit(exit);
        },
      };
      launch.processIdentity = processIdentity ?? `fake-process-${launch.pid}-birth-1`;
      launches.push(launch);
      launchOptions.push({ serverUrl, codexBin, options });
      return { pid: launch.pid, exited: launch.exited, ...(harnessOptions.launchCodexHome ? { codexHome: harnessOptions.launchCodexHome } : {}) };
    },
    waitForServer: async () => true,
    createRpcClient: (serverUrl, notify) => {
      const client = new FakeRpc(`thread-${nextThread++}`, notify, {
        threadDirectory: options.threadDirectory !== undefined ? options.threadDirectory
          : launchOptions.find((entry) => entry.serverUrl === serverUrl)?.options.trustedProjectPath ?? null,
        resumeSupported: options.resumeSupported ?? true,
        placeholderResumeIsFatal: options.placeholderResumeIsFatal ?? false,
        workplacePresent: options.workplacePresent ?? true,
        workplaceProbeTimesOut: options.workplaceProbeTimesOut ?? false,
        threadReadFails: options.threadReadFails ?? false,
        threadReadTimesOut: options.threadReadTimesOut ?? false,
        threadReadUnmaterialized: options.threadReadUnmaterialized ?? false,
        reviewerFromOwnSettings: options.reviewerFromOwnSettings ?? null,
        models: options.models === undefined ? FAKE_CODEX_MODELS : options.models,
        moreModelPages: options.moreModelPages ?? false,
        effortFromOwnSettings: options.effortFromOwnSettings,
        effortReportedAsNull: options.effortReportedAsNull ?? false,
      });
      if (reported.codexHome !== undefined) client.reportedCodexHome = () => reported.codexHome!;
      client.threadPolicies = threadPolicies;
      clients.push(client);
      return client;
    },
    signalProcess: (pid, signal) => {
      signals.push({ pid, signal });
      if (options.exitOnSignal) {
        const launch = launches.find((entry) => entry.pid === pid && entry.alive);
        if (options.exitAfterMs === undefined) launch?.resolveExit({ type: "exit", code: null, signal });
        else setTimeout(() => { if (launch?.alive) launch.resolveExit({ type: "exit", code: null, signal }); }, options.exitAfterMs);
      }
    },
    getProcessIdentity: (pid) => identityObservable
      ? launches.find((launch) => launch.pid === pid && launch.alive)?.processIdentity ?? null
      : undefined,
    observeProcessExit: async (pid, processIdentity) => {
      const launch = launches.find((entry) => entry.pid === pid);
      if (!launch) throw new Error(`Unknown fake process ${pid}`);
      if (launch.processIdentity !== processIdentity) {
        return { type: "exit", code: null, signal: null };
      }
      return launch.exited;
    },
    // A running process is read as it was launched: with the isolation overrides unless it kept the owner's setup.
    readCommandLine: async (pid) => {
      commandLineReads.push(pid);
      const launch = launchOptions[launches.findIndex((entry) => entry.pid === pid)];
      if (!launch || options.processUnreadable) return null;
      const isolated = launch.options.homeHarness !== true || options.commandLineClaimsIsolation === true;
      return `codex app-server ${isolated ? CODEX_OWNER_FEATURE_OVERRIDES.map((override) => `-c ${override}`).join(" ") : ""} --listen ${launch.serverUrl}`;
    },
    assertLiveProjectUnchanged: async (_codexBin, live) => {
      liveChecks.push(live);
      if (project.changed) throw new Error(project.changed);
    },
    assertLiveIsolationUnchanged: async (_codexBin, live) => {
      isolationChecks.push(live);
      if (isolation.changed) throw new Error(isolation.changed);
    },
    sandboxedLoadRefusal: async (_codexBin, live) => {
      ruleLoadChecks.push({ cwd: live.cwd, codexHome: live.codexHome });
      writableSandboxAsked.push(live.writableSandbox);
      return ruleLoad.refusal;
    },
    writeSupervisorBridgeContext: async (cwd, context) => {
      supervisorBridgeContexts.push({ cwd, context });
    },
    sleep: async (delayMs) => { sleeps.push(delayMs); },
    now: () => `2026-07-15T00:00:${String(clock++).padStart(2, "0")}.000Z`,
  };

  return {
    dependencies,
    launches,
    clients,
    signals,
    launchOptions,
    supervisorBridgeContexts,
    sleeps,
    mcpRuntimeProbes,
    liveChecks,
    commandLineReads,
    ruleLoadChecks,
    writableSandboxAsked,
    isolationChecks,
    /** A launch now would turn off an MCP server or a skill that the running process was not started with turned off. */
    changeIsolation: (refusal: string | null) => { isolation.changed = refusal; },
    /** A conversation the running process started or loaded now would read a command rule. */
    refuseRuleLoad: (refusal: string | null) => { ruleLoad.refusal = refusal; },
    /** What every app-server connected from now on says its Codex home is. */
    setReportedCodexHome: (codexHome: string | null) => { reported.codexHome = codexHome; },
    /** The project now adds something the running process was not started with turned off. */
    changeProject: (refusal: string) => { project.changed = refusal; },
    setIdentityObservable: (observable: boolean) => { identityObservable = observable; },
  };
}

export function spawnRequest(overrides: Partial<ProviderSpawnRequest> = {}): ProviderSpawnRequest {
  return {
    workAttemptId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    roomId: "focus_37",
    agentDisplayName: "LanternSparrow",
    cwd: "/tmp/letagents-work-attempt",
    launchPolicy: {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
    ...overrides,
  };
}

export function requestByMethod(client: FakeRpc, method: string): RecordedRequest {
  const request = client.requests.find((entry) => entry.method === method);
  assert.ok(request, `expected ${method} request`);
  return request;
}

export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export const approvalParams = (overrides: Record<string, unknown> = {}) => ({
  threadId: "thread-1", turnId: "turn-thread-1", itemId: "item-1", startedAtMs: 1,
  command: "npm test", ...overrides,
});

export const genericPermissionParams = (overrides: Record<string, unknown> = {}) => ({
  threadId: "thread-1", turnId: "turn-thread-1", itemId: "item-1", startedAtMs: 1,
  cwd: "/repo", permissions: {
    network: { enabled: true },
    fileSystem: { entries: [{ access: "write", path: { type: "special", value: { kind: "tmpdir" } } }] },
  },
  reason: "Run the local development server", ...overrides,
});

export const mcpToolPermissionParams = (overrides: Record<string, unknown> = {}) => ({
  threadId: "thread-1", turnId: "turn-thread-1", serverName: "letagents", mode: "form",
  _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"],
    tool_description: "Read the task board", tool_params: { room_id: "room", open_only: false } },
  message: 'Allow the letagents MCP server to run tool "get_board"?',
  requestedSchema: { type: "object", properties: {} }, ...overrides,
});

export const CODEX_READ_ONLY_POLICY = { approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } } as const;
/**
 * The permission profile every request of a Read-only runtime names in place of a sandbox: the one of its work
 * attempt. The launch defines it, as Codex's read-only sandbox with the owner's sign-in file denied to every command.
 */
export const READ_ONLY_PROFILE = codexReadOnlyProfileId(spawnRequest().workAttemptId);

export const READ_ONLY_REPLY = { type: "readOnly", networkAccess: false };
/**
 * What a Read-only thread must not be left with: another sandbox, another approval policy, no word on either,
 * or a read-only sandbox with a part that widens it. Such a part is one whose name speaks of writing, of the
 * network or of an exception to the sandbox, and whose value is anything but off, absent or empty.
 */
export const NOT_READ_ONLY_REPLIES: ReadonlyArray<[string, (client: FakeRpc) => void]> = [
  ["a full-access sandbox", (client) => { client.sandboxFromOwnSettings = { type: "dangerFullAccess" }; }],
  ["a sandbox that allows writes", (client) => { client.sandboxFromOwnSettings = { type: "workspaceWrite", writableRoots: [], networkAccess: false }; }],
  ["a read-only sandbox with network access", (client) => { client.sandboxFromOwnSettings = { type: "readOnly", networkAccess: true }; }],
  ["a read-only sandbox that does not say its network access", (client) => { client.sandboxFromOwnSettings = { type: "readOnly" }; }],
  ["a read-only sandbox with a writable folder", (client) => { client.sandboxFromOwnSettings = { ...READ_ONLY_REPLY, writableRoots: ["/tmp"] }; }],
  ["a read-only sandbox with a network flag that is on", (client) => { client.sandboxFromOwnSettings = { ...READ_ONLY_REPLY, allowLocalNetwork: true }; }],
  ["a read-only sandbox with allowed domains", (client) => { client.sandboxFromOwnSettings = { ...READ_ONLY_REPLY, allowedDomains: ["example.invalid"] }; }],
  ["a read-only sandbox with an exclusion list that is not empty", (client) => { client.sandboxFromOwnSettings = { ...READ_ONLY_REPLY, excludedPaths: ["/tmp"] }; }],
  ["a read-only sandbox with a writable folder inside a part this build does not know", (client) => { client.sandboxFromOwnSettings = { ...READ_ONLY_REPLY, access: { type: "restricted", writableRoots: ["/tmp"] } }; }],
  ["an approval policy that asks", (client) => { client.approvalPolicyFromOwnSettings = "on-request"; }],
  ["no word on the sandbox or the approval policy", (client) => { client.omitsThreadPolicy = true; }],
];
/** Replies a newer Codex could send for a thread that is Read-only all the same: parts this build does not know, none of which widens the sandbox. */
export const STILL_READ_ONLY_REPLIES: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["the exact reply of Codex 0.153.4", { ...READ_ONLY_REPLY }],
  ["a part about reading", { ...READ_ONLY_REPLY, access: { type: "fullAccess" }, readableRoots: ["/"] }],
  ["an unknown flag and an unknown value", { ...READ_ONLY_REPLY, includePlatformDefaults: true, profile: "read-only", version: 2 }],
  ["writing and network parts that are off, absent or empty", { ...READ_ONLY_REPLY, writableRoots: [], allowedDomains: [], networkProxy: null, excludeSlashTmp: false, excludedPaths: [], escalation: {} }],
];

/** A launch at an access level, as the daemon makes it. */
export const levelLaunch = (permissionProfileId: string, launchPolicy: Record<string, unknown>) =>
  ({ deliveryMode: "daemon_inbox" as const, permissionProfileId, configurationRevision: 1, launchPolicy });
export const foundAsReadOnly = () => levelLaunch("read_only", structuredClone(CODEX_READ_ONLY_POLICY));
export const foundAtOtherLevels = () => [
  levelLaunch("full_access", { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }),
  levelLaunch("ask_before_write", { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } }),
  levelLaunch("auto_review", { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" }),
];

/**
 * A process that an earlier adapter started at a level, and another adapter that finds it running.
 * `misreport` changes what the found conversation reports, until `tellTheTruth` is called.
 */
export async function foundRunning(level: ReturnType<typeof levelLaunch>, misreport: ((client: FakeRpc) => void) | null, policyKnown = true) {
  // The process ends when it is signalled, as a real one does.
  const harness = createHarness({ exitOnSignal: true });
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest(level));
  let misreporting = true;
  const createRpcClient = harness.dependencies.createRpcClient;
  harness.dependencies.createRpcClient = (...args) => { const client = createRpcClient(...args) as FakeRpc; if (misreporting) misreport?.(client); return client; };
  const restarted = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const ref = { workAttemptId: first.workAttemptId, providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection };
  return { harness, restarted, first, ref, level, tellTheTruth: () => { misreporting = false; },
    attach: (withPolicy = policyKnown) => restarted.attach({ ...ref, ...(withPolicy ? { launchPolicy: level.launchPolicy } : {}) }) };
}

/** What an attach answers when the adapter stopped the runtime it found: the proof, and the line for the owner. */
export function assertStoppedNotReadOnly(answer: unknown, scene: Awaited<ReturnType<typeof foundRunning>>, what: string): string {
  const stopped = answer as { state?: unknown; terminal?: Record<string, unknown>; notices?: string[] };
  assert.equal(stopped.state, "terminal", what);
  const pid = scene.harness.launches[0]!.pid;
  // The process was told to stop, it is gone, and the answer is the proof of that.
  assert.deepEqual(scene.harness.signals, [{ pid, signal: "SIGTERM" }], what);
  assert.equal(scene.harness.launches[0]!.alive, false, what);
  assert.equal(stopped.terminal!.terminalCause, "stopped", what);
  assert.equal(stopped.terminal!.providerContinuationId, scene.ref.providerContinuationId, what);
  assert.deepEqual(stopped.terminal!.nativeRuntimeDeath, { kind: "codex_app_server", pid, processIdentity: scene.harness.launches[0]!.processIdentity }, what);
  // One line for the owner: what Codex reported, that the agent was stopped, and what happens next.
  assert.equal(stopped.notices?.length, 1, what);
  assert.match(stopped.notices![0]!, new RegExp("^Codex reported (?:approval policy (?:\"[a-z-]+\"|none) and sandbox (?:\"[A-Za-z]+\"|none)(?: with [a-z ]+)? for this agent's conversation\\."
    + "|(?:no permission profile|another permission profile than the one LetAgents gave it) for this agent's conversation, so nothing says that your Codex sign-in file is kept from its commands\\.)"
    + " That is not Read-only access, so LetAgents stopped the agent\\. It starts again by itself, unless you paused it\\.$"), what);
  // No turn was started on it.
  assert.equal(scene.harness.clients.slice(1).some((client) => client.requests.some((call) => call.method === "turn/start")), false, what);
  return stopped.notices![0]!;
}

/**
 * Every room tool a supervised Codex agent is offered, and whether a Read-only agent may use it.
 * The names come from the room server's own registration, so a tool added there fails the test
 * below until it has a line here. "refused" is the answer unless the tool only reads what the room
 * says or says something in it.
 */
export const READ_ONLY_ROOM_TOOL_DECISIONS: Record<string, "approved" | "refused"> = {
  // Reads of what the room says: one request to the room's own server, nothing written anywhere.
  read_messages: "approved",          // the room's recent messages
  get_room_history_summary: "approved",    // a summary of the room's whole history
  expand_room_history_summary: "approved", // one summary line opened, down to a message
  get_current_room: "approved",       // which room the agent is in, and as whom
  get_room_guidelines: "approved",    // the conventions the room's admins wrote
  get_room_memory: "approved",        // the room's saved goals, decisions and terms
  get_human_requests: "approved",     // questions put to a person, and their answers
  get_board: "approved",              // the task board
  get_board_settings: "approved",     // whether the board has a manager, and who
  list_board_intents: "approved",     // requests waiting for the board's manager
  list_wake_rules: "approved",        // what agents in the room are waiting for
  get_room_artifacts: "approved",     // branches, pull requests and checks shared with the room
  get_room_events: "approved",        // GitHub events the room already holds
  // Optional expression lookup, enabled by the Room's human-admin setting.
  search_gifs: "approved",           // provider metadata; no repository writes
  // Saying something in the room.
  send_message: "approved",
  send_thread_message: "approved",
  post_status: "approved",
  post_reasoning: "approved",
  request_human_input: "approved",    // a question in a person's "Needs you" inbox
  set_reply_thread: "approved",       // where the final answer goes; approved at every access level
  set_reply_gif: "approved",          // optional attachment to the same final answer
  react_to_message: "approved",       // room communication under the agent's identity
  // Runs git in a folder the caller names, on this Mac and outside Codex's sandbox.
  check_repo: "refused",
  // The daemon reads the named files on this Mac, outside Codex's sandbox, and posts them to the room.
  set_reply_attachments: "refused",
  // Runs git, then asks GitHub, GitLab or Bitbucket about the repository: another machine.
  check_repo_visibility: "refused",
  // Runs git and writes .letagents.json into the repository.
  initialize_repo: "refused",
  // Joining or creating rooms.
  join_room: "refused", join_code: "refused", join_project: "refused", create_room: "refused", create_project: "refused",
  // Changing the task board, its leases and its reviews.
  add_task: "refused", claim_task: "refused", update_task: "refused", complete_task: "refused",
  claim_task_review: "refused", release_task_review: "refused", handoff_task_lease: "refused", release_task_lease: "refused",
  // Submits a review on GitHub.
  submit_review_verdict: "refused",
  // Board-manager authority and its requests.
  assign_board_manager: "refused", release_board_manager: "refused", set_board_manager_mode: "refused",
  approve_board_intent: "refused", deny_board_intent: "refused", register_board_intent: "refused",
  register_task_claim_intent: "refused", register_task_close_intent: "refused", register_task_create_intent: "refused",
  register_task_lease_action_intent: "refused",
  // Things that outlast the conversation or act later.
  publish_room_artifact: "refused", remember_room_fact: "refused", add_wake_rule: "refused", cancel_wake_rule: "refused",
};

/** Runs one bounded room turn and returns the exact `input` Codex received in `turn/start`. */
export async function codexRoomTurnInput(attachments: ProviderRoomTurnRequest["attachments"]) {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  let input: Array<Record<string, unknown>> | null = null;
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") {
      input = (params as { input: Array<Record<string, unknown>> }).input;
      return { turn: { id: "turn-images" } } as T;
    }
    if (method === "thread/read") return {
      thread: { id: handle.providerContinuationId, turns: [{ id: "turn-images", status: "completed", items: [
        { type: "agentMessage", phase: "final", text: "Seen." },
      ] }] },
    } as T;
    return originalRequest<T>(method, params);
  };
  const pending = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-images", actionId: "action-images",
    sourceMessage: { id: "message-1", text: "What is in these?" },
    activation: { for_current_agent: { reason: "mention" } },
    ...(attachments ? { attachments } : {}),
  }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
  await flush();
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-images" } });
  assert.deepEqual(await pending, { turnId: "turn-images", outcome: "reply", text: "Seen.", evidence: "transcript" });
  return { adapter, input: input! };
}

/**
 * The real adapter over a fake app-server, the real router, and a real daemon
 * with its real delivery, execution capture and shadow store. One supervised
 * daemon-inbox Codex agent is launched, bound and listening when this returns.
 */
export async function codexDaemonFixture(options: {
  /** Answers the nth worker-session mint; the launch's own is the first. */
  mint?: (mints: number) => { expiresInMs?: number; newSession?: boolean } | Error;
  heartbeatMs?: number;
  /** Work leases the room says this agent holds. */
  ownedTasks?: Array<{ id: string; title: string; leaseId: string; epoch: number }>;
  /** The owner turns on the agent's use of their own tool setup before it starts. */
  ownerSetup?: boolean;
  /** A stop request leaves the fake process running until the test ends it with `exitProcess`. */
  holdExits?: boolean;
  /** How long the daemon waits before it restarts an agent whose record blocks its delivery; ten seconds outside tests. */
  recordGraceMs?: number;
  /**
   * A stopped process exits this long after its signal, as a real one does.
   * Left out, it exits in the same tick it is signalled, which no real
   * process does and which is the hardest ordering for the daemon.
   */
  exitAfterMs?: number;
  /**
   * The fake processes carry a start time in the form the operating system
   * reports one, which is what "Restart and resume" checks a saved process by.
   */
  osProcessBirths?: boolean;
} = {}) {
  const { SupervisorDaemon } = await import(new URL("../../daemon/main.ts", import.meta.url).href);
  const { WorkDurabilityStore } = await import(new URL("../../daemon/durability-store.ts", import.meta.url).href);
  const { DAEMON_PROTOCOL_VERSION } = await import(new URL("../../daemon/types.ts", import.meta.url).href);
  const { SupervisedRoomAuthorizationError } = await import(new URL("../../daemon/supervised-agent-delivery.ts", import.meta.url).href);
  const { createConnection } = await import("node:net");
  const { DatabaseSync } = await import("node:sqlite");
  const { generateKeyPairSync, sign } = await import("node:crypto");
  /** The desktop app's key: only a request it signs can change an agent's use of its owner's setup. */
  const host = generateKeyPairSync("ed25519");
  const root = await mkdtemp(join(tmpdir(), "codex-daemon-"));
  const id = "codex_agent";
  const paths = {
    lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"),
    manifestPath: join(root, "daemon-state.sqlite"), auditPath: join(root, "audit.jsonl"),
    attemptsPath: join(root, "attempts.json"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root,
  };
  const request = (method: string, params?: unknown) => new Promise<{ ok: boolean; result?: any; error?: string }>((resolve, reject) => {
    const socket = createConnection(paths.socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      received += chunk;
      if (!received.includes("\n")) return;
      socket.end();
      resolve(JSON.parse(received.slice(0, received.indexOf("\n"))));
    });
    socket.on("connect", () => socket.write(`${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: "test", method, params })}\n`));
  });
  const eventually = async (check: () => Promise<boolean> | boolean, label: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!await check()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const workAttemptId = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const workspace = join(root, "worktrees", "repo", workAttemptId);
  await mkdir(join(root, "repos", "repo.git"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, ".letagents-work-attempt.json"), JSON.stringify({ version: 1, repo: "repo",
    work_attempt_id: workAttemptId, task_id: id, remote_url: "https://example.invalid/repo", resolved_revision: "a".repeat(40),
    bare_path: join(root, "repos", "repo.git") }));
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace, workAttemptId });
  await durability.close();

  // A stop request ends the fake process, so a runtime the daemon decides to
  // replace is really replaced and a test can see it.
  const harness = createHarness({ exitOnSignal: !options.holdExits, exitAfterMs: options.exitAfterMs,
    ...(options.osProcessBirths ? { processIdentity: "Fri Oct  2 19:00:00 2026" } : {}) });
  /** The sealed MCP runtime's tools. An app update that changes them changes every agent's launch contract. */
  let sealedRuntime: unknown = custodialRuntimeContract;
  /** Set once a daemon has been restarted: an app-server it re-attaches serves the agent's thread from its first request. */
  let serveOnConnect: ((server: FakeRpc) => void) | null = null;
  let onNextConnect: ((server: FakeRpc) => void) | null = null;
  const makeAdapter = () => new CodexProviderAdapter({ dependencies: { ...harness.dependencies, now: () => new Date().toISOString(),
    readMcpRuntimeContract: async () => sealedRuntime,
    createRpcClient: (serverUrl, notify) => {
      const server = harness.dependencies.createRpcClient(serverUrl, notify);
      serveOnConnect?.(server as FakeRpc);
      const connected = onNextConnect;
      onNextConnect = null;
      // Before the adapter has finished starting on or attaching to this app-server.
      if (connected) queueMicrotask(() => connected(server as FakeRpc));
      return server;
    },
    // Waits are real here, only short, so that what the app-server sends
    // within milliseconds still arrives before a wait of seconds runs out.
    sleep: async (ms) => { harness.sleeps.push(ms); await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 40))); },
    // An app-server takes time to start. A replacement that is up in the same
    // millisecond its predecessor exits is not something a real one does, and
    // the daemon's settling of that exit is not built for it.
    waitForServer: async () => { await new Promise((resolve) => setTimeout(resolve, 200)); return true; } } });
  let adapter = makeAdapter();
  const roomMessages: Array<Record<string, unknown>> = [];
  const published: string[] = [];
  let mints = 0;
  /** Moves the daemon's clock ahead of the wall clock; its timers stay real. */
  let clockAheadMs = 0;
  /** Renewals of the desktop's grant that were asked for, and what a test makes them wait on. */
  const renewals = { started: 0, held: null as Promise<void> | null };
  /** Bearers of a session the room has ended. The grant that minted them still mints. */
  const endedBearers = new Set<string>();
  /** Every reference the daemon has asked the provider to attach, in order. */
  const attachedRefs: Array<{ workAttemptId: string; ownerSetup?: true | "unknown" }> = [];
  const makeDaemon = () => new SupervisorDaemon(paths, "darwin", (() => {
    const router = new ProviderActionPortRouter({ codex: async () => adapter });
    const attach = router.attach.bind(router);
    router.attach = async (ref: { workAttemptId: string; ownerSetup?: true | "unknown" }) => { attachedRefs.push({ ...ref }); return attach(ref); };
    return router;
  })(), true,
    options.heartbeatMs ?? 50, undefined, { nowMs: () => Date.now() + clockAheadMs }, {
      poll: async ({ afterMessageId, bearer, signal }: { afterMessageId: string | null; bearer: string; signal: AbortSignal }) => {
        // The server's answer for a bearer whose session has ended, for any reason.
        if (endedBearers.has(bearer)) throw new SupervisedRoomAuthorizationError("Supervised room poll failed with HTTP 401.", 401);
        const from = afterMessageId ? roomMessages.findIndex((message) => message.id === afterMessageId) + 1 : 0;
        if (roomMessages.length > from) return { messages: roomMessages.slice(from) };
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 20);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        return { messages: [] };
      },
      publish: async (input: { text: string; roomId: string }) => {
        published.push(input.text);
        return { messageId: `msg_${900 + published.length}`, roomId: input.roomId };
      },
      ...(options.ownedTasks ? { ownedTasks: async () => options.ownedTasks! } : {}),
    }, {
      listWorkLeases: async () => [], readWorkLease: async () => null,
      attestWorkLease: async () => { throw new Error("unused"); },
      rebindWorkLease: async () => { throw new Error("unused"); },
      renewHostGrant: async (input: { grantId: string; grantGeneration: number }) => {
        renewals.started += 1;
        await renewals.held;
        return { grantId: input.grantId, grantGeneration: input.grantGeneration, supervisorGrant: `${id}-parent-${renewals.started}`,
          expiresAt: new Date(Date.now() + clockAheadMs + 24 * 60 * 60_000).toISOString() };
      },
      // What "Restart and resume" asks the server before it starts the agent again.
      endWorkerSession: async () => {},
      createWorkerSession: async () => {
        mints += 1;
        const answer = options.mint?.(mints) ?? {};
        if (answer instanceof Error) throw answer;
        return { sessionId: answer.newSession ? `${id}-session-${mints}` : `${id}-session`, bearer: `${id}-bearer-${mints}`, bearerId: `${id}-bearer-id-${mints}`,
          expiresAt: new Date(Date.now() + (answer.expiresInMs ?? 24 * 60 * 60_000)).toISOString() };
      },
    });
  let daemon = makeDaemon();
  const read = <T>(sql: string): T[] => {
    const database = new DatabaseSync(paths.manifestPath, { readOnly: true });
    try { return database.prepare(sql).all(id).map((row) => ({ ...row })) as T[]; } finally { database.close(); }
  };
  const cleanup = async () => {
    // A stop fences the daemon's commits, and a stream callback that was
    // still running is refused by that fence. The stop finishes all the same.
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  };
  try {
    const startDaemon = async () => {
      await daemon.start({ getHostApprovalPublicKey: async () => host.publicKey.export({ format: "der", type: "spki" }).toString("base64") });
      (daemon as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
      if (options.recordGraceMs !== undefined) {
        (daemon as unknown as { runtimeConfigurationApply: { recordBlockGraceMs: number } }).runtimeConfigurationApply.recordBlockGraceMs = options.recordGraceMs;
      }
      // "Restart and resume" asks the operating system whether the saved
      // process still runs; here the fake processes answer for themselves.
      (daemon as unknown as { runtimeRecovery: { options: { processIdentity?: unknown } } }).runtimeRecovery.options.processIdentity = {
        probe: (pid: number) => {
          if (!harness.launches.some((launch) => launch.pid === pid && launch.alive)) throw Object.assign(new Error("process gone"), { code: "ESRCH" });
        },
        readBirthIdentity: (pid: number) => harness.launches.find((launch) => launch.pid === pid)?.processIdentity ?? "",
        sameBirthIdentity: (actual: string, expected: string) => actual === expected,
      };
    };
    await startDaemon();
    const inbox = () => (daemon as unknown as { supervisedInbox: {
      bootstrapCursor(input: { agent_id: string; room_id: string; last_observed_message_id: string | null }): Promise<unknown>;
      receipts(agentId: string): Promise<Array<{ source_message_id: string; state: string; last_error: string | null; provider_turn_id: string | null }>>;
    } }).supervisedInbox;
    assert.equal((await request("manifest.put", { entry: {
      id, room_id: "room_1", display_name: "Agent", provider: "codex", model: null, charter: "test",
      desired_state: options.ownerSetup ? "paused" : "running", observed_state: "absent", condition: "none",
      permission_profile_id: options.ownerSetup ? "full_access" : null,
      ...(options.ownerSetup ? { provider_launch_policy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } } : {}),
      created_by: "test", created_at: "2026-01-01T00:00:00.000Z", delivery_mode: "daemon_inbox",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    await inbox().bootstrapCursor({ agent_id: id, room_id: "room_1", last_observed_message_id: null });
    let daemonGeneration = (await request("daemon.status")).result.generation;
    /** What the desktop app sends when the owner flips "use my own setup" for this agent. */
    const setOwnerSetup = async (enabled: boolean) => {
      const challenge = (await request("supervisor.host_approval_challenge")).result;
      const configuration = (await request("supervisor.get_agent_configuration", { entry_id: id, daemon_generation: daemonGeneration })).result;
      const issuedAt = Date.now();
      const payload = JSON.stringify({ domain: "letagents.host-approval", version: 1, ...challenge, operation: "set_home_harness",
        input: { entryId: id, daemonGeneration, expectedRevision: configuration.config_revision, enabled }, issuedAt, expiresAt: issuedAt + 30_000 });
      return request("supervisor.host_approval_request", { payload, signature: sign(null, Buffer.from(payload), host.privateKey).toString("base64") });
    };
    /** What the desktop app sends when the owner changes the agent's reasoning effort and uses "Restart to apply changes". */
    const changeEffortAndRestart = async () => {
      const configuration = (await request("supervisor.get_agent_configuration", { entry_id: id, daemon_generation: daemonGeneration })).result;
      const saved = await request("supervisor.update_agent_configuration", { entry_id: id, daemon_generation: daemonGeneration,
        expected_revision: configuration.config_revision, configuration: { model: configuration.model, reasoning_effort: "high",
          charter: configuration.charter, permission_profile_id: configuration.permission_profile_id } });
      assert.equal(saved.result?.outcome, "updated", saved.error ?? saved.result?.error);
      // While the last turn is still being wrapped up the answer is "busy":
      // the app says so and the owner presses the button again.
      for (const deadline = Date.now() + 10_000; ;) {
        const applied = await request("supervisor.apply_agent_configuration", { entry_id: id, daemon_generation: daemonGeneration,
          expected_configuration_revision: configuration.config_revision + 1 });
        if (applied.result?.outcome !== "busy_active_turn" || Date.now() >= deadline) return applied;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    if (options.ownerSetup) {
      const on = await setOwnerSetup(true);
      assert.equal(on.ok, true, on.error);
    }
    /** The desktop app hands every daemon it starts the grant its agents work under. */
    const installGrant = async () => assert.equal((await request("supervisor.install_host_grant", {
      entry_id: id, room_id: "room_1", agent_key: "owner/agent", grant_id: `grant-${id}`,
      supervisor_grant: `${id}-parent`, grant_generation: 1, api_url: "https://letagents.example", daemon_generation: daemonGeneration,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: new Date(Date.now() + clockAheadMs + 2 * 60 * 60_000).toISOString(),
    })).ok, true);
    await installGrant();
    const view = async () => (await request("manifest.list")).result[0] as {
      observed_state: string; condition: string; last_error: string | null;
      room_agent_state: { connection: { state: string }; ingress: { state: string; detail: string | null }; inbox: { state: string } };
    };
    if (options.ownerSetup) {
      const resumed = await request("manifest.set_desired_state", { id, desired_state: "running" });
      assert.equal(resumed.ok, true, resumed.error);
    }
    await eventually(() => harness.clients.length === 1, "the provider is launched").catch(async (error) => {
      const current = (await request("manifest.list")).result[0];
      throw new Error(`${(error as Error).message}: agent is ${current?.observed_state}/${current?.condition} (${current?.last_error})`);
    });
    if (!options.mint) {
      await eventually(async () => (await view())?.room_agent_state?.ingress.state === "observing", "the agent listens to its room");
    }

    const client = harness.clients[0]!;
    const threadId = client.threadId;
    const turns: Array<Record<string, unknown>> = [];
    /** Every app-server of this agent serves the one thread and its turns. */
    const serveThread = (server: typeof client) => {
      const originalRequest = server.request.bind(server);
      server.request = async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "turn/start") {
          turns.push({ id: `turn-${turns.length + 1}`, status: "inProgress", items: [] });
          return { turn: { id: turns.at(-1)!.id } } as T;
        }
        // As a real app-server reports it: a failed turn leaves the thread
        // in `systemError` until its next turn starts.
        if (method === "thread/read") {
          const last = turns.at(-1)?.status;
          const status = last === "inProgress" ? "active" : last === "failed" ? "systemError" : "idle";
          // A turn its process ended under before it reached the thread's own record is not in what a later process reads.
          return { thread: { id: threadId, status: { type: status }, turns: turns.filter((turn) => turn.notInThread !== true) } } as T;
        }
        if (method === "thread/loaded/list") return { data: [threadId], nextCursor: null } as T;
        return originalRequest<T>(method, params);
      };
    };
    serveThread(client);
    const receipt = async (messageId: string) => (await inbox().receipts(id)).find((item) => item.source_message_id === messageId);
    /**
     * Send one room message to the agent and end its turn the way the
     * app-server would. `beforeEnding` runs between a refusal's `systemError`
     * and its `turn/completed`.
     */
    const deliver = async (ordinal: number, ending: { refusal: string; beforeEnding?: () => Promise<void> } | { answer: string }) => {
      const messageId = `msg_${ordinal}`;
      roomMessages.push({ id: messageId, sender: "someone", text: `request ${ordinal}`,
        activation: { for_current_agent: { decision: "activate" } } });
      await eventually(async () => turns.length === ordinal && Boolean((await receipt(messageId))?.provider_turn_id),
        `${messageId} starts its own turn`);
      const turn = turns[ordinal - 1]!;
      const identity = { threadId, turnId: turn.id };
      client.emit({ method: "turn/started", params: { ...identity, turn: { id: turn.id, status: "inProgress" } } });
      if ("refusal" in ending) {
        Object.assign(turn, { status: "failed", error: { message: ending.refusal, codexErrorInfo: "cyberPolicy" } });
        // The order the app-server sends when the provider refuses a turn.
        client.emit({ method: "thread/status/changed", params: { threadId, status: { type: "systemError" } } });
        client.emit({ method: "error", params: { ...identity, willRetry: false, error: turn.error } });
        await ending.beforeEnding?.();
      } else {
        Object.assign(turn, { status: "completed", items: [{ type: "agentMessage", phase: "final", text: ending.answer }] });
        client.emit({ method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
      }
      client.emit({ method: "turn/completed", params: { ...identity, turn } });
      const settled = "refusal" in ending ? "acknowledged_failed" : "acknowledged";
      await eventually(async () => (await receipt(messageId))?.state === settled, `${messageId} settles ${settled}`).catch(async (error) => {
        const row = await receipt(messageId);
        const current = await view();
        throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error}); agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
      });
      return (await receipt(messageId))!;
    };
    const startSuccessor = async () => {
      serveOnConnect = serveThread;
      adapter = makeAdapter();
      daemon = makeDaemon();
      await startDaemon();
      daemonGeneration = (await request("daemon.status")).result.generation;
      await installGrant();
    };
    return { id, harness, client, threadId, request, eventually, view, read, deliver, published, roomMessages, turns, receipt, serveThread, setOwnerSetup, changeEffortAndRestart,
      receipts: () => inbox().receipts(id), mints: () => mints, cleanup, passTime: (ms: number) => { clockAheadMs += ms; },
      /** Execution capture has recorded the ending of this many message turns. An owner acts after that, not within the same millisecond. */
      turnsRecorded: (count: number) => eventually(() => read<{ n: number }>(
        "SELECT COUNT(*) AS n FROM execution_message_attempts WHERE agent_id=? AND conclusion IS NOT NULL")[0]!.n === count,
        `capture records ${count} turn ending(s)`),
      /**
       * What an app update does to a running agent: the daemon of the new app
       * computes its launch contract from a sealed runtime that changed, so
       * the runtime launched by the old app no longer matches it.
       */
      updateApp: () => {
        sealedRuntime = { ...custodialRuntimeContract, profiles: { ...custodialRuntimeContract.profiles,
          cursor_supervised_room_turn: { tools: [...custodialRuntimeContract.profiles.cursor_supervised_room_turn.tools, "post_status"] } } };
        (daemon as unknown as { runtimeConfigurationApply: { desiredContracts: Map<string, string> } }).runtimeConfigurationApply.desiredContracts.clear();
      },
      /** What a room admin's disconnect does: the agent's session ends, its grant stays valid. */
      endRoomSession: () => { for (let n = 1; n <= mints; n += 1) endedBearers.add(`${id}-bearer-${n}`); },
      converge: () => (daemon as unknown as { requestConvergence(entryId: string): void }).requestConvergence(id),
      /**
       * The daemon's recording of a runtime's exit: the ports it records
       * through, for a test to fail a step, how long the recording may take,
       * and whether an exit of this agent is still being recorded.
       */
      exitSettlement: () => (daemon as unknown as { providerTerminals: {
        ports: { settleRuntimeApprovals(...args: unknown[]): Promise<void>; serializeEntry<T>(entryId: string, operation: () => Promise<T>): Promise<T>;
          durability: { recordTerminal(...args: unknown[]): Promise<unknown> }; exitUnsettled(entryId: string, exitId: string): void };
        bounds: { settleMs: number; lastAttemptMs: number; recordMs: number }; settling(entryId: string): boolean;
      } }).providerTerminals,
      daemonGeneration: () => daemonGeneration,
      /**
       * The ordering a loaded machine produces by itself: the daemon is
       * stopped while it is writing the agent's activity, the stop's fence
       * refuses the write, and the stop comes to wait for that callback while
       * it is still ending. `release` lets the held write go on.
       */
      holdActivityWrites: (failure?: Error) => {
        const streams = (daemon as unknown as { providerStreams: { disposeAll(): Promise<void>; track(operation: Promise<void>): void;
          options: { appendNativeActivity(...args: unknown[]): Promise<unknown> } } }).providerStreams;
        const write = streams.options.appendNativeActivity;
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let waiting = 0, heldSequence = 0;
        // With a failure, the held write fails with it once released, as a write that loses a race does.
        streams.options.appendNativeActivity = async (...args: unknown[]) => {
          waiting += 1; heldSequence = (args[1] as { sequence: number }).sequence; await held;
          if (failure) throw failure;
          return write(...args);
        };
        let stopWaits!: () => void;
        const waited = new Promise<void>((resolve) => { stopWaits = resolve; });
        const track = streams.track.bind(streams);
        // A callback that fails is still ending when the stop comes to wait for it.
        streams.track = (operation) => track(operation.catch(async (error) => { await waited; throw error; }));
        const dispose = streams.disposeAll.bind(streams);
        streams.disposeAll = () => { const disposing = dispose(); stopWaits(); return disposing; };
        return { waiting: () => waiting, heldSequence: () => heldSequence, release };
      },
      /** The process of the nth runtime ends now, as it does some time after a stop request or when it crashes. */
      exitProcess: (launch: number, signal: NodeJS.Signals | null = "SIGTERM") =>
        harness.launches[launch]!.resolveExit({ type: "exit", code: signal ? null : 1, signal }),
      /** Whether the daemon still holds a runtime for the agent. It lets go of one the moment its process exits. */
      holdsRuntime: () => (daemon as unknown as { liveHandles: Map<string, unknown> }).liveHandles.has(id),
      attachedRefs: () => attachedRefs,
      /** Whether the daemon records the runtime it holds as started with the owner's own setup. */
      holdsOwnerSetup: () => (daemon as unknown as { liveHandles: Map<string, { ownerSetup?: true }> }).liveHandles.get(id)?.ownerSetup === true,
      /**
       * The desktop's grant is renewed in the middle of a convergence pass,
       * and that is a request to the server. From here on such a request
       * waits, as it does on a slow network, until the returned function
       * answers it.
       */
      holdGrantRenewals: () => {
        let answer!: () => void;
        renewals.held = new Promise<void>((resolve) => { answer = resolve; });
        return () => { renewals.held = null; answer(); };
      },
      grantRenewals: () => renewals.started,
      /** Runs once, for the next app-server the adapter connects to, while the adapter is still starting on it or attaching to it. */
      whenNextConnects: (act: (server: FakeRpc) => void) => { onNextConnect = act; },
      /**
       * What an app update, or a daemon crash, does to a running agent: its
       * daemon ends, its app-server keeps running, and a new daemon with a
       * new adapter finds the process and attaches to it.
       */
      restartDaemon: async () => {
        await daemon.stop();
        await startSuccessor();
      },
      /** The socket the daemon listens on: open, it keeps the process alive. */
      socketPath: paths.socketPath,
      /** A new daemon on the same paths, once the last one has stopped, however its stop ended. */
      startSuccessor,
      /** Change the daemon's saved state directly, to stand an agent in a state an earlier build left behind. */
      write: (sql: string, ...values: Array<string | number | null>) => {
        const database = new DatabaseSync(paths.manifestPath);
        try { database.prepare(sql).run(...values); } finally { database.close(); }
      },
      workAttemptId,
      /** The causes of the agent's recorded state changes, oldest first. */
      transitionCauses: async () => (await readFile(paths.auditPath, "utf8")).split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { entry_id?: string; cause?: string }).filter((line) => line.entry_id === id).map((line) => line.cause ?? "") };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** What the desktop app sends for "Restart to apply changes": the saved settings start a new runtime. Asked again while a turn is wrapping up. */
export async function applySavedSettings(agent: Awaited<ReturnType<typeof codexDaemonFixture>>) {
  const configuration = (await agent.request("supervisor.get_agent_configuration", { entry_id: agent.id, daemon_generation: agent.daemonGeneration() })).result;
  for (const deadline = Date.now() + 10_000; ;) {
    const applied = await agent.request("supervisor.apply_agent_configuration", { entry_id: agent.id, daemon_generation: agent.daemonGeneration(),
      expected_configuration_revision: configuration.config_revision });
    if (applied.result?.outcome !== "busy_active_turn" || Date.now() >= deadline) return applied;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The owner changes the switch and restarts the agent to apply it, and the runtime that starts is the nth one. */
export async function switchOwnerSetupAndApply(agent: Awaited<ReturnType<typeof codexDaemonFixture>>, enabled: boolean, runtime: number) {
  const saved = await agent.setOwnerSetup(enabled);
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.result?.outcome, "updated", saved.error ?? saved.result?.error);
  // Turning it off replaces a runtime that has it by itself. Turning it on waits for the owner's restart.
  if (enabled) {
    const applied = await applySavedSettings(agent);
    assert.equal(applied.result?.outcome, "restarting", applied.error ?? JSON.stringify(applied.result));
  }
  await agent.eventually(() => agent.harness.launches.length === runtime && agent.harness.clients.length === runtime, `runtime ${runtime} is started`).catch(async (error) => {
    const current = await agent.view();
    throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
  });
  agent.serveThread(agent.harness.clients[runtime - 1]!);
}

/** Whether the daemon, once it holds the agent's runtime, asked that runtime to list its MCP servers when it attached it. */
export const attachedAsIsolated = (agent: Awaited<ReturnType<typeof codexDaemonFixture>>) =>
  agent.harness.clients.at(-1)!.requests.some((request) => request.method === "mcpServerStatus/list");

/**
 * Puts one convergence pass between a runtime's exit and the settlement of
 * that exit. A pass renews the desktop's grant when it is due, which is a
 * request to the server, and the process exits while the pass waits for the
 * answer. Under load the same ordering happens without any wait; this
 * produces it every time.
 */
export async function convergeAcrossExit(agent: Awaited<ReturnType<typeof codexDaemonFixture>>, exit: () => void) {
  const answerRenewal = agent.holdGrantRenewals();
  const renewalsBefore = agent.grantRenewals();
  // The grant has under an hour left: the next pass renews it.
  agent.passTime(61 * 60_000);
  agent.converge();
  await agent.eventually(() => agent.grantRenewals() > renewalsBefore, "a convergence pass waits on the grant's renewal");
  exit();
  await agent.eventually(() => !agent.holdsRuntime(), "the daemon lets go of the exited runtime");
  answerRenewal();
}

/** Run the agent's nth message on its newest runtime and answer it. */
export async function answerOnReplacement(agent: Awaited<ReturnType<typeof codexDaemonFixture>>, ordinal: number) {
  const successor = agent.harness.clients.at(-1)!;
  agent.serveThread(successor);
  // Unless it was sent earlier and has been waiting for this runtime.
  if (!agent.roomMessages.some((message) => message.id === `msg_${ordinal}`)) {
    agent.roomMessages.push({ id: `msg_${ordinal}`, sender: "someone", text: `request ${ordinal}`,
      activation: { for_current_agent: { decision: "activate" } } });
  }
  await agent.eventually(async () => agent.turns.length === ordinal && Boolean((await agent.receipt(`msg_${ordinal}`))?.provider_turn_id),
    `msg_${ordinal} starts its turn on the replacement`, 8_000).catch(async (error) => {
    const current = await agent.view();
    throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
  });
  const turn = agent.turns[ordinal - 1]!;
  successor.emit({ method: "turn/started", params: { threadId: agent.threadId, turnId: turn.id, turn: { id: turn.id, status: "inProgress" } } });
  Object.assign(turn, { status: "completed", items: [{ type: "agentMessage", phase: "final", text: `Answer ${ordinal}.` }] });
  successor.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
  successor.emit({ method: "turn/completed", params: { threadId: agent.threadId, turnId: turn.id, turn } });
  await agent.eventually(async () => (await agent.receipt(`msg_${ordinal}`))?.state === "acknowledged", `msg_${ordinal} is answered`);
}

/**
 * What stops the daemon recording an exit, for as long as a test lasts.
 * Each returns what ends the fault, for the test to call when it is done:
 * a daemon cannot be stopped under a step that never returns.
 */
export type ExitSettlement = ReturnType<Awaited<ReturnType<typeof codexDaemonFixture>>["exitSettlement"]>;
export const EXIT_RECORDING_FAULTS = {
  "closing its approvals fails every time": (terminals: ExitSettlement) => {
    const original = terminals.ports.settleRuntimeApprovals;
    terminals.ports.settleRuntimeApprovals = async () => { throw new Error("approval storage fault"); };
    return () => { terminals.ports.settleRuntimeApprovals = original; };
  },
  "closing its approvals never returns": (terminals: ExitSettlement) => {
    const original = terminals.ports.settleRuntimeApprovals;
    let end!: () => void;
    const ended = new Promise<void>((resolve) => { end = resolve; });
    terminals.ports.settleRuntimeApprovals = async (...args) => { await ended; return original(...args); };
    return () => { terminals.ports.settleRuntimeApprovals = original; end(); };
  },
  "its entry's queue never answers": (terminals: ExitSettlement) => {
    const original = terminals.ports.serializeEntry;
    let end!: () => void;
    const ended = new Promise<void>((resolve) => { end = resolve; });
    terminals.ports.serializeEntry = async (entryId, operation) => { await ended; return original(entryId, operation); };
    return () => { terminals.ports.serializeEntry = original; end(); };
  },
  "saving its terminal fails every time": (terminals: ExitSettlement) => {
    const original = terminals.ports.durability;
    terminals.ports.durability = Object.create(original, {
      recordTerminal: { value: async () => { throw new Error("terminal storage fault"); } } });
    return () => { terminals.ports.durability = original; };
  },
  "saving its terminal never returns": (terminals: ExitSettlement) => {
    const original = terminals.ports.durability;
    let end!: () => void;
    const ended = new Promise<void>((resolve) => { end = resolve; });
    terminals.ports.durability = Object.create(original, {
      recordTerminal: { value: async (...args: unknown[]) => { await ended; return original.recordTerminal(...args); } } });
    return () => { terminals.ports.durability = original; end(); };
  },
} as const;

export const OUTPUT_CLOSED_BY = {
  "the commands' ends": (emit: (method: string, params: Record<string, unknown>) => void, ids: string[]) => {
    for (const id of ids) emit("item/completed", { item: { id, type: "commandExecution", status: "completed", exitCode: 0 } });
  },
  "the turn's end": (emit: (method: string, params: Record<string, unknown>) => void) => {
    emit("turn/completed", { turn: { id: "turn-1", status: "completed" } });
  },
  "the process exiting": (emit: (method: string, params: Record<string, unknown>) => void) => {
    emit("process/systemError", { status: "systemError" });
  },
} as const;

export const ACTIVITY_RECORD_STOPPED = "LetAgents stopped recording this agent's activity: part of the record could not be kept. The agent keeps working, and its messages are not affected.";
export const ACTIVITY_RECORD_CONTINUED = "Part of this agent's activity record is missing; LetAgents continued with a new record.";

/** What the agent's execution record holds about its observer, its turns and its recovery boundaries. */
export function executionRecord(agent: Awaited<ReturnType<typeof codexDaemonFixture>>) {
  return {
    observer: () => agent.read<{ last: number; max: number; runtime: string; source: string | null }>(`SELECT last_source_sequence AS last,
      max_observed_sequence AS max, observer_runtime_generation_id AS runtime, source_id AS source FROM execution_observers WHERE agent_id=?`)[0],
    boundaries: () => agent.read<{ operation_id: string; runtime_generation_id: string; phase: string; mode: string; observer_json: string | null; provider_ref_json: string }>(
      "SELECT operation_id,runtime_generation_id,phase,mode,observer_json,provider_ref_json FROM agent_runtime_recoveries WHERE agent_id=? ORDER BY created_at,operation_id"),
    turns: () => agent.read<{ provider_turn_id: string; state: string }>(
      "SELECT provider_turn_id,state FROM execution_turns WHERE agent_id=? ORDER BY created_at_ms,provider_turn_id"),
    notices: async () => ((await agent.request("manifest.list")).result[0].activity as Array<{ kind: string; summary: string }>)
      .filter((event) => event.kind === "launch_notice").map((event) => event.summary),
  };
}

/** A turn ending the adapter cannot attribute uses up a position in the record without a fact: a gap from here on. */
export async function openRecordGap(agent: Awaited<ReturnType<typeof codexDaemonFixture>>) {
  agent.client.emit({ method: "turn/completed", params: {
    threadId: agent.threadId, turnId: "unknown-turn", turn: { id: "another-turn", status: "completed" },
  } });
  const record = executionRecord(agent);
  await agent.eventually(() => { const row = record.observer(); return Boolean(row && row.max > row.last); }, "the gap is in the record");
  return record.observer()!;
}

/**
 * States that agents were found in on a real installation, after builds that
 * still had the causes fixed above. Each is rebuilt here from rows of the same
 * shape: which runtime the row is on, what the record says of that runtime and
 * how its generation ended. No message content is involved.
 */
export const RECORDS_LEFT_BEHIND = {
  // The record stops one position short of what its runtime sent.
  "a gap": { on: "last", gap: 1, turn: null, unstarted: 0, runtime: null, ending: null },
  // A long burst of output overflowed the record under a turn: the turn is
  // still open, later turns never started, and the runtime still reads as running.
  "a gap under a turn left active": { on: "last", gap: 1_347, turn: "active", unstarted: 3, runtime: ["ready", "responsive"], ending: null },
  // The runtime ended under a turn, and the turn was never closed.
  "a turn lost with its runtime": { on: "last", gap: 0, turn: "lost", unstarted: 0, runtime: null, ending: null },
  // The same on an earlier runtime, whose ending carries no evidence of the process.
  "a turn lost on an earlier runtime": { on: "earlier", gap: 0, turn: "lost", unstarted: 0, runtime: ["exited", "lost"], ending: "stopped" },
  // A turn whose ending was never recorded, on an earlier runtime that crashed and still reads as running.
  "a turn left active on an earlier runtime": { on: "earlier", gap: 0, turn: "active", unstarted: 0, runtime: ["ready", "responsive"], ending: "crashed" },
} as const;

export const RECORD_RESTART_PENDING = "Part of this agent's activity record is missing. LetAgents restarts the agent when it is idle and continues with a new record; messages wait until then.";

export const effortNotGiven = (effort: string, model: string) =>
  `This agent's reasoning effort "${effort}" was not given to Codex, because the model "${model}" does not take it. `
  + "The agent runs with the effort Codex gives it. Choose another effort in the agent's settings.";
export const effortNotReported = (given: string, reported: string) =>
  `This agent's reasoning effort "${given}" was given to Codex, but Codex reports "${reported}" for the conversation. `
  + "The agent runs with the effort Codex reports.";
/** What the daemon does with a repair's result: it records the lines, then tells the provider that they are recorded. */
export function recordedByDaemon(result: { notices?: readonly string[]; noticesRecorded?: () => void }): readonly string[] {
  result.noticesRecorded?.();
  return result.notices ?? [];
}
export const effortReportedAsNone = (given: string) =>
  `This agent's reasoning effort "${given}" was given to Codex, but Codex reports no effort for the conversation. `
  + "The agent runs with the effort Codex gives it.";

/** The access level every launch below runs under: the default policy of these tests is Full access. */
export const FULL_ACCESS = { permissionProfileId: "full_access", configurationRevision: 1 };

export const OWN_SETUP_LAUNCH = { deliveryMode: "daemon_inbox" as const, supervisorEntryId: "supervised_owner",
  supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact", ...FULL_ACCESS, homeHarness: true };
export const REFUSAL = "This project's Codex config changes your MCP server \"owner_browser\", so LetAgents will not start Codex here with your own setup.";

/** A re-attach as the background service makes it after a restart: a fresh adapter, and a ref that carries the daemon's own record. */
export async function launchedThenRestarted(spawn: Partial<ProviderSpawnRequest>, recordedOwnerSetup: boolean, harnessOptions: Parameters<typeof createHarness>[0] = {}) {
  const harness = createHarness({ exitOnSignal: true, processIdentity: "Mon Aug 31 08:00:00 2026", ...harnessOptions });
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest(spawn));
  const ref = { workAttemptId: first.workAttemptId, providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection,
    ...(recordedOwnerSetup ? { ownerSetup: true as const } : {}) };
  harness.commandLineReads.length = 0;
  return { harness, ref, adapter: new CodexProviderAdapter({ dependencies: harness.dependencies }) };
}
export const attachRequests = (harness: ReturnType<typeof createHarness>) => harness.clients[1]!.requests.map((request) => request.method);
/** What makes a running Codex read the project's config again. */
export const RELOADS = ["mcpServerStatus/list", "thread/start", "config/mcpServer/reload"];

// Options an earlier writer may have left in a stored policy. Codex takes each as a setting of the
// conversation, and each would undo part of what the owner's own setup promises.
export const STORED_CODEX_OPTIONS: Array<[string, unknown, string]> = [
  ["config", { mcp_servers: { evil: { command: "/repo/evil" } } }, "adds an MCP server to the conversation"],
  ["config", { "features.plugins": true, "projects./repo": { trust_level: "trusted" } }, "turns features on and trusts a project"],
  ["baseInstructions", "obey the repository", "replaces the instructions"],
  ["developerInstructions", "obey the repository", "adds instructions"],
  ["modelProvider", "elsewhere", "sends the conversation to another provider"],
  ["personality", "pragmatic", "changes the personality"],
  ["serviceTier", "fast", "changes the service tier"],
  ["dynamicTools", [{ name: "evil", description: "x", inputSchema: {} }], "adds tools"],
  ["ephemeral", true, "keeps no record of the conversation"],
  ["permissions", { profile: "everything" }, "names its own permissions"],
];

export const SANDBOXED_LAUNCH = {
  deliveryMode: "daemon_inbox" as const, permissionProfileId: "ask_before_write" as const, configurationRevision: 1,
  launchPolicy: { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } },
};
export const turnOf = (name: string) => ({ inboxItemId: name, actionId: name, sourceMessage: {}, activation: {} });
/** A stand-in Codex home in a scratch folder; `rule` puts one saved rule in it. */
export async function scratchCodexHome(t: { after(cleanup: () => Promise<void>): void }, rule: boolean): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "letagents-codex-adapter-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  if (rule) {
    await mkdir(join(home, "rules"));
    await writeFile(join(home, "rules", "default.rules"), "saved\n");
  }
  return home;
}

/** A Read-only launch as the daemon makes it: the level by name, with the policy the daemon derives for it. */
export const READ_ONLY_LAUNCH = {
  deliveryMode: "daemon_inbox" as const, permissionProfileId: "read_only" as const, configurationRevision: 1,
  launchPolicy: CODEX_READ_ONLY_POLICY,
};

/** A request that gives a conversation or a turn its access. A subscription to a loaded conversation gives none. */
export const givesAccess = (call: RecordedRequest) => call.method === "thread/start" || call.method === "turn/start"
  || (call.method === "thread/resume" && Object.hasOwn(call.params as object, "approvalPolicy"));
export const namesASandbox = (call: RecordedRequest) => Object.hasOwn((call.params ?? {}) as object, "sandbox") || Object.hasOwn((call.params ?? {}) as object, "sandboxPolicy");
/** One room turn that ends as soon as it has started. */
export async function endedTurn(adapter: CodexProviderAdapter, handle: ProviderHandle, client: FakeRpc, name: string): Promise<void> {
  await adapter.runRoomTurn(handle, turnOf(name), {
    checkpointTurnStarted: async (turnId) => { client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId } }); },
  });
}
/** What a launch was asked for besides its folder and its overrides. */
export const launchAskedFor = (harness: ReturnType<typeof createHarness>, launch = 0) => harness.launchOptions[launch]!.options as { sandboxed?: boolean; hideSignInProfile?: string; readOnlySandbox?: boolean };
// The line is true for a Codex that is too old and for one that is newer than LetAgents knows: it cannot tell which, and names every way out.
export const SIGN_IN_NOT_CONFIRMED = new RegExp("^Error: This version of Codex did not confirm that it keeps your Codex sign-in file from this agent's commands, so the agent was not started\\. "
  + "If Codex is not up to date, update it\\. If it is, update LetAgents, or choose another access level: at every other level the agent's commands can read that file\\.$");
/** What a Read-only conversation must not report in place of its profile, while its sandbox and approval policy are as they should be. */
export const NOT_THE_PROFILE_REPLIES: ReadonlyArray<[string, (client: FakeRpc) => void]> = [
  ["no permission profile", (client) => { client.profileFromOwnSettings = null; }],
  ["a profile of the owner's", (client) => { client.profileFromOwnSettings = { id: "owner_profile", extends: ":read-only" }; }],
  ["another work attempt's profile", (client) => { client.profileFromOwnSettings = { id: codexReadOnlyProfileId("another-work-attempt"), extends: ":read-only" }; }],
  ["the profile as an extension of another built-in one", (client) => { client.profileFromOwnSettings = { id: READ_ONLY_PROFILE, extends: ":workspace" }; }],
  ["the profile with no word on what it extends", (client) => { client.profileFromOwnSettings = { id: READ_ONLY_PROFILE, extends: null }; }],
];
