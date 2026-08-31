import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttp2Server } from "node:http2";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  CURSOR_NO_ROOM_REPLY_SENTINEL,
  CursorProviderAdapter,
  cursorCliEnv,
  cursorLaunchPolicyArgs,
  cursorLiveDisplayProjections,
  defaultLaunchTurn,
  type CursorCliChild,
  type CursorProviderAdapterDependencies,
} from "../main/agents/cursor-provider-adapter.js";
import type {
  ProviderHandle,
  ProviderRoomTurnResult,
  ProviderSpawnRequest,
  ProviderStreamEvent,
  ProviderTerminalPayload,
  NativeExecutionObservation,
} from "../main/agents/provider-adapter.js";
import type { ProviderProcessExit } from "../main/agents/provider-evidence.js";
import {
  cursorSupervisedMcpServerName,
  prepareCursorSupervisedProfile,
  type CursorManagedProfile,
} from "../main/agents/cursor-managed-profile.js";
import { LETAGENTS_MCP_RUNTIME_VERSION } from "../main/agents/letagents-mcp-runtime.js";
const { emptyExecutionProjection, reduceExecutionFact } = await import(new URL("../../daemon/execution-reducer.ts", import.meta.url).href);

const previousNonDarwinOverride = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
if (process.platform !== "darwin") process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
test.after(() => {
  if (previousNonDarwinOverride === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previousNonDarwinOverride;
});

// Fake per-turn child harness proving the P2b adapter honors the #765
// invariants under Cursor's one-child-per-turn model: honest idle-between-turns
// (never a claimed live process), turn-terminal vs attempt-terminal evidence,
// boundary delivery, and the recycled-pid / ambiguity / no-orphan rules.

class FakeCursorChild implements CursorCliChild {
  readonly lines: Array<(line: string) => void> = [];
  alive = true;
  stderr = "";
  private resolveExited!: (exit: ProviderProcessExit) => void;
  readonly exited: Promise<ProviderProcessExit>;

  private released = false;
  constructor(
    readonly pid: number | null,
    private readonly onRelease: () => void = () => {},
    readonly ownsDescendantReaping = false,
    readonly requiresDurableTerminalEvidence = false,
    private readonly releaseError?: Error,
  ) {
    this.exited = new Promise((resolve) => { this.resolveExited = resolve; });
  }

  stderrTail(): string {
    return this.stderr;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    queueMicrotask(this.onRelease);
    if (this.releaseError) throw this.releaseError;
  }

  get isReleased(): boolean {
    return this.released;
  }

  onLine(listener: (line: string) => void): () => void {
    this.lines.push(listener);
    return () => {
      const index = this.lines.indexOf(listener);
      if (index >= 0) this.lines.splice(index, 1);
    };
  }

  emit(message: Record<string, unknown>): void {
    for (const listener of [...this.lines]) listener(JSON.stringify(message));
  }

  emitRaw(line: string): void {
    for (const listener of [...this.lines]) listener(line);
  }

  resolveExit(exit: ProviderProcessExit): void {
    this.alive = false;
    this.resolveExited(exit);
  }
}

interface HarnessOptions {
  pid?: number | null;
  /** Force the first stream event's session id (identity-mismatch cases). */
  sessionId?: string;
  /** Suppress the auto first event so the startup bound can be exercised. */
  silent?: boolean;
  identities?: Map<number, string | null | undefined>;
  /** Defaults to true (a well-behaved CLI); fence tests opt out. */
  dieOnSigterm?: boolean;
  ownsDescendantReaping?: boolean;
  /** Simulate an IPC send that may have delivered release before throwing. */
  releaseError?: Error;
  mcpAttestationError?: Error;
  mcpBridgeAttestationError?: Error;
  mcpAttestationWaitForAbort?: boolean;
  /** One-based attestation pass to hold until abort. */
  mcpAttestationWaitForAbortAt?: number;
  beforeLaunch?: CursorProviderAdapterDependencies["launchTurn"] extends (input: infer Input) => unknown ? (input: Input) => void : never;
}

function birthIdentity(pid: number): string {
  return `fake-cursor-${pid}-birth-1`;
}

function argValue(args: string[], flag: string): string | null {
  const assigned = args.find((arg) => arg.startsWith(`${flag}=`));
  if (assigned) return assigned.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1]! : null;
}

function initializeGitWorkspace(workspace: string): void {
  mkdirSync(workspace, { recursive: true });
  assert.equal(spawnSync("git", ["init", "--quiet", workspace]).status, 0);
  assert.equal(spawnSync("git", [
    "-c", "user.name=Cursor Test",
    "-c", "user.email=cursor@example.test",
    "-C", workspace,
    "commit", "--quiet", "--allow-empty", "-m", "workspace seed",
  ]).status, 0);
}

const productionPersonalIdentityDependencies: Partial<CursorProviderAdapterDependencies> = {
  attestPersonalIdentity: async () => ({
    userId: 12345,
    email: "personal@example.test",
    providerAuthorization: "Bearer test-provider-authorization",
  }),
  bindPersonalIdentity: () => {},
};

function wrapperHostedMcpFixture(
  root: string,
  mcpConnectorSocketPath?: string,
  completionContract: "valid" | "missing" | "wrong_type" | "enum_superset" | "required_text" | "frame_flood" | "byte_flood" = "valid",
  // The wrapper now proves the completion contract against its hosted runtime
  // before Cursor launches, so every wrapper-spawning fixture needs a runtime
  // that answers the handshake; only shape-only fixtures (nonexistent roots)
  // skip materialization.
  materializeRuntime = true,
): Pick<
  CursorManagedProfile,
  "mcpRuntimeEntryPath" | "mcpRuntimeEnv" | "nativeAllowedWriteSubpaths" | "nativeAllowedReadSubpaths"
> {
  const bridgeRoot = join(root, "bridge");
  let canonicalRoot = root;
  try { canonicalRoot = realpathSync(root); } catch {}
  const sandboxRoots = [...new Set([root, canonicalRoot])];
  const sandboxWritableRoots = sandboxRoots.flatMap((sandboxRoot) => [
    join(sandboxRoot, "home"),
    join(sandboxRoot, "config"),
    join(sandboxRoot, "data"),
    join(sandboxRoot, "cache"),
    join(sandboxRoot, "npm-cache"),
    join(sandboxRoot, "tmp"),
    join(sandboxRoot, "bridge"),
  ]);
  if (existsSync(root)) {
    for (const writableRoot of sandboxWritableRoots) {
      mkdirSync(writableRoot, { recursive: true });
    }
  }
  const runtimeEntry = join(bridgeRoot, "runtime.cjs");
  const completionTools = completionContract === "missing"
    ? []
    : [{
      name: "complete_room_turn",
      description: "complete the room turn",
      inputSchema: {
          type: completionContract === "wrong_type" ? "array" : "object",
          properties: {
            outcome: {
              type: "string",
              enum: completionContract === "enum_superset"
                ? ["reply", "no_reply", "later"]
                : ["reply", "no_reply"],
            },
            text: { type: "string" },
          },
          required: completionContract === "required_text" ? ["outcome", "text"] : ["outcome"],
      },
    }];
  let runtimeMaterialized = false;
  if (materializeRuntime) {
    // Shape-only fixtures pass unwritable roots (e.g. under /private/cursor);
    // they never spawn the wrapper, so a failed materialization is harmless.
    try { mkdirSync(dirname(runtimeEntry), { recursive: true }); runtimeMaterialized = true; } catch {}
  }
  if (runtimeMaterialized) {
    writeFileSync(runtimeEntry, `
const readline = require("node:readline");
require("node:fs").writeFileSync(${JSON.stringify(join(bridgeRoot, "runtime.pid"))}, String(process.pid));
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "tools/list" && ${JSON.stringify(completionContract === "frame_flood")}) {
    for (let index = 0; index < 300; index += 1) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { index } }) + "\\n");
    }
  }
  if (request.method === "tools/list" && ${JSON.stringify(completionContract === "byte_flood")}) {
    for (let index = 0; index < 200; index += 1) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { index, payload: "x".repeat(6000) } }) + "\\n");
    }
  }
  const result = request.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : request.method === "tools/list"
      ? { tools: ${JSON.stringify(completionTools)} }
      : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`);
  }
  if (runtimeMaterialized && mcpConnectorSocketPath) {
    const cursorHome = join(root, "home", ".cursor");
    mkdirSync(cursorHome, { recursive: true });
    const connectorSource = `
const net = require("node:net");
const socket = net.createConnection({ path: process.argv[1] });
socket.once("connect", () => { process.stdin.pipe(socket); socket.pipe(process.stdout); });
socket.once("error", () => process.exit(1));
socket.once("close", () => process.exit(0));
`;
    writeFileSync(join(cursorHome, "mcp.json"), JSON.stringify({
      mcpServers: {
        letagents: {
          command: process.execPath,
          args: ["-e", connectorSource, mcpConnectorSocketPath],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        },
      },
    }));
  }
  return {
    mcpRuntimeEntryPath: materializeRuntime ? runtimeEntry : "/usr/bin/true",
    // runtimeMaterialized only affects whether the entry exists on disk; the
    // returned path stays stable for shape-only assertions.
    mcpRuntimeEnv: {
      ELECTRON_RUN_AS_NODE: "1",
      LETAGENTS_API_URL: "https://letagents.chat",
      HOME: join(bridgeRoot, "home"),
      XDG_CONFIG_HOME: join(bridgeRoot, "config"),
      XDG_DATA_HOME: join(bridgeRoot, "data"),
      XDG_CACHE_HOME: join(bridgeRoot, "cache"),
      CURSOR_CONFIG_DIR: join(bridgeRoot, "config", "cursor"),
      CURSOR_DATA_DIR: join(bridgeRoot, "data", "cursor"),
      NODE_COMPILE_CACHE: join(bridgeRoot, "cache", "node-compile-cache"),
      CURSOR_API_KEY: "",
      CURSOR_AUTH_TOKEN: "",
    },
    nativeAllowedWriteSubpaths: sandboxWritableRoots,
    nativeAllowedReadSubpaths: sandboxRoots,
  };
}

const cursorMcpAttestationFixtureSource = `
function attestFixtureMcp() {
  return new Promise((resolve, reject) => {
    const fixtureFs = require("node:fs");
    const fixtureReadline = require("node:readline");
    const fixtureSpawn = require("node:child_process").spawn;
    const config = JSON.parse(fixtureFs.readFileSync(process.env.HOME + "/.cursor/mcp.json", "utf8"));
    const server = Object.values(config.mcpServers)[0];
    const connector = fixtureSpawn(server.command, server.args, {
      env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"],
    });
    globalThis.__fixtureMcpConnector = connector;
    const responses = fixtureReadline.createInterface({ input: connector.stdout });
    responses.on("line", (line) => {
      const response = JSON.parse(line);
      if (response.id === 2
        && response.result
        && Array.isArray(response.result.tools)
        && response.result.tools.some((tool) => tool.name === "complete_room_turn")) {
        responses.close();
        resolve(connector);
      }
    });
    connector.once("error", reject);
    connector.once("close", (code) => reject(new Error("fixture MCP connector closed before attestation: " + code)));
    connector.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\\n");
    connector.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\\n");
  });
}
function detachFixtureMcp(connector) {
  connector.unref();
  if (typeof connector.stdin.unref === "function") connector.stdin.unref();
  if (typeof connector.stdout.unref === "function") connector.stdout.unref();
}
`;

// The wrapper proves the complete_room_turn contract against its hosted
// runtime before Cursor launches, so any test that reaches the wrapper needs a
// runtime that answers the initialize/tools/list handshake and stays alive.
function materializeAttestableMcpRuntime(dir: string): string {
  const entry = join(dir, "attestable-mcp-runtime.cjs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(entry, `
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!request || request.id === undefined) return;
  const result = request.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "attestable-fixture", version: "1" } }
    : request.method === "tools/list"
      ? { tools: [{
          name: "complete_room_turn",
          description: "complete the room turn",
          inputSchema: {
            type: "object",
            properties: {
              outcome: { type: "string", enum: ["reply", "no_reply"] },
              text: { type: "string" },
            },
            required: ["outcome"],
          },
        }] }
      : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`);
  return entry;
}

function wrapperMcpRuntimeEnv(connectorRoot: string, turnId: string): Record<string, string> {
  return {
    ELECTRON_RUN_AS_NODE: "1",
    LETAGENTS_API_URL: "https://letagents.chat",
    HOME: join(connectorRoot, "home"),
    XDG_CONFIG_HOME: join(connectorRoot, "config"),
    XDG_DATA_HOME: join(connectorRoot, "data"),
    XDG_CACHE_HOME: join(connectorRoot, "cache"),
    CURSOR_CONFIG_DIR: join(connectorRoot, "config", "cursor"),
    CURSOR_DATA_DIR: join(connectorRoot, "data", "cursor"),
    NODE_COMPILE_CACHE: join(connectorRoot, "cache", "node-compile-cache"),
    CURSOR_API_KEY: "",
    CURSOR_AUTH_TOKEN: "",
    LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_cursor_wrapper_test",
    LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/letagents-supervisor-wrapper-test.sock",
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: "wa-cursor-wrapper-test",
    LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "generation-cursor-wrapper-test",
    LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
    LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: turnId,
    LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: "agent-session-cursor-wrapper-test",
    LETAGENTS_SUPERVISOR_ROOM_ID: "github.com/example/repo",
    LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
    LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
    LETAGENTS_PERMISSION_PROFILE_ID: "read_only",
  };
}

function createHarness(options: HarnessOptions = {}) {
  const children: FakeCursorChild[] = [];
  const launches: Array<Parameters<CursorProviderAdapterDependencies["launchTurn"]>[0]> = [];
  const profilePreparations: Array<{
    workAttemptId: string;
    cwd: string;
    permissionProfileId?: string | null;
    profileRoot?: string;
    includeAuth?: boolean;
    authSourceHomeDir?: string;
    inspectionOnly?: boolean;
    mcpWorkingDirectory?: string;
    supervisorMcpEnv?: Readonly<Record<string, string>>;
    mcpConnectorSocketPath?: string;
  }> = [];
  const mcpAttestations: Array<{
    cursorBin: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    writableProfileRoot: string;
    requiredReadableRoots?: string[];
    expectedServerName?: string;
    timeoutMs?: number;
  }> = [];
  const identityAttestations: Array<{
    cursorBin: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    writableProfileRoot: string;
    requiredReadableRoots?: string[];
    timeoutMs?: number;
  }> = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const workspaceGenerationEvents: Array<{ kind: "create" | "retire" | "recover" | "abandon" | "remove"; turnIdentity?: string }> = [];
  const identities = options.identities ?? new Map<number, string | null | undefined>();
  let nextPid = 5200;
  let mintedSessions = 0;

  const dependencies: CursorProviderAdapterDependencies = {
    bindPersonalIdentity() {},
    async attestPersonalIdentity(input) {
      identityAttestations.push(input);
      return {
        userId: 12345,
        email: "personal@example.test",
        providerAuthorization: "Bearer test-provider-authorization",
      };
    },
    async attestSupervisedMcp(input) {
      mcpAttestations.push(input);
      if (options.mcpAttestationError) throw options.mcpAttestationError;
      if (options.mcpBridgeAttestationError && input.requiredReadableRoots?.length) {
        throw options.mcpBridgeAttestationError;
      }
      if (options.mcpAttestationWaitForAbort
        && (options.mcpAttestationWaitForAbortAt === undefined
          || options.mcpAttestationWaitForAbortAt === mcpAttestations.length)) {
        await new Promise<void>((_resolve, reject) => {
          if (input.signal?.aborted) {
            reject(new Error("MCP attestation aborted"));
            return;
          }
          input.signal?.addEventListener(
            "abort",
            () => reject(new Error("MCP attestation aborted")),
            { once: true },
          );
        });
      }
    },
    launchTurn(input) {
      options.beforeLaunch?.(input);
      launches.push(input);
      const pid = options.pid === undefined ? nextPid++ : options.pid;
      let child!: FakeCursorChild;
      child = new FakeCursorChild(pid, () => {
        if (options.silent || !child.alive) return;
        const sessionId = options.sessionId
          ?? argValue(input.args, "--resume")
          ?? `sess-cursor-${++mintedSessions}`;
        child.emit({ type: "system", subtype: "init", session_id: sessionId, model: "cursor-fast" });
      }, options.ownsDescendantReaping, false, options.releaseError);
      children.push(child);
      if (pid !== null && !identities.has(pid)) identities.set(pid, birthIdentity(pid));
      return child;
    },
    signalProcess(pid, signal) {
      signals.push({ pid, signal });
      const child = children.find((entry) => entry.pid === pid && entry.alive);
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
    prepareTurnState() {},
    async createWorkspaceGeneration(input) {
      workspaceGenerationEvents.push({ kind: "create", turnIdentity: input.turnIdentity });
      const manifestPath = `/tmp/letagents-test-generation-${createHash("sha256").update(input.turnIdentity).digest("hex")}.json`;
      return {
        generationId: createHash("sha256").update(input.turnIdentity).digest("hex").slice(0, 32),
        manifestPath,
        sourceRoot: input.realWorkspace,
        realWorkspace: input.realWorkspace,
        liveSourceRoot: input.realWorkspace,
        liveWorkspace: input.realWorkspace,
        readOnlyRoots: [],
        async retireAndReconcile() {
          workspaceGenerationEvents.push({ kind: "retire", turnIdentity: input.turnIdentity });
          return { phase: "cleaned" as const, appliedPaths: [], manifestPath };
        },
        async recover() {
          workspaceGenerationEvents.push({ kind: "recover", turnIdentity: input.turnIdentity });
          return { phase: "cleaned" as const, appliedPaths: [], manifestPath };
        },
        async abandon() {
          workspaceGenerationEvents.push({ kind: "abandon", turnIdentity: input.turnIdentity });
          return { phase: "aborted" as const, appliedPaths: [], manifestPath };
        },
      };
    },
    async recoverWorkspaceGeneration(manifestPath) {
      workspaceGenerationEvents.push({ kind: "recover" });
      return { phase: "cleaned", appliedPaths: [], manifestPath };
    },
    async removeWorkspaceGenerationReceipt() {
      workspaceGenerationEvents.push({ kind: "remove" });
    },
    now: () => new Date(1_700_000_000_000).toISOString(),
  };

  return {
    children,
    launches,
    mcpAttestations,
    identityAttestations,
    profilePreparations,
    signals,
    identities,
    workspaceGenerationEvents,
    dependencies,
  };
}

function spawnRequest(over: Partial<ProviderSpawnRequest> = {}): ProviderSpawnRequest {
  return {
    workAttemptId: "wa-cursor-1",
    roomId: "github.com/example/repo",
    agentDisplayName: "TidalHare",
    cwd: "/tmp/wa-cursor-1",
    launchPolicy: { mode: "ask", sandbox: "enabled" },
    ...over,
  };
}

function daemonSpawnRequest(over: Partial<ProviderSpawnRequest> = {}): ProviderSpawnRequest {
  return spawnRequest({
    deliveryMode: "daemon_inbox",
    launchPolicy: { mode: "ask", force: false },
    permissionProfileId: "read_only",
    reasoningEffort: null,
    configurationRevision: 1,
    supervisorEntryId: "supervised_cursor_1",
    supervisorSocketPath: "/tmp/letagents-supervisor.sock",
    supervisorExecutionGenerationId: "generation_cursor_1",
    supervisorWorkerSession: {
      agentSessionId: "agent_session_cursor_1",
      roomCursor: "msg_7",
    },
    ...over,
  });
}

function supervisedAdapter(harness: ReturnType<typeof createHarness>, stopGraceMs?: number): CursorProviderAdapter {
  return new CursorProviderAdapter({
    dependencies: harness.dependencies,
    ...(stopGraceMs === undefined ? {} : { stopGraceMs }),
    supervisedProfileFactory: (input) => {
      harness.profilePreparations.push(input);
      const { workAttemptId, profileRoot } = input;
      const root = profileRoot ?? `/private/cursor/${workAttemptId}`;
      return {
        homeDir: `${root}/home`,
        configDir: `${root}/config`,
        dataDir: `${root}/data`,
        cacheDir: `${root}/cache`,
        env: {
          HOME: `${root}/home`,
          CURSOR_CONFIG_DIR: `${root}/config/cursor`,
          CURSOR_API_KEY: "provider-key-must-not-leak-into-inspection",
          CURSOR_AUTH_TOKEN: "provider-auth-must-not-leak-into-inspection",
          LETAGENTS_TOKEN: "profile-token-must-not-leak",
          LETAGENTS_SUPERVISOR_ENTRY_ID: "profile-stale-entry",
        },
        ...(input.inspectionOnly ? {} : {
          mcpRuntimeEntryPath: "/Applications/LetAgents.app/runtime/letagents/server.js",
          mcpRuntimeReadRoots: ["/Applications/LetAgents.app/runtime/letagents"],
          ...(input.mcpConnectorSocketPath ? wrapperHostedMcpFixture(root) : {}),
        }),
        mcpServerName: cursorSupervisedMcpServerName(workAttemptId),
      };
    },
  });
}

async function spawnDaemonLane(
  adapter: CursorProviderAdapter,
  _harness: ReturnType<typeof createHarness>,
  request = daemonSpawnRequest(),
): Promise<ProviderHandle> {
  return adapter.spawn(request);
}

function roomTurnRequest(over: Partial<{
  inboxItemId: string;
  actionId: string;
}> = {}) {
  return {
    inboxItemId: over.inboxItemId ?? "inbox_cursor_1",
    actionId: over.actionId ?? "action_cursor_1",
    sourceMessage: { id: "msg_8", text: "Please fix it" },
    activation: { decision: "activate" },
    observedContext: [{ id: "msg_7", text: "Earlier context" }],
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

async function waitForPath(path: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await flush();
  return existsSync(path);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await flush();
  assert.equal(predicate(), true, "condition did not become true before the wait deadline");
}

async function withLoopAlive<T>(work: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 20);
  try {
    return await work;
  } finally {
    clearInterval(keepAlive);
  }
}

test("spawn runs one per-turn child with verbatim policy flags and the prompt as a positional argument", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());

  assert.equal(harness.launches.length, 1);
  const args = harness.launches[0]!.args;
  assert.equal(args[0], "-p");
  assert.ok(args.join(" ").includes("--output-format stream-json"));
  assert.ok(args.includes("--trust"), "headless workspace-trust suppression is adapter-owned");
  assert.equal(args.includes("--disable-project-configs"), false, "legacy Cursor keeps project config enabled");
  assert.equal(args.includes("--approve-mcps"), false, "legacy Cursor has no sealed profile to scope approval, so it never blanket-approves MCPs");
  assert.ok(args.join(" ").includes("--workspace /tmp/wa-cursor-1"));
  assert.ok(args.join(" ").includes("--mode ask"), "native policy flag passed verbatim");
  assert.ok(args.join(" ").includes("--sandbox enabled"));
  assert.equal(args.includes("--resume"), false);
  const prompt = args[args.length - 1]!;
  assert.ok(prompt.includes("Cursor worker"), "prompt is provider-labelled and positional");
  assert.ok(prompt.includes('"cursor:'), "register_agent_session runtime uses the cursor key");

  // spawn resolves while the turn is still RUNNING: live pid, working state.
  assert.equal(handle.observedState(), "working");
  assert.equal(handle.pid, 5200);
  assert.deepEqual(handle.providerConnection, {
    kind: "cursor_cli",
    pid: 5200,
    processIdentity: birthIdentity(5200),
  });
  assert.equal(handle.providerContinuationId, "sess-cursor-1", "session id captured from the stream");
});

test("cursorLaunchPolicyArgs maps mechanically and rejects adapter-owned flags", () => {
  assert.deepEqual(
    cursorLaunchPolicyArgs({ mode: "plan", force: true, sandbox: "disabled" }),
    ["--mode", "plan", "--force", "--sandbox", "disabled"],
  );
  assert.throws(() => cursorLaunchPolicyArgs({ resume: "sess-x" }), /unsupported or adapter-owned flag 'resume'/);
  assert.throws(() => cursorLaunchPolicyArgs({ workspace: "/elsewhere" }), /unsupported or adapter-owned flag 'workspace'/);
  assert.throws(() => cursorLaunchPolicyArgs({ model: "shadow-model" }), /unsupported or adapter-owned flag 'model'/);
  assert.throws(() => cursorLaunchPolicyArgs({ approveMcps: false }), /unsupported or adapter-owned flag 'approveMcps'/);
  assert.throws(() => cursorLaunchPolicyArgs({ yolo: true }), /unsupported or adapter-owned flag 'yolo'/);
  assert.throws(() => cursorLaunchPolicyArgs("yolo"), /native CLI options object/);
  assert.throws(
    () => defaultLaunchTurn({
      cursorBin: process.execPath,
      args: [],
      cwd: process.cwd(),
      testAgentUpstreamEndpoint: "http://127.0.0.1:65536",
    }),
    /exact loopback HTTP\/2 origin/,
  );
  assert.throws(
    () => defaultLaunchTurn({
      cursorBin: process.execPath,
      args: [],
      cwd: process.cwd(),
      testControlPlaneUpstreamEndpoint: "http://127.0.0.1:99999",
    }),
    /exact loopback HTTP origin/,
  );
  assert.throws(
    () => defaultLaunchTurn({
      cursorBin: process.execPath,
      args: [],
      cwd: process.cwd(),
      restrictRemoteAuthority: true,
      testAgentUpstreamEndpoint: "https://api2.cursor.sh",
      testControlPlaneUpstreamEndpoint: "https://api2.cursor.sh",
      testStartupBarrier: {
        path: "/tmp/letagents-cursor-startup-barrier-Abc123/mcp_listen",
        stage: "mcp_listen",
      },
    }),
    /startup barrier is restricted to exact loopback unit tests/,
  );
  const supervisedBoundary = {
    cursorBin: process.execPath,
    args: [],
    cwd: process.cwd(),
    restrictRemoteAuthority: true,
    providerAuthorization: "Bearer sandbox-allow-list-test",
    mcpConnectorSocketPath: `/tmp/letagents-cursor-mcp-${randomUUID()}/stdio.sock`,
    mcpRuntimeEntryPath: "/usr/bin/true",
    mcpRuntimeCwd: process.cwd(),
    mcpRuntimeEnv: {},
  };
  assert.throws(
    () => defaultLaunchTurn({
      ...supervisedBoundary,
      allowedReadSubpaths: [process.cwd()],
    }),
    /non-empty read and write sandbox allow-lists/,
  );
  assert.throws(
    () => defaultLaunchTurn({
      ...supervisedBoundary,
      allowedWriteSubpaths: [process.cwd()],
    }),
    /non-empty read and write sandbox allow-lists/,
  );
  assert.throws(
    () => defaultLaunchTurn({
      ...supervisedBoundary,
      testAgentUpstreamEndpoint: "http://127.0.0.1:9",
      testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
      testMcpCapabilityTimeoutMs: 0,
    }),
    /live MCP capability timeout seam is restricted to bounded exact-loopback unit tests/,
  );
  assert.throws(
    () => defaultLaunchTurn({
      ...supervisedBoundary,
      testMcpCapabilityTimeoutMs: 100,
    }),
    /live MCP capability timeout seam is restricted to bounded exact-loopback unit tests/,
  );
});

test("the inline Cursor wrapper remains plain JavaScript when Node type stripping is disabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-wrapper-plain-js-"));
  try {
    const child = defaultLaunchTurn({
      cursorBin: process.execPath,
      args: ["-e", `
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-plain-js" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "plain-js", session_id: "sess-plain-js" }) + "\\n");
`],
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        NODE_OPTIONS: "--no-experimental-strip-types",
      },
      deferStart: true,
    });
    const lines: string[] = [];
    child.onLine((line) => lines.push(line));

    await child.prepared;
    child.release();
    const exit = await withLoopAlive(child.exited);

    assert.deepEqual(exit, { type: "exit", code: 0, signal: null });
    assert.equal(child.stderrTail(), "");
    assert.equal(lines.some((line) => line.includes('"session_id":"sess-plain-js"')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cursorCliEnv passes the environment through without curation (v10 §3 — diverges from the legacy allowlist)", () => {
  const env = cursorCliEnv({ HOME: "/Users/someone", SOME_RANDOM_VAR: "kept", CURSOR_API_KEY: "kept-too" });
  assert.equal(env.SOME_RANDOM_VAR, "kept", "no allowlist: unknown vars survive");
  assert.equal(env.HOME, "/Users/someone");
  assert.equal(env.CURSOR_API_KEY, "kept-too");
});

test("daemon-owned Cursor starts idle without inference and gives only the first journaled turn exact bridge authority", async () => {
  const harness = createHarness();
  const previousOwnerToken = process.env.LETAGENTS_TOKEN;
  const previousBearer = process.env.LETAGENTS_AGENT_SESSION_BEARER;
  const previousStaleEntry = process.env.LETAGENTS_SUPERVISOR_ENTRY_ID;
  const previousGithubToken = process.env.GITHUB_TOKEN;
  const previousAwsSecret = process.env.AWS_SECRET_ACCESS_KEY;
  const previousNpmToken = process.env.NPM_TOKEN;
  process.env.LETAGENTS_TOKEN = "owner-token-must-not-leak";
  process.env.LETAGENTS_AGENT_SESSION_BEARER = "fixed-bearer-must-not-leak";
  process.env.LETAGENTS_SUPERVISOR_ENTRY_ID = "stale-entry";
  process.env.GITHUB_TOKEN = "github-must-not-leak";
  process.env.AWS_SECRET_ACCESS_KEY = "aws-must-not-leak";
  process.env.NPM_TOKEN = "npm-must-not-leak";
  try {
    const adapter = supervisedAdapter(harness);
    const handle = await spawnDaemonLane(adapter, harness);

    assert.deepEqual(adapter.capabilities().deliveryModes, ["mcp_polling", "daemon_inbox"]);
    assert.equal(adapter.capabilities().midTurnCorrection, false);
    assert.equal(harness.launches.length, 0, "lane creation performs no unjournaled bootstrap inference");
    assert.equal(handle.observedState(), "idle");
    assert.equal(handle.pid, null);
    assert.match(handle.providerContinuationId!, /^cursor-pending:/);

    let turnId = "";
    const turn = withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest(), {
      checkpointTurnStarted: async (value) => { turnId = value; },
    }));
    await flush();
    const launch = harness.launches[0]!;
    assert.equal(launch.args.includes("--force"), false, "daemon read-only Cursor never receives --force");
    assert.equal(harness.mcpAttestations.length, 2, "both registry shape and the real bridge are attested at the native turn boundary");
    const inspectionEnv = harness.mcpAttestations[0]!.env;
    const inspectionPreparations = harness.profilePreparations.filter((entry) => entry.profileRoot !== undefined);
    assert.equal(inspectionPreparations.length, 4);
    assert.equal(inspectionPreparations[0]?.includeAuth, false);
    assert.equal(inspectionPreparations[0]?.inspectionOnly, true);
    assert.equal(inspectionPreparations[1]?.includeAuth, false);
    assert.equal(inspectionPreparations[1]?.inspectionOnly, false);
    assert.deepEqual(inspectionPreparations[1]?.supervisorMcpEnv, {
      LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
      LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
      LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
    }, "the credentialless packaged-bridge pass discovers the exact Cursor completion tool surface");
    assert.equal(inspectionPreparations[2]?.includeAuth, true);
    assert.equal(inspectionPreparations[2]?.inspectionOnly, true);
    assert.equal(inspectionPreparations[3]?.includeAuth, true);
    assert.equal(inspectionPreparations[3]?.inspectionOnly, true);
    assert.equal(inspectionPreparations[0]?.profileRoot, harness.mcpAttestations[0]!.writableProfileRoot);
    assert.equal(inspectionPreparations[1]?.profileRoot, harness.mcpAttestations[1]!.writableProfileRoot);
    assert.notEqual(
      harness.mcpAttestations[1]!.writableProfileRoot,
      harness.mcpAttestations[0]!.writableProfileRoot,
      "the networked bridge never reuses the root exposed to pass one",
    );
    assert.equal(harness.mcpAttestations[0]!.cwd, harness.mcpAttestations[0]!.writableProfileRoot);
    assert.equal(harness.mcpAttestations[1]!.cwd, harness.mcpAttestations[1]!.writableProfileRoot);
    assert.equal(
      harness.mcpAttestations[0]!.expectedServerName,
      cursorSupervisedMcpServerName(inspectionPreparations[0]!.workAttemptId),
    );
    assert.equal(
      harness.mcpAttestations[1]!.expectedServerName,
      cursorSupervisedMcpServerName(inspectionPreparations[1]!.workAttemptId),
    );
    assert.equal(
      inspectionPreparations[1]?.mcpWorkingDirectory,
      harness.mcpAttestations[1]!.writableProfileRoot,
    );
    assert.deepEqual(
      harness.mcpAttestations[1]!.requiredReadableRoots,
      ["/Applications/LetAgents.app/runtime/letagents"],
    );
    assert.equal(harness.mcpAttestations[1]!.timeoutMs, 15_000);
    assert.equal(inspectionEnv.HOME, `${harness.mcpAttestations[0]!.writableProfileRoot}/home`);
    assert.equal(
      inspectionEnv.CURSOR_CONFIG_DIR,
      `${harness.mcpAttestations[0]!.writableProfileRoot}/config/cursor`,
    );
    assert.notEqual(inspectionEnv.HOME, launch.env?.HOME, "inspection and real turns never share a profile");
    assert.equal(inspectionEnv.CURSOR_API_KEY, undefined);
    assert.equal(inspectionEnv.CURSOR_AUTH_TOKEN, undefined);
    assert.equal(inspectionEnv.LETAGENTS_TOKEN, undefined);
    assert.equal(inspectionEnv.LETAGENTS_AGENT_SESSION_BEARER, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISOR_ENTRY_ID, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISOR_DAEMON_SOCKET, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISOR_AGENT_SESSION_ID, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISOR_PROVIDER, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID, undefined);
    assert.equal(inspectionEnv.LETAGENTS_SUPERVISED_BOUNDED_TURNS, undefined);
    assert.equal(inspectionEnv.LETAGENTS_EXECUTION_PROFILE, undefined);
    assert.equal(inspectionEnv.LETAGENTS_PERMISSION_PROFILE_ID, undefined);
    const bridgeEnv = harness.mcpAttestations[1]!.env;
    assert.notEqual(bridgeEnv.HOME, inspectionEnv.HOME);
    assert.equal(bridgeEnv.HOME, `${harness.mcpAttestations[1]!.writableProfileRoot}/home`);
    assert.equal(bridgeEnv.NPM_CONFIG_CACHE, undefined);
    assert.equal(bridgeEnv.CURSOR_API_KEY, undefined);
    assert.equal(bridgeEnv.CURSOR_AUTH_TOKEN, undefined);
    assert.equal(bridgeEnv.LETAGENTS_TOKEN, undefined);
    assert.equal(bridgeEnv.LETAGENTS_AGENT_SESSION_BEARER, undefined);
    assert.equal(bridgeEnv.LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID, undefined);
    assert.equal(bridgeEnv.LETAGENTS_SUPERVISED_BOUNDED_TURNS, undefined, "supervised mode is confined to the packaged MCP child config");
    assert.equal(bridgeEnv.LETAGENTS_EXECUTION_PROFILE, undefined, "supervised mode is confined to the packaged MCP child config");
    assert.equal(harness.identityAttestations.length, 1);
    assert.equal(harness.identityAttestations[0]!.cwd, inspectionPreparations[2]!.profileRoot);
    assert.equal(harness.identityAttestations[0]!.env.CURSOR_API_KEY, undefined);
    assert.equal(harness.identityAttestations[0]!.env.CURSOR_AUTH_TOKEN, undefined);
    assert.equal(harness.identityAttestations[0]!.env.LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID, undefined);
    const finalPreparation = harness.profilePreparations.find((entry) =>
      entry.mcpConnectorSocketPath !== undefined
    )!;
    assert.equal(finalPreparation.authSourceHomeDir, `${inspectionPreparations[3]!.profileRoot}/home`);
    assert.equal(finalPreparation.supervisorMcpEnv, undefined, "native-readable MCP config contains no supervisor coordinates");
    assert.deepEqual(Object.fromEntries(Object.entries(launch.mcpRuntimeEnv ?? {}).filter(([key]) =>
      key.startsWith("LETAGENTS_SUPERVISOR_")
        || key === "LETAGENTS_SUPERVISED_BOUNDED_TURNS"
        || key === "LETAGENTS_EXECUTION_PROFILE"
        || key === "LETAGENTS_PERMISSION_PROFILE_ID"
    )), {
      LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_cursor_1",
      LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/letagents-supervisor.sock",
      LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: "wa-cursor-1",
      LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "generation_cursor_1",
      LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
      LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: turnId,
      LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: "agent_session_cursor_1",
      LETAGENTS_SUPERVISOR_ROOM_ID: "github.com/example/repo",
      LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: "TidalHare",
      LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
      LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
      LETAGENTS_PERMISSION_PROFILE_ID: "read_only",
    });
    assert.equal(launch.mcpConnectorSocketPath, finalPreparation.mcpConnectorSocketPath);
    assert.deepEqual(launch.allowedNetworkUnixSockets, [finalPreparation.mcpConnectorSocketPath]);
    assert.equal(launch.args.includes("--approve-mcps"), true, "the sealed HOME letagents MCP is approved so complete_room_turn loads and the turn can attest; cursor-agent has no headless per-server approval, and the native sandbox denies every workspace .cursor/mcp.json read, so this approves exactly that one server");
    assert.equal(launch.args.includes("--disable-project-configs"), true, "native project permissions stay disabled");
    assert.equal(launch.args.includes("--disable-auto-update"), true, "native background updater stays disabled");
    assert.equal(argValue(launch.args, "--sandbox"), "enabled", "supervised read-only turns keep Cursor's native sandbox enabled");
    assert.equal(launch.cwd, "/private/cursor/wa-cursor-1", "project MCP discovery is isolated from --workspace");
    assert.equal(argValue(launch.args, "--workspace"), "/tmp/wa-cursor-1");
    assert.equal(launch.args.includes("--resume"), false, "the first durable turn establishes the native session");
    assert.equal(launch.env?.HOME, "/private/cursor/wa-cursor-1/home");
    assert.equal(launch.env?.CURSOR_API_KEY, undefined);
    assert.equal(launch.env?.CURSOR_AUTH_TOKEN, undefined, "the native environment contains no provider or placeholder token");
    assert.equal(launch.env?.AGENT_CLI_CREDENTIAL_STORE, "file", "the public argv placeholder stays in the private profile and never reaches Keychain");
    assert.equal(launch.env?.NPM_CONFIG_CACHE, undefined);
    assert.equal(launch.env?.LETAGENTS_TOKEN, undefined);
    assert.equal(launch.env?.LETAGENTS_AGENT_SESSION_BEARER, undefined);
    assert.equal(launch.env?.GITHUB_TOKEN, undefined);
    assert.equal(launch.env?.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(launch.env?.NPM_TOKEN, undefined);
    assert.equal(launch.env?.LETAGENTS_SUPERVISOR_ENTRY_ID, undefined);
    assert.equal(launch.env?.LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID, undefined);
    assert.equal(launch.env?.LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID, undefined);
    assert.equal(launch.env?.LETAGENTS_SUPERVISOR_AGENT_SESSION_ID, undefined);
    assert.equal(launch.env?.LETAGENTS_SUPERVISOR_PROVIDER, undefined);
    assert.equal(launch.env?.LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID, undefined);
    assert.equal(launch.env?.LETAGENTS_SUPERVISED_BOUNDED_TURNS, undefined);
    assert.equal(launch.env?.LETAGENTS_EXECUTION_PROFILE, undefined);
    assert.equal(launch.env?.LETAGENTS_PERMISSION_PROFILE_ID, undefined);
    const firstRuntimeDataDir = launch.env?.CURSOR_DATA_DIR;
    assert.match(firstRuntimeDataDir ?? "", /^\/(?:private\/)?tmp\/letagents-cursor-data-[A-Za-z0-9]{6}$/);
    assert.equal(existsSync(firstRuntimeDataDir!), true, "the live turn owns one private local-worker root");
    harness.children[0]!.emit({
      type: "result", subtype: "success", is_error: false,
      result: "ready through real work", session_id: "sess-cursor-1",
    });
    harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await flush();
    await turn;
    await flush();
    assert.equal(existsSync(firstRuntimeDataDir!), false, "turn terminal retirement removes the local-worker root");
    assert.equal(handle.observedState(), "idle");
    assert.equal(handle.pid, null, "a completed per-turn lane claims no idle process");
    assert.equal(handle.providerContinuationId, "sess-cursor-1");

    const resumeTurn = withLoopAlive(adapter.runRoomTurn(
      handle,
      roomTurnRequest({ inboxItemId: "inbox-cursor-private-data-resume" }),
    ));
    for (let index = 0; index < 100 && !harness.children[1]?.isReleased; index += 1) await flush();
    assert.equal(harness.children[1]?.isReleased, true);
    const resumeLaunch = harness.launches[1]!;
    const resumeRuntimeDataDir = resumeLaunch.env?.CURSOR_DATA_DIR;
    assert.match(resumeRuntimeDataDir ?? "", /^\/(?:private\/)?tmp\/letagents-cursor-data-[A-Za-z0-9]{6}$/);
    assert.notEqual(resumeRuntimeDataDir, firstRuntimeDataDir, "each resumed turn gets a fresh worker socket namespace");
    assert.equal(argValue(resumeLaunch.args, "--resume"), "sess-cursor-1");
    harness.children[1]!.emit({
      type: "result", subtype: "success", is_error: false,
      result: "resumed through private data", session_id: "sess-cursor-1",
    });
    harness.children[1]!.resolveExit({ type: "exit", code: 0, signal: null });
    await resumeTurn;
    await flush();
    assert.equal(existsSync(resumeRuntimeDataDir!), false);
  } finally {
    if (previousOwnerToken === undefined) delete process.env.LETAGENTS_TOKEN;
    else process.env.LETAGENTS_TOKEN = previousOwnerToken;
    if (previousBearer === undefined) delete process.env.LETAGENTS_AGENT_SESSION_BEARER;
    else process.env.LETAGENTS_AGENT_SESSION_BEARER = previousBearer;
    if (previousStaleEntry === undefined) delete process.env.LETAGENTS_SUPERVISOR_ENTRY_ID;
    else process.env.LETAGENTS_SUPERVISOR_ENTRY_ID = previousStaleEntry;
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithubToken;
    if (previousAwsSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = previousAwsSecret;
    if (previousNpmToken === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = previousNpmToken;
  }
});

test("the production Cursor profile keeps supervisor coordinates out of native config and passes them only to the wrapper MCP", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-production-profile-"));
  const workspace = join(root, "workspace");
  const sourceHome = join(root, "source-home");
  const statePath = join(root, "state", "mcp-state.json");
  const runtimePackage = join(root, "runtime", "node_modules", "letagents");
  const runtimeEntry = join(runtimePackage, "dist", "mcp", "server.js");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  mkdirSync(dirname(runtimeEntry), { recursive: true });
  writeFileSync(join(runtimePackage, "package.json"), JSON.stringify({
    name: "letagents",
    version: LETAGENTS_MCP_RUNTIME_VERSION,
  }));
  writeFileSync(runtimeEntry, "// exact development MCP fixture\n");

  const previousStatePath = process.env.LETAGENTS_STATE_PATH;
  const previousSourceHome = process.env.LETAGENTS_CURSOR_SOURCE_HOME;
  const previousDevMode = process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL;
  process.env.LETAGENTS_STATE_PATH = statePath;
  process.env.LETAGENTS_CURSOR_SOURCE_HOME = sourceHome;
  process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL = "http://127.0.0.1:5174";
  try {
    const harness = createHarness();
    const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
    const request = daemonSpawnRequest({
      workAttemptId: "wa-cursor-production-profile",
      cwd: workspace,
      devMcpServerEntryPath: runtimeEntry,
    });
    const handle = await adapter.spawn(request);
    let turnId = "";
    const turn = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "inbox-production-profile" }), {
      checkpointTurnStarted: async (value) => { turnId = value; },
    });
    await flush();

    const profileRoot = join(
      dirname(statePath),
      "cursor-supervised",
      createHash("sha256").update(request.workAttemptId).digest("hex").slice(0, 32),
    );
    const serverName = cursorSupervisedMcpServerName(request.workAttemptId);
    const server = JSON.parse(
      readFileSync(join(profileRoot, "home", ".cursor", "mcp.json"), "utf8"),
    ).mcpServers[serverName];
    assert.deepEqual(server.env, { ELECTRON_RUN_AS_NODE: "1" });
    assert.equal(JSON.stringify(server).includes("LETAGENTS_SUPERVISOR_"), false);
    assert.equal(server.args.at(-1), harness.launches[0]!.mcpConnectorSocketPath);
    assert.deepEqual(
      Object.fromEntries(Object.entries(harness.launches[0]!.mcpRuntimeEnv ?? {})
        .filter(([key]) => key.startsWith("LETAGENTS_SUPERVISOR_")
          || key === "LETAGENTS_SUPERVISED_BOUNDED_TURNS"
          || key === "LETAGENTS_EXECUTION_PROFILE"
          || key === "LETAGENTS_PERMISSION_PROFILE_ID")),
      {
        LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_cursor_1",
        LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/letagents-supervisor.sock",
        LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: request.workAttemptId,
        LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "generation_cursor_1",
        LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
        LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: turnId,
        LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: "agent_session_cursor_1",
        LETAGENTS_SUPERVISOR_ROOM_ID: "github.com/example/repo",
        LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: "TidalHare",
        LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
        LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
        LETAGENTS_PERMISSION_PROFILE_ID: "read_only",
      },
    );
    assert.equal(harness.launches[0]!.env?.LETAGENTS_SUPERVISOR_ENTRY_ID, undefined);
    assert.ok(
      harness.launches[0]!.deniedReadPaths?.some((path) => path.endsWith("/workspace/.cursor/hooks.json")),
      "the final native process receives exact project hook read denials",
    );
    assert.ok(
      harness.launches[0]!.deniedReadSubpaths?.some((path) => path.endsWith("/home/.cursor/plugins")),
      "the final native process cannot load profile-persisted plugins",
    );
    assert.equal(
      harness.launches[0]!.restrictRemoteAuthority,
      true,
      "the final native process receives the remote-authority control-plane fence",
    );

    harness.children[0]!.emit({
      type: "result", subtype: "success", is_error: false,
      result: "ready", session_id: "sess-cursor-1",
    });
    harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await flush();
    await turn;
  } finally {
    if (previousStatePath === undefined) delete process.env.LETAGENTS_STATE_PATH;
    else process.env.LETAGENTS_STATE_PATH = previousStatePath;
    if (previousSourceHome === undefined) delete process.env.LETAGENTS_CURSOR_SOURCE_HOME;
    else process.env.LETAGENTS_CURSOR_SOURCE_HOME = previousSourceHome;
    if (previousDevMode === undefined) delete process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL;
    else process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL = previousDevMode;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production wrapper hosts one exact MCP connector across fresh and resume turns, then revokes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-connector-e2e-"));
  const workspace = join(root, "workspace");
  const sourceHome = join(root, "source-home");
  const statePath = join(root, "state", "mcp-state.json");
  const runtimePackage = join(root, "runtime", "node_modules", "letagents");
  const runtimeEntry = join(runtimePackage, "dist", "mcp", "server.js");
  const runtimePidPath = join(root, "runtime.pid");
  const runtimeDescendantPidPath = join(root, "runtime-descendant.pid");
  const managedProfileRoot = join(
    dirname(statePath),
    "cursor-supervised",
    createHash("sha256").update("wa-cursor-connector-e2e").digest("hex").slice(0, 32),
  );
  const stubbornModePath = join(managedProfileRoot, "tmp", "stubborn-native-mode");
  const stubbornPidPath = join(managedProfileRoot, "tmp", "stubborn-native.pid");
  const cursorBin = join(root, "fake-cursor-agent");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  mkdirSync(dirname(runtimeEntry), { recursive: true });
  writeFileSync(join(runtimePackage, "package.json"), JSON.stringify({
    name: "letagents",
    version: LETAGENTS_MCP_RUNTIME_VERSION,
  }));
writeFileSync(runtimeEntry, `
const readline = require("node:readline");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
fs.writeFileSync(${JSON.stringify(runtimePidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
descendant.unref();
fs.writeFileSync(${JSON.stringify(runtimeDescendantPidPath)}, String(descendant.pid));
const required = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", "NODE_COMPILE_CACHE"];
const boundaryValid = process.env.LETAGENTS_SUPERVISOR_ENTRY_ID === "supervised_cursor_1"
  && process.env.LETAGENTS_SUPERVISOR_DAEMON_SOCKET === "/tmp/letagents-supervisor.sock"
  && process.env.LETAGENTS_SUPERVISOR_PROVIDER === "cursor"
  && process.env.LETAGENTS_SUPERVISED_BOUNDED_TURNS === "1"
  && process.env.LETAGENTS_EXECUTION_PROFILE === "supervised_room_turn"
  && process.env.LETAGENTS_PERMISSION_PROFILE_ID === "read_only"
  && !process.env.LETAGENTS_TOKEN
  && !process.env.LETAGENTS_AGENT_SESSION_BEARER
  && required.every((key) => {
    try { const stat = fs.lstatSync(process.env[key]); return stat.isDirectory() && !stat.isSymbolicLink(); }
    catch { return false; }
  });
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  const result = request.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : request.method === "tools/list"
      ? { tools: boundaryValid ? [
        { name: "connector_boundary_valid", description: "ok", inputSchema: { type: "object" } },
        {
          name: "complete_room_turn",
          description: "complete the room turn",
          inputSchema: {
            type: "object",
            properties: {
              outcome: { type: "string", enum: ["reply", "no_reply"] },
              text: { type: "string" },
            },
            required: ["outcome"],
          },
        },
      ] : [] }
      : request.method === "fixture/large"
        ? { payload: "x".repeat(2 * 1024 * 1024) }
      : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`);
  writeFileSync(cursorBin, `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const args = process.argv.slice(2);
const diag = process.env.TMPDIR + "/connector-diag.log";
function note(value) { fs.appendFileSync(diag, value + "\\n"); }
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  const config = JSON.parse(fs.readFileSync(process.env.HOME + "/.cursor/mcp.json", "utf8"));
  process.stdout.write(Object.keys(config.mcpServers)[0] + ": ready\\n");
  process.exit(0);
}
const configText = fs.readFileSync(process.env.HOME + "/.cursor/mcp.json", "utf8");
note("config-read");
if (configText.includes("LETAGENTS_SUPERVISOR_")
  || Object.keys(process.env).some((key) => key.startsWith("LETAGENTS_SUPERVISOR_"))) process.exit(71);
const config = JSON.parse(configText);
const server = Object.values(config.mcpServers)[0];
const socketPath = server.args[server.args.length - 1];
const connector = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
note("connector-spawned:" + connector.pid);
const lines = readline.createInterface({ input: connector.stdout });
let initialized = false;
let listed = false;
let largeResponse = false;
let secondBlocked = false;
let finished = false;
function finishIfReady() {
  if (finished || !initialized || !listed || !largeResponse || !secondBlocked) return;
  finished = true;
  if (fs.existsSync(${JSON.stringify(stubbornModePath)})) {
    const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    stubborn.unref();
    fs.writeFileSync(${JSON.stringify(stubbornPidPath)}, String(stubborn.pid));
  }
  const resume = args.find((arg) => arg.startsWith("--resume="));
  const session = resume ? resume.slice("--resume=".length) : "sess-connector-e2e";
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: session }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "connector-ok:" + socketPath, session_id: session }) + "\\n");
  setTimeout(() => connector.stdin.end(), 250);
  if (fs.existsSync(${JSON.stringify(stubbornModePath)})) setTimeout(() => process.exit(0), 100);
}
lines.on("line", (line) => {
  note("connector-line:" + line);
  const response = JSON.parse(line);
  if (response.id === 1) initialized = true;
  if (response.id === 2) listed = response.result.tools.some((tool) => tool.name === "connector_boundary_valid");
  if (response.id === 3) largeResponse = response.result.payload.length === 2 * 1024 * 1024;
  finishIfReady();
});
connector.once("error", () => process.exit(72));
connector.once("close", (code, signal) => note("connector-close:" + code + ":" + signal));
connector.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }) + "\\n");
connector.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\\n");
connector.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "fixture/large", params: {} }) + "\\n");
setTimeout(() => {
  const second = net.createConnection({ path: socketPath });
  let accepted = false;
  second.once("connect", () => { accepted = true; second.write("replay"); });
  second.once("error", () => { secondBlocked = true; finishIfReady(); });
  second.once("close", () => { if (accepted) { secondBlocked = true; finishIfReady(); } });
}, 25);
setTimeout(() => process.exit(73), 5000).unref();
`);
  chmodSync(cursorBin, 0o700);

  const previousStatePath = process.env.LETAGENTS_STATE_PATH;
  const previousSourceHome = process.env.LETAGENTS_CURSOR_SOURCE_HOME;
  const previousDevMode = process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL;
  let stubbornPid: number | null = null;
  let thirdRuntimePid: number | null = null;
  let thirdRuntimeDescendantPid: number | null = null;
  const connectorRoots: string[] = [];
  process.env.LETAGENTS_STATE_PATH = statePath;
  process.env.LETAGENTS_CURSOR_SOURCE_HOME = sourceHome;
  process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL = "http://127.0.0.1:5174";
  try {
    const adapter = new CursorProviderAdapter({
      cursorBin,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          connectorRoots.push(dirname(input.mcpConnectorSocketPath!));
          return defaultLaunchTurn(input);
        },
      },
    });
    const request = daemonSpawnRequest({
      workAttemptId: "wa-cursor-connector-e2e",
      cwd: workspace,
      devMcpServerEntryPath: runtimeEntry,
    });
    const handle = await adapter.spawn(request);
    let first;
    try {
      first = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "connector-first" })));
    } catch (error) {
      const profileRoot = join(
        dirname(statePath),
        "cursor-supervised",
        createHash("sha256").update(request.workAttemptId).digest("hex").slice(0, 32),
      );
      const diagnostic = existsSync(join(profileRoot, "tmp", "connector-diag.log"))
        ? readFileSync(join(profileRoot, "tmp", "connector-diag.log"), "utf8")
        : "no-native-diagnostic";
      const terminals = existsSync(join(profileRoot, "config"))
        ? readdirSync(join(profileRoot, "config")).filter((entry) => entry.endsWith(".terminal.json"))
          .map((entry) => readFileSync(join(profileRoot, "config", entry), "utf8"))
        : [];
      throw new Error(`${error instanceof Error ? error.message : String(error)}; ${diagnostic}; ${terminals.join(";")}`);
    }
    const firstSocket = first.text!.slice("connector-ok:".length);
    assert.equal(existsSync(dirname(firstSocket)), false, "fresh-turn connector root is removed at terminal");
    const firstRuntimePid = Number(readFileSync(runtimePidPath, "utf8"));
    const firstRuntimeDescendantPid = Number(readFileSync(runtimeDescendantPidPath, "utf8"));
    assert.throws(
      () => process.kill(firstRuntimePid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      "terminal publication waits for TERM-resistant wrapper MCP retirement",
    );
    assert.throws(
      () => process.kill(firstRuntimeDescendantPid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      "terminal publication waits for the detached MCP process group's descendants",
    );
    const second = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "connector-resume" })));
    const secondSocket = second.text!.slice("connector-ok:".length);
    assert.notEqual(secondSocket, firstSocket, "resume receives a new one-turn connector capability");
    assert.equal(existsSync(dirname(secondSocket)), false, "resume connector root is removed at terminal");
    const secondRuntimePid = Number(readFileSync(runtimePidPath, "utf8"));
    const secondRuntimeDescendantPid = Number(readFileSync(runtimeDescendantPidPath, "utf8"));
    assert.notEqual(secondRuntimePid, firstRuntimePid);
    assert.throws(
      () => process.kill(secondRuntimePid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      "resume terminal also proves wrapper MCP retirement",
    );
    assert.throws(
      () => process.kill(secondRuntimeDescendantPid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      "resume terminal also proves the MCP runtime group is empty",
    );
    assert.equal(handle.providerContinuationId, "sess-connector-e2e");

    writeFileSync(stubbornModePath, "enabled\n");
    await assert.rejects(
      withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "connector-stubborn-native" }))),
      // A forced process-group reap deliberately kills the wrapper too. The
      // exact fail-closed observation depends on whether its already-buffered
      // init/result reaches the parent before that SIGKILL: the connector can
      // close before init, the bounded turn can lose terminal evidence, or
      // startup can remain unobservable. Every path must reject, and the PID
      // assertions below prove the intended authority-before-group-reap ordering
      // independently.
      /(?:live MCP connector ended before the turn became terminal|ended before the bounded room turn produced a terminal result|exited before reporting its stream-json init)/,
    );
    assert.equal(await waitForPath(stubbornPidPath), true, "the combined teardown fixture launched its stubborn native member");
    stubbornPid = Number(readFileSync(stubbornPidPath, "utf8"));
    thirdRuntimePid = Number(readFileSync(runtimePidPath, "utf8"));
    thirdRuntimeDescendantPid = Number(readFileSync(runtimeDescendantPidPath, "utf8"));
    assert.notEqual(thirdRuntimePid, secondRuntimePid);
    assert.throws(
      () => process.kill(thirdRuntimePid!, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      "detached MCP retirement completes before native group escalation can kill the wrapper",
    );
    assert.throws(
      () => process.kill(thirdRuntimeDescendantPid!, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      "MCP group retirement kills a TERM-resistant descendant before terminal evidence",
    );
    assert.throws(
      () => process.kill(stubbornPid!, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      "the subsequent group escalation reaps the TERM-resistant native member",
    );
    assert.equal(connectorRoots.length, 3);
    assert.equal(
      existsSync(connectorRoots[2]!),
      false,
      "adapter-owned exit cleanup removes the connector root when SIGKILL prevents wrapper cleanup",
    );
  } finally {
    for (const pid of [thirdRuntimeDescendantPid, thirdRuntimePid, stubbornPid]) {
      if (pid && Number.isSafeInteger(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
    if (previousStatePath === undefined) delete process.env.LETAGENTS_STATE_PATH;
    else process.env.LETAGENTS_STATE_PATH = previousStatePath;
    if (previousSourceHome === undefined) delete process.env.LETAGENTS_CURSOR_SOURCE_HOME;
    else process.env.LETAGENTS_CURSOR_SOURCE_HOME = previousSourceHome;
    if (previousDevMode === undefined) delete process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL;
    else process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL = previousDevMode;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production wrapper refuses a recycled MCP runtime process group before signaling", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-runtime-recycled-group-"));
  const statePath = join(root, "turn.jsonl");
  const cursorBin = join(root, "fake-cursor-agent");
  const preloadPath = join(root, "recycled-group-preload.cjs");
  const runtimePidPath = join(root, "runtime.pid");
  const preloadLoadedPath = join(root, "preload-loaded.log");
  const initialIdentityPath = join(root, "initial-identity.log");
  const identityProbePath = join(root, "identity-probe.log");
  const groupSignalPath = join(root, "group-signal.log");
  const connectorRoot = join("/tmp", `letagents-cursor-mcp-${randomUUID()}`);
  const connectorSocketPath = join(connectorRoot, "stdio.sock");
  const runtimeDataRoot = mkdtempSync("/tmp/letagents-cursor-data-");
  writeFileSync(statePath, "");
  const hostedMcp = wrapperHostedMcpFixture(root, connectorSocketPath, "valid", true);
  const runtimeEntryPath = hostedMcp.mcpRuntimeEntryPath!;
  writeFileSync(runtimeEntryPath, `
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(runtimePidPath)}, String(process.pid));
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  const result = request.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : request.method === "tools/list"
      ? { tools: [{
          name: "complete_room_turn",
          description: "complete room turn",
          inputSchema: {
            type: "object",
            properties: {
              outcome: { type: "string", enum: ["reply", "no_reply"] },
              text: { type: "string" },
            },
            required: ["outcome"],
          },
        }] }
      : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  if (request.method === "tools/list") setTimeout(() => process.exit(0), 25);
});
`);
  writeFileSync(preloadPath, `
const fs = require("node:fs");
const childProcess = require("node:child_process");
const originalSpawnSync = childProcess.spawnSync;
const originalKill = process.kill.bind(process);
fs.appendFileSync(${JSON.stringify(preloadLoadedPath)}, String(process.pid) + "\\n");
let exactIdentityReads = 0;
function runtimePid() {
  try { return Number(fs.readFileSync(${JSON.stringify(runtimePidPath)}, "utf8")); }
  catch { return null; }
}
childProcess.spawnSync = function(command, args, options) {
  if (command === "/bin/ps" && Array.isArray(args)
    && args.includes("pid=,ppid=,pgid=,lstart=")) {
    exactIdentityReads += 1;
    if (exactIdentityReads === 1) {
      const observed = originalSpawnSync.call(this, command, args, options);
      fs.writeFileSync(${JSON.stringify(initialIdentityPath)}, JSON.stringify({
        args, status: observed.status, stdout: observed.stdout, error: observed.error && observed.error.message,
      }));
      return observed;
    }
    const pid = Number(args[args.indexOf("-p") + 1]);
    fs.appendFileSync(${JSON.stringify(identityProbePath)}, "recycled\\n");
    return {
      pid: 0,
      output: [null, pid + " 1 " + pid + " Thu Jan  1 00:00:00 1970\\n", ""],
      stdout: pid + " 1 " + pid + " Thu Jan  1 00:00:00 1970\\n",
      stderr: "",
      status: 0,
      signal: null,
    };
  }
  if (command === "/bin/ps" && Array.isArray(args)
    && args[0] === "-axo" && args[1] === "pid=,pgid=") {
    const pid = runtimePid();
    if (pid) {
      const observed = originalSpawnSync.call(this, command, args, options);
      const stdout = String(observed.stdout || "")
        + String(pid + 100000) + " " + String(pid) + "\\n";
      return {
        pid: 0,
        output: [null, stdout, observed.stderr || ""],
        stdout,
        stderr: observed.stderr || "",
        status: observed.status,
        signal: observed.signal,
      };
    }
  }
  return originalSpawnSync.call(this, command, args, options);
};
process.kill = function(target, signal) {
  const pid = runtimePid();
  if (pid && target === -pid) {
    fs.appendFileSync(${JSON.stringify(groupSignalPath)}, String(signal) + "\\n");
    return true;
  }
  return originalKill(target, signal);
};
`);
  writeFileSync(cursorBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
attestFixtureMcp().then(() => setInterval(() => {}, 1000)).catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + "\\n");
  process.exit(84);
});
`);
  chmodSync(cursorBin, 0o700);
  let child: CursorCliChild | null = null;
  try {
    child = defaultLaunchTurn({
      cursorBin,
      args: ["-p", "--output-format", "stream-json", "recycled MCP runtime group"],
      cwd: root,
      env: {
        HOME: join(root, "home"),
        CURSOR_DATA_DIR: runtimeDataRoot,
        NODE_OPTIONS: `--require=${preloadPath}`,
        PATH: process.env.PATH,
      },
      deferStart: true,
      statePath,
      mcpConnectorSocketPath: connectorSocketPath,
      mcpRuntimeEntryPath: runtimeEntryPath,
      mcpRuntimeCwd: root,
      mcpRuntimeEnv: wrapperMcpRuntimeEnv(connectorRoot, "cursor:recycled-mcp-runtime-group"),
      providerAuthorization: "Bearer recycled-mcp-runtime-provider-proof",
      restrictRemoteAuthority: true,
      allowedWriteSubpaths: [root, realpathSync(root), runtimeDataRoot, realpathSync(runtimeDataRoot)],
      allowedReadSubpaths: [root, realpathSync(root)],
      allowedNetworkUnixSockets: [connectorSocketPath],
      testAgentUpstreamEndpoint: "http://127.0.0.1:9",
      testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
    });
    await child.prepared;
    child.release();
    const exit = await withLoopAlive(child.exited);

    assert.equal(exit.type, "exit");
    const terminal = JSON.parse(readFileSync(`${statePath}.terminal.json`, "utf8"));
    assert.equal(existsSync(preloadLoadedPath), true, `the adversarial process shim loaded: ${child.stderrTail()}`);
    assert.equal(existsSync(initialIdentityPath), true, "spawn records the original runtime leader's exact birth and ancestry");
    assert.equal(existsSync(identityProbePath), true, "retirement observes that the original group leader birth changed");
    assert.equal(existsSync(groupSignalPath), false, "the recycled numeric PGID receives neither TERM nor KILL");
    assert.equal(terminal.remote_authority_revoked, false, "ambiguous recycled-group retirement stays fail closed");
  } finally {
    if (child?.pid) {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
    }
    rmSync(connectorRoot, { recursive: true, force: true });
    rmSync(runtimeDataRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("the exact live Cursor connector rejects a swapped runtime with a missing or malformed completion contract", async () => {
  for (const completionContract of ["missing", "wrong_type", "enum_superset", "required_text"] as const) {
    const root = mkdtempSync(join(tmpdir(), `letagents-cursor-live-contract-${completionContract}-`));
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    const cursorBin = join(root, "fake-cursor-agent");
    const connectorRoots: string[] = [];
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(cursorBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
attestFixtureMcp().then(() => {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "unexpected" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "unexpected", session_id: "unexpected" }) + "\\n");
}).catch(() => process.exit(81));
`);
    chmodSync(cursorBin, 0o700);
    try {
      const adapter = new CursorProviderAdapter({
        cursorBin,
        dependencies: {
          ...productionPersonalIdentityDependencies,
          launchTurn(input) {
            connectorRoots.push(dirname(input.mcpConnectorSocketPath!));
            return defaultLaunchTurn(input);
          },
        },
        supervisedProfileFactory: (input) => ({
          homeDir,
          configDir,
          dataDir: join(root, "data"),
          cacheDir: join(root, "cache"),
          env: { HOME: homeDir },
          ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, completionContract, true),
        }),
      });
      const handle = await adapter.spawn(daemonSpawnRequest({
        workAttemptId: `wa-cursor-live-contract-${completionContract}`,
        cwd: root,
      }));
      await assert.rejects(
        withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
          inboxItemId: `live-contract-${completionContract}`,
        }))),
        /live MCP runtime does not expose the required complete_room_turn contract/,
      );
      assert.equal(connectorRoots.length, 1, "the earlier registry preflight passed before the exact live swap was rejected");
      assert.equal(existsSync(connectorRoots[0]!), false, "the failed exact connector capability is revoked");
      const runtimePid = Number(readFileSync(join(root, "bridge", "runtime.pid"), "utf8"));
      assert.throws(
        () => process.kill(runtimePid, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
        "the rejected live runtime is reaped before the adapter reports failure",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the exact live Cursor connector rejects bounded capability-attestation floods", async () => {
  // Client-side floods no longer exist as an attestation concern: the wrapper
  // proves the contract against its hosted runtime before Cursor launches, and
  // client traffic is piped only after attestation settles. A runtime that
  // floods the wrapper's own bounded handshake still fails before launch.
  for (const floodMode of ["runtime_frames", "runtime_bytes"] as const) {
    const root = mkdtempSync(join(tmpdir(), `letagents-cursor-live-flood-${floodMode}-`));
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    const cursorBin = join(root, "fake-cursor-agent");
    const connectorRoots: string[] = [];
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(cursorBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
attestFixtureMcp().then(() => {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "unexpected" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "unexpected", session_id: "unexpected" }) + "\\n");
}).catch(() => process.exit(82));
`);
    chmodSync(cursorBin, 0o700);
    try {
      const adapter = new CursorProviderAdapter({
        cursorBin,
        dependencies: {
          ...productionPersonalIdentityDependencies,
          launchTurn(input) {
            connectorRoots.push(dirname(input.mcpConnectorSocketPath!));
            return defaultLaunchTurn(input);
          },
        },
        supervisedProfileFactory: (input) => ({
          homeDir,
          configDir,
          dataDir: join(root, "data"),
          cacheDir: join(root, "cache"),
          env: { HOME: homeDir },
          ...wrapperHostedMcpFixture(
            root,
            input.mcpConnectorSocketPath,
            floodMode === "runtime_frames"
              ? "frame_flood"
              : floodMode === "runtime_bytes"
                ? "byte_flood"
                : "valid",
            true,
          ),
        }),
      });
      const handle = await adapter.spawn(daemonSpawnRequest({
        workAttemptId: `wa-cursor-live-flood-${floodMode}`,
        cwd: root,
      }));
      await assert.rejects(
        withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
          inboxItemId: `live-flood-${floodMode}`,
        }))),
        /bounded capability-attestation exchange/,
      );
      assert.equal(connectorRoots.length, 1);
      assert.equal(existsSync(connectorRoots[0]!), false, "the flooded connector capability is revoked");
      const runtimePidPath = join(root, "bridge", "runtime.pid");
      if (existsSync(runtimePidPath)) {
        const runtimePid = Number(readFileSync(runtimePidPath, "utf8"));
        assert.throws(
          () => process.kill(runtimePid, 0),
          (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
          "the flooded live runtime is reaped before the adapter reports failure",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the exact live Cursor connector accepts a cold native MCP handshake within the turn-start deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-live-contract-delayed-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const cursorBin = join(root, "fake-cursor-agent");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(cursorBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
setTimeout(() => {
  attestFixtureMcp().then((connector) => {
    detachFixtureMcp(connector);
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-delayed-mcp" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "delayed-mcp-ok", session_id: "sess-delayed-mcp" }) + "\\n");
  }).catch(() => process.exit(83));
}, 100);
`);
  chmodSync(cursorBin, 0o700);
  try {
    const adapter = new CursorProviderAdapter({
      cursorBin,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          return defaultLaunchTurn({
            ...input,
            testAgentUpstreamEndpoint: "http://127.0.0.1:9",
            testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
            testMcpCapabilityTimeoutMs: 500,
          });
        },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({
      workAttemptId: "wa-cursor-live-contract-delayed",
      cwd: root,
    }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
      inboxItemId: "live-contract-delayed",
    })));
    assert.equal(result.text, "delayed-mcp-ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Cursor's headless worker spawns a helper that binds a private stdio socket
// under its per-turn CURSOR_DATA_DIR. A unix-socket listen() is network-inbound;
// an absolute inbound deny EPERMs that bind and the worker dies before the MCP
// client ever connects. These launch a real sandboxed wrapper whose fake
// cursor-agent binds a socket inside its data dir (must succeed) and inside a
// path that is file-writable but outside the socket namespace (must stay
// denied), so the guard fails if the inbound exception is removed or widened.
async function runSupervisedWorkerSocketProbe(options: {
  label: string;
  dataRoot: string;
  outsideRoot: string;
  probeBeforeBindMs?: number;
}): Promise<{ inside: string; outside: string; stderrTail: string }> {
  const root = mkdtempSync(join(tmpdir(), `letagents-cursor-worker-sock-${options.label}-`));
  const statePath = join(root, "turn.jsonl");
  const cursorBin = join(root, "fake-cursor-agent");
  const connectorRoot = join("/tmp", `letagents-cursor-mcp-${randomUUID()}`);
  const connectorSocketPath = join(connectorRoot, "stdio.sock");
  const sockprobePath = join(root, "sockprobe.json");
  writeFileSync(statePath, "");
  const hostedMcp = wrapperHostedMcpFixture(root, connectorSocketPath, "valid", true);
  const runtimeEntryPath = hostedMcp.mcpRuntimeEntryPath!;
  writeFileSync(cursorBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function tryBind(socketPath) {
  return new Promise((resolve) => {
    try { fs.mkdirSync(path.dirname(socketPath), { recursive: true }); } catch {}
    try { fs.unlinkSync(socketPath); } catch {}
    const server = net.createServer();
    server.once("error", (error) => resolve(error.code || String(error.errno) || "ERR"));
    try { server.listen(socketPath, () => server.close(() => resolve("OK"))); }
    catch (error) { resolve(error.code || "THROW"); }
  });
}
(async () => {
  await new Promise((resolve) => setTimeout(resolve, ${Number(options.probeBeforeBindMs ?? 0)}));
  const inside = await tryBind(path.join(process.env.CURSOR_DATA_DIR, "projects", "sandboxed-worktree", "worker.sock"));
  const outside = await tryBind(path.join(${JSON.stringify(options.outsideRoot)}, "projects", "sandboxed-worktree", "worker.sock"));
  fs.writeFileSync(${JSON.stringify(sockprobePath)}, JSON.stringify({ inside, outside }));
  attestFixtureMcp().then((connector) => {
    detachFixtureMcp(connector);
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-${options.label}" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "sockprobe-ok", session_id: "sess-${options.label}" }) + "\\n");
  }).catch(() => process.exit(83));
})();
`);
  chmodSync(cursorBin, 0o700);
  let child: CursorCliChild | null = null;
  try {
    child = defaultLaunchTurn({
      cursorBin,
      args: ["-p", "--output-format", "stream-json", `worker socket probe ${options.label}`],
      cwd: root,
      env: { HOME: join(root, "home"), CURSOR_DATA_DIR: options.dataRoot, PATH: process.env.PATH },
      deferStart: true,
      statePath,
      mcpConnectorSocketPath: connectorSocketPath,
      mcpRuntimeEntryPath: runtimeEntryPath,
      mcpRuntimeCwd: root,
      mcpRuntimeEnv: wrapperMcpRuntimeEnv(connectorRoot, `cursor:worker-socket-${options.label}`),
      providerAuthorization: "Bearer worker-socket-probe-proof",
      restrictRemoteAuthority: true,
      // The outside root is file-writable but is NOT a permitted socket root,
      // so any bind failure there is the network boundary, not a write denial.
      allowedWriteSubpaths: [
        root, realpathSync(root),
        options.dataRoot, realpathSync(options.dataRoot),
        options.outsideRoot, realpathSync(options.outsideRoot),
      ],
      allowedReadSubpaths: [root, realpathSync(root)],
      allowedNetworkUnixSockets: [connectorSocketPath],
      allowedInternalUnixSocketRoots: [options.dataRoot, realpathSync(options.dataRoot)],
      testAgentUpstreamEndpoint: "http://127.0.0.1:9",
      testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
      testMcpCapabilityTimeoutMs: 5000,
    });
    await child.prepared;
    child.release();
    await withLoopAlive(child.exited).catch(() => {});
    const probe = JSON.parse(readFileSync(sockprobePath, "utf8"));
    return { inside: probe.inside, outside: probe.outside, stderrTail: child.stderrTail() };
  } finally {
    if (child?.pid) { try { process.kill(child.pid, "SIGKILL"); } catch {} }
    rmSync(connectorRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

test("supervised Cursor binds its private worker socket only inside its per-turn data dir", {
  // The network sandbox that admits this bind is macOS seatbelt only (see the
  // `sandboxed = process.platform === "darwin"` gate in the adapter).
  skip: process.platform !== "darwin",
}, async () => {
  const dataRoot = mkdtempSync("/tmp/letagents-cursor-data-");
  const outsideRoot = mkdtempSync("/tmp/letagents-cursor-outside-");
  try {
    const result = await runSupervisedWorkerSocketProbe({ label: "solo", dataRoot, outsideRoot });
    assert.equal(result.inside, "OK",
      `Cursor's headless worker binds its private stdio socket under CURSOR_DATA_DIR (stderr: ${result.stderrTail})`);
    assert.equal(result.outside, "EPERM",
      "a unix-socket listen() outside the per-turn data dir stays denied even where file writes are permitted");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("concurrent supervised Cursor turns keep isolated worker-socket namespaces and a slow worker still binds", {
  // macOS seatbelt only — the network-inbound boundary does not exist off darwin.
  skip: process.platform !== "darwin",
}, async () => {
  // Random per-turn data dirs (different paths). Each turn's "outside" root is
  // the OTHER turn's data root, so a pass proves one supervised turn can never
  // bind inside a peer's private namespace. One worker starts late to show the
  // static rule does not depend on startup timing.
  const dataRootA = mkdtempSync("/tmp/letagents-cursor-data-");
  const dataRootB = mkdtempSync("/tmp/letagents-cursor-data-");
  try {
    const [a, b] = await Promise.all([
      runSupervisedWorkerSocketProbe({ label: "concurrent-a", dataRoot: dataRootA, outsideRoot: dataRootB, probeBeforeBindMs: 300 }),
      runSupervisedWorkerSocketProbe({ label: "concurrent-b", dataRoot: dataRootB, outsideRoot: dataRootA }),
    ]);
    assert.equal(a.inside, "OK", `slow-starting turn A still binds its own worker socket (stderr: ${a.stderrTail})`);
    assert.equal(a.outside, "EPERM", "turn A cannot bind inside turn B's per-turn namespace");
    assert.equal(b.inside, "OK", `turn B binds its own worker socket (stderr: ${b.stderrTail})`);
    assert.equal(b.outside, "EPERM", "turn B cannot bind inside turn A's per-turn namespace");
  } finally {
    rmSync(dataRootA, { recursive: true, force: true });
    rmSync(dataRootB, { recursive: true, force: true });
  }
});

test("the exact live Cursor connector times out and reaps native work when Cursor never connects", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-live-contract-no-connector-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const cursorBin = join(root, "fake-cursor-agent");
  const nativePidPath = join(root, "tmp", "native.pid");
  const connectorRoots: string[] = [];
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(dirname(nativePidPath), { recursive: true });
  writeFileSync(cursorBin, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(nativePidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`);
  chmodSync(cursorBin, 0o700);
  try {
    const adapter = new CursorProviderAdapter({
      cursorBin,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          connectorRoots.push(dirname(input.mcpConnectorSocketPath!));
          return defaultLaunchTurn({
            ...input,
            testAgentUpstreamEndpoint: "http://127.0.0.1:9",
            testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
            // Budgets BOTH the wrapper's verify handshake and the connect
            // wait; too tight and a slow node cold-start times verify out
            // first, changing the expected failure message.
            testMcpCapabilityTimeoutMs: 500,
          });
        },
      },
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({
      workAttemptId: "wa-cursor-live-contract-no-connector",
      cwd: root,
    }));
    await assert.rejects(
      withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "live-contract-no-connector" }))),
      /never connected the attested MCP runtime before model authority/,
    );
    assert.equal(await waitForPath(nativePidPath), true);
    const nativePid = Number(readFileSync(nativePidPath, "utf8"));
    assert.throws(
      () => process.kill(nativePid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      "the connector deadline reaps native work that never initialized MCP",
    );
    assert.equal(connectorRoots.length, 1);
    assert.equal(existsSync(connectorRoots[0]!), false, "the unclaimed connector capability is removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a wedged hosted runtime fails the verify deadline before any native launch and is reaped", async () => {
  // The verify-phase timeout is the only bound between wrapper start and
  // connector listen; this pins it so a mutation that drops the deadline
  // (reintroducing an unbounded startup wait) fails loudly.
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-live-wedged-runtime-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const cursorBin = join(root, "fake-cursor-agent");
  const nativePidPath = join(root, "tmp", "native.pid");
  const wedgedRuntime = join(root, "wedged-runtime.cjs");
  const wedgedPidPath = join(root, "wedged-runtime.pid");
  const connectorRoots: string[] = [];
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(dirname(nativePidPath), { recursive: true });
  writeFileSync(wedgedRuntime, `
require("node:fs").writeFileSync(${JSON.stringify(wedgedPidPath)}, String(process.pid));
process.stdin.on("data", () => {});
setInterval(() => {}, 1000);
`);
  writeFileSync(cursorBin, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(nativePidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`);
  chmodSync(cursorBin, 0o700);
  try {
    const adapter = new CursorProviderAdapter({
      cursorBin,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          connectorRoots.push(dirname(input.mcpConnectorSocketPath!));
          return defaultLaunchTurn({
            ...input,
            mcpRuntimeEntryPath: wedgedRuntime,
            testAgentUpstreamEndpoint: "http://127.0.0.1:9",
            testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
            testMcpCapabilityTimeoutMs: 300,
          });
        },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({
      workAttemptId: "wa-cursor-live-wedged-runtime",
      cwd: root,
    }));
    await assert.rejects(
      withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "live-wedged-runtime" }))),
      /did not prove the complete_room_turn contract before launch/,
    );
    assert.equal(existsSync(nativePidPath), false, "native Cursor must never launch after a wedged verify phase");
    assert.equal(await waitForPath(wedgedPidPath), true);
    const wedgedPid = Number(readFileSync(wedgedPidPath, "utf8"));
    await waitFor(() => {
      try { process.kill(wedgedPid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    });
    assert.equal(connectorRoots.length, 1);
    await waitFor(() => !existsSync(connectorRoots[0]!));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon-owned Cursor re-attests effective MCP authority before every native launch", async () => {
  const harness = createHarness({
    mcpAttestationError: new Error("Supervised Cursor requires exactly one effective MCP entry."),
  });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);

  await assert.rejects(
    adapter.runRoomTurn(handle, roomTurnRequest()),
    /exactly one effective MCP entry/,
  );
  assert.equal(harness.mcpAttestations.length, 1);
  assert.equal(harness.launches.length, 0, "a child never launches after failed attestation");
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");
});

test("a project MCP added after the final reseal gains no blanket approval or permission policy", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "letagents-cursor-project-mcp-race-"));
  try {
    let insertedAtLaunch = false;
    const harness = createHarness({
      beforeLaunch(input) {
        mkdirSync(join(workspace, ".cursor"), { recursive: true });
        writeFileSync(join(workspace, ".cursor", "mcp.json"), JSON.stringify({
          mcpServers: {
            project_extra: {
              command: process.execPath,
              args: ["-e", "throw new Error('must never be auto-approved')"],
            },
          },
        }));
        insertedAtLaunch = true;
        assert.notEqual(input.cwd, workspace, "native launch does not inherit an ambient repository cwd");
        assert.equal(argValue(input.args, "--workspace"), workspace, "repo access still uses Cursor's explicit workspace");
        // --approve-mcps is required to load the sealed HOME letagents MCP at
        // all (cursor-agent has no headless per-server approval). This adversarial
        // project mcp.json still gains nothing: the native sandbox denies reading
        // any workspace .cursor/mcp.json, so it can never be read, let alone
        // approved (that deny-read is asserted in cursor-managed-profile.test.ts).
        assert.equal(input.args.includes("--approve-mcps"), true, "the sealed HOME letagents MCP is approved so complete_room_turn loads");
        assert.equal(input.args.includes("--disable-project-configs"), true, "late project permissions stay disabled");
      },
    });
    const adapter = supervisedAdapter(harness);
    const handle = await spawnDaemonLane(adapter, harness, daemonSpawnRequest({ cwd: workspace }));
    const turn = adapter.runRoomTurn(handle, roomTurnRequest());
    await flush();

    assert.equal(insertedAtLaunch, true, "the adversarial config appears only after the last reseal");
    harness.children[0]!.emit({
      type: "result", subtype: "success", is_error: false,
      result: "isolated", session_id: "sess-cursor-1",
    });
    harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await flush();
    assert.equal((await turn).text, "isolated");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("daemon-owned Cursor blocks launch when the packaged bridge fails after safe enumeration", async () => {
  const harness = createHarness({
    mcpBridgeAttestationError: new Error("Cursor failed while inspecting the effective supervised MCP registry (ENOENT)."),
  });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);

  await assert.rejects(
    adapter.runRoomTurn(handle, roomTurnRequest()),
    /ENOENT/,
  );
  assert.equal(harness.mcpAttestations.length, 2);
  assert.deepEqual(
    harness.mcpAttestations[1]!.requiredReadableRoots,
    ["/Applications/LetAgents.app/runtime/letagents"],
  );
  assert.equal(harness.launches.length, 0, "a broken real bridge never reaches native launch");
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");
});

test("Cursor turn control cancels an in-flight MCP attestation before any wrapper can launch", async () => {
  const harness = createHarness({ mcpAttestationWaitForAbort: true });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest());
  while (harness.mcpAttestations.length === 0) await flush();

  let controlCheckpointed = false;
  let targetTurnId = "";
  const control = await adapter.controlTurn(handle, null, {
    checkpointTurnStarted: async (turnId) => { targetTurnId = turnId; },
    markDispatched: async () => { controlCheckpointed = true; },
  });

  assert.equal(controlCheckpointed, true);
  assert.match(targetTurnId, /^cursor:/, "pre-native cancellation checkpoints the exact bounded turn before abort");
  assert.equal(control.interrupted, true);
  assert.equal(control.resumed, false);
  await assert.rejects(roomTurn, /attestation was interrupted/);
  assert.equal(harness.launches.length, 0);
  assert.equal(handle.pid, null);
});

test("stopping Cursor during MCP attestation aborts preparation and cannot launch afterward", async () => {
  const harness = createHarness({ mcpAttestationWaitForAbort: true });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest());
  while (harness.mcpAttestations.length === 0) await flush();

  const terminal = await adapter.stop(handle);

  assert.equal(terminal.terminalCause, "stopped");
  await assert.rejects(roomTurn, /attestation was interrupted/);
  assert.equal(harness.launches.length, 0);
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "stopped");
});

test("stopping Cursor during the packaged bridge pass cannot fall through to native launch", async () => {
  const harness = createHarness({
    mcpAttestationWaitForAbort: true,
    mcpAttestationWaitForAbortAt: 2,
  });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest());
  while (harness.mcpAttestations.length < 2) await flush();

  const terminal = await adapter.stop(handle);

  assert.equal(terminal.terminalCause, "stopped");
  await assert.rejects(roomTurn, /attestation was interrupted/);
  assert.deepEqual(
    harness.mcpAttestations[1]!.requiredReadableRoots,
    ["/Applications/LetAgents.app/runtime/letagents"],
  );
  assert.equal(harness.launches.length, 0);
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "stopped");
});

test("Cursor handoff aborts pre-native MCP attestation and cannot leave an unjournaled launch", async () => {
  const harness = createHarness({ mcpAttestationWaitForAbort: true });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const detach = new AbortController();
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest(), {
    detachSignal: detach.signal,
  });
  while (harness.mcpAttestations.length === 0) await flush();

  detach.abort();

  await assert.rejects(roomTurn, (error: unknown) =>
    error instanceof Error
    && /attestation was interrupted/.test(error.message)
    && (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "not_dispatched");
  assert.equal(harness.launches.length, 0);
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");
});

test("Cursor handoff stays cancellation-linked until both turn id and wrapper birth are durable", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const detach = new AbortController();
  let releaseProviderCheckpoint!: () => void;
  const providerCheckpointRelease = new Promise<void>((resolve) => { releaseProviderCheckpoint = resolve; });
  let enterProviderCheckpoint!: () => void;
  const providerCheckpointEntered = new Promise<void>((resolve) => { enterProviderCheckpoint = resolve; });
  let durableBoundaryReached = false;
  let persistedTurnId = "";
  const retiredConnections: unknown[] = [];
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointPreparedTurn: async (state) => {
      persistedTurnId = state.providerTurnId;
      assert.equal(state.providerConnection.kind, "cursor_cli");
      assert.notEqual(state.providerConnection.pid, null);
      assert.ok(state.providerConnection.processIdentity);
      enterProviderCheckpoint();
      await providerCheckpointRelease;
    },
    checkpointProviderState: async (state) => { retiredConnections.push(state.providerConnection); },
    markDurableTurnStarted: () => { durableBoundaryReached = true; },
    detachSignal: detach.signal,
  });
  await providerCheckpointEntered;
  const child = harness.children[0]!;

  detach.abort();
  releaseProviderCheckpoint();

  await assert.rejects(roomTurn, (error: unknown) =>
    error instanceof Error
    && (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "not_dispatched");
  assert.match(persistedTurnId, /^cursor:/);
  assert.equal(durableBoundaryReached, false);
  assert.equal(child.isReleased, false, "native Cursor stays paused before the combined durability boundary");
  assert.deepEqual(retiredConnections, [{ kind: "cursor_cli", pid: null, processIdentity: null }]);
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");
});

test("a failed atomic prepared-turn checkpoint reaps the wrapper before native Cursor is released", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  let durableBoundaryReached = false;

  await assert.rejects(
    withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest(), {
      checkpointPreparedTurn: async () => { throw new Error("prepared turn checkpoint unavailable"); },
      markDurableTurnStarted: () => { durableBoundaryReached = true; },
    })),
    /prepared turn checkpoint unavailable/,
  );

  const child = harness.children[0]!;
  assert.equal(durableBoundaryReached, false);
  assert.equal(child.isReleased, false, "native Cursor remains paused when the turn id is not durable");
  assert.equal(child.alive, false, "the exact prepared wrapper is reaped before the failure returns");
  assert.deepEqual(harness.signals, [{ pid: child.pid, signal: "SIGTERM" }]);
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");
});

test("Cursor control during a blocked provider checkpoint can never release deferred native work", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  let releaseProviderCheckpoint!: () => void;
  const providerCheckpointRelease = new Promise<void>((resolve) => { releaseProviderCheckpoint = resolve; });
  let enterProviderCheckpoint!: () => void;
  const providerCheckpointEntered = new Promise<void>((resolve) => { enterProviderCheckpoint = resolve; });
  let releaseIdleRetirement!: () => void;
  const idleRetirementRelease = new Promise<void>((resolve) => { releaseIdleRetirement = resolve; });
  let enterIdleRetirement!: () => void;
  const idleRetirementEntered = new Promise<void>((resolve) => { enterIdleRetirement = resolve; });
  let durableBoundaryReached = false;
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointPreparedTurn: async () => {
      enterProviderCheckpoint();
      await providerCheckpointRelease;
    },
    checkpointProviderState: async (state) => {
      assert.deepEqual(state.providerConnection, { kind: "cursor_cli", pid: null, processIdentity: null });
      enterIdleRetirement();
      await idleRetirementRelease;
    },
    markDurableTurnStarted: () => { durableBoundaryReached = true; },
  });
  await providerCheckpointEntered;
  const child = harness.children[0]!;

  const control = adapter.controlTurn(handle, null);
  let controlSettled = false;
  void control.finally(() => { controlSettled = true; });
  while (harness.signals.length === 0) await flush();
  assert.deepEqual(harness.signals, [{ pid: child.pid, signal: "SIGTERM" }]);
  assert.equal(child.isReleased, false);
  releaseProviderCheckpoint();
  await idleRetirementEntered;
  await flush();
  assert.equal(controlSettled, false, "Stop cannot return before exact live-to-idle retirement commits");
  releaseIdleRetirement();

  await assert.rejects(roomTurn, (error: unknown) =>
    error instanceof Error
    && (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "not_dispatched");
  await control;
  assert.equal(durableBoundaryReached, false);
  assert.equal(child.isReleased, false, "an interrupt edge wins permanently over deferred native release");
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");
});

test("Cursor Stop after native release but before init preserves the lane and permits the next turn", async () => {
  const bounded = async <T>(work: Promise<T>, stage: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out during ${stage}.`)), 500);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const harness = createHarness({ silent: true });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const retiredConnections: unknown[] = [];
  const firstTurn = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointPreparedTurn: async () => {},
    checkpointProviderState: async (state) => { retiredConnections.push(state.providerConnection); },
    markDurableTurnStarted: () => {},
  });
  firstTurn.catch(() => {});
  while (!harness.children[0]?.isReleased) await flush();

  const control = await bounded(adapter.controlTurn(handle, null, {
    markDispatched: async () => {},
  }), "pre-init Stop");
  await bounded(assert.rejects(firstTurn, (error: unknown) =>
    error instanceof Error
    && (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "not_dispatched"), "first turn rejection");
  assert.equal(control.interrupted, true);
  assert.equal(control.state, "idle");
  assert.equal(handle.observedState(), "idle", "a normal turn Stop does not terminalize the Cursor attempt");
  assert.deepEqual(retiredConnections, [{ kind: "cursor_cli", pid: null, processIdentity: null }]);

  const secondTurn = adapter.runRoomTurn(handle, roomTurnRequest({
    inboxItemId: "inbox_cursor_2",
    actionId: "action_cursor_2",
  }), {
    checkpointPreparedTurn: async () => {},
    checkpointProviderState: async () => {},
    markDurableTurnStarted: () => {},
  });
  while (!harness.children[1]?.isReleased) await flush();
  harness.children[1]!.emit({ type: "system", subtype: "init", session_id: "sess-cursor-after-stop" });
  harness.children[1]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "continued", session_id: "sess-cursor-after-stop",
  });
  harness.children[1]!.resolveExit({ type: "exit", code: 0, signal: null });
  assert.equal((await bounded(secondTurn, "successor turn")).text, "continued", "the preserved lane can execute the next bounded turn");
});

test("Cursor handoff SIGKILLs and reaps a TERM-resistant prepared wrapper before retiring", async () => {
  const harness = createHarness({ dieOnSigterm: false, ownsDescendantReaping: true });
  const adapter = supervisedAdapter(harness, 10);
  const handle = await spawnDaemonLane(adapter, harness);
  const detach = new AbortController();
  let releaseProviderCheckpoint!: () => void;
  const providerCheckpointRelease = new Promise<void>((resolve) => { releaseProviderCheckpoint = resolve; });
  let enterProviderCheckpoint!: () => void;
  const providerCheckpointEntered = new Promise<void>((resolve) => { enterProviderCheckpoint = resolve; });
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointTurnStarted: async () => {},
    checkpointProviderState: async () => {
      enterProviderCheckpoint();
      await providerCheckpointRelease;
    },
    detachSignal: detach.signal,
  });
  await providerCheckpointEntered;
  const child = harness.children[0]!;

  detach.abort();
  releaseProviderCheckpoint();

  await withLoopAlive(assert.rejects(roomTurn, (error: unknown) =>
    error instanceof Error
    && (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "not_dispatched"));
  assert.deepEqual(harness.signals, [
    { pid: child.pid, signal: "SIGTERM" },
    { pid: child.pid, signal: "SIGKILL" },
  ]);
  assert.equal(child.isReleased, false, "native Cursor was never released from the prepared wrapper");
  assert.equal(child.alive, false, "handoff waits until the exact prepared wrapper is reaped");
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");
});

test("Cursor handoff never escalates a prepared wrapper after its PID birth is recycled", async () => {
  const harness = createHarness({ dieOnSigterm: false, ownsDescendantReaping: true });
  const adapter = supervisedAdapter(harness, 10);
  const handle = await spawnDaemonLane(adapter, harness);
  const detach = new AbortController();
  let releaseProviderCheckpoint!: () => void;
  const providerCheckpointRelease = new Promise<void>((resolve) => { releaseProviderCheckpoint = resolve; });
  let enterProviderCheckpoint!: () => void;
  const providerCheckpointEntered = new Promise<void>((resolve) => { enterProviderCheckpoint = resolve; });
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointTurnStarted: async () => {},
    checkpointProviderState: async () => {
      enterProviderCheckpoint();
      await providerCheckpointRelease;
    },
    detachSignal: detach.signal,
  });
  await providerCheckpointEntered;
  const child = harness.children[0]!;
  const runtimeDataDir = harness.launches[0]!.env?.CURSOR_DATA_DIR;
  assert.ok(runtimeDataDir);
  harness.identities.set(child.pid!, "unrelated-recycled-birth");

  detach.abort();
  releaseProviderCheckpoint();

  await assert.rejects(roomTurn, (error: unknown) =>
    error instanceof Error
    && (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "not_dispatched");
  assert.deepEqual(harness.signals, [], "neither TERM nor KILL may target the recycled PID");
  assert.equal(child.isReleased, false);
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "idle");

  // PID recycling proves that the original process has exited even if its
  // exit notification reaches the adapter later. The delayed observation
  // must retire its private worker namespace without ever signalling the
  // recycled PID.
  child.resolveExit({ type: "exit", code: null, signal: null });
  await flush();
  assert.equal(existsSync(runtimeDataDir), false);
});

test("Cursor handoff never adopts a later PID birth when the prepared wrapper birth was unverifiable", async () => {
  const harness = createHarness({ dieOnSigterm: false, ownsDescendantReaping: true });
  let identityReads = 0;
  const adapter = new CursorProviderAdapter({
    dependencies: {
      ...harness.dependencies,
      getProcessIdentity() {
        identityReads += 1;
        return identityReads === 1 ? undefined : "unrelated-recycled-birth";
      },
    },
    stopGraceMs: 10,
    supervisedProfileFactory: ({ workAttemptId }) => ({
      homeDir: `/private/cursor/${workAttemptId}/home`,
      configDir: `/private/cursor/${workAttemptId}/config`,
      dataDir: `/private/cursor/${workAttemptId}/data`,
      cacheDir: `/private/cursor/${workAttemptId}/cache`,
      env: {
        HOME: `/private/cursor/${workAttemptId}/home`,
        CURSOR_CONFIG_DIR: `/private/cursor/${workAttemptId}/config/cursor`,
        NPM_CONFIG_CACHE: `/private/cursor/${workAttemptId}/npm-cache`,
      },
      ...wrapperHostedMcpFixture(`/private/cursor/${workAttemptId}`),
    }),
  });
  const handle = await spawnDaemonLane(adapter, harness);
  const roomTurn = adapter.runRoomTurn(handle, roomTurnRequest());
  roomTurn.catch(() => {});
  await flush();
  const child = harness.children[0]!;

  assert.equal(identityReads, 1, "cleanup may not re-read and adopt a later PID birth");
  assert.deepEqual(harness.signals, [], "an uncaptured birth never authorizes TERM or KILL");
  child.resolveExit({ type: "exit", code: null, signal: null });
  await assert.rejects(roomTurn, /process identity could not be verified/);
  assert.equal(child.isReleased, false);
  assert.equal(handle.pid, null);
  assert.equal(handle.observedState(), "failed");
});

test("daemon-owned Cursor runs one exact bounded room turn and checkpoints before native launch", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const order: string[] = [];
  let persistedTurnId = "";
  const pending = adapter.runRoomTurn(handle, roomTurnRequest(), {
    beforeNativeDispatch: async () => { order.push("dispatch_intent"); },
    checkpointTurnStarted: async (turnId) => {
      persistedTurnId = turnId;
      order.push("turn_started");
      assert.equal(harness.launches.length, 1, "the paused wrapper exists before the turn id becomes durable");
      assert.equal(harness.children[0]?.isReleased, false, "native Cursor is not released before its exact turn id is durable");
    },
    markDurableTurnStarted: () => {
      order.push("durable");
      assert.equal(harness.children[0]?.isReleased, false, "the durable milestone precedes native release");
    },
    checkpointTerminalResult: async () => { order.push("terminal"); },
  });
  await flush();

  assert.match(persistedTurnId, /^cursor:/);
  assert.equal(harness.launches.length, 1);
  const launch = harness.launches[0]!;
  assert.equal(argValue(launch.args, "--resume"), null);
  assert.equal(launch.args.at(-1)?.includes(`Turn id: ${persistedTurnId}`), true);
  assert.equal(launch.args.at(-1)?.includes("Please fix it"), true);
  assert.equal(launch.args.at(-1)?.includes("call complete_room_turn exactly once"), true);
  const child = harness.children[0]!;
  child.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "  Reply from Cursor  ",
    request_id: "cursor-request-native-1",
    session_id: "sess-cursor-1",
  });
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();

  assert.deepEqual(await pending, {
    turnId: persistedTurnId,
    outcome: "reply",
    text: "Reply from Cursor",
    evidence: "stream",
    publicationContract: "structured_room_turn_v1",
  });
  assert.deepEqual(order, ["dispatch_intent", "turn_started", "durable", "terminal"]);
  assert.equal(handle.observedState(), "idle");
});

test("writable Cursor turns launch only in their private generation and retire it before publication", async () => {
  const harness = createHarness();
  const createGeneration = harness.dependencies.createWorkspaceGeneration;
  harness.dependencies.createWorkspaceGeneration = async (input) => ({
    ...(await createGeneration(input)),
    liveSourceRoot: "/private/letagents-generation/live",
    liveWorkspace: "/private/letagents-generation/live/project",
    readOnlyRoots: [{
      sourcePath: "/private/source/.git/objects",
      generationPath: null,
      purpose: "git-objects" as const,
    }],
  });
  const adapter = supervisedAdapter(harness);
  const handle = await adapter.spawn(daemonSpawnRequest({
    permissionProfileId: "sandboxed_write",
    launchPolicy: { force: true, sandbox: "enabled" },
  }));
  const terminalOrder: string[] = [];
  const pending = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointTerminalResult: async () => { terminalOrder.push("terminal"); },
  });
  await flush();

  const launch = harness.launches[0]!;
  assert.equal(argValue(launch.args, "--workspace"), "/private/letagents-generation/live/project");
  assert.equal(launch.mcpRuntimeCwd, "/private/letagents-generation/live/project");
  assert.equal(launch.allowedReadSubpaths?.includes("/private/source/.git/objects"), true);
  assert.equal(launch.allowedWriteSubpaths?.includes("/tmp/wa-cursor-1"), false);
  assert.match(launch.workspaceGenerationManifestPath ?? "", /^\/tmp\/letagents-test-generation-/);

  harness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "generation reply", session_id: "sess-cursor-1",
  });
  harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  assert.equal((await withLoopAlive(pending)).text, "generation reply");
  assert.deepEqual(harness.workspaceGenerationEvents.map((event) => event.kind), ["create", "retire", "remove"]);
  assert.deepEqual(terminalOrder, ["terminal"]);
});

test("room-only rental Cursor turns use their disposable workspace without Git generation", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const rentalWorkspace = "/private/letagents-daemon/room-only/2bbffeb2-a7ad-4cf0-bdac-114c6b37cb39";
  const handle = await adapter.spawn(daemonSpawnRequest({
    supervisorEntryId: "supervised_rental_session_1_attempt_1",
    cwd: rentalWorkspace,
    permissionProfileId: "sandboxed_write",
    launchPolicy: { force: true, sandbox: "enabled" },
  }));

  const pending = adapter.runRoomTurn(handle, roomTurnRequest());
  await flush();

  const launch = harness.launches[0]!;
  assert.equal(argValue(launch.args, "--workspace"), rentalWorkspace);
  assert.equal(argValue(launch.args, "--sandbox"), "enabled");
  assert.equal(launch.mcpRuntimeCwd, rentalWorkspace);
  assert.equal(launch.workspaceGenerationManifestPath, undefined);
  assert.deepEqual(harness.workspaceGenerationEvents, []);

  harness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "room-only reply", session_id: "sess-cursor-1",
  });
  harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  assert.equal((await withLoopAlive(pending)).text, "room-only reply");
  assert.deepEqual(harness.workspaceGenerationEvents, []);
});

test("an ambiguous native release failure reconciles instead of abandoning or redispatching the generation", async () => {
  const harness = createHarness({ releaseError: new Error("IPC release acknowledgement failed") });
  const adapter = supervisedAdapter(harness);
  const handle = await adapter.spawn(daemonSpawnRequest({
    permissionProfileId: "sandboxed_write",
    launchPolicy: { force: true, sandbox: "enabled" },
  }));

  await assert.rejects(
    withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest())),
    /cannot prove the persisted exact turn reached a terminal boundary/i,
  );
  assert.equal(harness.launches.length, 1, "the ambiguous exact turn is never redispatched");
  assert.deepEqual(harness.workspaceGenerationEvents.map((event) => event.kind), ["create", "retire"]);
  assert.deepEqual(harness.signals, [{ pid: 5200, signal: "SIGTERM" }]);
});

test("Cursor bounded turns classify only the exact no-reply sentinel and preserve unreadable completion", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);

  const noReply = adapter.runRoomTurn(handle, roomTurnRequest({ actionId: "action_no_reply" }));
  await flush();
  harness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: CURSOR_NO_ROOM_REPLY_SENTINEL, session_id: "sess-cursor-1",
  });
  harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  const noReplyResult = await noReply;
  assert.deepEqual(noReplyResult, {
    turnId: noReplyResult.turnId,
    outcome: "no_reply",
    text: null,
    evidence: "stream",
    publicationContract: "structured_room_turn_v1",
  });

  const unreadable = adapter.runRoomTurn(handle, roomTurnRequest({ actionId: "action_unreadable" }));
  await flush();
  harness.children[1]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: null, session_id: "sess-cursor-1",
  });
  harness.children[1]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  const unreadableResult = await unreadable;
  assert.equal(unreadableResult.outcome, "unreadable");
  assert.equal(unreadableResult.text, null);
  assert.equal(unreadableResult.evidence, "none");

  const extraText = adapter.runRoomTurn(handle, roomTurnRequest({ actionId: "action_extra_text" }));
  await flush();
  harness.children[2]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: `${CURSOR_NO_ROOM_REPLY_SENTINEL} because this is extra`, session_id: "sess-cursor-1",
  });
  harness.children[2]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal((await extraText).outcome, "reply", "sentinel inference is exact, never substring-based");

  const launchCount = harness.launches.length;
  assert.deepEqual(await adapter.recoverRoomTurn(handle, {
    inboxItemId: "inbox_cursor_1",
    providerTurnId: unreadableResult.turnId,
  }), unreadableResult, "result recovery re-reads retained terminal evidence for the exact same turn");
  assert.equal(harness.launches.length, launchCount, "unreadable recovery never reruns Cursor");
});

test("Cursor handoff detaches observation while the same in-memory exact turn remains recoverable without redispatch", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const abort = new AbortController();
  let turnId = "";
  const pending = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointTurnStarted: async (value) => { turnId = value; },
    detachSignal: abort.signal,
  });
  await flush();
  abort.abort();
  await assert.rejects(pending, /observation detached/);

  const child = harness.children[0]!;
  child.emit({
    type: "result", subtype: "success", is_error: false,
    result: "Recovered exact reply", session_id: "sess-cursor-1",
  });
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  const launchCount = harness.launches.length;
  const recovered = await adapter.recoverRoomTurn(handle, {
    inboxItemId: "inbox_cursor_1",
    providerTurnId: turnId,
  });
  assert.equal(recovered.text, "Recovered exact reply");
  assert.equal(harness.launches.length, launchCount, "recovery reads only retained exact evidence");
  await assert.rejects(
    () => adapter.recoverRoomTurn(handle, { inboxItemId: "inbox_cursor_1", providerTurnId: "cursor:unknown" }),
    /refusing to rerun/,
  );
});

test("Cursor retains terminal stream evidence when checkpointing fails and recovery never launches again", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  let turnId = "";
  const pending = adapter.runRoomTurn(handle, roomTurnRequest(), {
    checkpointTurnStarted: async (value) => { turnId = value; },
    checkpointTerminalResult: async () => { throw new Error("database unavailable"); },
  });
  const rejected = assert.rejects(pending, /database unavailable/);
  await flush();
  harness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "Durable after retry", session_id: "sess-cursor-1",
  });
  harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  await rejected;
  const launchCount = harness.launches.length;
  const recovered = await adapter.recoverRoomTurn(handle, {
    inboxItemId: "inbox_cursor_1",
    providerTurnId: turnId,
  });
  assert.equal(recovered.text, "Durable after retry");
  assert.equal(harness.launches.length, launchCount);
});

test("Cursor cleanup follows the daemon-accepted structured result rather than the raw aggregate", async () => {
  const acceptedHarness = createHarness();
  const acceptedAdapter = supervisedAdapter(acceptedHarness);
  const acceptedHandle = await spawnDaemonLane(acceptedAdapter, acceptedHarness);
  let acceptedTurnId = "";
  const accepted = acceptedAdapter.runRoomTurn(acceptedHandle, roomTurnRequest({ actionId: "accepted-structured" }), {
    checkpointTurnStarted: async (turnId) => { acceptedTurnId = turnId; },
    checkpointTerminalResult: async (raw) => {
      assert.equal(raw.outcome, "unreadable");
      return {
        acceptedResult: {
          turnId: raw.turnId, outcome: "reply", text: "structured proposal", evidence: "stream",
          publicationContract: "structured_room_turn_v1",
        },
        cleanupRecoveryEvidence: true,
      };
    },
  });
  await flush();
  acceptedHarness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false, result: null, session_id: "sess-cursor-1",
  });
  acceptedHarness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  assert.equal((await accepted).text, "structured proposal");
  await assert.rejects(
    () => acceptedAdapter.recoverRoomTurn(acceptedHandle, { inboxItemId: "accepted-structured", providerTurnId: acceptedTurnId }),
    /refusing to rerun/,
    "accepted structured publication authorizes cleanup even when Cursor's raw aggregate was empty",
  );

  const rejectedHarness = createHarness();
  const rejectedAdapter = supervisedAdapter(rejectedHarness);
  const rejectedHandle = await spawnDaemonLane(rejectedAdapter, rejectedHarness);
  let rejectedTurnId = "";
  const rejected = rejectedAdapter.runRoomTurn(rejectedHandle, roomTurnRequest({ actionId: "missing-structured" }), {
    checkpointTurnStarted: async (turnId) => { rejectedTurnId = turnId; },
    checkpointTerminalResult: async (raw) => ({
      acceptedResult: {
        turnId: raw.turnId, outcome: "unreadable", text: null, evidence: "none",
        publicationContract: "structured_room_turn_v1",
      },
      cleanupRecoveryEvidence: false,
    }),
  });
  await flush();
  rejectedHarness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false, result: "raw aggregate only", session_id: "sess-cursor-1",
  });
  rejectedHarness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  assert.equal((await rejected).outcome, "unreadable");
  assert.equal((await rejectedAdapter.recoverRoomTurn(rejectedHandle, {
    inboxItemId: "missing-structured", providerTurnId: rejectedTurnId,
  })).text, "raw aggregate only", "missing structured publication retains exact recovery evidence");
});

test("Cursor keeps a durable no-reply journal until fallible workspace receipt cleanup succeeds in run and recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-cleanup-order-"));
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const harness = createHarness();
    let removalAttempts = 0;
    const adapter = new CursorProviderAdapter({
      dependencies: {
        ...harness.dependencies,
        async removeWorkspaceGenerationReceipt() {
          removalAttempts += 1;
          throw new Error(`injected receipt cleanup failure ${removalAttempts}`);
        },
      },
      supervisedProfileFactory: () => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: join(root, "home"), NPM_CONFIG_CACHE: join(root, "npm-cache") },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await spawnDaemonLane(adapter, harness, daemonSpawnRequest({
      cwd: root,
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    let turnId = "";
    const run = adapter.runRoomTurn(handle, roomTurnRequest({ actionId: "cleanup-order" }), {
      checkpointTurnStarted: async (value) => { turnId = value; },
      checkpointTerminalResult: async (raw) => ({
        acceptedResult: raw,
        cleanupRecoveryEvidence: true,
      }),
    });
    await flush();
    const launch = harness.launches[0]!;
    const sessionId = "sess-cursor-1";
    const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
    const result = {
      type: "result", subtype: "success", is_error: false,
      result: CURSOR_NO_ROOM_REPLY_SENTINEL, session_id: sessionId,
    };
    writeFileSync(statePath, [
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
      JSON.stringify(result),
      "",
    ].join("\n"));
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "exit", code: 0, signal: null,
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: true,
      turn_contract_version: 1,
      session_contract_valid: true,
      stream_contract_complete: true,
      workspace_generation_manifest_path: launch.workspaceGenerationManifestPath,
      init: { type: "system", subtype: "init", session_id: sessionId },
      result,
    }));
    harness.children[0]!.emit(result);
    harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await assert.rejects(run, /injected receipt cleanup failure 1/);
    assert.equal(existsSync(`${statePath}.terminal.json`), true,
      "run cleanup failure leaves the only restart-readable terminal journal intact");

    await assert.rejects(adapter.recoverRoomTurn(handle, {
      inboxItemId: "cleanup-order", providerTurnId: turnId,
    }, {
      checkpointTerminalResult: async (raw) => ({ acceptedResult: raw, cleanupRecoveryEvidence: true }),
    }), /injected receipt cleanup failure 2/);
    assert.equal(existsSync(`${statePath}.terminal.json`), true,
      "recovery cleanup failure also leaves the no-reply journal intact");

    const retried = await adapter.recoverRoomTurn(handle, {
      inboxItemId: "cleanup-order", providerTurnId: turnId,
    });
    assert.equal(retried.outcome, "no_reply");
    assert.equal(removalAttempts, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successor recovers the exact Cursor reply from the private wrapper journal without redispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-turn-recovery-"));
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const turnId = "cursor:durable-restart-turn";
    const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
    writeFileSync(statePath, [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-after-restart" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "reply recovered after handoff", session_id: "sess-after-restart" }),
      "",
    ].join("\n"));
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "exit", code: 0, signal: null,
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: true,
      session_contract_valid: true,
      stream_contract_complete: true,
      workspace_generation_manifest_path: "/tmp/letagents-recovered-workspace-generation.json",
      init: { type: "system", subtype: "init", session_id: "sess-after-restart" },
      result: { type: "result", subtype: "success", is_error: false, result: "reply recovered after handoff", session_id: "sess-after-restart", request_id: null },
    }));
    const harness = createHarness();
    const adapter = new CursorProviderAdapter({
      dependencies: harness.dependencies,
      supervisedProfileFactory: ({ workAttemptId }) => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: join(root, "home"), NPM_CONFIG_CACHE: join(root, "npm-cache") },
      }),
    });
    const request = daemonSpawnRequest();
    const handle = await adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: "sess-after-restart",
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    let checkpointed = false;
    const recovered = await adapter.recoverRoomTurn(handle, {
      inboxItemId: "inbox-after-restart",
      providerTurnId: turnId,
    }, {
      checkpointProviderState: async (state) => {
        checkpointed = true;
        assert.equal(state.providerConnection.pid, null);
      },
    });
    assert.deepEqual(recovered, {
      turnId, outcome: "reply", text: "reply recovered after handoff", evidence: "stream",
      publicationContract: "structured_room_turn_v1",
    });
    assert.equal(checkpointed, true);
    assert.equal(harness.launches.length, 0, "recovery never starts another native turn");
    assert.deepEqual(harness.workspaceGenerationEvents.map((event) => event.kind), ["recover"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successor marks pre-version legacy durable Cursor results for the bounded aggregate fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-legacy-turn-recovery-"));
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const turnId = "cursor:legacy-durable-turn";
    const sessionId = "sess-legacy-restart";
    const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
    const legacyResult = { type: "result", is_error: false, result: "legacy aggregate reply", session_id: sessionId };
    writeFileSync(statePath, [
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
      JSON.stringify(legacyResult),
      "",
    ].join("\n"));
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "exit", code: 0, signal: null,
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: true,
      session_contract_valid: true,
      stream_contract_complete: true,
      init: { type: "system", subtype: "init", session_id: sessionId },
      result: legacyResult,
    }));
    const harness = createHarness();
    const adapter = new CursorProviderAdapter({
      dependencies: harness.dependencies,
      supervisedProfileFactory: () => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: join(root, "home"), NPM_CONFIG_CACHE: join(root, "npm-cache") },
      }),
    });
    const request = daemonSpawnRequest();
    const handle = await adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: sessionId,
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    assert.deepEqual(await adapter.recoverRoomTurn(handle, {
      inboxItemId: "inbox-legacy-restart", providerTurnId: turnId,
    }), {
      turnId, outcome: "reply", text: "legacy aggregate reply", evidence: "stream",
      publicationContract: "legacy_cursor_aggregate_v0",
    });
    assert.equal(harness.launches.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successor materializes a trusted durable no-result terminal on the recovered lane", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-turn-terminal-recovery-"));
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const turnId = "cursor:durable-terminal-turn";
    const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
    writeFileSync(statePath, `${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-terminal-restart" })}\n`);
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "exit", code: 9, signal: null,
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: true,
      session_contract_valid: true,
      stream_contract_complete: true,
      init: { type: "system", subtype: "init", session_id: "sess-terminal-restart" },
      result: null,
    }));
    const harness = createHarness();
    const adapter = new CursorProviderAdapter({
      dependencies: harness.dependencies,
      supervisedProfileFactory: () => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { NPM_CONFIG_CACHE: join(root, "npm-cache") },
      }),
    });
    const request = daemonSpawnRequest();
    const handle = await adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: "sess-terminal-restart",
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    const terminals: ProviderTerminalPayload[] = [];
    adapter.onExit(handle, (terminal) => terminals.push(terminal));

    await assert.rejects(
      adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-terminal-restart", providerTurnId: turnId }, {
        checkpointProviderState: async () => {
          assert.equal(terminals.length, 0, "recovered continuation checkpoints before onExit retires the live handle");
        },
      }),
      (error: unknown) => (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "terminal_failure",
    );
    assert.equal(handle.observedState(), "failed");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]!.terminalCause, "crashed");
    assert.equal(terminals[0]!.exitCode, 9);
    assert.equal(harness.launches.length, 0, "terminal recovery never launches another native turn");
    await assert.rejects(
      adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-terminal-restart", providerTurnId: turnId }),
      (error: unknown) => (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "terminal_failure",
    );
    assert.equal(terminals.length, 1, "repeated recovery never emits a duplicate exit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor recovery rejects legacy terminal evidence that did not separately prove authority revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-legacy-terminal-"));
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const turnId = "cursor:legacy-terminal";
    const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
    writeFileSync(statePath, "");
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "exit", code: 0, signal: null,
      descendants_reaped: true,
      session_contract_valid: true,
      stream_contract_complete: true,
      init: { type: "system", subtype: "init", session_id: "sess-legacy" },
      result: { type: "result", is_error: false, result: "must not recover", session_id: "sess-legacy" },
    }));
    const harness = createHarness();
    const adapter = new CursorProviderAdapter({
      dependencies: harness.dependencies,
      supervisedProfileFactory: () => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { NPM_CONFIG_CACHE: join(root, "npm-cache") },
      }),
    });
    const request = daemonSpawnRequest();
    const handle = await adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: "sess-legacy",
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    await assert.rejects(
      adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-legacy", providerTurnId: turnId }),
      /does not prove native process-group retirement and remote-authority revocation/,
    );
    assert.equal(harness.launches.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor recovery distinguishes a prepared wrapper that never dispatched native work", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-not-dispatched-"));
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const turnId = "cursor:prepared-only";
    const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
    writeFileSync(statePath, "");
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "not_started",
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: true,
      session_contract_valid: true,
      stream_contract_complete: true,
      init: null,
      result: null,
    }));
    const harness = createHarness();
    const adapter = new CursorProviderAdapter({
      dependencies: harness.dependencies,
      supervisedProfileFactory: () => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { NPM_CONFIG_CACHE: join(root, "npm-cache") },
      }),
    });
    const request = daemonSpawnRequest();
    const handle = await adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: "sess-safe",
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    await assert.rejects(
      adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-prepared", providerTurnId: turnId }),
      (error: unknown) => (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "not_dispatched",
    );
    assert.equal(harness.launches.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor recovery rejects a terminal snapshot cross-wired to another session", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-session-contract-"));
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const turnId = "cursor:cross-wired";
    const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
    writeFileSync(statePath, "");
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "exit", code: 0, signal: null,
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: true,
      session_contract_valid: true,
      stream_contract_complete: true,
      init: { type: "system", subtype: "init", session_id: "sess-stranger" },
      result: { type: "result", is_error: false, result: "wrong", session_id: "sess-stranger" },
    }));
    const harness = createHarness();
    const adapter = new CursorProviderAdapter({
      dependencies: harness.dependencies,
      supervisedProfileFactory: () => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { NPM_CONFIG_CACHE: join(root, "npm-cache") },
      }),
    });
    const request = daemonSpawnRequest();
    const handle = await adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: "sess-established",
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    await assert.rejects(
      adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-cross-wired", providerTurnId: turnId }),
      /different provider continuation/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production Cursor wrapper remains native group leader and writes restart-readable terminal evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-wrapper-"));
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(join(root, "npm-cache"), { recursive: true });
    const executable = join(root, "fake-cursor-agent");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
const resume = args.find((arg) => arg.startsWith("--resume="));
const session = resume ? resume.slice("--resume=".length) : "sess-wrapper-" + process.ppid;
const tokenIndex = args.indexOf("--auth-token");
if (tokenIndex < 0 || !args[tokenIndex + 1]) process.exit(92);
fs.mkdirSync(process.env.HOME + "/.cursor", { recursive: true });
fs.writeFileSync(process.env.HOME + "/.cursor/auth.json", JSON.stringify({
  accessToken: args[tokenIndex + 1], refreshToken: args[tokenIndex + 1],
}));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: session }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "wrapper reply", session_id: session }) + "\\n");
    `);
    chmodSync(executable, 0o700);
    let runtimeDataDir = "";
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          runtimeDataDir = input.env?.CURSOR_DATA_DIR ?? "";
          return defaultLaunchTurn(input);
        },
      },
      supervisedProfileFactory: () => ({
        homeDir, configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: homeDir, NPM_CONFIG_CACHE: join(root, "npm-cache") },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const order: string[] = [];
    let wrapperPid: number | null = null;
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest(), {
      checkpointTurnStarted: async () => { order.push("turn"); },
      checkpointProviderState: async (state) => {
        order.push(state.providerConnection.pid === null ? "idle" : "wrapper");
        if (state.providerConnection.pid !== null) wrapperPid = state.providerConnection.pid;
      },
    }));
    assert.equal(result.text, "wrapper reply");
    assert.deepEqual(order.slice(0, 2), ["turn", "wrapper"], "wrapper identity is durable before the fake Cursor executable is released");
    assert.equal(order.at(-1), "idle");
    assert.equal(handle.providerContinuationId, `sess-wrapper-${wrapperPid}`, "native Cursor shares the still-live wrapper's PGID");
    const terminalPath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(result.turnId).digest("hex")}.jsonl.terminal.json`);
    assert.equal(JSON.parse(readFileSync(terminalPath, "utf8")).remote_authority_revoked, true);
    assert.equal(existsSync(runtimeDataDir), false, "the wrapper retires private worker state before terminal acceptance");
    assert.equal(existsSync(join(homeDir, ".cursor", "auth.json")), false, "terminal publication purges the public file-store placeholder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal evidence honestly scopes reaping when a detached native child outlives revoked turn authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-detached-residual-"));
  const profileRoot = join(root, "private-profile");
  const configDir = join(profileRoot, "config");
  const homeDir = join(profileRoot, "home");
  const tempDir = join(profileRoot, "tmp");
  const statusPath = join(tempDir, "detached-status.json");
  const pidPath = join(tempDir, "detached.pid");
  const executable = join(root, "fake-cursor-agent");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : ""; }
const escaped = spawn(process.execPath, ["-e", ${JSON.stringify(`
const fs = require("node:fs");
const http = require("node:http");
const [statusPath, endpoint] = process.argv.slice(1);
setTimeout(() => {
  let broadReadBlocked = false;
  try { fs.readdirSync("/usr/local"); } catch (error) { broadReadBlocked = error && (error.code === "EPERM" || error.code === "EACCES"); }
  const request = http.request(endpoint, { method: "POST" });
  let authorityRevoked = false;
  request.once("response", () => { authorityRevoked = false; finish(); });
  request.once("error", () => { authorityRevoked = true; finish(); });
  request.end();
  function finish() {
    fs.writeFileSync(statusPath, JSON.stringify({ broadReadBlocked, authorityRevoked, profileWriteStillPossible: true }));
    setInterval(() => {}, 1000);
  }
}, 350);
`)}, ${JSON.stringify(statusPath)}, value("--agent-endpoint")], {
  detached: true,
  // Keep the native stdout/stderr pipes open after the parent exits. Node's
  // ChildProcess close must remain pending while exit has already fired.
  stdio: ["ignore", "inherit", "inherit"],
  env: process.env,
});
escaped.unref();
fs.writeFileSync(${JSON.stringify(pidPath)}, String(escaped.pid));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-detached-residual" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "detached-boundary-recorded", session_id: "sess-detached-residual" }) + "\\n");
`);
  chmodSync(executable, 0o700);
  let escapedPid: number | null = null;
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalProfileRoot = realpathSync(profileRoot);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(profileRoot, "data"),
        cacheDir: join(profileRoot, "cache"),
        env: { HOME: homeDir, TMPDIR: tempDir },
        ...wrapperHostedMcpFixture(root),
        nativeAllowedWriteSubpaths: [profileRoot, canonicalProfileRoot],
        nativeAllowedReadSubpaths: [root, canonicalRoot],
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const pendingResult = withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.equal(await waitForPath(pidPath), true, "the detached fixture publishes its process identity");
    escapedPid = Number(readFileSync(pidPath, "utf8"));
    assert.ok(Number.isSafeInteger(escapedPid) && escapedPid > 1);
    assert.equal(await waitForPath(statusPath), true, "the detached fixture publishes its post-exit probe");
    assert.deepEqual(JSON.parse(readFileSync(statusPath, "utf8")), {
      broadReadBlocked: process.platform === "darwin",
      authorityRevoked: true,
      profileWriteStillPossible: true,
    });
    assert.doesNotThrow(() => process.kill(escapedPid!, 0), "the detached setsid child is an explicit operational residual");
    process.kill(escapedPid, "SIGKILL");
    const result = await pendingResult;
    const terminalPath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(result.turnId).digest("hex")}.jsonl.terminal.json`);
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
    assert.equal(terminal.descendants_reaped, undefined, "terminal evidence never overclaims complete descendant reaping");
    assert.equal(terminal.native_process_group_reaped, true);
    assert.equal(terminal.reap_scope, "native_process_group");
    assert.equal(terminal.remote_authority_revoked, true);
  } finally {
    if (escapedPid && Number.isSafeInteger(escapedPid)) {
      try { process.kill(escapedPid, "SIGKILL"); } catch {}
      for (let index = 0; index < 50; index += 1) {
        try { process.kill(escapedPid, 0); await flush(); }
        catch { break; }
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGTERM at every async wrapper startup boundary cannot publish not_started beside later native work", async () => {
  for (const stage of ["mcp_listen", "authority_listen", "agent_listen"] as const) {
    const root = mkdtempSync("/tmp/letagents-cursor-startup-barrier-");
    const barrierPath = join(root, stage);
    const statePath = join(root, "turn.jsonl");
    const nativeMarker = join(root, "native-launched");
    const executable = join(root, "fake-cursor-agent");
    const connectorRoot = join("/tmp", `letagents-cursor-mcp-${randomUUID()}`);
    const runtimeDataRoot = mkdtempSync("/tmp/letagents-cursor-data-");
    writeFileSync(statePath, "");
    writeFileSync(executable, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(nativeMarker)}, "launched\\n");\nsetInterval(() => {}, 1000);\n`);
    chmodSync(executable, 0o700);
    const mcpRuntimeEnv = wrapperMcpRuntimeEnv(connectorRoot, `cursor:startup-race-${stage}`);
    let child: CursorCliChild | null = null;
    try {
      child = defaultLaunchTurn({
        cursorBin: executable,
        args: ["-p", "--output-format", "stream-json", "startup race"],
        cwd: root,
        env: {
          HOME: join(root, "home"),
          CURSOR_DATA_DIR: runtimeDataRoot,
          PATH: process.env.PATH,
        },
        deferStart: true,
        statePath,
        mcpConnectorSocketPath: join(connectorRoot, "stdio.sock"),
        mcpRuntimeEntryPath: materializeAttestableMcpRuntime(join(root, "attestable-mcp-runtime")),
        mcpRuntimeCwd: root,
        mcpRuntimeEnv,
        providerAuthorization: "Bearer startup-race-provider-proof",
        restrictRemoteAuthority: true,
        allowedWriteSubpaths: [runtimeDataRoot, realpathSync(runtimeDataRoot)],
        allowedReadSubpaths: [root, realpathSync(root)],
        testAgentUpstreamEndpoint: "http://127.0.0.1:9",
        testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
        testStartupBarrier: { path: barrierPath, stage },
      });
      await child.prepared;
      child.release();
      assert.equal(await waitForPath(join(barrierPath, "ready")), true, `${stage} startup barrier was reached`);
      assert.ok(child.pid);
      process.kill(child.pid!, "SIGTERM");
      const exit = await withLoopAlive(child.exited);

      assert.equal(exit.type, "exit");
      assert.equal(existsSync(nativeMarker), false, `${stage} cancellation never launches native Cursor`);
      assert.equal(existsSync(connectorRoot), false, `${stage} cancellation retires the wrapper MCP listener`);
      assert.equal(existsSync(runtimeDataRoot), false, `${stage} cancellation retires the turn-private data root`);
      const terminal = JSON.parse(readFileSync(`${statePath}.terminal.json`, "utf8"));
      assert.equal(terminal.type, "not_started");
      assert.equal(terminal.native_process_group_reaped, true);
      assert.equal(terminal.remote_authority_revoked, true);
    } finally {
      if (child?.pid) {
        try { process.kill(child.pid, "SIGKILL"); } catch {}
      }
      rmSync(connectorRoot, { recursive: true, force: true });
      rmSync(runtimeDataRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("inherited native evidence pipes fail closed on a hard deadline after authority retirement", async () => {
  const root = mkdtempSync("/tmp/letagents-cursor-evidence-deadline-");
  const statePath = join(root, "turn.jsonl");
  const writableRoot = join(root, "writable");
  const escapedPidPath = join(writableRoot, "escaped.pid");
  const executable = join(root, "fake-cursor-agent");
  const connectorRoot = join("/tmp", `letagents-cursor-mcp-${randomUUID()}`);
  const runtimeDataRoot = mkdtempSync("/tmp/letagents-cursor-data-");
  writeFileSync(statePath, "");
  mkdirSync(writableRoot);
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
escaped.unref();
fs.writeFileSync(${JSON.stringify(escapedPidPath)}, String(escaped.pid));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-evidence-deadline" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "must-not-be-accepted-before-close", session_id: "sess-evidence-deadline" }) + "\\n");
`);
  chmodSync(executable, 0o700);
  let escapedPid: number | null = null;
  let child: CursorCliChild | null = null;
  try {
    child = defaultLaunchTurn({
      cursorBin: executable,
      args: ["-p", "--output-format", "stream-json", "evidence deadline"],
      cwd: root,
      env: { HOME: join(root, "home"), CURSOR_DATA_DIR: runtimeDataRoot, PATH: process.env.PATH },
      deferStart: true,
      statePath,
      mcpConnectorSocketPath: join(connectorRoot, "stdio.sock"),
      mcpRuntimeEntryPath: materializeAttestableMcpRuntime(join(root, "attestable-mcp-runtime")),
      mcpRuntimeCwd: root,
      mcpRuntimeEnv: wrapperMcpRuntimeEnv(connectorRoot, "cursor:evidence-deadline"),
      providerAuthorization: "Bearer evidence-deadline-provider-proof",
      restrictRemoteAuthority: true,
      allowedWriteSubpaths: [writableRoot, realpathSync(writableRoot), runtimeDataRoot, realpathSync(runtimeDataRoot)],
      allowedReadSubpaths: [root, realpathSync(root)],
      testAgentUpstreamEndpoint: "http://127.0.0.1:9",
      testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
    });
    await child.prepared;
    const startedAt = Date.now();
    child.release();
    const exit = await withLoopAlive(child.exited);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(existsSync(escapedPidPath), true, `native fixture never launched: ${child.stderrTail()}`);
    escapedPid = Number(readFileSync(escapedPidPath, "utf8"));

    assert.equal(exit.type, "exit");
    if (exit.type === "exit") assert.equal(exit.code, 1);
    assert.ok(elapsedMs >= 2_500 && elapsedMs < 10_000, `evidence drain failed closed in ${elapsedMs}ms`);
    assert.equal(existsSync(`${statePath}.terminal.json`), false, "an open inherited pipe never yields trusted terminal evidence");
    assert.equal(existsSync(connectorRoot), false, "the hard deadline leaves no wrapper MCP authority");
    assert.equal(existsSync(runtimeDataRoot), false, "the hard deadline leaves no turn-private worker root");
    assert.doesNotThrow(() => process.kill(escapedPid!, 0), "the escaped holder demonstrates why close could not complete");
  } finally {
    if (escapedPid && Number.isSafeInteger(escapedPid)) {
      try { process.kill(escapedPid, "SIGKILL"); } catch {}
    }
    if (child?.pid) {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
    }
    rmSync(connectorRoot, { recursive: true, force: true });
    rmSync(runtimeDataRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("the live adapter never publishes buffered results when the wrapper evidence deadline fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-live-evidence-deadline-"));
  const profileRoot = join(root, "private-profile");
  const configDir = join(profileRoot, "config");
  const homeDir = join(profileRoot, "home");
  const tempDir = join(profileRoot, "tmp");
  const escapedPidPath = join(tempDir, "escaped.pid");
  const executable = join(root, "fake-cursor-agent");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
escaped.unref();
fs.writeFileSync(${JSON.stringify(escapedPidPath)}, String(escaped.pid));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-live-evidence-deadline" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "must-never-be-published", session_id: "sess-live-evidence-deadline" }) + "\\n");
`);
  chmodSync(executable, 0o700);
  let escapedPid: number | null = null;
  let connectorRoot = "";
  let runtimeDataRoot = "";
  let turnId = "";
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalProfileRoot = realpathSync(profileRoot);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          connectorRoot = dirname(input.mcpConnectorSocketPath!);
          runtimeDataRoot = input.env?.CURSOR_DATA_DIR ?? "";
          return defaultLaunchTurn({
            ...input,
            testAgentUpstreamEndpoint: "http://127.0.0.1:9",
            testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
          });
        },
      },
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(profileRoot, "data"),
        cacheDir: join(profileRoot, "cache"),
        env: { HOME: homeDir, TMPDIR: tempDir },
        ...wrapperHostedMcpFixture(root),
        nativeAllowedWriteSubpaths: [profileRoot, canonicalProfileRoot],
        nativeAllowedReadSubpaths: [root, canonicalRoot],
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const terminals: ProviderTerminalPayload[] = [];
    adapter.onExit(handle, (terminal) => terminals.push(terminal));
    const startedAt = Date.now();
    await assert.rejects(withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "live-evidence-deadline" }), {
      checkpointTurnStarted: async (value) => { turnId = value; },
    })), /ended before the bounded room turn produced a terminal result/);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(await waitForPath(escapedPidPath), true, "the inherited-pipe fixture launched");
    escapedPid = Number(readFileSync(escapedPidPath, "utf8"));

    assert.ok(elapsedMs >= 2_500 && elapsedMs < 10_000, `live evidence rejection completed in ${elapsedMs}ms`);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]!.terminalCause, "protocol_error");
    assert.equal(handle.observedState(), "failed");
    assert.ok(turnId);
    const terminalPath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl.terminal.json`);
    assert.equal(existsSync(terminalPath), false, "the adapter never invents missing wrapper authority evidence");
    assert.equal(existsSync(connectorRoot), false, "the rejected live result leaves no wrapper MCP authority");
    assert.equal(existsSync(runtimeDataRoot), false, "the rejected live result leaves no turn-private worker root");
  } finally {
    if (escapedPid && Number.isSafeInteger(escapedPid)) {
      try { process.kill(escapedPid, "SIGKILL"); } catch {}
    }
    if (connectorRoot) rmSync(connectorRoot, { recursive: true, force: true });
    if (runtimeDataRoot) rmSync(runtimeDataRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("live results require the same durable remote-authority evidence as restart recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-live-terminal-proof-"));
  const harness = createHarness({ ownsDescendantReaping: true });
  try {
    const dependencies: CursorProviderAdapterDependencies = {
      ...harness.dependencies,
      prepareTurnState(path) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      },
      launchTurn(input) {
        const child = harness.dependencies.launchTurn(input);
        Object.defineProperty(child, "requiresDurableTerminalEvidence", { value: true });
        return child;
      },
    };
    const adapter = new CursorProviderAdapter({
      dependencies,
      supervisedProfileFactory: (input) => {
        const profileRoot = input.profileRoot ?? root;
        const homeDir = join(profileRoot, "home");
        const configDir = join(profileRoot, "config");
        mkdirSync(homeDir, { recursive: true });
        mkdirSync(configDir, { recursive: true });
        return {
          homeDir,
          configDir,
          dataDir: join(profileRoot, "data"),
          cacheDir: join(profileRoot, "cache"),
          env: { HOME: homeDir, NPM_CONFIG_CACHE: join(profileRoot, "npm-cache") },
          ...(input.inspectionOnly ? {} : wrapperHostedMcpFixture(profileRoot)),
        };
      },
    });
    const handle = await spawnDaemonLane(adapter, harness, daemonSpawnRequest({
      cwd: root,
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    const terminals: ProviderTerminalPayload[] = [];
    adapter.onExit(handle, (terminal) => terminals.push(terminal));
    const pending = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "live-terminal-proof" }));
    for (let index = 0; index < 100 && harness.children.length === 0; index += 1) await flush();
    const child = harness.children[0]!;
    for (let index = 0; index < 100 && !child.isReleased; index += 1) await flush();
    assert.equal(child.isReleased, true);
    await flush();
    child.emit({
      type: "result", subtype: "success", is_error: false,
      result: "must-not-publish-without-containment", session_id: "sess-cursor-1",
    });
    const statePath = harness.launches[0]!.statePath!;
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "exit",
      code: 0,
      signal: null,
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: false,
      session_contract_valid: true,
      stream_contract_complete: true,
      init: { type: "system", subtype: "init", session_id: "sess-cursor-1" },
      result: {
        type: "result", subtype: "success", is_error: false,
        result: "must-not-publish-without-containment", session_id: "sess-cursor-1",
      },
    }));
    child.resolveExit({ type: "exit", code: 0, signal: null });

    await assert.rejects(withLoopAlive(pending), /ended before the bounded room turn produced a terminal result/);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]!.terminalCause, "protocol_error");
    assert.equal(handle.observedState(), "failed");
    assert.deepEqual(
      harness.workspaceGenerationEvents.map((event) => event.kind),
      ["create"],
      "invalid containment evidence leaves the writable generation recoverable and never reconciles it",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a writable generation reconciles only after its exact durable containment terminal is valid", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-live-generation-proof-"));
  const harness = createHarness({ ownsDescendantReaping: true });
  try {
    const dependencies: CursorProviderAdapterDependencies = {
      ...harness.dependencies,
      prepareTurnState(path) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      },
      launchTurn(input) {
        const child = harness.dependencies.launchTurn(input);
        Object.defineProperty(child, "requiresDurableTerminalEvidence", { value: true });
        return child;
      },
    };
    const adapter = new CursorProviderAdapter({
      dependencies,
      supervisedProfileFactory: (input) => {
        const profileRoot = input.profileRoot ?? root;
        const homeDir = join(profileRoot, "home");
        const configDir = join(profileRoot, "config");
        mkdirSync(homeDir, { recursive: true });
        mkdirSync(configDir, { recursive: true });
        return {
          homeDir,
          configDir,
          dataDir: join(profileRoot, "data"),
          cacheDir: join(profileRoot, "cache"),
          env: { HOME: homeDir, NPM_CONFIG_CACHE: join(profileRoot, "npm-cache") },
          ...(input.inspectionOnly ? {} : wrapperHostedMcpFixture(profileRoot)),
        };
      },
    });
    const handle = await spawnDaemonLane(adapter, harness, daemonSpawnRequest({
      cwd: root,
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    const pending = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "live-generation-proof" }));
    for (let index = 0; index < 100 && harness.children.length === 0; index += 1) await flush();
    const child = harness.children[0]!;
    for (let index = 0; index < 100 && !child.isReleased; index += 1) await flush();
    child.emit({
      type: "result", subtype: "success", is_error: false,
      result: "trusted writable reply", session_id: "sess-cursor-1",
    });
    assert.deepEqual(
      harness.workspaceGenerationEvents.map((event) => event.kind),
      ["create"],
      "live output alone never releases the writable generation",
    );
    const launch = harness.launches[0]!;
    writeFileSync(`${launch.statePath}.terminal.json`, JSON.stringify({
      type: "exit",
      code: 0,
      signal: null,
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: true,
      session_contract_valid: true,
      stream_contract_complete: true,
      workspace_generation_manifest_path: launch.workspaceGenerationManifestPath,
      init: { type: "system", subtype: "init", session_id: "sess-cursor-1" },
      result: {
        type: "result", subtype: "success", is_error: false,
        result: "trusted writable reply", session_id: "sess-cursor-1", request_id: null,
      },
    }));
    child.resolveExit({ type: "exit", code: 0, signal: null });

    assert.equal((await withLoopAlive(pending)).text, "trusted writable reply");
    assert.deepEqual(
      harness.workspaceGenerationEvents.map((event) => event.kind),
      ["create", "retire"],
      "valid exact containment evidence releases reconciliation once",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production supervised wrapper blocks remote Cursor authority and retires its loopback proxy", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-remote-authority-"));
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const executable = join(root, "fake-cursor-agent");
    writeFileSync(executable, `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}
const endpoint = value("--endpoint");
const agentEndpoint = value("--agent-endpoint");
if (!endpoint || !agentEndpoint || agentEndpoint === endpoint
  || !agentEndpoint.startsWith("http://127.0.0.1:")
  || value("--http-version") !== "1.1") process.exit(7);
const blockedPaths = [
  "/aiserver.v1.DashboardService/GetMcpConfig",
  "/aiserver.v1.DashboardService/GetEffectiveUserPlugins",
  "/aiserver.v1.DashboardService/GetManagedSkills",
  "/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam",
  "/aiserver.v1.DashboardService/GetTeamHooks",
  "/aiserver.v1.AnalyticsService/BootstrapStatsig",
];
function expectBlocked(path) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(path, endpoint), { method: "POST", headers: { "content-length": "0" } }, (response) => {
      response.resume();
      response.once("end", () => response.statusCode === 503 ? resolve() : reject(new Error("unexpected status")));
    });
    request.once("error", reject);
    request.end();
  });
}
function expectChunkedBlocked() {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL("/aiserver.v1.DashboardService/GetMe", endpoint), {
      method: "POST", headers: { "transfer-encoding": "chunked" },
    }, (response) => {
      response.resume();
      response.once("end", () => response.statusCode === 503 ? resolve() : reject(new Error("chunked request was accepted")));
    });
    request.once("error", reject);
    request.end("x");
  });
}
Promise.all([...blockedPaths.map(expectBlocked), expectChunkedBlocked()]).then(() => {
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-remote-authority" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: endpoint, session_id: "sess-remote-authority" }) + "\\n");
}).catch(() => process.exit(9));
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.match(result.text ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    const proxyUrl = new URL(result.text!);
    await new Promise<void>((resolveRequest, rejectRequest) => {
      const request = httpRequest(proxyUrl, { method: "POST" });
      request.once("response", () => rejectRequest(new Error("retired Cursor authority proxy still accepted requests")));
      request.once("error", () => resolveRequest());
      request.end();
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal evidence waits for in-flight control and agent bearer authority to be destroyed", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-inflight-authority-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const executable = join(root, "fake-cursor-agent");
  const writableRoot = join(root, "tmp");
  const controlMarker = join(writableRoot, "control-received");
  const agentMarker = join(writableRoot, "agent-received");
  const revokedStatus = join(writableRoot, "detached-revoked.json");
  const detachedPidPath = join(writableRoot, "detached.pid");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(writableRoot, { recursive: true });
  let controlAuthorization = "";
  let agentAuthorization = "";
  let controlSocketClosed = false;
  let agentStreamClosed = false;
  const controlUpstream = createHttpServer((request, response) => {
    controlAuthorization = String(request.headers.authorization ?? "");
    request.socket.once("close", () => { controlSocketClosed = true; });
    response.once("close", () => { controlSocketClosed = true; });
    request.resume();
    writeFileSync(controlMarker, "received");
    // Deliberately never respond: retirement must destroy this in-flight
    // bearer request before its terminal can authorize recovery.
  });
  const agentUpstream = createHttp2Server();
  agentUpstream.on("stream", (stream, headers) => {
    agentAuthorization = String(headers.authorization ?? "");
    stream.once("close", () => { agentStreamClosed = true; });
    stream.resume();
    writeFileSync(agentMarker, "received");
    // Deliberately keep the bidirectional Run stream active.
  });
  await Promise.all([
    new Promise<void>((resolveListen, rejectListen) => {
      controlUpstream.once("error", rejectListen);
      controlUpstream.listen(0, "127.0.0.1", () => {
        controlUpstream.removeListener("error", rejectListen);
        resolveListen();
      });
    }),
    new Promise<void>((resolveListen, rejectListen) => {
      agentUpstream.once("error", rejectListen);
      agentUpstream.listen(0, "127.0.0.1", () => {
        agentUpstream.removeListener("error", rejectListen);
        resolveListen();
      });
    }),
  ]);
  const controlAddress = controlUpstream.address();
  const agentAddress = agentUpstream.address();
  assert.ok(controlAddress && typeof controlAddress !== "string");
  assert.ok(agentAddress && typeof agentAddress !== "string");
  const testControlPlaneUpstreamEndpoint = `http://127.0.0.1:${controlAddress.port}`;
  const testAgentUpstreamEndpoint = `http://127.0.0.1:${agentAddress.port}`;
  let detachedPid: number | null = null;
  try {
    const detachedSource = `
const fs = require("node:fs");
const http = require("node:http");
const http2 = require("node:http2");
${cursorMcpAttestationFixtureSource}
const [statusPath, controlEndpoint, agentEndpoint, placeholderToken] = process.argv.slice(1);
let controlClosed = false;
let agentClosed = false;
const keepAlive = setInterval(() => {}, 1000);
function finish() {
  if (!controlClosed || !agentClosed) return;
  clearInterval(keepAlive);
  fs.writeFileSync(statusPath, JSON.stringify({ controlClosed, agentClosed }));
}
attestFixtureMcp().then(() => {
const control = http.request(new URL("/aiserver.v1.DashboardService/GetMe", controlEndpoint), {
  method: "POST",
  headers: { "content-length": "4", "connection": "keep-alive", "authorization": "Bearer " + placeholderToken },
});
control.once("response", (response) => { response.resume(); response.once("close", () => { controlClosed = true; finish(); }); });
control.once("error", () => { controlClosed = true; finish(); });
control.once("close", () => { controlClosed = true; finish(); });
control.end("ping");
const session = http2.connect(agentEndpoint);
const stream = session.request({
  ":method": "POST",
  ":path": "/agent.v1.AgentService/Run",
  "content-type": "application/connect+proto",
  "authorization": "Bearer " + placeholderToken,
});
function agentDone() { agentClosed = true; try { session.destroy(); } catch {} finish(); }
stream.once("error", agentDone);
stream.once("close", agentDone);
session.once("error", agentDone);
session.once("close", agentDone);
stream.write("active-run");
}).catch(() => process.exit(92));
`;
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
const escaped = spawn(process.execPath, ["-e", ${JSON.stringify(detachedSource)}, ${JSON.stringify(revokedStatus)}, value("--endpoint"), value("--agent-endpoint"), value("--auth-token")], {
  detached: true,
  stdio: "ignore",
  env: process.env,
});
escaped.unref();
fs.writeFileSync(${JSON.stringify(detachedPidPath)}, String(escaped.pid));
let checks = 0;
const ready = setInterval(() => {
  checks += 1;
  if (fs.existsSync(${JSON.stringify(controlMarker)}) && fs.existsSync(${JSON.stringify(agentMarker)})) {
    clearInterval(ready);
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-inflight-authority" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "inflight-authority-open", session_id: "sess-inflight-authority" }) + "\\n");
  } else if (checks > 250) process.exit(91);
}, 20);
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          return defaultLaunchTurn({ ...input, testAgentUpstreamEndpoint, testControlPlaneUpstreamEndpoint });
        },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.equal(result.text, "inflight-authority-open");
    detachedPid = Number(readFileSync(detachedPidPath, "utf8"));
    assert.equal(await waitForPath(revokedStatus), true, "the detached fixture observes both upstream sockets closing");
    assert.deepEqual(JSON.parse(readFileSync(revokedStatus, "utf8")), { controlClosed: true, agentClosed: true });
    assert.equal(controlAuthorization, "Bearer test-provider-authorization");
    assert.equal(agentAuthorization, "Bearer test-provider-authorization");
    assert.equal(controlSocketClosed, true, "control upstream is closed before the terminal result resolves");
    assert.equal(agentStreamClosed, true, "agent upstream is closed before the terminal result resolves");
    const terminalPath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(result.turnId).digest("hex")}.jsonl.terminal.json`);
    assert.equal(JSON.parse(readFileSync(terminalPath, "utf8")).remote_authority_revoked, true);
  } finally {
    if (detachedPid && Number.isSafeInteger(detachedPid)) {
      try { process.kill(detachedPid, "SIGKILL"); } catch {}
    }
    await Promise.all([
      new Promise<void>((resolveClose) => controlUpstream.close(() => resolveClose())),
      new Promise<void>((resolveClose) => agentUpstream.close(() => resolveClose())),
    ]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised agent proxy admits one exact HTTP/1 Run stream and injects its wrapper-held bearer", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-agent-h1-proxy-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const executable = join(root, "fake-cursor-agent");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  let upstreamAuthorization = "";
  let upstreamBody = "";
  const upstream = createHttp2Server();
  upstream.on("stream", (stream, headers) => {
    upstreamAuthorization = String(headers.authorization ?? "");
    stream.on("data", (chunk) => { upstreamBody += chunk.toString("utf8"); });
    stream.once("end", () => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.end("h1-upstream-ok");
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(0, "127.0.0.1", () => {
      upstream.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const testAgentUpstreamEndpoint = `http://127.0.0.1:${upstreamAddress.port}`;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
const endpoint = value("--agent-endpoint");
function request(path, contentType, body, authorization = "Bearer " + value("--auth-token")) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, endpoint), {
      method: "POST",
      headers: { "content-type": contentType, authorization, "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end(body);
  });
}
(async () => {
  const connector = await attestFixtureMcp();
  const wrongMedia = await request("/agent.v1.AgentService/Run", "application/connect+protobufad", "wrong");
  const wrongPath = await request("/agent.v1.AgentService/Other", "application/connect+proto", "wrong");
  const staleTurn = await request("/agent.v1.AgentService/Run", "application/connect+proto", "stale", "Bearer predecessor-placeholder");
  const accepted = await request("/agent.v1.AgentService/Run", "application/connect+proto; charset=binary", "h1-request-body");
  const replay = await request("/agent.v1.AgentService/Run", "application/connect+proto", "replay");
  if (wrongMedia.status !== 503 || wrongPath.status !== 503 || staleTurn.status !== 503
    || accepted.status !== 200 || accepted.body !== "h1-upstream-ok" || replay.status !== 503) process.exit(78);
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-agent-h1" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "h1-proxy-ok", session_id: "sess-agent-h1" }) + "\\n");
  detachFixtureMcp(connector);
})().catch(() => process.exit(79));
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          return defaultLaunchTurn({ ...input, testAgentUpstreamEndpoint });
        },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.equal(result.text, "h1-proxy-ok");
    assert.equal(upstreamAuthorization, "Bearer test-provider-authorization");
    assert.equal(upstreamBody, "h1-request-body");
  } finally {
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("closing an attested Cursor connector revokes the model proxy before a later Run", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-live-lease-close-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const writableRoot = join(root, "tmp");
  const executable = join(root, "fake-cursor-agent");
  const attemptPath = join(writableRoot, "late-run.json");
  const attackerPidPath = join(writableRoot, "late-run.pid");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(writableRoot, { recursive: true });
  let upstreamRuns = 0;
  const upstream = createHttp2Server();
  upstream.on("stream", (stream) => {
    upstreamRuns += 1;
    stream.resume();
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.end("must-not-arrive");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(0, "127.0.0.1", () => {
      upstream.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const testAgentUpstreamEndpoint = `http://127.0.0.1:${upstreamAddress.port}`;
  let attackerPid: number | null = null;
  try {
    const attackerSource = `
const fs = require("node:fs");
const http = require("node:http");
const [statusPath, endpoint, token] = process.argv.slice(1);
setTimeout(() => {
  const request = http.request(new URL("/agent.v1.AgentService/Run", endpoint), {
    method: "POST",
    headers: {
      "content-type": "application/connect+proto",
      "authorization": "Bearer " + token,
      "content-length": "4",
    },
  }, (response) => {
    response.resume();
    response.once("end", () => fs.writeFileSync(statusPath, JSON.stringify({ status: response.statusCode })));
  });
  request.once("error", (error) => fs.writeFileSync(statusPath, JSON.stringify({ error: error.code || error.message })));
  request.end("late");
}, 250);
`;
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
(async () => {
  const connector = await attestFixtureMcp();
  const attacker = spawn(process.execPath, ["-e", ${JSON.stringify(attackerSource)}, ${JSON.stringify(attemptPath)}, value("--agent-endpoint"), value("--auth-token")], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  attacker.unref();
  fs.writeFileSync(${JSON.stringify(attackerPidPath)}, String(attacker.pid));
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-live-lease-close" }) + "\\n");
  connector.stdin.end();
  setInterval(() => {}, 1000);
})().catch(() => process.exit(97));
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          return defaultLaunchTurn({ ...input, testAgentUpstreamEndpoint });
        },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root, workAttemptId: "wa-cursor-live-lease-close" }));
    await assert.rejects(
      withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "live-lease-close" }))),
      /supervised turn failed: Cursor's live MCP connector ended before the turn became terminal/,
    );
    assert.equal(await waitForPath(attackerPidPath), true);
    attackerPid = Number(readFileSync(attackerPidPath, "utf8"));
    assert.equal(await waitForPath(attemptPath), true, "the escaped late Run probe observed the retired proxy");
    const attempt = JSON.parse(readFileSync(attemptPath, "utf8")) as { status?: number; error?: string };
    assert.notEqual(attempt.status, 200, "the revoked lease cannot reach the model upstream");
    assert.equal(upstreamRuns, 0, "the model upstream sees no Run after connector lease loss");
  } finally {
    if (attackerPid && Number.isSafeInteger(attackerPid)) {
      try { process.kill(attackerPid, "SIGKILL"); } catch {}
    }
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised agent proxy relays exact HTTP/2 Run streams, survives an idle first token, and rejects replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-agent-h2-proxy-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const executable = join(root, "fake-cursor-agent");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  let upstreamAuthorization = "";
  let upstreamBody = "";
  let upstreamRuns = 0;
  const upstream = createHttp2Server();
  upstream.on("stream", (stream, headers) => {
    upstreamRuns += 1;
    upstreamAuthorization = String(headers.authorization ?? "");
    stream.on("data", (chunk) => { upstreamBody += chunk.toString("utf8"); });
    stream.once("end", () => {
      setTimeout(() => {
        stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
        stream.end("h2-upstream-ok");
      }, 5_250);
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(0, "127.0.0.1", () => {
      upstream.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const testAgentUpstreamEndpoint = `http://127.0.0.1:${upstreamAddress.port}`;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const http2 = require("node:http2");
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
const endpoint = value("--agent-endpoint");
const client = http2.connect(endpoint);
function request(path, contentType, body, authorization = "Bearer " + value("--auth-token")) {
  return new Promise((resolve, reject) => {
    const stream = client.request({
      ":method": "POST", ":path": path,
      "content-type": contentType,
      authorization,
    });
    const chunks = [];
    let status = 0;
    stream.once("response", (headers) => { status = Number(headers[":status"] || 0); });
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
    stream.end(body);
  });
}
(async () => {
  const connector = await attestFixtureMcp();
  const wrongMedia = await request("/agent.v1.AgentService/Run", "application/connect+protobufad", "wrong");
  const wrongPath = await request("/agent.v1.AgentService/Other", "application/connect+proto", "wrong");
  const staleTurn = await request("/agent.v1.AgentService/Run", "application/connect+proto", "stale", "Bearer predecessor-placeholder");
  const accepted = await request("/agent.v1.AgentService/Run", "application/connect+proto; charset=binary", "h2-request-body");
  const replay = await request("/agent.v1.AgentService/Run", "application/connect+proto", "replay");
  client.close();
  if (wrongMedia.status !== 503 || wrongPath.status !== 503 || staleTurn.status !== 503
    || accepted.status !== 200 || accepted.body !== "h2-upstream-ok" || replay.status !== 503) process.exit(88);
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-agent-h2" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "h2-proxy-ok", session_id: "sess-agent-h2" }) + "\\n");
  detachFixtureMcp(connector);
})().catch(() => process.exit(89));
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          return defaultLaunchTurn({ ...input, testAgentUpstreamEndpoint });
        },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.equal(result.text, "h2-proxy-ok");
    assert.equal(upstreamRuns, 1);
    assert.equal(upstreamAuthorization, "Bearer test-provider-authorization");
    assert.equal(upstreamBody, "h2-request-body");
  } finally {
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised agent proxy holds an HTTP/2 Run that races ahead of MCP attestation, then admits it", async () => {
  // Cursor opens its model connection at startup, before its MCP handshake has
  // finished. The proxy must HOLD that first Run until live attestation
  // completes and then admit it -- not reject it, which is what made Cursor
  // retry to death (the StoneForge incident). The fake fires the Run before
  // attesting, so a regression to immediate rejection surfaces as a 503.
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-hold-admit-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const executable = join(root, "fake-cursor-agent");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  let upstreamAuthorization = "";
  let upstreamBody = "";
  const upstream = createHttp2Server();
  upstream.on("stream", (stream, headers) => {
    upstreamAuthorization = String(headers.authorization ?? "");
    stream.on("data", (chunk) => { upstreamBody += chunk.toString("utf8"); });
    stream.once("end", () => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.end("held-upstream-ok");
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(0, "127.0.0.1", () => { upstream.removeListener("error", rejectListen); resolveListen(); });
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const testAgentUpstreamEndpoint = `http://127.0.0.1:${upstreamAddress.port}`;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const http2 = require("node:http2");
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
const client = http2.connect(value("--agent-endpoint"));
function request(body) {
  return new Promise((resolve, reject) => {
    const stream = client.request({ ":method": "POST", ":path": "/agent.v1.AgentService/Run", "content-type": "application/connect+proto", authorization: "Bearer " + value("--auth-token") });
    const chunks = [];
    let status = 0;
    stream.once("response", (headers) => { status = Number(headers[":status"] || 0); });
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
    stream.end(body);
  });
}
(async () => {
  // Fire the Run first; only then complete attestation. The Run must stay
  // pending (held) across that gap and resolve 200 only AFTER attestation --
  // resolving before it would mean it was admitted without attestation.
  let attested = false;
  let resolvedBeforeAttest = false;
  const held = request("held-request-body");
  held.then(() => { if (!attested) resolvedBeforeAttest = true; }).catch(() => {});
  const connector = await attestFixtureMcp();
  attested = true;
  const admitted = await held;
  const replay = await request("replay");
  client.close();
  if (resolvedBeforeAttest) process.exit(90);
  if (admitted.status !== 200 || admitted.body !== "held-upstream-ok" || replay.status !== 503) process.exit(88);
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-hold-admit" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "hold-admit-ok", session_id: "sess-hold-admit" }) + "\\n");
  detachFixtureMcp(connector);
})().catch(() => process.exit(89));
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) { return defaultLaunchTurn({ ...input, testAgentUpstreamEndpoint }); },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ workAttemptId: "wa-cursor-hold-admit", cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "hold-admit" })));
    assert.equal(result.text, "hold-admit-ok");
    assert.equal(upstreamAuthorization, "Bearer test-provider-authorization");
    assert.equal(upstreamBody, "held-request-body");
  } finally {
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a held Run whose MCP attestation never completes fails with the exact causal reason and is never forwarded upstream", async () => {
  // With the model Run held rather than rejected, Cursor no longer dies in a
  // retry storm; the turn instead fails when the capability deadline elapses,
  // recording that exact attestation reason (not the generic connector-ended
  // message). Critically, a held Run whose attestation FAILS must never reach
  // the model backend: the recording upstream must see zero requests. A
  // regression that fail-opens the held release path would forward it here and
  // trip that assertion (the code-only mutation this test is designed to kill).
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-held-timeout-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const executable = join(root, "fake-cursor-agent");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  let upstreamHits = 0;
  const upstream = createHttp2Server();
  upstream.on("stream", (stream) => {
    upstreamHits += 1;
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.end("must-never-be-reached");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(0, "127.0.0.1", () => { upstream.removeListener("error", rejectListen); resolveListen(); });
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const testAgentUpstreamEndpoint = `http://127.0.0.1:${upstreamAddress.port}`;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
const body = "never-attested";
const req = http.request(new URL("/agent.v1.AgentService/Run", value("--agent-endpoint")), {
  method: "POST",
  headers: { "content-type": "application/connect+proto", authorization: "Bearer " + value("--auth-token"), "content-length": Buffer.byteLength(body) },
}, () => {});
req.on("error", () => {});
req.end(body);
setInterval(() => {}, 1000);
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          return defaultLaunchTurn({
            ...input,
            testAgentUpstreamEndpoint,
            testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
            testMcpCapabilityTimeoutMs: 800,
          });
        },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ workAttemptId: "wa-cursor-held-timeout", cwd: root }));
    await assert.rejects(
      withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "held-timeout" }))),
      (error: unknown) => {
        const message = String((error as Error)?.message ?? error);
        assert.match(message, /never connected the attested MCP runtime before model authority/);
        assert.doesNotMatch(message, /connector ended/);
        return true;
      },
    );
    assert.equal(upstreamHits, 0, "a held Run whose attestation failed must never be forwarded to the model backend");
  } finally {
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("two concurrent supervised agents each hold and admit their own Run independently", async () => {
  // The hold state is per-wrapper-process, so concurrent turns must not
  // interfere: each holds its own first Run and admits it on its own
  // attestation, with no shared admission slot or cross-turn deadlock.
  const buildAgent = async (label: string) => {
    const root = mkdtempSync(join(tmpdir(), `letagents-cursor-concurrent-${label}-`));
    const homeDir = join(root, "home");
    const configDir = join(root, "config");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    let upstreamBody = "";
    const upstream = createHttp2Server();
    upstream.on("stream", (stream) => {
      stream.on("data", (chunk) => { upstreamBody += chunk.toString("utf8"); });
      stream.once("end", () => {
        stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
        stream.end(`concurrent-upstream-${label}`);
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      upstream.once("error", rejectListen);
      upstream.listen(0, "127.0.0.1", () => { upstream.removeListener("error", rejectListen); resolveListen(); });
    });
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
    const testAgentUpstreamEndpoint = `http://127.0.0.1:${upstreamAddress.port}`;
    writeFileSync(executable, `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
function request(body) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL("/agent.v1.AgentService/Run", value("--agent-endpoint")), {
      method: "POST",
      headers: { "content-type": "application/connect+proto", authorization: "Bearer " + value("--auth-token"), "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end(body);
  });
}
(async () => {
  const held = request("concurrent-body-${label}");
  const connector = await attestFixtureMcp();
  const admitted = await held;
  if (admitted.status !== 200 || admitted.body !== "concurrent-upstream-${label}") process.exit(70);
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-concurrent-${label}" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "concurrent-${label}-ok", session_id: "sess-concurrent-${label}" }) + "\\n");
  detachFixtureMcp(connector);
})().catch(() => process.exit(71));
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) { return defaultLaunchTurn({ ...input, testAgentUpstreamEndpoint }); },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ workAttemptId: `wa-cursor-concurrent-${label}`, cwd: root }));
    return {
      root,
      upstream,
      run: () => withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: `concurrent-${label}` }))),
    };
  };
  const agentA = await buildAgent("a");
  const agentB = await buildAgent("b");
  try {
    const [resultA, resultB] = await Promise.all([agentA.run(), agentB.run()]);
    assert.equal(resultA.text, "concurrent-a-ok");
    assert.equal(resultB.text, "concurrent-b-ok");
  } finally {
    await new Promise<void>((resolveClose) => agentA.upstream.close(() => resolveClose()));
    await new Promise<void>((resolveClose) => agentB.upstream.close(() => resolveClose()));
    rmSync(agentA.root, { recursive: true, force: true });
    rmSync(agentB.root, { recursive: true, force: true });
  }
});

test("the supervised agent proxy rejects a boundary-violating request immediately, never holding it for attestation", async () => {
  // The attestation hold is only for the one exact, authorized Run. A request
  // outside that boundary -- wrong path or a bearer that is not the wrapper's
  // placeholder -- must be rejected at once, never granted the grace window.
  // The fake awaits those rejections BEFORE attesting: if such a request were
  // held, the await would block until the deadline and the turn would fail, so
  // reaching attestation and a 200 proves the immediate, hold-free rejection.
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-boundary-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const executable = join(root, "fake-cursor-agent");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  let upstreamBody = "";
  const upstream = createHttp2Server();
  upstream.on("stream", (stream) => {
    stream.on("data", (chunk) => { upstreamBody += chunk.toString("utf8"); });
    stream.once("end", () => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.end("boundary-upstream-ok");
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(0, "127.0.0.1", () => { upstream.removeListener("error", rejectListen); resolveListen(); });
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const testAgentUpstreamEndpoint = `http://127.0.0.1:${upstreamAddress.port}`;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
function request(path, body, authorization = "Bearer " + value("--auth-token")) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, value("--agent-endpoint")), {
      method: "POST",
      headers: { "content-type": "application/connect+proto", authorization, "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end(body);
  });
}
(async () => {
  // These resolve only if rejected immediately; if held, the awaits would hang.
  const wrongPath = await request("/agent.v1.AgentService/Other", "x");
  const badBearer = await request("/agent.v1.AgentService/Run", "x", "Bearer not-the-placeholder");
  if (wrongPath.status !== 503 || badBearer.status !== 503) process.exit(74);
  const connector = await attestFixtureMcp();
  const accepted = await request("/agent.v1.AgentService/Run", "boundary-request-body");
  if (accepted.status !== 200 || accepted.body !== "boundary-upstream-ok") process.exit(75);
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-boundary" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "boundary-ok", session_id: "sess-boundary" }) + "\\n");
  detachFixtureMcp(connector);
})().catch(() => process.exit(76));
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) { return defaultLaunchTurn({ ...input, testAgentUpstreamEndpoint }); },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ workAttemptId: "wa-cursor-boundary", cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "boundary" })));
    assert.equal(result.text, "boundary-ok");
    assert.equal(upstreamBody, "boundary-request-body");
  } finally {
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised native Cursor sandbox blocks late hook reads", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-native-hook-sandbox-"));
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    const blockedHook = join(root, "late-hooks.json");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(blockedHook, '{"hooks":{"beforeSubmitPrompt":[{"command":"steal"}]}}\n');
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
let result = "hook-readable";
try { fs.readFileSync(${JSON.stringify(blockedHook)}, "utf8"); }
catch (error) {
  if (!error || (error.code !== "EPERM" && error.code !== "EACCES")) process.exit(8);
  result = "hook-blocked";
}
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-hook-sandbox" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "sess-hook-sandbox" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root),
        nativeDeniedReadPaths: [blockedHook, join(realpathSync(root), "late-hooks.json")],
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.equal(result.text, "hook-blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real supervised profile hides compatible workspace Claude settings from native Cursor", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-workspace-claude-settings-"));
  try {
    const workspace = join(root, "workspace");
    const sourceHomeDir = join(root, "source-home");
    const stableProfileRoot = join(root, "stable-profile");
    const claudeSettings = join(workspace, ".claude", "settings.local.json");
    const redirectedClaudeSettings = join(workspace, ".claude", "settings.json");
    const externalSettings = join(root, "external-claude-settings.json");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(dirname(claudeSettings), { recursive: true });
    mkdirSync(join(sourceHomeDir, ".cursor"), { recursive: true });
    writeFileSync(claudeSettings, '{"permissions":{"allow":["Bash(*)"]}}\n');
    writeFileSync(externalSettings, '{"hooks":{"PreToolUse":[{"command":"steal"}]}}\n');
    symlinkSync(externalSettings, redirectedClaudeSettings);
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const authorityPaths = ${JSON.stringify([claudeSettings, redirectedClaudeSettings])};
let blocked = 0;
for (const authorityPath of authorityPaths) {
  try { fs.readFileSync(authorityPath, "utf8"); }
  catch (error) {
    if (!error || (error.code !== "EPERM" && error.code !== "EACCES")) process.exit(8);
    blocked += 1;
  }
}
const result = blocked === authorityPaths.length ? "claude-settings-blocked" : "claude-settings-readable";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-claude-settings" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "sess-claude-settings" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        attestSupervisedMcp: async () => {},
      },
      supervisedProfileFactory: (input) => prepareCursorSupervisedProfile({
        ...input,
        apiBaseUrl: "https://desktop.letagents.example",
        workspaceRoot: input.cwd,
        sourceHomeDir,
        profileRoot: input.profileRoot ?? stableProfileRoot,
        ...(input.inspectionOnly ? {} : {
          mcpRuntime: {
            entryPath: materializeAttestableMcpRuntime(join(dirname(sourceHomeDir), "attestable-mcp-runtime")),
            readRoots: [join(dirname(sourceHomeDir), "attestable-mcp-runtime")],
          },
        }),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: workspace }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.equal(result.text, "claude-settings-blocked");
    assert.equal(readFileSync(claudeSettings, "utf8"), '{"permissions":{"allow":["Bash(*)"]}}\n');
    assert.equal(readFileSync(externalSettings, "utf8"), '{"hooks":{"PreToolUse":[{"command":"steal"}]}}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real supervised boundary starts without inventorying pre-existing project files", {
  skip: process.platform !== "darwin",
}, async () => {
  for (const [permissionProfileId, sandbox, workspaceWritable] of [
    ["read_only", "enabled", false],
    ["sandboxed_write", "enabled", true],
    ["full_access", "disabled", true],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `letagents-cursor-${permissionProfileId}-boundary-`));
    try {
      const workspace = join(root, "workspace");
      const sourceHomeDir = join(root, "source-home");
      const stableProfileRoot = join(root, "stable-profile");
      const workspaceFile = join(workspace, "agent-change.txt");
      const outsideFile = join(root, "outside-workspace.txt");
      const workspaceHardlinkSource = join(workspace, "hardlink-source.txt");
      const workspaceHardlink = join(workspace, "hardlink-escape.txt");
      const preexistingOutsideTarget = join(root, "preexisting-outside-target.txt");
      const preexistingWorkspaceAlias = join(workspace, "preexisting-outside-alias.txt");
      const cursorAuthority = join(workspace, ".cursor", "mcp.json");
      const executable = join(root, "fake-cursor-agent");
      initializeGitWorkspace(workspace);
      mkdirSync(dirname(cursorAuthority), { recursive: true });
      writeFileSync(join(workspace, ".cursor", ".keep"), "");
      mkdirSync(join(sourceHomeDir, ".cursor"), { recursive: true });
      writeFileSync(workspaceHardlinkSource, "inside-original\n");
      writeFileSync(preexistingOutsideTarget, "preexisting-outside\n");
      linkSync(preexistingOutsideTarget, preexistingWorkspaceAlias);
      writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const workspace = args[args.indexOf("--workspace") + 1];
function write(path) {
  try { fs.writeFileSync(path, "changed\\n"); return "allowed"; }
  catch (error) {
    if (!error || (error.code !== "EPERM" && error.code !== "EACCES")) return error && error.code || "error";
    return "blocked";
  }
}
function link(source, destination) {
  try { fs.linkSync(source, destination); return "allowed"; }
  catch (error) {
    if (!error || (error.code !== "EPERM" && error.code !== "EACCES")) return error && error.code || "error";
    return "blocked";
  }
}
const outcome = {
  workspace: write(path.join(workspace, "agent-change.txt")),
  outside: write(${JSON.stringify(outsideFile)}),
  hardlinkCreate: link(path.join(workspace, "hardlink-source.txt"), path.join(workspace, "hardlink-escape.txt")),
  authority: write(path.join(workspace, ".cursor", "mcp.json")),
};
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-write-boundary" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(outcome), session_id: "sess-write-boundary" }) + "\\n");
`);
      chmodSync(executable, 0o700);
      let launchArgs: string[] = [];
      const adapter = new CursorProviderAdapter({
        cursorBin: executable,
        dependencies: {
          ...productionPersonalIdentityDependencies,
          attestSupervisedMcp: async () => {},
          launchTurn(input) {
            launchArgs = [...input.args];
            return defaultLaunchTurn(input);
          },
        },
        supervisedProfileFactory: (input) => prepareCursorSupervisedProfile({
          ...input,
          apiBaseUrl: "https://desktop.letagents.example",
          workspaceRoot: input.cwd,
          sourceHomeDir,
          profileRoot: input.profileRoot ?? stableProfileRoot,
          ...(input.inspectionOnly ? {} : {
            mcpRuntime: {
            entryPath: materializeAttestableMcpRuntime(join(dirname(sourceHomeDir), "attestable-mcp-runtime")),
            readRoots: [join(dirname(sourceHomeDir), "attestable-mcp-runtime")],
          },
          }),
        }),
      });
      const handle = await adapter.spawn(daemonSpawnRequest({
        cwd: workspace,
        workAttemptId: `wa-${permissionProfileId}-boundary`,
        permissionProfileId,
        launchPolicy: permissionProfileId === "read_only"
          ? { mode: "ask", force: false }
          : { force: true, sandbox },
      }));
      const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
        inboxItemId: `inbox-${permissionProfileId}-boundary`,
      })));
      assert.deepEqual(JSON.parse(result.text!), {
        workspace: workspaceWritable ? "allowed" : "blocked",
        outside: "blocked",
        hardlinkCreate: "blocked",
        authority: "blocked",
      });
      assert.equal(launchArgs.includes("--force"), permissionProfileId !== "read_only");
      assert.equal(argValue(launchArgs, "--sandbox"), sandbox);
      assert.equal(existsSync(workspaceFile), workspaceWritable);
      assert.equal(existsSync(outsideFile), false);
      assert.equal(existsSync(join(root, "symlink-escape.txt")), false);
      assert.equal(readFileSync(workspaceHardlinkSource, "utf8"), "inside-original\n");
      assert.equal(readFileSync(preexistingOutsideTarget, "utf8"), "preexisting-outside\n");
      assert.equal(existsSync(cursorAuthority), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the supervised workspace boundary runs Node, npm, Git, the system compiler, and repo-native binaries", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-workspace-toolchains-"));
  try {
    const workspace = join(root, "workspace");
    const sourceHomeDir = join(root, "source-home");
    const stableProfileRoot = join(root, "stable-profile");
    const executable = join(root, "fake-cursor-agent");
    const nativeBinary = join(workspace, "repo-native-esbuild");
    const hostBrokerProbeSource = join(workspace, "host-broker-probe.c");
    const hostBrokerProbe = join(workspace, "host-broker-probe");
    const insideCopySource = join(workspace, "copy-source.txt");
    const insideCopyTarget = join(workspace, "copy-target.txt");
    const outsideCopySource = join(root, "outside-copy-source.txt");
    const outsideCloneTarget = join(workspace, "outside-clone-target.txt");
    initializeGitWorkspace(workspace);
    mkdirSync(join(sourceHomeDir, ".cursor"), { recursive: true });
    writeFileSync(hostBrokerProbeSource, `
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreServices/CoreServices.h>
#include <stdio.h>
int main(void) {
  CFArrayRef keychains = NULL;
  OSStatus keychainStatus = SecKeychainCopySearchList(&keychains);
  int keychainAccessible = keychainStatus == errSecSuccess;
  if (keychains != NULL) CFRelease(keychains);
  CFPropertyListRef preference = CFPreferencesCopyValue(
    CFSTR("AppleLocale"),
    kCFPreferencesAnyApplication,
    kCFPreferencesCurrentUser,
    kCFPreferencesAnyHost
  );
  int preferencesAccessible = preference != NULL;
  if (preference != NULL) CFRelease(preference);
  CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
  int windowsAccessible = windows != NULL;
  if (windows != NULL) CFRelease(windows);
  MDQueryRef metadataQuery = MDQueryCreate(
    kCFAllocatorDefault,
    CFSTR("kMDItemFSName == 'package.json'"),
    NULL,
    NULL
  );
  int metadataAccessible = metadataQuery != NULL && MDQueryExecute(metadataQuery, kMDQuerySynchronous);
  if (metadataQuery != NULL) CFRelease(metadataQuery);
  printf("{\\\"keychain\\\":%s,\\\"preferences\\\":%s,\\\"windows\\\":%s,\\\"metadata\\\":%s}\\n",
    keychainAccessible ? "true" : "false",
    preferencesAccessible ? "true" : "false",
    windowsAccessible ? "true" : "false",
    metadataAccessible ? "true" : "false");
  return 0;
}
`);
    const compiler = [
      "/Library/Developer/CommandLineTools/usr/bin/clang",
      "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang",
    ].find((candidate) => existsSync(candidate));
    assert.ok(compiler, "the macOS test host exposes a real compiler driver");
    const sdkRoot = [
      "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk",
      "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
    ].find((candidate) => existsSync(candidate));
    assert.ok(sdkRoot, "the macOS test host exposes a selected SDK");
    const compileProbe = spawnSync(compiler, [
      "-isysroot", sdkRoot,
      "-framework", "Security",
      "-framework", "CoreFoundation",
      "-framework", "CoreGraphics",
      "-framework", "CoreServices",
      hostBrokerProbeSource,
      "-o", hostBrokerProbe,
    ], { encoding: "utf8" });
    assert.equal(compileProbe.status, 0, compileProbe.stderr);
    writeFileSync(insideCopySource, "inside-copy\n");
    writeFileSync(outsideCopySource, "outside-private\n");
    copyFileSync(join(process.cwd(), "node_modules", "esbuild", "bin", "esbuild"), nativeBinary);
    chmodSync(nativeBinary, 0o700);
    writeFileSync(executable, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const args = process.argv.slice(2);
const workspace = args[args.indexOf("--workspace") + 1];
function run(command, args) {
  const child = spawnSync(command, args, { cwd: workspace, encoding: "utf8" });
  return {
    ok: child.status === 0,
    code: child.error && child.error.code || null,
    signal: child.signal || null,
    output: (child.stdout || child.stderr || "").trim(),
  };
}
const outcome = {
  node: run("node", ["--version"]),
  npm: run("npm", ["--version"]),
  git: run("git", ["status", "--porcelain"]),
  native: run(path.join(workspace, "repo-native-esbuild"), ["--version"]),
  compiler: run("clang", ["--version"]),
  hostBrokers: run(path.join(workspace, "host-broker-probe"), []),
  insideCopy: run("/bin/cp", [path.join(workspace, "copy-source.txt"), path.join(workspace, "copy-target.txt")]),
  outsideClone: run("/bin/cp", ["-c", ${JSON.stringify(outsideCopySource)}, path.join(workspace, "outside-clone-target.txt")]),
};
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-workspace-toolchains" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(outcome), session_id: "sess-workspace-toolchains" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        attestSupervisedMcp: async () => {},
      },
      supervisedProfileFactory: (input) => prepareCursorSupervisedProfile({
        ...input,
        apiBaseUrl: "https://desktop.letagents.example",
        workspaceRoot: input.cwd,
        sourceHomeDir,
        profileRoot: input.profileRoot ?? stableProfileRoot,
        ...(input.inspectionOnly ? {} : {
          mcpRuntime: {
            entryPath: materializeAttestableMcpRuntime(join(dirname(sourceHomeDir), "attestable-mcp-runtime")),
            readRoots: [join(dirname(sourceHomeDir), "attestable-mcp-runtime")],
          },
        }),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({
      cwd: workspace,
      workAttemptId: "wa-workspace-toolchains",
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
      inboxItemId: "inbox-workspace-toolchains",
    })));
    const outcome = JSON.parse(result.text!) as Record<string, {
      ok: boolean;
      code: string | null;
      signal: string | null;
      output: string;
    }>;
    assert.equal(outcome.node?.ok, true, JSON.stringify(outcome.node));
    assert.equal(outcome.npm?.ok, true, JSON.stringify(outcome.npm));
    assert.equal(outcome.git?.ok, true, JSON.stringify(outcome.git));
    assert.equal(outcome.native?.ok, true, JSON.stringify(outcome.native));
    assert.match(outcome.native?.output ?? "", /^\d+[.]\d+[.]\d+$/);
    assert.equal(outcome.compiler?.ok, true, JSON.stringify(outcome.compiler));
    assert.match(outcome.compiler?.output ?? "", /clang version/i);
    assert.equal(outcome.hostBrokers?.ok, true, JSON.stringify(outcome.hostBrokers));
    assert.deepEqual(JSON.parse(outcome.hostBrokers?.output ?? "null"), {
      keychain: false,
      preferences: false,
      windows: false,
      metadata: false,
    }, "repo-native framework clients cannot query host keychains, preferences, or windows");
    assert.equal(outcome.insideCopy?.ok, true, JSON.stringify(outcome.insideCopy));
    assert.equal(outcome.outsideClone?.ok, false, "APFS clone still requires source read authority");
    assert.equal(readFileSync(insideCopyTarget, "utf8"), "inside-copy\n");
    assert.equal(existsSync(outsideCloneTarget), false);
    assert.equal(existsSync(join(workspace, ".git", "HEAD")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hostile PATH roots cannot widen supervised reads outside the selected workspace", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-hostile-path-"));
  const previousHome = process.env.HOME;
  try {
    const workspace = join(root, "workspace");
    const hostHome = join(root, "host-home");
    const pathHomeAlias = join(root, "path-home-bin");
    const pathSecretAlias = join(root, "path-secret-bin");
    const customBin = join(root, "custom-bin");
    const customTool = join(customBin, "repo-tool");
    const secretDirectory = join(hostHome, ".ssh");
    const secret = join(secretDirectory, "id_test");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(hostHome, { recursive: true });
    mkdirSync(secretDirectory, { recursive: true });
    mkdirSync(customBin, { recursive: true });
    process.env.HOME = hostHome;
    writeFileSync(secret, "must-stay-private\n");
    symlinkSync(hostHome, pathHomeAlias, "dir");
    symlinkSync(secretDirectory, pathSecretAlias, "dir");
    writeFileSync(customTool, `#!${process.execPath}\nprocess.stdout.write("custom-tool-ok\\n");\n`);
    chmodSync(customTool, 0o700);
    writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
let outsideRead = "allowed";
try { fs.readFileSync(${JSON.stringify(secret)}, "utf8"); }
catch (error) { outsideRead = error && (error.code === "EPERM" || error.code === "EACCES") ? "blocked" : error && error.code || "error"; }
const tool = spawnSync("repo-tool", [], { encoding: "utf8" });
const outcome = { outsideRead, tool: tool.status === 0 ? tool.stdout.trim() : tool.error && tool.error.code || tool.signal || "blocked" };
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-hostile-path" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(outcome), session_id: "sess-hostile-path" }) + "\\n");
`);
    chmodSync(executable, 0o700);

    for (const [name, candidatePath, expectedTool] of [
      ["root", "/", null],
      ["home-alias", pathHomeAlias, null],
      ["secret-child-alias", pathSecretAlias, null],
      ["custom-bin", customBin, "custom-tool-ok"],
    ] as const) {
      const stableProfileRoot = join(root, `stable-profile-${name}`);
      mkdirSync(stableProfileRoot, { recursive: true });
      const adapter = new CursorProviderAdapter({
        cursorBin: executable,
        dependencies: {
          ...productionPersonalIdentityDependencies,
          attestSupervisedMcp: async () => {},
        },
        supervisedProfileFactory: (input) => {
          const profileRoot = input.profileRoot ?? stableProfileRoot;
          for (const directory of ["home", "config", "data", "cache"]) {
            mkdirSync(join(profileRoot, directory), { recursive: true });
          }
          const mcp = wrapperHostedMcpFixture(profileRoot);
          return {
            homeDir: join(profileRoot, "home"),
            configDir: join(profileRoot, "config"),
            dataDir: join(profileRoot, "data"),
            cacheDir: join(profileRoot, "cache"),
            env: { HOME: join(profileRoot, "home"), PATH: candidatePath },
            mcpRuntimeEntryPath: mcp.mcpRuntimeEntryPath,
            mcpRuntimeEnv: mcp.mcpRuntimeEnv,
            nativeAllowedWriteSubpaths: [profileRoot],
            nativeAllowedReadSubpaths: [profileRoot, workspace],
          };
        },
      });
      const handle = await adapter.spawn(daemonSpawnRequest({
        cwd: workspace,
        workAttemptId: `wa-hostile-path-${name}`,
      }));
      const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
        inboxItemId: `inbox-hostile-path-${name}`,
      })));
      const outcome = JSON.parse(result.text!) as { outsideRead: string; tool: string };
      assert.equal(outcome.outsideRead, "blocked", `PATH ${candidatePath} did not become broad file-read authority`);
      if (expectedTool) assert.equal(outcome.tool, expectedTool, `PATH ${candidatePath} remains usable for narrow custom tools`);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised workspace generation supports linked Git worktrees without exposing shared Git authority", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-linked-worktree-"));
  try {
    const repository = join(root, "repository");
    const workspace = join(root, "selected-worktree");
    const sourceHomeDir = join(root, "source-home");
    const stableProfileRoot = join(root, "stable-profile");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(repository, { recursive: true });
    mkdirSync(join(sourceHomeDir, ".cursor"), { recursive: true });
    assert.equal(spawnSync("git", ["init", "--quiet", repository]).status, 0);
    writeFileSync(join(repository, "seed.txt"), "seed\n");
    assert.equal(spawnSync("git", ["-C", repository, "add", "seed.txt"]).status, 0);
    assert.equal(spawnSync("git", [
      "-c", "user.name=Cursor Test", "-c", "user.email=cursor@example.test",
      "-C", repository, "commit", "--quiet", "-m", "seed",
    ]).status, 0);
    assert.equal(spawnSync("git", ["-C", repository, "worktree", "add", "--quiet", "-b", "cursor-write", workspace]).status, 0);

    const featureFile = join(workspace, "feature.txt");
    const outsideMainWorktree = join(repository, "outside-main.txt");
    const gitMarker = join(workspace, ".git");
    const originalGitMarker = readFileSync(gitMarker, "utf8");
    const gitDirectory = spawnSync("git", ["-C", workspace, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).stdout.trim();
    const gitCommonDirectory = spawnSync("git", ["-C", workspace, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).stdout.trim();
    const commonDirectory = realpathSync(resolve(workspace, gitCommonDirectory));
    const hookPath = join(commonDirectory, "hooks", "pre-commit");
    const worktreeConfigPath = join(gitDirectory, "config.worktree");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const cliArgs = process.argv.slice(2);
const providerWorkspace = cliArgs[cliArgs.indexOf("--workspace") + 1];
function run(args) {
  const child = spawnSync("git", args, { cwd: providerWorkspace, encoding: "utf8" });
  return { ok: child.status === 0, output: (child.stderr || child.stdout || "").trim() };
}
function attempt(callback) {
  try { callback(); return "allowed"; }
  catch (error) { return error && (error.code === "EPERM" || error.code === "EACCES") ? "blocked" : error && error.code || "error"; }
}
fs.writeFileSync(path.join(providerWorkspace, "feature.txt"), "linked-worktree-change\\n");
let outside = "allowed";
try { fs.writeFileSync(${JSON.stringify(outsideMainWorktree)}, "must-not-write\\n"); }
catch (error) { outside = error && (error.code === "EPERM" || error.code === "EACCES") ? "blocked" : error && error.code || "error"; }
const hook = attempt(() => fs.writeFileSync(${JSON.stringify(hookPath)}, "#!/bin/sh\\nexit 1\\n"));
const worktreeConfig = attempt(() => fs.writeFileSync(${JSON.stringify(worktreeConfigPath)}, "[core]\\n\\thooksPath = planted\\n"));
const marker = attempt(() => fs.writeFileSync(${JSON.stringify(gitMarker)}, "gitdir: /tmp/planted\\n"));
const hooksConfig = run(["config", "core.hooksPath", ".planted-hooks"]);
const add = run(["add", "feature.txt"]);
const commit = run(["-c", "user.name=Cursor Test", "-c", "user.email=cursor@example.test", "commit", "--quiet", "-m", "cursor linked worktree"]);
const outcome = { add, commit, outside, hook, worktreeConfig, marker, hooksConfig };
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-linked-worktree" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(outcome), session_id: "sess-linked-worktree" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        attestSupervisedMcp: async () => {},
      },
      supervisedProfileFactory: (input) => prepareCursorSupervisedProfile({
        ...input,
        apiBaseUrl: "https://desktop.letagents.example",
        workspaceRoot: input.cwd,
        sourceHomeDir,
        profileRoot: input.profileRoot ?? stableProfileRoot,
        ...(input.inspectionOnly ? {} : {
          mcpRuntime: {
            entryPath: materializeAttestableMcpRuntime(join(dirname(sourceHomeDir), "attestable-mcp-runtime")),
            readRoots: [join(dirname(sourceHomeDir), "attestable-mcp-runtime")],
          },
        }),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({
      cwd: workspace,
      workAttemptId: "wa-linked-worktree",
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
      inboxItemId: "inbox-linked-worktree",
    })));
    const outcome = JSON.parse(result.text!) as {
      add: { ok: boolean }; commit: { ok: boolean }; outside: string; hook: string;
      worktreeConfig: string; marker: string; hooksConfig: { ok: boolean };
    };
    assert.equal(outcome.add.ok, true);
    assert.equal(outcome.commit.ok, true);
    assert.equal(outcome.outside, "blocked");
    assert.equal(outcome.hook, "blocked");
    assert.equal(outcome.worktreeConfig, "blocked");
    assert.equal(outcome.marker, "blocked");
    assert.equal(outcome.hooksConfig.ok, false, "provider-visible Git config remains immutable after trusted setup");
    assert.equal(readFileSync(featureFile, "utf8"), "linked-worktree-change\n");
    assert.equal(existsSync(outsideMainWorktree), false);
    assert.equal(existsSync(hookPath), false);
    assert.equal(existsSync(worktreeConfigPath), false);
    assert.equal(readFileSync(gitMarker, "utf8"), originalGitMarker);
    assert.equal(spawnSync("git", ["-C", workspace, "log", "-1", "--format=%s"], { encoding: "utf8" }).stdout.trim(), "seed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised workspace generation rejects Git submodules before native launch", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-submodule-boundary-"));
  try {
    const childRepository = join(root, "child-origin");
    const repository = join(root, "superproject");
    const workspace = join(repository, "modules", "child");
    const sourceHomeDir = join(root, "source-home");
    const stableProfileRoot = join(root, "stable-profile");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(childRepository, { recursive: true });
    mkdirSync(repository, { recursive: true });
    mkdirSync(join(sourceHomeDir, ".cursor"), { recursive: true });
    assert.equal(spawnSync("git", ["init", "--quiet", childRepository]).status, 0);
    writeFileSync(join(childRepository, "seed.txt"), "seed\n");
    assert.equal(spawnSync("git", ["-C", childRepository, "add", "seed.txt"]).status, 0);
    assert.equal(spawnSync("git", [
      "-c", "user.name=Cursor Test", "-c", "user.email=cursor@example.test",
      "-C", childRepository, "commit", "--quiet", "-m", "child seed",
    ]).status, 0);
    assert.equal(spawnSync("git", ["init", "--quiet", repository]).status, 0);
    writeFileSync(join(repository, "parent.txt"), "parent\n");
    assert.equal(spawnSync("git", ["-C", repository, "add", "parent.txt"]).status, 0);
    assert.equal(spawnSync("git", [
      "-c", "user.name=Cursor Test", "-c", "user.email=cursor@example.test",
      "-C", repository, "commit", "--quiet", "-m", "parent seed",
    ]).status, 0);
    assert.equal(spawnSync("git", [
      "-c", "protocol.file.allow=always", "-C", repository,
      "submodule", "add", "--quiet", `file://${childRepository}`, "modules/child",
    ]).status, 0);
    assert.equal(spawnSync("git", [
      "-c", "user.name=Cursor Test", "-c", "user.email=cursor@example.test",
      "-C", repository, "commit", "--quiet", "-am", "add child",
    ]).status, 0);

    const featureFile = join(workspace, "feature.txt");
    const parentEscape = join(repository, "parent-escape.txt");
    const gitMarker = join(workspace, ".git");
    const originalGitMarker = readFileSync(gitMarker, "utf8");
    const gitDirectory = spawnSync("git", ["-C", workspace, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).stdout.trim();
    const hookPath = join(gitDirectory, "hooks", "pre-commit");
    const configPath = join(gitDirectory, "config");
    const originalConfig = readFileSync(configPath, "utf8");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
function run(args) {
  const child = spawnSync("git", args, { cwd: ${JSON.stringify(workspace)}, encoding: "utf8" });
  return { ok: child.status === 0, output: (child.stderr || child.stdout || "").trim() };
}
function attempt(callback) {
  try { callback(); return "allowed"; }
  catch (error) { return error && (error.code === "EPERM" || error.code === "EACCES") ? "blocked" : error && error.code || "error"; }
}
fs.writeFileSync(${JSON.stringify(featureFile)}, "submodule-change\\n");
const parent = attempt(() => fs.writeFileSync(${JSON.stringify(parentEscape)}, "must-not-write\\n"));
const hook = attempt(() => fs.writeFileSync(${JSON.stringify(hookPath)}, "#!/bin/sh\\nexit 1\\n"));
const marker = attempt(() => fs.writeFileSync(${JSON.stringify(gitMarker)}, "gitdir: /tmp/planted\\n"));
const hooksConfig = run(["config", "core.hooksPath", ".planted-hooks"]);
const add = run(["add", "feature.txt"]);
const commit = run(["-c", "user.name=Cursor Test", "-c", "user.email=cursor@example.test", "commit", "--quiet", "-m", "cursor submodule"]);
const outcome = { add, commit, parent, hook, marker, hooksConfig };
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-submodule-boundary" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(outcome), session_id: "sess-submodule-boundary" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        attestSupervisedMcp: async () => {},
      },
      supervisedProfileFactory: (input) => prepareCursorSupervisedProfile({
        ...input,
        apiBaseUrl: "https://desktop.letagents.example",
        workspaceRoot: input.cwd,
        sourceHomeDir,
        profileRoot: input.profileRoot ?? stableProfileRoot,
        ...(input.inspectionOnly ? {} : {
          mcpRuntime: {
            entryPath: materializeAttestableMcpRuntime(join(dirname(sourceHomeDir), "attestable-mcp-runtime")),
            readRoots: [join(dirname(sourceHomeDir), "attestable-mcp-runtime")],
          },
        }),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({
      cwd: workspace,
      workAttemptId: "wa-submodule-boundary",
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    await assert.rejects(
      withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
        inboxItemId: "inbox-submodule-boundary",
      }))),
      /submodules|separate Git directories/i,
    );
    assert.equal(existsSync(featureFile), false);
    assert.equal(existsSync(parentEscape), false);
    assert.equal(existsSync(hookPath), false);
    assert.equal(readFileSync(gitMarker, "utf8"), originalGitMarker);
    assert.equal(readFileSync(configPath, "utf8"), originalConfig);
    assert.equal(spawnSync("git", ["-C", workspace, "log", "-1", "--format=%s"], { encoding: "utf8" }).stdout.trim(), "child seed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real supervised boundary blocks a late in-workspace authority symlink", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-late-authority-symlink-"));
  try {
    const workspace = join(root, "workspace");
    const insideTarget = join(workspace, "inside-target");
    const sourceHomeDir = join(root, "source-home");
    const stableProfileRoot = join(root, "stable-profile");
    const targetSettings = join(insideTarget, "settings.json");
    const targetMcp = join(insideTarget, "mcp.json");
    const executable = join(root, "fake-cursor-agent");
    initializeGitWorkspace(workspace);
    mkdirSync(insideTarget, { recursive: true });
    mkdirSync(join(sourceHomeDir, ".cursor"), { recursive: true });
    writeFileSync(targetSettings, "inside-secret\n");
writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const workspace = args[args.indexOf("--workspace") + 1];
function attempt(callback) {
  try { callback(); return "allowed"; }
  catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES")) return "blocked";
    return error && error.code || "error";
  }
}
const outcome = {
  read: attempt(() => fs.readFileSync(path.join(workspace, ".cursor", "settings.json"), "utf8")),
  write: attempt(() => fs.writeFileSync(path.join(workspace, ".cursor", "mcp.json"), "replaced\\n")),
};
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-late-authority-symlink" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(outcome), session_id: "sess-late-authority-symlink" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    let launchedChild: CursorCliChild | null = null;
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        attestSupervisedMcp: async () => {},
        launchTurn(input) {
          const launchWorkspace = argValue(input.args, "--workspace")!;
          const authorityLink = join(launchWorkspace, ".cursor");
          if (!existsSync(authorityLink)) {
            symlinkSync(join(launchWorkspace, "inside-target"), authorityLink, "dir");
          }
          launchedChild = defaultLaunchTurn(input);
          void launchedChild.exited.then(() => rmSync(authorityLink, { force: true }));
          return launchedChild;
        },
      },
      supervisedProfileFactory: (input) => prepareCursorSupervisedProfile({
        ...input,
        apiBaseUrl: "https://desktop.letagents.example",
        workspaceRoot: input.cwd,
        sourceHomeDir,
        profileRoot: input.profileRoot ?? stableProfileRoot,
        ...(input.inspectionOnly ? {} : {
          mcpRuntime: {
            entryPath: materializeAttestableMcpRuntime(join(dirname(sourceHomeDir), "attestable-mcp-runtime")),
            readRoots: [join(dirname(sourceHomeDir), "attestable-mcp-runtime")],
          },
        }),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({
      cwd: workspace,
      workAttemptId: "wa-late-authority-symlink",
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    let result: ProviderRoomTurnResult;
    try {
      result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
        inboxItemId: "inbox-late-authority-symlink",
      })));
    } catch (error) {
      const nativeStderr = (launchedChild as CursorCliChild | null)?.stderrTail() ?? "<none>";
      throw new Error(`${error instanceof Error ? error.message : String(error)}; native stderr: ${nativeStderr}`);
    }
    assert.deepEqual(JSON.parse(result.text!), { read: "blocked", write: "blocked" });
    assert.equal(readFileSync(targetSettings, "utf8"), "inside-secret\n");
    assert.equal(existsSync(targetMcp), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised native sandbox blocks macOS effect-delegating helpers and private-profile executables", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-native-delegation-"));
  try {
    const profileRoot = join(root, "private-profile");
    const configDir = join(profileRoot, "config");
    const homeDir = join(profileRoot, "home");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
const copiedOpen = process.env.HOME + "/copied-open";
fs.copyFileSync("/usr/bin/open", copiedOpen);
fs.chmodSync(copiedOpen, 0o700);
function blocked(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "ignore" });
  return result.error?.code === "EPERM" || result.error?.code === "EACCES" || result.status !== 0;
}
const outcome = {
  directOpen: blocked("/usr/bin/open", ["--help"]),
  copiedOpen: blocked(copiedOpen, ["--help"]),
  appleScript: blocked("/usr/bin/osascript", ["-e", "return 1"]),
  keychainCli: blocked("/usr/bin/security", ["list-keychains"]),
  xcodeDispatcher: blocked("/usr/bin/xcrun", ["--find", "clang"]),
};
const session = "sess-native-delegation";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: session }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(outcome), session_id: session }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(profileRoot, "data"),
        cacheDir: join(profileRoot, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root),
        nativeDeniedExecSubpaths: [profileRoot, realpathSync(profileRoot)],
        nativeAllowedWriteSubpaths: [profileRoot, realpathSync(profileRoot)],
        nativeAllowedReadSubpaths: [root, realpathSync(root)],
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.deepEqual(JSON.parse(result.text!), {
      directOpen: true,
      copiedOpen: true,
      appleScript: true,
      keychainCli: true,
      xcodeDispatcher: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised native sandbox cannot signal its wrapper or unrelated same-UID processes", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-native-signal-fence-"));
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
  const victimClosed = new Promise<void>((resolve) => victim.once("close", () => resolve()));
  try {
    const profileRoot = join(root, "private-profile");
    const configDir = join(profileRoot, "config");
    const homeDir = join(profileRoot, "home");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(executable, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
const ownChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
let externalBlocked = false;
let parentBlocked = false;
let childAllowed = false;
try { process.kill(${victim.pid}, "SIGTERM"); }
catch (error) { externalBlocked = error?.code === "EPERM" || error?.code === "EACCES"; }
try { process.kill(process.ppid, "SIGTERM"); }
catch (error) { parentBlocked = error?.code === "EPERM" || error?.code === "EACCES"; }
try { process.kill(ownChild.pid, "SIGTERM"); childAllowed = true; }
catch {}
const session = "sess-native-signal-fence";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: session }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", is_error: false,
  result: JSON.stringify({ externalBlocked, parentBlocked, childAllowed }), session_id: session,
}) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(profileRoot, "data"),
        cacheDir: join(profileRoot, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root),
        nativeAllowedWriteSubpaths: [profileRoot, realpathSync(profileRoot)],
        nativeAllowedReadSubpaths: [root, realpathSync(root)],
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.deepEqual(JSON.parse(result.text!), {
      externalBlocked: true,
      parentBlocked: true,
      childAllowed: true,
    });
    assert.doesNotThrow(() => process.kill(victim.pid!, 0), "the unrelated process remains alive");
  } finally {
    try { victim.kill("SIGKILL"); } catch {}
    await victimClosed;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised native sandbox fences private config, runtime, Statsig temps, and redirected authority roots", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-native-authority-fences-"));
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    const cursorHome = join(homeDir, ".cursor");
    const runtimeConfig = join(configDir, "cursor");
    const runtimeRoot = join(root, "runtime");
    const workspace = join(root, "workspace");
    const externalCursor = join(root, "external-cursor");
    const privateMcp = join(cursorHome, "mcp.json");
    const privatePermissions = join(runtimeConfig, "cli-config.json");
    const identityBinding = join(configDir, "letagents-cursor-identity.json");
    const runtimeFile = join(runtimeRoot, "server.js");
    const statsigTemp = join(runtimeConfig, "statsig-cache.json.4321.01234567-89ab-cdef-0123-456789abcdef.tmp");
    const redirectedSettings = join(workspace, ".cursor", "settings.json");
    const executable = join(root, "fake-cursor-agent");
    for (const directory of [cursorHome, runtimeConfig, runtimeRoot, workspace, externalCursor, join(root, "data"), join(root, "cache")]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(privateMcp, "mcp-original\n");
    writeFileSync(privatePermissions, "permissions-original\n");
    writeFileSync(identityBinding, '{"userId":12345}\n');
    writeFileSync(runtimeFile, "runtime-original\n");
    writeFileSync(join(externalCursor, "settings.json"), "redirected-secret\n");
    symlinkSync(externalCursor, join(workspace, ".cursor"), "dir");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
const cliTemp = ${JSON.stringify(`${privatePermissions}.native-tmp`)};
let cliConfigRewritten = false;
try {
  fs.writeFileSync(cliTemp, "permissions-native-rewrite\\n");
  fs.renameSync(cliTemp, ${JSON.stringify(privatePermissions)});
  cliConfigRewritten = true;
} catch {}
const attempts = [
  () => fs.writeFileSync(${JSON.stringify(privateMcp)}, "replaced"),
  () => fs.unlinkSync(${JSON.stringify(identityBinding)}),
  () => fs.writeFileSync(${JSON.stringify(runtimeFile)}, "replaced"),
  () => fs.writeFileSync(${JSON.stringify(statsigTemp)}, "remote gates"),
  () => fs.readFileSync(${JSON.stringify(redirectedSettings)}, "utf8"),
  () => fs.symlinkSync(${JSON.stringify(externalCursor)}, ${JSON.stringify(join(workspace, ".claude"))}, "dir"),
  () => fs.readdirSync("/usr/local"),
  () => fs.readdirSync("/Library/Application Support"),
];
let blocked = 0;
const outcomes = [];
for (const attempt of attempts) {
  try { attempt(); outcomes.push("allowed"); }
  catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES")) { blocked += 1; outcomes.push("blocked"); }
    else outcomes.push(error && error.code || "error");
  }
}
const result = blocked === attempts.length && cliConfigRewritten
  ? "authority-fences-blocked"
  : "authority-fence-bypass:" + blocked + ":cli=" + cliConfigRewritten + ":" + outcomes.join(",");
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-authority-fences" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "sess-authority-fences" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const canonicalRoot = realpathSync(root);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root),
        nativeDeniedReadMetadataPaths: [
          join(canonicalRoot, "workspace", ".cursor"),
          join(canonicalRoot, "workspace", ".claude"),
        ],
        nativeDeniedReadWriteRegexes: [
          `^${join(root, "config", "cursor", "statsig-cache[.]json[.][0-9]+[.][0-9A-Fa-f-]+[.]tmp")}$`,
          `^${join(canonicalRoot, "config", "cursor", "statsig-cache[.]json[.][0-9]+[.][0-9A-Fa-f-]+[.]tmp")}$`,
        ],
        nativeDeniedWritePaths: [privateMcp, realpathSync(privateMcp), identityBinding, realpathSync(identityBinding)],
        nativeDeniedWriteStructuralPaths: [root, homeDir, cursorHome, configDir, runtimeConfig],
        nativeDeniedWriteSubpaths: [runtimeRoot],
        nativeAllowedWriteSubpaths: [
          homeDir, realpathSync(homeDir), configDir, realpathSync(configDir),
          join(root, "data"), join(canonicalRoot, "data"), join(root, "cache"), join(canonicalRoot, "cache"),
        ],
        nativeAllowedReadSubpaths: [
          homeDir, realpathSync(homeDir), configDir, realpathSync(configDir),
          join(root, "data"), join(canonicalRoot, "data"), join(root, "cache"), join(canonicalRoot, "cache"),
          workspace, realpathSync(workspace),
        ],
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: workspace }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.equal(result.text, "authority-fences-blocked");
    assert.equal(readFileSync(privateMcp, "utf8"), "mcp-original\n");
    assert.equal(readFileSync(privatePermissions, "utf8"), "permissions-native-rewrite\n");
    assert.equal(readFileSync(identityBinding, "utf8"), '{"userId":12345}\n');
    assert.equal(readFileSync(runtimeFile, "utf8"), "runtime-original\n");
    assert.equal(existsSync(statsigTemp), false);
    assert.equal(existsSync(join(workspace, ".claude")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production Cursor turn wrapper never leaks Electron's wrapper-only Node mode into native Cursor", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-wrapper-electron-env-"));
  const previousElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  try {
    const executable = join(root, "fake-cursor-agent");
    writeFileSync(executable, `#!/usr/bin/env node
if (process.argv.includes("--endpoint") || process.argv.includes("--agent-endpoint")) process.exit(8);
if (process.env.ELECTRON_RUN_AS_NODE !== undefined) process.exit(7);
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-electron-env" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "native env clean", session_id: "sess-electron-env" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    process.env.ELECTRON_RUN_AS_NODE = "1";

    const adapter = new CursorProviderAdapter({ cursorBin: executable });
    const handle = await adapter.spawn(spawnRequest({ cwd: root }));
    for (let index = 0; index < 100 && handle.observedState() !== "idle"; index += 1) await flush();
    assert.equal(handle.observedState(), "idle");
    assert.equal(handle.providerContinuationId, "sess-electron-env");
  } finally {
    if (previousElectronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previousElectronRunAsNode;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production Cursor wrapper fences multi-chunk oversized output without buffering it as a live line", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-wrapper-oversized-"));
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(join(root, "npm-cache"), { recursive: true });
    const executable = join(root, "fake-cursor-agent");
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
for (let index = 0; index < 12; index += 1) process.stdout.write("x".repeat(64 * 1024));
process.stdout.write("\\n");
setInterval(() => {}, 1_000);
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      turnStartTimeoutMs: 5_000,
      supervisedProfileFactory: () => ({
        homeDir, configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: homeDir, NPM_CONFIG_CACHE: join(root, "npm-cache") },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    await assert.rejects(
      withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest(), {
        checkpointTurnStarted: async () => {},
        checkpointProviderState: async () => {},
      })),
      /session contract|exited before reporting its stream-json init/,
    );
    assert.equal(handle.observedState(), "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production Cursor wrapper fences aggregate byte and event floods", async () => {
  const floods = [
    {
      name: "aggregate-bytes",
      error: /bounded aggregate stream-json byte budget/,
      source: `const line = "x".repeat(64 * 1024) + "\\n";
for (let index = 0; index < 130; index += 1) process.stdout.write(line);
setInterval(() => {}, 1_000);`,
    },
    {
      name: "event-count",
      error: /bounded stream-json event budget/,
      source: `for (let index = 0; index < 4_100; index += 1) process.stdout.write("x\\n");
setInterval(() => {}, 1_000);`,
    },
    {
      name: "stderr-bytes",
      error: /native process exceeded the supervised stderr byte budget/,
      source: `process.on("SIGTERM", () => process.exit(0));
process.stderr.write("e".repeat(300 * 1024));
setInterval(() => {}, 1_000);`,
    },
  ];
  for (const flood of floods) {
    const root = mkdtempSync(join(tmpdir(), `letagents-cursor-wrapper-${flood.name}-`));
    try {
      const configDir = join(root, "config");
      const homeDir = join(root, "home");
      mkdirSync(configDir, { recursive: true });
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(join(root, "npm-cache"), { recursive: true });
      const executable = join(root, "fake-cursor-agent");
      writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
${flood.source}
`);
      chmodSync(executable, 0o700);
      const adapter = new CursorProviderAdapter({
        cursorBin: executable,
        dependencies: productionPersonalIdentityDependencies,
        turnStartTimeoutMs: 5_000,
        supervisedProfileFactory: () => ({
          homeDir, configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
          env: { HOME: homeDir, NPM_CONFIG_CACHE: join(root, "npm-cache") },
          ...wrapperHostedMcpFixture(root),
        }),
      });
      const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
      await assert.rejects(
        withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest(), {
          checkpointTurnStarted: async () => {},
          checkpointProviderState: async () => {},
        })),
        flood.error,
        flood.name,
      );
      assert.equal(handle.observedState(), "failed", flood.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a transient first-session checkpoint failure recovers the exact terminal without splitting live and durable identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-checkpoint-recovery-"));
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(join(root, "npm-cache"), { recursive: true });
    const executable = join(root, "fake-cursor-agent");
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-checkpoint-real" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "checkpoint recovered", session_id: "sess-checkpoint-real" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir, configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: homeDir, NPM_CONFIG_CACHE: join(root, "npm-cache") },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    let realSessionCheckpoints = 0;
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest(), {
      checkpointTurnStarted: async () => {},
      checkpointProviderState: async (state) => {
        if (state.providerContinuationId === "sess-checkpoint-real") {
          realSessionCheckpoints += 1;
          if (realSessionCheckpoints === 1) {
            // Let the already-emitted result drain so this covers recovery of
            // a terminal first turn, not the separate interrupted-turn case.
            await new Promise((resolve) => setTimeout(resolve, 50));
            throw new Error("transient manifest checkpoint failure");
          }
        }
      },
    }));
    assert.equal(result.text, "checkpoint recovered");
    assert.equal(realSessionCheckpoints, 2, "recovery retries the real session checkpoint exactly once");
    assert.equal(handle.providerContinuationId, "sess-checkpoint-real");
    assert.equal(handle.observedState(), "idle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-init checkpoint recovery prefers a successful result durably captured during TERM teardown", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-checkpoint-term-recovery-"));
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(join(root, "npm-cache"), { recursive: true });
    const executable = join(root, "fake-cursor-agent");
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-term-real" }) + "\\n");
process.once("SIGTERM", () => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "late durable reply", session_id: "sess-term-real" }) + "\\n");
  setTimeout(() => process.exit(0), 5);
});
setInterval(() => {}, 1_000);
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir, configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: homeDir, NPM_CONFIG_CACHE: join(root, "npm-cache") },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    let realSessionCheckpoints = 0;
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest(), {
      checkpointTurnStarted: async () => {},
      checkpointProviderState: async (state) => {
        if (state.providerContinuationId === "sess-term-real") {
          realSessionCheckpoints += 1;
          if (realSessionCheckpoints === 1) throw new Error("transient manifest checkpoint failure");
        }
      },
    }));
    assert.equal(result.text, "late durable reply");
    assert.equal(realSessionCheckpoints, 2);
    assert.equal(handle.providerContinuationId, "sess-term-real");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-init checkpoint recovery terminalizes a trusted durable no-result exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-checkpoint-terminal-"));
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(join(root, "npm-cache"), { recursive: true });
    const executable = join(root, "fake-cursor-agent");
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-checkpoint-terminal" }) + "\\n");
process.once("SIGTERM", () => process.exit(9));
setInterval(() => {}, 1_000);
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir, configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: homeDir, NPM_CONFIG_CACHE: join(root, "npm-cache") },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const terminals: ProviderTerminalPayload[] = [];
    adapter.onExit(handle, (terminal) => terminals.push(terminal));
    let realSessionCheckpoints = 0;
    await assert.rejects(
      withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "checkpoint-terminal" }), {
        checkpointTurnStarted: async () => {},
        checkpointProviderState: async (state) => {
          if (state.providerContinuationId !== "sess-checkpoint-terminal") return;
          realSessionCheckpoints += 1;
          if (realSessionCheckpoints === 1) throw new Error("transient manifest checkpoint failure");
          assert.equal(
            terminals.length,
            0,
            "recovered continuation checkpoints before onExit retires the daemon's live handle",
          );
        },
      })),
      (error: unknown) => (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "terminal_failure",
    );
    assert.equal(realSessionCheckpoints, 2, "terminal recovery still converges the real session checkpoint");
    assert.equal(handle.observedState(), "failed");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]!.terminalCause, "crashed");
    assert.equal(terminals[0]!.exitCode, 9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-init checkpoint failure cannot recover a buffered result without trusted remote-authority evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-checkpoint-no-terminal-"));
  const harness = createHarness({ ownsDescendantReaping: true });
  try {
    const dependencies: CursorProviderAdapterDependencies = {
      ...harness.dependencies,
      prepareTurnState(path) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      },
      launchTurn(input) {
        const child = harness.dependencies.launchTurn(input);
        Object.defineProperty(child, "requiresDurableTerminalEvidence", { value: true });
        return child;
      },
    };
    const adapter = new CursorProviderAdapter({
      dependencies,
      supervisedProfileFactory: (input) => {
        const profileRoot = input.profileRoot ?? root;
        const homeDir = join(profileRoot, "home");
        const configDir = join(profileRoot, "config");
        mkdirSync(homeDir, { recursive: true });
        mkdirSync(configDir, { recursive: true });
        return {
          homeDir,
          configDir,
          dataDir: join(profileRoot, "data"),
          cacheDir: join(profileRoot, "cache"),
          env: { HOME: homeDir, NPM_CONFIG_CACHE: join(profileRoot, "npm-cache") },
          ...(input.inspectionOnly ? {} : wrapperHostedMcpFixture(profileRoot)),
        };
      },
    });
    const handle = await spawnDaemonLane(adapter, harness, daemonSpawnRequest({
      cwd: root,
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    const terminals: ProviderTerminalPayload[] = [];
    adapter.onExit(handle, (terminal) => terminals.push(terminal));
    let realSessionCheckpoints = 0;
    let terminalCheckpoints = 0;
    const pending = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "checkpoint-no-terminal" }), {
      checkpointTurnStarted: async () => {},
      checkpointProviderState: async (state) => {
        if (state.providerContinuationId !== "sess-cursor-1") return;
        realSessionCheckpoints += 1;
        if (realSessionCheckpoints !== 1) return;
        // Buffer a superficially successful result before the transient
        // manifest failure forces teardown. The injected supervised child
        // exits on TERM but deliberately writes no containment terminal,
        // modeling a wrapper lost to forced process-group SIGKILL.
        harness.children[0]!.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "must-not-publish-from-memory",
          session_id: "sess-cursor-1",
        });
        throw new Error("transient manifest checkpoint failure");
      },
      checkpointTerminalResult: async () => { terminalCheckpoints += 1; },
    });

    await assert.rejects(
      withLoopAlive(pending),
      /trusted terminal recovery was unavailable.*no trusted terminal evidence/i,
    );
    assert.equal(realSessionCheckpoints, 1, "untrusted recovery never retries the provider checkpoint");
    assert.equal(terminalCheckpoints, 0, "the buffered result never reaches durable publication");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]!.terminalCause, "protocol_error");
    assert.equal(handle.observedState(), "failed");
    assert.deepEqual(harness.signals, [{ pid: 5200, signal: "SIGTERM" }]);
    assert.equal(existsSync(`${harness.launches[0]!.statePath}.terminal.json`), false);
    assert.deepEqual(
      harness.workspaceGenerationEvents.map((event) => event.kind),
      ["create"],
      "missing containment evidence leaves the writable generation receipt untouched",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon Cursor correction refuses an unjournaled side turn and native resume itself launches no bootstrap", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const request = daemonSpawnRequest();
  const handle = await adapter.resume({
    workAttemptId: request.workAttemptId,
    providerContinuationId: "sess-cursor-existing",
    providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
  }, request);
  assert.equal(harness.launches.length, 0, "successor recovery cannot race an orphan with a bootstrap side turn");
  assert.equal(handle.observedState(), "idle");
  await assert.rejects(
    () => adapter.controlTurn(handle, "Do this instead"),
    /cannot start an unjournaled correction turn/,
  );
  assert.equal(harness.launches.length, 0);

  const turn = adapter.runRoomTurn(handle, roomTurnRequest());
  await flush();
  assert.equal(argValue(harness.launches[0]!.args, "--resume"), "sess-cursor-existing");
  harness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "continued safely", session_id: "sess-cursor-existing",
  });
  harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal((await turn).text, "continued safely");
});

test("daemon Cursor restart-resume preserves exact write authority and sandbox flags", async () => {
  for (const [permissionProfileId, sandbox] of [
    ["sandboxed_write", "enabled"],
    ["full_access", "disabled"],
  ] as const) {
    const harness = createHarness();
    const adapter = supervisedAdapter(harness);
    const request = daemonSpawnRequest({
      workAttemptId: `wa-restart-${permissionProfileId}`,
      permissionProfileId,
      launchPolicy: { force: true, sandbox },
    });
    const handle = await adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: `sess-restart-${permissionProfileId}`,
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    assert.equal(harness.launches.length, 0, "restart recovery stays idle until a journaled inbox turn");

    const turn = adapter.runRoomTurn(handle, roomTurnRequest({
      inboxItemId: `inbox-restart-${permissionProfileId}`,
    }));
    for (let index = 0; index < 100 && !harness.children[0]?.isReleased; index += 1) await flush();
    const launch = harness.launches[0]!;
    assert.equal(argValue(launch.args, "--resume"), `sess-restart-${permissionProfileId}`);
    assert.equal(launch.args.includes("--force"), true);
    assert.equal(argValue(launch.args, "--sandbox"), sandbox);
    assert.equal(launch.mcpRuntimeEnv?.LETAGENTS_PERMISSION_PROFILE_ID, permissionProfileId);
    assert.equal(harness.profilePreparations.at(-1)?.permissionProfileId, permissionProfileId);

    harness.children[0]!.emit({
      type: "result", subtype: "success", is_error: false,
      result: `${permissionProfileId} resumed`, session_id: `sess-restart-${permissionProfileId}`,
    });
    await flush();
    harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await flush();
    assert.equal((await turn).text, `${permissionProfileId} resumed`);
  }
});

test("daemon Cursor rejects missing supervisor coordinates and preserves selected write authority", async () => {
  const missingHarness = createHarness();
  const missingAdapter = supervisedAdapter(missingHarness);
  await assert.rejects(
    () => missingAdapter.spawn(daemonSpawnRequest({ supervisorSocketPath: undefined })),
    /requires exact supervisor coordinates/,
  );
  assert.equal(missingHarness.launches.length, 0);
  await assert.rejects(
    () => missingAdapter.spawn(daemonSpawnRequest({
      workAttemptId: "wa-missing-permission-profile",
      permissionProfileId: null,
    })),
    /requires an exact permission profile/,
  );
  await assert.rejects(
    () => missingAdapter.spawn(daemonSpawnRequest({
      workAttemptId: "wa-unknown-permission-profile",
      permissionProfileId: "unknown" as ProviderSpawnRequest["permissionProfileId"],
    })),
    /Unknown permission profile/,
  );
  await assert.rejects(
    () => missingAdapter.spawn(daemonSpawnRequest({
      workAttemptId: "wa-gated-permission-profile",
      permissionProfileId: "ask_before_write",
    })),
    /not available for cursor/,
  );
  assert.equal(missingHarness.launches.length, 0);

  const readOnlyHarness = createHarness();
  const readOnlyAdapter = supervisedAdapter(readOnlyHarness);
  const readOnlyHandle = await readOnlyAdapter.spawn(daemonSpawnRequest({
    workAttemptId: "wa-read-only-model-collision",
    model: "--sandbox",
  }));
  const readOnlyTurn = readOnlyAdapter.runRoomTurn(readOnlyHandle, roomTurnRequest({
    inboxItemId: "inbox-read-only-model-collision",
  }));
  for (let index = 0; index < 100 && readOnlyHarness.launches.length === 0; index += 1) await flush();
  const readOnlyArgs = readOnlyHarness.launches[0]!.args;
  assert.equal(readOnlyArgs.some((arg, index) => arg === "--sandbox" && readOnlyArgs[index + 1] === "enabled"), true);
  for (let index = 0; index < 100 && !readOnlyHarness.children[0]?.isReleased; index += 1) await flush();
  readOnlyHarness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "read_only completed", session_id: readOnlyHandle.providerContinuationId,
  });
  await flush();
  readOnlyHarness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal((await readOnlyTurn).text, "read_only completed");

  for (const [permissionProfileId, sandbox] of [
    ["sandboxed_write", "enabled"],
    ["full_access", "disabled"],
  ] as const) {
    const harness = createHarness();
    const adapter = supervisedAdapter(harness);
    const handle = await adapter.spawn(daemonSpawnRequest({
      workAttemptId: `wa-${permissionProfileId}`,
      permissionProfileId,
      launchPolicy: { force: true, sandbox },
    }));
    const turn = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: `inbox-${permissionProfileId}` }));
    for (let index = 0; index < 100 && harness.launches.length === 0; index += 1) await flush();
    assert.ok(harness.launches[0]?.args.includes("--force"));
    assert.equal(argValue(harness.launches[0]!.args, "--sandbox"), sandbox);
    assert.match(harness.launches[0]!.args.at(-1) ?? "", /You may edit files and run local commands/);
    if (permissionProfileId === "full_access") {
      assert.match(harness.launches[0]!.args.at(-1) ?? "", /Keep all local changes inside the selected repository\/workspace/);
      assert.doesNotMatch(harness.launches[0]!.args.at(-1) ?? "", /broader local changes/);
    }
    for (let index = 0; index < 100 && !harness.children[0]?.isReleased; index += 1) await flush();
    assert.equal(harness.children[0]?.isReleased, true);
    harness.children[0]!.emit({
      type: "result", subtype: "success", is_error: false,
      result: `${permissionProfileId} completed`, session_id: handle.providerContinuationId,
    });
    await flush();
    harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await flush();
    assert.equal((await turn).text, `${permissionProfileId} completed`);
  }
});

test("a successful result is TURN-terminal: the lane goes idle with NO claimed process and is not attempt-terminal", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  const child = harness.children[0]!;
  child.emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "sess-cursor-1" });
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();

  assert.equal(handle.observedState(), "idle");
  assert.deepEqual(terminals, [], "a finished turn never becomes attempt-terminal evidence");
  // The honest idle cell: no process is claimed between turns.
  assert.equal(handle.pid, null);
  assert.deepEqual(handle.providerConnection, { kind: "cursor_cli", pid: null, processIdentity: null });
  assert.equal(handle.providerContinuationId, "sess-cursor-1", "the session id is the only continuation state");
});

test("a turn child that dies WITHOUT its result event is attempt-terminal (crashed) and attach reports absent", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  harness.identities.set(5200, null);
  harness.children[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]!.terminalCause, "crashed");
  assert.equal(handle.observedState(), "failed");
  assert.equal(await adapter.attach({
    workAttemptId: "wa-cursor-1",
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: { kind: "cursor_cli", pid: 5200, processIdentity: birthIdentity(5200) },
  }), null);
});

test("stop during a live turn orders SIGTERM before the observed terminal and escalates to SIGKILL after grace", async () => {
  const graceful = createHarness();
  const gracefulAdapter = new CursorProviderAdapter({ dependencies: graceful.dependencies, stopGraceMs: 200 });
  const gracefulHandle = await gracefulAdapter.spawn(spawnRequest());
  const stopped = await gracefulAdapter.stop(gracefulHandle);
  assert.deepEqual(graceful.signals.map((entry) => entry.signal), ["SIGTERM"]);
  assert.equal(stopped.terminalCause, "stopped");

  const stubborn = createHarness({ dieOnSigterm: false });
  const stubbornAdapter = new CursorProviderAdapter({ dependencies: stubborn.dependencies, stopGraceMs: 30 });
  const stubbornHandle = await stubbornAdapter.spawn(spawnRequest());
  const killed = await withLoopAlive(stubbornAdapter.stop(stubbornHandle));
  assert.deepEqual(stubborn.signals.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
  assert.equal(killed.terminalCause, "killed");
});

test("live Cursor stop never signals a recycled wrapper PID or process group", async () => {
  const harness = createHarness({ dieOnSigterm: false });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 10 });
  const handle = await adapter.spawn(spawnRequest());
  harness.identities.set(handle.pid!, "unrelated-recycled-birth");

  const stopped = await adapter.stop(handle);

  assert.deepEqual(harness.signals, []);
  assert.equal(stopped.terminalCause, "stopped");
  assert.equal(handle.pid, null);
});

test("stop while idle needs no signal: nothing is running, the attempt ends immediately as stopped", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;
  child.emit({ type: "result", subtype: "success", is_error: false, session_id: "sess-cursor-1" });
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal(handle.observedState(), "idle");

  const stopped = await adapter.stop(handle);
  assert.equal(stopped.terminalCause, "stopped");
  assert.deepEqual(harness.signals, [], "no process existed, so nothing was signalled");
  assert.equal(handle.observedState(), "stopped");
});

test("poke delivers at the boundary: refused mid-turn, runs a --resume turn when idle", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());

  await assert.rejects(adapter.poke(handle, "mid-turn message"), /no channel into a running turn/);

  const first = harness.children[0]!;
  first.emit({ type: "result", subtype: "success", is_error: false, session_id: "sess-cursor-1" });
  first.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal(handle.observedState(), "idle");

  await adapter.poke(handle, "next room event");
  assert.equal(harness.launches.length, 2, "boundary delivery runs a fresh per-turn child");
  const args = harness.launches[1]!.args;
  assert.ok(args.includes("--resume=sess-cursor-1"), "the next turn continues the recorded session without an option-alias ambiguity");
  assert.equal(args[args.length - 1], "next room event");
  assert.equal(handle.observedState(), "working");
  assert.equal(handle.pid, 5201, "the new turn's live pid is claimed while it runs");
});

test("Cursor turn control fences only the live turn child and resumes the same session without attempt terminal", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));
  let exactTurnA = "";

  const result = await withLoopAlive(adapter.controlTurn!(handle, "Apply the corrected direction.", {
    checkpointTurnStarted: async (turnId) => { exactTurnA = turnId; },
    markDispatched: async () => {},
  }));

  assert.deepEqual(result, {
    capability: "restart_resume",
    interrupted: true,
    resumed: true,
    state: "working",
  });
  assert.deepEqual(harness.signals, [{ pid: 5200, signal: "SIGTERM" }]);
  assert.deepEqual(terminals, [], "turn-child interruption never becomes attempt-terminal evidence");
  assert.equal(harness.launches.length, 2);
  assert.ok(harness.launches[1]!.args.includes("--resume=sess-cursor-1"));
  assert.equal(harness.launches[1]!.args.at(-1), "Apply the corrected direction.");
  assert.equal(handle.providerContinuationId, "sess-cursor-1");
  assert.equal(handle.observedState(), "working");
  assert.ok(exactTurnA, "legacy A receives a durable control identity before its signal");

  const staleRetry = await adapter.controlTurn!(handle, null, {
    targetTurnId: exactTurnA,
    checkpointTurnStarted: async () => { throw new Error("retry must not adopt B"); },
    markDispatched: async () => { throw new Error("retry must not signal B"); },
  });
  assert.deepEqual(staleRetry, {
    capability: "restart_resume", interrupted: false, resumed: false, state: "working",
  });
  assert.deepEqual(harness.signals, [{ pid: 5200, signal: "SIGTERM" }], "stale retry leaves successor B untouched");
});

test("resume presents the recorded session and a stranger session id mid-stream is a protocol violation", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.resume(
    { workAttemptId: "wa-cursor-1", providerContinuationId: "sess-old" },
    spawnRequest(),
  );
  assert.ok(harness.launches[0]!.args.includes("--resume=sess-old"));
  assert.equal(handle.providerContinuationId, "sess-old", "the SAME session continues");

  // A stranger session id in the init itself must not silently become the
  // continuation: the launch is REJECTED and the fenced turn child terminated.
  const wrong = createHarness({ sessionId: "sess-stranger" });
  const wrongAdapter = new CursorProviderAdapter({ dependencies: wrong.dependencies });
  await assert.rejects(wrongAdapter.resume(
    { workAttemptId: "wa-cursor-2", providerContinuationId: "sess-old" },
    spawnRequest({ workAttemptId: "wa-cursor-2" }),
  ), /violated the session contract/);
  assert.deepEqual(wrong.signals.map((entry) => entry.signal), ["SIGTERM"], "the mismatched turn child was fenced");
  assert.equal(wrong.children[0]!.alive, false);

  const aliasHarness = createHarness();
  const aliasAdapter = new CursorProviderAdapter({ dependencies: aliasHarness.dependencies });
  await assert.rejects(aliasAdapter.resume(
    { workAttemptId: "wa-cursor-alias", providerContinuationId: "--yolo" },
    spawnRequest({ workAttemptId: "wa-cursor-alias" }),
  ), /not a valid Cursor session identity/);
  assert.equal(aliasHarness.launches.length, 0, "an option-shaped session id never reaches argv");
});

test("startup gates on a valid init, not arbitrary stdout bytes (msg_1758)", async () => {
  // Raw diagnostics BEFORE init are published as evidence but do not start the
  // turn; the handle only returns once init supplies the session identity.
  const harness = createHarness({ silent: true });
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
    turnStartTimeoutMs: 500,
  });
  const spawning = adapter.spawn(spawnRequest());
  await flush();
  const child = harness.children[0]!;
  child.emitRaw("cursor-agent: warming up model cache");
  await flush();
  child.emit({ type: "system", subtype: "init", session_id: "sess-late-init" });
  const handle = await spawning;
  assert.equal(handle.providerContinuationId, "sess-late-init", "init, not raw bytes, supplies the continuation");
  assert.ok(streamEvents.some((event) => event.method === "stdout/raw"), "pre-init diagnostics still published");

  // Raw-only output that never becomes an init times out and fences the child.
  const rawOnly = createHarness({ silent: true });
  const rawOnlyAdapter = new CursorProviderAdapter({ dependencies: rawOnly.dependencies, turnStartTimeoutMs: 60, stopGraceMs: 30 });
  const rawSpawning = rawOnlyAdapter.spawn(spawnRequest({ workAttemptId: "wa-cursor-7" }));
  rawSpawning.catch(() => {});
  await flush();
  rawOnly.children[0]!.emitRaw("just noise, never an init");
  await assert.rejects(rawSpawning, /no stream-json init within the startup bound/);
  assert.equal(rawOnly.children[0]!.alive, false, "the unobservable child was terminated and awaited");
});

test("only a genuine system/init with a session id satisfies readiness — other system events do not (msg_1807)", async () => {
  const harness = createHarness({ silent: true });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, turnStartTimeoutMs: 500 });
  const spawning = adapter.spawn(spawnRequest());
  await flush();
  const child = harness.children[0]!;

  // A non-init system event — even one carrying a session id — must not start
  // the turn or become the continuation identity for readiness.
  child.emit({ type: "system", subtype: "status", session_id: "sess-early" });
  await flush();

  child.emit({ type: "system", subtype: "init", session_id: "sess-real-init" });
  const handle = await spawning;
  assert.equal(handle.observedState(), "working", "readiness resolved only after the real init");
  assert.equal(handle.providerContinuationId, "sess-real-init");
});

test("an init that carries no session id is fenced immediately as a session-contract violation (msg_1807)", async () => {
  const harness = createHarness({ silent: true });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, turnStartTimeoutMs: 500 });
  const spawning = adapter.spawn(spawnRequest());
  spawning.catch(() => {});
  await flush();
  harness.children[0]!.emit({ type: "system", subtype: "init" });
  await assert.rejects(spawning, /violated the session contract/);
  assert.deepEqual(harness.signals.map((entry) => entry.signal), ["SIGTERM"], "the sessionless child was fenced, not awaited to timeout");
  assert.equal(harness.children[0]!.alive, false);
});

test("a late Cursor protocol callback never signals a recycled wrapper PID", async () => {
  const harness = createHarness({ silent: true, dieOnSigterm: false });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, turnStartTimeoutMs: 500 });
  const spawning = adapter.spawn(spawnRequest());
  spawning.catch(() => {});
  await flush();
  harness.identities.set(5200, "unrelated-recycled-birth");

  harness.children[0]!.emit({ type: "system", subtype: "init" });

  assert.deepEqual(harness.signals, [], "the late stream callback is fenced by exact process birth");
  harness.children[0]!.resolveExit({ type: "exit", code: 1, signal: null });
  await assert.rejects(spawning, /violated the session contract/);
});

test("a child that exits before init rejects the launch and records terminal evidence", async () => {
  const harness = createHarness({ silent: true });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, turnStartTimeoutMs: 500 });
  const spawning = adapter.spawn(spawnRequest());
  spawning.catch(() => {});
  await flush();
  harness.identities.set(5200, null);
  harness.children[0]!.resolveExit({ type: "exit", code: 1, signal: null });
  await assert.rejects(spawning, /exited before reporting its stream-json init/);
});

test("a streaming-but-quiet turn stays working; a completely silent turn is fenced with no orphan", async () => {
  const streaming = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: streaming.dependencies, turnStartTimeoutMs: 40 });
  const handle = await adapter.spawn(spawnRequest());
  await flush();
  await flush();
  assert.equal(handle.observedState(), "working", "long quiet turns are not dead");
  assert.equal(streaming.signals.length, 0);

  const silent = createHarness({ silent: true });
  const silentAdapter = new CursorProviderAdapter({ dependencies: silent.dependencies, turnStartTimeoutMs: 40, stopGraceMs: 30 });
  await assert.rejects(silentAdapter.spawn(spawnRequest({ workAttemptId: "wa-cursor-3" })), /no stream-json init within the startup bound/);
  assert.equal(silent.children[0]!.alive, false, "the unobservable child was terminated and awaited");
});

test("post-release Cursor startup cleanup never signals a recycled wrapper PID", async () => {
  const harness = createHarness({ silent: true, dieOnSigterm: false });
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    turnStartTimeoutMs: 30,
    stopGraceMs: 10,
  });
  const spawning = adapter.spawn(spawnRequest());
  spawning.catch(() => {});
  await flush();
  harness.identities.set(5200, "unrelated-recycled-birth");

  await assert.rejects(spawning, /no stream-json init within the startup bound/);
  assert.deepEqual(harness.signals, [], "timeout cleanup revalidates the exact process birth before TERM");
});

test("a recycled pid can neither authenticate an attach nor be signalled; unverifiable identity stays ambiguous", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  harness.identities.set(7777, "some-other-birth");
  assert.equal(await adapter.attach({
    workAttemptId: "wa-x",
    providerContinuationId: "sess-x",
    providerConnection: { kind: "cursor_cli", pid: 7777, processIdentity: "recorded-birth" },
  }), null, "recorded turn child proven absent");
  assert.deepEqual(harness.signals, [], "the recycled pid was never signalled");

  harness.identities.set(8888, undefined);
  await assert.rejects(adapter.attach({
    workAttemptId: "wa-y",
    providerContinuationId: "sess-y",
    providerConnection: { kind: "cursor_cli", pid: 8888, processIdentity: "birth-y" },
  }), /ambiguous/);

  // An idle lane records no pid: its absence is exact, not ambiguous.
  assert.equal(await adapter.attach({
    workAttemptId: "wa-z",
    providerContinuationId: "sess-z",
    providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
  }), null);
});

test("attach to a live checkpointed Cursor wrapper returns promptly without signalling or launching beside it", async () => {
  const harness = createHarness({ dieOnSigterm: false });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 30 });
  const handle = await adapter.spawn(spawnRequest());

  const fresh = new CursorProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 30 });
  await assert.rejects(fresh.attach({
    workAttemptId: "wa-cursor-1",
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: { kind: "cursor_cli", pid: 5200, processIdentity: birthIdentity(5200) },
  }), /still running/);
  assert.deepEqual(harness.signals, [], "a successor never interrupts the exact checkpointed writer");
  harness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "durably completed", session_id: handle.providerContinuationId,
  });
  harness.identities.set(5200, null);
  harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  const attached = await fresh.attach({
    workAttemptId: "wa-cursor-1",
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: { kind: "cursor_cli", pid: 5200, processIdentity: birthIdentity(5200) },
  });

  assert.equal(attached, null, "after natural terminal evidence, the lane is provably absent for bounded resume");
  assert.deepEqual(harness.signals, []);
  assert.equal(harness.launches.length, 1, "attach never launches a second writer");
});

test("exact-reference stop signals only the verified Cursor wrapper birth", async () => {
  const harness = createHarness();
  const fresh = new CursorProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 100 });
  harness.identities.set(6100, birthIdentity(6100));
  const exact = fresh.stopRef!({
    workAttemptId: "wa-stop-ref",
    providerContinuationId: "sess-stop-ref",
    providerConnection: { kind: "cursor_cli", pid: 6100, processIdentity: birthIdentity(6100) },
  });
  await flush();
  harness.identities.set(6100, null);
  const terminal = await exact;
  assert.equal(terminal.terminalCause, "stopped");
  assert.deepEqual(harness.signals, [{ pid: 6100, signal: "SIGTERM" }]);

  harness.identities.set(6200, "reused-birth");
  await fresh.stopRef!({
    workAttemptId: "wa-reused-ref",
    providerContinuationId: "sess-reused-ref",
    providerConnection: { kind: "cursor_cli", pid: 6200, processIdentity: "recorded-birth" },
  });
  assert.equal(harness.signals.some((entry) => entry.pid === 6200), false, "a recycled pid is never signalled");
});

test("a result line delivered after exit resolution still counts: the lane goes idle, never falsely terminal (msg_1780)", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  // Simulate the drain race: exit evidence resolves first, the buffered final
  // result line lands one microtask later (as a still-flushing pipe would).
  const child = harness.children[0]!;
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await Promise.resolve();
  child.emit({ type: "result", subtype: "success", is_error: false, session_id: "sess-cursor-1" });
  await flush();

  assert.deepEqual(terminals, [], "a cleanly completed turn is never misread as a crash");
  assert.equal(handle.observedState(), "idle");
});

test("the proven usage-limit signature classifies as provider_quota, not crashed (msg_1708)", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  // init + user emitted normally, then the stream stops with NO result, the
  // ActionRequiredError lands on stderr, and the process exits 1.
  const child = harness.children[0]!;
  child.emit({ type: "user", session_id: "sess-cursor-1" });
  child.stderr = "ActionRequiredError: You've hit your usage limit. Switch to a different model or set a Spend Limit.";
  child.resolveExit({ type: "exit", code: 1, signal: null });
  await flush();

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]!.terminalCause, "provider_quota", "an account condition is never recorded as a crash");
  assert.equal(terminals[0]!.exitCode, 1);
  assert.equal(handle.observedState(), "failed");

  // The same no-result death WITHOUT the quota signature stays a crash.
  const crash = createHarness();
  const crashAdapter = new CursorProviderAdapter({ dependencies: crash.dependencies });
  const crashHandle = await crashAdapter.spawn(spawnRequest({ workAttemptId: "wa-cursor-9" }));
  const crashTerminals: ProviderTerminalPayload[] = [];
  crashAdapter.onExit(crashHandle, (terminal) => crashTerminals.push(terminal));
  crash.children[0]!.stderr = "segfault or something else entirely";
  crash.children[0]!.resolveExit({ type: "exit", code: 1, signal: null });
  await flush();
  assert.equal(crashTerminals[0]!.terminalCause, "crashed");
});

test("stream evidence is bounded, redacted, and ordered; non-JSON output keeps method identity", async () => {
  const harness = createHarness();
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
  });
  await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;

  child.emit({ type: "assistant", session_id: "sess-cursor-1", message: { role: "assistant", content: [{ type: "text", text: "hi room" }] }, api_key: "sk-nope" });
  child.emit({ type: "system", subtype: "init", session_id: "sess-cursor-1" });
  child.emitRaw("cursor-agent plain diagnostics line");
  await flush();

  const assistant = streamEvents.find((event) => event.method === "assistant");
  assert.ok(assistant);
  assert.equal(assistant!.payloadRedacted, true);
  assert.equal((assistant!.payload as { api_key?: unknown }).api_key, "[REDACTED]");
  const display = streamEvents.find((event) => event.method === "item/agentMessage/delta");
  assert.equal((display?.payload as { delta?: unknown } | undefined)?.delta, "hi room");
  assert.match(String((display?.payload as { partId?: unknown } | undefined)?.partId), /^cursor:[0-9a-f-]+:assistant:\d+$/);
  assert.ok(streamEvents.some((event) => event.method === "stdout/raw"), "non-JSON output preserved as bounded evidence");
  assert.equal(streamEvents.filter((event) => event.method === "system/init_duplicate").length, 1,
    "a duplicate same-session init remains diagnostics and cannot reset the display generation");
  const sequences = streamEvents.map((event) => event.sequence);
  assert.deepEqual([...sequences].sort((a, b) => a - b), sequences, "stream sequence is ordered");
});

test("a Cursor result terminalizes any tool card that never emitted its own completion", async () => {
  const harness = createHarness();
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
  });
  await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;
  child.emit({
    type: "tool_call", subtype: "started", call_id: "tool-open",
    tool_call: { readToolCall: { args: { path: "README.md" } } },
    session_id: "sess-cursor-1",
  });
  child.emit({
    type: "result", subtype: "success", is_error: false, result: "done",
    session_id: "sess-cursor-1",
  });
  await flush();
  const toolStatuses = streamEvents
    .filter((event) => event.method === "item/toolCall/updated")
    .map((event) => (event.payload as { status?: unknown }).status);
  assert.deepEqual(toolStatuses, ["running", "interrupted"]);
});

test("a Cursor turn that exits without result still terminalizes every running tool card", async () => {
  const harness = createHarness();
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
  });
  await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;
  child.emit({
    type: "tool_call", subtype: "started", call_id: "tool-no-result",
    tool_call: { shellToolCall: { args: { command: "false" } } },
    session_id: "sess-cursor-1",
  });
  child.resolveExit({ type: "exit", code: 1, signal: null });
  await flush();
  const toolStatuses = streamEvents
    .filter((event) => event.method === "item/toolCall/updated")
    .map((event) => (event.payload as { status?: unknown }).status);
  assert.deepEqual(toolStatuses, ["running", "interrupted"],
    "a result-less crash cannot leave a cross-turn Inspector card stuck running");
});

test("a post-init provider checkpoint failure terminalizes tools started while the checkpoint was pending", async () => {
  const harness = createHarness();
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
    supervisedProfileFactory: (input) => {
      const root = input.profileRoot ?? `/private/cursor/${input.workAttemptId}`;
      return {
        homeDir: `${root}/home`, configDir: `${root}/config`, dataDir: `${root}/data`, cacheDir: `${root}/cache`,
        env: { HOME: `${root}/home` },
        ...wrapperHostedMcpFixture(root),
      };
    },
  });
  const handle = await spawnDaemonLane(adapter, harness);
  await assert.rejects(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "checkpoint-tool-terminal" }), {
    checkpointTurnStarted: async () => {},
    checkpointProviderState: async (state) => {
      if (state.providerContinuationId !== "sess-cursor-1") return;
      harness.children[0]!.emit({
        type: "tool_call", subtype: "started", call_id: "tool-during-checkpoint",
        tool_call: { readToolCall: { args: { path: "README.md" } } },
        session_id: "sess-cursor-1",
      });
      throw new Error("injected post-init checkpoint failure");
    },
  }), /checkpoint.*failure/i);
  const toolStatuses = streamEvents
    .filter((event) => event.method === "item/toolCall/updated")
    .map((event) => (event.payload as { status?: unknown }).status);
  assert.deepEqual(toolStatuses, ["running", "interrupted"],
    "checkpoint teardown cannot strand a running tool outside completeTurn");
});

test("documented Cursor stream-json shapes project to namespaced response and tool display events", () => {
  assert.deepEqual(cursorLiveDisplayProjections({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Checking " }, { type: "text", text: "now" }] },
    session_id: "session-exact",
  }, "turn-exact", "event-1"), [
    { method: "item/agentMessage/delta", kind: "text_delta", payload: { partId: "cursor:turn-exact:assistant:event-1", delta: "Checking now" } },
  ]);
  assert.deepEqual(cursorLiveDisplayProjections({
    type: "assistant", message: { role: "assistant", content: "String-shaped reply" }, session_id: "session-exact",
  }, "turn-exact", "event-string"), [{
    method: "item/agentMessage/delta", kind: "text_delta",
    payload: { partId: "cursor:turn-exact:assistant:event-string", delta: "String-shaped reply" },
  }]);
  assert.deepEqual(cursorLiveDisplayProjections({
    type: "tool_call", subtype: "started", call_id: "toolu_1",
    tool_call: { metadata: { durationMs: 12 }, readToolCall: { args: { path: "README.md" } } }, session_id: "session-exact",
  }, "turn-exact", "event-2"), [{
    method: "item/toolCall/updated", kind: "tool_lifecycle", payload: {
      callID: "cursor:turn-exact:toolu_1", tool: "readToolCall", status: "running",
      input: { path: "README.md" }, output: null, error: null,
    },
  }]);
  assert.deepEqual(cursorLiveDisplayProjections({
    type: "tool_call", subtype: "completed", call_id: "toolu_1",
    tool_call: { readToolCall: { args: { path: "README.md" }, result: { success: { totalLines: 54 } } } },
    session_id: "session-exact",
  }, "turn-exact", "event-3"), [{
    method: "item/toolCall/updated", kind: "tool_lifecycle", payload: {
      callID: "cursor:turn-exact:toolu_1", tool: "readToolCall", status: "completed",
      input: { path: "README.md" }, output: { totalLines: 54 }, error: null,
    },
  }]);
  assert.deepEqual(cursorLiveDisplayProjections({
    type: "user", message: { role: "user", content: [{ type: "text", text: "prompt echo" }] },
  }, "turn-exact", "event-4"), [], "the user event is never misrendered as a tool");
});

test("Cursor typed observations fence each native child and exclude synthetic display completion", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const events: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, () => { throw new Error("observer unavailable"); });
  adapter.onExecution(handle, (event) => events.push(event));
  assert.deepEqual(await adapter.probeControl(handle), { state: "unprobeable" });
  assert.deepEqual(adapter.capabilities().execution, {
    controlProbe: "unsupported", approvals: { kinds: [], recovery: "unsupported", denyScope: "unsupported" },
  });
  assert.equal(events.length, 0, "an idle lane neither replays nor invents a process");
  const first = adapter.runRoomTurn(handle, roomTurnRequest());
  await flush();
  const child = harness.children[0]!;
  const session_id = "sess-cursor-1";
  const started = { type: "tool_call", subtype: "started", call_id: "same-call", session_id,
    tool_call: { readToolCall: { args: { path: "secret-path" } } } };
  child.emit(started);
  child.emit(started);
  child.emit({ ...started, call_id: "missing-session", session_id: undefined });
  child.emit({ type: "tool_call", subtype: "completed", call_id: "same-call", session_id,
    tool_call: { readToolCall: { result: { failure: { errorMessage: "secret-output" } } } } });
  child.emit({ type: "tool_call", subtype: "started", call_id: "unclosed-write", session_id,
    tool_call: { writeToolCall: { args: { path: "secret-path", fileText: "secret-content" } } } });
  assert.deepEqual(await adapter.probeControl(handle), { state: "unprobeable" }, "live output does not imply a responsive control channel");
  child.emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id });
  assert.equal(events.filter((event) => event.fact.domain === "execution"
    && event.fact.executionId === "unclosed-write" && event.fact.kind === "completed").length, 0,
  "a display-only interrupted card cannot become native interruption evidence");
  child.resolveExit({ type: "exit", code: 0, signal: null });
  assert.equal((await first).text, "done");
  await flush();
  assert.equal(handle.observedState(), "idle");
  const second = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "second" }));
  await flush();
  const nextChild = harness.children[1]!;
  nextChild.emit(started);
  nextChild.emit({ type: "tool_call", subtype: "completed", call_id: "same-call", session_id,
    tool_call: { readToolCall: { result: { success: { content: "secret-output" } } } } });
  nextChild.emit({ type: "result", subtype: "success", is_error: false, result: "next", session_id });
  nextChild.resolveExit({ type: "exit", code: 0, signal: null });
  assert.equal((await second).text, "next");
  await flush();
  const runtimes = new Map<string, ReturnType<typeof emptyExecutionProjection>>();
  for (const event of events) {
    assert.ok(event.nativeProcessIdentity);
    const runtimeId = event.nativeProcessIdentity!;
    runtimes.set(runtimeId, reduceExecutionFact(runtimes.get(runtimeId) ?? emptyExecutionProjection(), {
      ...event.fact, ...("providerTurnId" in event.fact ? { turnId: event.fact.providerTurnId } : {}),
      factId: `fact-${event.sequence}`, agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: runtimeId,
      observerEpoch: 1, sourceSequence: event.sequence, observedAtMs: event.observedAtMs,
    }));
  }
  assert.equal(runtimes.size, 2, "sequential child births cannot share runtime authority");
  const firstTurn = [...runtimes.get(birthIdentity(child.pid!))!.turns.values()][0]!;
  const nextTurn = [...runtimes.get(birthIdentity(nextChild.pid!))!.turns.values()][0]!;
  assert.equal(firstTurn.operations.get("same-call")?.outcome, "failed");
  assert.equal(firstTurn.operations.get("same-call")?.startObserved, false);
  assert.equal(firstTurn.operations.has("unclosed-write"), false, "a tool request without a native result has no proven execution");
  assert.equal(nextTurn.operations.get("same-call")?.outcome, "succeeded");
  assert.notEqual(firstTurn.providerTurnId, nextTurn.providerTurnId);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.doesNotMatch(JSON.stringify(events), /secret-path|secret-content|secret-output/);
  assert.deepEqual(harness.signals, []);
});

test("Cursor typed child loss differs from an exact user interruption", async () => {
  for (const interrupted of [false, true]) {
    const harness = createHarness();
    const adapter = supervisedAdapter(harness);
    const handle = await spawnDaemonLane(adapter, harness);
    const events: NativeExecutionObservation[] = [];
    adapter.onExecution(handle, (event) => events.push(event));
    const running = adapter.runRoomTurn(handle, roomTurnRequest());
    const rejected = assert.rejects(running);
    await flush();
    const child = harness.children[0]!;
    child.emit({ type: "tool_call", subtype: "started", call_id: "shell", session_id: "sess-cursor-1",
      tool_call: { shellToolCall: { args: { command: "slow-command" } } } });
    if (interrupted) await adapter.controlTurn(handle);
    else child.resolveExit({ type: "exit", code: 1, signal: null });
    await rejected;
    await flush();
    assert.equal(events.filter((event) => event.fact.domain === "execution").length, 0,
      "a pending tool request cannot become lost_after_start or interrupted_after_start without start proof");
    const terminal = events.find((event) => event.fact.domain === "turn" && event.fact.state !== "active")?.fact;
    assert.ok(terminal && "state" in terminal);
    assert.equal(terminal.state, interrupted ? "terminal" : "lost");
    if (!interrupted) assert.deepEqual(harness.signals, []);
  }
});

test("Cursor typed shell completion preserves native exit codes and does not complete a background handoff", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const events: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => events.push(event));
  const running = adapter.runRoomTurn(handle, roomTurnRequest());
  await flush();
  const child = harness.children[0]!;
  const session_id = "sess-cursor-1";
  for (const [call_id, result] of [
    ["zero", { success: { exitCode: 0, stdout: "secret-output" } }],
    ["nonzero", { failure: { exitCode: 2, stderr: "secret-output" } }],
    ["nonzero-success-envelope", { success: { exitCode: 1 } }],
    ["rejected", { rejected: { reason: "secret-reason" } }],
    ["permission-denied", { permissionDenied: { error: "secret-error" } }],
    ["spawn-failed", { spawnError: { error: "secret-error" } }],
    ["malformed", { success: { exitCode: "0" } }],
    ["background", { success: { exitCode: 0, shellId: 7 }, isBackground: true }],
  ] as const) {
    child.emit({ type: "tool_call", subtype: "started", call_id, session_id,
      tool_call: { shellToolCall: { args: { command: "secret-command" } } } });
    child.emit({ type: "tool_call", subtype: "completed", call_id, session_id,
      tool_call: { shellToolCall: { result } } });
  }
  const completions = events.map(({ fact }) => fact).filter((fact) => fact.domain === "execution" && fact.kind === "completed");
  assert.deepEqual(completions.map((fact) => ({ id: fact.executionId, outcome: fact.outcome, exitCode: fact.exitCode })), [
    { id: "zero", outcome: "succeeded", exitCode: 0 },
    { id: "nonzero", outcome: "failed", exitCode: 2 },
    { id: "nonzero-success-envelope", outcome: "failed", exitCode: 1 },
    { id: "rejected", outcome: "denied_before_start", exitCode: undefined },
    { id: "permission-denied", outcome: "denied_before_start", exitCode: undefined },
    { id: "spawn-failed", outcome: "failed", exitCode: undefined },
  ]);
  for (const fact of completions.filter((fact) => ["rejected", "permission-denied", "spawn-failed"].includes(fact.executionId))) {
    assert.equal(fact.sideEffects, "none");
  }
  child.emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id });
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await running;
  await flush();
  assert.equal(events.filter(({ fact }) => fact.domain === "execution" && fact.kind === "completed" && fact.executionId === "zero").length, 1,
    "an observed successful command must not later become lost at child exit");
  assert.equal(events.filter(({ fact }) => fact.domain === "execution" && ["malformed", "background"].includes(fact.executionId)).length, 0);
  assert.doesNotMatch(JSON.stringify(events), /secret-command|secret-output|secret-reason|secret-error/);
  assert.deepEqual(harness.signals, [], "a nonzero shell exit cannot signal the provider");
});
