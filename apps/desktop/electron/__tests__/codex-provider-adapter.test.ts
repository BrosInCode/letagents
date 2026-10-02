import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  CodexAppServerExit,
  CodexAppServerLaunch,
} from "../main/agents/codex-app-server.js";
import {
  CodexProviderAdapter,
  codexMcpWorkplaceConfigOverrides,
  type CodexPermissionObservation,
  type CodexAdapterRpc,
  type CodexProviderAdapterDependencies,
} from "../main/agents/codex-provider-adapter.js";
import { CodexRpcClient, type RpcNotification, type RpcServerRequest } from "../main/agents/codex-rpc-client.js";
import { CODEX_OWNER_FEATURE_OVERRIDES } from "../../../../shared/codex-owner-isolation.mjs";
import {
  CODEX_SUPERVISOR_BRIDGE_CONTEXT_FILE,
  writeCodexSupervisorBridgeContext,
} from "../main/agents/codex-supervisor-bridge-context.js";
import type {
  ProviderActivityEvent,
  ProviderConnectionRef,
  ProviderContinuationRef,
  ProviderHandle,
  ProviderSpawnRequest,
  ProviderStreamEvent,
  ProviderTerminalPayload,
} from "../main/agents/provider-adapter.js";
import { ProviderContinuationMissingError, ProviderTurnControlError } from "../main/agents/provider-adapter.js";
import { ProviderExecutionObserver } from "../main/agents/provider-execution-observer.js";
import { LETAGENTS_MCP_RUNTIME_VERSION } from "../main/agents/letagents-mcp-runtime.js";
import type { NativeExecutionObservation, NativeTurnBoundary } from "../../shared/execution-protocol.js";

// Cross-layer assertions load the daemon at test runtime without pulling its
// separately compiled source tree into Electron's production rootDir.
const { providerStreamLifecycle } = await import(new URL("../../daemon/provider-stream-policy.ts", import.meta.url).href);
const { emptyExecutionProjection, reduceExecutionFact } = await import(new URL("../../daemon/execution-reducer.ts", import.meta.url).href);
const { ProviderActionPortRouter } = await import(new URL("../../daemon/provider-action-port-router.ts", import.meta.url).href);
const { HostApprovalBroker } = await import(new URL("../../daemon/host-approval-broker.ts", import.meta.url).href);
const { ManifestStore } = await import(new URL("../../daemon/manifest-store.ts", import.meta.url).href);
const { SupervisedAgentInboxStore } = await import(new URL("../../daemon/supervised-agent-inbox-store.ts", import.meta.url).href);

type RecordedRequest = { method: string; params: unknown };

function roomReadiness(tools = ["claim_task", "get_board", "read_messages", "send_message"]) {
  return { contents: [{ uri: "letagents://runtime/readiness", mimeType: "application/json",
    text: JSON.stringify({ format: 1, profile: "supervised_room_turn", provider: "codex", tools }) }] };
}

function assertProviderHandle(
  value: ProviderHandle | { state: "terminal" } | null,
): asserts value is ProviderHandle {
  assert.ok(value && !("state" in value && value.state === "terminal"), "expected a live provider handle");
}

class FakeRpc implements CodexAdapterRpc {
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
    },
  ) {
    this.reviewerFromOwnSettings = options.reviewerFromOwnSettings;
  }

  /** Set when the app-server ignores the requested reviewer and reports this one. */
  reviewerFromOwnSettings: string | null;

  /** A current app-server applies the reviewer it was asked for; one that ignores the request uses its own. */
  private appliedReviewer(params: unknown): string {
    const requested = (params as { approvalsReviewer?: unknown } | undefined)?.approvalsReviewer;
    return this.reviewerFromOwnSettings ?? (typeof requested === "string" ? requested : "user");
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
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
    if (method === "thread/start") {
      this.threadStartCount += 1;
      return {
        thread: {
          id: this.threadStartCount === 1
            ? this.threadId
            : `${this.threadId}-replacement-${this.threadStartCount - 1}`,
        },
        approvalsReviewer: this.appliedReviewer(params),
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
      return { thread: { id: threadId }, approvalsReviewer: this.appliedReviewer(params) } as T;
    }
    if (method === "turn/start") {
      const threadId = (params as { threadId?: string } | undefined)?.threadId ?? this.threadId;
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

type FakeLaunch = CodexAppServerLaunch & {
  alive: boolean;
  processIdentity: string;
  resolveExit(exit: CodexAppServerExit): void;
};

const custodialRuntimeContract = {
  format: 1,
  profiles: { cursor_supervised_room_turn: { tools: ["claim_task", "get_board", "read_messages", "send_message", "send_thread_message", "set_reply_thread", "complete_room_turn"] }, supervised_mcp_polling: {
    contract: "custodial_polling_v1", tools: ["wait_for_messages", "read_messages", "send_message"],
  } },
};

function createHarness(options: {
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
  /** Set when the app-server ignores the requested reviewer and reports this one. */
  reviewerFromOwnSettings?: string;
  /** The folder new threads report instead of the launch folder; null reports none. */
  threadDirectory?: string | null;
  /** The running process's command line cannot be read, as when `ps` does not answer in time. */
  processUnreadable?: boolean;
  /** The running process's command line carries every isolation override, whatever it was started with. */
  commandLineClaimsIsolation?: boolean;
} = {}) {
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
      return { pid: launch.pid, exited: launch.exited };
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
      });
      clients.push(client);
      return client;
    },
    signalProcess: (pid, signal) => {
      signals.push({ pid, signal });
      if (options.exitOnSignal) {
        const launch = launches.find((entry) => entry.pid === pid && entry.alive);
        launch?.resolveExit({ type: "exit", code: null, signal });
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
    /** The project now adds something the running process was not started with turned off. */
    changeProject: (refusal: string) => { project.changed = refusal; },
    setIdentityObservable: (observable: boolean) => { identityObservable = observable; },
  };
}

function spawnRequest(overrides: Partial<ProviderSpawnRequest> = {}): ProviderSpawnRequest {
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

function requestByMethod(client: FakeRpc, method: string): RecordedRequest {
  const request = client.requests.find((entry) => entry.method === method);
  assert.ok(request, `expected ${method} request`);
  return request;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const approvalParams = (overrides: Record<string, unknown> = {}) => ({
  threadId: "thread-1", turnId: "turn-thread-1", itemId: "item-1", startedAtMs: 1,
  command: "npm test", ...overrides,
});

const genericPermissionParams = (overrides: Record<string, unknown> = {}) => ({
  threadId: "thread-1", turnId: "turn-thread-1", itemId: "item-1", startedAtMs: 1,
  cwd: "/repo", permissions: {
    network: { enabled: true },
    fileSystem: { entries: [{ access: "write", path: { type: "special", value: { kind: "tmpdir" } } }] },
  },
  reason: "Run the local development server", ...overrides,
});

const mcpToolPermissionParams = (overrides: Record<string, unknown> = {}) => ({
  threadId: "thread-1", turnId: "turn-thread-1", serverName: "letagents", mode: "form",
  _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"],
    tool_description: "Read the task board", tool_params: { room_id: "room", open_only: false } },
  message: 'Allow the letagents MCP server to run tool "get_board"?',
  requestedSchema: { type: "object", properties: {} }, ...overrides,
});

test("Codex observes native MCP tool approvals without invented item coordinates and replies only once", async () => {
  for (const reply of ["once", "reject"] as const) {
    const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!; client.turnStatus = "inProgress";
    const request = client.askPermission(mcpToolPermissionParams(), 41, "mcpServer/elicitation/request");
    const controller = new AbortController();
    let observed = false;
    const watching = adapter.observePermissions(handle, event => {
      if (event.type === "snapshot") observed ||= event.requests.includes(request);
    }, controller.signal);
    await flush(); assert.equal(observed, true);
    assert.deepEqual(await adapter.inspectPermissionMcpToolCall(handle, request), request.params);
    assert.deepEqual(await adapter.replyPermission(handle, request, reply, {
      beforeNativeDispatch: async () => {}, assertNativeDispatch: () => {},
    }), { outcome: "sent", scope: "request" });
    assert.deepEqual(client.permissionResponses, [{ request, result: {
      action: reply === "once" ? "accept" : "decline", content: reply === "once" ? {} : null, _meta: null,
    } }]);
    assert.equal(await adapter.inspectPermissionMcpToolCall(handle, request), null);
    await assert.rejects(adapter.replyPermission(handle, request, reply), { outcome: "not_dispatched" });
    controller.abort(); await watching;
  }
});

test("Codex approvals use the latest exact turn despite an orphaned in-progress historical turn", async (t) => {
  for (const [method, params] of [
    ["mcpServer/elicitation/request", mcpToolPermissionParams()],
    ["item/commandExecution/requestApproval", approvalParams()],
    ["item/permissions/requestApproval", genericPermissionParams()],
  ] as const) await t.test(method, async () => {
    const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!; client.turnStatus = "inProgress";
    const original = client.request.bind(client);
    let historyReads = 0;
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method !== "thread/read") return original<T>(method, params);
      historyReads++;
      return { thread: { id: "thread-1", status: { type: "active", activeFlags: ["waitingOnApproval"] }, turns: [
        { id: "retired-turn", status: "inProgress" }, { id: "turn-thread-1", status: "inProgress" },
      ] } } as T;
    };
    assert.deepEqual(await adapter.inspectTurnBoundary(handle), { state: "unknown" }, "discovery remains conservative");
    const request = client.askPermission(params, 0, method);
    let admitted = 0;
    assert.deepEqual(await adapter.replyPermission(handle, request, "once", {
      beforeNativeDispatch: async () => { admitted++; },
    }), { outcome: "sent", scope: "request" });
    assert.equal(admitted, 1); assert.equal(client.permissionResponses.length, 1);
    assert.equal(historyReads, 1,
      "only explicit discovery reads history; approval dispatch uses the latest native turn");
    assert.deepEqual(requestByMethod(client, "thread/turns/list").params, {
      threadId: "thread-1", limit: 1, sortDirection: "desc", itemsView: "full",
    });
    await assert.rejects(adapter.replyPermission(handle, request, "once"), { outcome: "not_dispatched" });
    assert.equal(client.permissionResponses.length, 1);
  });
});

test("Codex approval latest-turn inspection refuses stale or ambiguous snapshots before admission", async (t) => {
  for (const data of [undefined, [], [null], [{ id: "retired-turn", status: "inProgress", itemsView: "full" }],
    [{ id: "turn-thread-1", status: "completed", itemsView: "full" }],
    [{ id: "turn-thread-1", status: "inProgress" }],
    [{ id: "turn-thread-1", status: "inProgress", itemsView: "full" }, { id: "other", status: "inProgress", itemsView: "full" }],
  ]) await t.test(JSON.stringify(data) ?? "missing data", async () => {
    const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    const original = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown): Promise<T> => method === "thread/turns/list"
      ? { data } as T : original<T>(method, params);
    const request = client.askPermission(mcpToolPermissionParams(), 0, "mcpServer/elicitation/request");
    await assert.rejects(adapter.replyPermission(handle, request, "once", {
      beforeNativeDispatch: async () => { assert.fail("invalid snapshot cannot admit dispatch"); },
    }), { outcome: "not_dispatched" });
    assert.deepEqual(client.permissionResponses, []);
  });
});

test("Codex MCP approvals refuse uncorrelated, unsupported, cancelled, replaced, or changed requests", async (t) => {
  const cases = [
    { name: "foreign thread", params: { threadId: "foreign" } },
    { name: "foreign turn", params: { turnId: "foreign" } },
    { name: "uncorrelated elicitation", params: { turnId: null } },
    { name: "URL interaction", params: { mode: "url" } },
    { name: "generic form", params: { _meta: {} } },
    { name: "data-entry form", params: { requestedSchema: { type: "object", properties: { password: { type: "string" } } } } },
    { name: "oversized proposal", params: { message: "x".repeat(25 * 1024) } },
    ...["cancelled", "replacement", "disconnect", "turn completed", "arguments changed"].map(name => ({ name, params: {} })),
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!; client.turnStatus = "inProgress";
    const request = client.askPermission(mcpToolPermissionParams(entry.params), 41, "mcpServer/elicitation/request");
    await assert.rejects(adapter.replyPermission(handle, request, "once", {
      beforeNativeDispatch: async () => {
        if (entry.name === "cancelled") client.emit({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 41 } });
        if (entry.name === "replacement") client.askPermission(mcpToolPermissionParams(), 41, request.method);
        if (entry.name === "disconnect") client.disconnect();
        if (entry.name === "turn completed") client.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-thread-1", status: "completed" } } });
        if (entry.name === "arguments changed") ((request.params as ReturnType<typeof mcpToolPermissionParams>)._meta.tool_params).room_id = "other-room";
      },
      assertNativeDispatch: () => assert.fail("invalid request must not pass the dispatch fence"),
    }), { outcome: "not_dispatched" });
    assert.deepEqual(client.permissionResponses, []);
  });
});

test("Codex file approval inspection requires exact full pending native edits", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!; client.turnStatus = "inProgress";
  const request = client.askPermission(approvalParams(), 3, "item/fileChange/requestApproval");
  const changes = [
    { path: "/repo/empty", kind: { type: "add" }, diff: "" },
    { path: "/repo/deleted", kind: { type: "delete" }, diff: "-old" },
    { path: "/repo/update", kind: { type: "update", move_path: null }, diff: "-old\n+new" },
    { path: "/repo/renamed", kind: { type: "update", move_path: "/repo/new" }, diff: "" },
  ];
  const valid = { data: [{ id: "turn-thread-1", status: "inProgress", itemsView: "full",
    items: [{ id: "item-1", type: "fileChange", status: "inProgress", changes }] }] };
  let response: unknown = valid;
  const original = client.request.bind(client);
  client.request = async (method, params) => {
    if (method !== "thread/turns/list") return original(method, params);
    assert.deepEqual(params, { threadId: "thread-1", limit: 1, sortDirection: "desc", itemsView: "full" });
    return response as never;
  };
  assert.deepEqual(await adapter.inspectPermissionFileChanges(handle, request), changes);
  for (const invalid of [null, { data: [] }, { data: [...valid.data, ...valid.data] },
    ...[{ id: "foreign" }, { status: "completed" }, { itemsView: "none" }, { items: [] },
      { items: [...valid.data[0]!.items, ...valid.data[0]!.items] },
      ...[{ status: "completed" }, { type: "commandExecution" }, { changes: [] },
        { changes: [{ ...changes[0], kind: { type: "unknown" } }] },
        { changes: [{ ...changes[0], path: "" }] },
        { changes: [{ ...changes[0], diff: "x".repeat(25 * 1024) }] }]
        .map(item => ({ items: [{ ...valid.data[0]!.items[0], ...item }] }))]
      .map(turn => ({ data: [{ ...valid.data[0], ...turn }] }))]) {
    response = invalid;
    assert.equal(await adapter.inspectPermissionFileChanges(handle, request), null);
  }
  response = valid;
  assert.equal(await adapter.inspectPermissionFileChanges(handle, { ...request }), null);
  client.pendingPermissions.delete(request.id);
  assert.equal(await adapter.inspectPermissionFileChanges(handle, request), null);
  assert.equal(client.permissionResponses.length, 0);
});

test("Codex file approval inspection uses the exact ephemeral proposal when the active turn omits its pending item", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  client.turnStatus = "inProgress";
  const request = client.askPermission(approvalParams(), 3, "item/fileChange/requestApproval");
  const changes = structuredClone(client.permissionChanges);
  const original = client.request.bind(client);
  client.request = async (method, params) => method === "thread/turns/list"
    ? { data: [{ id: "turn-thread-1", status: "inProgress", itemsView: "full", items: [] }] } as never
    : original(method, params);

  assert.equal(await adapter.inspectPermissionFileChanges(handle, request), null);
  client.emit({ method: "item/started", params: {
    threadId: "thread-1",
    turnId: "turn-thread-1",
    item: { id: "item-1", type: "fileChange", status: "inProgress", changes },
  } });
  assert.deepEqual(await adapter.inspectPermissionFileChanges(handle, request), changes);
  assert.deepEqual(await adapter.replyPermission(handle, request, "once", {
    expectedFileChanges: changes,
    beforeNativeDispatch: async () => {},
  }), { outcome: "sent", scope: "request" });
  assert.deepEqual(client.permissionResponses, [{ request, result: { decision: "accept" } }]);
});

test("Codex ephemeral file approval proposals expire on item, turn, or connection terminal evidence", async (t) => {
  for (const terminal of ["item", "turn", "connection"] as const) await t.test(terminal, async () => {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    client.turnStatus = "inProgress";
    const request = client.askPermission(approvalParams(), 3, "item/fileChange/requestApproval");
    const changes = structuredClone(client.permissionChanges);
    const original = client.request.bind(client);
    client.request = async (method, params) => method === "thread/turns/list"
      ? { data: [{ id: "turn-thread-1", status: "inProgress", itemsView: "full", items: [] }] } as never
      : original(method, params);
    client.emit({ method: "item/started", params: {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      item: { id: "item-1", type: "fileChange", status: "inProgress", changes },
    } });
    assert.deepEqual(await adapter.inspectPermissionFileChanges(handle, request), changes);

    if (terminal === "item") client.emit({ method: "item/completed", params: {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      item: { id: "item-1", type: "fileChange", status: "declined" },
    } });
    if (terminal === "turn") client.emit({ method: "turn/completed", params: {
      threadId: "thread-1",
      turn: { id: "turn-thread-1", status: "completed" },
    } });
    if (terminal === "connection") client.disconnect();

    assert.equal(await adapter.inspectPermissionFileChanges(handle, request), null);
    assert.deepEqual(client.permissionResponses, []);
  });
});

test("Codex file approval rechecks proposed edits after the broker hook and never sends changed edits", async () => {
  for (const changed of [false, true]) {
    const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!; client.turnStatus = "inProgress";
    const request = client.askPermission(approvalParams(), 1, "item/fileChange/requestApproval");
    const expected = structuredClone(client.permissionChanges);
    const original = client.request.bind(client);
    client.request = async (method, params) => {
      assert.notEqual(method, "thread/read", "live pending edits cannot require materialized historical items");
      return original(method, params) as never;
    };
    let fences = 0;
    const operation = adapter.replyPermission(handle, request, "once", {
      expectedFileChanges: expected,
      beforeNativeDispatch: async () => { if (changed) client.permissionChanges[0]!.diff = "+changed"; expected[0]!.diff = "+caller-mutated"; },
      assertNativeDispatch: () => { fences++; },
    });
    if (changed) await assert.rejects(operation, { outcome: "not_dispatched" });
    else assert.deepEqual(await operation, { outcome: "sent", scope: "request" });
    assert.equal(fences, changed ? 0 : 1);
    assert.equal(client.permissionResponses.length, changed ? 0 : 1);
  }
});

test("Codex file approval refuses authority loss or unsupported inspection across native reads", async () => {
  for (const race of ["birth", "connection", "resolved", "replacement", "unsupported"]) {
    const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!; client.turnStatus = "inProgress";
    const request = client.askPermission(approvalParams(), 1, "item/fileChange/requestApproval");
    const original = client.request.bind(client);
    client.request = async (method, params) => {
      const result = await original(method, params);
      if (method === "thread/turns/list") {
        if (race === "birth") harness.setIdentityObservable(false);
        if (race === "connection") client.disconnect();
        if (race === "resolved") client.pendingPermissions.delete(request.id);
        if (race === "replacement") client.askPermission(approvalParams(), request.id, request.method);
        if (race === "unsupported") throw new Error("method not found");
      }
      return result as never;
    };
    assert.equal(await adapter.inspectPermissionFileChanges(handle, request), null, race);
    assert.equal(client.permissionResponses.length, 0);
  }
});

test("Codex permission dispatch rechecks native authority after the durable broker hook", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!; client.turnStatus = "inProgress";
  const request = client.askPermission(approvalParams());
  let syncChecks = 0;
  await assert.rejects(adapter.replyPermission(handle, request, "once", {
    beforeNativeDispatch: async () => { harness.setIdentityObservable(false); },
    assertNativeDispatch: () => { syncChecks++; },
  }), { outcome: "not_dispatched" });
  assert.equal(syncChecks, 0); assert.equal(client.permissionResponses.length, 0);
  harness.setIdentityObservable(true);
  await assert.rejects(adapter.replyPermission(handle, request, "once", {
    beforeNativeDispatch: async () => {}, assertNativeDispatch: () => { throw new Error("broker closed"); },
  }), /broker closed/);
  assert.equal(client.permissionResponses.length, 0);
  await adapter.replyPermission(handle, request, "once", {
    beforeNativeDispatch: async () => {}, assertNativeDispatch: () => { syncChecks++; },
  });
  assert.equal(syncChecks, 1); assert.equal(client.permissionResponses.length, 1);
});

test("Codex permission replies target exact pending requests and report sent, never applied", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  client.turnStatus = "inProgress";
  const facts: NativeExecutionObservation[] = [];
  const subscription = adapter.onExecution(handle, event => facts.push(event));
  assert.equal(facts[0]?.fact.domain, "runtime");
  facts.length = 0;
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
    // Same native item, distinct typed RPC IDs: neither callback can authorize the other.
    const once = client.askPermission(approvalParams({ approvalId: "callback-1", availableDecisions: ["accept", "decline"] }), 1, method);
    const reject = client.askPermission(approvalParams({ approvalId: "callback-2", grantRoot: "/host/private" }), "1", method);
    const options = method.includes("fileChange") ? { beforeNativeDispatch: async () => {}, expectedFileChanges: client.permissionChanges } : undefined;
    assert.deepEqual(await adapter.replyPermission(handle, once, "once", options), { outcome: "sent", scope: "request" });
    assert.equal(client.listPendingRequests()[0], reject);
    assert.deepEqual(await adapter.replyPermission(handle, reject, "reject", options), { outcome: "sent", scope: "request" });
    assert.deepEqual(client.permissionResponses.slice(-2), [
      { request: once, result: { decision: "accept" } }, { request: reject, result: { decision: "decline" } },
    ]);
    await assert.rejects(adapter.replyPermission(handle, once, "once"), { outcome: "not_dispatched" });
  }
  assert.equal(client.permissionResponses.length, 4);
  assert.equal(client.requests.filter(request => request.method === "thread/read").length, 0, "approval dispatch never scans historical turns");
  assert.deepEqual(facts, [], "approval payloads and decisions never enter execution evidence");
  assert.deepEqual(harness.signals, []);
  assert.equal(client.requests.some(request => request.method === "turn/start"), false);
  subscription.dispose();
});

test("Codex generic permission replies grant only the exact requested profile for the current turn", async () => {
  for (const reply of ["once", "reject"] as const) {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!; client.turnStatus = "inProgress";
    const request = client.askPermission(genericPermissionParams(), 41, "item/permissions/requestApproval");
    assert.deepEqual(await adapter.replyPermission(handle, request, reply, {
      beforeNativeDispatch: async () => {}, assertNativeDispatch: () => {},
    }), { outcome: "sent", scope: "request" });
    const requested = (request.params as { permissions: Record<string, unknown> }).permissions;
    assert.deepEqual(client.permissionResponses, [{ request, result: reply === "once"
      ? { permissions: requested, scope: "turn", strictAutoReview: true }
      : { permissions: {}, scope: "turn" } }]);
    assert.equal(JSON.stringify(client.permissionResponses).includes('"session"'), false);
  }
});

test("Codex generic permission dispatch refuses a changed or malformed requested profile", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!; client.turnStatus = "inProgress";
  const request = client.askPermission(genericPermissionParams(), 41, "item/permissions/requestApproval");
  await assert.rejects(adapter.replyPermission(handle, request, "once", {
    beforeNativeDispatch: async () => {
      ((request.params as { permissions: { network: { enabled: boolean } } }).permissions.network).enabled = false;
    },
    assertNativeDispatch: () => assert.fail("a changed request cannot cross the native dispatch fence"),
  }), { outcome: "not_dispatched" });
  assert.deepEqual(client.permissionResponses, []);

  for (const params of [
    genericPermissionParams({ cwd: "relative/path" }),
    genericPermissionParams({ permissions: { network: { enabled: true, unexpected: true } } }),
    genericPermissionParams({ permissions: { fileSystem: { entries: [{ access: "execute", path: { type: "special", value: { kind: "tmpdir" } } }] } } }),
    genericPermissionParams({ permissions: { network: { enabled: true }, extra: true } }),
  ]) {
    const candidate = client.askPermission(params, 42, "item/permissions/requestApproval");
    await assert.rejects(adapter.replyPermission(handle, candidate, "once"), { outcome: "not_dispatched" });
    client.pendingPermissions.delete(candidate.id);
  }
  assert.deepEqual(client.permissionResponses, []);
});

test("Codex rejects unsupported, stale, malformed, or broader-than-once approval decisions before dispatch", async (t) => {
  const cases: Array<{ name: string; params?: Record<string, unknown>; method?: string; reply?: "once" | "reject"; clone?: boolean }> = [
    { name: "foreign thread", params: { threadId: "foreign" } },
    { name: "foreign turn", params: { turnId: "foreign" } },
    { name: "missing item", params: { itemId: undefined } },
    { name: "invalid start time", params: { startedAtMs: "1" } },
    { name: "generic permission missing profile", method: "item/permissions/requestApproval" },
    { name: "file grantRoot cannot mean once", method: "item/fileChange/requestApproval", params: { grantRoot: "/repo" } },
    { name: "session-only choices", params: { availableDecisions: ["acceptForSession", "cancel"] } },
    { name: "amendment-only choices", params: { availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm"] } }] } },
    { name: "decline unavailable", params: { availableDecisions: ["accept"] }, reply: "reject" },
    { name: "malformed choices", params: { availableDecisions: "accept" } },
    { name: "empty choices", params: { availableDecisions: [] } },
    { name: "copied request", clone: true },
    { name: "unknown reply", reply: "acceptForSession" as "once" },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    client.turnStatus = "inProgress";
    const request = client.askPermission(approvalParams(entry.params), 1, entry.method);
    await assert.rejects(adapter.replyPermission(handle, entry.clone ? { ...request } : request, entry.reply ?? "once"), {
      name: "CodexPermissionReplyError", outcome: "not_dispatched",
    });
    assert.deepEqual(client.permissionResponses, []);
    assert.equal(client.listPendingRequests()[0], request, "refusal does not consume native pending authority");
    assert.deepEqual(harness.signals, []);
  });
});

test("Codex permission dispatch refuses non-active or inconclusive native turn snapshots", async (t) => {
  for (const status of ["completed", "failed", "interrupted", "unknown", "read-error"]) await t.test(status, async () => {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    client.turnStatus = status;
    if (status === "read-error") client.request = async () => { throw new Error("timed out"); };
    const request = client.askPermission(approvalParams());
    await assert.rejects(adapter.replyPermission(handle, request, "once"), { outcome: "not_dispatched" });
    assert.deepEqual(client.permissionResponses, []);
    assert.equal(handle.observedState(), "idle", "read uncertainty is not runtime failure");
  });
});

test("Codex permission responses do not replay after an uncertain send or changed post-send identity", async (t) => {
  for (const failure of ["send_throw", "process_birth", "unverifiable", "disconnect"]) await t.test(failure, async () => {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    client.turnStatus = "inProgress";
    const request = client.askPermission(approvalParams());
    const respond = client.respond.bind(client);
    client.respond = (expected, result) => {
      if (failure === "send_throw") client.responseError = true;
      respond(expected, result);
      if (failure === "process_birth") harness.launches[0]!.processIdentity += "-replaced";
      if (failure === "unverifiable") harness.setIdentityObservable(false);
      if (failure === "disconnect") client.disconnect();
    };
    await assert.rejects(adapter.replyPermission(handle, request, "once"), { outcome: "uncertain" });
    assert.equal(client.permissionResponses.length, 1);
    await assert.rejects(adapter.replyPermission(handle, request, "once"), { outcome: "not_dispatched" });
    assert.equal(client.permissionResponses.length, 1);
    assert.deepEqual(harness.signals, failure === "disconnect" ? [{ pid: handle.pid, signal: "SIGTERM" }] : [],
      "only the existing observeFencedExit disconnect policy may signal the process");
  });
});

test("Codex empty permission observations permit exact idle reservation through the router and broker", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-idle-permissions-"));
  const store = new ManifestStore(join(root, "state.sqlite"));
  const inbox = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  const handle = await router.spawn({ provider: "codex", ...spawnRequest({ deliveryMode: "daemon_inbox" }) });
  const broker = new HostApprovalBroker({ store, inbox, provider: router,
    currentHandle: () => handle, isCurrent: () => true, exactAuthority: async () => true,
    fenceCommit: async (commit: () => Promise<void>) => commit() });
  const exact = { entryId: "agent", handle, executionGenerationId: "generation", providerConnection: handle.providerConnection };
  const client = harness.clients[0]!;
  try {
    broker.install("agent", handle, "generation");
    await flush();
    const empty = broker.reserveIdle(exact);
    assert.ok(empty, "an observed empty native approval lane retains its verified RPC identity");
    empty.assertCurrent();
    const pending = client.askPermission(approvalParams());
    await flush();
    assert.throws(empty.assertCurrent, /permissions changed/);
    empty.release();
    assert.equal(broker.reserveIdle(exact), null, "a pending native request blocks refresh");
    client.emit({ method: "serverRequest/resolved", params: { requestId: pending.id, threadId: "thread-1" } });
    await flush();
    const resolved = broker.reserveIdle(exact);
    assert.ok(resolved, "the same connection remains identifiable after its last request closes");
    resolved.assertCurrent();
    harness.setIdentityObservable(false);
    client.askPermission(approvalParams(), "unverifiable-birth");
    await flush();
    assert.throws(resolved.assertCurrent, /permissions changed/);
    resolved.release();
    assert.equal(broker.reserveIdle(exact), null, "unverifiable process identity never establishes idle authority");
    harness.setIdentityObservable(true);
    client.emit({ method: "serverRequest/resolved", params: { requestId: "unverifiable-birth", threadId: "thread-1" } });
    await flush();
    const beforeDisconnect = broker.reserveIdle(exact);
    assert.ok(beforeDisconnect);
    client.disconnect();
    await flush();
    assert.throws(beforeDisconnect.assertCurrent, /permissions changed/);
    beforeDisconnect.release();
    assert.equal(broker.reserveIdle(exact), null, "disconnect cannot retain healthy empty authority");
  } finally {
    broker.close();
    await inbox.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex permission observation tracks pending requests without projecting resolution as an applied decision", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  client.turnStatus = "inProgress";
  const initial = client.askPermission(approvalParams());
  client.askPermission(approvalParams({ threadId: "foreign" }), "foreign");
  const controller = new AbortController();
  const events: CodexPermissionObservation[] = [];
  const observation = adapter.observePermissions(handle, event => { events.push(event); }, controller.signal);
  const throwing = adapter.observePermissions(handle, () => { throw new Error("consumer failed"); }, controller.signal);
  assert.deepEqual(events[0], { type: "snapshot", connectionId: client.currentConnectionId(), requests: [initial] });
  const second = client.askPermission(approvalParams({ itemId: "item-2" }), "second");
  await flush();
  assert.deepEqual(events.at(-1), { type: "snapshot", connectionId: client.currentConnectionId(), requests: [initial, second] });
  client.emit({ method: "serverRequest/resolved", params: { requestId: initial.id, threadId: "thread-1" } });
  await flush();
  assert.deepEqual(events.at(-1), { type: "snapshot", connectionId: client.currentConnectionId(), requests: [second] });
  assert.deepEqual(client.permissionResponses, [], "remote resolution is not evidence of our decision or dispatch");
  await adapter.replyPermission(handle, second, "reject");
  await flush();
  assert.deepEqual(events.at(-1), { type: "snapshot", connectionId: client.currentConnectionId(), requests: [] });
  harness.setIdentityObservable(false);
  client.askPermission(approvalParams(), "degraded");
  await flush();
  assert.deepEqual(events.at(-1), { type: "degraded" });
  harness.setIdentityObservable(true);
  client.disconnect();
  await Promise.all([observation, throwing]);
  assert.deepEqual(events.at(-1), { type: "unavailable" });
  assert.equal(client.permissionListeners.size, 0);
  const count = events.length;
  controller.abort();
  client.askPermission(approvalParams(), "after-close");
  await flush();
  assert.equal(events.length, count);
});

test("Codex permission dispatch revalidates exact authority after an awaited native read", async (t) => {
  for (const race of ["resolved", "request_replaced", "process_birth", "unverifiable", "connection", "continuation", "handle", "stopping", "turn_terminal"]) {
    await t.test(race, async () => {
      const harness = createHarness({ exitOnSignal: true });
      const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
      const spawn = spawnRequest({ deliveryMode: "daemon_inbox" });
      const handle = await adapter.spawn(spawn);
      const client = harness.clients[0]!;
      const permission = client.askPermission(approvalParams());
      let release!: () => void;
      let reading!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { reading = resolve; });
      const originalRequest = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        if (method !== "thread/turns/list") return originalRequest<T>(method, params);
        reading();
        await barrier;
        return { data: [{ id: "turn-thread-1", status: "inProgress", itemsView: "full" }] } as T;
      };
      const response = adapter.replyPermission(handle, permission, "once", {
        beforeNativeDispatch: async () => { assert.fail("lost authority cannot admit dispatch"); },
      });
      const rejected = assert.rejects(response, { outcome: "not_dispatched" });
      await started;
      if (race === "resolved") client.emit({ method: "serverRequest/resolved", params: { requestId: permission.id, threadId: "thread-1" } });
      if (race === "request_replaced") client.askPermission(approvalParams({ command: "different command" }));
      if (race === "process_birth") harness.launches[0]!.processIdentity += "-replaced";
      if (race === "unverifiable") harness.setIdentityObservable(false);
      if (race === "connection") client.connectionEpoch = "replacement";
      if (race === "continuation") await adapter.repairContinuation(handle, {
        workAttemptId: handle.workAttemptId, expectedProviderContinuationId: "thread-1",
        checkpointedReplacementProviderContinuationId: "thread-repaired", cwd: spawn.cwd, launchPolicy: spawn.launchPolicy,
      }, { checkpointReplacement: async () => {} });
      if (race === "handle") {
        harness.launches[0]!.resolveExit({ type: "exit", code: 0, signal: null });
        await flush();
        await adapter.spawn(spawn);
      }
      if (race === "stopping") await adapter.stop(handle, { force: true });
      if (race === "turn_terminal") client.emit({ method: "turn/completed", params: {
        threadId: "thread-1", turn: { id: "turn-thread-1", status: "completed" },
      } });
      release();
      await rejected;
      assert.deepEqual(client.permissionResponses, []);
    });
  }
});

test("Codex concurrent permission replies send only once for one frozen pending request", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  client.turnStatus = "inProgress";
  const request = client.askPermission(approvalParams());
  const outcomes = await Promise.allSettled([
    adapter.replyPermission(handle, request, "once"), adapter.replyPermission(handle, request, "reject"),
  ]);
  assert.equal(outcomes[0]!.status, "fulfilled");
  assert.equal(outcomes[1]!.status, "rejected");
  assert.equal((outcomes[1] as PromiseRejectedResult).reason.outcome, "not_dispatched");
  assert.equal(client.permissionResponses.length, 1);
});

test("Codex permission observation withdraws replaced/stopped bindings and disposes on abort", async (t) => {
  for (const end of ["abort", "continuation", "connection", "stop", "already_aborted"]) await t.test(end, async () => {
    const harness = createHarness({ exitOnSignal: true });
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const spawn = spawnRequest({ deliveryMode: "daemon_inbox" });
    const handle = await adapter.spawn(spawn);
    const client = harness.clients[0]!;
    client.askPermission(approvalParams());
    const controller = new AbortController();
    if (end === "already_aborted") controller.abort();
    const events: CodexPermissionObservation[] = [];
    const observation = adapter.observePermissions(handle, event => events.push(event), controller.signal);
    if (end === "abort") controller.abort();
    if (end === "continuation") await adapter.repairContinuation(handle, {
      workAttemptId: handle.workAttemptId, expectedProviderContinuationId: "thread-1",
      checkpointedReplacementProviderContinuationId: "thread-repaired", cwd: spawn.cwd, launchPolicy: spawn.launchPolicy,
    }, { checkpointReplacement: async () => {} });
    if (end === "connection") {
      client.connectionEpoch = "replacement";
      client.askPermission(approvalParams(), "replacement-connection");
    }
    if (end === "stop") await adapter.stop(handle, { force: true });
    await observation;
    assert.equal(events.at(-1)?.type, end === "already_aborted" ? undefined : end === "abort" ? "snapshot" : "unavailable");
    assert.equal(client.permissionListeners.size, 0);
    const count = events.length;
    client.askPermission(approvalParams(), "later");
    await flush();
    assert.equal(events.length, count);
  });
});

test("Codex adapter launches app-server, maps attested thread policy, and boots the MCP workplace", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({
    codexBin: "/usr/local/bin/codex",
    dependencies: harness.dependencies,
  });
  assert.equal(adapter.capabilities().resume, true, "P0-backed resume is available to a fresh reconciler");
  const policy = {
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  };

  const handle = await adapter.spawn(spawnRequest({ launchPolicy: policy }));

  assert.equal(handle.observedState(), "working");
  assert.equal(handle.providerContinuationId, "thread-1");
  assert.deepEqual(handle.providerConnection, {
    kind: "codex_app_server",
    url: "ws://127.0.0.1:4700",
    pid: 4100,
    processIdentity: "fake-process-4100-birth-1",
  });
  assert.equal(harness.launchOptions[0]?.codexBin, "/usr/local/bin/codex");
  assert.deepEqual(harness.launchOptions[0]?.options, {
    trustedProjectPath: "/tmp/letagents-work-attempt",
    configOverrides: codexMcpWorkplaceConfigOverrides("/tmp/letagents-work-attempt"),
  });
  assert.equal(
    harness.launchOptions[0]?.options.configOverrides.some((value) => /token|authorization|env/i.test(value)),
    false,
    "adapter must not inject a bearer or reinterpret provider auth",
  );

  const threadStart = requestByMethod(harness.clients[0]!, "thread/start");
  const threadParams = threadStart.params as Record<string, unknown>;
  assert.equal(threadParams.approvalPolicy, policy.approvalPolicy);
  assert.equal(threadParams.sandbox, "danger-full-access");
  assert.equal(Object.hasOwn(threadParams, "sandboxPolicy"), false);
  assert.equal(Object.hasOwn(threadParams, "cwd"), false, "a thread started in a named folder makes Codex trust the project");
  assert.equal(
    harness.clients[0]!.requests.some((entry) => entry.method === "thread/resume"),
    false,
    "a fresh start must never probe resume with a synthetic continuation",
  );

  const turnStart = requestByMethod(harness.clients[0]!, "turn/start");
  const prompt = ((turnStart.params as { input: Array<{ text: string }> }).input[0]?.text) ?? "";
  assert.match(prompt, /join_room/);
  assert.match(prompt, /focus_37/);
  assert.match(prompt, /register_agent_session/);
  assert.match(prompt, /cwd="\/tmp\/letagents-work-attempt"/, "registration binds from the exact daemon-owned worktree rather than the MCP process cwd");
  assert.match(prompt, /wait_for_messages/);
  assert.match(prompt, /LanternSparrow/);
  assert.equal(await adapter.attach({
    workAttemptId: spawnRequest().workAttemptId,
    providerContinuationId: "thread-1",
    providerConnection: handle.providerConnection,
  }), handle);

  assert.deepEqual(adapter.capabilities(), {
    execution: { controlProbe: "rpc", approvals: { kinds: ["command", "file_change", "network"], recovery: "connection_only", denyScope: "request" } },
    deliveryModes: ["mcp_polling", "daemon_inbox"],
    resume: true,
    midTurnInjection: false,
    midTurnCorrection: true,
    transcriptAccess: true,
    permissionPromptBridging: false,
    survivesRestart: true,
    turnControl: "native_interrupt",
    continuationRepair: "same_process",
  });
  await assert.rejects(adapter.poke(handle, "wake up"), /not enabled/);
});

test("Codex Auto keeps project-only writes and its own reviewer on every thread and turn", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const launchPolicy = {
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
    approvalsReviewer: "auto_review",
  };
  const first = await adapter.spawn(spawnRequest({
    deliveryMode: "daemon_inbox", permissionProfileId: "auto_review", configurationRevision: 1, launchPolicy,
  }));
  const thread = requestByMethod(harness.clients[0]!, "thread/start").params as Record<string, unknown>;
  assert.equal(thread.approvalPolicy, "on-request");
  assert.equal(thread.sandbox, "workspace-write");
  assert.equal(thread.approvalsReviewer, "auto_review");
  assert.equal(Object.hasOwn(thread, "sandboxPolicy"), false);

  const attachedAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await attachedAdapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection, launchPolicy });
  assertProviderHandle(attached);
  // A later caller mutation cannot return approvals to nobody or widen the sandbox.
  launchPolicy.sandboxPolicy.type = "dangerFullAccess";
  launchPolicy.approvalsReviewer = "user";
  for (const [runtime, handle, client] of [[adapter, first, harness.clients[0]!], [attachedAdapter, attached, harness.clients[1]!]] as const) {
    await runtime.runRoomTurn(handle, { inboxItemId: "auto-turn", actionId: "auto-turn", sourceMessage: {}, activation: {} }, {
      checkpointTurnStarted: async (turnId) => {
        client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId } });
      },
    });
    const turn = requestByMethod(client, "turn/start").params as Record<string, unknown>;
    assert.equal(turn.approvalPolicy, "on-request");
    assert.deepEqual(turn.sandboxPolicy, { type: "workspaceWrite", networkAccess: false });
    assert.equal(turn.approvalsReviewer, "auto_review");
  }
});

test("Codex Auto refuses a runtime or policy that would not review automatically", async () => {
  const autoPolicy = { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" };
  const ignoring = createHarness({ reviewerFromOwnSettings: "user" });
  await assert.rejects(new CodexProviderAdapter({ dependencies: ignoring.dependencies }).spawn(spawnRequest({
    deliveryMode: "daemon_inbox", permissionProfileId: "auto_review", configurationRevision: 1, launchPolicy: autoPolicy,
  })), /did not turn on automatic review/);
  assert.equal(ignoring.clients[0]!.requests.some(request => request.method === "turn/start"), false);

  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  for (const [permissionProfileId, launchPolicy, reason] of [
    // Project-only writes never run with the host as the reviewer of record.
    ["auto_review", { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false } }, /approvalsReviewer/],
    ["auto_review", { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: true }, approvalsReviewer: "auto_review" }, /sandboxPolicy/],
    ["auto_review", { approvalPolicy: "never", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" }, /approvalPolicy/],
    ["ask_before_write", { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalsReviewer: "auto_review" }, /approvalsReviewer/],
    ["full_access", { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "guardian_subagent" }, /approvalsReviewer/],
    // A launch that names no access level is still held to the same pairing.
    [null, { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "auto_review" }, /automatic review outside the Auto access level/],
    [null, { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalsReviewer: "auto_review" }, /automatic review outside the Auto access level/],
    [null, { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "guardian_subagent" }, /unsupported approval reviewer/],
  ] as const) {
    await assert.rejects(adapter.spawn(spawnRequest({
      deliveryMode: "daemon_inbox", permissionProfileId, configurationRevision: 1, launchPolicy,
    })), reason);
  }
  assert.equal(harness.clients.some(client => client.requests.some(request => request.method === "thread/start")), false);
});

test("Codex asks the host, not its own reviewer, on every access level except Auto", async () => {
  for (const [permissionProfileId, launchPolicy] of [
    ["ask_before_write", { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } }],
    ["full_access", { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }],
  ] as const) {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", permissionProfileId, configurationRevision: 1, launchPolicy }));
    // The launch names the host even though the stored policy names nobody.
    assert.equal((requestByMethod(harness.clients[0]!, "thread/start").params as Record<string, unknown>).approvalsReviewer, "user");
    await adapter.runRoomTurn(handle, { inboxItemId: "pinned", actionId: "pinned", sourceMessage: {}, activation: {} }, {
      checkpointTurnStarted: async (turnId) => {
        harness.clients[0]!.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId } });
      },
    });
    assert.equal((requestByMethod(harness.clients[0]!, "turn/start").params as Record<string, unknown>).approvalsReviewer, "user");

    // The owner's own Codex settings name a reviewer and the app-server keeps it.
    const owned = createHarness({ reviewerFromOwnSettings: "auto_review" });
    await assert.rejects(new CodexProviderAdapter({ dependencies: owned.dependencies }).spawn(spawnRequest({
      deliveryMode: "daemon_inbox", permissionProfileId, configurationRevision: 1, launchPolicy,
    })), /would review approvals itself instead of asking you/);
    assert.equal(owned.clients[0]!.requests.some(request => request.method === "turn/start"), false);
  }
});

test("Codex continuation repair keeps the access level the runtime was launched under", async () => {
  const autoPolicy = { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" };
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", permissionProfileId: "auto_review", configurationRevision: 1, launchPolicy: autoPolicy }));
  const client = harness.clients[0]!;
  const before = client.requests.length;
  // An agent created in Add Agent stores an empty policy until its settings are edited.
  const result = await adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
    forceReplacement: true, cwd: spawnRequest().cwd, launchPolicy: {}, model: null, reasoningEffort: null,
  }, { checkpointReplacement: async () => {} });
  assert.equal(result.outcome, "replaced");
  const replacement = client.requests.slice(before).find(request => request.method === "thread/start")!.params as Record<string, unknown>;
  assert.equal(replacement.approvalPolicy, "on-request");
  assert.equal(replacement.sandbox, "workspace-write");
  assert.equal(replacement.approvalsReviewer, "auto_review");
});

test("Codex continuation repair refuses a thread that would not review the way the runtime was launched", async () => {
  for (const [permissionProfileId, launchPolicy, reported, reason] of [
    ["auto_review", { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" },
      "user", /did not turn on automatic review/],
    ["ask_before_write", { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } },
      "auto_review", /would review approvals itself instead of asking you/],
  ] as const) {
    for (const forceReplacement of [true, false]) {
      const harness = createHarness();
      const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
      const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", permissionProfileId, configurationRevision: 1, launchPolicy }));
      // The app-server honoured the launch, then stops honouring the reviewer.
      harness.clients[0]!.reviewerFromOwnSettings = reported;
      let checkpointed = false;
      await assert.rejects(adapter.repairContinuation!(handle, {
        workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
        forceReplacement, cwd: spawnRequest().cwd, launchPolicy: {}, model: null, reasoningEffort: null,
      }, { checkpointReplacement: async () => { checkpointed = true; } }), reason);
      assert.equal(checkpointed, false, "a refused thread never becomes the agent's conversation");
    }
  }
});

test("a new Codex thread names no folder, and one that starts outside the work attempt's folder is refused", async () => {
  // Codex records a project as trusted, and loads its .codex config, when a
  // thread starts in a named folder with a writable sandbox.
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  assert.equal(harness.launchOptions[0]?.options.trustedProjectPath, spawnRequest().cwd, "the app-server starts in the folder");
  assert.equal(Object.hasOwn(requestByMethod(client, "thread/start").params as object, "cwd"), false);

  const repair = (cwd: string, checkpointReplacement: () => Promise<void> = async () => {}) => adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
    forceReplacement: true, cwd, launchPolicy: spawnRequest().launchPolicy, model: null, reasoningEffort: null,
  }, { checkpointReplacement });
  let checkpointed = false;
  const conversation = handle.providerContinuationId;
  // The live app-server runs in the folder it was launched in, not this one.
  await assert.rejects(repair("/tmp/letagents-another-attempt", async () => { checkpointed = true; }),
    /^Error: Codex opened this conversation in \/tmp\/letagents-work-attempt, not in the agent's folder \/tmp\/letagents-another-attempt, so LetAgents will not use it\. Restart the agent\.$/);
  assert.equal(checkpointed, false, "a thread in the wrong folder never becomes the agent's conversation");
  // A refused repair uses nothing and stops nothing: the running app-server keeps its conversation.
  assert.equal(handle.providerContinuationId, conversation);
  assert.equal(handle.observedState(), "idle");
  assert.deepEqual(harness.signals, []);
  assert.equal((await repair(`${spawnRequest().cwd}/`)).outcome, "replaced");
  // A request that names no folder has none to compare.
  assert.equal((await repair("")).outcome, "replaced");
  const starts = client.requests.filter((request) => request.method === "thread/start");
  assert.equal(starts.length, 4);
  for (const start of starts) assert.equal(Object.hasOwn(start.params as object, "cwd"), false);

  for (const [threadDirectory, reason] of [
    ["/tmp/letagents-elsewhere", /Codex opened this conversation in \/tmp\/letagents-elsewhere, not in the agent's folder \/tmp\/letagents-work-attempt, so LetAgents will not use it/],
    [null, /Codex did not report the folder this conversation opened in, so LetAgents will not use it/],
  ] as const) {
    const elsewhere = createHarness({ threadDirectory });
    const refused = new CodexProviderAdapter({ dependencies: elsewhere.dependencies });
    await assert.rejects(refused.spawn(spawnRequest({ deliveryMode: "daemon_inbox" })), reason);
    assert.deepEqual(elsewhere.signals, [{ pid: 4100, signal: "SIGTERM" }], "a refused launch stops its app-server");
    assert.equal(elsewhere.clients[0]!.requests.some((request) => request.method === "turn/start"), false);
  }
});

test("a Codex thread's folder is compared by where it really is", async (t) => {
  const real = await realpath(await mkdtemp(join(tmpdir(), "letagents-codex-thread-folder-")));
  const link = `${real}-link`;
  await symlink(real, link);
  t.after(async () => {
    await rm(link, { force: true });
    await rm(real, { recursive: true, force: true });
  });
  // The work attempt names the link; Codex reports the folder it resolves to.
  const harness = createHarness({ threadDirectory: real });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", cwd: link }));
  assert.equal(handle.observedState(), "idle");
});

test("a Codex thread's folder matches under its macOS data-volume path", {
  skip: process.platform === "darwin" ? false : "macOS firmlinks only",
}, async (t) => {
  const real = await realpath(await mkdtemp(join(tmpdir(), "letagents-codex-thread-folder-")));
  t.after(() => rm(real, { recursive: true, force: true }));
  // The same folder, by a path that does not resolve to the one Codex reports.
  const dataVolumePath = join("/System/Volumes/Data", real);
  assert.equal(await realpath(dataVolumePath), dataVolumePath);
  const harness = createHarness({ threadDirectory: real });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", cwd: dataVolumePath }));
  assert.equal(handle.observedState(), "idle");

  // Another folder is still refused, as is one that cannot be read.
  const other = await realpath(await mkdtemp(join(tmpdir(), "letagents-codex-thread-folder-")));
  t.after(() => rm(other, { recursive: true, force: true }));
  for (const cwd of [join("/System/Volumes/Data", other), join(real, "missing")]) {
    const refused = createHarness({ threadDirectory: real });
    await assert.rejects(new CodexProviderAdapter({ dependencies: refused.dependencies })
      .spawn(spawnRequest({ deliveryMode: "daemon_inbox", cwd })), /not in the agent's folder/);
  }
});

test("Codex ask-before-write remains read-only at turn dispatch after reattachment", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const launchPolicy = {
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  };
  const first = await adapter.spawn(spawnRequest({
    deliveryMode: "daemon_inbox",
    permissionProfileId: "ask_before_write",
    configurationRevision: 1,
    launchPolicy,
  }));

  const params = requestByMethod(harness.clients[0]!, "thread/start").params as Record<string, unknown>;
  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.sandbox, "read-only");
  assert.equal(Object.hasOwn(params, "sandboxPolicy"), false);

  const attachedAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await attachedAdapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection, launchPolicy });
  assertProviderHandle(attached);
  // Caller mutation and permissive user defaults cannot widen a captured launch contract.
  launchPolicy.sandboxPolicy.type = "dangerFullAccess";
  launchPolicy.approvalPolicy = "never";
  for (const [runtime, handle, client] of [[adapter, first, harness.clients[0]!], [attachedAdapter, attached, harness.clients[1]!]] as const) {
    await runtime.runRoomTurn(handle, { inboxItemId: "approval-retest", actionId: "approval-retest", sourceMessage: {}, activation: {} }, {
      checkpointTurnStarted: async (turnId) => {
        client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId } });
      },
    });
    const turn = requestByMethod(client, "turn/start").params as Record<string, unknown>;
    assert.equal(turn.approvalPolicy, "on-request");
    assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
    assert.equal(Object.hasOwn(turn, "sandbox"), false, "turn/start uses its native sandboxPolicy shape");
  }

  const unknownAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const unknown = await unknownAdapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
  assertProviderHandle(unknown);
  let dispatched = false;
  await assert.rejects(unknownAdapter.runRoomTurn(unknown, {
    inboxItemId: "unknown-policy", actionId: "unknown-policy", sourceMessage: {}, activation: {},
  }, { beforeNativeDispatch: async () => { dispatched = true; } }), /exact applied permission policy/);
  assert.equal(dispatched, false, "an unverified attach remains observable but cannot start work");
  assert.equal(harness.clients[2]!.requests.some(request => request.method === "turn/start"), false);
  const verified = await unknownAdapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection,
    launchPolicy: { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } } });
  assert.equal(verified, unknown, "verified configuration binds to the already observed exact native process");
  await unknownAdapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection,
    launchPolicy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } });
  await unknownAdapter.controlTurn(unknown, "Continue after permission recovery.");
  const recoveredTurn = requestByMethod(harness.clients[2]!, "turn/start").params as Record<string, unknown>;
  assert.equal(recoveredTurn.approvalPolicy, "on-request");
  assert.deepEqual(recoveredTurn.sandboxPolicy, { type: "readOnly", networkAccess: false },
    "the first verified contract remains immutable across subsequent attaches");
});

test("Codex fresh spawn does not let a fatal placeholder resume probe block thread/start", async () => {
  const harness = createHarness({ placeholderResumeIsFatal: true });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

  const handle = await adapter.spawn(spawnRequest());

  assert.equal(handle.observedState(), "working");
  assert.equal(handle.providerContinuationId, "thread-1");
  assert.deepEqual(
    harness.clients[0]!.requests.map((entry) => entry.method),
    ["mcpServerStatus/list", "thread/start", "turn/start", "thread/read"],
  );
  assert.deepEqual(harness.signals, []);
});

test("Codex workplace status timeout does not kill launch or durable resume", async () => {
  const harness = createHarness({ workplaceProbeTimesOut: true });
  const request = spawnRequest();
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

  const first = await firstAdapter.spawn(request);
  assert.equal(first.observedState(), "working");
  assert.equal(first.providerContinuationId, "thread-1");

  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();

  const resumed = await new CodexProviderAdapter({ dependencies: harness.dependencies }).resume({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
  }, request);

  assert.equal(resumed.observedState(), "working");
  assert.equal(resumed.providerContinuationId, first.providerContinuationId);
  assert.ok(harness.clients[1]!.requests.some((entry) => entry.method === "thread/resume"));
  assert.deepEqual(harness.signals, []);
});

test("Codex turn control interrupts the exact turn and resumes the same thread with the correction", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  client.turnStatus = "inProgress";

  const result = await adapter.controlTurn!(handle, "Use the corrected acceptance criteria.");

  assert.deepEqual(result, {
    capability: "native_interrupt",
    interrupted: true,
    resumed: true,
    state: "working",
  });
  const interrupt = client.requests.find((request) => request.method === "turn/interrupt");
  assert.deepEqual(interrupt?.params, { threadId: "thread-1", turnId: "turn-thread-1" });
  const redirected = client.requests.filter((request) => request.method === "turn/start").at(-1)!;
  assert.equal((redirected.params as { threadId: string }).threadId, "thread-1");
  assert.equal(
    (redirected.params as { input: Array<{ text: string }> }).input[0]?.text,
    "Use the corrected acceptance criteria.",
  );
  assert.equal(handle.providerContinuationId, "thread-1");
});

test("Codex turn control cannot clear or act past a genuine runtime failure", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  client.turnStatus = "inProgress";
  client.requests.length = 0;

  await assert.rejects(adapter.controlTurn!(handle, "Do not dispatch this correction.", {
    checkpointTurnStarted: async () => {},
    markDispatched: async () => {
      client.emit({ method: "thread/status/changed", params: {
        threadId: handle.providerContinuationId, status: { type: "systemError" },
      } });
      await flush();
    },
  }), (error: unknown) => error instanceof ProviderTurnControlError
    && error.turnControlOutcome === "uncertain");
  assert.equal(handle.observedState(), "failed");
  assert.equal(client.requests.some((request) => request.method === "turn/interrupt"), false);

  client.turnStatus = "completed";
  await assert.rejects(adapter.controlTurn!(handle, null), (error: unknown) =>
    error instanceof ProviderTurnControlError && error.turnControlOutcome === "uncertain");
  assert.equal(handle.observedState(), "failed");
});

test("Codex retry never retargets completed A to newer active B", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const original = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return {
      thread: { id: handle.providerContinuationId, turns: [
        { id: "turn-A", status: "interrupted", items: [] },
        { id: "turn-B", status: "inProgress", items: [] },
      ] },
    } as T;
    return original<T>(method, params);
  };
  client.requests.length = 0;
  const checkpoints: string[] = [];

  const stopped = await adapter.controlTurn!(handle, null, {
    targetTurnId: "turn-A",
    checkpointTurnStarted: async (turnId) => { checkpoints.push(turnId); },
    markDispatched: async () => { throw new Error("must not dispatch against B"); },
  });
  assert.deepEqual(stopped, { capability: "native_interrupt", interrupted: false, resumed: false, state: "working" });
  await assert.rejects(() => adapter.controlTurn!(handle, "apply exact correction", {
    targetTurnId: "turn-A",
    checkpointTurnStarted: async () => {},
    markDispatched: async () => { throw new Error("must not dispatch against B"); },
  }), /newer turn is active/);
  assert.deepEqual(checkpoints, ["turn-A"]);
  assert.equal(client.requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(client.requests.some((request) => request.method === "turn/start"), false);
});

test("Codex exact legacy-turn control checkpoints once and never selects a newer latest turn", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const original = client.request.bind(client);
  let turns: Array<{ id: string; status: string }> = [
    { id: "turn-polling", status: "inProgress" },
    { id: "turn-newer", status: "inProgress" },
  ];
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return {
      thread: { id: handle.providerContinuationId, turns: turns.map((turn) => ({ ...turn, items: [] })) },
    } as T;
    if (method === "turn/interrupt") {
      await original<T>(method, params);
      const id = (params as { turnId: string }).turnId;
      turns = turns.map((turn) => turn.id === id ? { ...turn, status: "interrupted" } : turn);
      return {} as T;
    }
    return original<T>(method, params);
  };
  client.requests.length = 0;
  const events: string[] = [];

  const result = await adapter.controlExactTurn!(handle, {
    targetTurnId: "turn-polling",
    checkpointTargetTurn: async (turnId) => { events.push(`checkpoint:${turnId}`); },
    markDispatched: async () => { events.push("dispatch"); },
  });

  assert.deepEqual(result, { outcome: "interrupt_dispatched", targetTurnId: "turn-polling" });
  assert.deepEqual(events, ["checkpoint:turn-polling", "dispatch"]);
  assert.deepEqual(
    client.requests.filter((request) => request.method === "turn/interrupt").map((request) => request.params),
    [{ threadId: "thread-1", turnId: "turn-polling" }],
  );
});

test("Codex exact legacy-turn control proves no-active and persisted terminal boundaries without interrupting", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const original = client.request.bind(client);
  let turns: Array<{ id: string; status: string }> = [];
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns } } as T;
    return original<T>(method, params);
  };
  client.requests.length = 0;
  const callbacks = { checkpointedTurnIds: [] as string[], dispatch: 0 };
  const options = {
    checkpointTargetTurn: async (turnId: string) => { callbacks.checkpointedTurnIds.push(turnId); },
    markDispatched: async () => { callbacks.dispatch += 1; },
  };
  assert.deepEqual(await adapter.controlExactTurn!(handle, options), { outcome: "no_active", targetTurnId: null });
  turns = [{ id: "turn-polling", status: "interrupted" }, { id: "turn-newer", status: "inProgress" }];
  assert.deepEqual(await adapter.controlExactTurn!(handle, { ...options, targetTurnId: "turn-polling" }), {
    outcome: "terminal", targetTurnId: "turn-polling",
  });
  assert.deepEqual(callbacks, { checkpointedTurnIds: ["turn-polling"], dispatch: 0 }, "a discovered terminal latest is durably fenced before return and cannot be retargeted to turn-newer");
  assert.equal(client.requests.some((request) => request.method === "turn/interrupt"), false);
});

test("Codex exact legacy-turn control refuses missing, unknown, or callback-failed targets before native interrupt", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const original = client.request.bind(client);
  let turns: Array<{ id: string; status: string }> = [{ id: "turn-polling", status: "mystery" }];
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns } } as T;
    return original<T>(method, params);
  };
  client.requests.length = 0;
  const stable = { checkpointTargetTurn: async () => {}, markDispatched: async () => {} };
  await assert.rejects(adapter.controlExactTurn!(handle, { ...stable, targetTurnId: "turn-missing" }), /cannot find/);
  await assert.rejects(adapter.controlExactTurn!(handle, { ...stable, targetTurnId: "turn-polling" }), /unknown target state/);
  turns = [{ id: "turn-polling", status: "inProgress" }];
  await assert.rejects(adapter.controlExactTurn!(handle, {
    checkpointTargetTurn: async () => {},
    markDispatched: async () => { throw new Error("durable dispatch failed"); },
  }), /durable dispatch failed/);
  assert.equal(client.requests.some((request) => request.method === "turn/interrupt"), false);
});

test("Codex bounded room turn waits for its exact terminal event and publishes only final agent text", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  const causal: string[] = []; let boundedStatus = "inProgress"; let settled = false;
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") {
      const prompt = (params as { input: Array<{ text: string }> }).input[0]!.text;
      assert.match(prompt, /chat reply publication does not publish code or create PRs/);
      assert.match(prompt, /standing merge approval/);
      assert.match(prompt, /LetAgents room tools do not provide browser automation or a preview service/);
      assert.match(prompt, /capabilities actually exposed and authorized in this runtime/);
      assert.match(prompt, /report the specific gap once and continue independent feasible work/);
      assert.match(prompt, /leave affected verification incomplete/);
      assert.match(prompt, /Do not repeat an unchanged capability attempt or blocker report/);
      assert.match(prompt, /Still respond to explicit user instructions and new questions/);
      assert.match(prompt, /acknowledgment-only closing messages.*no-reply completion/);
      assert.match(prompt, /return exactly LETAGENTS_NO_ROOM_REPLY with no other text/);
      assert.doesNotMatch(prompt, /Browser QA is unavailable here/, "Codex may have separately configured authorized tools; the shared prompt must not claim Cursor's sealed capability limits");
      causal.push("turn/start");
      return { turn: { id: "turn-bounded" } } as T;
    }
    if (method === "thread/read") return {
      thread: { id: handle.providerContinuationId, turns: [{ id: "turn-bounded", status: boundedStatus, items: [
        { type: "userMessage", phase: "final", text: "Never publish this." },
        { type: "agentMessage", phase: "commentary", text: "Thinking aloud." },
        { type: "tool", phase: "final", text: "Tool transcript." },
        { type: "agentMessage", phase: "final", content: [{ text: "Final answer, part one." }, { text: "Part two." }] },
      ] }] },
    } as T;
    return originalRequest<T>(method, params);
  };
  const pending = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-1",
    actionId: "action-1",
    sourceMessage: { id: "message-1", text: "Please investigate." },
    activation: { for_current_agent: { reason: "mention" } },
  }, {
    beforeNativeDispatch: async () => { causal.push("before-native"); },
    checkpointTurnStarted: async (turnId) => { causal.push(`started:${turnId}`); },
  });
  void pending.then(() => { settled = true; });
  await flush();
  assert.deepEqual(causal, ["before-native", "turn/start", "started:turn-bounded"]);
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "other-turn" } });
  client.emit({ method: "turn/completed", params: { threadId: "other-thread", turnId: "turn-bounded" } });
  await flush();
  assert.equal(settled, false, "an unrelated turn terminal cannot settle this bounded delivery");
  boundedStatus = "completed";
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-bounded" } });
  const result = await pending;

  assert.deepEqual(result, {
    turnId: "turn-bounded",
    outcome: "reply",
    text: "Final answer, part one.\nPart two.",
    evidence: "transcript",
  });
  assert.equal(handle.pid, 4100);
  assert.equal(handle.providerContinuationId, "thread-1", "the bounded delivery retains the original app-server thread");
});

test("Codex bounded room turn verifies its exact terminal state when thread idle arrives without a turn terminal event", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  let boundedStatus = "inProgress";
  let settled = false;
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-idle-reconcile" } } as T;
    if (method === "thread/read") return { thread: {
      id: handle.providerContinuationId,
      turns: [{ id: "turn-idle-reconcile", status: boundedStatus, items: [
        { type: "agentMessage", phase: "final", text: "Verified after idle." },
      ] }],
    } } as T;
    return originalRequest<T>(method, params);
  };

  const pending = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-idle-reconcile",
    actionId: "action-idle-reconcile",
    sourceMessage: {},
    activation: {},
  }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
  void pending.then(() => { settled = true; });
  await flush();

  client.emit({ method: "thread/status/changed", params: {
    threadId: "other-thread", status: { type: "idle" },
  } });
  await flush();
  assert.equal(settled, false, "another thread becoming idle cannot settle the bounded turn");

  client.emit({ method: "thread/status/changed", params: {
    threadId: handle.providerContinuationId, status: { type: "idle" },
  } });
  await flush();
  assert.equal(settled, false, "idle alone cannot be treated as successful terminal evidence");

  boundedStatus = "completed";
  client.emit({ method: "thread/status/changed", params: {
    threadId: handle.providerContinuationId, status: { type: "idle" },
  } });
  assert.deepEqual(await pending, {
    turnId: "turn-idle-reconcile",
    outcome: "reply",
    text: "Verified after idle.",
    evidence: "transcript",
  });
});

test("room readiness targets the exact thread's LetAgents server while unrelated discovery hangs", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  const probes: RecordedRequest[] = [];
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "mcpServerStatus/list") {
      probes.push({ method, params });
      return new Promise<T>(() => {});
    }
    if (method === "mcpServer/resource/read") {
      probes.push({ method, params });
      await ready;
      return roomReadiness() as T;
    }
    return originalRequest<T>(method, params);
  };
  let dispatches = 0;
  const running = adapter.runRoomTurn!(handle, {
    inboxItemId: "target-tools", actionId: "target-tools-action", sourceMessage: {}, activation: {},
  }, { beforeNativeDispatch: async () => { dispatches += 1; } });
  void running.catch(() => undefined);
  await flush();
  assert.equal(dispatches, 0, "a pending readiness read cannot start model work");
  assert.deepEqual(probes, [{ method: "mcpServer/resource/read", params: {
    threadId: handle.providerContinuationId, server: "letagents", uri: "letagents://runtime/readiness",
  } }]);
  release(); await flush();
  assert.equal(dispatches, 1);
  client.emit({ method: "turn/completed", params: {
    threadId: handle.providerContinuationId, turnId: `turn-${handle.providerContinuationId}`,
  } });
  await running;
  assert.equal(probes.length, 1, "no aggregate discovery or polling is needed");
});

test("Codex blocks invalid or unavailable room readiness before any dispatch", async (t) => {
  const payload = JSON.parse(roomReadiness().contents[0].text);
  const resource = (value: unknown) => ({ contents: [{ ...roomReadiness().contents[0], text: JSON.stringify(value) }] });
  for (const [name, readiness] of Object.entries({
    "missing resource": { contents: [] },
    "old runtime without resource": new Error("Resource not found"),
    "failed connection": new Error("MCP server connection failed"),
    "malformed result": {},
    "ambiguous resource": { contents: [...roomReadiness().contents, ...roomReadiness().contents] },
    "wrong URI": { contents: [{ ...roomReadiness().contents[0], uri: "letagents://other" }] },
    "wrong MIME type": { contents: [{ ...roomReadiness().contents[0], mimeType: "text/plain" }] },
    "malformed JSON": { contents: [{ ...roomReadiness().contents[0], text: "{" }] },
    "oversized resource": { contents: [{ ...roomReadiness().contents[0], text: " ".repeat(64 * 1024 + 1) }] },
    "wrong format": resource({ ...payload, format: 2 }),
    "wrong profile": resource({ ...payload, profile: "autonomous_mcp_worker" }),
    "wrong provider": resource({ ...payload, provider: "cursor" }),
    "malformed tools": resource({ ...payload, tools: { get_board: {} } }),
    "missing board tool": roomReadiness(["claim_task", "read_messages", "send_message"]),
    "probe timeout": new Error("request timed out"),
  })) await t.test(name, async () => {
    const harness = createHarness();
    const spawn = spawnRequest({ deliveryMode: "daemon_inbox" });
    const original = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(spawn);
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.attach({ workAttemptId: spawn.workAttemptId,
      providerContinuationId: original.providerContinuationId!, providerConnection: original.providerConnection,
      launchPolicy: spawn.launchPolicy });
    assertProviderHandle(handle);
    const client = harness.clients.at(-1)!;
    const originalRequest = client.request.bind(client);
    let probes = 0;
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "mcpServer/resource/read") {
        probes += 1;
        assert.deepEqual(params, { threadId: original.providerContinuationId, server: "letagents", uri: "letagents://runtime/readiness" });
        if (readiness instanceof Error) throw readiness;
        return readiness as T;
      }
      return originalRequest<T>(method, params);
    };
    let dispatches = 0;
    await assert.rejects(adapter.runRoomTurn!(handle, {
      inboxItemId: "inbox-tools", actionId: "action-tools", sourceMessage: {}, activation: {},
    }, { beforeNativeDispatch: async () => { dispatches += 1; } }), {
      providerFailureCode: "provider_room_tools_unavailable",
      ...(name === "probe timeout" ? { message: "Room tool discovery timed out. No model turn was started. Retry the message." } : {}),
      ...(name === "missing board tool" ? { message: "Required LetAgents room tools are missing from this conversation. No model turn was started. Retry the message." } : {}),
    });
    assert.equal(dispatches, 0);
    assert.equal(client.requests.some(request => request.method === "turn/start"), false);
    assert.equal(probes, 1, "unavailable readiness never falls back to aggregate discovery");
    assert.equal(client.closed, false, "observation remains attached");
    assert.deepEqual(harness.signals, [], "a missing tool never kills the provider");
    assert.equal(harness.launches.length, 1);
  });
});

test("room readiness uses the unchanged bounded RPC budget without dispatching early", async (t) => {
  for (const delayMs of [6_500, 35_000]) await t.test(`inventory after ${delayMs}ms`, async (t) => {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    const originalRequest = client.request.bind(client);
    const originalWebSocket = globalThis.WebSocket;
    let probes = 0;
    class DiscoverySocket {
      static readonly OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      close() { this.readyState = 3; }
      send(raw: string) {
        const message = JSON.parse(raw);
        if (message.id === undefined) return;
        if (message.method === "initialize") {
          queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result: {} }) }));
          return;
        }
        assert.equal(message.method, "mcpServer/resource/read");
        assert.equal(message.params.threadId, handle.providerContinuationId);
        probes += 1;
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result: roomReadiness() }) }), delayMs);
      }
    }
    globalThis.WebSocket = DiscoverySocket as unknown as typeof WebSocket;
    const rpc = new CodexRpcClient("ws://synthetic.invalid");
    try {
      await rpc.connect();
      client.request = <T>(method: string, params?: unknown, options?: { timeoutMs?: number }) =>
        method === "mcpServer/resource/read" ? rpc.request<T>(method, params, options) : originalRequest<T>(method, params);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let dispatches = 0; let settled = false;
      const running = adapter.runRoomTurn!(handle, {
        inboxItemId: "slow-tools", actionId: "slow-tools-action", sourceMessage: {}, activation: {},
      }, { beforeNativeDispatch: async () => { dispatches += 1; } });
      void running.then(() => { settled = true; }, () => { settled = true; });
      const timeout = delayMs > 30_000 ? assert.rejects(running, /Room tool discovery timed out/) : null;
      await flush();
      t.mock.timers.tick(5_001); await flush();
      assert.equal(settled, false, "healthy MCP startup may exceed five seconds");
      assert.equal(dispatches, 0, "discovery itself never starts a model turn");
      if (timeout) {
        t.mock.timers.tick(30_000 - 5_001); await timeout;
        assert.equal(dispatches, 0);
        t.mock.timers.tick(delayMs - 30_000); await flush();
        assert.equal(dispatches, 0, "a late response cannot revive a timed-out delivery");
      } else {
        t.mock.timers.tick(delayMs - 5_001); await flush();
        assert.equal(dispatches, 1);
        client.emit({ method: "turn/completed", params: {
          threadId: handle.providerContinuationId, turnId: `turn-${handle.providerContinuationId}`,
        } });
        await running;
      }
      assert.equal(probes, 1, "discovery does not add a retry or polling loop");
    } finally { rpc.close(); globalThis.WebSocket = originalWebSocket; }
  });
});

test("Codex rechecks target readiness on each new turn but not exact prior-turn recovery", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  let healthy = true;
  const probes: unknown[] = [];
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "mcpServer/resource/read") {
      probes.push(params);
      return (healthy ? roomReadiness() : roomReadiness([])) as T;
    }
    return originalRequest<T>(method, params);
  };
  const request = { inboxItemId: "inbox-ready", actionId: "action-ready", sourceMessage: {}, activation: {} };
  const running = adapter.runRoomTurn!(handle, request);
  await flush();
  client.emit({ method: "turn/completed", params: {
    threadId: handle.providerContinuationId, turnId: `turn-${handle.providerContinuationId}`,
  } });
  await running;
  assert.deepEqual(probes, [
    { threadId: handle.providerContinuationId, server: "letagents", uri: "letagents://runtime/readiness" },
  ]);
  healthy = false;
  await assert.rejects(adapter.runRoomTurn!(handle, { ...request, inboxItemId: "inbox-next", actionId: "action-next" }), {
    providerFailureCode: "provider_room_tools_unavailable",
  });
  assert.equal(client.requests.filter(request => request.method === "turn/start").length, 1);
  assert.equal((await adapter.recoverRoomTurn!(handle, { inboxItemId: request.inboxItemId,
    providerTurnId: `turn-${handle.providerContinuationId}` })).turnId, `turn-${handle.providerContinuationId}`);
  assert.equal(probes.length, 2, "exact prior-turn recovery does not depend on current tool availability");
});

test("Codex refuses readiness evidence from a replaced RPC connection", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    const response = await originalRequest<T>(method, params);
    if (method === "mcpServer/resource/read") client.connectionEpoch = "replacement";
    return response;
  };
  let dispatched = false;
  await assert.rejects(adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-stale-tools", actionId: "action-stale-tools", sourceMessage: {}, activation: {},
  }, { beforeNativeDispatch: async () => { dispatched = true; } }), /runtime is unavailable/);
  assert.equal(dispatched, false);
  assert.equal(client.requests.some(request => request.method === "turn/start"), false);
});

test("an exact missing conversation during tool discovery retains automatic continuation repair", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "mcpServer/resource/read") throw new Error(`thread not found: ${handle.providerContinuationId}`);
    return originalRequest<T>(method, params);
  };
  await assert.rejects(adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-missing", actionId: "action-missing", sourceMessage: {}, activation: {},
  }), { providerFailureCode: "provider_continuation_missing", providerContinuationId: handle.providerContinuationId });
  assert.equal(client.requests.some(request => request.method === "turn/start"), false);
});

test("a failed Codex room turn leaves the same runtime available for its successor", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  let turnNumber = 0;
  const statuses = new Map<string, string>();
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") {
      const turnId = turnNumber++ === 0 ? "turn-failed" : "turn-successor";
      statuses.set(turnId, "inProgress");
      return { turn: { id: turnId } } as T;
    }
    if (method === "thread/read") return { thread: {
      id: handle.providerContinuationId,
      turns: [...statuses].map(([id, status]) => ({
        id,
        status,
        error: status === "failed" ? { message: "HTTP 503 unavailable" } : null,
        items: id === "turn-successor"
          ? [{ type: "agentMessage", phase: "final", text: "Successor completed." }]
          : [],
      })),
    } } as T;
    return originalRequest<T>(method, params);
  };

  const failed = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-failed", actionId: "action-failed", sourceMessage: {}, activation: {},
  }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
  await flush();
  statuses.set("turn-failed", "failed");
  client.emit({ method: "turn/completed", params: {
    threadId: handle.providerContinuationId, turnId: "turn-failed", turn: { id: "turn-failed", status: "failed" },
  } });
  assert.deepEqual(await failed, { turnId: "turn-failed", providerContinuationId: handle.providerContinuationId,
    outcome: "failed", text: null, evidence: "transcript", error: "HTTP 503 unavailable" });
  assert.equal(handle.observedState(), "idle");
  assert.equal(harness.launches[0]?.alive, true);

  const successor = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-successor", actionId: "action-successor", sourceMessage: {}, activation: {},
  }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
  await flush();
  statuses.set("turn-successor", "completed");
  client.emit({ method: "turn/completed", params: {
    threadId: handle.providerContinuationId, turnId: "turn-successor", turn: { id: "turn-successor", status: "completed" },
  } });
  assert.deepEqual(await successor, {
    turnId: "turn-successor", outcome: "reply", text: "Successor completed.", evidence: "transcript",
  });
  assert.equal(handle.observedState(), "idle");
  assert.equal(harness.launches.length, 1, "the successor reuses the same native app-server");
  assert.deepEqual(harness.signals, []);
});

test("a runtime failure during the turn checkpoint cannot be cleared by turn settlement", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-runtime-failure" } } as T;
    if (method === "thread/read") return { thread: {
      id: handle.providerContinuationId,
      turns: [{ id: "turn-runtime-failure", status: "completed", items: [
        { type: "agentMessage", phase: "final", text: "Turn completed after runtime failure." },
      ] }],
    } } as T;
    return originalRequest<T>(method, params);
  };

  const pending = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-runtime-failure", actionId: "action-runtime-failure", sourceMessage: {}, activation: {},
  }, {
    beforeNativeDispatch: async () => {},
    checkpointTurnStarted: async () => {
      client.emit({ method: "thread/status/changed", params: {
        threadId: handle.providerContinuationId, status: { type: "systemError" },
      } });
      await flush();
    },
  });
  await flush();
  assert.equal(handle.observedState(), "failed");
  client.emit({ method: "turn/completed", params: {
    threadId: handle.providerContinuationId,
    turnId: "turn-runtime-failure",
    turn: { id: "turn-runtime-failure", status: "completed" },
  } });
  assert.deepEqual(await pending, {
    turnId: "turn-runtime-failure", outcome: "reply",
    text: "Turn completed after runtime failure.", evidence: "transcript",
  });
  assert.equal(handle.observedState(), "failed");
});

test("a provider-refused turn on a daemon-inbox lane fails the turn, not the runtime, and the thread takes the next turn", async () => {
  const refusal = "The provider refused this turn. Try rephrasing your request.";
  const harness = createHarness();
  const stream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies, streamSink: (event) => stream.push(event) });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", lifecycleAuthorityMode: "typed" }));
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  const threadId = handle.providerContinuationId;
  const turns = [
    { id: "turn-refused", status: "failed", error: { message: refusal, codexErrorInfo: "cyberPolicy" }, items: [] },
    { id: "turn-refused-again", status: "failed", error: { message: refusal, codexErrorInfo: "cyberPolicy" }, items: [] },
    { id: "turn-answered", status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answered on the same thread." }] },
  ];
  let started = 0;
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: turns[started++]!.id } } as T;
    if (method === "thread/read") return { thread: { id: threadId, turns: turns.slice(0, started) } } as T;
    return originalRequest<T>(method, params);
  };
  const checkpointed: Array<{ outcome: string; runtime: string }> = [];
  const run = (turn: typeof turns[number]) => {
    const pending = adapter.runRoomTurn!(handle, {
      inboxItemId: `inbox-${turn.id}`, actionId: `action-${turn.id}`, sourceMessage: {}, activation: {},
    }, {
      beforeNativeDispatch: async () => {},
      checkpointTurnStarted: async () => {},
      checkpointTerminalResult: async (result) => {
        checkpointed.push({ outcome: result.outcome, runtime: handle.observedState() });
        return { acceptedResult: result, cleanupRecoveryEvidence: true };
      },
    });
    return { pending, identity: { threadId, turnId: turn.id } };
  };
  const refuse = async (turn: typeof turns[number]) => {
    const { pending, identity } = run(turn);
    await flush();
    client.emit({ method: "turn/started", params: { ...identity, turn: { id: turn.id, status: "inProgress" } } });
    // The order the app-server sends when the provider refuses a turn.
    client.emit({ method: "thread/status/changed", params: { threadId, status: { type: "systemError" } } });
    assert.equal(handle.observedState(), "working", "the thread's systemError status does not end the runtime");
    client.emit({ method: "error", params: { ...identity, willRetry: false, error: turn.error } });
    client.emit({ method: "turn/completed", params: { ...identity, turn } });
    assert.deepEqual(await pending, { turnId: turn.id, providerContinuationId: threadId,
      outcome: "failed", text: null, evidence: "transcript", error: refusal, refusal: true });
    assert.equal(handle.observedState(), "idle");
  };

  await refuse(turns[0]!);
  await refuse(turns[1]!);
  assert.notEqual((await adapter.probeControl(handle)).state, "lost", "a control probe does not report the runtime gone");

  const answered = run(turns[2]!);
  await flush();
  client.emit({ method: "turn/started", params: { ...answered.identity, turn: { id: "turn-answered", status: "inProgress" } } });
  client.emit({ method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
  client.emit({ method: "turn/completed", params: { ...answered.identity, turn: turns[2] } });
  assert.deepEqual(await answered.pending, {
    turnId: "turn-answered", outcome: "reply", text: "Answered on the same thread.", evidence: "transcript",
  });

  assert.deepEqual(checkpointed, [
    { outcome: "failed", runtime: "idle" }, { outcome: "failed", runtime: "idle" }, { outcome: "reply", runtime: "idle" },
  ], "each ending is offered for checkpoint on a runtime the daemon may still use");
  const lifecycle = observations.map((event) => event.fact)
    .filter((fact) => fact.domain === "runtime" || fact.domain === "turn")
    .map((fact) => [fact.domain, fact.state, "turnOutcome" in fact ? fact.turnOutcome : undefined]);
  assert.equal(observations.some((event) => event.fact.domain === "control" && event.fact.state === "lost"), false);
  assert.deepEqual(lifecycle, [
    ["runtime", "ready", undefined],
    ["runtime", "ready", undefined], ["turn", "active", undefined], ["turn", "terminal", "failed"],
    ["runtime", "ready", undefined], ["turn", "active", undefined], ["turn", "terminal", "failed"],
    ["runtime", "ready", undefined], ["turn", "active", undefined], ["turn", "terminal", "completed"],
  ], "each refusal is one failed turn; nothing is reported lost and the runtime never exits");
  assert.equal(harness.launches.length, 1, "one app-server served all three turns");
  assert.deepEqual(harness.signals, []);
  assert.deepEqual(stream.filter((event) => event.method === "error").map((event) => event.summary),
    [`Codex error: ${refusal}`, `Codex error: ${refusal}`], "the owner's activity names the provider's reason");
});

test("only a policy refusal is marked as one; other failed turns are not", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", lifecycleAuthorityMode: "typed" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  const threadId = handle.providerContinuationId;
  let current: Record<string, unknown> = {};
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: current.id } } as T;
    if (method === "thread/read") return { thread: { id: threadId, turns: [current] } } as T;
    return originalRequest<T>(method, params);
  };
  const cases: Array<[unknown, boolean]> = [
    ["cyberPolicy", true], ["misalignmentPolicyViolation", true],
    ["unauthorized", false], ["usageLimitExceeded", false], ["rateLimitExceeded", false], ["contextWindowExceeded", false],
    [{ responseTooManyFailedAttempts: { httpStatusCode: 429 } }, false], ["other", false], [null, false],
  ];
  for (const [index, [codexErrorInfo, refusal]] of cases.entries()) {
    current = { id: `turn-${index}`, status: "failed", error: { message: "The turn failed.", codexErrorInfo }, items: [] };
    const pending = adapter.runRoomTurn!(handle, {
      inboxItemId: `inbox-${index}`, actionId: `action-${index}`, sourceMessage: {}, activation: {},
    }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
    await flush();
    client.emit({ method: "turn/completed", params: { threadId, turnId: current.id, turn: current } });
    const result = await pending;
    assert.equal(result.outcome, "failed");
    assert.equal("refusal" in result && result.refusal === true, refusal, JSON.stringify(codexErrorInfo));
  }

  // A turn someone stopped is not a refusal, whatever error it carries.
  current = { id: "turn-stopped", status: "interrupted", error: { message: "The turn was stopped.", codexErrorInfo: "cyberPolicy" }, items: [] };
  const stopped = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-stopped", actionId: "action-stopped", sourceMessage: {}, activation: {},
  }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
  await flush();
  client.emit({ method: "turn/completed", params: { threadId, turnId: current.id, turn: current } });
  const interrupted = await stopped;
  assert.equal(interrupted.outcome, "interrupted");
  assert.equal("refusal" in interrupted, false, "an interrupted turn carries no refusal mark");
});

test("a lane that polls for itself still ends its runtime on a thread systemError", async () => {
  for (const lifecycleAuthorityMode of ["typed_shadow", "legacy"] as const) {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode }));
    const observations: NativeExecutionObservation[] = [];
    adapter.onExecution(handle, (event) => observations.push(event));
    harness.clients[0]!.emit({ method: "thread/status/changed", params: {
      threadId: handle.providerContinuationId, status: { type: "systemError" },
    } });
    assert.equal(handle.observedState(), "failed", lifecycleAuthorityMode);
    assert.deepEqual(observations.at(-1)?.fact, { domain: "runtime", kind: "state_changed", state: "exited",
      controlEvidence: "native_session_terminated", sideEffects: "none" }, lifecycleAuthorityMode);
  }
});

/**
 * The real adapter over a fake app-server, the real router, and a real daemon
 * with its real delivery, execution capture and shadow store. One supervised
 * daemon-inbox Codex agent is launched, bound and listening when this returns.
 */
async function codexDaemonFixture(options: {
  /** Answers the nth worker-session mint; the launch's own is the first. */
  mint?: (mints: number) => { expiresInMs?: number; newSession?: boolean } | Error;
  heartbeatMs?: number;
  /** Work leases the room says this agent holds. */
  ownedTasks?: Array<{ id: string; title: string; leaseId: string; epoch: number }>;
  /** The owner turns on the agent's use of their own tool setup before it starts. */
  ownerSetup?: boolean;
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
  const harness = createHarness({ exitOnSignal: true });
  /** The sealed MCP runtime's tools. An app update that changes them changes every agent's launch contract. */
  let sealedRuntime: unknown = custodialRuntimeContract;
  const adapter = new CodexProviderAdapter({ dependencies: { ...harness.dependencies, now: () => new Date().toISOString(),
    readMcpRuntimeContract: async () => sealedRuntime,
    // Waits are real here, only short, so that what the app-server sends
    // within milliseconds still arrives before a wait of seconds runs out.
    sleep: async (ms) => { harness.sleeps.push(ms); await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 40))); },
    // An app-server takes time to start. A replacement that is up in the same
    // millisecond its predecessor exits is not something a real one does, and
    // the daemon's settling of that exit is not built for it.
    waitForServer: async () => { await new Promise((resolve) => setTimeout(resolve, 200)); return true; } } });
  const roomMessages: Array<Record<string, unknown>> = [];
  const published: string[] = [];
  let mints = 0;
  /** Moves the daemon's clock ahead of the wall clock; its timers stay real. */
  let clockAheadMs = 0;
  /** Bearers of a session the room has ended. The grant that minted them still mints. */
  const endedBearers = new Set<string>();
  const daemon = new SupervisorDaemon(paths, "darwin", new ProviderActionPortRouter({ codex: async () => adapter }), true,
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
      createWorkerSession: async () => {
        mints += 1;
        const answer = options.mint?.(mints) ?? {};
        if (answer instanceof Error) throw answer;
        return { sessionId: answer.newSession ? `${id}-session-${mints}` : `${id}-session`, bearer: `${id}-bearer-${mints}`, bearerId: `${id}-bearer-id-${mints}`,
          expiresAt: new Date(Date.now() + (answer.expiresInMs ?? 24 * 60 * 60_000)).toISOString() };
      },
    });
  const read = <T>(sql: string): T[] => {
    const database = new DatabaseSync(paths.manifestPath, { readOnly: true });
    try { return database.prepare(sql).all(id).map((row) => ({ ...row })) as T[]; } finally { database.close(); }
  };
  const cleanup = async () => {
    // A stream callback that this stop fences rejects, and stop then returns
    // before it has closed its socket and stores, which would keep this test
    // process alive. Let the callbacks finish first, and finish the stop.
    await (daemon as unknown as { providerStreams: { drainCallbacks(): Promise<void> } }).providerStreams.drainCallbacks().catch(() => undefined);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { await daemon.stop(); break; } catch { /* retried */ }
    }
    await rm(root, { recursive: true, force: true });
  };
  try {
    await daemon.start({ getHostApprovalPublicKey: async () => host.publicKey.export({ format: "der", type: "spki" }).toString("base64") });
    (daemon as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const inbox = (daemon as unknown as { supervisedInbox: {
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
    await inbox.bootstrapCursor({ agent_id: id, room_id: "room_1", last_observed_message_id: null });
    const daemonGeneration = (await request("daemon.status")).result.generation;
    /** What the desktop app sends when the owner flips "use my own setup" for this agent. */
    const setOwnerSetup = async (enabled: boolean) => {
      const challenge = (await request("supervisor.host_approval_challenge")).result;
      const configuration = (await request("supervisor.get_agent_configuration", { entry_id: id, daemon_generation: daemonGeneration })).result;
      const issuedAt = Date.now();
      const payload = JSON.stringify({ domain: "letagents.host-approval", version: 1, ...challenge, operation: "set_home_harness",
        input: { entryId: id, daemonGeneration, expectedRevision: configuration.config_revision, enabled }, issuedAt, expiresAt: issuedAt + 30_000 });
      return request("supervisor.host_approval_request", { payload, signature: sign(null, Buffer.from(payload), host.privateKey).toString("base64") });
    };
    if (options.ownerSetup) {
      const on = await setOwnerSetup(true);
      assert.equal(on.ok, true, on.error);
    }
    assert.equal((await request("supervisor.install_host_grant", {
      entry_id: id, room_id: "room_1", agent_key: "owner/agent", grant_id: `grant-${id}`,
      supervisor_grant: `${id}-parent`, grant_generation: 1, api_url: "https://letagents.example", daemon_generation: daemonGeneration,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    })).ok, true);
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
          return { thread: { id: threadId, status: { type: status }, turns } } as T;
        }
        if (method === "thread/loaded/list") return { data: [threadId], nextCursor: null } as T;
        return originalRequest<T>(method, params);
      };
    };
    serveThread(client);
    const receipt = async (messageId: string) => (await inbox.receipts(id)).find((item) => item.source_message_id === messageId);
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
    return { id, harness, client, threadId, request, eventually, view, read, deliver, published, roomMessages, turns, receipt, serveThread, setOwnerSetup,
      receipts: () => inbox.receipts(id), mints: () => mints, cleanup, passTime: (ms: number) => { clockAheadMs += ms; },
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
      converge: () => (daemon as unknown as { requestConvergence(entryId: string): void }).requestConvergence(id) };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

for (const variant of ["", ", with an execution-capture gap from before", ", while it holds a task lease"] as const) test(`a real daemon keeps a Codex agent answering after its provider refuses two turns${variant}`, async () => {
  const refusal = "The provider refused this turn. Try rephrasing your request.";
  const priorGap = variant.includes("gap");
  const heldTask = variant.includes("task lease");
  const agent = await codexDaemonFixture(heldTask
    ? { ownedTasks: [{ id: "task_1", title: "Existing work", leaseId: "lease-1", epoch: 2 }] } : {});
  try {
    const observer = () => agent.read<{ last: number; max: number }>(
      "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0];
    if (priorGap) {
      // A terminal notification the adapter cannot attribute consumes a source
      // position without a fact: the capture lane has a gap from here on.
      agent.client.emit({ method: "turn/completed", params: {
        threadId: agent.threadId, turnId: "unknown-turn", turn: { id: "another-turn", status: "completed" },
      } });
      await agent.eventually(() => { const row = observer(); return Boolean(row && row.max > row.last); }, "the capture gap is durable");
    }

    // With a task lease held, a note that the task was not continued follows the reason.
    const reason = (row: { last_error: string | null }) => heldTask ? row.last_error?.slice(0, refusal.length) : row.last_error;
    assert.equal(reason(await agent.deliver(1, { refusal })), refusal, "the first refusal settles with the provider's reason");
    assert.equal(reason(await agent.deliver(2, { refusal })), refusal, "so does the second");
    await agent.deliver(3, { answer: "Answer 3." });
    if (heldTask) {
      const rows = await agent.receipts();
      assert.deepEqual(rows.map((row) => [row.source_message_id, row.state]),
        [["msg_1", "acknowledged_failed"], ["msg_2", "acknowledged_failed"], ["msg_3", "acknowledged"]],
        "no blocked task follow-up was queued in front of the next message");
      assert.ok(rows[1]!.last_error?.startsWith(refusal), "the provider's reason stays on the refused message");
    }
    assert.deepEqual(agent.published, ["Answer 3."], "the next message is delivered and answered without a person");
    assert.deepEqual(agent.read<{ activation_json: string }>("SELECT activation_json FROM supervised_agent_inbox WHERE agent_id=? ORDER BY fifo_sequence")
      .map((row) => Object.hasOwn(JSON.parse(row.activation_json), "task_continuity_refusal")), [false, false, false],
      "no refusal mark is left on a settled message");

    assert.equal(agent.harness.launches.length, 1, "the same app-server served every turn");
    assert.deepEqual(agent.harness.signals, [], "the runtime was never stopped");
    const current = await agent.view();
    assert.equal(current.condition, "none", current.last_error ?? "");
    assert.ok(["idle", "working"].includes(current.observed_state), current.observed_state);
    assert.equal(current.room_agent_state.connection.state, "connected");
    assert.equal(current.room_agent_state.inbox.state, "empty");
    if (priorGap) {
      const row = observer()!;
      assert.ok(row.max > row.last, "the earlier gap is still there; delivery did not depend on closing it");
    } else {
      await agent.eventually(() => agent.read<{ n: number }>(
        "SELECT COUNT(*) AS n FROM execution_turns WHERE agent_id=? AND state='terminal'")[0]!.n === 3, "the capture records every turn");
      assert.deepEqual(agent.read<{ provider_turn_id: string; state: string }>(
        "SELECT provider_turn_id,state FROM execution_turns WHERE agent_id=? ORDER BY created_at_ms,provider_turn_id"), [
        { provider_turn_id: "turn-1", state: "terminal" },
        { provider_turn_id: "turn-2", state: "terminal" },
        { provider_turn_id: "turn-3", state: "terminal" },
      ], "the real shadow store accepted each turn; none was lost");
      const row = observer()!;
      assert.equal(row.max, row.last, "the capture lane has no gap");
      await agent.eventually(() => agent.read<{ n: number }>(
        "SELECT COUNT(*) AS n FROM execution_message_attempts WHERE agent_id=? AND conclusion IS NOT NULL")[0]!.n === 3, "every attempt settles");
      assert.deepEqual(agent.read<{ source_message_id: string; conclusion: string | null }>(
        "SELECT source_message_id,conclusion FROM execution_message_attempts WHERE agent_id=? ORDER BY created_at_ms"), [
        { source_message_id: "msg_1", conclusion: "failed" },
        { source_message_id: "msg_2", conclusion: "failed" },
        { source_message_id: "msg_3", conclusion: "replied" },
      ]);
    }
  } finally {
    await agent.cleanup();
  }
});

test("convergence and heartbeats between a thread's systemError and its turn's ending leave the turn alone", async () => {
  const refusal = "The provider refused this turn. Try rephrasing your request.";
  const agent = await codexDaemonFixture();
  try {
    // A capture gap, so nothing could replace a runtime that was stopped here.
    agent.client.emit({ method: "turn/completed", params: {
      threadId: agent.threadId, turnId: "unknown-turn", turn: { id: "another-turn", status: "completed" },
    } });
    const row = await agent.deliver(1, { refusal, beforeEnding: async () => {
      // Eight heartbeats and two explicit passes while the turn has not ended.
      agent.converge();
      await new Promise((resolve) => setTimeout(resolve, 400));
      agent.converge();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(agent.harness.signals, [], "the runtime is not stopped under its turn");
    } });
    assert.equal(row.last_error, refusal);
    await agent.deliver(2, { answer: "Answer 2." });
    assert.deepEqual(agent.published, ["Answer 2."]);
    assert.equal(agent.harness.launches.length, 1);
    assert.deepEqual(agent.harness.signals, []);
  } finally {
    await agent.cleanup();
  }
});

test("a runtime that ends under a turn is retired only after the turn's delayed result is saved", async () => {
  const reason = "The provider failed this turn.";
  const agent = await codexDaemonFixture();
  try {
    agent.roomMessages.push({ id: "msg_1", sender: "someone", text: "request 1",
      activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 1 && Boolean((await agent.receipt("msg_1"))?.provider_turn_id),
      "msg_1 starts its turn");
    const turn = agent.turns[0]!;
    const identity = { threadId: agent.threadId, turnId: turn.id };
    agent.client.emit({ method: "turn/started", params: { ...identity, turn: { id: turn.id, status: "inProgress" } } });

    // The runtime itself ends, without its process exiting, under the turn.
    agent.client.emit({ method: "process/systemError", params: { status: "systemError" } });
    // Eight heartbeats and two explicit passes before the provider reports the turn.
    agent.converge();
    await new Promise((resolve) => setTimeout(resolve, 400));
    agent.converge();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(agent.harness.signals, [], "the runtime is not stopped before its turn's result is saved");
    assert.equal((await agent.receipt("msg_1"))?.last_error ?? null, null, "and the turn is still open");

    // The delayed terminal event.
    Object.assign(turn, { status: "failed", error: { message: reason } });
    agent.client.emit({ method: "turn/completed", params: { ...identity, turn } });
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged_failed", "msg_1 settles");
    assert.equal((await agent.receipt("msg_1"))?.last_error, reason, "with the provider's own reason");
    await agent.eventually(() => agent.harness.signals.length === 1, "the ended runtime is stopped once its turn is recorded");

    // Its replacement serves the same conversation and answers the next message.
    await agent.eventually(() => agent.harness.clients.length === 2, "the runtime is replaced");
    const successor = agent.harness.clients[1]!;
    agent.serveThread(successor);
    agent.roomMessages.push({ id: "msg_2", sender: "someone", text: "request 2",
      activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 2 && Boolean((await agent.receipt("msg_2"))?.provider_turn_id),
      "msg_2 starts its own turn on the replacement");
    const next = agent.turns[1]!;
    successor.emit({ method: "turn/started", params: { threadId: agent.threadId, turnId: next.id, turn: { id: next.id, status: "inProgress" } } });
    Object.assign(next, { status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answer 2." }] });
    successor.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
    successor.emit({ method: "turn/completed", params: { threadId: agent.threadId, turnId: next.id, turn: next } });
    await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered");
    assert.deepEqual(agent.published, ["Answer 2."]);
    assert.deepEqual((await agent.receipts()).map((row) => [row.source_message_id, row.state]),
      [["msg_1", "acknowledged_failed"], ["msg_2", "acknowledged"]], "the failed turn was never run again");
    assert.equal(agent.turns.length, 2);
    assert.equal(agent.harness.launches.length, 2, "one replacement");
  } finally {
    await agent.cleanup();
  }
});

test("an ended runtime whose turn can no longer be recorded is left until the provider finishes it, and retired when the bounded wait runs out", async () => {
  const reason = "The provider failed this turn.";
  // The launch's bearer falls due for rotation fifteen seconds after it is
  // minted; a rotation then gets a new session, as the room gives when the
  // earlier one has ended. The lane that started a turn under the earlier
  // session has no authority left to record it.
  const agent = await codexDaemonFixture({ mint: (mints) => mints === 1 ? { expiresInMs: 75_000 } : { newSession: true } });
  try {
    await agent.eventually(async () => (await agent.view())?.room_agent_state?.ingress.state === "observing", "the agent listens to its room");
    // A capture gap: no fact tells the entry that its runtime ended, so the
    // heartbeat keeps rotating its bearer.
    agent.client.emit({ method: "turn/completed", params: {
      threadId: agent.threadId, turnId: "unknown-turn", turn: { id: "another-turn", status: "completed" },
    } });
    await agent.eventually(() => {
      const row = agent.read<{ last: number; max: number }>(
        "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0];
      return Boolean(row && row.max > row.last);
    }, "the capture gap is durable");
    agent.roomMessages.push({ id: "msg_1", sender: "someone", text: "request 1",
      activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 1 && Boolean((await agent.receipt("msg_1"))?.provider_turn_id),
      "msg_1 starts its turn");
    const turn = agent.turns[0]!;
    const identity = { threadId: agent.threadId, turnId: turn.id };
    agent.client.emit({ method: "turn/started", params: { ...identity, turn: { id: turn.id, status: "inProgress" } } });
    agent.client.emit({ method: "process/systemError", params: { status: "systemError" } });

    // Fifteen seconds pass: the bearer is due, and half the wait for the turn is left.
    agent.passTime(15_000);
    await agent.eventually(() => agent.mints() === 2, "the rotation mints a new session under the turn");
    // Eight heartbeats with the lane torn down and the provider still working.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(agent.harness.signals, [], "the runtime is not stopped while its message is in flight");

    // The provider finishes the turn and records its ending in the thread.
    Object.assign(turn, { status: "failed", error: { message: reason } });
    agent.client.emit({ method: "turn/completed", params: { ...identity, turn } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(agent.harness.signals, [], "nor before the bounded wait for that message has run out");
    assert.equal((await agent.receipt("msg_1"))?.state, "dispatching", "nothing here could record the turn");

    // The wait runs out: the runtime is retired, once, with the turn's ending
    // already in the provider's own record for the replacement to read.
    agent.passTime(31_000);
    agent.converge();
    await agent.eventually(() => agent.harness.signals.length === 1, "the ended runtime is stopped when the wait runs out");
    const row = await agent.receipt("msg_1");
    assert.equal(row?.provider_turn_id, "turn-1", "the message keeps its exact turn");
    assert.equal(agent.turns.length, 1, "and that turn is never run again");
  } finally {
    await agent.cleanup();
  }
});

test("a failed turn whose turn/completed never arrives is settled from the thread after a stated wait, and the next message runs", async () => {
  const reason = "The provider refused this turn.";
  const agent = await codexDaemonFixture();
  try {
    agent.roomMessages.push({ id: "msg_1", sender: "someone", text: "request 1",
      activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 1 && Boolean((await agent.receipt("msg_1"))?.provider_turn_id),
      "msg_1 starts its turn");
    const turn = agent.turns[0]!;
    const identity = { threadId: agent.threadId, turnId: turn.id };
    agent.client.emit({ method: "turn/started", params: { ...identity, turn: { id: turn.id, status: "inProgress" } } });
    const sleepsBefore = agent.harness.sleeps.length;
    // The app-server fails the turn and reports the thread; its turn/completed is lost.
    Object.assign(turn, { status: "failed", error: { message: reason, codexErrorInfo: "unauthorized" } });
    // Reported twice, as a reconnecting client can see it: still one read.
    for (let report = 0; report < 2; report += 1) {
      agent.client.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "systemError" } } });
    }
    agent.client.emit({ method: "error", params: { ...identity, willRetry: false, error: turn.error } });

    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged_failed", "msg_1 settles without its turn/completed");
    assert.equal((await agent.receipt("msg_1"))?.last_error, reason, "with the provider's reason, read from the thread");
    assert.deepEqual(agent.harness.sleeps.slice(sleepsBefore), [2_000], "after one stated wait, not a poll");
    await agent.eventually(async () => (await agent.view()).observed_state === "idle", "the agent is idle again", 5_000).catch(async (error) => {
      const current = await agent.view();
      throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
    });

    // The lost notification turns up after all: it repeats what the thread
    // already said, and execution capture takes it without a gap.
    agent.client.emit({ method: "turn/completed", params: { ...identity, turn } });
    await agent.turnsRecorded(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const observer = agent.read<{ last: number; max: number }>(
      "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0]!;
    assert.equal(observer.max, observer.last, "the capture lane has no gap");
    assert.equal((await agent.receipt("msg_1"))?.state, "acknowledged_failed");

    await agent.deliver(2, { answer: "Answer 2." });
    assert.deepEqual(agent.published, ["Answer 2."]);
    assert.equal(agent.harness.launches.length, 1, "on the same runtime");
    assert.deepEqual(agent.harness.signals, []);
  } finally {
    await agent.cleanup();
  }
});

for (const lastTurn of ["answered", "refused"] as const) test(`an app update replaces the runtime of an agent whose last turn was ${lastTurn}, and its next message is delivered`, async () => {
  const agent = await codexDaemonFixture();
  try {
    if (lastTurn === "refused") await agent.deliver(1, { refusal: "The provider refused this turn." });
    else await agent.deliver(1, { answer: "Answer 1." });
    await agent.turnsRecorded(1);
    agent.updateApp();

    agent.roomMessages.push({ id: "msg_2", sender: "someone", text: "request 2",
      activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(() => agent.harness.clients.length === 2, "the runtime launched by the old app is replaced", 10_000).catch(async (error) => {
      const current = await agent.view();
      throw new Error(`${(error as Error).message}: msg_2 is ${(await agent.receipt("msg_2"))?.state}; agent is ${current.observed_state}/${current.condition} (${current.last_error}); inbox ${current.room_agent_state.inbox.state}`);
    });
    const successor = agent.harness.clients[1]!;
    agent.serveThread(successor);
    await agent.eventually(async () => agent.turns.length === 2 && Boolean((await agent.receipt("msg_2"))?.provider_turn_id),
      "msg_2 starts its turn on the replacement");
    const next = agent.turns[1]!;
    successor.emit({ method: "turn/started", params: { threadId: agent.threadId, turnId: next.id, turn: { id: next.id, status: "inProgress" } } });
    Object.assign(next, { status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answer 2." }] });
    successor.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
    successor.emit({ method: "turn/completed", params: { threadId: agent.threadId, turnId: next.id, turn: next } });
    await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered");
    assert.equal(agent.published.at(-1), "Answer 2.");
    assert.equal(agent.harness.launches.length, 2, "one replacement");
  } finally {
    await agent.cleanup();
  }
});

test("an agent that still runs with its owner's setup after a refused turn is stopped and replaced without it when the owner turns the setup off", async () => {
  const agent = await codexDaemonFixture({ ownerSetup: true });
  try {
    assert.equal(agent.harness.launchOptions[0]?.options.homeHarness, true, "the runtime was started with the owner's setup");
    await agent.deliver(1, { refusal: "The provider refused this turn." });
    await agent.turnsRecorded(1);

    // Its thread is in systemError. The switch replaces the runtime as it
    // does after an answered turn: as soon as the agent is idle.
    const off = await agent.setOwnerSetup(false);
    assert.equal(off.ok, true, off.error);
    await agent.eventually(() => agent.harness.signals.length === 1, "the runtime that has the setup is stopped");
    await agent.eventually(() => agent.harness.launches.length === 2, "a replacement is started").catch(async (error) => {
      const current = await agent.view();
      throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
    });
    assert.notEqual(agent.harness.launchOptions[1]?.options.homeHarness, true, "and it runs without the owner's setup");
    assert.equal(agent.turns.length, 1, "no turn ran on the runtime that still had the setup");
  } finally {
    await agent.cleanup();
  }
});

test("an agent paused and resumed after a refused turn is replaced, and its next message is delivered", async () => {
  const agent = await codexDaemonFixture();
  const snap = async () => { const current = await agent.view(); return `agent is ${current.observed_state}/${current.condition} (${current.last_error}); launches ${agent.harness.launches.length}; signals ${JSON.stringify(agent.harness.signals)}`; };
  try {
    await agent.deliver(1, { refusal: "The provider refused this turn." });
    await agent.turnsRecorded(1);
    assert.equal((await agent.request("manifest.set_desired_state", { id: agent.id, desired_state: "paused" })).ok, true);
    await agent.eventually(async () => (await agent.view()).observed_state === "paused", "the agent pauses").catch(async (error) => { throw new Error(`${(error as Error).message}: ${await snap()}`); });
    assert.equal(agent.harness.signals.length, 1, "pausing stops the runtime whose thread is in systemError");
    assert.equal((await agent.request("manifest.set_desired_state", { id: agent.id, desired_state: "running" })).ok, true);
    await agent.eventually(() => agent.harness.clients.length === 2, "resuming starts a runtime").catch(async (error) => { throw new Error(`${(error as Error).message}: ${await snap()}`); });
    const successor = agent.harness.clients[1]!;
    agent.serveThread(successor);

    agent.roomMessages.push({ id: "msg_2", sender: "someone", text: "request 2",
      activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 2 && Boolean((await agent.receipt("msg_2"))?.provider_turn_id),
      "msg_2 starts its turn on the resumed runtime").catch(async (error) => { throw new Error(`${(error as Error).message}: msg_2 is ${(await agent.receipt("msg_2"))?.state}; ${await snap()}`); });
    const next = agent.turns[1]!;
    successor.emit({ method: "turn/started", params: { threadId: agent.threadId, turnId: next.id, turn: { id: next.id, status: "inProgress" } } });
    Object.assign(next, { status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answer 2." }] });
    successor.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
    successor.emit({ method: "turn/completed", params: { threadId: agent.threadId, turnId: next.id, turn: next } });
    await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered");
    assert.equal(agent.published.at(-1), "Answer 2.");
  } finally {
    await agent.cleanup();
  }
});

for (const runtime of ["healthy", "ended"] as const) for (const room of ["ends the agent's session", "still accepts the agent"] as const) {
  if (runtime === "healthy" && room === "still accepts the agent") continue;
  test(`${runtime === "ended" ? "an ended" : "a healthy"} runtime whose room ${room}: ${room === "still accepts the agent" ? "the runtime is replaced" : "no new session and no new runtime"}`, async () => {
    const { ROOM_REFUSED_ACCESS_DETAIL } = await import(new URL("../../daemon/supervised-agent-delivery.ts", import.meta.url).href);
    const agent = await codexDaemonFixture();
    try {
      // A capture gap: no fact will tell the entry that its runtime ended,
      // which is the ending this change newly recovers by replacing the runtime.
      agent.client.emit({ method: "turn/completed", params: {
        threadId: agent.threadId, turnId: "unknown-turn", turn: { id: "another-turn", status: "completed" },
      } });
      await agent.eventually(() => {
        const row = agent.read<{ last: number; max: number }>(
          "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0];
        return Boolean(row && row.max > row.last);
      }, "the capture gap is durable");
      const mintsBefore = agent.mints();
      assert.equal(mintsBefore, 1, "the launch's own session");

      if (room === "ends the agent's session") {
        // What a room admin's disconnect looks like from here: the bearer is
        // refused, and the grant that minted it would mint again if asked.
        agent.endRoomSession();
        await agent.eventually(async () => (await agent.view()).room_agent_state.ingress.state === "blocked", "the owner sees the refusal");
      }
      if (runtime === "ended") agent.client.emit({ method: "process/systemError", params: { status: "systemError" } });

      if (room === "still accepts the agent") {
        await agent.eventually(() => agent.harness.signals.length === 1, "the ended runtime is stopped for its replacement");
        return;
      }
      // Thirty heartbeats, with the refused poll retried throughout.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      assert.equal(agent.mints(), mintsBefore, "no session is minted");
      assert.equal(agent.harness.launches.length, 1, "no runtime is launched");
      assert.deepEqual(agent.harness.signals, [], "and none is stopped");
      const current = await agent.view();
      assert.deepEqual([current.room_agent_state.ingress.state, current.room_agent_state.ingress.detail],
        ["blocked", ROOM_REFUSED_ACCESS_DETAIL], "the owner is told the room refused the agent, not that it is reconnecting");
    } finally {
      await agent.cleanup();
    }
  });
}

test("an ended runtime whose room access was refused is not minted for again on every heartbeat", async () => {
  const { SupervisorGrantRequestError } = await import(new URL("../../daemon/cloud-http.ts", import.meta.url).href);
  // The launch's bearer is due for rotation at once, and the room refuses
  // every later mint: the agent ends up with no room binding.
  const agent = await codexDaemonFixture({
    mint: (mints) => mints === 1 ? { expiresInMs: 30_000 } : new SupervisorGrantRequestError(403, "Worker session mint"),
  });
  try {
    await agent.eventually(async () => /Use Reconnect/.test((await agent.view()).last_error ?? ""),
      "room access is given up after its bounded attempts", 30_000);
    // The runtime itself now ends without its process exiting.
    agent.client.emit({ method: "process/systemError", params: { status: "systemError" } });
    // The failure itself is reconciled once; let that settle before counting.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const settledMints = agent.mints();
    // Thirty heartbeats. Each used to send convergence to mint once more.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(agent.mints(), settledMints, "no heartbeat mints for an agent that has no room binding");
    const current = await agent.view();
    assert.equal(current.condition, "coordination_blocked");
    assert.match(current.last_error ?? "", /Use Reconnect/, "the owner still sees how to restore it");
  } finally {
    await agent.cleanup();
  }
});

test("an error activity line is generic without a reason, bounded, and free of credentials", async () => {
  const harness = createHarness();
  const stream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies, streamSink: (event) => stream.push(event) });
  const handle = await adapter.spawn(spawnRequest());
  for (const error of [undefined, {}, { message: "   " }, { message: 7 }]) {
    harness.clients[0]!.emit({ method: "error", params: { threadId: handle.providerContinuationId, error } });
  }
  harness.clients[0]!.emit({ method: "error", params: {
    threadId: handle.providerContinuationId, error: { message: `first line\n  second line ${"x".repeat(600)}` },
  } });
  // Only the `error` notification is the provider's reason for a failed turn.
  // Another notification that happens to carry an error keeps its own summary.
  harness.clients[0]!.emit({ method: "thread/tokenUsage/updated", params: {
    threadId: handle.providerContinuationId, error: { message: "not a failed turn" },
  } });
  assert.doesNotMatch(stream.find((event) => event.method === "thread/tokenUsage/updated")?.summary ?? "", /^Codex error:/);
  const lines = stream.filter((event) => event.method === "error").map((event) => event.summary);
  assert.deepEqual(lines.slice(0, 4), Array(4).fill("Codex runtime event: error"));
  assert.match(lines[4] ?? "", /^Codex error: first line second line x+$/);
  assert.equal(lines[4]?.length, 500, "the line is bounded");

  // A provider can echo the credential it rejected. Built at run time so no
  // credential-shaped literal sits in this file.
  const echoed = "ab12".repeat(8);
  harness.clients[0]!.emit({ method: "error", params: {
    threadId: handle.providerContinuationId, error: { message: `The key was rejected: Bearer ${echoed}` },
  } });
  const redacted = stream.filter((event) => event.method === "error").at(-1)?.summary ?? "";
  assert.equal(redacted, "Codex error: The key was rejected: Bearer [REDACTED]");
  assert.equal(redacted.includes(echoed), false, "a credential in the provider's reason never reaches the activity line");
});

test("a hard runtime failure prevents bounded room-turn dispatch across the durable callback", async () => {
  for (const failureTiming of ["before", "during-callback"] as const) {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    client.requests.length = 0;
    const failRuntime = async () => {
      client.emit({ method: "thread/status/changed", params: {
        threadId: handle.providerContinuationId, status: { type: "systemError" },
      } });
      await flush();
    };
    if (failureTiming === "before") await failRuntime();

    await assert.rejects(adapter.runRoomTurn!(handle, {
      inboxItemId: `inbox-${failureTiming}`,
      actionId: `action-${failureTiming}`,
      sourceMessage: {},
      activation: {},
    }, {
      beforeNativeDispatch: failureTiming === "during-callback" ? failRuntime : async () => {},
      checkpointTurnStarted: async () => {},
    }), /runtime is unavailable/);

    assert.equal(handle.observedState(), "failed");
    assert.equal(client.requests.some((request) => request.method === "turn/start"), false,
      `${failureTiming}: no native work starts after hard runtime failure`);
  }
});

test("Codex bounded room turn consumes a fast exact terminal cached before its waiter", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") {
      client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-fast" } });
      return { turn: { id: "turn-fast" } } as T;
    }
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-fast", status: "completed", items: [{ type: "agentMessage", phase: "final", text: "LETAGENTS_NO_ROOM_REPLY" }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  assert.deepEqual(await adapter.runRoomTurn!(handle, { inboxItemId: "inbox-fast", actionId: "action-fast", sourceMessage: {}, activation: {} }, {
    beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {},
  }), { turnId: "turn-fast", outcome: "no_reply", text: null, evidence: "transcript" });
});

test("Codex bounded room turn preserves an unreadable completed result without throwing", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-empty" } } as T;
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-empty", status: "completed", items: [{ type: "agentMessage", phase: "final", text: "  " }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const pending = adapter.runRoomTurn!(handle, { inboxItemId: "inbox-empty", actionId: "action-empty", sourceMessage: {}, activation: {} }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
  await flush(); client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-empty" } });
  assert.deepEqual(await pending, { turnId: "turn-empty", outcome: "unreadable", text: null, evidence: "none" });
});

test("Codex retains stream-only terminal evidence until the daemon durably checkpoints it", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-stream-checkpoint" } } as T;
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-stream-checkpoint", status: "completed" }] } } as T;
    return originalRequest<T>(method, params);
  };
  const pending = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-stream-checkpoint", actionId: "action-stream-checkpoint", sourceMessage: {}, activation: {},
  }, {
    beforeNativeDispatch: async () => {},
    checkpointTurnStarted: async () => {},
    checkpointTerminalResult: async () => { throw new Error("SQLite checkpoint unavailable"); },
  });
  await flush();
  client.emit({ method: "item/agentMessage/delta", params: { threadId: handle.providerContinuationId, turnId: "turn-stream-checkpoint", itemId: "answer", delta: "Retained answer" } });
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-stream-checkpoint" } });
  await assert.rejects(pending, /SQLite checkpoint unavailable/);
  let checkpointed: unknown = null;
  assert.deepEqual(await adapter.recoverRoomTurn!(handle, {
    inboxItemId: "inbox-stream-checkpoint", providerTurnId: "turn-stream-checkpoint",
  }, {
    checkpointTerminalResult: async (result) => { checkpointed = result; },
  }), { turnId: "turn-stream-checkpoint", outcome: "reply", text: "Retained answer", evidence: "stream" });
  assert.deepEqual(checkpointed, { turnId: "turn-stream-checkpoint", outcome: "reply", text: "Retained answer", evidence: "stream" });
});

test("Codex bounded room turn does not treat a sentinel with extra text as no-reply", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-sentinel-extra" } } as T;
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-sentinel-extra", status: "completed", items: [{ type: "agentMessage", phase: "final", text: "LETAGENTS_NO_ROOM_REPLY\nextra" }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const pending = adapter.runRoomTurn!(handle, { inboxItemId: "inbox-sentinel-extra", actionId: "action-sentinel-extra", sourceMessage: {}, activation: {} }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
  await flush(); client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-sentinel-extra" } });
  assert.deepEqual(await pending, { turnId: "turn-sentinel-extra", outcome: "reply", text: "LETAGENTS_NO_ROOM_REPLY\nextra", evidence: "transcript" });
});

test("Codex reports an exact missing conversation as a typed pre-turn failure", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") {
      throw new Error(`thread not found: ${handle.providerContinuationId}`);
    }
    return originalRequest<T>(method, params);
  };
  let checkpointedTurn = false;

  await assert.rejects(
    adapter.runRoomTurn!(handle, {
      inboxItemId: "inbox-missing-thread",
      actionId: "action-missing-thread",
      sourceMessage: {},
      activation: {},
    }, {
      beforeNativeDispatch: async () => {},
      checkpointTurnStarted: async () => { checkpointedTurn = true; },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderContinuationMissingError);
      assert.equal(error.providerFailureCode, "provider_continuation_missing");
      assert.equal(error.providerContinuationId, "thread-1");
      return true;
    },
  );
  assert.equal(checkpointedTurn, false, "a missing thread never creates durable evidence that a model turn began");
  assert.equal(handle.providerContinuationId, "thread-1");
  assert.equal(handle.pid, 4100);
});

test("Codex repairs a readable-but-not-runnable conversation on the same app-server process", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const resumesBefore = client.threadResumeCounts.get("thread-1") ?? 0;
  const readsBefore = client.requests.filter((request) =>
    request.method === "thread/read"
    && (request.params as { threadId?: string } | undefined)?.threadId === "thread-1").length;
  client.markThreadMissing("thread-1");
  const checkpointed: string[] = [];

  const result = await adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId,
    expectedProviderContinuationId: "thread-1",
    cwd: "/tmp/letagents-work-attempt",
    launchPolicy: spawnRequest().launchPolicy,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  }, {
    checkpointReplacement: async (continuation) => {
      assert.equal(handle.providerContinuationId, "thread-1", "the live handle cannot move before the durable checkpoint");
      checkpointed.push(continuation);
    },
  });

  assert.equal(result.handle, handle, "repair retains the sole process/stream owner");
  assert.deepEqual(result, {
    handle,
    outcome: "replaced",
    previousProviderContinuationId: "thread-1",
    replacementProviderContinuationId: "thread-1-replacement-1",
  });
  assert.deepEqual(checkpointed, ["thread-1-replacement-1"]);
  assert.deepEqual(harness.sleeps, [1_000, 2_000, 4_000], "probes occur at absolute 0s, 1s, 3s, and 7s");
  assert.equal((client.threadResumeCounts.get("thread-1") ?? 0) - resumesBefore, 4);
  assert.equal(
    client.requests.filter((request) =>
      request.method === "thread/read"
      && (request.params as { threadId?: string } | undefined)?.threadId === "thread-1").length - readsBefore,
    0,
    "metadata readability is not accepted as execution readiness",
  );
  assert.equal(client.requests.filter((request) => request.method === "thread/start").length, 2);
  assert.equal(harness.launches.length, 1, "repair must not launch another app-server");
  assert.equal(handle.pid, 4100);
  assert.deepEqual(handle.providerConnection, {
    kind: "codex_app_server",
    url: "ws://127.0.0.1:4700",
    pid: 4100,
    processIdentity: "fake-process-4100-birth-1",
  });
  assert.equal(handle.workAttemptId, spawnRequest().workAttemptId);
  assert.equal(handle.providerContinuationId, "thread-1-replacement-1");
});

test("Codex continuation repair cannot replace authority after runtime failure wins the checkpoint race", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  client.markThreadMissing("thread-1");

  await assert.rejects(adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId,
    expectedProviderContinuationId: "thread-1",
    cwd: "/tmp/letagents-work-attempt",
    launchPolicy: spawnRequest().launchPolicy,
  }, {
    checkpointReplacement: async () => {
      client.emit({ method: "thread/status/changed", params: {
        threadId: handle.providerContinuationId, status: { type: "systemError" },
      } });
      await flush();
    },
  }), /lost exact provider authority/);
  assert.equal(handle.observedState(), "failed");
  assert.equal(handle.providerContinuationId, "thread-1", "failed repair cannot install its replacement");
});

test("Codex reuses a conversation that materializes during the grace window", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  client.markThreadMissing("thread-1", 2);
  let checkpoints = 0;

  const result = await adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId,
    expectedProviderContinuationId: "thread-1",
    cwd: "/tmp/letagents-work-attempt",
    launchPolicy: spawnRequest().launchPolicy,
  }, {
    checkpointReplacement: async () => { checkpoints += 1; },
  });

  assert.equal(result.outcome, "rematerialized");
  assert.equal(result.replacementProviderContinuationId, "thread-1");
  assert.equal(handle.providerContinuationId, "thread-1");
  assert.deepEqual(harness.sleeps, [1_000, 2_000]);
  assert.equal(checkpoints, 0);
  assert.equal(client.requests.filter((request) => request.method === "thread/start").length, 1);
});

test("Codex force-replaces a continuation that already failed after rematerialization", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const checkpointed: string[] = [];

  const result = await adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId,
    expectedProviderContinuationId: "thread-1",
    forceReplacement: true,
    cwd: "/tmp/letagents-work-attempt",
    launchPolicy: spawnRequest().launchPolicy,
  }, {
    checkpointReplacement: async (continuation) => { checkpointed.push(continuation); },
  });

  assert.equal(result.outcome, "replaced");
  assert.equal(result.replacementProviderContinuationId, "thread-1-replacement-1");
  assert.equal(handle.providerContinuationId, "thread-1-replacement-1");
  assert.deepEqual(checkpointed, ["thread-1-replacement-1"]);
  assert.equal(client.threadResumeCounts.get("thread-1") ?? 0, 0, "a disproven rematerialization is never probed again");
  assert.deepEqual(harness.sleeps, []);
});

test("Codex resumes a checkpointed replacement after a repair crash without creating another thread", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const checkpointed: string[] = [];

  const result = await adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId,
    expectedProviderContinuationId: "thread-1",
    checkpointedReplacementProviderContinuationId: "thread-checkpointed-replacement",
    cwd: "/tmp/letagents-work-attempt",
    launchPolicy: spawnRequest().launchPolicy,
  }, {
    checkpointReplacement: async (continuation) => { checkpointed.push(continuation); },
  });

  assert.equal(result.outcome, "replaced");
  assert.equal(result.replacementProviderContinuationId, "thread-checkpointed-replacement");
  assert.equal(handle.providerContinuationId, "thread-checkpointed-replacement");
  assert.deepEqual(checkpointed, ["thread-checkpointed-replacement"]);
  assert.deepEqual(harness.sleeps, []);
  assert.equal(harness.clients[0]!.requests.filter((request) => request.method === "thread/start").length, 1);
});

test("Codex room-turn recovery reattaches only the persisted exact active turn and never starts another", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  let status = "inProgress";
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-recover", status, items: [{ type: "agentMessage", phase: "final", text: "Recovered reply." }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const startsBefore = client.requests.filter((request) => request.method === "turn/start").length;
  const pending = adapter.recoverRoomTurn!(handle, { inboxItemId: "inbox-recover", providerTurnId: "turn-recover" });
  await flush();
  client.emit({ method: "turn/completed", params: { threadId: "other-thread", turnId: "turn-recover" } });
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "other-turn" } });
  await flush(); status = "completed";
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-recover" } });
  assert.deepEqual(await pending, { turnId: "turn-recover", outcome: "reply", text: "Recovered reply.", evidence: "transcript" });
  assert.equal(client.requests.filter((request) => request.method === "turn/start").length, startsBefore);
});

test("Codex room-turn recovery returns already-terminal exact output without starting a turn", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-done", status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Already durable." }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const startsBefore = client.requests.filter((request) => request.method === "turn/start").length;
  assert.deepEqual(await adapter.recoverRoomTurn!(handle, { inboxItemId: "inbox-done", providerTurnId: "turn-done" }), { turnId: "turn-done", outcome: "reply", text: "Already durable.", evidence: "transcript" });
  assert.equal(client.requests.filter((request) => request.method === "turn/start").length, startsBefore);
});

test("Codex room-turn recovery treats an already-failed turn as idle runtime evidence", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  client.emit({ method: "turn/started", params: {
    threadId: handle.providerContinuationId,
    turnId: "turn-already-failed",
    turn: { id: "turn-already-failed", status: "inProgress" },
  } });
  await flush();
  assert.equal(handle.observedState(), "working", "the recovery assertion must prove a working-to-idle transition");
  const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: {
      id: handle.providerContinuationId,
      turns: [{ id: "turn-already-failed", status: "failed" }],
    } } as T;
    return originalRequest<T>(method, params);
  };

  assert.equal((await adapter.recoverRoomTurn!(handle, {
    inboxItemId: "inbox-already-failed", providerTurnId: "turn-already-failed",
  })).outcome, "failed");
  assert.equal(handle.observedState(), "idle");
  assert.equal(harness.launches[0]?.alive, true);
  assert.deepEqual(harness.signals, []);
});

test("a runtime failure during recovery cannot be cleared by an active or terminal turn", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  let status = "inProgress";
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") {
      client.emit({ method: "thread/status/changed", params: {
        threadId: handle.providerContinuationId, status: { type: "systemError" },
      } });
      await flush();
      return { thread: {
        id: handle.providerContinuationId,
        turns: [{ id: "turn-recovery-runtime-failure", status, items: [
          { type: "agentMessage", phase: "final", text: "Recovered after runtime failure." },
        ] }],
      } } as T;
    }
    return originalRequest<T>(method, params);
  };

  const pending = adapter.recoverRoomTurn!(handle, {
    inboxItemId: "inbox-recovery-runtime-failure",
    providerTurnId: "turn-recovery-runtime-failure",
  });
  await flush();
  assert.equal(handle.observedState(), "failed");
  status = "completed";
  client.emit({ method: "turn/completed", params: {
    threadId: handle.providerContinuationId,
    turnId: "turn-recovery-runtime-failure",
    turn: { id: "turn-recovery-runtime-failure", status: "completed" },
  } });
  assert.deepEqual(await pending, {
    turnId: "turn-recovery-runtime-failure", outcome: "reply",
    text: "Recovered after runtime failure.", evidence: "transcript",
  });
  assert.equal(handle.observedState(), "failed");
});

test("Codex room-turn recovery rejects missing and unknown exact turns as ambiguous", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-unknown", status: "mystery" }] } } as T;
    return originalRequest<T>(method, params);
  };
  await assert.rejects(adapter.recoverRoomTurn!(handle, { inboxItemId: "missing", providerTurnId: "turn-missing" }), /cannot find/);
  await assert.rejects(adapter.recoverRoomTurn!(handle, { inboxItemId: "unknown", providerTurnId: "turn-unknown" }), /unknown exact turn state/);
});

test("Codex retirement detaches only its waiter so a successor recovers the same exact turn", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  let status = "inProgress";
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-retired" } } as T;
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-retired", status, items: [{ type: "agentMessage", phase: "final", text: "successor reply" }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const controller = new AbortController();
  const old = adapter.runRoomTurn!(handle, { inboxItemId: "old", actionId: "old", sourceMessage: {}, activation: {} }, {
    beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {}, detachSignal: controller.signal,
  });
  await flush(); controller.abort();
  await assert.rejects(old, /observation detached/);
  const successor = adapter.recoverRoomTurn!(handle, { inboxItemId: "successor", providerTurnId: "turn-retired" });
  await flush(); status = "completed";
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-retired" } });
  assert.deepEqual(await successor, { turnId: "turn-retired", outcome: "reply", text: "successor reply", evidence: "transcript" });
  assert.equal(handle.pid, 4100); assert.equal(handle.providerContinuationId, "thread-1");
  assert.equal(client.requests.filter((request) => request.method === "turn/interrupt").length, 0);
});

test("Codex caches a terminal racing observer detach for successor recovery", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  let status = "inProgress";
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-race", status, items: [{ type: "agentMessage", phase: "final", text: "raced" }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const controller = new AbortController();
  const old = adapter.recoverRoomTurn!(handle, { inboxItemId: "old-race", providerTurnId: "turn-race" }, { detachSignal: controller.signal });
  await flush(); controller.abort(); await assert.rejects(old, /observation detached/);
  status = "completed";
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-race" } });
  assert.deepEqual(await adapter.recoverRoomTurn!(handle, { inboxItemId: "next-race", providerTurnId: "turn-race" }), { turnId: "turn-race", outcome: "reply", text: "raced", evidence: "transcript" });
});

test("Codex supervised launch passes only its daemon generation binding to the MCP child", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  await adapter.spawn(spawnRequest({
    supervisorEntryId: "manifest_exact",
    supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact",
  }));
  assert.deepEqual(harness.launchOptions[0]?.options.env, {
    LETAGENTS_SUPERVISOR_ENTRY_ID: "manifest_exact",
    LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/daemon.sock",
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: spawnRequest().workAttemptId,
    LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "execution_exact",
    LETAGENTS_SUPERVISOR_PROVIDER: "codex",
    LETAGENTS_EXECUTION_PROFILE: "interactive_desktop",
  });
  assert.deepEqual(harness.supervisorBridgeContexts, [{
    cwd: "/tmp/letagents-work-attempt",
    context: {
      entry_id: "manifest_exact",
      room_id: "focus_37",
      work_attempt_id: spawnRequest().workAttemptId,
      execution_generation_id: "execution_exact",
    },
  }]);
});

test("Codex resumed bounded launch supplies only the exact non-secret worker route to the MCP bridge", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest({
    deliveryMode: "daemon_inbox",
    supervisorEntryId: "manifest_exact",
    supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact",
    supervisorWorkerSession: { agentSessionId: "agent_session_exact", roomCursor: "msg_1" },
  });
  const first = await adapter.spawn(request);
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();
  await new CodexProviderAdapter({ dependencies: harness.dependencies }).resume({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
  }, request);
  const expectedEnvironment = {
    LETAGENTS_SUPERVISOR_ENTRY_ID: "manifest_exact",
    LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/daemon.sock",
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: spawnRequest().workAttemptId,
    LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "execution_exact",
    LETAGENTS_SUPERVISOR_PROVIDER: "codex",
    LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
    LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
    LETAGENTS_TOKEN: "", LETAGENTS_AGENT_SESSION_BEARER: "", LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: "",
    LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: "agent_session_exact",
    LETAGENTS_SUPERVISOR_ROOM_ID: "focus_37",
    LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: "LanternSparrow",
  };
  assert.deepEqual(harness.launchOptions.map((launch) => launch.options.env), [expectedEnvironment, expectedEnvironment],
    "fresh and resumed bounded app-server launches share the credential-scrubbing marker");
  const expectedBridgeContext = {
    entry_id: "manifest_exact",
    room_id: "focus_37",
    work_attempt_id: spawnRequest().workAttemptId,
    execution_generation_id: "execution_exact",
    agent_session_id: "agent_session_exact",
    agent_display_name: "LanternSparrow",
  };
  assert.deepEqual(harness.supervisorBridgeContexts.map(({ context }) => context), [expectedBridgeContext, expectedBridgeContext]);
  for (const launch of harness.launchOptions) {
    const override = launch.options.configOverrides[0]!;
    assert.ok(override.includes('command = ' + JSON.stringify(process.execPath)));
    assert.ok(override.includes('/verified/runtime/dist/mcp/server.js'));
    for (const [name, value] of Object.entries(expectedEnvironment)) {
      assert.ok(override.includes(`${JSON.stringify(name)} = ${JSON.stringify(value)}`), `${name} crosses the MCP environment filter`);
    }
    assert.ok(override.includes('"LETAGENTS_TOKEN" = ""'));
    assert.ok(override.includes('"LETAGENTS_AGENT_SESSION_BEARER" = ""'));
    assert.ok(override.includes('"LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID" = ""'));
    assert.ok(override.includes('env_vars = []'));
    assert.ok(override.includes('default_tools_approval_mode = "writes"'), "reads need no additional prompt; unmarked and write tools still do");
    for (const name of custodialRuntimeContract.profiles.cursor_supervised_room_turn.tools.filter(name => name !== "complete_room_turn")) {
      const mode = name === "set_reply_thread" ? "approve" : "writes";
      assert.ok(override.includes(`${JSON.stringify(name)} = { approval_mode = "${mode}" }`), `${name} overrides inherited native prompt/approve policies`);
    }
    assert.ok(!override.includes("complete_room_turn"), "pinned Cursor profile excludes its completion hook for Codex");
    assert.ok(override.includes(`enabled_tools = ${JSON.stringify(custodialRuntimeContract.profiles.cursor_supervised_room_turn.tools.filter((tool) => tool !== "complete_room_turn"))}, disabled_tools = []`));
  }
  assert.doesNotMatch(JSON.stringify(harness.launchOptions), /session-secret|authorization/);
});

test("Codex bounded local launch probes and configures the same exact local tool route", async () => {
  const { letAgentsRuntimeContract } = await import(new URL("../../../../src/mcp/server/runtime-contract.ts", import.meta.url).href);
  const harness = createHarness();
  let probedRoute: string | undefined;
  harness.dependencies.readMcpRuntimeContract = async (_entryPath, apiUrl) => {
    probedRoute = apiUrl; return letAgentsRuntimeContract(apiUrl);
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox",
    supervisorEntryId: "manifest_exact", supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact",
    supervisorWorkerSession: { agentSessionId: "session_exact", roomCursor: "msg_1", apiUrl: "letagents-local://rooms" },
  }));
  assert.equal(probedRoute, "letagents-local://rooms");
  const config = harness.launchOptions[0]!.options.configOverrides!.join("\n");
  const names = letAgentsRuntimeContract(probedRoute).profiles.cursor_supervised_room_turn.tools.filter((name: string) => name !== "complete_room_turn");
  assert.ok(config.includes(`enabled_tools = ${JSON.stringify(names)}`));
  assert.ok(config.includes('"LETAGENTS_API_URL" = "letagents-local://rooms"'));
  assert.doesNotMatch(config, /register_task_close_intent|join_room|get_room_memory|complete_room_turn/);
});

test("Codex bounded launches reject missing or unsafe managed MCP tool contracts before launch", async () => {
  for (const tools of [null, ["get_board"], ["claim_task", "get_board", "read_messages", "send_message", "register_agent_session"]]) {
    const harness = createHarness();
    harness.dependencies.readMcpRuntimeContract = async () => ({ format: 1, profiles: { cursor_supervised_room_turn: { tools } } });
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    await assert.rejects(adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox",
      supervisorEntryId: "manifest_exact", supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact",
    })), /does not support Codex supervised room tools/);
    assert.equal(harness.launchOptions.length, 0);
    assert.equal(harness.supervisorBridgeContexts.length, 0);
  }
});

test("explicit custodial activation dispatches once after intent and checkpoints its exact native ID", async () => {
  for (const scenario of ["success", "recovered", "recovered_session_mismatch", "changed_session", "wrong_receipt", "active", "unknown", "lost_ack", "bad_id", "checkpoint_failure", "detached", "legacy"] as const) {
    const harness = createHarness();
    let adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const request = spawnRequest({ configurationRevision: 4,
      pollingContract: scenario === "legacy" ? undefined : "custodial_polling_v1", deliveryMode: scenario === "legacy" ? "daemon_inbox" : "mcp_polling",
      supervisorEntryId: "manifest_exact", supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact",
      supervisorWorkerSession: { agentSessionId: "agent_session_exact", roomCursor: "msg_41", apiUrl: "https://letagents.chat" },
    });
    let handle = await adapter.spawn(request);
    assert.equal(handle.custodyLaunchAgentSessionId, scenario === "legacy" ? undefined : "agent_session_exact");
    if (scenario === "recovered" || scenario === "recovered_session_mismatch") {
      adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
      const attached = await adapter.attach({ workAttemptId: handle.workAttemptId,
        providerContinuationId: handle.providerContinuationId!, providerConnection: handle.providerConnection!, launchPolicy: request.launchPolicy });
      assertProviderHandle(attached);
      handle = attached;
    }
    const client = harness.clients.at(-1)!;
    const original = client.request.bind(client);
    const events: string[] = [];
    let starts = 0;
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "thread/read") return { thread: { id: handle.providerContinuationId, status: "idle", turns:
        scenario === "unknown" ? undefined : scenario === "active" ? [{ id: "active", status: "inProgress" }] : [] } } as T;
      if (method === "turn/start") {
        starts++;
        events.push("rpc");
        const prompt = JSON.stringify(params);
        assert.match(prompt, /agent_session_exact/);
        assert.match(prompt, /msg_41/);
        assert.match(prompt, /before processing/);
        assert.doesNotMatch(prompt, /LOCAL_CODEX_ROOM_|join_code|Hard stop deadline/);
        if (scenario === "lost_ack") throw new Error("lost acknowledgement");
        return { turn: { id: scenario === "bad_id" ? "" : "native-activation" } } as T;
      }
      return original<T>(method, params);
    };
    const controller = new AbortController();
    const activate = adapter.activateCustodialPolling(handle, {
      operationId: "activation-1", roomId: request.roomId, cwd: request.cwd, agentDisplayName: "GardenPoint",
      workerSession: { agentSessionId: scenario === "changed_session" ? "session_rotated" : "agent_session_exact", roomCursor: "msg_41" },
      launchReceipt: { contract: "custodial_polling_v1", agentSessionId: scenario === "changed_session" || scenario === "recovered_session_mismatch" ? "session_rotated" : "agent_session_exact", configurationRevision: scenario === "wrong_receipt" ? 5 : 4, workAttemptId: handle.workAttemptId,
        providerContinuationId: handle.providerContinuationId!, providerConnection: handle.providerConnection! },
    }, { detachSignal: controller.signal,
      beforeNativeDispatch: async () => { events.push("intent"); if (scenario === "detached") controller.abort(); },
      checkpointTurnStarted: async id => { assert.equal(id, "native-activation"); events.push("checkpoint"); if (scenario === "checkpoint_failure") throw new Error("checkpoint failed"); },
    });
    if (scenario === "success" || scenario === "recovered") {
      assert.deepEqual(await activate, { providerTurnId: "native-activation" });
      assert.deepEqual(events, ["intent", "rpc", "checkpoint"]);
    } else await assert.rejects(activate);
    assert.equal(starts, ["success", "recovered", "lost_ack", "bad_id", "checkpoint_failure"].includes(scenario) ? 1 : 0, scenario);
    if (scenario === "success") {
      for (const status of ["inProgress", "completed", "failed", "interrupted", "cancelled", "future"] as const) {
        client.request = async <T>(method: string): Promise<T> => {
          assert.equal(method, "thread/read", "inspection never starts, resumes, or interrupts");
          return { thread: { id: handle.providerContinuationId, turns: [
            { id: "native-activation", status }, { id: "latest-unrelated", status: "completed" },
          ] } } as T;
        };
        assert.deepEqual(await adapter.inspectCustodialPollingActivation(handle, "native-activation"),
          status === "inProgress" ? { state: "active" } : status === "future" ? { state: "unknown" }
            : { state: "terminal", outcome: status === "cancelled" ? "interrupted" : status });
        assert.deepEqual(await adapter.inspectCustodialPollingActivation(handle, "missing-exact"), { state: "unknown" });
      }
      client.request = async () => { throw new Error("connection lost"); };
      assert.deepEqual(await adapter.inspectCustodialPollingActivation(handle, "native-activation"), { state: "unknown" });
    }
    harness.launches[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await flush();
  }
});

test("Codex custodial polling verifies its exact MCP runtime and leaves fresh and resumed threads idle", async () => {
  const harness = createHarness();
  const request = spawnRequest({
    pollingContract: "custodial_polling_v1", deliveryMode: "mcp_polling",
    supervisorEntryId: "manifest_exact", supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact",
    supervisorWorkerSession: { agentSessionId: "agent_session_exact", roomCursor: "msg_41", apiUrl: "https://letagents.chat" },
  });
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  assert.equal(first.observedState(), "idle");
  harness.launches[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  const second = await new CodexProviderAdapter({ dependencies: harness.dependencies }).resume({
    workAttemptId: request.workAttemptId, providerContinuationId: first.providerContinuationId!,
  }, { ...request, supervisorExecutionGenerationId: "execution_successor" });
  assert.equal(second.observedState(), "idle");
  assert.equal(second.providerContinuationId, first.providerContinuationId);
  assert.deepEqual(harness.mcpRuntimeProbes, ["/verified/runtime/dist/mcp/server.js", "/verified/runtime/dist/mcp/server.js"]);
  for (const [index, launch] of harness.launchOptions.entries()) {
    assert.equal(harness.clients[index]!.requests.some((call) => call.method === "turn/start"), false);
    const env = launch.options.env!;
    assert.equal(env.LETAGENTS_EXECUTION_PROFILE, "supervised_mcp_polling");
    assert.equal(env.LETAGENTS_SUPERVISED_BOUNDED_TURNS, "");
    assert.equal(env.LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID, "");
    assert.equal(env.LETAGENTS_TOKEN, "");
    assert.equal(env.LETAGENTS_AGENT_SESSION_BEARER, "");
    assert.equal(env.LETAGENTS_API_URL, "https://letagents.chat");
    assert.equal(env.LETAGENTS_SUPERVISOR_AGENT_SESSION_ID, "agent_session_exact");
    assert.equal(env.LETAGENTS_SUPERVISOR_ROOM_ID, request.roomId);
    assert.equal(env.LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID, index ? "execution_successor" : "execution_exact");
    assert.equal(launch.options.configOverrides.length, 1, "pin the MCP executable, custody coordinates and advertised tools together");
    const override = launch.options.configOverrides[0]!;
    assert.ok(override.startsWith("mcp_servers.letagents={ "));
    assert.ok(override.includes('default_tools_approval_mode = "writes"'));
    assert.ok(!override.includes('approval_mode = "approve"'), "polling never receives a bounded-control exemption");
    for (const name of custodialRuntimeContract.profiles.supervised_mcp_polling.tools) {
      assert.ok(override.includes(`${JSON.stringify(name)} = { approval_mode = "writes" }`));
    }
    assert.ok(override.includes(`command = ${JSON.stringify(process.execPath)}`));
    assert.ok(override.includes('args = ["/verified/runtime/dist/mcp/server.js"]'));
    assert.ok(override.includes("env_vars = [], enabled = true"));
    assert.ok(override.includes(`enabled_tools = ${JSON.stringify(custodialRuntimeContract.profiles.supervised_mcp_polling.tools)}, disabled_tools = []`));
    for (const [key, value] of Object.entries({ ...env, ELECTRON_RUN_AS_NODE: "1" })) {
      assert.ok(override.includes(`${JSON.stringify(key)} = ${JSON.stringify(value)}`), `exact MCP env ${key}`);
    }
    assert.doesNotMatch(override, /npx|interactive_desktop/);
  }
});

test("Codex custodial polling fails closed on old runtime contracts and incomplete authority before native launch", async () => {
  const request = spawnRequest({
    pollingContract: "custodial_polling_v1", deliveryMode: "mcp_polling",
    supervisorEntryId: "manifest_exact", supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact",
    supervisorWorkerSession: { agentSessionId: "agent_session_exact", roomCursor: "msg_41", apiUrl: "https://letagents.chat" },
  });
  for (const report of [
    { format: 1, profiles: { cursor_supervised_room_turn: { tools: ["complete_room_turn"] } } },
    { ...custodialRuntimeContract, format: 2 },
    { format: 1, profiles: { supervised_mcp_polling: { contract: "custodial_polling_v1", tools: ["read_messages", "send_message"] } } },
    { format: 1, profiles: { supervised_mcp_polling: { contract: "custodial_polling_v1", tools: [...custodialRuntimeContract.profiles.supervised_mcp_polling.tools, "register_agent_session"] } } },
  ]) {
    const harness = createHarness();
    harness.dependencies.readMcpRuntimeContract = async () => report;
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    await assert.rejects(adapter.preflightCustodialPolling({}), /does not support custodial_polling_v1/);
    await assert.rejects(adapter.spawn(request), /does not support custodial_polling_v1/);
    assert.deepEqual(harness.launches, []);
    assert.deepEqual(harness.signals, []);
    assert.deepEqual(harness.supervisorBridgeContexts, []);
  }
  for (const patch of [
    { deliveryMode: "daemon_inbox" as const }, { supervisorSocketPath: undefined },
    { supervisorWorkerSession: undefined },
    { supervisorWorkerSession: { ...request.supervisorWorkerSession!, apiUrl: undefined } },
    { supervisorWorkerSession: { ...request.supervisorWorkerSession!, apiUrl: "https://user:secret@example.test" } },
  ]) {
    const harness = createHarness();
    await assert.rejects(new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn({ ...request, ...patch }), /coordinates|API origin/);
    assert.deepEqual(harness.launches, []);
    assert.deepEqual(harness.mcpRuntimeProbes, []);
  }
});

test("Codex custodial polling reads the selected built executable contract without owner environment or fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-codex-contract-"));
  const entry = join(directory, "dist", "mcp", "server.js");
  const previousDev = process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL;
  const previousToken = process.env.LETAGENTS_TOKEN;
  process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL = "http://127.0.0.1:5174";
  process.env.LETAGENTS_TOKEN = "contract-probe-owner-canary";
  try {
    await mkdir(join(directory, "dist", "mcp"), { recursive: true });
    await mkdir(join(directory, "node_modules"));
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "letagents", version: LETAGENTS_MCP_RUNTIME_VERSION, type: "module" }));
    const request = spawnRequest({
      pollingContract: "custodial_polling_v1", deliveryMode: "mcp_polling", devMcpServerEntryPath: entry,
      supervisorEntryId: "manifest_exact", supervisorSocketPath: "/tmp/daemon.sock",
      supervisorExecutionGenerationId: "execution_exact",
      supervisorWorkerSession: { agentSessionId: "agent_session_exact", roomCursor: "msg_41", apiUrl: "https://letagents.chat" },
    });
    const harness = createHarness();
    const { resolveMcpRuntime: _resolve, readMcpRuntimeContract: _read, ...nativeDependencies } = harness.dependencies;
    const adapter = new CodexProviderAdapter({ dependencies: nativeDependencies });
    await writeFile(entry, `process.stdout.write(${JSON.stringify(JSON.stringify({ format: 1, profiles: {} }))});`);
    await assert.rejects(adapter.preflightCustodialPolling({ devMcpServerEntryPath: entry }), /does not support custodial_polling_v1/);
    await assert.rejects(adapter.spawn(request), /does not support custodial_polling_v1/, "a matching package version cannot replace contract proof");
    assert.equal(harness.launches.length, 0);
    await writeFile(entry, "throw new Error('contract-probe-owner-canary');");
    await assert.rejects(adapter.preflightCustodialPolling({ devMcpServerEntryPath: entry }), (error: unknown) => error instanceof Error
      && /contract could not be read/.test(error.message) && !error.message.includes("contract-probe-owner-canary"));
    await assert.rejects(adapter.spawn(request), (error: unknown) => error instanceof Error
      && /contract could not be read/.test(error.message) && !error.message.includes("contract-probe-owner-canary"));
    await writeFile(entry, [
      "if (process.argv[2] !== '--letagents-runtime-contract' || process.env.LETAGENTS_TOKEN) process.exit(2);",
      `process.stdout.write(${JSON.stringify(JSON.stringify(custodialRuntimeContract))});`,
    ].join("\n"));
    await adapter.preflightCustodialPolling({ devMcpServerEntryPath: entry });
    assert.deepEqual(harness.launches, [], "preflight never launches a provider");
    assert.deepEqual(harness.signals, []);
    assert.deepEqual(harness.supervisorBridgeContexts, []);
    const handle = await adapter.spawn(request);
    assert.equal(handle.observedState(), "idle");
    assert.equal(harness.clients[0]!.requests.some((call) => call.method === "turn/start"), false);
    assert.ok(harness.launchOptions[0]!.options.configOverrides[0]!.includes(JSON.stringify(await realpath(entry))), "launch uses the resolver's canonical executable");
    await writeFile(entry, [
      "if (process.env.LETAGENTS_API_URL !== 'letagents-local://rooms' || process.env.LETAGENTS_TOKEN || process.env.LETAGENTS_SUPERVISOR_ENTRY_ID) process.exit(2);",
      `process.stdout.write(${JSON.stringify(JSON.stringify(custodialRuntimeContract))});`,
    ].join("\n"));
    const localHarness = createHarness();
    const { resolveMcpRuntime: _localResolve, readMcpRuntimeContract: _localRead, ...localDependencies } = localHarness.dependencies;
    const localAdapter = new CodexProviderAdapter({ dependencies: localDependencies });
    await localAdapter.spawn({ ...request, deliveryMode: "daemon_inbox", pollingContract: undefined,
      supervisorWorkerSession: { ...request.supervisorWorkerSession!, apiUrl: "letagents-local://rooms" },
    });
    assert.equal(localHarness.launches.length, 1, "credential-free contract subprocess receives the same local route as native MCP");
  } finally {
    if (previousDev === undefined) delete process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL;
    else process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL = previousDev;
    if (previousToken === undefined) delete process.env.LETAGENTS_TOKEN;
    else process.env.LETAGENTS_TOKEN = previousToken;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex supervised launch fails closed before app-server start when bridge coordinates are partial", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(
    adapter.spawn(spawnRequest({ supervisorEntryId: "manifest_exact" })),
    /coordinates are incomplete/,
  );
  assert.deepEqual(harness.supervisorBridgeContexts, []);
  assert.deepEqual(harness.launchOptions, []);
});

test("Codex supervisor bridge context is owner-only, atomic, and contains no worker credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-codex-supervisor-context-"));
  try {
    const base = {
      entry_id: "manifest_exact",
      room_id: "focus_37",
      work_attempt_id: spawnRequest().workAttemptId,
    };
    await writeCodexSupervisorBridgeContext(root, { ...base, execution_generation_id: "generation_first" });
    await writeCodexSupervisorBridgeContext(root, { ...base, execution_generation_id: "generation_resumed" });

    const path = join(root, CODEX_SUPERVISOR_BRIDGE_CONTEXT_FILE);
    const encoded = await readFile(path, "utf8");
    assert.equal(JSON.parse(encoded).execution_generation_id, "generation_resumed");
    assert.doesNotMatch(encoded, /session_token|session-secret|authorization/i);
    assert.doesNotMatch(encoded, /socket_path/, "repo-controlled context cannot select the credential transport");
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), [CODEX_SUPERVISOR_BRIDGE_CONTEXT_FILE], "atomic rewrite leaves no temporary context");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex dev MCP entry override adds exact command/args/cwd overrides when devMcpServerEntryPath is supplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-codex-dev-mcp-entry-"));
  try {
    const quotedDirectory = join(root, 'path with spaces and "quotes"');
    await mkdir(quotedDirectory);
    const entryPath = join(quotedDirectory, "server.js");
    await writeFile(entryPath, "// stub");
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    await adapter.spawn(spawnRequest({ devMcpServerEntryPath: entryPath }));
    assert.deepEqual(harness.launchOptions[0]?.options.configOverrides, [
      ...codexMcpWorkplaceConfigOverrides(spawnRequest().cwd),
      `mcp_servers.letagents.command=${JSON.stringify("node")}`,
      `mcp_servers.letagents.args=${JSON.stringify([entryPath])}`,
    ]);
    assert.equal(
      harness.launchOptions[0]?.options.configOverrides.some((value) =>
        /token|authorization|bearer|password/i.test(value),
      ),
      false,
      "dev entry override must not inject any credential",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex dev MCP entry override fails closed for relative, missing, and non-file inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-codex-dev-mcp-invalid-"));
  try {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

    await assert.rejects(
      adapter.spawn(spawnRequest({ devMcpServerEntryPath: "relative/path/server.js" })),
      /must be absolute/,
      "relative path must fail closed",
    );
    assert.deepEqual(harness.launchOptions, [], "no app-server launch on relative path");

    await assert.rejects(
      adapter.spawn(spawnRequest({ devMcpServerEntryPath: join(root, "nonexistent.js") })),
      /does not exist/,
      "missing file must fail closed",
    );

    const dirPath = join(root, "subdir");
    await mkdir(dirPath);
    await assert.rejects(
      adapter.spawn(spawnRequest({ devMcpServerEntryPath: dirPath })),
      /must be a regular built file/,
      "directory must fail closed",
    );

    const symlinkTarget = join(root, "target.js");
    await writeFile(symlinkTarget, "// target");
    const symlinkPath = join(root, "link.js");
    await symlink(symlinkTarget, symlinkPath);
    await assert.rejects(
      adapter.spawn(spawnRequest({ devMcpServerEntryPath: symlinkPath })),
      /must be a regular built file/,
      "symlink must fail closed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex dev MCP entry is absent by default and does not affect the baseline cwd-only override", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  await adapter.spawn(spawnRequest());
  assert.deepEqual(
    harness.launchOptions[0]?.options.configOverrides,
    codexMcpWorkplaceConfigOverrides(spawnRequest().cwd),
    "baseline spawn must produce only the cwd override",
  );
});

test("Codex resume reopens the exact native thread and preserves the same launch policy", async () => {
  const harness = createHarness();
  const activity: ProviderActivityEvent[] = [];
  const adapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    activitySink: (event) => activity.push(event),
  });
  const request = spawnRequest({
    supervisorWorkerSession: {
      agentSessionId: "agent_session_exact",
      roomCursor: "msg_2819",
    },
  });
  const first = await adapter.spawn(request);
  const continuation = first.providerContinuationId!;
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();

  const resumedAdapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    activitySink: (event) => activity.push(event),
  });
  assert.equal(resumedAdapter.capabilities().resume, true);
  const resumed = await resumedAdapter.resume({
    workAttemptId: request.workAttemptId,
    providerContinuationId: continuation,
  }, request);

  assert.equal(resumed.providerContinuationId, continuation);
  const resume = harness.clients[1]!.requests.find((entry) =>
    entry.method === "thread/resume"
      && (entry.params as { threadId?: string }).threadId === continuation);
  assert.ok(resume, "expected exact durable continuation resume request");
  const params = resume.params as Record<string, unknown>;
  assert.equal(params.threadId, continuation);
  assert.equal(params.sandbox, "danger-full-access");
  assert.equal(
    harness.clients[1]!.requests.filter((entry) => entry.method === "thread/start").length,
    0,
    "resume must not mint a fresh provider thread",
  );
  const readIndex = harness.clients[1]!.requests.findIndex((entry) => entry.method === "thread/read");
  const turnIndex = harness.clients[1]!.requests.findIndex((entry) => entry.method === "turn/start");
  assert.ok(readIndex >= 0 && readIndex < turnIndex, "prior transcript is read before the next turn");
  const turn = harness.clients[1]!.requests[turnIndex]!.params as { input: Array<{ text: string }> };
  assert.match(turn.input[0]!.text, /agent_session_exact/);
  assert.match(turn.input[0]!.text, /msg_2819/);
  assert.match(turn.input[0]!.text, /Do not call register_agent_session/);
  assert.doesNotMatch(turn.input[0]!.text, /Suggested codename|Call set_agent_name/);
  assert.ok(activity.some((event) =>
    event.providerContinuationId === continuation
      && event.source === "transcript_tail"
      && event.summary === "Transcript checkpoint persisted."));
});

test("reattachment subscribes the exact thread and observes native approvals without replay or policy overrides", async () => {
  const harness = createHarness();
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const first = await firstAdapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const createRpcClient = harness.dependencies.createRpcClient;
  harness.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    const request = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown) => {
      const result = await request<T>(method, params);
      if (method === "thread/resume") client.askPermission(approvalParams());
      return result;
    };
    return client;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await adapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
  assertProviderHandle(attached);
  const client = harness.clients[1]!;
  assert.deepEqual(requestByMethod(client, "thread/resume").params, { threadId: first.providerContinuationId });
  assert.equal(client.requests.some(request => request.method === "turn/start" || request.method === "thread/start"), false);
  const events: CodexPermissionObservation[] = [];
  const controller = new AbortController();
  const observation = adapter.observePermissions(attached, event => events.push(event), controller.signal);
  await flush();
  assert.ok(events.some(event => event.type === "snapshot" && event.requests.length === 1));
  assert.equal(client.permissionResponses.length, 0);
  controller.abort();
  await observation;
});

test("reattachment reconstructs a turn that completed before subscription without a notification", async () => {
  const harness = createHarness();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies })
    .spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const createRpcClient = harness.dependencies.createRpcClient;
  harness.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    client.turnStatus = "inProgress";
    const request = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown) => {
      if (method === "thread/resume") client.turnStatus = "completed";
      return request<T>(method, params);
    };
    return client;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await adapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
  assertProviderHandle(attached);
  const observations: NativeExecutionObservation[] = [];
  const subscription = adapter.onExecution(attached, event => observations.push(event));
  assert.ok(observations.some(event => event.fact.domain === "turn"
    && event.fact.state === "terminal" && event.fact.turnOutcome === "completed"));
  assert.equal(attached.observedState(), "idle", "configuration restart admission must agree with the exact terminal snapshot");
  subscription.dispose();
});

test("observation attachment does not cold-resume an unloaded thread with process defaults", async () => {
  const harness = createHarness();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies })
    .spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const createRpcClient = harness.dependencies.createRpcClient;
  harness.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    const request = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown) => {
      const result = await request<T>(method, params);
      if (method === "thread/read") (result as { thread: { status: unknown } }).thread.status = { type: "notLoaded" };
      return result;
    };
    return client;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await adapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
  assertProviderHandle(attached);
  assert.equal(harness.clients[1]!.requests.some(request => request.method === "thread/resume"), false);
});

test("empty reattachment subscribes after first-turn checkpoint and never replays on subscription failure", async () => {
  for (const { failSubscription, status } of [
    { failSubscription: false, status: "completed" },
    { failSubscription: false, status: "cancelled" },
    { failSubscription: false, status: "STOPPED" },
    { failSubscription: true, status: "completed" },
  ]) {
    const harness = createHarness();
    const first = await new CodexProviderAdapter({ dependencies: harness.dependencies })
      .spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const createRpcClient = harness.dependencies.createRpcClient;
    let materialized = false;
    let checkpointed = false;
    let subscriptionFailed = false;
    harness.dependencies.createRpcClient = (serverUrl, notify) => {
      const client = createRpcClient(serverUrl, notify) as FakeRpc;
      const request = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown) => {
        if (method === "thread/read" && !materialized && (params as { includeTurns?: boolean }).includeTurns) {
          throw new Error(`thread ${first.providerContinuationId} is not materialized yet; includeTurns is unavailable before first user message`);
        }
        if (method === "turn/start") { materialized = true; client.turnStatus = "inProgress"; }
        if (method === "thread/resume") {
          assert.ok(materialized, "resume cannot read history before the first turn");
          assert.ok(checkpointed, "native acknowledgement is durable before subscription can fail");
          if (failSubscription && !subscriptionFailed) {
            subscriptionFailed = true;
            throw new Error("subscription unavailable");
          }
          client.askPermission(approvalParams());
          // Fast completion before subscription has no corresponding notification.
          client.turnStatus = status;
        }
        return request<T>(method, params);
      };
      return client;
    };
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const attached = await adapter.attach({ workAttemptId: first.workAttemptId,
      providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection,
      launchPolicy: { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } } });
    assertProviderHandle(attached);
    const result = adapter.runRoomTurn(attached, { inboxItemId: "first-turn", actionId: "first-turn", sourceMessage: {}, activation: {} }, {
      checkpointTurnStarted: async () => { checkpointed = true; },
    });
    if (failSubscription) {
      await assert.rejects(result, /subscription unavailable/);
      await adapter.recoverRoomTurn(attached, { inboxItemId: "first-turn", providerTurnId: `turn-${first.providerContinuationId}` });
    }
    else if (status !== "completed") assert.equal((await result).outcome, "interrupted");
    else await result;
    const client = harness.clients[1]!;
    assert.equal(client.requests.filter(request => request.method === "turn/start").length, 1);
    assert.equal(client.permissionResponses.length, 0);
    const policy = requestByMethod(client, "turn/start").params as Record<string, unknown>;
    assert.deepEqual(policy.sandboxPolicy, { type: "readOnly", networkAccess: false });
    assert.equal(client.listPendingRequests().length, 1);
  }
});

test("fresh adapter reattaches the durable app-server endpoint without launching a duplicate child", async () => {
  const harness = createHarness();
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await firstAdapter.spawn(request);
  assert.ok(first.providerConnection);

  const createRpcClient = harness.dependencies.createRpcClient;
  harness.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    client.turnStatus = { status: "failed" };
    const request = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown) => {
      const result = await request<T>(method, params);
      if (method === "thread/read") {
        const thread = (result as { thread?: { turns?: Array<Record<string, unknown>> } }).thread;
        const latestTurn = thread?.turns?.at(-1);
        if (latestTurn) latestTurn.items = [{ type: "agentMessage", text: "x".repeat(40_000) }];
      }
      return result;
    };
    return client;
  };
  const stream: ProviderStreamEvent[] = [];
  const freshAdapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => stream.push(event),
  });
  const attached = await freshAdapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });
  assertProviderHandle(attached);
  const observations: NativeExecutionObservation[] = [];
  const subscription = freshAdapter.onExecution(attached, (event) => observations.push(event));

  assert.equal(attached.providerContinuationId, first.providerContinuationId);
  assert.equal(attached.pid, first.pid);
  assert.equal(harness.launches.length, 1, "reattach must not create a second native writer");
  assert.equal(
    harness.clients[1]!.requests.some((entry) => entry.method === "thread/start" || entry.method === "turn/start"),
    false,
  );
  const snapshot = stream.find((event) => event.method === "thread/read");
  assert.ok(snapshot, "reattach emits one normalized transcript snapshot");
  assert.equal((snapshot.payload as { thread?: unknown }).thread, undefined,
    "attach and live transcript snapshots share the same closed payload shape");
  assert.deepEqual((snapshot.payload as { latestTurn?: { status?: unknown } }).latestTurn?.status, { status: "failed" });
  assert.equal(snapshot.payloadTruncated, false,
    "oversized transcript items cannot erase the closed lifecycle metadata");
  assert.equal(providerStreamLifecycle(snapshot), "terminal",
    "the exact reattach payload keeps failed-turn evidence scoped to the native turn");
  assert.equal(snapshot.nativeLifecyclePhase, undefined,
    "reattach reconstruction does not feed the legacy lifecycle projection");
  const terminal = observations.find((event) => event.fact.domain === "turn");
  assert.ok(terminal?.fact.domain === "turn");
  assert.deepEqual(terminal.fact, {
    providerContinuationId: first.providerContinuationId,
    providerTurnId: `turn-${first.providerContinuationId}`,
    domain: "turn",
    kind: "state_changed",
    state: "terminal",
    turnOutcome: "failed",
    sideEffects: "none",
  });
  assert.equal(terminal.nativeProcessPid, first.providerConnection.pid);
  assert.equal(terminal.nativeProcessIdentity, first.providerConnection.processIdentity);
  assert.equal(observations[0]?.fact.domain, "runtime",
    "late capture receives the reconstructed runtime boundary before the turn");
  assert.equal(await freshAdapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  }), attached);
  subscription.dispose();
});

test("fresh Codex attach reconstructs only a recognized latest native turn", async (t) => {
  const cases = [
    { name: "active", status: "inProgress", expected: { state: "active" } },
    { name: "completed", status: "completed", expected: { state: "terminal", turnOutcome: "completed" } },
    { name: "interrupted", status: "cancelled", expected: { state: "terminal", turnOutcome: "interrupted" } },
    { name: "unknown", status: "futureStatus", expected: null },
  ] as const;
  for (const entry of cases) await t.test(entry.name, async () => {
    const harness = createHarness();
    const request = spawnRequest();
    const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
    assert.ok(first.providerConnection);
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (serverUrl, notify) => {
      const client = createRpcClient(serverUrl, notify) as FakeRpc;
      client.turnStatus = entry.status;
      const request = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        const result = await request<T>(method, params);
        if (method === "thread/read" && (params as { includeTurns?: boolean } | undefined)?.includeTurns === true) {
          const turns = (result as { thread?: { turns?: Array<Record<string, unknown>> } }).thread?.turns;
          if (turns) turns.unshift({ id: "historical-turn", status: "completed" });
        }
        return result;
      };
      return client;
    };
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const attached = await adapter.attach({
      workAttemptId: request.workAttemptId,
      providerContinuationId: first.providerContinuationId!,
      providerConnection: first.providerConnection,
    });
    assertProviderHandle(attached);
    const observations: NativeExecutionObservation[] = [];
    const subscription = adapter.onExecution(attached, (event) => observations.push(event));
    const turns = observations.filter((event) => event.fact.domain === "turn");
    assert.equal(turns.length, entry.expected === null ? 0 : 1,
      "reattach reconstructs at most the single latest native turn");
    const turn = turns[0];
    if (entry.expected === null) assert.equal(turn, undefined);
    else {
      assert.ok(turn?.fact.domain === "turn");
      assert.equal(turn.fact.state, entry.expected.state);
      assert.equal("turnOutcome" in entry.expected ? turn.fact.turnOutcome : undefined,
        "turnOutcome" in entry.expected ? entry.expected.turnOutcome : undefined);
      assert.equal(turn.fact.providerContinuationId, first.providerContinuationId);
      assert.equal(turn.fact.providerTurnId, `turn-${first.providerContinuationId}`);
    }
    assert.equal(observations.filter((event) => event.fact.domain === "runtime").length, 1);
    assert.equal(observations.some((event) => event.fact.domain === "turn"
      && event.fact.providerTurnId === "historical-turn"), false);
    assert.equal(subscription.position().latestSequence, 2,
      "recognized turns retain one fact while unreadable latest state leaves an explicit source gap");
    assert.equal(harness.launches.length, 1);
    assert.equal(harness.clients[1]!.requests.some((request) =>
      request.method === "thread/start" || request.method === "turn/start" || request.method === "turn/interrupt"), false);
    subscription.dispose();
  });
});

test("fresh Codex attach never orders a snapshot against queued lifecycle evidence", async (t) => {
  const cases: Array<{ name: string; expectedActive: boolean; expectedTerminal: boolean;
    expectedLatestSequence: number;
    emit(client: FakeRpc, threadId: string, turnId: string): void }> = [
    { name: "typed terminal", expectedActive: false, expectedTerminal: true, expectedLatestSequence: 3,
      emit: (client: FakeRpc, threadId: string, turnId: string) => client.emit({ method: "turn/completed",
        params: { threadId, turnId, turn: { id: turnId, status: "completed" } } }) },
    { name: "unreadable terminal", expectedActive: false, expectedTerminal: false, expectedLatestSequence: 4,
      emit: (client: FakeRpc, threadId: string, turnId: string) => client.emit({ method: "turn/completed",
        params: { threadId, turnId } }) },
    { name: "malformed terminal identity", expectedActive: false, expectedTerminal: false, expectedLatestSequence: 4,
      emit: (client: FakeRpc, threadId: string) => client.emit({ method: "turn/completed",
        params: { threadId } }) },
    { name: "mismatched terminal turn identities", expectedActive: false, expectedTerminal: false,
      expectedLatestSequence: 4,
      emit: (client: FakeRpc, threadId: string, turnId: string) => client.emit({ method: "turn/completed",
        params: { threadId, turnId, turn: { id: `${turnId}-other`, status: "completed" } } }) },
    { name: "terminal after queued start", expectedActive: true, expectedTerminal: true, expectedLatestSequence: 5,
      emit: (client: FakeRpc, threadId: string, turnId: string) => {
        client.emit({ method: "turn/started", params: { threadId, turnId, turn: { id: turnId, status: "inProgress" } } });
        client.emit({ method: "turn/cancelled", params: { threadId, turnId } });
      } },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const harness = createHarness();
    const request = spawnRequest();
    const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
    assert.ok(first.providerConnection);
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (serverUrl, notify) => {
      const client = createRpcClient(serverUrl, notify) as FakeRpc;
      client.turnStatus = "inProgress";
      const read = client.request.bind(client);
      let queued = false;
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        const result = await read<T>(method, params);
        if (!queued && method === "thread/read"
          && (params as { includeTurns?: boolean } | undefined)?.includeTurns === true) {
          queued = true;
          const turnId = `turn-${first.providerContinuationId}`;
          entry.emit(client, first.providerContinuationId!, turnId);
        }
        return result;
      };
      return client;
    };
    const stream: ProviderStreamEvent[] = [];
    const adapter = new CodexProviderAdapter({
      dependencies: harness.dependencies,
      streamSink: event => stream.push(event),
    });
    const attached = await adapter.attach({
      workAttemptId: request.workAttemptId,
      providerContinuationId: first.providerContinuationId!,
      providerConnection: first.providerConnection,
    });
    assertProviderHandle(attached);
    const observations: NativeExecutionObservation[] = [];
    const subscription = adapter.onExecution(attached, event => observations.push(event));
    const activeTurns = observations.filter(event => event.fact.domain === "turn" && event.fact.state === "active");
    assert.equal(activeTurns.length, entry.expectedActive ? 1 : 0,
      "only an exact queued start may produce active state; the ambiguous snapshot never does");
    if (entry.expectedActive) assert.equal(activeTurns[0]?.sequence, 4,
      "the queued start remains behind the explicit ambiguity gap");
    assert.equal(observations.filter(event => event.fact.domain === "turn").length,
      (entry.expectedActive ? 1 : 0) + (entry.expectedTerminal ? 1 : 0));
    assert.equal(subscription.position().latestSequence, entry.expectedLatestSequence);
    assert.equal(observations.some(event => event.sequence === 2), false,
      "snapshot/notification coexistence consumes an unavailable source position");
    assert.equal(stream.filter(event => /^turn\/(?:completed|cancelled)$/.test(event.method)).length, 1,
      "the raw sink receives the queued terminal exactly once, even without typed correlation");
    assert.equal(stream.some(event => event.nativeEventId !== undefined), false,
      "notifications consumed before the production raw listener exists are not correlated into shadow comparison");
    assert.equal(observations.some(event => event.fact.nativeEventId !== undefined), false);
    assert.equal(stream.find(event => event.method === "thread/read")?.nativeEventId, undefined,
      "the stale snapshot is not correlated as a lifecycle checkpoint");
    subscription.dispose();
  });
});

test("Codex attach gaps a queued start that may precede a terminal snapshot", async () => {
  const harness = createHarness();
  const request = spawnRequest();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  assert.ok(first.providerConnection);
  const createRpcClient = harness.dependencies.createRpcClient;
  harness.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    client.turnStatus = "completed";
    const read = client.request.bind(client);
    let queued = false;
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (!queued && method === "thread/read"
        && (params as { includeTurns?: boolean } | undefined)?.includeTurns === true) {
        queued = true;
        const turnId = `turn-${first.providerContinuationId}`;
        client.emit({ method: "turn/started", params: {
          threadId: first.providerContinuationId,
          turnId,
          turn: { id: turnId, status: "inProgress" },
        } });
      }
      return read<T>(method, params);
    };
    return client;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await adapter.attach({ workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
  assertProviderHandle(attached);
  const observations: NativeExecutionObservation[] = [];
  const subscription = adapter.onExecution(attached, event => observations.push(event));
  assert.deepEqual(observations.map(event => event.sequence), [1, 3, 4],
    "the queued start remains retained but cannot erase the ambiguous response boundary");
  assert.deepEqual(subscription.position(), { firstRetainedSequence: 1, latestSequence: 4 });
  assert.deepEqual(observations.flatMap(event => event.fact.domain === "turn" ? [event.fact.state] : []), ["active"]);
  assert.equal(attached.observedState(), "working", "ambiguous queued activity must not admit an idle restart");
  subscription.dispose();
});

test("queued lifecycle cannot erase unreadable or contradictory Codex attach evidence", async (t) => {
  await t.test("unknown snapshot plus typed start", async () => {
    const harness = createHarness();
    const request = spawnRequest();
    const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
    assert.ok(first.providerConnection);
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (serverUrl, notify) => {
      const client = createRpcClient(serverUrl, notify) as FakeRpc;
      client.turnStatus = "futureStatus";
      const read = client.request.bind(client);
      let queued = false;
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        const result = await read<T>(method, params);
        if (!queued && method === "thread/read" && (params as { includeTurns?: boolean }).includeTurns === true) {
          queued = true;
          const turnId = `turn-${first.providerContinuationId}`;
          client.emit({ method: "turn/started", params: {
            threadId: first.providerContinuationId,
            turnId,
            turn: { id: turnId, status: "inProgress" },
          } });
        }
        return result;
      };
      return client;
    };
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const attached = await adapter.attach({ workAttemptId: request.workAttemptId,
      providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
    assertProviderHandle(attached);
    const observations: NativeExecutionObservation[] = [];
    const subscription = adapter.onExecution(attached, event => observations.push(event));
    assert.deepEqual(observations.map(event => event.sequence), [1, 3, 4],
      "the queued typed facts remain behind the unreadable snapshot gap");
    assert.deepEqual(subscription.position(), { firstRetainedSequence: 1, latestSequence: 4 });
    subscription.dispose();
  });

  await t.test("explicit empty fallback plus unreadable terminal", async () => {
    const harness = createHarness({ threadReadUnmaterialized: true });
    const request = spawnRequest({ deliveryMode: "daemon_inbox" });
    const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
    assert.ok(first.providerConnection);
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (serverUrl, notify) => {
      const client = createRpcClient(serverUrl, notify) as FakeRpc;
      const read = client.request.bind(client);
      let queued = false;
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        try { return await read<T>(method, params); }
        catch (error) {
          if (!queued && method === "thread/read" && (params as { includeTurns?: boolean }).includeTurns === true) {
            queued = true;
            client.emit({ method: "turn/completed", params: {
              threadId: first.providerContinuationId,
              turnId: `turn-${first.providerContinuationId}`,
            } });
          }
          throw error;
        }
      };
      return client;
    };
    const stream: ProviderStreamEvent[] = [];
    const adapter = new CodexProviderAdapter({
      dependencies: harness.dependencies,
      streamSink: event => stream.push(event),
    });
    const attached = await adapter.attach({ workAttemptId: request.workAttemptId,
      providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
    assertProviderHandle(attached);
    const observations: NativeExecutionObservation[] = [];
    const subscription = adapter.onExecution(attached, event => observations.push(event));
    assert.deepEqual(observations.map(event => event.sequence), [1, 4]);
    assert.deepEqual(subscription.position(), { firstRetainedSequence: 1, latestSequence: 4 },
      "both the malformed terminal and its contradiction with the empty fallback remain visible as gaps");
    assert.equal(stream.filter(event => event.method === "turn/completed").length, 1);
    subscription.dispose();
  });
});

test("cached Codex attach requires the exact continuation and native connection identity", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const handle = await adapter.spawn(request);
  assert.ok(handle.providerConnection?.kind === "codex_app_server");
  const exactRef = {
    workAttemptId: request.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection,
  };

  assert.equal(await adapter.attach(exactRef), handle);
  assert.equal(await adapter.attach({ ...exactRef, providerContinuationId: "cross-wired-thread" }), null);
  assert.equal(await adapter.attach({ ...exactRef, providerConnection: null }), null);

  const mismatchedConnections: ProviderConnectionRef[] = [
    { ...handle.providerConnection, url: "ws://127.0.0.1:9999" },
    { ...handle.providerConnection, url: "" },
    { ...handle.providerConnection, pid: handle.providerConnection.pid! + 1 },
    { ...handle.providerConnection, pid: null },
    { ...handle.providerConnection, processIdentity: "another-process-birth" },
    { ...handle.providerConnection, processIdentity: null },
    { kind: "claude_cli", pid: handle.providerConnection.pid, processIdentity: handle.providerConnection.processIdentity },
  ];
  for (const providerConnection of mismatchedConnections) {
    assert.equal(await adapter.attach({ ...exactRef, providerConnection }), null);
  }
  assert.equal(harness.launches.length, 1);
  assert.equal(harness.clients.length, 1, "rejected cached refs never contact or launch another endpoint");
});

test("fresh adapter reattaches when only the MCP workplace status probe times out", async () => {
  const harness = createHarness({ workplaceProbeTimesOut: true });
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await firstAdapter.spawn(request);
  assert.ok(first.providerConnection);

  const attached = await new CodexProviderAdapter({ dependencies: harness.dependencies }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });

  assertProviderHandle(attached);
  assert.equal(attached.providerContinuationId, first.providerContinuationId);
  assert.equal(attached.pid, first.pid);
  assert.equal(harness.launches.length, 1);
});

test("reattached RPC disconnect fences the exact child and waits for verified exit", async () => {
  const harness = createHarness();
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await firstAdapter.spawn(request);
  const freshAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await freshAdapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });
  assertProviderHandle(attached);
  const terminals: ProviderTerminalPayload[] = [];
  freshAdapter.onExit(attached, (terminal) => terminals.push(terminal));

  assert.equal(harness.dependencies.getProcessIdentity(4100), "fake-process-4100-birth-1");
  harness.clients[1]!.disconnect();
  await flush();

  assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }]);
  assert.equal(harness.launches[0]?.alive, true);
  assert.equal(terminals.length, 0, "RPC loss alone cannot make a live writer restartable");
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
  await flush();

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.terminalCause, "crashed");
  assert.equal(attached.observedState(), "failed");
});

test("unverifiable process identity keeps RPC loss ambiguous until actual exit", async () => {
  const harness = createHarness();
  const request = spawnRequest();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  const freshAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await freshAdapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });
  assertProviderHandle(attached);
  const terminals: ProviderTerminalPayload[] = [];
  freshAdapter.onExit(attached, (terminal) => terminals.push(terminal));

  harness.setIdentityObservable(false);
  harness.clients[1]!.disconnect();
  await flush();
  assert.deepEqual(harness.signals, [], "an unverifiable pid must not be signalled");
  assert.equal(terminals.length, 0, "unverifiable liveness must remain restart-blocking");

  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
  await flush();
  assert.equal(terminals.length, 1, "the actual child-exit observation remains authoritative");
});

test("pid-less durable endpoint stays ambiguous even when exact thread RPC succeeds", async () => {
  const healthy = createHarness();
  const request = spawnRequest();
  const first = await new CodexProviderAdapter({ dependencies: healthy.dependencies }).spawn(request);
  const pidlessConnection = { ...first.providerConnection!, pid: null };
  await assert.rejects(new CodexProviderAdapter({ dependencies: healthy.dependencies }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: pidlessConnection,
  }), /attach is ambiguous; refusing to launch a second writer/);
  assert.equal(healthy.launches.length, 1);

  const unavailable = createHarness({ threadReadFails: true });
  const unavailableFirst = await new CodexProviderAdapter({
    dependencies: unavailable.dependencies,
  }).spawn(request);
  await assert.rejects(new CodexProviderAdapter({
    dependencies: unavailable.dependencies,
  }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: unavailableFirst.providerContinuationId!,
    providerConnection: { ...unavailableFirst.providerConnection!, pid: null },
  }), /attach is ambiguous; refusing to launch a second writer/);
  assert.equal(unavailable.launches.length, 1);
});

test("recycled pid terminalizes the recorded writer without touching the replacement process", async () => {
  const harness = createHarness();
  const request = spawnRequest();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  harness.launches[0]!.processIdentity = "fake-process-4100-birth-2";

  const attached = await new CodexProviderAdapter({ dependencies: harness.dependencies }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });
  assert.ok(attached && "state" in attached);
  assert.equal(attached.state, "terminal");
  assert.equal(attached.terminal.terminalCause, "crashed");
  assert.equal(harness.launches.length, 1);
  assert.equal(harness.clients.length, 1, "a recycled pid is rejected before endpoint contact");
  assert.deepEqual(harness.signals, [], "the replacement process must not be signalled");
});

test("fresh attach fences an unverifiable live app-server instead of allowing a duplicate writer", async () => {
  const harness = createHarness({ threadReadFails: true });
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await firstAdapter.spawn(request);
  const freshAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

  await assert.rejects(freshAdapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  }), /attach is ambiguous; refusing to launch a second writer/);
  assert.equal(harness.launches.length, 1);
});

test("fresh attach proves an empty unmaterialized daemon-inbox thread without launching a second writer", async () => {
  const harness = createHarness({ threadReadUnmaterialized: true });
  const request = spawnRequest({ deliveryMode: "daemon_inbox" });
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);

  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await adapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });

  assertProviderHandle(attached);
  const observations: NativeExecutionObservation[] = [];
  const subscription = adapter.onExecution(attached, event => observations.push(event));
  assert.equal(attached.providerContinuationId, first.providerContinuationId);
  assert.equal(harness.launches.length, 1, "the verified existing writer must be retained");
  assert.equal(harness.clients[1]!.requests.some(entry => entry.method === "thread/resume"), false,
    "an empty thread may have no stored history for resume; preserve metadata-only attachment");
  assert.deepEqual(
    harness.clients[1]!.requests
      .filter((entry) => entry.method === "thread/read")
      .map((entry) => (entry.params as { includeTurns?: boolean }).includeTurns),
    [true, false],
    "metadata-only proof is used only after the exact empty-thread response",
  );
  assert.deepEqual(observations.map(event => event.fact.domain), ["runtime"]);
  assert.deepEqual(subscription.position(), { firstRetainedSequence: 1, latestSequence: 1 },
    "the explicit unmaterialized-empty proof is gap-free, not an unreadable snapshot");
  assert.deepEqual(harness.signals, []);
  subscription.dispose();
});

test("a reattached thread with no turn yet is idle, so it stops reporting work it is not doing", async () => {
  // Shapes the attach read can take for a thread that has never run a turn.
  const cases: Array<{ name: string; read: (threadId: string, includeTurns: boolean | undefined) => unknown; expected: "idle" | "working" }> = [
    { name: "unmaterialized daemon-inbox thread", expected: "idle", read: (threadId, includeTurns) => {
      if (includeTurns !== false) throw new Error(`thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`);
      return { thread: { id: threadId, status: { type: "idle" } } };
    } },
    { name: "materialized thread without turns", expected: "idle",
      read: (threadId) => ({ thread: { id: threadId, status: { type: "idle" }, turns: [] } }) },
    { name: "thread that still reports itself active", expected: "working", read: (threadId, includeTurns) => {
      if (includeTurns !== false) throw new Error(`thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`);
      return { thread: { id: threadId, status: { type: "active" } } };
    } },
    { name: "thread not loaded in the app-server", expected: "idle",
      read: (threadId) => ({ thread: { id: threadId, status: { type: "notLoaded" }, turns: [] } }) },
    { name: "thread in a system error", expected: "idle",
      read: (threadId) => ({ thread: { id: threadId, status: { type: "systemError" }, turns: [] } }) },
  ];
  for (const testCase of cases) {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const first = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (serverUrl, notify) => {
      const client = createRpcClient(serverUrl, notify) as FakeRpc;
      const request = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        if (method !== "thread/read") return request<T>(method, params);
        client.requests.push({ method, params });
        const input = params as { threadId: string; includeTurns?: boolean };
        return testCase.read(input.threadId, input.includeTurns) as T;
      };
      return client;
    };
    const attached = await new CodexProviderAdapter({ dependencies: harness.dependencies }).attach({
      workAttemptId: first.workAttemptId,
      providerContinuationId: first.providerContinuationId!,
      providerConnection: first.providerConnection,
    });
    assertProviderHandle(attached);
    assert.equal(attached.observedState(), testCase.expected, testCase.name);
    assert.equal(harness.launches.length, 1, `${testCase.name}: the existing writer is kept`);
  }
});

test("fresh and repaired threads retain empty-thread attachment when native default history is unsupported", async () => {
  for (const repair of [false, true]) {
    const harness = createHarness();
    const historyModes = new Map<string, unknown>();
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (serverUrl, notify) => {
      const client = createRpcClient(serverUrl, notify) as FakeRpc;
      const request = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        const input = params as { threadId?: string; historyMode?: string; includeTurns?: boolean };
        if (method === "thread/read") {
          client.requests.push({ method, params });
          if (input.includeTurns) {
            if (historyModes.get(input.threadId!) !== "legacy") throw new Error("list_turns is not supported yet");
            throw new Error(`thread ${input.threadId} is not materialized yet; includeTurns is unavailable before first user message`);
          }
          return { thread: { id: input.threadId, status: { type: "idle" }, turns: [] } } as T;
        }
        const result = await request<T>(method, params);
        if (method === "thread/start") {
          historyModes.set((result as { thread: { id: string } }).thread.id, input.historyMode ?? "paginated");
        }
        return result;
      };
      return client;
    };
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const launchPolicy = { ...spawnRequest().launchPolicy as Record<string, unknown>, historyMode: "paginated" };
    const first = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", launchPolicy }));
    if (repair) {
      harness.clients[0]!.markThreadMissing(first.providerContinuationId!);
      await adapter.repairContinuation(first, {
        workAttemptId: first.workAttemptId,
        expectedProviderContinuationId: first.providerContinuationId!,
        cwd: spawnRequest().cwd,
        launchPolicy,
      }, { checkpointReplacement: async () => {} });
    }
    const freshAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const attached = await freshAdapter.attach({ workAttemptId: first.workAttemptId,
      providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
    assertProviderHandle(attached);
    assert.equal(attached.providerContinuationId, first.providerContinuationId);
    const subscription = freshAdapter.onExecution(attached, () => {});
    assert.deepEqual(subscription.position(), { firstRetainedSequence: 1, latestSequence: 1 });
    subscription.dispose();
    assert.equal(harness.launches.length, 1);
    assert.deepEqual(harness.signals, []);
    assert.equal(harness.clients[1]!.requests.some(entry => entry.method === "thread/resume"), false);
  }
});

test("unsupported paginated history cannot become empty-thread attachment or idle proof", async () => {
  const harness = createHarness();
  const createRpcClient = harness.dependencies.createRpcClient;
  harness.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    const request = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "thread/read" && (params as { includeTurns?: boolean }).includeTurns) {
        client.requests.push({ method, params });
        throw new Error("list_turns is not supported yet");
      }
      return request<T>(method, params);
    };
    return client;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const first = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const freshAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(freshAdapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection }),
  /attach is ambiguous.*list_turns is not supported yet/);
  assert.deepEqual(await adapter.inspectTurnBoundary(first), { state: "unknown" });
  await assert.rejects(adapter.recoverRoomTurn(first, { inboxItemId: "retained-inbox", providerTurnId: "retained-turn" }),
    /list_turns is not supported yet/);
  assert.equal(harness.clients.some(client => client.requests.some(entry => entry.method === "turn/start")), false);
  assert.equal(harness.clients[1]!.requests.some(entry => entry.method === "thread/read"
    && (entry.params as { includeTurns?: boolean }).includeTurns === false), false);
  assert.equal(harness.launches.length, 1);
  assert.deepEqual(harness.signals, []);
});

test("missing-continuation attach remains gap-free across same-process repair", async () => {
  const harness = createHarness();
  const request = spawnRequest({ deliveryMode: "daemon_inbox" });
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  assert.ok(first.providerConnection);
  const createRpcClient = harness.dependencies.createRpcClient;
  harness.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    client.markThreadMissing(first.providerContinuationId!);
    const request = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "thread/read") throw new Error(`thread not found: ${first.providerContinuationId}`);
      return request<T>(method, params);
    };
    return client;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await adapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });
  assertProviderHandle(attached);
  const observations: NativeExecutionObservation[] = [];
  const subscription = adapter.onExecution(attached, event => observations.push(event));
  assert.deepEqual(subscription.position(), { firstRetainedSequence: 1, latestSequence: 1 });
  const repaired = await adapter.repairContinuation!(attached, {
    workAttemptId: request.workAttemptId,
    expectedProviderContinuationId: first.providerContinuationId!,
    cwd: request.cwd,
    launchPolicy: request.launchPolicy,
  }, { checkpointReplacement: async () => {} });
  assert.equal(repaired.outcome, "replaced");
  const replacement = repaired.replacementProviderContinuationId;
  harness.clients[1]!.emit({ method: "turn/started", params: {
    threadId: replacement,
    turnId: `turn-${replacement}`,
    turn: { id: `turn-${replacement}`, status: "inProgress" },
  } });
  assert.deepEqual(subscription.position(), { firstRetainedSequence: 1, latestSequence: 3 },
    "repair continues the original exact source without inheriting a permanent gap");
  assert.equal(observations.some(event => event.fact.domain === "turn"
    && event.fact.providerContinuationId === replacement), true);
  assert.equal(harness.launches.length, 1);
  subscription.dispose();
});

test("fresh attach returns terminal evidence when the recorded app-server is verifiably gone", async () => {
  const harness = createHarness({ threadReadFails: true });
  const request = spawnRequest();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });

  const attached = await new CodexProviderAdapter({ dependencies: harness.dependencies }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });

  assert.ok(attached && "state" in attached);
  assert.equal(attached.state, "terminal");
  assert.equal(attached.terminal.terminalCause, "crashed");
  assert.equal(attached.terminal.providerContinuationId, first.providerContinuationId);
  assert.equal(harness.clients.length, 1, "a proven-absent process is rejected before endpoint contact");
  assert.deepEqual(harness.signals, [], "a proven-absent process is never signalled");
});

test("resume capability fails honestly when app-server lacks thread/resume", async () => {
  const harness = createHarness({ resumeSupported: false });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await adapter.spawn(request);

  assert.equal(
    adapter.capabilities().resume,
    true,
    "fresh thread/start cannot safely infer resume support without a real continuation",
  );
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();
  await assert.rejects(
    adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: first.providerContinuationId!,
    }, request),
    /bounded recovery must start a fresh generation/,
  );
  assert.equal(adapter.capabilities().resume, false);
});

test("spawn fails clearly when the configured LetAgents MCP workplace is absent", async () => {
  const harness = createHarness({ workplacePresent: false });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

  await assert.rejects(adapter.spawn(spawnRequest()), /LetAgents MCP server is not configured/);
  assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }]);
  assert.equal(harness.clients[0]?.closed, true);
});

test("request timeout leaves a slow live writer working and unsignalled", async () => {
  const harness = createHarness({ threadReadTimesOut: true });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));
  await flush();

  assert.equal(handle.observedState(), "working");
  assert.equal(harness.launches[0]?.alive, true);
  assert.deepEqual(harness.signals, []);
  assert.deepEqual(terminals, []);
});

test("startup identity failure terminates and awaits the known fresh child", async () => {
  const harness = createHarness({ identityUnavailableAtLaunch: true, exitOnSignal: true });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

  await assert.rejects(adapter.spawn(spawnRequest()), /process identity could not be verified/);
  assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }]);
  assert.equal(harness.launches[0]?.alive, false);
  assert.equal(harness.clients.length, 0, "no RPC thread may start before process identity is durable");
});

test("spawn requires manifest identity instead of generating an adapter-local name", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

  await assert.rejects(
    adapter.spawn(spawnRequest({ agentDisplayName: "" })),
    /durable agent display name from the manifest/,
  );
  assert.equal(harness.launches.length, 0);
});

test("observed crash emits one synthesized terminal payload and makes attach absent", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const handle = await adapter.spawn(request);
  const seen: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (payload) => seen.push(payload));

  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.terminalCause, "crashed");
  assert.deepEqual(seen[0]?.nativeRuntimeDeath, { kind: "codex_app_server", pid: 4100, processIdentity: handle.providerConnection!.processIdentity });
  assert.equal(seen[0]?.providerContinuationId, handle.providerContinuationId);
  assert.equal(handle.observedState(), "failed");
  assert.equal(await adapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
  }), null);
});

test("spawned RPC disconnect fences the child and waits for observed exit", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  harness.clients[0]!.disconnect();
  await flush();

  assert.equal(harness.launches[0]?.alive, true);
  assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }]);
  assert.equal(terminals.length, 0, "RPC loss is not child-exit evidence");
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
  await flush();

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.terminalCause, "crashed");
  assert.equal(handle.observedState(), "failed");
});

test("stop orders SIGTERM before observed terminal and escalates to SIGKILL after grace", async () => {
  const gracefulHarness = createHarness();
  const gracefulAdapter = new CodexProviderAdapter({ dependencies: gracefulHarness.dependencies });
  const gracefulHandle = await gracefulAdapter.spawn(spawnRequest());
  const gracefulStop = gracefulAdapter.stop(gracefulHandle, { graceMs: 50 });
  assert.deepEqual(gracefulHarness.signals, [{ pid: 4100, signal: "SIGTERM" }]);
  gracefulHarness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
  assert.equal((await gracefulStop).terminalCause, "stopped");

  const forceHarness = createHarness();
  const forceAdapter = new CodexProviderAdapter({ dependencies: forceHarness.dependencies });
  const forceHandle = await forceAdapter.spawn(spawnRequest());
  const forceStop = forceAdapter.stop(forceHandle, { graceMs: 0 });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(forceHarness.signals, [
    { pid: 4100, signal: "SIGTERM" },
    { pid: 4100, signal: "SIGKILL" },
  ]);
  forceHarness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  assert.equal((await forceStop).terminalCause, "killed");
});

test("stop refuses signals without the exact process birth before dispatch or escalation", async (t) => {
  for (const evidence of ["reused", "absent", "unknown"] as const) {
    for (const stage of ["graceful", "force", "escalation"] as const) {
      await t.test(`${stage}: ${evidence}`, async () => {
        const harness = createHarness();
        const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
        const handle = await adapter.spawn(spawnRequest());
        const initialState = handle.observedState();
        const terminals: ProviderTerminalPayload[] = [];
        adapter.onExit(handle, (terminal) => terminals.push(terminal));
        const invalidate = () => {
          if (evidence === "reused") harness.launches[0]!.processIdentity += "-reused";
          else if (evidence === "absent") harness.launches[0]!.alive = false;
          else harness.setIdentityObservable(false);
        };
        if (stage !== "escalation") invalidate();
        const stopped = adapter.stop(handle, { force: stage === "force", graceMs: 0 });
        if (stage === "escalation") invalidate();
        // Keep the event loop alive for the adapter's existing unref'd grace timer.
        const keepAlive = setTimeout(() => {}, 1_000);
        try {
          await assert.rejects(stopped, /exact process birth cannot be verified/);
          assert.deepEqual(harness.signals, stage === "escalation" ? [{ pid: 4100, signal: "SIGTERM" }] : []);
          assert.equal(handle.observedState(), stage === "escalation" ? "stopping" : initialState);
          assert.equal(terminals.length, 0, "a refused signal must not manufacture a terminal payload");
        } finally {
          clearTimeout(keepAlive);
          harness.launches[0]!.resolveExit({ type: "exit", code: 0, signal: null });
        }
      });
    }
  }
});

test("Codex exact-reference stop validates the complete recorded owner before signalling", async () => {
  const harness = createHarness({ processIdentity: "Mon Aug 31 08:00:00 2026" });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const ref: ProviderContinuationRef = {
    workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!,
    providerConnection: { ...handle.providerConnection! },
  };
  for (const patch of [
    { workAttemptId: "" }, { providerContinuationId: "" }, { providerConnection: null },
    { providerConnection: { kind: "claude_cli", pid: 4100, processIdentity: "fake-process-4100-birth-1" } },
    { providerConnection: { ...ref.providerConnection, pid: 0 } },
    { providerConnection: { ...ref.providerConnection, pid: 1.5 } },
    { providerConnection: { ...ref.providerConnection, processIdentity: " " } },
    { providerConnection: { ...ref.providerConnection, processIdentity: "unreadable birth" } },
    { providerConnection: { ...ref.providerConnection, processIdentity: "Mon Aug 99 25:00:00 2026" } },
    { providerConnection: { ...ref.providerConnection, url: "" } },
    { workAttemptId: "different-owner" }, { providerContinuationId: "different-thread" },
    { providerConnection: { ...ref.providerConnection, url: "ws://127.0.0.1:9999" } },
  ]) {
    await assert.rejects(adapter.stopRef({ ...ref, ...patch } as ProviderContinuationRef, { graceMs: 0 }), /exact-reference stop/);
  }
  assert.deepEqual(harness.signals, []);
  assert.equal(handle.observedState(), "idle");
  for (const identity of [undefined, "unreadable birth", "Mon Aug 99 25:00:00 2026", null, "Mon Aug 31 09:00:00 2026"] as const) {
    const freshAdapter = new CodexProviderAdapter({ dependencies: { ...harness.dependencies, getProcessIdentity: () => identity } });
    if (identity === undefined || identity === "unreadable birth" || identity === "Mon Aug 99 25:00:00 2026") {
      assert.equal(harness.launches[0]!.alive, true);
      await assert.rejects(freshAdapter.stopRef(ref), /birth cannot be verified/, "malformed ps text cannot prove a live process was replaced");
    }
    else {
      const { endedAt, ...terminal } = await freshAdapter.stopRef(ref);
      assert.ok(endedAt);
      assert.deepEqual(terminal, { exitCode: null, signal: null, terminalCause: "stopped", providerContinuationId: ref.providerContinuationId,
        nativeRuntimeDeath: { kind: "codex_app_server", pid: 4100, processIdentity: ref.providerConnection!.processIdentity } });
    }
  }
  assert.deepEqual(harness.signals, [], "no attachment or signal is needed after exact birth absence/replacement");
  assert.equal(harness.clients.length, 1);
});

test("Codex exact-reference stop proves OS death even with a cached protocol terminal", async () => {
  const harness = createHarness({ processIdentity: "Mon Aug 31 08:00:00 2026" });
  const signalProcess = harness.dependencies.signalProcess;
  harness.dependencies.signalProcess = (pid, signal) => {
    signalProcess(pid, signal);
    if (signal === "SIGKILL") harness.launches[0]!.alive = false;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const ref = { workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!, providerConnection: { ...handle.providerConnection! } };
  harness.launches[0]!.resolveExit({ type: "error", error: new Error("protocol error, not OS death") });
  harness.launches[0]!.alive = true;
  await flush();
  assert.equal(handle.observedState(), "failed");
  const before = harness.clients[0]!.requests.length;
  const terminal = await adapter.stopRef(ref, { graceMs: 0 });
  assert.equal(terminal.terminalCause, "stopped");
  assert.equal(terminal.exitCode, null, "the signal's exit status is not invented");
  assert.equal(terminal.signal, null);
  assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }, { pid: 4100, signal: "SIGKILL" }]);
  assert.equal(harness.clients[0]!.requests.length, before, "stopRef does not depend on a functioning native transport");
  assert.equal(harness.launches.length, 1);
});

test("Codex exact-reference stop rechecks birth at escalation and never trusts a signal as death", async () => {
  for (const evidence of ["unknown", "malformed", "replaced", "absent", "still_alive", "force"] as const) {
    const harness = createHarness({ processIdentity: "Mon Aug 31 08:00:00 2026" });
    const signalProcess = harness.dependencies.signalProcess;
    const getProcessIdentity = harness.dependencies.getProcessIdentity;
    let signalled = false;
    let readsAfterSignal = 0;
    harness.dependencies.getProcessIdentity = (pid) => {
      if (signalled && ++readsAfterSignal === 2) {
        if (evidence === "unknown") harness.setIdentityObservable(false);
        if (evidence === "malformed") harness.launches[0]!.processIdentity = "unreadable birth";
        if (evidence === "replaced") harness.launches[0]!.processIdentity = "Mon Aug 31 09:00:00 2026";
      }
      return getProcessIdentity(pid);
    };
    harness.dependencies.signalProcess = (pid, signal) => {
      signalProcess(pid, signal);
      signalled = true;
      if (evidence === "absent" || evidence === "force") harness.launches[0]!.alive = false;
    };
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const ref = { workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!, providerConnection: { ...handle.providerConnection! } };
    const stoppingAdapter = evidence === "force" ? new CodexProviderAdapter({ dependencies: harness.dependencies }) : adapter;
    const stopped = stoppingAdapter.stopRef(ref, { graceMs: 0, force: evidence === "force" });
    if (evidence === "unknown" || evidence === "malformed" || evidence === "still_alive") await assert.rejects(stopped, /cannot be verified|not yet proved/);
    else assert.equal((await stopped).terminalCause, "stopped");
    assert.deepEqual(harness.signals, evidence === "still_alive"
      ? [{ pid: 4100, signal: "SIGTERM" }, { pid: 4100, signal: "SIGKILL" }]
      : [{ pid: 4100, signal: evidence === "force" ? "SIGKILL" : "SIGTERM" }]);
    assert.equal(handle.observedState(), evidence === "force" ? "idle" : "stopping", "the reference proof does not mint a native lifecycle event");
    assert.equal(harness.clients.length, 1, "a fresh adapter stops the saved birth without attaching its native transport");
  }
});

test("native notifications and transcript tail become activity evidence", async () => {
  const harness = createHarness();
  const sink: ProviderActivityEvent[] = [];
  const nativeStream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    activitySink: (event) => sink.push(event),
    streamSink: (event) => nativeStream.push(event),
  });
  const handle = await adapter.spawn(spawnRequest());
  const subscribed: ProviderActivityEvent[] = [];
  const subscribedStream: ProviderStreamEvent[] = [];
  adapter.onActivity(handle, (event) => subscribed.push(event));
  adapter.onStream(handle, (event) => subscribedStream.push(event));

  harness.clients[0]!.emit({
    method: "item/agentMessage/delta",
    params: { delta: "Reading the next room message", apiKey: "must-not-leak" },
  });
  harness.clients[0]!.emit({
    method: "command/exec/outputDelta",
    params: { processId: "p1", delta: "npm test: 13 passed" },
  });
  harness.clients[0]!.emit({ method: "turn/started", params: { turnId: "turn-1" } });
  harness.clients[0]!.emit({ method: "item/mcpToolCall/progress", params: { tool: "read_messages" } });
  harness.clients[0]!.emit({ method: "item/commandExecution/requestApproval", params: { command: "git push" } });
  harness.clients[0]!.emit({ method: "error", params: { message: "provider error" } });
  harness.clients[0]!.emit({ method: "thread/tokenUsage/updated", params: { inputTokens: 12 } });

  harness.clients[0]!.emit({
    method: "turn/completed",
    params: { threadId: handle.providerContinuationId, turnId: "turn-thread-1" },
  });
  await flush();

  assert.ok(sink.some((event) => event.source === "native_harness" && event.method === "turn/completed"));
  assert.ok(sink.some((event) =>
    event.source === "transcript_tail" && event.summary === "Transcript checkpoint persisted."));
  assert.ok(subscribed.some((event) => event.source === "transcript_tail"));
  const textDelta = nativeStream.find((event) => event.method === "item/agentMessage/delta");
  assert.equal(textDelta?.kind, "text_delta");
  assert.equal((textDelta?.payload as { delta?: string }).delta, "Reading the next room message");
  assert.equal((textDelta?.payload as { apiKey?: string }).apiKey, "[REDACTED]");
  assert.equal(textDelta?.payloadRedacted, true);
  assert.equal(
    nativeStream.find((event) => event.method === "command/exec/outputDelta")?.kind,
    "command_output",
    "command deltas retain their tool-specific stream category",
  );
  assert.equal(nativeStream.find((event) => event.method === "turn/started")?.kind, "turn_lifecycle");
  assert.equal(nativeStream.find((event) => event.method === "item/mcpToolCall/progress")?.kind, "tool_lifecycle");
  assert.equal(nativeStream.find((event) => event.method.includes("requestApproval"))?.kind, "approval");
  assert.equal(nativeStream.find((event) => event.method === "error")?.kind, "error");
  assert.equal(nativeStream.find((event) => event.method.includes("tokenUsage"))?.kind, "usage");
  assert.ok(nativeStream.some((event) => event.kind === "transcript_snapshot"));
  assert.ok(subscribedStream.some((event) => event.method === "turn/completed"));
  assert.deepEqual(
    nativeStream.map((event) => event.sequence),
    nativeStream.map((_, index) => index + 1),
    "native stream ordering is explicit per provider handle",
  );
});

test("native stream carries accumulated readable reasoning summaries but never raw reasoning text", async () => {
  const harness = createHarness();
  const nativeStream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => nativeStream.push(event),
  });
  const handle = await adapter.spawn(spawnRequest());
  const identity = {
    threadId: handle.providerContinuationId,
    turnId: "turn-readable-summary",
    itemId: "item-readable-summary",
    summaryIndex: 0,
  };

  harness.clients[0]!.emit({
    method: "item/reasoning/summaryTextDelta",
    params: { ...identity, delta: "Checking the room " },
  });
  harness.clients[0]!.emit({
    method: "item/reasoning/summaryTextDelta",
    params: { ...identity, delta: "delivery path." },
  });
  harness.clients[0]!.emit({
    method: "item/reasoning/textDelta",
    params: { ...identity, delta: "private chain of thought must not become UI copy" },
  });

  const readable = nativeStream.filter((event) => event.method === "item/reasoning/summaryTextDelta");
  assert.deepEqual(readable.map((event) => event.summary), [
    "Checking the room",
    "Checking the room delivery path.",
  ]);
  assert.equal(
    nativeStream.find((event) => event.method === "item/reasoning/textDelta")?.summary,
    "Codex raw reasoning text is streaming.",
  );
  assert.equal(
    nativeStream.some((event) => event.summary?.includes("private chain of thought")),
    false,
    "raw reasoning content never enters the human-readable stream summary",
  );
});

test("native turn failure leaves the Codex runtime reusable while system failure latches", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());

  harness.clients[0]!.emit({
    method: "turn/completed",
    params: { turn: { status: "failed" } },
  });
  await flush();
  assert.equal(handle.observedState(), "idle");

  harness.clients[0]!.emit({
    method: "thread/status/changed",
    params: { threadId: handle.providerContinuationId, status: { type: "systemError" } },
  });
  await flush();
  assert.equal(handle.observedState(), "failed");

  harness.clients[0]!.emit({
    method: "turn/completed",
    params: { turn: { status: "completed" } },
  });
  await flush();
  assert.equal(handle.observedState(), "failed", "turn settlement cannot clear process/control failure");
});

test("Codex spawn cannot clear runtime failure observed before handle admission or initial turn acknowledgement", async () => {
  const queuedHarness = createHarness();
  const queuedCreateClient = queuedHarness.dependencies.createRpcClient;
  const queuedAdapter = new CodexProviderAdapter({ dependencies: {
    ...queuedHarness.dependencies,
    createRpcClient: (serverUrl, notify) => {
      const client = queuedCreateClient(serverUrl, notify) as FakeRpc;
      client.emit({ method: "thread/status/changed", params: {
        threadId: "thread-1", status: { type: "systemError" },
      } });
      return client;
    },
  } });
  const queuedHandle = await queuedAdapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  assert.equal(queuedHandle.observedState(), "failed", "queued native failure survives the idle launch baseline");

  const pollingHarness = createHarness();
  const pollingCreateClient = pollingHarness.dependencies.createRpcClient;
  const pollingAdapter = new CodexProviderAdapter({ dependencies: {
    ...pollingHarness.dependencies,
    createRpcClient: (serverUrl, notify) => {
      const client = pollingCreateClient(serverUrl, notify) as FakeRpc;
      const request = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        const result = await request<T>(method, params);
        if (method === "turn/start") {
          client.emit({ method: "thread/status/changed", params: {
            threadId: "thread-1", status: { type: "systemError" },
          } });
          await flush();
        }
        return result;
      };
      return client;
    },
  } });
  const pollingHandle = await pollingAdapter.spawn(spawnRequest());
  assert.equal(pollingHandle.observedState(), "failed", "turn acknowledgement cannot clear runtime failure");
});

test("execution failures preserve the Codex runtime and subsequent exact room turns", async () => {
  const harness = createHarness();
  const stream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => stream.push(event),
  });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const failures = [
    { method: "item/commandExecution/failed", kind: "command_output", params: { status: "failed", exitCode: 1 } },
    { method: "item/mcpToolCall/failed", kind: "tool_lifecycle", params: { status: "error" } },
    { method: "item/fileChange/failed", kind: "tool_lifecycle", params: { status: "failed" } },
    { method: "command/exec/failed", kind: "command_output", params: { status: "failed" } },
    { method: "item/completed", kind: "item_lifecycle", params: { item: { type: "commandExecution", status: "failed", error: { message: "exit 1" } } } },
    { method: "item/completed", kind: "item_lifecycle", params: { item: { type: "fileChange", status: "failed", error: { message: "write denied" } } } },
    { method: "item/failed", kind: "error", params: { status: "failed" } },
  ];
  for (const failure of failures) {
    client.emit(failure);
    assert.equal(stream.at(-1)?.kind, failure.kind, failure.method);
    assert.equal(providerStreamLifecycle(stream.at(-1)!), "working", failure.method);
    assert.equal(handle.observedState(), "working", failure.method);
  }
  await flush();
  assert.equal(harness.launches[0]!.alive, true);
  assert.deepEqual(harness.signals, []);

  // Item failures neither settle the containing turn nor poison its successor.
  const originalRequest = client.request.bind(client);
  let nativeTurn = 0;
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: `turn-after-error-${nativeTurn++}` } } as T;
    if (method === "thread/read") return { thread: {
      id: handle.providerContinuationId,
      turns: [{ id: `turn-after-error-${nativeTurn - 1}`, status: "completed" }],
    } } as T;
    return originalRequest<T>(method, params);
  };
  for (let index = 0; index < 2; index += 1) {
    const running = adapter.runRoomTurn!(handle, {
      inboxItemId: `inbox-after-tool-error-${index}`,
      actionId: `action-after-tool-error-${index}`,
      sourceMessage: {}, activation: {},
    }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
    await flush();
    client.emit({ method: "item/commandExecution/failed", params: { status: "failed", exitCode: 1 } });
    assert.equal(handle.observedState(), "working");
    client.emit({ method: "item/agentMessage/delta", params: {
      threadId: handle.providerContinuationId, turnId: `turn-after-error-${index}`,
      itemId: `answer-${index}`, delta: "Recovered from command failure.",
    } });
    client.emit({ method: "turn/completed", params: {
      threadId: handle.providerContinuationId, turnId: `turn-after-error-${index}`,
    } });
    assert.equal((await running).outcome, "reply");
    assert.equal(handle.observedState(), "idle");
  }
  assert.equal(harness.launches.length, 1, "both turns reuse the same app-server");
  assert.deepEqual(harness.signals, []);
  client.emit({ method: "process/systemError", params: { status: "systemError" } });
  assert.equal(stream.at(-1)?.kind, "error", "process errors are not command failures");
  assert.equal(handle.observedState(), "failed", "genuine runtime failure still latches");
});

test("typed Codex authority is daemon-inbox only and ignores raw execution failure classification", async () => {
  const rejectedHarness = createHarness();
  const rejected = new CodexProviderAdapter({ dependencies: rejectedHarness.dependencies });
  await assert.rejects(
    rejected.spawn(spawnRequest({ deliveryMode: "mcp_polling", lifecycleAuthorityMode: "typed" })),
    /Typed Codex lifecycle authority requires daemon-inbox delivery/,
  );
  assert.equal(rejectedHarness.launches.length, 0, "an invalid authority/delivery pair starts no runtime");

  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({
    deliveryMode: "daemon_inbox",
    lifecycleAuthorityMode: "typed",
  }));
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, event => observations.push(event));
  assert.equal(observations[0]?.fact.domain, "runtime");
  assert.equal(observations[0]?.fact.state, "ready",
    "successful app-server setup emits replayable runtime readiness before room work");
  const client = harness.clients[0]!;
  client.emit({ method: "turn/started", params: {
    threadId: handle.providerContinuationId,
    turnId: "typed-turn",
    turn: { id: "typed-turn", status: "inProgress" },
  } });
  assert.equal(handle.observedState(), "working");
  client.emit({ method: "thread/status/changed", params: {
    threadId: "unrelated-thread",
    status: { type: "systemError" },
  } });
  assert.equal(handle.observedState(), "working",
    "an unrelated raw runtime failure cannot mutate the exact typed runtime handle");
});

test("native stream bounds oversized provider payloads without dropping method identity", async () => {
  const harness = createHarness();
  const nativeStream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => nativeStream.push(event),
  });
  await adapter.spawn(spawnRequest());

  harness.clients[0]!.emit({ method: "item/reasoning/textDelta", params: { delta: "x".repeat(40_000) } });
  const event = nativeStream.find((entry) => entry.method === "item/reasoning/textDelta");
  assert.equal(event?.kind, "text_delta");
  assert.equal(event?.payloadTruncated, true);
  assert.equal(typeof (event?.payload as { preview?: unknown }).preview, "string");
  assert.equal(event?.durablePayloadRef, null);
});

test("launch policy cannot override adapter-owned thread fields", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(
    adapter.spawn(spawnRequest({ launchPolicy: { cwd: "/tmp/escape" } })),
    /reserved field 'cwd'/,
  );
  assert.equal(harness.launches.length, 0);
});

test("Codex typed shadow separates exact tool and turn failures from the reusable runtime handle", async () => {
  const harness = createHarness();
  const stream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies, streamSink: (event) => stream.push(event) });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, () => { throw new Error("shadow writer unavailable"); });
  const unsubscribe = adapter.onExecution(handle, (event) => observations.push(event));
  const client = harness.clients[0]!;
  const threadId = handle.providerContinuationId;
  const emit = (method: string, params: Record<string, unknown>) => client.emit({ method, params: { threadId, turnId: "turn-1", ...params } });
  emit("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
  emit("item/started", { item: { id: "command-1", type: "commandExecution", status: "inProgress", processId: "pty-1", command: "SECRET=hidden npm test", cwd: "/private/project" } });
  emit("item/commandExecution/outputDelta", { itemId: "command-1", delta: "secret output" });
  emit("item/completed", { item: { id: "command-1", type: "commandExecution", status: "failed", exitCode: 1 } });
  assert.equal(handle.observedState(), "working");
  assert.equal(providerStreamLifecycle(stream.at(-1)!), "working");
  const failedTurn = { turn: { id: "turn-1", status: "failed" } };
  emit("turn/completed", failedTurn);
  emit("turn/completed", failedTurn);
  emit("turn/failed", failedTurn);
  assert.equal(handle.observedState(), "idle", "the failed turn does not poison the reusable runtime handle");
  for (const event of stream.filter((candidate) => /^turn\/(?:completed|failed)$/.test(candidate.method))) {
    assert.equal(event.kind, "turn_lifecycle", "the adapter preserves exact turn identity ahead of generic failure labels");
    assert.equal(providerStreamLifecycle(event), "terminal",
      "the daemon agrees that an exact failed turn leaves the Codex app-server reusable");
  }
  emit("turn/started", { turnId: "turn-2", turn: { id: "turn-2", status: "inProgress" } });
  let projection = emptyExecutionProjection();
  for (const observation of observations) {
    projection = reduceExecutionFact(projection, {
      ...observation.fact, factId: `fact-${observation.sequence}`, agentId: "agent", executionGenerationId: "generation",
      runtimeGenerationId: "runtime", observerEpoch: 1, sourceSequence: observation.sequence, observedAtMs: observation.observedAtMs,
      ...("providerTurnId" in observation.fact ? { turnId: `local-${observation.fact.providerTurnId}` } : {}),
    });
    assert.equal(observation.nativeProcessIdentity, handle.providerConnection?.processIdentity);
    assert.equal(projection.runtime, "ready", "the exact native start proves readiness from an empty projection");
  }
  assert.equal(projection.runtime, "ready", "native turn failure never says the app-server died");
  assert.equal(projection.turns.get("local-turn-1").outcome, "failed");
  assert.equal(projection.turns.get("local-turn-1").operations.get("command-1").exitCode, 1);
  assert.equal(projection.turns.get("local-turn-2").state, "active");
  assert.equal(/SECRET|secret output|private\/project/.test(JSON.stringify(observations)), false);
  const streamCheckpointIds = [...new Set(stream.flatMap((event) => event.nativeEventId ? [event.nativeEventId] : []))];
  const typedCheckpointIds = [...new Set(observations.flatMap((event) => event.fact.nativeEventId ? [event.fact.nativeEventId] : []))];
  assert.deepEqual(typedCheckpointIds, streamCheckpointIds,
    "exact native turn lifecycle events carry the same opaque identity in typed and legacy projections");
  assert.equal(stream.every((event) => !event.nativeEventId || event.nativeLifecyclePhase ===
    (event.method === "turn/started" ? "turn_active" : "turn_terminal")), true,
  "correlated Codex events expose only the closed structural lifecycle phase");
  assert.equal(streamCheckpointIds.length, 3, "two native starts and one native terminal are independently correlated");
  const terminalIds = stream.filter((event) => event.method === "turn/completed")
    .map((event) => event.nativeEventId);
  assert.equal(terminalIds.length, 2);
  assert.equal(terminalIds[0], terminalIds[1], "an identical terminal replay keeps the first checkpoint identity");
  assert.ok(streamCheckpointIds.every((value) => /^nlc1:[A-Za-z0-9_-]{43}$/.test(value)));
  assert.equal(stream.some((event) => event.method.startsWith("item/") && event.nativeEventId !== undefined), false,
    "execution and display events are outside turn-lifecycle checkpoint identity");
  assert.equal(observations.some((event) => event.fact.domain === "execution" && event.fact.nativeEventId !== undefined), false);
  assert.deepEqual(harness.signals, []);
  assert.equal(harness.launches.length, 1);
  unsubscribe.dispose();
  const replayed: NativeExecutionObservation[] = [];
  const stopReplay = adapter.onExecution(handle, (event) => replayed.push(event));
  assert.deepEqual(replayed, observations, "late installation receives the same structural facts, not a reconstructed transcript");
  assert.equal(stopReplay.sourceId, unsubscribe.sourceId);
  assert.ok(replayed.every(event => event.sourceId === stopReplay.sourceId));
  stopReplay.dispose();
});

test("direct Codex turn/failed emits its own typed terminal checkpoint", async () => {
  const harness = createHarness();
  const stream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => stream.push(event),
  });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  const client = harness.clients[0]!;
  const params = { threadId: handle.providerContinuationId, turnId: "turn-direct-failed" };
  client.emit({ method: "turn/started", params: {
    ...params, turn: { id: params.turnId, status: "inProgress" },
  } });
  client.emit({ method: "turn/failed", params: {
    ...params, turn: { id: params.turnId, status: "failed" },
  } });

  const failedStream = stream.find((event) => event.method === "turn/failed");
  assert.ok(failedStream?.nativeEventId);
  assert.equal(failedStream.kind, "turn_lifecycle");
  assert.equal(providerStreamLifecycle(failedStream), "terminal");
  const failedFact = observations.find((event) => event.fact.domain === "turn"
    && event.fact.providerTurnId === params.turnId
    && event.fact.state === "terminal");
  assert.ok(failedFact && failedFact.fact.domain === "turn");
  assert.equal(failedFact.fact.turnOutcome, "failed");
  assert.equal(failedFact.fact.nativeEventId, failedStream.nativeEventId,
    "the direct failure carries one shared typed/legacy checkpoint identity");
});

test("execution observation replay stays bounded and preserves source gaps", () => {
  const observer = new ProviderExecutionObserver(() => "2026-08-31T00:00:00.000Z");
  const fact = { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" } as const;
  for (let index = 0; index < 300; index++) observer.emit(fact, `birth-${index}`);
  const replay: NativeExecutionObservation[] = [];
  const stop = observer.subscribe(event => replay.push(event));
  assert.equal(replay.length, 256);
  assert.equal(replay[0]!.sequence, 45);
  assert.equal(replay.at(-1)!.sequence, 300);
  assert.equal(replay[0]!.nativeProcessIdentity, "birth-44");
  assert.equal(replay[0]!.observedAtMs, Date.parse("2026-08-31T00:00:00.000Z"));
  assert.ok(Object.isFrozen(replay[0]) && Object.isFrozen(replay[0]!.fact));
  assert.deepEqual(stop.position(), { firstRetainedSequence: 45, latestSequence: 300 });
  stop.dispose();

  // UTF-8 bytes, not character count, bound even malformed adapter input.
  for (let index = 0; index < 100; index++) observer.emit({ ...fact, nativeEventId: "😀".repeat(1024) });
  const bounded: NativeExecutionObservation[] = [];
  const stopBounded = observer.subscribe(event => bounded.push(event));
  stopBounded.dispose();
  assert.ok(bounded.length < 100);
  assert.equal(bounded.at(-1)!.sequence, 400);
  assert.ok(bounded.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0) <= 256 * 1024);
  observer.emit({ ...fact, nativeEventId: "x".repeat(256 * 1024) });
  assert.equal(stopBounded.position().latestSequence, 401, "a dropped trailing observation remains visible in the source watermark");
  observer.emit(fact, "final-birth");
  const afterGap: NativeExecutionObservation[] = [];
  observer.subscribe(event => afterGap.push(event)).dispose();
  assert.deepEqual(afterGap.slice(-2).map(event => event.sequence), [400, 402]);
  assert.equal(replay.length, 256, "unsubscribed observers receive neither live events nor later replay");
});

test("execution observation replay and live fan-out preserve reentrant order and listener isolation", () => {
  const observer = new ProviderExecutionObserver(() => "2026-08-31T00:00:00.000Z");
  let emitted = 0;
  // Alternate real transitions so this ordering test remains independent of
  // steady-state control-observation coalescing.
  const emit = () => observer.emit({ domain: "control", kind: "state_changed",
    state: emitted++ % 2 === 0 ? "responsive" : "degraded", sideEffects: "none" });
  emit(); emit();
  const first: number[] = [];
  const second: number[] = [];
  observer.subscribe(event => {
    first.push(event.sequence);
    if (event.sequence === 1 || event.sequence === 4) emit();
    throw new Error("journal unavailable");
  });
  const secondSubscription = observer.subscribe(event => {
    second.push(event.sequence);
    if (event.sequence === 4) secondSubscription.dispose();
  });
  emit(); emit();
  assert.deepEqual(first, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(second, [1, 2, 3, 4], "unsubscribe during fan-out prevents later facts, including reentrant ones");
  const replay: number[] = [];
  observer.subscribe(event => replay.push(event.sequence)).dispose();
  assert.deepEqual(replay, first);
  const replacement = new ProviderExecutionObserver(() => "2026-08-31T00:00:00.000Z");
  const otherSource = replacement.subscribe(() => {});
  assert.notEqual(otherSource.sourceId, secondSubscription.sourceId, "observer replacement is independent of native process identity");
  assert.deepEqual(otherSource.position(), { firstRetainedSequence: 1, latestSequence: 0 });
  otherSource.dispose();
});

test("Codex pending approval is not execution start; malformed exact terminals consume an unavailable source position", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  const client = harness.clients[0]!;
  const params = { threadId: handle.providerContinuationId, turnId: "pending-turn" };
  client.emit({ method: "item/started", params: { ...params, item: { id: "pending", type: "commandExecution", status: "inProgress", processId: null } } });
  client.emit({ method: "item/started", params: { ...params, item: { id: "patch", type: "fileChange", status: "inProgress" } } });
  client.emit({ method: "turn/completed", params: { ...params, turn: { id: "pending-turn", status: "futureStatus" } } });
  assert.equal(observations.length, 2);
  assert.equal(observations[1]!.sequence, 3, "the malformed terminal consumes one position after runtime readiness");
  assert.deepEqual(observations[1]!.fact, {
    domain: "control", kind: "state_changed", state: "degraded", sideEffects: "none",
  });
  client.emit({ method: "item/commandExecution/outputDelta", params: { ...params, threadId: "wrong", itemId: "pending", delta: "data" } });
  client.emit({ method: "item/completed", params: { threadId: params.threadId, item: { id: "no-turn", type: "commandExecution", status: "failed" } } });
  client.emit({ method: "item/reasoning/textDelta", params: { ...params, delta: "private reasoning" } });
  assert.equal(observations.length, 2, "unrelated malformed item/display events still mint no structural facts");
  client.emit({ method: "item/completed", params: { ...params, item: { id: "pending", type: "commandExecution", status: "declined" } } });
  assert.equal(observations.length, 3);
  const fact = observations[2]!.fact;
  assert.equal(fact.domain, "execution");
  assert.equal(fact.kind, "completed");
  assert.equal("outcome" in fact && fact.outcome, "denied_before_start");
  assert.equal(fact.sideEffects, "none");
  client.emit({ method: "turn/started", params: { ...params, turn: { id: params.turnId, status: "inProgress" } } });
  client.emit({ method: "item/started", params: { ...params, item: { id: "orphan", type: "commandExecution", status: "inProgress", processId: "pty" } } });
  harness.launches[0]!.resolveExit({ type: "exit", code: 1, signal: null });
  await flush();
  const orphan = observations.find((entry) => entry.fact.domain === "execution" && entry.fact.kind === "completed" && entry.fact.executionId === "orphan");
  assert.equal(orphan?.fact.domain === "execution" && orphan.fact.kind === "completed" && orphan.fact.outcome, "lost_after_start");
  assert.equal(observations.at(-1)?.fact.domain, "runtime");
  assert.equal(await adapter.probeControl(handle).then((result) => result.state), "lost");
  assert.deepEqual(harness.signals, []);
});

test("explicit Codex system errors emit one typed hard-runtime terminal before process exit", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({
    deliveryMode: "daemon_inbox",
    lifecycleAuthorityMode: "typed",
  }));
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  const client = harness.clients[0]!;
  const params = { threadId: handle.providerContinuationId, turnId: "system-error-turn" };
  let resolveProbe!: (value: unknown) => void;
  client.request = <T>(): Promise<T> => new Promise((resolve) => {
    resolveProbe = resolve as (value: unknown) => void;
  });
  const pendingProbe = adapter.probeControl(handle);
  client.emit({ method: "turn/started", params: { ...params, turn: { id: params.turnId, status: "inProgress" } } });
  client.emit({ method: "item/started", params: { ...params,
    item: { id: "system-error-command", type: "commandExecution", status: "inProgress", processId: "pty-system-error" } } });
  // On a typed lane a thread's `systemError` status is a failed turn; only a
  // process-level system error ends the runtime.
  client.emit({ method: "process/systemError", params: { status: "systemError" } });

  const hardTerminals = observations.filter((event) => event.fact.domain === "runtime" || event.fact.domain === "control");
  assert.deepEqual(hardTerminals.map((event) => event.fact), [
    { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" },
    { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" },
    { domain: "control", kind: "state_changed", state: "lost", controlEvidence: "native_session_terminated", sideEffects: "none" },
    { domain: "runtime", kind: "state_changed", state: "exited", controlEvidence: "native_session_terminated", sideEffects: "none" },
  ]);
  assert.equal(observations.some((event) => event.fact.domain === "turn" && event.fact.state === "lost"), true);
  assert.equal(observations.some((event) => event.fact.domain === "execution" && event.fact.kind === "completed"
    && event.fact.outcome === "lost_after_start"), true);

  const terminalCount = observations.length;
  resolveProbe({ data: [], nextCursor: null });
  assert.deepEqual(await pendingProbe, {
    state: "lost", controlEvidence: "native_session_terminated",
  }, "an in-flight probe cannot reopen a conclusively lost runtime");
  assert.equal(observations.length, terminalCount);
  client.emit({ method: "turn/started", params: {
    ...params, turnId: "late-turn", turn: { id: "late-turn", status: "inProgress" },
  } });
  client.emit({ method: "item/started", params: {
    ...params, turnId: "late-turn", item: {
      id: "late-command", type: "commandExecution", status: "inProgress", processId: "pty-late",
    },
  } });
  client.emit({ method: "process/systemError", params: { status: "systemError" } });
  client.emit({ method: "thread/status/changed", params: {
    threadId: handle.providerContinuationId, status: { type: "systemError" },
  } });
  client.disconnect();
  harness.launches[0]!.resolveExit({ type: "exit", code: 1, signal: null });
  await flush();
  assert.equal(observations.length, terminalCount,
    "late activity, disconnect, repeated system error, and process exit cannot reopen or extend the terminal tail");
  assert.deepEqual(await adapter.probeControl(handle), {
    state: "lost", controlEvidence: "native_session_terminated",
  }, "a probe preserves the first conclusive terminal without appending another fact");
  assert.equal(observations.length, terminalCount);
  assert.equal(handle.observedState(), "failed");
});

test("Codex cheap probes degrade on uncertainty and lose control only on exact process proof", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const probes: unknown[] = [];
  let response: unknown = { data: [], nextCursor: null };
  client.request = async <T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T> => {
    probes.push({ method, params, options });
    if (response instanceof Error) throw response;
    return response as T;
  };
  assert.deepEqual(await adapter.probeControl(handle), { state: "responsive" });
  response = new Error("request timed out");
  for (let i = 0; i < 3; i++) assert.deepEqual(await adapter.probeControl(handle), { state: "degraded" });
  response = { data: "malformed" };
  assert.deepEqual(await adapter.probeControl(handle), { state: "degraded" });
  response = new Error("JSON-RPC -32601: method not found");
  assert.deepEqual(await adapter.probeControl(handle), { state: "unprobeable" });
  assert.equal(handle.observedState(), "idle");
  assert.deepEqual(probes[0], { method: "thread/loaded/list", params: { limit: 1 }, options: { timeoutMs: 2_000 } });
  assert.equal(probes.every((probe) => (probe as { method: string }).method === "thread/loaded/list"), true);
  harness.setIdentityObservable(false);
  const count = probes.length;
  assert.deepEqual(await adapter.probeControl(handle), { state: "degraded" });
  assert.equal(probes.length, count, "unverified process never receives a probe");
  harness.setIdentityObservable(true);
  harness.launches[0]!.processIdentity += "-replaced";
  assert.deepEqual(await adapter.probeControl(handle), { state: "lost", controlEvidence: "process_birth_changed" });
  assert.equal(probes.length, count);
  assert.deepEqual(harness.signals, []);
  assert.equal(harness.launches.length, 1);
});

test("Codex turn-boundary inspection validates the complete native snapshot without changing execution", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const identity = { providerContinuationId: "thread-1", nativeProcessIdentity: harness.launches[0]!.processIdentity };
  const idle = (latestProviderTurnId: string | null): NativeTurnBoundary => ({ state: "idle", ...identity, latestProviderTurnId });
  const active: NativeTurnBoundary = { state: "active", ...identity, providerTurnId: "waiting-turn" };
  const unknown: NativeTurnBoundary = { state: "unknown" };
  const snapshot = (turns: unknown, status: unknown = { type: "idle" }, id: unknown = "thread-1") => ({ thread: { id, status, turns } });
  const terminal = { id: "last-turn", status: "completed" };
  const waiting = { id: "waiting-turn", status: "inProgress", items: [{ type: "mcpToolCall", server: "letagents", tool: "wait_for_messages", status: "inProgress" }] };
  const cases: Array<[string, unknown, NativeTurnBoundary]> = [
    ["empty idle", snapshot([]), idle(null)],
    ["all terminal", snapshot(["completed", "interrupted", "failed", "cancelled", "stopped"].map(status => ({ id: status, status })), "idle"), idle("stopped")],
    ["nested turn status", snapshot([{ id: "nested", status: { status: "completed" } }]), idle("nested")],
    ["MCP waiting before latest terminal", snapshot([waiting, terminal], { type: "active" }), active],
    ["MCP waiting after terminal", snapshot([terminal, waiting], { type: "active" }), active],
    ["missing response", undefined, unknown], ["missing thread", {}, unknown],
    ["missing turns", snapshot(undefined), unknown], ["null turns", snapshot(null), unknown],
    ["object turns", snapshot({}), unknown], ["malformed turn", snapshot([null, terminal]), unknown],
    ["missing turn status", snapshot([{ id: "missing" }, terminal]), unknown],
    ["malformed turn status", snapshot([{ id: "malformed", status: { status: 1 } }]), unknown],
    ["unknown turn status", snapshot([{ id: "unknown", status: "futureStatus" }, terminal]), unknown],
    ["missing turn id", snapshot([{ status: "completed" }]), unknown],
    ["malformed turn id", snapshot([{ id: 1, status: "completed" }]), unknown],
    ["unsafe turn id", snapshot([{ id: "turn\nspoof", status: "completed" }]), unknown],
    ["oversized turn id", snapshot([{ id: "x".repeat(513), status: "completed" }]), unknown],
    ["wrong continuation", snapshot([], "idle", "different-thread"), unknown],
    ["duplicate turn", snapshot([terminal, terminal]), unknown],
    ["multiple active", snapshot([waiting, { ...waiting, id: "other-active" }]), unknown],
    ["active thread but terminal turns", snapshot([terminal], { type: "active" }), unknown],
    ["active thread but no turns", snapshot([], { type: "active" }), unknown],
    ["missing thread status", { thread: { id: "thread-1", turns: [] } }, unknown],
    ["malformed thread status", snapshot([], { type: 1 }), unknown],
    ["timeout", new Error("Codex app-server request timed out: thread/read"), unknown],
    ["unsupported", new Error("JSON-RPC -32601: method not found"), unknown],
    ["unmaterialized", new Error("thread is not materialized yet; includeTurns is unavailable before first user message"), unknown],
  ];
  const observations: NativeExecutionObservation[] = [];
  const subscription = adapter.onExecution(handle, event => observations.push(event));
  assert.equal(observations[0]?.fact.domain, "runtime");
  assert.equal(observations[0]?.fact.state, "ready");
  observations.length = 0;
  const reads: RecordedRequest[] = [];
  let response: unknown;
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    reads.push({ method, params });
    client.requests.push({ method, params });
    if (response instanceof Error) throw response;
    return response as T;
  };
  for (const [name, value, expected] of cases) {
    response = value;
    assert.deepEqual(await adapter.inspectTurnBoundary(handle), expected, name);
    assert.equal(handle.observedState(), "idle", `${name}: native inspection must not mutate the handle`);
  }
  assert.equal(observations.length, 0, "native snapshot inspection emits no lifecycle facts");
  assert.equal(reads.length, cases.length);
  assert.ok(reads.every(read => read.method === "thread/read"));
  assert.deepEqual(reads[0]!.params, { threadId: "thread-1", includeTurns: true });
  harness.setIdentityObservable(false);
  assert.deepEqual(await adapter.inspectTurnBoundary(handle), unknown);
  assert.equal(reads.length, cases.length, "unverifiable process receives no native read");
  harness.setIdentityObservable(true);
  client.emit({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "live-turn", status: "inProgress" } } });
  assert.deepEqual(observations.map(event => event.fact.domain), ["runtime", "turn"], "ordinary native capture still receives real observations");
  assert.equal(handle.observedState(), "working");
  response = snapshot([]);
  assert.deepEqual(await adapter.inspectTurnBoundary(handle), idle(null));
  assert.equal(handle.observedState(), "working", "native idle discovery must not rewrite legacy lifecycle state");
  assert.equal(observations.length, 2);
  assert.deepEqual(harness.signals, []);
  assert.equal(harness.launches.length, 1);
  assert.equal(client.requests.some(request => request.method === "turn/start" || request.method === "turn/interrupt"), false);
  subscription.dispose();
});

for (const race of ["process_birth", "continuation", "owned_handle"] as const) {
  test(`Codex turn-boundary inspection rejects ${race} changes during its native read`, async () => {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const request = spawnRequest({ deliveryMode: "daemon_inbox" });
    const handle = await adapter.spawn(request);
    const client = harness.clients[0]!;
    const originalRequest = client.request.bind(client);
    let release!: () => void;
    let markReading!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { markReading = resolve; });
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method !== "thread/read") return originalRequest<T>(method, params);
      client.requests.push({ method, params });
      markReading();
      await waiting;
      return { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } } as T;
    };
    const observations: NativeExecutionObservation[] = [];
    const subscription = adapter.onExecution(handle, event => observations.push(event));
    const pending = adapter.inspectTurnBoundary(handle);
    await reading;
    if (race === "process_birth") harness.launches[0]!.processIdentity += "-replaced";
    else if (race === "continuation") {
      await adapter.repairContinuation(handle, {
        workAttemptId: handle.workAttemptId, expectedProviderContinuationId: "thread-1",
        checkpointedReplacementProviderContinuationId: "thread-repaired", cwd: request.cwd, launchPolicy: request.launchPolicy,
      }, { checkpointReplacement: async () => {} });
      assert.equal(handle.providerContinuationId, "thread-repaired");
    } else {
      harness.launches[0]!.resolveExit({ type: "exit", code: 0, signal: null });
      await flush();
      const replacement = await adapter.spawn(request);
      assert.notEqual(replacement, handle);
    }
    const factsBeforeReadCompletes = observations.length;
    const stateBeforeReadCompletes = handle.observedState();
    release();
    assert.deepEqual(await pending, { state: "unknown" });
    assert.equal(observations.length, factsBeforeReadCompletes);
    assert.equal(handle.observedState(), stateBeforeReadCompletes);
    assert.deepEqual(harness.signals, [], "inspection never kills or interrupts a raced provider");
    assert.equal(harness.launches.length, race === "owned_handle" ? 2 : 1, "only the test's explicit replacement may launch");
    subscription.dispose();
  });
}

for (const race of ["none", "permission", "connection", "birth", "active", "unknown", "reservation"] as const) {
  test(`idle replacement sends no signal after ${race} proof changes`, async () => {
    const harness = createHarness({ exitOnSignal: true });
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    client.request = async <T>(): Promise<T> => {
      if (race === "permission") client.pendingPermissions.set(22, { id: 22, method: "unknown/request", params: {}, connectionId: client.connectionEpoch });
      if (race === "connection") client.connectionEpoch = "replacement";
      if (race === "birth") harness.launches[0]!.processIdentity += "-replacement";
      return (race === "unknown" ? {} : { thread: { id: handle.providerContinuationId,
        status: { type: race === "active" ? "active" : "idle" },
        turns: race === "active" ? [{ id: "turn-live", status: "inProgress" }] : [] } }) as T;
    };
    let finalChecks = 0;
    const stopping = adapter.stopIdle(handle, () => {
      finalChecks += 1;
      if (race === "reservation") throw new Error("reservation changed");
    });
    if (race === "none") {
      assert.equal((await stopping).terminalCause, "stopped");
      assert.equal(finalChecks, 1);
      assert.deepEqual(harness.signals, [{ pid: handle.pid, signal: "SIGTERM" }]);
    } else {
      await assert.rejects(stopping, /not provably idle|reservation changed/);
      assert.deepEqual(harness.signals, []);
    }
  });
}

test("managed launch receipt freezes the exact generated tool policy and is never invented on attach", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest({ deliveryMode: "daemon_inbox", supervisorEntryId: "manifest_exact",
    supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact",
    supervisorWorkerSession: { agentSessionId: "session_exact", apiUrl: "letagents-local://rooms", roomCursor: null } });
  const route = request.supervisorWorkerSession!.apiUrl!;
  const expected = await adapter.describeManagedLaunchContract({ apiUrl: route });
  assert.match(expected!, /^[a-f0-9]{64}$/);
  const launch = harness.dependencies.launchServer;
  harness.dependencies.launchServer = (...args) => {
    request.supervisorWorkerSession!.apiUrl = "https://changed.example";
    return launch(...args);
  };
  const exact = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await exact.spawn(request) as ProviderHandle & { managedLaunchContract?: string };
  assert.equal(handle.managedLaunchContract, expected);
  assert.ok(harness.launchOptions[0]!.options.configOverrides[0]!.includes(route));
  assert.notEqual(await adapter.describeManagedLaunchContract({ apiUrl: "https://changed.example" }), expected);
  assert.equal(await adapter.describeManagedLaunchContract({ apiUrl: route, devMcpServerEntryPath: "/mutable/source.js" }), null);
  const restored = await new CodexProviderAdapter({ dependencies: harness.dependencies }).attach({
    workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!, providerConnection: handle.providerConnection,
  });
  assertProviderHandle(restored);
  assert.equal((restored as ProviderHandle & { managedLaunchContract?: string }).managedLaunchContract, undefined);
});

/** The access level every launch below runs under: the default policy of these tests is Full access. */
const FULL_ACCESS = { permissionProfileId: "full_access", configurationRevision: 1 };

test("the owner's own Codex setup reaches the app-server launch only for an exact request, and never for a rental", async () => {
  const supervised = { deliveryMode: "daemon_inbox" as const, supervisorEntryId: "supervised_owner",
    supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact", ...FULL_ACCESS };
  const launchOptions = async (overrides: Partial<ProviderSpawnRequest>) => {
    const harness = createHarness();
    await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest({ ...supervised, ...overrides }));
    return harness.launchOptions[0]!.options as Record<string, unknown>;
  };
  const off = await launchOptions({});
  assert.equal(Object.hasOwn(off, "homeHarness"), false, "an ordinary launch is handed exactly what it was before");
  for (const unclear of ["true", 1, false, null]) {
    assert.deepEqual(await launchOptions({ homeHarness: unclear as never }), off, String(unclear));
  }
  assert.deepEqual(await launchOptions({ homeHarness: true }), { ...off, homeHarness: true },
    "the room's own server, its environment and the working folder are the same either way");

  const rental = createHarness();
  await assert.rejects(new CodexProviderAdapter({ dependencies: rental.dependencies }).spawn(spawnRequest({
    ...supervised, supervisorEntryId: "supervised_rental_0123", homeHarness: true,
  })), /a rented agent never uses its owner's own setup/);
  assert.equal(rental.launches.length, 0, "nothing starts");

  // An agent that collects its own room messages could not be held back once the setup is turned off, so it never has it.
  for (const deliveryMode of [undefined, "mcp_polling"] as const) {
    const polling = createHarness();
    await assert.rejects(new CodexProviderAdapter({ dependencies: polling.dependencies }).spawn(spawnRequest({
      ...supervised, ...(deliveryMode ? { deliveryMode } : { deliveryMode: undefined }), homeHarness: true,
    })), /an agent that collects its own room messages never uses its owner's own setup/, String(deliveryMode));
    assert.equal(polling.launches.length, 0, "nothing starts");
  }
  // Its environment is cleared of the room agent's coordinates, so the room's server must be the one given its own copy.
  const unsupervised = createHarness();
  await assert.rejects(new CodexProviderAdapter({ dependencies: unsupervised.dependencies }).spawn(spawnRequest({ deliveryMode: "daemon_inbox", ...FULL_ACCESS, homeHarness: true })),
    /only as a daemon-supervised room agent/);
  assert.equal(unsupervised.launches.length, 0, "nothing starts");
  // Nor without a named access level: the launch is built from that level and from nothing else the policy holds.
  const unnamed = createHarness();
  await assert.rejects(new CodexProviderAdapter({ dependencies: unnamed.dependencies }).spawn(spawnRequest({
    ...supervised, permissionProfileId: undefined, homeHarness: true,
  })), /an agent with its owner's own setup starts only under a named access level/);
  assert.equal(unnamed.launches.length, 0, "nothing starts");
});

test("another MCP server's request for typed input or a sign-in is declined at once; approvals and the room's own server are left alone", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", supervisorEntryId: "supervised_owner",
    supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact", ...FULL_ACCESS, homeHarness: true }));
  const client = harness.clients[0]!; client.turnStatus = "inProgress";
  const method = "mcpServer/elicitation/request";
  const activity: string[] = [];
  // The background service keeps an agent's activity from its stream, so that is where each one must be.
  adapter.onStream(handle, (event) => { if (event.method === "mcpServer/elicitation/declined") activity.push(event.summary ?? ""); });
  const form = client.askPermission(mcpToolPermissionParams({ serverName: "owner_browser", _meta: null, message: "Which account?",
    requestedSchema: { type: "object", properties: { account: { type: "string" } }, required: ["account"] } }), 51, method);
  const signIn = client.askPermission({ threadId: "thread-1", turnId: "turn-thread-1", serverName: "owner_browser", mode: "url",
    url: "https://example.invalid/sign-in", elicitationId: "sign-in-1", message: "Sign in", _meta: null }, 52, method);
  // A tool approval from the owner's server waits for the owner, like the room's own.
  const ownerToolApproval = client.askPermission(mcpToolPermissionParams({ serverName: "owner_browser",
    message: 'Allow the owner_browser MCP server to run tool "owner_write"?' }), 53, method);
  const roomToolApproval = client.askPermission(mcpToolPermissionParams(), 54, method);
  // The room's server never asks for input; an unrecognised request of its own is not answered for it.
  const roomForm = client.askPermission(mcpToolPermissionParams({ _meta: {} }), 55, method);
  const command = client.askPermission(approvalParams(), 56);
  // A tool approval too large to show could never be answered either. From the owner's server it is turned down;
  // from the room's own it is left exactly as it always was.
  const oversized = { codex_approval_kind: "mcp_tool_call", persist: ["session"], tool_description: "Write", tool_params: { text: "x".repeat(30_000) } };
  const ownerOversized = client.askPermission(mcpToolPermissionParams({ serverName: "owner_browser", _meta: oversized }), 57, method);
  const roomOversized = client.askPermission(mcpToolPermissionParams({ _meta: oversized }), 58, method);
  assert.deepEqual(client.permissionResponses, [
    { request: form, result: { action: "decline", content: null, _meta: null } },
    { request: signIn, result: { action: "decline", content: null, _meta: null } },
    { request: ownerOversized, result: { action: "decline", content: null, _meta: null } },
  ]);
  assert.deepEqual(client.listPendingRequests(), [ownerToolApproval, roomToolApproval, roomForm, command, roomOversized]);
  // Each one is in the agent's activity, with whose request it was, and nothing else is reported as declined.
  assert.deepEqual(activity, [
    'Declined a request for typed input from your MCP server "owner_browser". LetAgents cannot show it.',
    'Declined a request for a sign-in from your MCP server "owner_browser". LetAgents cannot show it.',
    'Did not allow a tool of your MCP server "owner_browser". Its approval request was too large or malformed to show.',
  ]);
});

test("an agent that was re-attached still declines and reports an owner server's request nobody can answer", async () => {
  const harness = createHarness();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest({
    deliveryMode: "daemon_inbox", supervisorEntryId: "supervised_owner", supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact", ...FULL_ACCESS, homeHarness: true,
  }));
  // A fresh adapter, as after the background service restarts: it is not told about the switch again.
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await adapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
  assertProviderHandle(attached);
  const client = harness.clients[1]!; client.turnStatus = "inProgress";
  const activity: string[] = [];
  adapter.onStream(attached, (event) => { if (event.method === "mcpServer/elicitation/declined") activity.push(event.summary ?? ""); });
  const form = client.askPermission(mcpToolPermissionParams({ serverName: "owner_browser", _meta: null, message: "Which account?",
    requestedSchema: { type: "object", properties: { account: { type: "string" } }, required: ["account"] } }), 71, "mcpServer/elicitation/request");
  assert.deepEqual(client.permissionResponses, [{ request: form, result: { action: "decline", content: null, _meta: null } }]);
  assert.deepEqual(activity, ['Declined a request for typed input from your MCP server "owner_browser". LetAgents cannot show it.']);
});

const OWN_SETUP_LAUNCH = { deliveryMode: "daemon_inbox" as const, supervisorEntryId: "supervised_owner",
  supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact", ...FULL_ACCESS, homeHarness: true };
const REFUSAL = "This project's Codex config changes your MCP server \"owner_browser\", so LetAgents will not start Codex here with your own setup.";

/** A re-attach as the background service makes it after a restart: a fresh adapter, and a ref that carries the daemon's own record. */
async function launchedThenRestarted(spawn: Partial<ProviderSpawnRequest>, recordedOwnerSetup: boolean, harnessOptions: Parameters<typeof createHarness>[0] = {}) {
  const harness = createHarness({ exitOnSignal: true, processIdentity: "Mon Aug 31 08:00:00 2026", ...harnessOptions });
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest(spawn));
  const ref = { workAttemptId: first.workAttemptId, providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection,
    ...(recordedOwnerSetup ? { ownerSetup: true as const } : {}) };
  harness.commandLineReads.length = 0;
  return { harness, ref, adapter: new CodexProviderAdapter({ dependencies: harness.dependencies }) };
}
const attachRequests = (harness: ReturnType<typeof createHarness>) => harness.clients[1]!.requests.map((request) => request.method);
/** What makes a running Codex read the project's config again. */
const RELOADS = ["mcpServerStatus/list", "thread/start", "config/mcpServer/reload"];

test("an agent that never had its owner's setup is re-attached exactly as before, whatever its process looks like, and nothing is read off the process", async () => {
  // What a re-attach asked a running app-server before the owner's setup existed.
  const BEFORE = ["mcpServerStatus/list", "thread/read", "thread/resume", "thread/read"];
  for (const [shape, spawn, harnessOptions] of [
    // Started by an older build: no override that turns the owner's extensions off is on its command line.
    ["no isolation overrides on its command line", OWN_SETUP_LAUNCH, {}],
    ["every isolation override on its command line", { deliveryMode: "daemon_inbox" as const }, {}],
    // Nothing about the process is asked, so a process that cannot be read is no obstacle either.
    ["a process that cannot be read", { deliveryMode: "daemon_inbox" as const }, { processUnreadable: true }],
  ] as const) {
    const { harness, ref, adapter } = await launchedThenRestarted(spawn, false, harnessOptions);
    harness.changeProject(REFUSAL);
    const attached = await adapter.attach(ref);
    assertProviderHandle(attached);
    assert.equal(attached.ownerSetup, false, shape);
    assert.deepEqual(attachRequests(harness), BEFORE, shape);
    assert.deepEqual(harness.commandLineReads, [], `${shape}: the process's command line is never read`);
    assert.deepEqual(harness.liveChecks, [], `${shape}: the project is never inspected`);
    assert.deepEqual(harness.signals, [], `${shape}: nothing is stopped`);
    // Nor later: its conversation is repaired with no check at all.
    await adapter.repairContinuation(attached, {
      workAttemptId: attached.workAttemptId, expectedProviderContinuationId: attached.providerContinuationId!,
      cwd: spawnRequest().cwd, launchPolicy: spawnRequest().launchPolicy, forceReplacement: true,
    }, { checkpointReplacement: async () => {} });
    assert.deepEqual(harness.commandLineReads, [], shape);
    assert.deepEqual(harness.liveChecks, [], shape);
    assert.deepEqual(harness.signals, [], shape);
  }
});

test("re-attaching an agent the daemon started with its owner's setup never asks Codex to read the project again, and stops nothing", async () => {
  for (const [name, harnessOptions, projectChanged] of [
    ["the project is as it was", {}, false],
    ["the project changed since the agent started", {}, true],
    ["its command line cannot be read", { processUnreadable: true }, true],
    ["its command line claims it was started isolated", { commandLineClaimsIsolation: true }, true],
  ] as const) {
    const { harness, ref, adapter } = await launchedThenRestarted(OWN_SETUP_LAUNCH, true, harnessOptions);
    if (projectChanged) harness.changeProject(REFUSAL);
    const attached = await adapter.attach(ref);
    assertProviderHandle(attached);
    assert.equal(attached.ownerSetup, true, name);
    // The same re-attach as any agent's, without the one request that lists the MCP servers.
    assert.deepEqual(attachRequests(harness), ["thread/read", "thread/resume", "thread/read"], name);
    assert.deepEqual(attachRequests(harness).filter((method) => RELOADS.includes(method)), [], name);
    assert.deepEqual(harness.signals, [], `${name}: the agent keeps running, mid-turn or not`);
    assert.deepEqual(harness.commandLineReads, [], `${name}: no process is started to look at it`);
    assert.deepEqual(harness.liveChecks, [], name);
    assert.equal(harness.launches[0]!.alive, true, name);
  }
});

test("a process whose record cannot say how it was started is not asked to read its project again, and is otherwise an agent without the setup", async () => {
  for (const spawn of [OWN_SETUP_LAUNCH, { deliveryMode: "daemon_inbox" as const }]) {
    const { harness, ref, adapter } = await launchedThenRestarted(spawn, false, { processUnreadable: true });
    harness.changeProject(REFUSAL);
    const attached = await adapter.attach({ ...ref, ownerSetup: "unknown" });
    assertProviderHandle(attached);
    assert.deepEqual(attachRequests(harness), ["thread/read", "thread/resume", "thread/read"], "the list of MCP servers is left out");
    // Nothing else changes for it: it is not held to be an agent with the setup, and nothing is read or stopped.
    assert.equal(attached.ownerSetup, false);
    await adapter.repairContinuation(attached, {
      workAttemptId: attached.workAttemptId, expectedProviderContinuationId: attached.providerContinuationId!,
      cwd: spawnRequest().cwd, launchPolicy: spawnRequest().launchPolicy, forceReplacement: true,
    }, { checkpointReplacement: async () => {} });
    assert.deepEqual([harness.commandLineReads, harness.liveChecks, harness.signals], [[], [], []]);
  }
});

test("repairing a conversation never lets a Codex that has its owner's setup reload a project that changed since it started", async () => {
  const repair = async (spawn: Partial<ProviderSpawnRequest>, change: boolean, harnessOptions: Parameters<typeof createHarness>[0] = {}, reattachedAs?: boolean) => {
    const harness = createHarness({ exitOnSignal: true, processIdentity: "Mon Aug 31 08:00:00 2026", ...harnessOptions });
    let adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const request = spawnRequest(spawn);
    let handle = await adapter.spawn(request);
    // A launch says on its handle whether the process has the owner's setup.
    assert.equal(handle.ownerSetup, spawn.homeHarness === true);
    if (reattachedAs !== undefined) {
      // After a restart of the background service the adapter knows only what the daemon's ref tells it.
      adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
      const attached = await adapter.attach({ workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!,
        providerConnection: handle.providerConnection, ...(reattachedAs ? { ownerSetup: true as const } : {}) });
      assertProviderHandle(attached);
      handle = attached;
    }
    const client = harness.clients.at(-1)!;
    const before = client.requests.length;
    // What the daemon puts in the agent's activity, and how many stops had been sent when it was said.
    const told: Array<{ summary: string; stopsBefore: number }> = [];
    adapter.onStream(handle, (event) => {
      if (event.method === "ownerSetup/stopped") told.push({ summary: event.summary ?? "", stopsBefore: harness.signals.length });
    });
    if (change) harness.changeProject(REFUSAL);
    const outcome = await adapter.repairContinuation(handle, {
      workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
      cwd: request.cwd, launchPolicy: request.launchPolicy, forceReplacement: true,
    }, { checkpointReplacement: async () => {} }).then(() => null, (error: Error) => error);
    return { harness, handle, outcome, told, after: client.requests.slice(before).map((entry) => entry.method) };
  };
  const threadCalls = (methods: string[]) => methods.filter((method) => method === "thread/start" || method === "thread/resume");
  const refused = (result: Awaited<ReturnType<typeof repair>>, reason: RegExp, name: string) => {
    assert.match(result.outcome?.message ?? "", reason, name);
    assert.deepEqual(threadCalls(result.after), [], `${name}: no thread was started or loaded`);
    assert.deepEqual(result.harness.signals.map((signal) => signal.pid), [4100], `${name}: the process is stopped`);
    assert.equal(result.handle.observedState() === "idle" || result.handle.observedState() === "working", false, name);
    // The owner is told why in the agent's activity, once, before the process goes.
    assert.equal(result.told.length, 1, name);
    assert.match(result.told[0]!.summary, /^Stopped this agent\. /, name);
    assert.match(result.told[0]!.summary, reason, name);
    assert.equal(result.told[0]!.stopsBefore, 0, name);
  };

  const changed = await repair(OWN_SETUP_LAUNCH, true);
  refused(changed, /changes your MCP server "owner_browser"/, "the refusal names what the project changed");

  // A command line that cannot be read, as when `ps` does not answer in time: the project is not loaded on a guess.
  const unreadable = await repair(OWN_SETUP_LAUNCH, false, { processUnreadable: true });
  refused(unreadable, /could not read how this agent's Codex was started, so it stopped the agent before Codex could load the project's configuration with your own setup/, "unreadable");
  assert.deepEqual(unreadable.harness.liveChecks, [], "there is nothing to compare the project with");

  // LetAgents started this process with the owner's setup. A command line that says it is isolated is not believed.
  const spoofed = await repair(OWN_SETUP_LAUNCH, false, { commandLineClaimsIsolation: true });
  refused(spoofed, /is not running the way LetAgents started it, so LetAgents stopped the agent/, "a command line that claims isolation");
  assert.deepEqual(spoofed.harness.liveChecks, []);

  const same = await repair(OWN_SETUP_LAUNCH, false);
  assert.equal(same.outcome, null);
  assert.equal(same.after.includes("thread/start"), true);
  assert.deepEqual(same.harness.liveChecks.map((check) => check.cwd), [spawnRequest().cwd], "the project is inspected in the agent's own folder");
  assert.equal(same.harness.liveChecks[0]!.commandLine.includes("--listen"), true, "against what the process was started with");
  assert.deepEqual(same.harness.signals, []);
  assert.deepEqual(same.told, []);

  // A re-attached agent is checked when the daemon's record says it has the setup, and only then.
  refused(await repair(OWN_SETUP_LAUNCH, true, {}, true), /changes your MCP server "owner_browser"/, "re-attached, recorded as started with the setup");
  const recordedWithout = await repair(OWN_SETUP_LAUNCH, true, { processUnreadable: true }, false);
  assert.equal(recordedWithout.outcome, null, "re-attached, never recorded as having the setup: repaired as before");
  assert.deepEqual(recordedWithout.harness.commandLineReads, []);

  const isolated = await repair({ deliveryMode: "daemon_inbox" }, true, { processUnreadable: true });
  assert.equal(isolated.outcome, null, "an agent without its owner's setup is repaired exactly as before");
  assert.deepEqual(isolated.harness.liveChecks, []);
  assert.deepEqual(isolated.harness.commandLineReads, [], "and its process is never read");
  assert.equal(isolated.after.includes("thread/start"), true);
  assert.deepEqual(isolated.told, []);
});

// Options an earlier writer may have left in a stored policy. Codex takes each as a setting of the
// conversation, and each would undo part of what the owner's own setup promises.
const STORED_CODEX_OPTIONS: Array<[string, unknown, string]> = [
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

test("with the owner's own setup no stored Codex option reaches a conversation, at a start or a repair, and without it every one still does", async () => {
  const level = spawnRequest().launchPolicy as Record<string, unknown>;
  let agents = 0;
  const started = async (homeHarness: boolean, stored: Record<string, unknown>) => {
    const harness = createHarness({ exitOnSignal: true });
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    // Each start is another agent's first, so each is told what was left out.
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", supervisorEntryId: `supervised_stored_${agents += 1}`, supervisorSocketPath: "/tmp/daemon.sock",
      supervisorExecutionGenerationId: "execution_exact", ...FULL_ACCESS, launchPolicy: { ...level, ...stored }, ...(homeHarness ? { homeHarness: true } : {}) }));
    const client = harness.clients[0]!;
    const start = client.requests.find((request) => request.method === "thread/start")!.params as Record<string, unknown>;
    // A repair starts a second conversation on the same process, from the policy as it is stored.
    const before = client.requests.length;
    await adapter.repairContinuation(handle, {
      workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
      cwd: spawnRequest().cwd, launchPolicy: { ...level, ...stored }, forceReplacement: true,
    }, { checkpointReplacement: async () => {} });
    const repair = client.requests.slice(before).find((request) => request.method === "thread/start")!.params as Record<string, unknown>;
    return { start, repair, notices: handle.launchNotices ?? [] };
  };
  // What a conversation is given when nothing else is stored.
  const on = await started(true, {});
  const off = await started(false, {});
  assert.deepEqual(Object.keys(on.start).sort(), ["approvalPolicy", "approvalsReviewer", "historyMode", "sandbox"]);
  assert.deepEqual([on.start, on.repair, on.notices], [off.start, off.repair, []], "an agent with nothing else stored starts the same either way");
  for (const [option, value, what] of STORED_CODEX_OPTIONS) {
    const name = `${option} (${what})`;
    const withOption = await started(true, { [option]: value });
    assert.deepEqual(withOption.start, on.start, `${name}: not in the conversation the launch starts`);
    assert.deepEqual(withOption.repair, on.repair, `${name}: nor in one a repair starts`);
    assert.deepEqual(withOption.notices, [
      `With your own setup on, this agent starts with its access level's own Codex options only. These saved options were not used: ${JSON.stringify(option)}.`,
    ], name);
    // Without the owner's setup the option is passed on exactly as it always was.
    const passedOn = await started(false, { [option]: value });
    assert.deepEqual(passedOn.start, { ...off.start, [option]: value }, `${name}: unchanged without the owner's setup`);
    assert.deepEqual(passedOn.repair, { ...off.repair, [option]: value }, name);
    assert.deepEqual(passedOn.notices, [], name);
  }
});

test("a Codex agent is told which saved options were left out when they change, not at every start", async () => {
  const level = spawnRequest().launchPolicy as Record<string, unknown>;
  const told = async (agent: string, stored: Record<string, unknown>, own: Record<string, unknown> = OWN_SETUP_LAUNCH) => {
    const harness = createHarness({ exitOnSignal: true });
    const handle = await new CodexProviderAdapter({ dependencies: harness.dependencies })
      .spawn(spawnRequest({ ...own, supervisorEntryId: agent, launchPolicy: { ...level, ...stored } }));
    return handle.launchNotices ?? [];
  };
  const line = (...options: string[]) => [`With your own setup on, this agent starts with its access level's own Codex options only. These saved options were not used: ${options.map((option) => JSON.stringify(option)).join(", ")}.`];
  const secret = { mcp_servers: { evil: { command: "/repo/value-that-is-never-shown" } } };
  assert.deepEqual(await told("supervised_said_once", { config: secret }), line("config"), "its first start says it");
  assert.deepEqual(await told("supervised_said_once", { config: secret }), [], "the same again says nothing");
  assert.deepEqual(await told("supervised_said_once", { config: { other: true } }), [], "another value under the same name is not a change: names are all that is said");
  assert.deepEqual(await told("supervised_said_once", { config: secret, personality: "x" }), line("config", "personality"), "a change is said");
  assert.deepEqual(await told("supervised_said_once", {}), []);
  assert.deepEqual(await told("supervised_said_once", { config: secret, personality: "x" }), line("config", "personality"), "and so is the same set coming back");
  // A start without the owner's setup says nothing and is not counted as one that did.
  const { homeHarness: _on, ...without } = OWN_SETUP_LAUNCH;
  assert.deepEqual(await told("supervised_said_once", { config: secret, personality: "x" }, without), []);
  assert.deepEqual(await told("supervised_said_once", { config: secret, personality: "x" }), []);
  // What one agent was told says nothing about another.
  assert.deepEqual(await told("supervised_said_once_other", { config: secret, personality: "x" }), line("config", "personality"));
});

test("without the owner's setup nothing the room's server asks is declined, whatever its size or shape", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!; client.turnStatus = "inProgress";
  const method = "mcpServer/elicitation/request";
  const activity: string[] = [];
  // The background service keeps an agent's activity from its stream, so that is where each one must be.
  adapter.onStream(handle, (event) => { if (event.method === "mcpServer/elicitation/declined") activity.push(event.summary ?? ""); });
  const pending = [
    client.askPermission(mcpToolPermissionParams(), 61, method),
    client.askPermission(mcpToolPermissionParams({ _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { text: "x".repeat(30_000) } } }), 62, method),
    client.askPermission(mcpToolPermissionParams({ _meta: null, requestedSchema: { type: "object", properties: { a: { type: "string" } } } }), 63, method),
    client.askPermission(mcpToolPermissionParams({ mode: "url", url: "https://example.invalid", _meta: null }), 64, method),
    client.askPermission(approvalParams(), 65),
  ];
  assert.deepEqual(client.permissionResponses, []);
  assert.deepEqual(client.listPendingRequests(), pending);
  assert.deepEqual(activity, []);
});
