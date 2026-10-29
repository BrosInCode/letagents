import { rmSync } from "node:fs";
import { dirname } from "node:path";

import { spawnTree, windowsCommandLine } from "../../../../../../shared/process-tree.mjs";

import type { ProviderProcessExit } from "../provider-evidence.js";
import {
  CURSOR_LIVE_MCP_CAPABILITY_TIMEOUT_MS,
  CURSOR_SUPERVISED_AGENT_ENDPOINT,
  MAX_CURSOR_STREAM_LINE_BYTES,
} from "../cursor-provider-constants.js";
import { safeCursorTerminalErrorDetail } from "../cursor-provider-evidence.js";
import {
  cursorOsSandbox,
  cursorSandboxDelegatingExecutablePaths,
  cursorSandboxPathVariants,
  cursorSandboxRuntimeReadSubpaths,
  cursorTemporaryRoot,
  escapeCursorSandboxRegex,
  isExactCursorLoopbackTestOrigin,
  prepareCursorResumeOwnershipLock,
  validateCursorSandboxPaths,
  validateCursorSandboxRegexes,
} from "../cursor-sandbox-policy.js";
import { cursorWrapperMcpSource } from "./turn-wrapper-mcp.js";
import { cursorWrapperProxySource } from "./turn-wrapper-proxies.js";
import { cursorWrapperSetupSource, type CursorWrapperLaunchValues } from "./turn-wrapper-setup.js";
import { cursorWrapperStartSource } from "./turn-wrapper-start.js";
import {
  assertCursorWindowsCommandLines,
  cursorMcpConnectorListenPath,
  cursorWindowsNativeLaunch,
  cursorWrapperProgramBootstrap,
  prepareCursorWindowsConnectorRoot,
  rememberCursorWrapperForStop,
  writeCursorWrapperProgram,
  type CursorWindowsTurnValues,
} from "./windows-turn.js";

export interface CursorCliChild {
  pid: number | null;
  exited: Promise<ProviderProcessExit>;
  /** Positive native spawn failure before any child process was acquired. */
  didNotSpawn?(): boolean;
  /** Ordered stdout stream-json lines (raw, one JSON document per line). */
  onLine(listener: (line: string) => void): () => void;
  /** Bounded stderr tail — the provider-quota signature lives here (msg_1708). */
  stderrTail(): string;
  /** Trusted wrapper IPC detail for a failure that may prevent journal publication. */
  terminalError?(): string | null;
  /** Release a prepared wrapper only after its exact process identity is durable. */
  release(): void;
  /** Production wrappers resolve only after their journal and IPC handlers exist. */
  prepared?: Promise<void>;
  /** The wrapper proves retirement of its own native process group; filesystem authority is separate. */
  ownsDescendantReaping?: boolean;
  /** Production wrappers require their remote-authority journal before a live result is trusted. */
  requiresDurableTerminalEvidence?: boolean;
}

/**
 * The wrapper program: the cursor/turn-wrapper-*.ts slices, joined in order.
 * `platform` picks the Windows-only text; the macOS program does not change.
 */
export function cursorTurnWrapperSource(
  values: CursorWrapperLaunchValues,
  platform: NodeJS.Platform = process.platform,
): string {
  return String.raw`
${cursorWrapperSetupSource(values, platform)}${cursorWrapperMcpSource(platform)}${cursorWrapperProxySource()}${cursorWrapperStartSource(cursorOsSandbox(platform))}`;
}

/**
 * v10 §3: the child sees the user's own environment; nothing is scrubbed or
 * curated here. This deliberately DIVERGES from
 * CURSOR_CHILD_ENV_ALLOWLIST (cursor-runner.ts), which is a LetAgents-imposed
 * curation of exactly the kind v10 prohibits. If TrailDelta's task_38 spike
 * proves a real launch blocker (a CLAUDECODE-analogue), add that single
 * documented carve-out — not an allowlist.
 */
export function cursorCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base };
}

export function defaultLaunchTurn(input: {
  cursorBin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  deferStart?: boolean;
  statePath?: string;
  workspaceGenerationManifestPath?: string;
  deniedReadPaths?: string[];
  deniedReadSubpaths?: string[];
  deniedReadMetadataPaths?: string[];
  deniedReadWriteRegexes?: string[];
  deniedWriteRegexes?: string[];
  deniedWritePaths?: string[];
  deniedWriteStructuralPaths?: string[];
  deniedWriteSubpaths?: string[];
  deniedExecSubpaths?: string[];
  allowedWriteSubpaths?: string[];
  allowedReadSubpaths?: string[];
  allowedNetworkUnixSockets?: string[];
  /**
   * Directory roots under which the sandboxed agent may bind AND connect its
   * own private unix sockets (Cursor's headless worker IPC). Scoped to the
   * per-turn CURSOR_DATA_DIR so the inbound-bind allowance can never reach a
   * shared or ambient socket path.
   */
  allowedInternalUnixSocketRoots?: string[];
  mcpConnectorSocketPath?: string;
  mcpRuntimeEntryPath?: string;
  mcpRuntimeCwd?: string;
  mcpRuntimeEnv?: Readonly<Record<string, string>>;
  providerAuthorization?: string;
  restrictRemoteAuthority?: boolean;
  /** Attested Full access profile: retain turn supervision without an OS sandbox. */
  fullAccess?: boolean;
  /** Exact continuation already held by the supervised adapter, never a prompt value. */
  nativeResumeSessionId?: string;
  /** Injectable only through direct unit tests; adapter production never sets it. */
  testAgentUpstreamEndpoint?: string;
  /** Injectable only through direct unit tests; adapter production never sets it. */
  testControlPlaneUpstreamEndpoint?: string;
  /** Injectable only through direct loopback unit tests; adapter production never sets it. */
  testMcpCapabilityTimeoutMs?: number;
  /** Injectable only through direct unit tests; adapter production never sets it. */
  testStartupBarrier?: {
    path: string;
    stage: "mcp_listen" | "authority_listen" | "agent_listen";
  };
}): CursorCliChild {
  // Windows: no operating-system sandbox, so none of the sandbox lists below
  // reach the wrapper there (see cursorOsSandbox).
  const windows = cursorOsSandbox() === "windows-unsandboxed";
  const deniedDelegatingExecutablePaths = cursorSandboxDelegatingExecutablePaths();
  const deniedReadPaths = validateCursorSandboxPaths(input.deniedReadPaths);
  const deniedReadSubpaths = validateCursorSandboxPaths(input.deniedReadSubpaths);
  const deniedReadMetadataPaths = validateCursorSandboxPaths(input.deniedReadMetadataPaths);
  const deniedReadWriteRegexes = validateCursorSandboxRegexes(input.deniedReadWriteRegexes);
  const deniedWriteRegexes = validateCursorSandboxRegexes(input.deniedWriteRegexes);
  const deniedWritePaths = validateCursorSandboxPaths(input.deniedWritePaths);
  const deniedWriteStructuralPaths = validateCursorSandboxPaths(input.deniedWriteStructuralPaths);
  const deniedWriteSubpaths = validateCursorSandboxPaths(input.deniedWriteSubpaths);
  const deniedExecSubpaths = validateCursorSandboxPaths(input.deniedExecSubpaths);
  const allowedWriteSubpaths = validateCursorSandboxPaths(input.allowedWriteSubpaths);
  const allowedReadSubpaths = input.allowedReadSubpaths?.length
    ? validateCursorSandboxPaths([
      ...input.allowedReadSubpaths,
      ...(windows ? [] : cursorSandboxRuntimeReadSubpaths(input.cursorBin, input.cwd, input.env ?? process.env)),
    ])
    : [];
  const allowedNetworkUnixSockets = validateCursorSandboxPaths(
    (input.allowedNetworkUnixSockets ?? []).flatMap(cursorSandboxPathVariants),
  );
  const allowedInternalUnixSocketRoots = validateCursorSandboxPaths(
    (input.allowedInternalUnixSocketRoots ?? []).flatMap(cursorSandboxPathVariants),
  );
  if (input.statePath && !windows) {
    const streamPaths = validateCursorSandboxPaths(
      cursorSandboxPathVariants(input.statePath),
    );
    const terminalPaths = validateCursorSandboxPaths(
      cursorSandboxPathVariants(`${input.statePath}.terminal.json`),
    );
    deniedReadPaths.push(...streamPaths, ...terminalPaths);
    deniedWritePaths.push(...streamPaths, ...terminalPaths);
    deniedReadWriteRegexes.push(...terminalPaths.map((terminalPath) =>
      `^${escapeCursorSandboxRegex(terminalPath)}[.]tmp-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$`
    ));
  }
  const restrictRemoteAuthority = input.restrictRemoteAuthority === true;
  const providerAuthorization = input.providerAuthorization;
  const agentUpstreamEndpoint = input.testAgentUpstreamEndpoint ?? CURSOR_SUPERVISED_AGENT_ENDPOINT;
  const controlPlaneUpstreamEndpoint = input.testControlPlaneUpstreamEndpoint ?? "https://api2.cursor.sh";
  if (agentUpstreamEndpoint !== CURSOR_SUPERVISED_AGENT_ENDPOINT
    && !isExactCursorLoopbackTestOrigin(agentUpstreamEndpoint)) {
    throw new Error("Cursor's supervised agent upstream test seam requires an exact loopback HTTP/2 origin.");
  }
  if (controlPlaneUpstreamEndpoint !== "https://api2.cursor.sh"
    && !isExactCursorLoopbackTestOrigin(controlPlaneUpstreamEndpoint)) {
    throw new Error("Cursor's supervised control-plane upstream test seam requires an exact loopback HTTP origin.");
  }
  const testStartupBarrier = input.testStartupBarrier;
  if (testStartupBarrier && (
    !restrictRemoteAuthority
    || !input.testAgentUpstreamEndpoint
    || !input.testControlPlaneUpstreamEndpoint
    || !isExactCursorLoopbackTestOrigin(input.testAgentUpstreamEndpoint)
    || !isExactCursorLoopbackTestOrigin(input.testControlPlaneUpstreamEndpoint)
    || !/^(?:\/private)?\/tmp\/letagents-cursor-startup-barrier-[A-Za-z0-9]{6,64}\/(?:mcp_listen|authority_listen|agent_listen)$/.test(testStartupBarrier.path)
    || !testStartupBarrier.path.endsWith(`/${testStartupBarrier.stage}`)
  )) {
    throw new Error("Cursor's startup barrier is restricted to exact loopback unit tests.");
  }
  const testMcpCapabilityTimeoutMs = input.testMcpCapabilityTimeoutMs;
  if (testMcpCapabilityTimeoutMs !== undefined && (
    !restrictRemoteAuthority
    || !input.testAgentUpstreamEndpoint
    || !input.testControlPlaneUpstreamEndpoint
    || !isExactCursorLoopbackTestOrigin(input.testAgentUpstreamEndpoint)
    || !isExactCursorLoopbackTestOrigin(input.testControlPlaneUpstreamEndpoint)
    || !Number.isSafeInteger(testMcpCapabilityTimeoutMs)
    || testMcpCapabilityTimeoutMs < 1
    || testMcpCapabilityTimeoutMs > CURSOR_LIVE_MCP_CAPABILITY_TIMEOUT_MS
  )) {
    throw new Error("Cursor's live MCP capability timeout seam is restricted to bounded exact-loopback unit tests.");
  }
  const mcpCapabilityTimeoutMs = testMcpCapabilityTimeoutMs
    ?? CURSOR_LIVE_MCP_CAPABILITY_TIMEOUT_MS;
  if (restrictRemoteAuthority && (!providerAuthorization
    || !/^Bearer [^\s\0]{1,16384}$/.test(providerAuthorization))) {
    throw new Error("Supervised Cursor requires an in-memory live provider authorization proof.");
  }
  if (restrictRemoteAuthority && (!input.mcpConnectorSocketPath
    || !input.mcpRuntimeEntryPath
    || !input.mcpRuntimeCwd
    || !input.mcpRuntimeEnv)) {
    throw new Error("Supervised Cursor requires a wrapper-owned MCP connector boundary.");
  }
  if (restrictRemoteAuthority && !windows
    && (allowedWriteSubpaths.length === 0 || allowedReadSubpaths.length === 0)) {
    throw new Error("Supervised Cursor requires non-empty read and write sandbox allow-lists.");
  }
  if (restrictRemoteAuthority && input.args.some((arg) =>
    arg === "-e"
      || arg === "--endpoint"
      || arg.startsWith("--endpoint=")
      || arg === "--agent-endpoint"
      || arg.startsWith("--agent-endpoint=")
      || arg === "--auth-token"
      || arg.startsWith("--auth-token=")
      || arg === "--http-version"
      || arg.startsWith("--http-version="))) {
    throw new Error("Supervised Cursor endpoint and authentication flags are adapter-owned.");
  }
  if (input.nativeResumeSessionId !== undefined) {
    if (!restrictRemoteAuthority
      || input.args.filter((arg) => arg.startsWith("--resume=")).length !== 1
      || !input.args.includes(`--resume=${input.nativeResumeSessionId}`)) {
      throw new Error("Cursor ownership access must match the exact supervised resume session.");
    }
    if (cursorOsSandbox() === "macos-sandbox-exec") {
      const lock = prepareCursorResumeOwnershipLock(input.nativeResumeSessionId);
      allowedReadSubpaths.push(...cursorSandboxPathVariants(lock));
      allowedWriteSubpaths.push(...cursorSandboxPathVariants(lock));
    }
  }
  // The wrapper is the durable process identity. It does not launch Cursor
  // until release(), allowing the daemon to checkpoint PID + birth identity
  // before any model/tool side effect. It also mirrors the exact stream and a
  // terminal record to an owner-private file for restart/handoff recovery.
  // The program text lives in the cursor/turn-wrapper-*.ts slices, joined in order.
  // Windows: it is longer than the 32,767-character command-line limit, so
  // it runs from an owner-private file with the same process.argv.
  let windowsTurn: CursorWindowsTurnValues | undefined;
  let windowsConnectorRoot: string | null = null;
  let wrapperProgram: ReturnType<typeof writeCursorWrapperProgram> | null = null;
  let child: ReturnType<typeof spawnTree>;
  try {
    if (windows) {
      const connectorListenPath = restrictRemoteAuthority && input.mcpConnectorSocketPath
        ? cursorMcpConnectorListenPath(input.mcpConnectorSocketPath)
        : "";
      windowsTurn = {
        ...cursorWindowsNativeLaunch(input.cursorBin, input.args, { env: input.env ?? process.env, cwd: input.cwd }),
        connectorListenPath,
        temporaryRoot: cursorTemporaryRoot(),
      };
      if (connectorListenPath) {
        windowsConnectorRoot = dirname(input.mcpConnectorSocketPath!);
        prepareCursorWindowsConnectorRoot(windowsConnectorRoot);
      }
    }
    const wrapperSource = cursorTurnWrapperSource({
      agentUpstreamEndpoint,
      controlPlaneUpstreamEndpoint,
      deniedDelegatingExecutablePaths,
      ...(windowsTurn ? { windows: windowsTurn } : {}),
    });
    if (windows) wrapperProgram = writeCursorWrapperProgram(wrapperSource);
    const sandboxList = (paths: string[]): string => (windows ? "[]" : JSON.stringify(paths));
    const wrapperArgs = [
      "-e",
      wrapperProgram ? cursorWrapperProgramBootstrap(wrapperProgram.path) : wrapperSource,
      input.cursorBin,
      input.statePath ?? "",
      input.workspaceGenerationManifestPath ?? "",
      sandboxList(deniedReadPaths),
      sandboxList(deniedReadSubpaths),
      sandboxList(deniedReadMetadataPaths),
      sandboxList(deniedReadWriteRegexes),
      sandboxList(deniedWriteRegexes),
      sandboxList(deniedWritePaths),
      sandboxList(deniedWriteStructuralPaths),
      sandboxList(deniedWriteSubpaths),
      sandboxList(deniedExecSubpaths),
      sandboxList(allowedWriteSubpaths),
      sandboxList(allowedReadSubpaths),
      sandboxList(allowedNetworkUnixSockets),
      sandboxList(allowedInternalUnixSocketRoots),
      input.mcpConnectorSocketPath ?? "",
      input.mcpRuntimeEntryPath ?? "",
      input.mcpRuntimeCwd ?? "",
      testStartupBarrier?.path ?? "",
      testStartupBarrier?.stage ?? "",
      String(mcpCapabilityTimeoutMs),
      restrictRemoteAuthority ? "1" : "0",
      input.fullAccess === true ? "1" : "0",
      ...input.args,
    ];
    if (windowsTurn) assertCursorWindowsCommandLines(windowsCommandLine(process.execPath, wrapperArgs), windowsTurn);
    child = spawnTree(process.execPath, wrapperArgs, {
      cwd: input.cwd,
      // The prompt travels as a positional argument; cursor-agent has no stdin
      // channel (matrix row). Its own process group so group signalling reaps
      // any descendants (on Windows the process-tree helper's job).
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: process.platform !== "win32",
      env: {
        ...(input.env ?? cursorCliEnv()),
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
    });
  } catch (error) {
    wrapperProgram?.remove();
    if (windowsConnectorRoot) rmSync(windowsConnectorRoot, { recursive: true, force: true });
    throw error;
  }
  if (wrapperProgram) {
    const program = wrapperProgram;
    child.once("close", () => { try { program.remove(); } catch { /* a private temporary file */ } });
    child.once("error", () => { try { program.remove(); } catch { /* a private temporary file */ } });
  }
  if (windows) rememberCursorWrapperForStop(child);

  const lineListeners = new Set<(line: string) => void>();
  const stderrChunks: string[] = [];
  let wrapperTerminalError: string | null = null;
  let wrapperPrepared = false;
  let resolvePrepared!: () => void;
  let rejectPrepared!: (error: Error) => void;
  const prepared = new Promise<void>((resolve, reject) => {
    resolvePrepared = resolve;
    rejectPrepared = reject;
  });
  child.on("message", (message) => {
    const wrapperMessage = message && typeof message === "object"
      ? message as { type?: unknown; error?: unknown }
      : null;
    if (wrapperMessage?.type === "terminal_error"
      && typeof wrapperMessage.error === "string") {
      wrapperTerminalError = wrapperMessage.error;
    }
    if (!wrapperPrepared && message && typeof message === "object"
      && (message as { type?: unknown }).type === "prepared") {
      wrapperPrepared = true;
      resolvePrepared();
    }
  });
  let spawned = false;
  let sawPid = child.pid !== undefined;
  let failedToSpawn = false;
  child.once("spawn", () => { spawned = true; sawPid ||= child.pid !== undefined; });
  const exited = new Promise<ProviderProcessExit>((resolve) => {
    child.once("error", (error) => {
      sawPid ||= child.pid !== undefined;
      failedToSpawn = !spawned && !sawPid;
      if (!wrapperPrepared) rejectPrepared(error);
      resolve({ type: "error", error });
    });
    // "close", not "exit": close fires only after the stdio streams have
    // drained, so the final buffered `result` line is always delivered before
    // the exit evidence resolves. With "exit" a cleanly completed turn could be
    // misclassified as a crash because its result line was still in the pipe
    // (TrailDelta review, msg_1780).
    child.once("close", (code, signal) => {
      if (!wrapperPrepared) rejectPrepared(new Error("Cursor wrapper exited before preparing its durable turn boundary."));
      resolve({ type: "exit", code, signal });
    });
  });
  if (child.stdout) {
    let bufferedLine = Buffer.alloc(0);
    let droppingOversizedLine = false;
    let protocolErrorEmitted = false;
    const emitLine = (line: string) => {
      for (const listener of lineListeners) listener(line);
    };
    const emitOversizedLineError = () => {
      if (protocolErrorEmitted) return;
      protocolErrorEmitted = true;
      emitLine(JSON.stringify({
        type: "letagents_stream_contract_error",
        session_id: "",
        error: "Cursor wrapper emitted an oversized stream-json line.",
      }));
    };
    child.stdout.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(0x0a, cursor);
        if (droppingOversizedLine) {
          if (newline < 0) return;
          droppingOversizedLine = false;
          cursor = newline + 1;
          continue;
        }
        const end = newline < 0 ? chunk.length : newline;
        const segment = chunk.subarray(cursor, end);
        if (bufferedLine.length + segment.length > MAX_CURSOR_STREAM_LINE_BYTES) {
          bufferedLine = Buffer.alloc(0);
          emitOversizedLineError();
          if (newline < 0) {
            droppingOversizedLine = true;
            return;
          }
          cursor = newline + 1;
          continue;
        }
        bufferedLine = bufferedLine.length === 0
          ? Buffer.from(segment)
          : Buffer.concat([bufferedLine, segment]);
        if (newline < 0) return;
        const line = bufferedLine.length > 0 && bufferedLine.at(-1) === 0x0d
          ? bufferedLine.subarray(0, -1)
          : bufferedLine;
        emitLine(line.toString("utf8"));
        bufferedLine = Buffer.alloc(0);
        cursor = newline + 1;
      }
    });
    child.stdout.on("end", () => {
      if (!droppingOversizedLine && bufferedLine.length) emitLine(bufferedLine.toString("utf8"));
      bufferedLine = Buffer.alloc(0);
    });
  }
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
    if (stderrChunks.length > 20) stderrChunks.shift();
  });

  let released = false;
  const result: CursorCliChild = {
    pid: child.pid ?? null,
    exited,
    didNotSpawn: () => failedToSpawn && child.pid === undefined,
    onLine(listener) {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    stderrTail() {
      return stderrChunks.join("");
    },
    terminalError() {
      return safeCursorTerminalErrorDetail(wrapperTerminalError);
    },
    prepared,
    ownsDescendantReaping: !windows,
    requiresDurableTerminalEvidence: Boolean(input.statePath && restrictRemoteAuthority),
    release() {
      if (released) return;
      released = true;
      child.send?.({
        type: "start",
        ...(providerAuthorization ? { providerAuthorization } : {}),
        ...(input.mcpRuntimeEnv ? { mcpRuntimeEnv: input.mcpRuntimeEnv } : {}),
      });
    },
  };
  if (!input.deferStart) result.release();
  return result;
}
