// Shared fixtures for the cursor-provider-adapter tests, split out of
// cursor-provider-adapter.test.ts. It is not a test file: the *.test.ts glob does not match it.
import "./isolated-home.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CursorProviderAdapter,
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
} from "../main/agents/provider-adapter.js";
import type { ProviderProcessExit } from "../main/agents/provider-evidence.js";
import { cursorSupervisedMcpServerName, type CursorManagedProfile } from "../main/agents/cursor-managed-profile.js";
import { LETAGENTS_MCP_RUNTIME_VERSION } from "../main/agents/letagents-mcp-runtime.js";
import { CURSOR_MCP_CONNECTOR_PARENT } from "../main/agents/cursor-provider-constants.js";
import { cursorMcpPipeConnectorArgs } from "../main/agents/cursor/windows-turn.js";
import { testDaemonEndpoint, writeFakeProvider } from "./platform.js";

/** Where Cursor's private folders go: /tmp on POSIX (the sandbox profile names it), the temporary folder on Windows. */
export const cursorTmp = CURSOR_MCP_CONNECTOR_PARENT;
/** A path ends with `tail`, written with forward slashes whatever this platform's separator. */
export const endsWithPath = (path: string, tail: string): boolean => path.replaceAll("\\", "/").endsWith(tail);
/** The working folder of the harness's spawn requests, spelled for this platform. */
export const WA_CURSOR_CWD = join(cursorTmp, "wa-cursor-1");

export const { emptyExecutionProjection, reduceExecutionFact } = await import(new URL("../../daemon/execution-reducer.ts", import.meta.url).href);

export const previousNonDarwinOverride = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
if (process.platform !== "darwin") process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
test.after(() => {
  if (previousNonDarwinOverride === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previousNonDarwinOverride;
});

// Fake per-turn child harness proving the P2b adapter honors the #765
// invariants under Cursor's one-child-per-turn model: honest idle-between-turns
// (never a claimed live process), turn-terminal vs attempt-terminal evidence,
// boundary delivery, and the recycled-pid / ambiguity / no-orphan rules.

export class FakeCursorChild implements CursorCliChild {
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

export interface HarnessOptions {
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

/**
 * Windows: Cursor starts inside letagents-process-tree.exe's job. CI builds
 * the helper outside its default path and names it in
 * LETAGENTS_TEST_PROCESS_TREE_HELPER, so only the Cursor files that import this
 * fixture use it (each test file runs in its own process).
 */
function useTestProcessTreeHelper(): void {
  const helper = process.env.LETAGENTS_TEST_PROCESS_TREE_HELPER;
  if (process.platform === "win32" && helper && !process.env.LETAGENTS_PROCESS_TREE_HELPER) {
    process.env.LETAGENTS_PROCESS_TREE_HELPER = helper;
  }
}
useTestProcessTreeHelper();

export function birthIdentity(pid: number): string {
  return `fake-cursor-${pid}-birth-1`;
}

export function argValue(args: string[], flag: string): string | null {
  const assigned = args.find((arg) => arg.startsWith(`${flag}=`));
  if (assigned) return assigned.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1]! : null;
}

export function initializeGitWorkspace(workspace: string): void {
  mkdirSync(workspace, { recursive: true });
  assert.equal(spawnSync("git", ["init", "--quiet", workspace]).status, 0);
  assert.equal(spawnSync("git", [
    "-c", "user.name=Cursor Test",
    "-c", "user.email=cursor@example.test",
    "-C", workspace,
    "commit", "--quiet", "--allow-empty", "-m", "workspace seed",
  ]).status, 0);
}

export const productionPersonalIdentityDependencies: Partial<CursorProviderAdapterDependencies> = {
  attestPersonalIdentity: async () => ({
    userId: 12345,
    email: "personal@example.test",
    providerAuthorization: "Bearer test-provider-authorization",
  }),
  bindPersonalIdentity: () => {},
};

export function wrapperHostedMcpFixture(
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
          // Windows: the wrapper listens on a named pipe, which only the product's own pipe connector can open.
          args: process.platform === "win32" ? cursorMcpPipeConnectorArgs(mcpConnectorSocketPath) : ["-e", connectorSource, mcpConnectorSocketPath],
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

export function cursorConversationStoreFixtureSource(sessionId: string): string {
  return `{
    const fs = require("node:fs");
    const path = require("node:path");
    process.chdir(process.argv[process.argv.indexOf("--workspace") + 1]);
    const hash = require("node:crypto").createHash("md5").update(path.resolve(process.cwd())).digest("hex");
    const store = path.join(process.env.CURSOR_CONFIG_DIR, "chats", hash, ${JSON.stringify(sessionId)}, "store.db");
    const resume = process.argv.find((arg) => arg.startsWith("--resume="));
    if (resume && (resume !== "--resume=" + ${JSON.stringify(sessionId)} || !fs.existsSync(store))) {
      throw new Error("The original conversation is missing in this workspace");
    }
    const previous = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : { context: "original conversation", turns: 0 };
    if (previous.context !== "original conversation") throw new Error("Conversation context was replaced");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ ...previous, turns: previous.turns + 1 }));
  }`;
}

export const cursorMcpAttestationFixtureSource = `
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
export function materializeAttestableMcpRuntime(dir: string): string {
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

export function wrapperMcpRuntimeEnv(connectorRoot: string, turnId: string): Record<string, string> {
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

export function createHarness(options: HarnessOptions = {}) {
  const children: FakeCursorChild[] = [];
  const launches: Array<Parameters<CursorProviderAdapterDependencies["launchTurn"]>[0]> = [];
  const profilePreparations: Array<{
    workAttemptId: string;
    cwd: string;
    apiBaseUrl: string;
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
  const generations = new Map<string, Awaited<ReturnType<CursorProviderAdapterDependencies["createWorkspaceGeneration"]>>>();
  const identities = options.identities ?? new Map<number, string | null | undefined>();
  let nextPid = 5200;
  let mintedSessions = 0;

  const dependencies: CursorProviderAdapterDependencies = {
    readUsageOwner: () => null,
    readUsageContext: () => null,
    readUsageAccount: async () => ({ state: "unavailable", windows: [] }),
    relocateConversationNamespace() {},
    async openWorkspaceGeneration(path) {
      const generation = generations.get(path);
      if (!generation) throw new Error("Unexpected generation reopen in fixture");
      return generation;
    },
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
      const manifestPath = join(cursorTmp, `letagents-test-generation-${createHash("sha256").update(input.turnIdentity).digest("hex")}.json`);
      const generation = {
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
      generations.set(manifestPath, generation);
      return generation;
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

export function spawnRequest(over: Partial<ProviderSpawnRequest> = {}): ProviderSpawnRequest {
  return {
    workAttemptId: "wa-cursor-1",
    roomId: "github.com/example/repo",
    agentDisplayName: "TidalHare",
    cwd: WA_CURSOR_CWD,
    launchPolicy: { mode: "ask", sandbox: "enabled" },
    ...over,
  };
}

export function daemonSpawnRequest(over: Partial<ProviderSpawnRequest> = {}): ProviderSpawnRequest {
  return spawnRequest({
    deliveryMode: "daemon_inbox",
    workspaceKind: "git_worktree",
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

export function supervisedAdapter(harness: ReturnType<typeof createHarness>, stopGraceMs?: number): CursorProviderAdapter {
  return new CursorProviderAdapter({
    dependencies: harness.dependencies,
    ...(stopGraceMs === undefined ? {} : { stopGraceMs }),
    supervisedProfileFactory: (input) => {
      harness.profilePreparations.push(input);
      const { workAttemptId, profileRoot } = input;
      const root = profileRoot ?? `/private/cursor/${workAttemptId}`;
      const runtime = input.mcpConnectorSocketPath ? wrapperHostedMcpFixture(root) : {};
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
          ...runtime,
          ...(runtime.mcpRuntimeEnv ? { mcpRuntimeEnv: { ...runtime.mcpRuntimeEnv, LETAGENTS_API_URL: input.apiBaseUrl } } : {}),
        }),
        mcpServerName: cursorSupervisedMcpServerName(workAttemptId),
      };
    },
  });
}

export async function spawnDaemonLane(
  adapter: CursorProviderAdapter,
  _harness: ReturnType<typeof createHarness>,
  request = daemonSpawnRequest(),
): Promise<ProviderHandle> {
  return adapter.spawn(request);
}

export function roomTurnRequest(over: Partial<{
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

export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

export async function waitForPath(path: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await flush();
  return existsSync(path);
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  // Native preparation includes async filesystem work. A 10 ms flush cannot
  // prove the child exists or that checkpoints and stream listeners are ready.
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await flush();
  assert.equal(predicate(), true, "condition did not become true before the wait deadline");
}

export const loopKeepAlives = new Set<ReturnType<typeof setInterval>>();
test.afterEach(() => {
  // A failed assertion can abandon the turn before withLoopAlive settles.
  for (const keepAlive of loopKeepAlives) clearInterval(keepAlive);
  loopKeepAlives.clear();
});

export async function withLoopAlive<T>(work: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 20);
  loopKeepAlives.add(keepAlive);
  try {
    return await work;
  } finally {
    clearInterval(keepAlive);
    loopKeepAlives.delete(keepAlive);
  }
}

export async function verifyMcpConnectorRetirement(slowMembershipProbe = false, gracefulDescendant = false): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-connector-e2e-"));
  const workspace = join(root, "workspace");
  const sourceHome = join(root, "source-home");
  const statePath = join(root, "state", "mcp-state.json");
  const runtimePackage = join(root, "runtime", "node_modules", "letagents");
  const runtimeEntry = join(runtimePackage, "dist", "mcp", "server.js");
  const runtimePidPath = join(root, "runtime.pid");
  const runtimeDescendantPidPath = join(root, "runtime-descendant.pid");
  const preloadPath = join(root, "slow-membership-preload.cjs");
  const managedProfileRoot = join(
    dirname(statePath),
    "cursor-supervised",
    createHash("sha256").update("wa-cursor-connector-e2e").digest("hex").slice(0, 32),
  );
  const stubbornModePath = join(managedProfileRoot, "tmp", "stubborn-native-mode");
  const stubbornPidPath = join(managedProfileRoot, "tmp", "stubborn-native.pid");
  let cursorBin = join(root, "fake-cursor-agent");
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
process.on("SIGTERM", () => { if (${gracefulDescendant}) process.exit(0); });
setInterval(() => {}, 1000);
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`
process.on("SIGTERM", () => { ${gracefulDescendant ? "setTimeout(() => process.exit(0), 700);" : ""} });
setInterval(() => {}, 1000);
process.send("ready");
`)}, ${JSON.stringify(runtimeEntry)}], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
const descendantReady = new Promise((resolve) => descendant.once("message", () => { descendant.disconnect(); resolve(); }));
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
lines.on("line", async (line) => {
  await descendantReady;
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
  cursorBin = writeFakeProvider(cursorBin, `const fs = require("node:fs");
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
// Windows: the connector gets the named pipe, then its proof file and the pipe addon (cursorMcpPipeConnectorArgs).
const socketPath = process.platform === "win32" ? server.args[2] : server.args[server.args.length - 1];
const connector = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
note("connector-spawned:" + connector.pid);
const lines = readline.createInterface({ input: connector.stdout });
let initialized = false;
let listed = false;
let largeResponse = false;
let secondBlocked = false;
let replayProbeStarted = false;
let finished = false;
function startReplayProbe() {
  if (replayProbeStarted) return;
  replayProbeStarted = true;
  const second = net.createConnection({ path: socketPath });
  let accepted = false;
  second.once("connect", () => { accepted = true; second.write("replay"); });
  second.once("error", () => { secondBlocked = true; finishIfReady(); });
  second.once("close", () => { if (accepted) { secondBlocked = true; finishIfReady(); } });
}
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
  startReplayProbe();
  finishIfReady();
});
connector.once("error", () => process.exit(72));
connector.once("close", (code, signal) => note("connector-close:" + code + ":" + signal));
connector.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }) + "\\n");
connector.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\\n");
connector.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "fixture/large", params: {} }) + "\\n");
setTimeout(() => process.exit(73), 5000).unref();
`);
  chmodSync(cursorBin, 0o700);

  writeFileSync(preloadPath, `
const fs = require("node:fs");
const childProcess = require("node:child_process");
const originalSpawnSync = childProcess.spawnSync;
// The fault injection belongs to the wrapper, outside the native sandbox.
delete process.env.NODE_OPTIONS;
childProcess.spawnSync = function(command, args, options) {
  if (command === "/bin/ps" && args[0] === "-axo" && args[1] === "pid=,pgid=") {
    let runtimeAlive = false;
    try {
      const pid = Number(fs.readFileSync(${JSON.stringify(runtimePidPath)}, "utf8"));
      process.kill(pid, 0);
      runtimeAlive = true;
    } catch {}
    if (runtimeAlive) return {
      status: null, stdout: "", stderr: "",
      error: Object.assign(new Error("slow process-table scan"), { code: "ETIMEDOUT" }),
    };
  }
  return originalSpawnSync.call(this, command, args, options);
};
`);

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
          return defaultLaunchTurn(slowMembershipProbe ? {
            ...input, env: { ...input.env, NODE_OPTIONS: `--require=${preloadPath}` },
          } : input);
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
    // The folder the launch made, not dirname of what the fake reports: on Windows that is a pipe name.
    assert.equal(existsSync(connectorRoots[0]!), false, "fresh-turn connector root is removed at terminal");
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
    assert.equal(existsSync(connectorRoots[1]!), false, "resume connector root is removed at terminal");
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
    for (const pid of [thirdRuntimePid, thirdRuntimeDescendantPid, stubbornPid]) {
      await waitFor(() => {
        try { process.kill(pid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      });
    }
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
    if (existsSync(runtimePidPath)) {
      const pid = Number(readFileSync(runtimePidPath, "utf8"));
      const observed = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8", timeout: 1_000 });
      const member = (observed.stdout ?? "").split("\n").some((line) => {
        const fields = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        return fields && Number(fields[2]) === pid && fields[3]!.split(/\s+/).includes(runtimeEntry);
      });
      if (Number.isSafeInteger(pid) && pid > 1 && member) {
        try { process.kill(-pid, "SIGKILL"); } catch {}
      }
    }
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
}

export async function verifyMcpRuntimeSignalFence(probeMode: "recycled" | "absent" | "ambiguous_identity" | "ambiguous_kill_identity" | "ambiguous_group"
  | "group_timeout_then_empty" | "group_timeout_always" | "group_alive"): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-runtime-recycled-group-"));
  const statePath = join(root, "turn.jsonl");
  let cursorBin = join(root, "fake-cursor-agent");
  const preloadPath = join(root, "recycled-group-preload.cjs");
  const runtimePidPath = join(root, "runtime.pid");
  const preloadLoadedPath = join(root, "preload-loaded.log");
  const initialIdentityPath = join(root, "initial-identity.log");
  const identityProbePath = join(root, "identity-probe.log");
  const groupSignalPath = join(root, "group-signal.log");
  const ambiguousProbePath = join(root, "ambiguous-probe.log");
  const laterProbePath = join(root, "later-probe.log");
  const groupTimeoutsPath = join(root, "group-probe-timeouts.log");
  const connectorRoot = join(cursorTmp, `letagents-cursor-mcp-${randomUUID()}`);
  const connectorSocketPath = join(connectorRoot, "stdio.sock");
  const runtimeDataRoot = mkdtempSync(join(cursorTmp, "letagents-cursor-data-"));
  writeFileSync(statePath, "");
  const hostedMcp = wrapperHostedMcpFixture(root, connectorSocketPath, "valid", true);
  const runtimeEntryPath = hostedMcp.mcpRuntimeEntryPath!;
  writeFileSync(runtimeEntryPath, `
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(runtimePidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
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
  // Invalid startup contracts take the repeated finishNotStarted cleanup path.
  if (request.method === "tools/list") result.tools = [];
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  if (request.method === "tools/list") setTimeout(() => process.exit(0), 1_500);
});
`);
  writeFileSync(preloadPath, `
const fs = require("node:fs");
const childProcess = require("node:child_process");
const originalSpawnSync = childProcess.spawnSync;
const originalKill = process.kill.bind(process);
fs.appendFileSync(${JSON.stringify(preloadLoadedPath)}, String(process.pid) + "\\n");
let exactIdentityReads = 0;
let capturedIdentity;
let ambiguousGroupProbes = 0;
let groupProbeCalls = 0;
const probeMode = ${JSON.stringify(probeMode)};
const groupMode = probeMode.startsWith("group_");
const retryIdentity = probeMode === "ambiguous_identity" || probeMode === "ambiguous_kill_identity" || groupMode;
function ambiguousProbe() {
  fs.writeFileSync(${JSON.stringify(ambiguousProbePath)}, fs.existsSync(${JSON.stringify(groupSignalPath)})
    ? fs.readFileSync(${JSON.stringify(groupSignalPath)}, "utf8") : "");
  return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("probe timed out"), { code: "ETIMEDOUT" }) };
}
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
      capturedIdentity = observed;
      fs.writeFileSync(${JSON.stringify(initialIdentityPath)}, JSON.stringify({
        args, status: observed.status, stdout: observed.stdout, error: observed.error && observed.error.message,
      }));
      return observed;
    }
    if (probeMode === "ambiguous_identity" && exactIdentityReads === 2) return ambiguousProbe();
    if (probeMode === "ambiguous_kill_identity" && exactIdentityReads === 3) return ambiguousProbe();
    if (exactIdentityReads > 2 || retryIdentity || probeMode === "ambiguous_group") {
      fs.appendFileSync(${JSON.stringify(laterProbePath)}, "identity\\n");
      return capturedIdentity;
    }
    const pid = Number(args[args.indexOf("-p") + 1]);
    fs.appendFileSync(${JSON.stringify(identityProbePath)}, "recycled\\n");
    if (probeMode === "absent") return { status: 1, stdout: "", stderr: "" };
    return {
      pid: 0,
      output: [null, pid + " " + process.pid + " " + pid + " Thu Jan  1 00:00:00 1970\\n", ""],
      stdout: pid + " " + process.pid + " " + pid + " Thu Jan  1 00:00:00 1970\\n",
      stderr: "",
      status: 0,
      signal: null,
    };
  }
  if (command === "/bin/ps" && Array.isArray(args)
    && args[0] === "-axo" && args[1] === "pid=,pgid=") {
    const pid = runtimePid();
    if (pid && groupMode) {
      // Record the bound each attempt of the wrapper's group probe was given.
      fs.appendFileSync(${JSON.stringify(groupTimeoutsPath)}, String(options && options.timeout) + "\\n");
      groupProbeCalls += 1;
      if (probeMode === "group_timeout_always" || (probeMode === "group_timeout_then_empty" && groupProbeCalls === 1)) {
        return ambiguousProbe();
      }
      const observed = originalSpawnSync.call(this, command, args, options);
      if (probeMode === "group_timeout_then_empty") return observed;
      const stdout = String(observed.stdout || "") + String(pid + 100000) + " " + String(pid) + "\\n";
      return { pid: 0, output: [null, stdout, observed.stderr || ""], stdout, stderr: observed.stderr || "", status: observed.status, signal: observed.signal };
    }
    if (pid && !retryIdentity) {
      // A timeout that outlasts the wrapper's whole retry budget loses group continuity.
      if (probeMode === "ambiguous_group" && ambiguousGroupProbes < 3) {
        ambiguousGroupProbes += 1;
        return ambiguousProbe();
      }
      fs.appendFileSync(${JSON.stringify(laterProbePath)}, "group\\n");
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
    if (!retryIdentity) return true;
  }
  return originalKill(target, signal);
};
`);
  cursorBin = writeFakeProvider(cursorBin, `const args = process.argv.slice(2);
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
    assert.equal(terminal.type, "not_started", "the invalid contract exercises cleanup before and after startup settles");
    const signals = existsSync(groupSignalPath) ? readFileSync(groupSignalPath, "utf8").trim().split("\n") : [];
    if (probeMode.startsWith("group_")) {
      const bounds = readFileSync(groupTimeoutsPath, "utf8").trim().split("\n");
      if (probeMode === "group_timeout_then_empty") {
        assert.deepEqual(bounds.slice(0, 2), ["250", "1000"], "a timed-out probe is retried at once with a longer bound");
        assert.deepEqual(terminal.remote_authority_failed_checks, [], "a retried probe that answers proves the group closed");
      } else if (probeMode === "group_timeout_always") {
        assert.ok(bounds.length >= 3 && bounds.length % 3 === 0
          && bounds.every((bound, index) => bound === (index % 3 === 0 ? "250" : "1000")),
        `every probe is tried three times, then reported unknown: ${bounds.join(",")}`);
        assert.deepEqual(terminal.remote_authority_failed_checks, ["mcp_runtime_group"]);
      } else {
        assert.ok(bounds.length >= 1 && bounds.every((bound) => bound === "250"), "a definite answer is never retried");
        assert.deepEqual(terminal.remote_authority_failed_checks, ["mcp_runtime_group"]);
      }
    } else if (probeMode === "recycled" || probeMode === "absent") {
      assert.equal(existsSync(identityProbePath), true, "retirement observes that the original group leader birth changed");
      assert.equal(existsSync(groupSignalPath), false, "the recycled numeric PGID receives neither TERM nor KILL");
      assert.equal(existsSync(laterProbePath), true, "cleanup continues probing group absence without restoring signal authority");
    } else {
      assert.equal(existsSync(ambiguousProbePath), true, "retirement encounters the injected probe timeout");
      assert.equal(existsSync(laterProbePath), true, "retirement probes again after the timeout");
      if (probeMode === "ambiguous_group") {
        assert.equal(signals[0], "SIGTERM");
        assert.ok(signals.length <= 2 && signals.slice(1).every((signal) => signal === "SIGKILL"));
        assert.equal(readFileSync(groupSignalPath, "utf8"), readFileSync(ambiguousProbePath, "utf8"),
          "cleanup retries cannot signal after losing group continuity, regardless of earlier escalation");
      } else {
        assert.deepEqual(signals, ["SIGTERM", "SIGKILL"], "a fresh matching identity permits the timed-out signal to retry");
      }
    }
    assert.equal(terminal.remote_authority_revoked,
      probeMode === "ambiguous_identity" || probeMode === "ambiguous_kill_identity" || probeMode === "group_timeout_then_empty",
      "only successful retirement of a freshly verified runtime proves revoked authority");
  } finally {
    if (child?.pid) {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
    }
    rmSync(connectorRoot, { recursive: true, force: true });
    rmSync(runtimeDataRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

// Cursor's headless worker spawns a helper that binds a private stdio socket
// under its per-turn CURSOR_DATA_DIR. A unix-socket listen() is network-inbound;
// an absolute inbound deny EPERMs that bind and the worker dies before the MCP
// client ever connects. These launch a real sandboxed wrapper whose fake
// cursor-agent binds a socket inside its data dir (must succeed) and inside a
// path that is file-writable but outside the socket namespace (must stay
// denied), so the guard fails if the inbound exception is removed or widened.
export async function runSupervisedWorkerSocketProbe(options: {
  label: string;
  dataRoot: string;
  outsideRoot: string;
  probeBeforeBindMs?: number;
}): Promise<{ inside: string; outside: string; stderrTail: string }> {
  const root = mkdtempSync(join(tmpdir(), `letagents-cursor-worker-sock-${options.label}-`));
  const statePath = join(root, "turn.jsonl");
  let cursorBin = join(root, "fake-cursor-agent");
  const connectorRoot = join(cursorTmp, `letagents-cursor-mcp-${randomUUID()}`);
  const connectorSocketPath = join(connectorRoot, "stdio.sock");
  const sockprobePath = join(root, "sockprobe.json");
  writeFileSync(statePath, "");
  const hostedMcp = wrapperHostedMcpFixture(root, connectorSocketPath, "valid", true);
  const runtimeEntryPath = hostedMcp.mcpRuntimeEntryPath!;
  cursorBin = writeFakeProvider(cursorBin, `const args = process.argv.slice(2);
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

/**
 * Run one writable supervised turn whose live stream reports a successful
 * result, then let the wrapper publish `terminalFor(launch)` as its durable
 * terminal. The checkpoint callback answers as the daemon does for a settled
 * Cursor ending: cleanup of recovery evidence is allowed.
 */
export async function runTurnWithWrapperTerminal(
  inboxItemId: string,
  terminalFor: (launch: { statePath?: string; workspaceGenerationManifestPath?: string }) => Record<string, unknown>,
  liveResult: string | null = "reply that must not be published",
  permissionProfileId: "read_only" | "sandboxed_write" = "sandboxed_write",
) {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-unproven-authority-"));
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
    const streamEvents: ProviderStreamEvent[] = [];
    const adapter = new CursorProviderAdapter({
      dependencies,
      streamSink: (event) => streamEvents.push(event),
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
      permissionProfileId,
      launchPolicy: permissionProfileId === "read_only" ? { mode: "ask", force: false } : { force: true, sandbox: "enabled" },
    }));
    const terminals: ProviderTerminalPayload[] = [];
    adapter.onExit(handle, (terminal) => terminals.push(terminal));
    const checkpointed: ProviderRoomTurnResult[] = [];
    const pending = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId }), {
      checkpointTerminalResult: async (result) => {
        checkpointed.push(result);
        return { acceptedResult: result, cleanupRecoveryEvidence: true };
      },
    });
    for (let index = 0; index < 100 && harness.children.length === 0; index += 1) await flush();
    const child = harness.children[0]!;
    for (let index = 0; index < 100 && !child.isReleased; index += 1) await flush();
    if (liveResult !== null) {
      child.emit({
        type: "result", subtype: "success", is_error: false,
        result: liveResult, session_id: "sess-cursor-1",
      });
    }
    const launch = harness.launches[0]!;
    writeFileSync(`${launch.statePath}.terminal.json`, JSON.stringify(terminalFor(launch)));
    child.resolveExit({ type: "exit", code: 1, signal: null });
    const outcome = await withLoopAlive(pending).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    return { ...outcome, harness, handle, terminals, checkpointed, streamEvents, terminalEvidenceKept: existsSync(`${launch.statePath}.terminal.json`) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A wrapper terminal that is sound in every way except the remote-authority proof. */
export function unprovenAuthorityTerminal(
  launch: { workspaceGenerationManifestPath?: string },
  over: Record<string, unknown> = {},
  resultText = "reply that must not be published",
): Record<string, unknown> {
  return {
    type: "exit",
    code: 0,
    signal: null,
    native_process_group_reaped: true,
    reap_scope: "native_process_group",
    remote_authority_revoked: false,
    turn_contract_version: 1,
    session_contract_valid: true,
    stream_contract_complete: true,
    workspace_generation_manifest_path: launch.workspaceGenerationManifestPath,
    init: { type: "system", subtype: "init", session_id: "sess-cursor-1" },
    result: {
      type: "result", subtype: "success", is_error: false,
      result: resultText, session_id: "sess-cursor-1", request_id: null,
    },
    ...over,
  };
}

/**
 * A real daemon supervising one Cursor agent: the real adapter, action router,
 * delivery, execution capture and stores, over the fake wrapper harness. Only
 * the room, the server and the processes are doubles.
 */
export async function cursorDaemonFixture() {
  const { SupervisorDaemon } = await import(new URL("../../daemon/main.ts", import.meta.url).href);
  const { WorkDurabilityStore } = await import(new URL("../../daemon/durability-store.ts", import.meta.url).href);
  const { DAEMON_PROTOCOL_VERSION } = await import(new URL("../../daemon/types.ts", import.meta.url).href);
  const { ProviderActionPortRouter } = await import(new URL("../../daemon/provider-action-port-router.ts", import.meta.url).href);
  const { connectDaemon } = await import(new URL("../../../../shared/daemon-endpoint.mjs", import.meta.url).href);
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const root = realpathSync(await mkdtemp(join(tmpdir(), "cursor-daemon-")));
  const id = "cursor_agent";
  const paths = {
    lockPath: join(root, "daemon.lock"), ...testDaemonEndpoint(root),
    manifestPath: join(root, "daemon-state.sqlite"), auditPath: join(root, "audit.jsonl"),
    attemptsPath: join(root, "attempts.json"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root,
  };
  const request = (method: string, params?: unknown) => new Promise<{ ok: boolean; result?: any; error?: string }>((resolveRequest, reject) => {
    const socket = connectDaemon(paths.socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer | string) => {
      received += chunk;
      if (!received.includes("\n")) return;
      socket.end();
      resolveRequest(JSON.parse(received.slice(0, received.indexOf("\n"))));
    });
    socket.on("connect", () => socket.write(`${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: "test", method, params })}\n`));
  });
  const eventually = async (check: () => Promise<boolean> | boolean, label: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!await check()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((wake) => setTimeout(wake, 10));
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

  const harness = createHarness();
  /** The agent's profile, where its wrapper writes each turn's durable terminal; every adapter of the agent reads it there. */
  const profileRoot = join(root, "profile");
  const configDir = join(profileRoot, "config");
  mkdirSync(configDir, { recursive: true });
  /** What the daemon asked of the adapter's reading back of a saved turn. */
  const recovery = { requests: [] as Array<Record<string, unknown>> };
  const makeAdapter = () => {
    const adapter = new CursorProviderAdapter({
      dependencies: { ...harness.dependencies, now: () => new Date().toISOString() },
      supervisedProfileFactory: (input) => {
        const base = input.profileRoot ?? profileRoot;
        return {
          homeDir: join(base, "home"), configDir: join(base, "config"), dataDir: join(base, "data"), cacheDir: join(base, "cache"),
          env: { HOME: join(base, "home"), CURSOR_CONFIG_DIR: join(base, "config", "cursor") },
          ...(input.inspectionOnly ? {} : {
            mcpRuntimeEntryPath: "/Applications/LetAgents.app/runtime/letagents/server.js",
            mcpRuntimeReadRoots: ["/Applications/LetAgents.app/runtime/letagents"],
            mcpRuntimeEnv: { ELECTRON_RUN_AS_NODE: "1", LETAGENTS_API_URL: input.apiBaseUrl, HOME: join(base, "bridge-home") },
          }),
          mcpServerName: cursorSupervisedMcpServerName(input.workAttemptId),
        };
      },
    });
    const recover = adapter.recoverRoomTurn.bind(adapter);
    adapter.recoverRoomTurn = async (handle, turn, options) => {
      recovery.requests.push({ ...turn });
      return recover(handle, turn, options);
    };
    return adapter;
  };
  let adapter = makeAdapter();
  const roomMessages: Array<Record<string, unknown>> = [];
  const published: string[] = [];
  let mints = 0;
  const makeDaemon = () => new SupervisorDaemon(paths, "darwin", new ProviderActionPortRouter({ cursor: async () => adapter }), true,
    50, undefined, {}, {
      poll: async ({ afterMessageId, signal }: { afterMessageId: string | null; signal: AbortSignal }) => {
        const from = afterMessageId ? roomMessages.findIndex((message) => message.id === afterMessageId) + 1 : 0;
        if (roomMessages.length > from) return { messages: roomMessages.slice(from) };
        await new Promise<void>((wake) => {
          const timer = setTimeout(wake, 20);
          signal.addEventListener("abort", () => { clearTimeout(timer); wake(); }, { once: true });
        });
        return { messages: [] };
      },
      publish: async (input: { text: string; roomId: string }) => {
        published.push(input.text);
        return { messageId: `msg_${900 + published.length}`, roomId: input.roomId };
      },
    }, {
      listWorkLeases: async () => [], readWorkLease: async () => null,
      attestWorkLease: async () => { throw new Error("unused"); },
      rebindWorkLease: async () => { throw new Error("unused"); },
      createWorkerSession: async () => {
        mints += 1;
        return { sessionId: `${id}-session`, bearer: `${id}-bearer-${mints}`, bearerId: `${id}-bearer-id-${mints}`,
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() };
      },
    });
  let daemon = makeDaemon();
  const read = <T>(sql: string): T[] => {
    const database = new DatabaseSync(paths.manifestPath, { readOnly: true });
    try { return database.prepare(sql).all(id).map((row) => ({ ...row })) as T[]; } finally { database.close(); }
  };
  const cleanup = async () => {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  };
  type Receipt = { source_message_id: string; state: string; last_error: string | null; provider_turn_id: string | null };
  const inbox = () => (daemon as unknown as { supervisedInbox: {
    bootstrapCursor(input: { agent_id: string; room_id: string; last_observed_message_id: string | null }): Promise<unknown>;
    receipts(agentId: string): Promise<Receipt[]>;
    prepareEffect(input: Record<string, unknown>): Promise<{ effect: { state: string } }>;
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
      id, room_id: "room_1", display_name: "Agent", provider: "cursor", model: null, charter: "test",
      desired_state: "running", observed_state: "absent", condition: "none", permission_profile_id: "read_only",
      created_by: "test", created_at: "2026-01-01T00:00:00.000Z", delivery_mode: "daemon_inbox",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    await inbox().bootstrapCursor({ agent_id: id, room_id: "room_1", last_observed_message_id: null });
    await installGrant();
    const view = async () => (await request("manifest.list")).result[0] as {
      observed_state: string; condition: string; last_error: string | null;
      room_agent_state: { ingress: { state: string }; inbox: { state: string; detail: string | null } };
    };
    await eventually(async () => (await view())?.room_agent_state?.ingress.state === "observing", "the agent listens to its room");
    const receipt = async (messageId: string) => (await inbox().receipts(id)).find((item) => item.source_message_id === messageId);
    /** Send the agent its nth room message and wait until that turn's wrapper is released. */
    const begin = async (ordinal: number) => {
      roomMessages.push({ id: `msg_${ordinal}`, sender: "someone", text: `request ${ordinal}`, activation: { for_current_agent: { decision: "activate" } } });
      await eventually(async () => harness.children[ordinal - 1]?.isReleased === true && Boolean((await receipt(`msg_${ordinal}`))?.provider_turn_id),
        `msg_${ordinal} starts its turn`).catch(async (error) => {
        const current = await view();
        throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error}); inbox ${current.room_agent_state.inbox.state} (${current.room_agent_state.inbox.detail})`);
      });
      return { child: harness.children[ordinal - 1]!, id: (await receipt(`msg_${ordinal}`))!.provider_turn_id! };
    };
    const sessionId = "sess-cursor-1";
    return { harness, eventually, view, published, receipt, begin, cleanup, recovery, sessionId,
      /** The agent completes its room turn with this answer, through complete_room_turn. */
      complete: async (turnId: string, text: string) => {
        const [binding] = read<{ work_attempt_id: string; origin_execution_generation_id: string; provider_continuation_id: string }>(
          `SELECT work_attempt_id,origin_execution_generation_id,provider_continuation_id FROM supervised_agent_provider_turn_bindings
            WHERE agent_id=? AND provider_turn_id=${JSON.stringify(turnId).replaceAll('"', "'")}`);
        const prepared = await inbox().prepareEffect({ agent_id: id, room_id: "room_1", execution_generation_id: binding!.origin_execution_generation_id,
          provider_turn_id: turnId, work_attempt_id: binding!.work_attempt_id, current_execution_generation_id: binding!.origin_execution_generation_id,
          provider_continuation_id: binding!.provider_continuation_id, mcp_request_id: `complete:${turnId}`, tool_name: "complete_room_turn",
          request: { outcome: "reply", text }, mutation: true });
        assert.equal(prepared.effect.state, "completed");
      },
      /** The wrapper writes the exact durable terminal of this turn, as it does once its native process group is reaped. */
      writeTerminal: (turnId: string, result: Record<string, unknown>) => {
        const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
        writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
          type: "exit", code: 0, signal: null,
          native_process_group_reaped: true, reap_scope: "native_process_group", remote_authority_revoked: true,
          session_contract_valid: true, stream_contract_complete: true, turn_contract_version: 1,
          init: { type: "system", subtype: "init", session_id: sessionId }, result,
        }));
      },
      /** This turn's wrapper ends now. */
      exitChild: (child: FakeCursorChild) => {
        harness.identities.set(child.pid!, null);
        child.resolveExit({ type: "exit", code: 0, signal: null });
      },
      /** The daemon ends and a new one, with a new adapter, takes the agent over. */
      restartDaemon: async () => {
        await daemon.stop();
        adapter = makeAdapter();
        daemon = makeDaemon();
        await (await startDaemon())();
      },
      /** The agent's execution record: its turns, recovery boundaries, and whether its observer has a gap. */
      recorded: () => ({
        turns: read<{ provider_turn_id: string; state: string }>("SELECT provider_turn_id,state FROM execution_turns WHERE agent_id=? ORDER BY created_at_ms,rowid"),
        boundaries: read<{ phase: string }>("SELECT phase FROM agent_runtime_recoveries WHERE agent_id=?").map((row) => row.phase),
        gaps: read<{ last: number; max: number }>("SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")
          .filter((observer) => observer.max !== observer.last).length,
      }) };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function stagedImageAttachments(folder: string) {
  return [
    { index: 1, fileName: "screen.png", mimeType: "image/png", sizeBytes: 12, status: "image" as const,
      image: { mimeType: "image/png" as const, path: join(folder, "1.png") } },
    { index: 2, fileName: "notes.pdf", mimeType: "application/pdf", sizeBytes: 5, status: "cannot_read_pdf" as const, category: "file" as const },
  ];
}
