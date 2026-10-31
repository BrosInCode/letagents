// Shared fixtures for the claude-code-provider-adapter tests, split out of
// claude-code-provider-adapter.test.ts. It is not a test file: the *.test.ts glob does not match it.
import "./isolated-home.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_BACKGROUND_WORK_METHOD,
  CLAUDE_BACKGROUND_WORK_TEXT,
  ClaudeCodeProviderAdapter,
  type ClaudeCliChild,
  type ClaudeCodeProviderAdapterDependencies,
  type ClaudeCodeProviderAdapterOptions,
} from "../main/agents/claude-code-provider-adapter.js";
import type {
  ProviderSpawnRequest,
  ProviderActivityEvent,
  ProviderRoomTurnResult,
  ProviderStreamEvent,
  NativeExecutionObservation,
} from "../main/agents/provider-adapter.js";
import { CLAUDE_FAILURE_TEXT, CLAUDE_REAL_CAPTURES, claudeCapturedTask, realClaudeCapture } from "./claude-result-shapes.js";
import { type ProviderProcessExit } from "../main/agents/provider-evidence.js";

// Cross-layer assertions load the daemon at test runtime without pulling its
// separately compiled source tree into Electron's production rootDir.
export const { providerStreamLifecycle } = await import(new URL("../../daemon/provider-stream-policy.ts", import.meta.url).href);
export const { emptyExecutionProjection, reduceExecutionFact } = await import(new URL("../../daemon/execution-reducer.ts", import.meta.url).href);
export const { ProviderActionPortRouter } = await import(new URL("../../daemon/provider-action-port-router.ts", import.meta.url).href);
// What Chat shows of an agent's activity is decided in the renderer.
export const { humanFacingSupervisorActivitySummary, isHumanVisibleSupervisorActivity, supervisedAgentWorkIndicators } = await import(new URL("../../renderer/src/domain/managed-agents.ts", import.meta.url).href);
export const { ProviderSchedulerFailureCoordinator } = await import(new URL("../../daemon/provider-scheduler-failure-coordinator.ts", import.meta.url).href);
export const { redactCredentialText } = await import(new URL("../../daemon/credential-redaction.ts", import.meta.url).href);

// Fake-child harness proving the P2a adapter honors every #765 liveness
// invariant with no live `claude` binary: birth-identity fencing, control-loss
// is never death, recycled PIDs are never signalled, and startup failures
// leave no orphan.

export class FakeClaudeChild implements ClaudeCliChild {
  readonly lines: Array<(line: string) => void> = [];
  readonly disconnects: Array<() => void> = [];
  readonly written: string[] = [];
  intentionalClose = false;
  inputEnded = false;
  alive = true;
  /** Absent, as for every child but the one the default launch spawns; a test of the Windows stop sets it. */
  terminate?: ClaudeCliChild["terminate"];
  private resolveExited!: (exit: ProviderProcessExit) => void;
  readonly exited: Promise<ProviderProcessExit>;

  constructor(readonly pid: number | null) {
    this.exited = new Promise((resolve) => { this.resolveExited = resolve; });
  }

  onLine(listener: (line: string) => void): () => void {
    this.lines.push(listener);
    return () => {
      const index = this.lines.indexOf(listener);
      if (index >= 0) this.lines.splice(index, 1);
    };
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnects.push(listener);
    return () => {
      const index = this.disconnects.indexOf(listener);
      if (index >= 0) this.disconnects.splice(index, 1);
    };
  }

  writeLine(json: string): void {
    this.written.push(json);
  }

  endInput(): void {
    this.inputEnded = true;
  }

  markIntentionalClose(): void {
    this.intentionalClose = true;
  }

  emit(message: Record<string, unknown>): void {
    for (const listener of [...this.lines]) listener(JSON.stringify(message));
  }

  emitRaw(line: string): void {
    for (const listener of [...this.lines]) listener(line);
  }

  disconnect(): void {
    for (const listener of [...this.disconnects]) listener();
    this.disconnects.length = 0;
  }

  resolveExit(exit: ProviderProcessExit): void {
    this.alive = false;
    this.resolveExited(exit);
  }
}

export interface HarnessOptions {
  pid?: number | null;
  /** Force the init message's session id (to exercise identity-mismatch refusal). */
  initSessionId?: string;
  noInit?: boolean;
  noLetagents?: boolean;
  /** The servers the CLI reports, when a test needs more than the room's own. */
  mcpServers?: Array<Record<string, unknown>>;
  mcpStatus?: string;
  mcpTools?: string[];
  noApprovalLifecycle?: boolean;
  /** The mode the CLI reports it started in; an account without Auto reports another. */
  initPermissionMode?: string;
  bootstrapResultSubtype?: string;
  bootstrapMessages?: (sessionId: string, turnId: string) => Record<string, unknown>[];
  omitBootstrapResult?: boolean;
  exitAfterBootstrapResult?: ProviderProcessExit;
  /** Overrides per pid; undefined entries mean "cannot verify". */
  identities?: Map<number, string | null | undefined>;
  /** Defaults to true (a well-behaved CLI); fence tests opt out to exercise escalation. */
  dieOnSigterm?: boolean;
  versionOutput?: string;
  sessionRows?: Array<Record<string, unknown>>;
  /** The managed commit identity the work attempt resolves to. */
  commitEnvironment?: Record<string, string>;
}

export function argValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1]! : null;
}

export function birthIdentity(pid: number): string {
  return `fake-claude-${pid}-birth-1`;
}

export function createHarness(options: HarnessOptions = {}) {
  const children: FakeClaudeChild[] = [];
  const launches: Array<{ claudeBin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; ownerSetup?: true }> = [];
  const versionBins: string[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const identities = options.identities ?? new Map<number, string | null | undefined>();
  let nextPid = 4100;
  let mcpConfigDisposals = 0;
  let versionReads = 0;
  const commitRequests: ProviderSpawnRequest[] = [];
  const mcpConfigRequests: unknown[][] = [];

  const dependencies: ClaudeCodeProviderAdapterDependencies = {
    async readVersion(claudeBin) {
      versionReads += 1;
      versionBins.push(claudeBin);
      return options.versionOutput ?? "2.1.220 (Claude Code)";
    },
    async createLetAgentsMcpConfig(...received) {
      mcpConfigRequests.push(received);
      return {
        path: "/private/tmp/letagents-claude-mcp-test/mcp.json",
        async dispose() { mcpConfigDisposals += 1; },
      };
    },
    launchChild(input) {
      launches.push(input);
      const pid = options.pid === undefined ? nextPid++ : options.pid;
      const child = new FakeClaudeChild(pid);
      children.push(child);
      if (pid !== null && !identities.has(pid)) identities.set(pid, birthIdentity(pid));
      // Real-CLI semantics proven by the task_36 spike (msg_1382): init is only
      // emitted AFTER the first stdin user frame, and it echoes the minted
      // --session-id (or the SAME id under --resume).
      const initSessionId = options.initSessionId
        ?? argValue(input.args, "--resume")
        ?? argValue(input.args, "--session-id")
        ?? "sess-unexpected";
      const originalWriteLine = child.writeLine.bind(child);
      let sawFirstWrite = false;
      child.writeLine = (json: string) => {
        originalWriteLine(json);
        if (sawFirstWrite) return;
        sawFirstWrite = true;
        queueMicrotask(() => {
          if (!child.alive) return;
          if (!options.noInit) child.emit({
            type: "system",
            subtype: "init",
            session_id: initSessionId,
            model: "claude-fable-5",
            capabilities: options.noApprovalLifecycle ? [] : ["msg_lifecycle_v1"],
            permissionMode: options.initPermissionMode ?? "default",
            cwd: input.cwd,
            mcp_servers: options.mcpServers ?? (options.noLetagents ? [] : [{ name: "letagents", status: options.mcpStatus ?? "connected" }]),
            tools: options.mcpTools ?? ["mcp__letagents__get_board", "mcp__letagents__read_messages", "mcp__letagents__send_message"],
          });
          const frame = JSON.parse(json) as { uuid?: string };
          for (const message of options.bootstrapMessages?.(initSessionId, frame.uuid!) ?? []) child.emit(message);
          if (options.noInit || options.omitBootstrapResult) return;
          child.emit({
            type: "result",
            subtype: options.bootstrapResultSubtype ?? "success",
            is_error: options.bootstrapResultSubtype !== undefined,
            session_id: initSessionId,
            user_message_uuid: frame.uuid,
            result: "LETAGENTS_CLAUDE_DAEMON_READY",
          });
          if (options.exitAfterBootstrapResult) {
            if (options.exitAfterBootstrapResult.type === "exit" && pid !== null) identities.set(pid, null);
            child.resolveExit(options.exitAfterBootstrapResult);
          }
        });
      };
      return child;
    },
    signalProcess(pid, signal) {
      signals.push({ pid, signal });
      const child = children.find((entry) => entry.pid === pid);
      if (signal === "SIGKILL") {
        identities.set(pid, null);
        child?.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
      } else if (signal === "SIGTERM" && (options.dieOnSigterm ?? true)) {
        identities.set(pid, null);
        child?.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
      }
    },
    getProcessIdentity(pid) {
      return identities.get(pid);
    },
    observeProcessExit(pid, processIdentity) {
      return new Promise((resolve) => {
        const poll = () => {
          const current = identities.get(pid);
          if (current === null || (typeof current === "string" && current !== processIdentity)) {
            resolve({ type: "exit", code: null, signal: null });
            return;
          }
          setTimeout(poll, 5);
        };
        poll();
      });
    },
    async readSessionRows() {
      return options.sessionRows ?? [];
    },
    async resolveCommitEnvironment(req) {
      commitRequests.push(req);
      return options.commitEnvironment ?? {};
    },
    now: () => new Date(1_700_000_000_000).toISOString(),
  };

  return {
    children,
    launches,
    versionBins,
    signals,
    identities,
    dependencies,
    commitRequests,
    mcpConfigRequests,
    get mcpConfigDisposals() { return mcpConfigDisposals; },
    get versionReads() { return versionReads; },
  };
}

export function spawnRequest(over: Partial<ProviderSpawnRequest> = {}): ProviderSpawnRequest {
  return {
    workAttemptId: "wa-claude-1",
    roomId: "github.com/example/repo",
    agentDisplayName: "LanternRook",
    cwd: "/tmp/wa-claude-1",
    launchPolicy: { permissionMode: "acceptEdits" },
    deliveryMode: "daemon_inbox",
    ...over,
  };
}

export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

export function waitForChildOutput(child: ReturnType<typeof spawn>, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes(marker)) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onExit = () => { cleanup(); reject(new Error(`child exited before '${marker}'`)); };
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

// The evidence module's grace timers are deliberately unref'd; when a test's
// only pending work is such a timer the loop would drain, so hold it open.
export async function withLoopAlive<T>(work: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 20);
  try {
    return await work;
  } finally {
    clearInterval(keepAlive);
  }
}

export type ClaudeFixtureTasks = Array<{ id: string; title: string; leaseId: string; epoch: number }>;

/**
 * A real daemon supervising one Claude Code agent: the real adapter, action
 * router, delivery, execution capture and stores, over the fake CLI. Only the
 * room, the server and the processes are doubles.
 */
export async function claudeDaemonFixture(options: {
  /** The tasks the agent holds a work lease for. Without it the daemon has no way to ask, as before. */
  ownedTasks?: (input: { signal: AbortSignal }) => ClaudeFixtureTasks | Promise<ClaudeFixtureTasks>;
  /**
   * A follow-up turn for a task is dispatched without the wait it was scheduled with (ten seconds and
   * more). The waits that were asked for are kept, for a test to read.
   */
  skipFollowUpDelay?: boolean;
  /** The adapter's own waits, for a test that cannot wait as long as an agent does. */
  adapter?: Pick<ClaudeCodeProviderAdapterOptions, "backgroundSubagentWaitLimitMs" | "backgroundCommandWaitLimitMs" | "backgroundNoticeStartLimitMs" | "backgroundWorkNoticeEveryMs">;
} = {}) {
  const { SupervisorDaemon } = await import(new URL("../../daemon/main.ts", import.meta.url).href);
  const { WorkDurabilityStore } = await import(new URL("../../daemon/durability-store.ts", import.meta.url).href);
  const { DAEMON_PROTOCOL_VERSION } = await import(new URL("../../daemon/types.ts", import.meta.url).href);
  // The daemon's own endpoint: a socket file on POSIX, a named pipe with its proof on Windows.
  const { connectDaemon, daemonEndpoint } = await import(new URL("../../../../shared/daemon-endpoint.mjs", import.meta.url).href);
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(join(tmpdir(), "claude-daemon-"));
  const id = "claude_agent";
  const paths = {
    lockPath: join(root, "daemon.lock"), socketPath: daemonEndpoint(root).listenPath, peerProofPath: daemonEndpoint(root).proofPath,
    manifestPath: join(root, "daemon-state.sqlite"), auditPath: join(root, "audit.jsonl"),
    attemptsPath: join(root, "attempts.json"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root,
  };
  const request = (method: string, params?: unknown) => new Promise<{ ok: boolean; result?: any; error?: string }>((resolve, reject) => {
    const socket = connectDaemon(paths.socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
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

  /** The session file every process of this agent appends to and resumes from. */
  const sessionRows: Array<Record<string, unknown>> = [];
  /** How the fake CLI behaves. What a test changes here holds for each process that starts afterwards. */
  const cli: HarnessOptions = { sessionRows };
  const harness = createHarness(cli);
  /** Whether the session file is found where the CLI keeps it, and where the adapter looked for it. */
  const transcript = { found: true, readFrom: [] as Array<string | undefined> };
  harness.dependencies.readSessionRows = async (_sessionId, transcriptsRoot) => {
    transcript.readFrom.push(transcriptsRoot);
    return transcript.found ? sessionRows : null;
  };
  /** Every room turn a process was asked to run: the frame after its bootstrap, and each one after that. */
  const turns: Array<{ id: string; child: FakeClaudeChild }> = [];
  const launchChild = harness.dependencies.launchChild;
  harness.dependencies.launchChild = (input) => {
    const child = launchChild(input) as FakeClaudeChild;
    const write = child.writeLine.bind(child);
    let bootstrapped = false;
    child.writeLine = (json: string) => {
      const frame = JSON.parse(json) as { type?: string; uuid?: string };
      if (!bootstrapped) bootstrapped = true;
      else if (frame.type === "user" && frame.uuid) turns.push({ id: frame.uuid, child });
      write(json);
    };
    return child;
  };
  /** What a test makes the adapter's reading back of a turn wait on, and what the daemon asked of it. */
  const recovery = { held: null as Promise<void> | null, requests: [] as Array<Record<string, unknown>> };
  /** What a test makes the first saving of a turn's result fail with. */
  let failNextResultCheckpoint: Error | null = null;
  const makeAdapter = () => {
    const adapter = new ClaudeCodeProviderAdapter({ ...options.adapter, dependencies: { ...harness.dependencies, now: () => new Date().toISOString() } });
    const recover = adapter.recoverRoomTurn!.bind(adapter);
    adapter.recoverRoomTurn = async (handle, turn, options) => {
      recovery.requests.push({ ...turn });
      await recovery.held;
      return recover(handle, turn, options);
    };
    const run = adapter.runRoomTurn!.bind(adapter);
    adapter.runRoomTurn = (handle, turn, options = {}) => run(handle, turn, { ...options, checkpointTerminalResult: async (result) => {
      const failure = failNextResultCheckpoint;
      failNextResultCheckpoint = null;
      if (failure) throw failure;
      return options.checkpointTerminalResult!(result);
    } });
    return adapter;
  };
  let adapter = makeAdapter();
  const roomMessages: Array<Record<string, unknown>> = [];
  const published: string[] = [];
  let mints = 0;
  /** The waits that follow-up turns were scheduled with, when a test has them skipped. */
  const followUpWaits: number[] = [];
  const skipFollowUpDelay = <Daemon>(made: Daemon): Daemon => {
    if (!options.skipFollowUpDelay) return made;
    // Delivery waits for its polls and for a follow-up's delay with the same function. The polls of this
    // fixture wait a fraction of a second; only a follow-up is scheduled seconds ahead. The inbox hands a
    // follow-up out when its own clock has reached the scheduled time, so that clock is moved ahead by
    // the wait that was asked for: for the daemon the time has passed.
    const internals = made as unknown as {
      supervisedDelivery: { waitForPollDelay: (delayMs: number, signal: AbortSignal) => Promise<void> };
      supervisedInbox: { now: () => string };
    };
    const wait = internals.supervisedDelivery.waitForPollDelay;
    let ahead = 0;
    internals.supervisedInbox.now = () => new Date(Date.now() + ahead).toISOString();
    internals.supervisedDelivery.waitForPollDelay = async (delayMs, signal) => {
      if (delayMs < 5_000) return wait(delayMs, signal);
      followUpWaits.push(delayMs);
      ahead += delayMs;
    };
    return made;
  };
  const makeDaemon = () => skipFollowUpDelay(new SupervisorDaemon(paths, "darwin", new ProviderActionPortRouter({ "claude-code": async () => adapter }), true,
    50, undefined, {}, {
      poll: async ({ afterMessageId, signal }: { afterMessageId: string | null; signal: AbortSignal }) => {
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
      ...(options.ownedTasks ? { ownedTasks: async (input: { signal: AbortSignal }) => options.ownedTasks!(input) } : {}),
    }, {
      listWorkLeases: async () => [], readWorkLease: async () => null,
      attestWorkLease: async () => { throw new Error("unused"); },
      rebindWorkLease: async () => { throw new Error("unused"); },
      createWorkerSession: async () => {
        mints += 1;
        return { sessionId: `${id}-session`, bearer: `${id}-bearer-${mints}`, bearerId: `${id}-bearer-id-${mints}`,
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() };
      },
    }));
  let daemon = makeDaemon();
  const read = <T>(sql: string): T[] => {
    const database = new DatabaseSync(paths.manifestPath, { readOnly: true });
    try { return database.prepare(sql).all(id).map((row) => ({ ...row })) as T[]; } finally { database.close(); }
  };
  const cleanup = async () => {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  };
  type Receipt = { inbox_item_id: string; source_message_id: string; state: string; last_error: string | null; provider_turn_id: string | null };
  const inbox = () => (daemon as unknown as { supervisedInbox: {
    bootstrapCursor(input: { agent_id: string; room_id: string; last_observed_message_id: string | null }): Promise<unknown>;
    receipts(agentId: string): Promise<Receipt[]>;
  } }).supervisedInbox;
  const startDaemon = async () => {
    await daemon.start();
    (daemon as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const generation = (await request("daemon.status")).result.generation;
    return async () => assert.equal((await request("supervisor.install_host_grant", {
      entry_id: id, room_id: "room_1", agent_key: "owner/agent", grant_id: `grant-${id}`,
      supervisor_grant: `${id}-parent`, grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    })).ok, true);
  };
  try {
    const installGrant = await startDaemon();
    assert.equal((await request("manifest.put", { entry: {
      id, room_id: "room_1", display_name: "Agent", provider: "claude-code", model: null, charter: "test",
      desired_state: "running", observed_state: "absent", condition: "none", permission_profile_id: null,
      created_by: "test", created_at: "2026-01-01T00:00:00.000Z", delivery_mode: "daemon_inbox",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    await inbox().bootstrapCursor({ agent_id: id, room_id: "room_1", last_observed_message_id: null });
    await installGrant();
    const view = async () => (await request("manifest.list")).result[0] as {
      observed_state: string; condition: string; last_error: string | null; work_attempt_id: string;
      provider_ref: { provider_continuation_id: string; execution_generation_id: string };
      room_agent_state: { ingress: { state: string }; inbox: { state: string; detail: string | null }; turn: { state: string } };
      activity: Array<{ kind: string; method: string; summary: string; status: string }>;
    };
    await eventually(() => harness.children.length === 1, "the CLI is launched");
    await eventually(async () => (await view())?.room_agent_state?.ingress.state === "observing", "the agent listens to its room");
    const sessionId = (await view()).provider_ref.provider_continuation_id;
    const receipt = async (messageId: string) => (await inbox().receipts(id)).find((item) => item.source_message_id === messageId);
    /** Send the agent its nth room message. */
    const send = (ordinal: number) => {
      roomMessages.push({ id: `msg_${ordinal}`, sender: "someone", text: `request ${ordinal}`, activation: { for_current_agent: { decision: "activate" } } });
    };
    /** Send the agent its nth room message and wait until its process has been asked to run the turn. */
    const begin = async (ordinal: number) => {
      send(ordinal);
      await eventually(async () => turns.length === ordinal && Boolean((await receipt(`msg_${ordinal}`))?.provider_turn_id), `msg_${ordinal} starts its turn`).catch(async (error) => {
        const current = await view();
        throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error}); inbox ${current.room_agent_state.inbox.state} (${current.room_agent_state.inbox.detail})`);
      });
      return turns[ordinal - 1]!;
    };
    return { id, harness, cli, request, eventually, view, read, published, roomMessages, turns, sessionRows, sessionId, receipt, send, begin, cleanup, recovery, transcript,
      followUpWaits,
      /** The owner stops the turn of a room message, as the desktop asks the daemon to. */
      stopTurn: async (messageId: string, turn: { id: string }) => {
        const entry = await view();
        return request("manifest.control_turn", { id, daemon_generation: (await request("daemon.status")).result.generation, room_id: "room_1",
          work_attempt_id: entry.work_attempt_id, execution_generation_id: entry.provider_ref.execution_generation_id,
          provider_continuation_id: entry.provider_ref.provider_continuation_id, provider_turn_id: turn.id,
          inbox_item_id: (await receipt(messageId))!.inbox_item_id, source_message_id: messageId, action_id: `stop-${messageId}`, action_sequence: 1 });
      },
      receipts: () => inbox().receipts(id),
      /** The CLI reports that the turn has started. */
      reportStarted: (turn: { id: string; child: FakeClaudeChild }) =>
        turn.child.emit({ type: "command_lifecycle", state: "started", command_uuid: turn.id, session_id: sessionId }),
      /** The CLI reports the turn's result. */
      answer: (turn: { id: string; child: FakeClaudeChild }, text: string) =>
        turn.child.emit({ type: "result", subtype: "success", is_error: false, session_id: sessionId, user_message_uuid: turn.id, result: text }),
      /** The agent's newest process ends now, as it does when it crashes. */
      exitProcess: () => {
        const child = harness.children.at(-1)!;
        harness.identities.set(child.pid!, null);
        child.resolveExit({ type: "exit", code: 1, signal: null });
      },
      /** The first saving of the next turn result fails, as it does when the daemon dies between the result and its checkpoint. */
      failNextResultCheckpoint: (error: Error) => { failNextResultCheckpoint = error; },
      /** From here on the reading back of a saved turn waits until the returned function lets it go. */
      holdRecovery: () => {
        let release!: () => void;
        recovery.held = new Promise<void>((resolve) => { release = resolve; });
        return () => { recovery.held = null; release(); };
      },
      /**
       * The daemon ends and a new one, with a new adapter, takes the agent over. `whileNoDaemonRuns` is what
       * happens in between, when nothing can react to it: a process that ends then is found ended by the new
       * daemon, and no daemon launches a replacement that the new one would have to fence first.
       */
      restartDaemon: async (whileNoDaemonRuns: () => void = () => {}) => {
        await daemon.stop();
        whileNoDaemonRuns();
        adapter = makeAdapter();
        daemon = makeDaemon();
        await (await startDaemon())();
      },
      /** The turns in the agent's execution record, and whether the record has a gap. */
      recorded: () => ({
        turns: read<{ provider_turn_id: string; state: string }>("SELECT provider_turn_id,state FROM execution_turns WHERE agent_id=? ORDER BY created_at_ms,rowid"),
        endings: read<{ provider_turn_id: string; n: number; outcome: string | null }>(`SELECT t.provider_turn_id, COUNT(*) AS n, MIN(f.turn_outcome) AS outcome
          FROM execution_facts f JOIN execution_turns t USING(turn_id)
          WHERE f.agent_id=? AND f.domain='turn' AND f.state='terminal' GROUP BY t.provider_turn_id ORDER BY MIN(f.sequence)`),
        gaps: read<{ last: number; max: number }>("SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")
          .filter((observer) => observer.max !== observer.last).length,
      }) };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** What a Claude session holds of a turn whose process ended under it. */
export const CLAUDE_SESSION_AFTER_EXIT = {
  "its answer": (sessionId: string, turnId: string, ordinal: number) => [
    { type: "user", uuid: turnId, sessionId, message: { content: [{ type: "text", text: "request" }] } },
    { type: "assistant", sessionId, message: { id: `assistant-${ordinal}`, stop_reason: "end_turn", content: [{ type: "text", text: `Recovered ${ordinal}.` }] } }],
  "half an answer": (sessionId: string, turnId: string, ordinal: number) => [
    { type: "user", uuid: turnId, sessionId, message: { content: [{ type: "text", text: "request" }] } },
    { type: "assistant", sessionId, message: { id: `assistant-${ordinal}`, stop_reason: null, content: [{ type: "text", text: "Half of" }] } }],
  "a tool call that never returned": (sessionId: string, turnId: string, ordinal: number) => [
    { type: "user", uuid: turnId, sessionId, message: { content: [{ type: "text", text: "request" }] } },
    { type: "assistant", sessionId, message: { id: `assistant-${ordinal}`, stop_reason: "tool_use", content: [{ type: "tool_use", id: `tool-${ordinal}`, name: "Bash", input: {} }] } }],
  "a transcript that holds nothing of the turn": () => [],
  // The shape Claude Code 2.1.278 writes when it gives up on a request the provider refused.
  "the provider's error": (sessionId: string, turnId: string, ordinal: number) => [
    { type: "user", uuid: turnId, sessionId, message: { role: "user", content: [{ type: "text", text: "request" }] } },
    { type: "assistant", uuid: `api-error-${ordinal}`, parentUuid: turnId, sessionId, isApiErrorMessage: true, apiErrorStatus: 400, error: "unknown",
      message: { id: `synthetic-${ordinal}`, role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
        content: [{ type: "text", text: "API Error: 400 LOCAL_PROVIDER_FAILURE_1517" }] } }],
} as const;

/** Wait until the adapter has written the next frame to the CLI, and return the turn id it carries. */
export async function nextClaudeTurnId(child: FakeClaudeChild, writtenBefore: number): Promise<string> {
  for (let tick = 0; child.written.length <= writtenBefore; tick += 1) {
    if (tick > 2_000) throw new Error("the adapter did not write the turn to the CLI");
    await new Promise((resolve) => setImmediate(resolve));
  }
  return (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
}

/** A provider failure as the daemon shows it to the owner: one line, credentials removed, at most 1024 characters. */
export function shownToOwner(error: unknown): string {
  return redactCredentialText(String(error).replace(/[\t\n\r ]+/g, " ").trim(), 1_024).value;
}

export const HELD_TASK = { id: "task_1", title: "Existing work", leaseId: "lease-1", epoch: 2 };

/** What a task holder gets after each of these failures that Claude Code names `invalid_request`, whichever way the daemon learns of it. */
export const CLAUDE_INVALID_REQUEST_OUTCOMES = {
  // The request cannot succeed as it was sent: nothing is queued, and Claude's own text stays on the message.
  tool_history_mismatch: { then: "settled", reads: CLAUDE_FAILURE_TEXT.cannotSucceed },
  // The owner can put the key right, and Retry delivery then continues the task.
  api_key_authentication_disabled: { then: "blocked", reads: CLAUDE_FAILURE_TEXT.authentication },
  // The context is full: the follow-up shows Claude's text and what a new conversation costs.
  context_blocking_limit: { then: "blocked", reads: CLAUDE_FAILURE_TEXT.conversation },
} as const;

/** What a Claude session can hold of a turn that completed with an empty answer. */
export const CLAUDE_SESSION_WITHOUT_ANSWER = {
  // The rows Claude Code 2.1.278 really wrote: the request, and its own note that the reply had no visible output.
  "what the CLI really wrote": (sessionId: string, turnId: string) =>
    realClaudeCapture(CLAUDE_REAL_CAPTURES.completed_without_answer!, sessionId, turnId).session,
  "a last row that ends the turn with thinking only": (sessionId: string, turnId: string) => [
    { type: "user", uuid: turnId, sessionId, message: { role: "user", content: [{ type: "text", text: "request" }] } },
    { type: "assistant", sessionId, message: { id: "assistant-thinking", role: "assistant", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "private" }] } }],
} as const;

/**
 * What a Claude session holds of a turn whose first reply had no visible output, when its process ended before
 * the turn's result was seen. The request and the CLI's note asking for output are the rows Claude Code
 * 2.1.278 really wrote.
 */
export const CLAUDE_SESSION_AFTER_A_REPLY_WITHOUT_OUTPUT = (sessionId: string, turnId: string, ended: "after the model answered" | "before the model answered" | "before the CLI asked for output") => {
  const [request, askForOutput] = realClaudeCapture(CLAUDE_REAL_CAPTURES.completed_without_answer!, sessionId, turnId).session;
  return [request!,
    { type: "assistant", sessionId, message: { id: "assistant-thinking", role: "assistant", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "private" }] } },
    ...(ended === "before the CLI asked for output" ? [] : [askForOutput!]),
    ...(ended === "after the model answered" ? [{ type: "assistant", sessionId, message: { id: "assistant-answer", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "REAL ANSWER" }] } }] : [])];
};

/** The messages of a real capture's session, or the first of them, for this session and this turn. */
export const realClaudeSession = (name: string, first?: number) => (sessionId: string, turnId: string) =>
  realClaudeCapture(CLAUDE_REAL_CAPTURES[name]!, sessionId, turnId).session.slice(0, first);
/** Every row of a real capture's session file that has an id, as the daemon reads the file. */
export const realClaudeSessionFile = (name: string) => (sessionId: string, turnId: string) =>
  realClaudeCapture(CLAUDE_REAL_CAPTURES[name]!, sessionId, turnId).session_file;

/**
 * What must reach the room for a Claude turn whose process ended under it, by what its session holds. The rows
 * are those Claude Code 2.1.278 really wrote, but where a line says otherwise. `posted` is the turn's reply: its
 * own answer and, for a turn that started background work, the answers to the notices of that work. Null is a
 * turn for which no answer is proven: it was cut off, and nothing is posted.
 */
export const CLAUDE_SESSION_READ_BACK: Record<string, { rows: (sessionId: string, turnId: string) => Array<Record<string, unknown>>; posted: string | null }> = {
  "a Stop hook's refusal of an answer, and the answer after it": { posted: "ANSWER AFTER THE HOOK", rows: realClaudeSession("stop_hook_refuses_end_once") },
  "an answer and a Stop hook's refusal of it": { posted: null, rows: realClaudeSession("stop_hook_refuses_end_once", 3) },
  "its answer, then a background command's notice and the CLI's answer to the notice": { posted: "ANSWER OF THE TURN\n\nANSWER TO THE TASK NOTICE", rows: realClaudeSession("background_command") },
  "its answer, then a sub-agent's notice and the CLI's answer to the notice": { posted: "ANSWER OF THE TURN\n\nANSWER TO THE TASK NOTICE", rows: realClaudeSession("subagent_in_background") },
  // The flow in which the session is read: the process ended, and the one that replaced it has written its first
  // prompt before the turn is read. Real rows of a session that the CLI was started for a second time.
  "its answer, then the first prompt of the process that resumed the session, and that prompt's answer": { posted: "ANSWER OF THE TURN", rows: realClaudeSessionFile("resumed_session") },
  // The same rows as a CLI writes them that does not mark its prompts: every captured row is of Claude Code 2.1.278,
  // and the app allows older ones. The turn's own request row has no mark, so the earlier rule reads the session.
  "its answer, then the first prompt of the process that resumed the session, in a session whose prompts carry no mark": { posted: "ANSWER OF THE TURN",
    rows: (sessionId, turnId) => realClaudeSessionFile("resumed_session")(sessionId, turnId).map(({ promptSource: _source, turnOrigin: _turn, ...row }) => row) },
  "its answer, then a prompt and that prompt's answer, in the simplest session whose prompts carry no mark": { posted: "PROBE_OK",
    rows: (sessionId, turnId) => [...realClaudeSession("completed_answer")(sessionId, turnId), ...realClaudeSession("resumed_session")(sessionId, turnId).slice(2)].map(({ promptSource: _source, turnOrigin: _turn, ...row }) => row) },
  // A compaction that no command made, after the turn's answer: the real boundary and summary rows, with the boundary
  // saying that it was automatic. No capture holds one, so it is read as it was before: the answer before the summary.
  "its answer, then an automatic compaction's boundary and summary": { posted: "ANSWER OF THE TURN",
    rows: (sessionId, turnId) => realClaudeSessionFile("compaction_by_command")(sessionId, turnId).slice(0, 11)
      .map((row) => row.subtype === "compact_boundary" ? { ...row, compactMetadata: { trigger: "auto" } } : row) },
  // Rows that start another command end the turn: its answer is proven.
  "its answer, then a second prompt and that prompt's answer": { posted: "ANSWER OF THE TURN",
    rows: (sessionId, turnId) => realClaudeSessionFile("compaction_by_command")(sessionId, turnId).filter((row) => row.type === "assistant" || row.promptSource === "sdk") },
  "its answer, then the rows of the CLI's own command /compact, and a second prompt": { posted: "ANSWER OF THE TURN", rows: realClaudeSessionFile("compaction_by_command") },
  "a hook's denial of a tool call as that call's result, and the answer after it": { posted: "ANSWER OF THE TURN", rows: realClaudeSessionFile("hook_denies_tool_call") },
  "a hook's words after a tool call, and the answer after them": { posted: "ANSWER OF THE TURN", rows: realClaudeSessionFile("hook_feedback_after_tool_call") },
  "a skill's text, and the answer after it": { posted: "ANSWER OF THE TURN", rows: realClaudeSession("skill_call") },
  // Claude Code 2.1.278 keeps a sub-agent's rows in a file of their own. In these two they stand in the session file, after the call that started it.
  "a sub-agent's report after its tool call, and no answer of its own": { posted: null,
    rows: (sessionId, turnId) => {
      const { session, subagent_session } = realClaudeCapture(CLAUDE_REAL_CAPTURES.subagent_in_foreground!, sessionId, turnId);
      return [...session.slice(0, 2), subagent_session!.at(-1)!];
    } },
  "a sub-agent's prompt and report among its rows, and its own answer after them": { posted: "ANSWER OF THE TURN",
    rows: (sessionId, turnId) => {
      const { session, subagent_session } = realClaudeCapture(CLAUDE_REAL_CAPTURES.subagent_in_foreground!, sessionId, turnId);
      return [...session.slice(0, 2), ...subagent_session!, ...session.slice(2)];
    } },
  // The last rows of these two are written by hand: no capture holds, in a room turn, a user row that is neither the turn going on nor the start of another command.
  // Such a row can be the turn going on: then the message that ended before it is an interim one, and is not posted as the answer.
  "a message that ended, then a row that is not known": { posted: null,
    rows: (sessionId, turnId) => [...realClaudeSession("completed_answer")(sessionId, turnId),
      { type: "user", uuid: "another-row", isMeta: true, sessionId, message: { role: "user", content: "A note the CLI wrote." } }] },
  "a row that is not known, and a message that ended after it": { posted: null,
    rows: (sessionId, turnId) => [...realClaudeSession("completed_answer", 1)(sessionId, turnId),
      { type: "user", uuid: "another-row", isMeta: true, sessionId, message: { role: "user", content: "A note the CLI wrote." } },
      { type: "assistant", sessionId, message: { id: "message-after", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "A MESSAGE THAT MAY BE ANOTHER TURN'S" }] } }] },
};

export const TURNS_ANSWER = "ANSWER OF THE TURN";
export const NOTICE_ANSWER = "ANSWER TO THE TASK NOTICE";
/**
 * What the model wrote for the room in each real capture where the CLI wrote more than a request and an answer:
 * the turn's own answer, then its answer to the notice of each background task that the turn started. The room
 * gets these as one reply. A sub-agent's report is never among them.
 */
export const CLAUDE_STREAMS_WITH_MORE_THAN_AN_ANSWER: Record<string, readonly string[]> = {
  stop_hook_refuses_end_once: ["ANSWER AFTER THE HOOK"],
  background_command: [TURNS_ANSWER, NOTICE_ANSWER],
  subagent_in_background: [TURNS_ANSWER, NOTICE_ANSWER],
  subagent_in_foreground: [TURNS_ANSWER],
  // The sub-agent failed. The model was told so, and answered.
  subagent_api_error: [TURNS_ANSWER, NOTICE_ANSWER],
  skill_call: [TURNS_ANSWER],
  // One notice and one answer for each task.
  two_background_commands: [TURNS_ANSWER, "ANSWER TO THE FIRST TASK NOTICE", "ANSWER TO THE SECOND TASK NOTICE"],
  two_subagents_in_background: [TURNS_ANSWER, "ANSWER TO THE FIRST TASK NOTICE", "ANSWER TO THE SECOND TASK NOTICE"],
  // Both notices went to the model in one request. The CLI wrote a result for each: an empty one, and the answer.
  two_background_commands_end_together: [TURNS_ANSWER, "ANSWER TO THE FIRST TASK NOTICE"],
  // The command failed. The model was told so, and answered.
  background_command_fails: [TURNS_ANSWER, NOTICE_ANSWER],
  // The model wrote nothing about the notice, twice.
  background_command_notice_answer_empty: [TURNS_ANSWER],
  // The request that held the notice failed at the provider. The turn ends with what it has, and says so.
  background_command_notice_api_error: [TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.notReported],
  // The task ended while the turn still ran, and the turn's last request took its notice. No answer to a notice follows.
  task_ends_while_turn_goes_on: ["ANSWER OF THE TURN, TO A REQUEST THAT HOLDS THE TASK NOTICE"],
  // The second task ended while the first notice was answered, and that answer's last request took both notices.
  task_ends_while_notice_is_answered: [TURNS_ANSWER, "ANSWER NUMBER 1 AFTER THE TURN, TO A REQUEST THAT HOLDS 2 TASK NOTICES"],
  // An interrupt that reaches the CLI when no turn runs stops nothing: the command ends later, and its notice is answered.
  background_command_running_at_interrupt: [TURNS_ANSWER, NOTICE_ANSWER],
  // An interrupt that reaches the CLI while it answers the notice ends that answer.
  interrupt_during_task_notice_answer: [TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.notReported],
  // The model is not told of a command that was stopped. It is told of a sub-agent that was.
  background_command_stopped_by_request: [TURNS_ANSWER],
  background_command_running_at_input_close: [TURNS_ANSWER],
  subagent_stopped_by_request: [TURNS_ANSWER, NOTICE_ANSWER],
  // A sub-agent and a command in one turn. Both end, each in its time, and each notice is answered.
  subagent_and_background_command: [TURNS_ANSWER, "ANSWER TO THE FIRST TASK NOTICE", "ANSWER TO THE SECOND TASK NOTICE"],
  // A hook of another kind than Stop: it adds a line to the prompt, denies the tool call, or has words for the model after the call.
  hook_adds_context_to_prompt: [TURNS_ANSWER],
  hook_denies_tool_call: [TURNS_ANSWER],
  hook_feedback_after_tool_call: [TURNS_ANSWER],
  // The tool wrote in the run's folder, and the recorder's sandbox denied its write beside it.
  write_outside_run_folder_denied: [TURNS_ANSWER],
  // Two commands of one message. The task that started first ended last: each answer is added in the order of the notices.
  two_background_commands_end_in_the_other_order: [TURNS_ANSWER, "ANSWER TO THE FIRST TASK NOTICE", "ANSWER TO THE SECOND TASK NOTICE"],
  // The turn stopped its own background command. The model is told of no end of it, and the turn is not held open.
  background_command_stopped_by_the_turn: [TURNS_ANSWER],
};

/**
 * What is posted for each real turn that started background work when its process ended before the adapter saw
 * the turn's result, and the session file holds all that the CLI wrote: the model's texts, and after them the
 * one line of the adapter's when the file does not prove the reply complete. Where it does, the reply is the
 * one that the room gets from the stream (`CLAUDE_STREAMS_WITH_MORE_THAN_AN_ANSWER`).
 */
export const CLAUDE_BACKGROUND_WORK_READ_BACK: Record<string, readonly string[]> = {
  background_command: [TURNS_ANSWER, NOTICE_ANSWER],
  subagent_in_background: [TURNS_ANSWER, NOTICE_ANSWER],
  subagent_api_error: [TURNS_ANSWER, NOTICE_ANSWER],
  two_background_commands: [TURNS_ANSWER, "ANSWER TO THE FIRST TASK NOTICE", "ANSWER TO THE SECOND TASK NOTICE"],
  two_subagents_in_background: [TURNS_ANSWER, "ANSWER TO THE FIRST TASK NOTICE", "ANSWER TO THE SECOND TASK NOTICE"],
  two_background_commands_end_together: [TURNS_ANSWER, "ANSWER TO THE FIRST TASK NOTICE"],
  background_command_fails: [TURNS_ANSWER, NOTICE_ANSWER],
  background_command_running_at_interrupt: [TURNS_ANSWER, NOTICE_ANSWER],
  subagent_stopped_by_request: [TURNS_ANSWER, NOTICE_ANSWER],
  subagent_and_background_command: [TURNS_ANSWER, "ANSWER TO THE FIRST TASK NOTICE", "ANSWER TO THE SECOND TASK NOTICE"],
  // The notice went to the model with a request that was running. The file holds that, so the reply is proven complete.
  task_ends_while_turn_goes_on: ["ANSWER OF THE TURN, TO A REQUEST THAT HOLDS THE TASK NOTICE"],
  task_ends_while_notice_is_answered: [TURNS_ANSWER, "ANSWER NUMBER 1 AFTER THE TURN, TO A REQUEST THAT HOLDS 2 TASK NOTICES"],
  // The CLI kept a second prompt until the answer to the notice had ended: that answer is the turn's.
  prompt_during_task_notice_answer: [TURNS_ANSWER, NOTICE_ANSWER],
  // The file holds the notice, and no answer to it that ended: an empty answer, the provider's error, an interrupt.
  background_command_notice_answer_empty: [TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.notReported],
  background_command_notice_api_error: [TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.notReported],
  interrupt_during_task_notice_answer: [TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.notReported],
  interrupt_during_task_notice_answer_then_prompt: [TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.notReported],
  approval_in_task_notice_answer_interrupted: [TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.notReported],
  approval_in_task_notice_answer_denied_and_interrupted: [TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.notReported],
  two_background_commands_end_in_the_other_order: [TURNS_ANSWER, "ANSWER TO THE FIRST TASK NOTICE", "ANSWER TO THE SECOND TASK NOTICE"],
  // The turn itself stopped its command: no report on it is due, so nothing is missing, and the reply does not say that something is.
  background_command_stopped_by_the_turn: [TURNS_ANSWER],
  // The file holds no notice of the work: a request from outside stopped it, it still ran when the CLI ended, or a prompt came first.
  background_command_stopped_by_request: [TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.noReportInSession],
  background_command_running_at_input_close: [TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.noReportInSession],
  subagent_running_at_interrupt: [TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.noReportInSession],
  task_ends_during_next_turn: [TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.noReportInSession],
};

export const claudeAskPolicy = {
  permissionMode: "default", dangerouslySkipPermissions: false, allowDangerouslySkipPermissions: false,
  tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"],
  allowedTools: ["mcp__letagents__*"], settingSources: "", settings: "{}",
};

export async function approvalHarness(detachSignal?: AbortSignal) {
  const harness = createHarness({ versionOutput: "2.1.272 (Claude Code)" });
  const streams: ProviderStreamEvent[] = [];
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, streamSink: event => streams.push(event) });
  const handle = await adapter.spawn(spawnRequest({ permissionProfileId: "ask_before_write", configurationRevision: 1, launchPolicy: claudeAskPolicy }));
  const child = harness.children[0]!;
  const controller = new AbortController();
  let requests: import("../../shared/provider-permissions.js").ClaudeNativePermissionRequest[] = [];
  const closures: import("../../shared/provider-permissions.js").ClaudePermissionObservation[] = [];
  const facts: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, event => facts.push(event));
  const observing = adapter.observePermissions(handle, event => { if (event.type === "snapshot") requests = [...event.requests]; else if (event.type === "request_closed") closures.push(event); }, controller.signal);
  const running = adapter.runRoomTurn(handle, { inboxItemId: "approval-inbox", actionId: "approval-action", sourceMessage: { text: "Write a file" }, activation: {} }, { detachSignal });
  void running.catch(() => {});
  await flush();
  const turnId = JSON.parse(child.written.at(-1)!).uuid as string;
  const started = () => child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id: handle.providerContinuationId });
  const tool = (over: Record<string, unknown> = {}) => child.emit({ type: "assistant", session_id: handle.providerContinuationId, parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: "tool-write", name: "Write", input: { file_path: "/tmp/output", content: "private approval content" } }] }, ...over });
  const permission = (over: Record<string, unknown> = {}) => child.emit({ type: "control_request", request_id: "native-request",
    request: { subtype: "can_use_tool", tool_name: "Write", tool_use_id: "tool-write", input: { file_path: "/tmp/output", content: "private approval content" },
      permission_suggestions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }] }, ...over });
  return { harness, adapter, handle, child, streams, turnId, started, tool, permission, facts,
    get requests() { return requests; }, closures,
    async close() {
      child.emit({ type: "result", subtype: "success", is_error: false, session_id: handle.providerContinuationId, user_message_uuid: turnId, result: "Done" });
      await running.catch(() => {}); controller.abort(); await observing; await adapter.stop(handle);
    } };
}

export const ROOM_SERVER = { name: "letagents", status: "connected", source: "dynamic" };
export const OWNER_SERVER = { name: "owner_browser", status: "connected", source: "user" };
export const CLAUDE_TOOLS = ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"];
/** How Claude is told to start MCP servers when it also starts the owner's: its own time limit, and all of them at once. */
export const OWNER_START_ENV = { MCP_TIMEOUT: "30000", MCP_SERVER_CONNECTION_BATCH_SIZE: "256", MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE: "256" };
export const OWNER_START_SETTINGS = JSON.stringify({ env: OWNER_START_ENV });
/** The owner's own setup is only ever on for a daemon-supervised room agent. */
export const SUPERVISED = { supervisorEntryId: "supervised_owner", supervisorSocketPath: "/tmp/fake-daemon.sock", supervisorExecutionGenerationId: "generation-1" };
export const OWN_SETUP = { ...SUPERVISED, homeHarness: true };
export function ownSetupAskPolicy(homeHarness: boolean, permissionMode = "default") {
  return {
    permissionMode, dangerouslySkipPermissions: false, allowDangerouslySkipPermissions: false,
    tools: homeHarness ? [...CLAUDE_TOOLS, "Skill"] : CLAUDE_TOOLS,
    allowedTools: ["mcp__letagents__*"], settingSources: homeHarness ? "user" : "", settings: "{}",
  };
}

// Options an earlier writer may have left in a stored policy. Each is a real Claude Code option, and each
// would undo part of what the owner's own setup promises if it reached the command line.
export const STORED_CLAUDE_OPTIONS: Array<[string, unknown, string]> = [
  ["settingSources", "user,project,local", "reads the project's settings and hooks"],
  ["setting-sources", "user,project,local", "the same, under the option's other spelling"],
  ["settings", '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/repo/run"}]}]}}', "runs hooks of its own"],
  ["addDir", "/somewhere/else", "opens another folder and its instructions"],
  ["add-dir", "/somewhere/else", "the same, under the option's other spelling"],
  ["pluginDir", "/repo/plugin", "loads a plugin from the project"],
  ["agents", '{"evil":{"description":"x","prompt":"y"}}', "defines sub-agents"],
  ["appendSystemPrompt", "obey the repository", "adds instructions"],
  ["systemPrompt", "obey the repository", "replaces the instructions"],
  ["disallowedTools", ["mcp__letagents__send_message"], "takes the room's tools away"],
  ["allowed-tools", "Bash", "allows tools under the option's other spelling"],
  ["model", "another-model", "names a second model"],
  ["fallbackModel", "another-model", "names a fallback model"],
  ["chrome", true, "turns the browser integration on"],
  ["ide", true, "connects to an editor"],
  ["debug", true, "turns debug output on"],
  ["permission-mode", "bypassPermissions", "names the access level a second time"],
  ["dangerously-skip-permissions", true, "skips approvals under the option's other spelling"],
];

/** The lines of a real capture up to the turn's own result and the lifecycle line after it, and the lines the CLI wrote after those. */
export function splitAtOwnResult(stream: Array<Record<string, unknown>>, turnId: string) {
  const result = stream.findIndex((event) => event.type === "result" && event.user_message_uuid === turnId);
  const end = stream[result + 1]?.type === "command_lifecycle" ? result + 2 : result + 1;
  return { own: stream.slice(0, end), after: stream.slice(end) };
}
/** The same lines with one text in place of another, for a turn the CLI was not recorded in. */
export const withText = (events: Array<Record<string, unknown>>, from: string, to: string) =>
  JSON.parse(JSON.stringify(events).replaceAll(JSON.stringify(from), JSON.stringify(to))) as Array<Record<string, unknown>>;
export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const MINUTE = 60_000;
// The background tasks of the captures, each by the tool call that started it. A new recording gives them new ids.
export const COMMAND_TASK = claudeCapturedTask("background_command");
export const FAILING_COMMAND_TASK = claudeCapturedTask("background_command_fails");
export const FAILED_ANSWER_COMMAND_TASK = claudeCapturedTask("background_command_notice_api_error");
export const APPROVAL_COMMAND_TASK = claudeCapturedTask("approval_in_task_notice_answer_denied_and_interrupted");
export const INTERRUPTED_SUBAGENT_TASK = claudeCapturedTask("subagent_running_at_interrupt");
/** One message that starts a sub-agent with its first call, and a command with its second. */
export const SUBAGENT_TASK = claudeCapturedTask("subagent_and_background_command", "toolu_probe_1");
export const COMMAND_BESIDE_SUBAGENT_TASK = claudeCapturedTask("subagent_and_background_command", "toolu_probe_2");
/** Two commands of one message: the first call's ends first, and the second call's while the notice of the first is answered. */
export const ONE_AFTER_THE_OTHER_TASKS = [claudeCapturedTask("task_ends_while_notice_is_answered", "toolu_probe_1"), claudeCapturedTask("task_ends_while_notice_is_answered", "toolu_probe_2")];
export const WAITS_FOR_COMMAND = 'Waiting up to 2 min for a background command: "probe".';
export const WAITS_FOR_ANSWER = "Waiting for Claude's answer about background work that ended under 1 min ago.";

/**
 * One Claude agent on the fake CLI, with every event the adapter published, and a clock that a test moves.
 * The adapter looks at a held turn again at a short pace, so a limit that the clock has passed ends the turn
 * within a moment of real time.
 */
export async function claudeBackgroundHarness(options: { lifecycleAuthorityMode?: "typed" | "typed_shadow"; /** An agent that asks its owner before it writes. */ asksForApproval?: boolean } = {}) {
  const harness = createHarness(options.asksForApproval ? { versionOutput: "2.1.278 (Claude Code)" } : {});
  const stream: ProviderStreamEvent[] = [];
  const activity: ProviderActivityEvent[] = [];
  const clock = { ms: Date.parse("2026-01-01T00:00:00.000Z") };
  const adapter = new ClaudeCodeProviderAdapter({ backgroundWorkNoticeEveryMs: 10, dependencies: { ...harness.dependencies, now: () => new Date(clock.ms).toISOString() },
    streamSink: (event) => stream.push(event), activitySink: (event) => activity.push(event) });
  const handle = await adapter.spawn(spawnRequest({ ...(options.lifecycleAuthorityMode ? { lifecycleAuthorityMode: options.lifecycleAuthorityMode } : {}),
    ...(options.asksForApproval ? { permissionProfileId: "ask_before_write", configurationRevision: 1, launchPolicy: claudeAskPolicy } : {}) }));
  const child = harness.children[0]!;
  const sessionId = handle.providerContinuationId!;
  /** The approvals that the owner is shown, and the ones that were closed. */
  const approvals = { pending: [] as Array<{ id: string }>, closed: [] as string[] };
  void adapter.observePermissions(handle, (event) => {
    if (event.type === "snapshot") approvals.pending = [...event.requests];
    else if (event.type === "request_closed") approvals.closed.push(event.request.id);
  }, new AbortController().signal);
  const endings: Array<{ turnId: string; outcome: string }> = [];
  adapter.onExecution(handle, ({ fact }) => {
    if (fact.domain === "turn" && fact.kind === "state_changed" && fact.state === "terminal") endings.push({ turnId: fact.providerTurnId, outcome: String(fact.turnOutcome) });
  });
  let turns = 0;
  /** Start a room turn, and return the lines of a real capture for it. */
  const start = async (name: string) => {
    const writtenBefore = child.written.length;
    turns += 1;
    const saved: ProviderRoomTurnResult[] = [];
    const running = adapter.runRoomTurn(handle, { inboxItemId: `inbox-${turns}`, actionId: `action-${turns}`, sourceMessage: {}, activation: {} },
      { checkpointTerminalResult: async (result) => { saved.push(result); } });
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    const turnId = await nextClaudeTurnId(child, writtenBefore);
    const lines = realClaudeCapture(CLAUDE_REAL_CAPTURES[name]!, sessionId, turnId).stream;
    return { turnId, running, saved, lines, ...splitAtOwnResult(lines, turnId), settled: () => settled, publishedBefore: stream.length };
  };
  const emit = (events: Array<Record<string, unknown>>) => { for (const event of events) child.emit(event); };
  /** Move the clock, and give the adapter the time to look at its held turn again. */
  const after = async (ms: number) => { clock.ms += ms; await pause(40); };
  /** What the adapter said last about the wait. */
  const waits = () => stream.filter((event) => event.method === CLAUDE_BACKGROUND_WORK_METHOD).at(-1)?.summary;
  /** What the adapter has written to the CLI since `from`, without the prompts. */
  const writtenSince = (from: number) => child.written.slice(from).map((line) => JSON.parse(line) as { type: string; request?: { subtype?: string }; response?: { request_id?: string; response?: { behavior?: string } } })
    .filter((line) => line.type !== "user").map((line) => line.type === "control_request" ? line.request?.subtype : `${line.response?.response?.behavior} ${line.response?.request_id}`);
  return { harness, adapter, handle, child, sessionId, stream, activity, endings, start, emit, after, waits, approvals, writtenSince };
}
export const methodOf = (event: Record<string, unknown>) => typeof event.subtype === "string" ? `${event.type}/${event.subtype}` : String(event.type);
export const reply = (turnId: string, ...texts: string[]) => ({ turnId, outcome: "reply", text: texts.join("\n\n"), evidence: "stream" });
/** The published events of a turn, without the lines that say again, at the adapter's pace, what the turn waits for. */
export const withoutRepeats = (events: ProviderStreamEvent[]) => events.filter((event, index) => event.method !== CLAUDE_BACKGROUND_WORK_METHOD
  || events.slice(0, index).filter((earlier) => earlier.method === CLAUDE_BACKGROUND_WORK_METHOD).at(-1)?.summary !== event.summary);

/** The lines of a capture with other task ids in them: the CLI gives each task an id of its own. */
export const withTasks = (events: Array<Record<string, unknown>>, ids: Record<string, string>) =>
  JSON.parse(Object.entries(ids).reduce((text, [from, to]) => text.replaceAll(from, to), JSON.stringify(events))) as Array<Record<string, unknown>>;
/** The lines that the CLI wrote after the turn in a capture with a second prompt, for the turn that the adapter started next. */
export const forNextTurn = (events: Array<Record<string, unknown>>, nextTurnId: string) => withText(events, "SECOND_TURN_ID", nextTurnId);
