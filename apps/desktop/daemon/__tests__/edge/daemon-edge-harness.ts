import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { DAEMON_PROTOCOL_VERSION, isDaemonAsyncRpcAccepted, type DaemonRpcEffectView } from "#daemon-contract/index.js";
import { connectDaemon, daemonEndpoint } from "../../../../../shared/daemon-endpoint.mjs";
import { processTreeHelperPath } from "../../../../../shared/process-tree.mjs";
import { materializeNodeShim, resolveStandInRuntime, type MaterializeNodeShimOptions } from "./executable-shim.js";
import { FakeRoomServer } from "./fake-room-server.js";
import { EdgeSqliteInspector } from "./sqlite-inspector.js";

const EDGE_DIR = dirname(fileURLToPath(import.meta.url));
export const DESKTOP_ROOT = resolve(EDGE_DIR, "../../..");
export const REPO_ROOT = resolve(DESKTOP_ROOT, "../..");
export { DAEMON_PROTOCOL_VERSION };

export const EDGE_DAEMON_UNSUPPORTED_REASON: string | null =
  process.platform !== "darwin" && process.platform !== "win32"
    ? "Supervisor daemon supports macOS and Windows only (apps/desktop/daemon/platform.ts)."
    : null;

export interface EdgeDaemonCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * Whether to attach a Node IPC channel for host-approval Ed25519 verifier
   * and state-recovery key bootstrap. Defaults to `true` for the built-in Node
   * daemon and `false` when an external binary is passed via `LETAGENTS_EDGE_DAEMON_CMD`.
   */
  useNodeIpc?: boolean;
}

export interface EdgeDaemonOptions {
  /** Override the daemon executable/args so another implementation (for example Rust) runs the same suite. */
  daemonCommand?: EdgeDaemonCommand;
  /** Extra environment variables passed to the daemon child process. */
  env?: Record<string, string>;
  /** Optional provider shims to materialize into an isolated bin dir prepended to the daemon's PATH. */
  shims?: ReadonlyArray<{
    name: string;
    scriptPath: string;
    env?: Record<string, string>;
    nodeArgs?: readonly string[];
    /** Copy `scriptPath` into `binDir` for sandboxed providers that can read only inside the shim directory. */
    copyScript?: boolean;
    /** If set, also expose the materialized shim path under this env var name on the daemon process. */
    envVar?: string;
  }>;
  /** Startup readiness timeout in ms. Defaults to 15s on macOS, 30s on Windows. */
  readyTimeoutMs?: number;
  /** Keep the isolated home folder after `dispose()` for debugging. */
  keepHome?: boolean;
  /** Optional parent directory where the isolated `letagents-edge-*` home folder is created. Defaults to `os.tmpdir()`. */
  tempRoot?: string;
  /** Optional process-table enumerator override (defaults to OS `ps` / native Windows lookup). */
  listProcesses?: (extraPids?: Iterable<number>) => ProcessSnapshotEntry[];
}

export interface EdgeDaemonStatus {
  healthy: boolean;
  protocol_version: number;
  implementation_version: string;
  generation: number;
  pid: number;
  started_at: string;
  [key: string]: unknown;
}

export interface EdgeManifestEntryView {
  id: string;
  room_id: string;
  display_name: string;
  provider: string;
  model: string | null;
  charter: string;
  desired_state: "running" | "paused" | "stopped";
  observed_state: string;
  condition: string;
  last_error?: string | null;
  permission_profile_id: string | null;
  delivery_mode?: string;
  work_attempt_id?: string | null;
  workspace_path?: string | null;
  provider_ref?: {
    work_attempt_id: string;
    provider_continuation_id: string;
    execution_generation_id: string;
    provider_connection?: {
      kind: string;
      url?: string;
      pid?: number | null;
      processIdentity?: string | null;
      serverAuthPath?: string;
    } | null;
  } | null;
  worker_binding?: {
    agent_session_id: string;
    work_attempt_id: string;
    execution_generation_id: string;
    updated_at: string;
  } | null;
  room_agent_state?: {
    connection: { state: string; detail: string | null };
    ingress: { state: string; detail: string | null };
    inbox: { state: string; pending_count: number; blocked_by_message_id: string | null; detail: string | null };
    turn: {
      state: string;
      inbox_item_id: string | null;
      source_message_id: string | null;
      provider_turn_id: string | null;
      detail: string | null;
    };
    task: { state: string; task_id: string | null; title: string | null };
  } | null;
  delivery_receipts?: Array<{
    inbox_item_id: string;
    source_message_id: string;
    fifo_sequence: number;
    reply_client_message_id: string;
    canonical_message_id: string | null;
    state: string;
    attempt_count: number;
    provider_turn_id: string | null;
    error: string | null;
  }>;
  reconciliation?: {
    exit_timestamps_ms?: number[];
    consecutive_action_failures?: number;
    next_restart_at_ms?: number | null;
    last_terminal?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface EdgeWatchStateResult {
  daemon_generation: number;
  sequence: number;
  complete?: boolean;
  entries: EdgeManifestEntryView[];
  removed_entry_ids?: string[];
  entry_order?: string[];
  rpc_effects?: DaemonRpcEffectView[];
}

export interface EdgeHostApprovalChallenge {
  daemonGeneration: number;
  bootNonce: string;
  keyFingerprint: string;
}

export interface EdgeHostApprovalCandidate {
  reference: Record<string, unknown>;
  presentation: Record<string, unknown>;
  status: string;
  detail: string | null;
  recordedDecision: Record<string, unknown> | null;
}

export interface EdgeAgentRegistration {
  entryId: string;
  roomId: string;
  provider: "codex" | "claude-code" | "cursor" | "open-model";
  displayName?: string;
  model?: string | null;
  charter?: string;
  permissionProfileId?: string | null;
  providerLaunchPolicy?: Record<string, unknown>;
  sourceRepoPath?: string | null;
  agentKey?: string;
  grantId?: string;
  supervisorGrant?: string;
  grantGeneration?: number;
  initialMessage?: string;
  openModelCredential?: {
    apiKey: string | null;
    baseUrl: string;
    model: string;
    contextWindow?: number;
  };
}

interface ManagedDaemonProcess {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null;
}

function readConfiguredMcpVersion(): string {
  const pkgPath = join(DESKTOP_ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    letagentsRuntime?: { mcpVersion?: string };
  };
  const version = pkg.letagentsRuntime?.mcpVersion;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Could not read letagentsRuntime.mcpVersion from ${pkgPath}`);
  }
  return version;
}

/**
 * Create a lightweight, self-contained development MCP runtime package inside
 * `rootDir` that satisfies `resolveLetAgentsMcpRuntime` (exact name/version +
 * real `node_modules/` directory + `--letagents-runtime-contract` JSON output
 * + minimal stdio MCP JSON-RPC responses).
 */
async function materializeDevMcpPackage(rootDir: string): Promise<string> {
  const mcpVersion = readConfiguredMcpVersion();
  await mkdir(join(rootDir, "node_modules"), { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    `${JSON.stringify({ name: "letagents", version: mcpVersion, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  const serverPath = join(rootDir, "server.mjs");
  const serverSource = `
const CONTRACT = {
  format: 1,
  profiles: {
    cursor_supervised_room_turn: {
      tools: [
        "claim_task",
        "get_board",
        "read_messages",
        "send_message",
        "send_thread_message",
        "complete_room_turn",
      ],
    },
  },
};

if (process.argv.includes("--letagents-runtime-contract")) {
  process.stdout.write(JSON.stringify(CONTRACT) + "\\n");
  process.exit(0);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() ?? "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined || msg.id === null) continue;
    const reply = (result) => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
    };
    if (msg.method === "initialize") {
      reply({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "letagents-edge-mcp-stub", version: ${JSON.stringify(mcpVersion)} },
      });
    } else if (msg.method === "ping") {
      reply({});
    } else if (msg.method === "tools/list") {
      reply({
        tools: [
          { name: "read_messages", description: "Read room messages", inputSchema: { type: "object", properties: {} } },
          { name: "send_message", description: "Send room message", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
          { name: "get_board", description: "Get room board", inputSchema: { type: "object", properties: {} } },
          { name: "claim_task", description: "Claim task", inputSchema: { type: "object", properties: { task_id: { type: "string" } } } },
          { name: "complete_room_turn", description: "Complete bounded room turn", inputSchema: { type: "object", properties: { summary: { type: "string" } } } },
        ],
      });
    } else if (msg.method === "resources/list") {
      reply({
        resources: [
          { uri: "letagents://runtime/readiness", name: "Runtime readiness", mimeType: "application/json" },
        ],
      });
    } else if (msg.method === "resources/read") {
      reply({
        contents: [
          {
            uri: "letagents://runtime/readiness",
            mimeType: "application/json",
            text: JSON.stringify({
              format: 1,
              profile: "supervised_room_turn",
              provider: process.env.LETAGENTS_SUPERVISED_PROVIDER || "codex",
              tools: ["claim_task", "get_board", "read_messages", "send_message"],
            }),
          },
        ],
      });
    } else if (msg.method === "tools/call") {
      reply({
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        isError: false,
      });
    } else {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "Unsupported method: " + String(msg.method) },
      }) + "\\n");
    }
  }
});
`;
  await writeFile(serverPath, serverSource.trimStart(), "utf8");
  return serverPath;
}

const ALLOWED_HOST_ENV_KEYS = new Set([
  // POSIX baseline
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TZ",
  // Windows baseline
  "SYSTEMROOT",
  "COMSPEC",
  "WINDIR",
  "TEMP",
  "TMP",
  "PATHEXT",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "NUMBER_OF_PROCESSORS",
  "SYSTEMDRIVE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  // Explicit CI/local process-tree helper paths on Windows
  "LETAGENTS_PROCESS_TREE_HELPER",
  "LETAGENTS_TEST_PROCESS_TREE_HELPER",
]);

function allowedHostEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ALLOWED_HOST_ENV_KEYS.has(key.toUpperCase())) {
      out[key] = value;
    }
  }
  return out;
}

export interface ProcessSnapshotEntry {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
  /** Optional executable image path for diagnostics only (never substituted into `command`). */
  image?: string;
  /** Helper-reported `exited` flag for diagnostics when `commandLineUnreadable` is true. */
  helperExited?: boolean | null;
  /** Set when OS/helper reported the process alive without a readable command line. */
  commandLineUnreadable?: boolean;
}

export interface ProcessListDiagnostics {
  method: "ps" | "tasklist+process-tree-helper" | "powershell-fallback";
  totalTasks: number;
  helperCalls: number;
  elapsedMs: number;
}

/**
 * Windows executable image names queried via `letagents-process-tree.exe info <pid>`
 * after `tasklist.exe /FO CSV /NH`.
 *
 * Scope & trade-off: querying every Windows service (`svchost.exe`, etc.) via
 * per-PID helper spawns would add hundreds of spawns per `dispose()`. Restricting
 * name-based inspection to test/provider/shell executables keeps Windows scans to
 * a handful of fast native helper calls while still always inspecting `process.pid`
 * and every tracked daemon/provider PID regardless of image name. Limitation: an
 * untracked child process whose image name is outside this set (for example a
 * standalone `python.exe` not in `trackedProviderPids`) is not inspected for
 * `homeDir` command-line matches.
 */
const WINDOWS_EDGE_PROCESS_IMAGES = new Set([
  "node.exe",
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  "letagents-process-tree.exe",
  "codex.exe",
  "opencode.exe",
  "claude.exe",
  "cursor-agent.exe",
  "agent.exe",
  "electron.exe",
  "letagents.exe",
  "git.exe",
  "bash.exe",
  "sh.exe",
  "bun.exe",
]);

let lastProcessListDiagnosticsValue: ProcessListDiagnostics | null = null;

export function lastProcessListDiagnostics(): ProcessListDiagnostics | null {
  return lastProcessListDiagnosticsValue ? { ...lastProcessListDiagnosticsValue } : null;
}

function resolveWindowsProcessTreeHelper(): string | null {
  if (process.platform !== "win32") return null;
  const configured =
    process.env.LETAGENTS_PROCESS_TREE_HELPER?.trim() ||
    process.env.LETAGENTS_TEST_PROCESS_TREE_HELPER?.trim() ||
    "";
  return processTreeHelperPath({
    platform: "win32",
    env: {
      ...process.env,
      ...(configured ? { LETAGENTS_PROCESS_TREE_HELPER: configured } : {}),
    },
  });
}

export function parseWindowsTasklistCsv(output: string): Array<{ image: string; pid: number }> {
  const entries: Array<{ image: string; pid: number }> = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, "").trim();
    if (!line || !line.startsWith('"')) continue;
    const match = /^"([^"]+)","(\d+)"/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[2]!, 10);
    if (Number.isInteger(pid) && pid > 1) {
      entries.push({ image: match[1]!, pid });
    }
  }
  return entries;
}

export function selectWindowsEdgeProcessCandidates(
  tasks: ReadonlyArray<{ image: string; pid: number }>,
  options: {
    currentPid?: number;
    extraPids?: Iterable<number>;
    extraImageNames?: Iterable<string>;
  } = {},
): Array<{ image: string; pid: number }> {
  const currentPid = options.currentPid ?? process.pid;
  const extraPids = new Set<number>();
  for (const pid of options.extraPids ?? []) {
    if (Number.isInteger(pid) && pid > 1) extraPids.add(pid);
  }
  const images = new Set(WINDOWS_EDGE_PROCESS_IMAGES);
  const currentExecImage = basename(process.execPath).toLowerCase();
  if (currentExecImage) images.add(currentExecImage);
  const overrideDaemonCmd = process.env.LETAGENTS_EDGE_DAEMON_CMD?.trim();
  if (overrideDaemonCmd) {
    const overrideImage = basename(overrideDaemonCmd).toLowerCase();
    if (overrideImage) images.add(overrideImage);
  }
  for (const image of options.extraImageNames ?? []) {
    if (image.trim()) images.add(image.trim().toLowerCase());
  }
  return tasks.filter(
    (task) => task.pid === currentPid || extraPids.has(task.pid) || images.has(task.image.toLowerCase()),
  );
}

export function execWithTimeoutRetry<T>(
  operation: () => T,
  maxAttempts = 2,
): T {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (attempt < maxAttempts && code === "ETIMEDOUT") continue;
      throw error;
    }
  }
  throw lastError;
}

function execProcessList(command: string, args: readonly string[], timeoutMs: number): string {
  return execWithTimeoutRetry(
    () =>
      execFileSync(command, [...args], {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        ...(process.platform === "win32" ? { windowsHide: true } : {}),
      }),
    2,
  );
}

export interface WindowsHelperSpawnResult {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
}

const SYNC_SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(SYNC_SLEEP_ARRAY, 0, 0, ms);
}

/**
 * Interpret one `letagents-process-tree.exe info <pid>` reply without ever
 * substituting `image` for a missing `commandLine` or silently omitting an
 * inaccessible tracked/required process.
 */
export function parseWindowsHelperInfoResult(
  pid: number,
  result: WindowsHelperSpawnResult,
  options: { required?: boolean; owned?: boolean; deferUnreadableThrow?: boolean } = {},
): ProcessSnapshotEntry | null {
  if (result.error) throw result.error;
  // Exit 2 = confirmed absent (exited between tasklist and info).
  if (result.status === 2) {
    if (options.required) throw new Error(`letagents-process-tree.exe reported required pid ${pid} absent.`);
    return null;
  }
  // Exit 3 = access denied. For the runner or any tracked/owned pid this cannot
  // prove the process is unrelated to the test; fail closed immediately.
  if (result.status === 3) {
    if (options.required || options.owned) {
      throw new Error(`letagents-process-tree.exe could not open tracked/required pid ${pid} (access denied).`);
    }
    return null;
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(`letagents-process-tree.exe info ${pid} exited with code ${result.status}${stderr ? `: ${stderr}` : ""}`);
  }
  const parsed = JSON.parse(String(result.stdout || "").trim()) as {
    pid?: unknown;
    parentPid?: unknown;
    exited?: unknown;
    image?: unknown;
    commandLine?: unknown;
  };
  if (parsed.pid !== pid) {
    throw new Error(`letagents-process-tree.exe info ${pid} returned unexpected pid ${String(parsed.pid)}.`);
  }
  // Confirmed exited (only a handle remains open): harmless unless required.
  if (parsed.exited === true) {
    if (options.required) throw new Error(`letagents-process-tree.exe reported required pid ${pid} exited.`);
    return null;
  }
  const ppid = typeof parsed.parentPid === "number" && Number.isInteger(parsed.parentPid) ? parsed.parentPid : 0;
  const image = typeof parsed.image === "string" && parsed.image.length > 0 ? parsed.image : undefined;
  const helperExited = typeof parsed.exited === "boolean" ? parsed.exited : null;
  if (typeof parsed.commandLine !== "string" || parsed.commandLine.length === 0) {
    if ((options.required || options.owned) && !options.deferUnreadableThrow) {
      throw new Error(
        `letagents-process-tree.exe info ${pid} returned unreadable commandLine for live tracked/required process (ppid=${ppid}, tracked=${Boolean(options.owned || options.required)}, alive=${isPidAlive(pid)}, exited=${String(helperExited)}${image ? `, image=${image}` : ""}).`,
      );
    }
    return { pid, ppid, pgid: pid, command: "", ...(image ? { image } : {}), helperExited, commandLineUnreadable: true };
  }
  return { pid, ppid, pgid: pid, command: parsed.commandLine, ...(image ? { image } : {}) };
}

/**
 * Re-probe briefly when Windows returns status 0 + `exited: false` + `commandLine: null`,
 * which happens transiently while a short-lived process is initializing or tearing down its PEB.
 * Fails closed identically if the process remains live with an unreadable command line after settling.
 */
export function queryWindowsHelperInfoWithSettle(
  pid: number,
  queryOnce: () => WindowsHelperSpawnResult,
  options: {
    required?: boolean;
    owned?: boolean;
    maxUnreadableRetries?: number;
    retryDelayMs?: number;
    sleep?: (ms: number) => void;
  } = {},
): ProcessSnapshotEntry | null {
  const maxRetries = options.maxUnreadableRetries ?? 20;
  const retryDelayMs = options.retryDelayMs ?? 100;
  const sleep = options.sleep ?? sleepSync;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const isFinalAttempt = attempt === maxRetries;
    const raw = queryOnce();
    const entry = parseWindowsHelperInfoResult(pid, raw, {
      required: options.required,
      owned: options.owned,
      deferUnreadableThrow: !isFinalAttempt,
    });
    if (entry && entry.commandLineUnreadable && !isFinalAttempt) {
      sleep(retryDelayMs);
      continue;
    }
    return entry;
  }
  return null;
}

function queryWindowsHelperProcessInfo(
  helperPath: string,
  pid: number,
  options: { required?: boolean; owned?: boolean; onLaunch?: () => void } = {},
): ProcessSnapshotEntry | null {
  return queryWindowsHelperInfoWithSettle(
    pid,
    () =>
      execWithTimeoutRetry(
        () => {
          options.onLaunch?.();
          const result = spawnSync(helperPath, ["info", String(pid)], {
            encoding: "utf8",
            timeout: 10_000,
            maxBuffer: 4 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
          if (result.error) throw result.error;
          return result;
        },
        2,
      ),
    options,
  );
}

export function listOsProcesses(extraPids?: Iterable<number>): ProcessSnapshotEntry[] {
  const startedAt = performance.now();
  if (process.platform === "win32") {
    const helperPath = resolveWindowsProcessTreeHelper();
    if (helperPath) {
      try {
        const rawCsv = execProcessList("tasklist.exe", ["/FO", "CSV", "/NH"], 15_000);
        const tasks = parseWindowsTasklistCsv(rawCsv);
        if (!tasks.some((task) => task.pid === process.pid)) {
          throw new Error(`tasklist.exe output did not contain current runner pid ${process.pid} (parsed ${tasks.length} rows).`);
        }
        const ownedPids = new Set<number>();
        for (const pid of extraPids ?? []) {
          if (Number.isInteger(pid) && pid > 1) ownedPids.add(pid);
        }
        const candidates = selectWindowsEdgeProcessCandidates(tasks, { extraPids: ownedPids });
        const entries: ProcessSnapshotEntry[] = [];
        const inspectedPids = new Set<number>();
        let helperCalls = 0;
        for (const candidate of candidates) {
          inspectedPids.add(candidate.pid);
          const info = queryWindowsHelperProcessInfo(helperPath, candidate.pid, {
            required: candidate.pid === process.pid,
            owned: ownedPids.has(candidate.pid),
            onLaunch: () => { helperCalls += 1; },
          });
          if (info) entries.push(info);
        }
        // Directly inspect any live owned/tracked PID that was absent from tasklist.
        for (const pid of ownedPids) {
          if (inspectedPids.has(pid) || !isPidAlive(pid)) continue;
          inspectedPids.add(pid);
          const info = queryWindowsHelperProcessInfo(helperPath, pid, {
            owned: true,
            onLaunch: () => { helperCalls += 1; },
          });
          if (info) entries.push(info);
        }
        if (!entries.some((entry) => entry.pid === process.pid)) {
          throw new Error(`letagents-process-tree.exe did not report current runner pid ${process.pid}.`);
        }
        lastProcessListDiagnosticsValue = {
          method: "tasklist+process-tree-helper",
          totalTasks: tasks.length,
          helperCalls,
          elapsedMs: Math.round(performance.now() - startedAt),
        };
        return entries;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`OS process enumeration failed (tasklist.exe + letagents-process-tree.exe): ${detail}`, { cause: error });
      }
    }
    try {
      const output = execProcessList(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine | ForEach-Object { \"$($_.ProcessId)\t$($_.ParentProcessId)\t$($_.CommandLine)\" }",
        ],
        25_000,
      );
      const entries: ProcessSnapshotEntry[] = [];
      for (const line of output.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const firstTab = line.indexOf("\t");
        const secondTab = firstTab >= 0 ? line.indexOf("\t", firstTab + 1) : -1;
        if (firstTab < 0 || secondTab < 0) continue;
        const pid = Number.parseInt(line.slice(0, firstTab), 10);
        const ppid = Number.parseInt(line.slice(firstTab + 1, secondTab), 10);
        const commandLine = line.slice(secondTab + 1);
        if (Number.isInteger(pid) && pid > 1) {
          entries.push({ pid, ppid: Number.isInteger(ppid) ? ppid : 0, pgid: pid, command: commandLine });
        }
      }
      if (entries.length === 0) {
        throw new Error("powershell.exe returned an empty process list.");
      }
      lastProcessListDiagnosticsValue = {
        method: "powershell-fallback",
        totalTasks: entries.length,
        helperCalls: 0,
        elapsedMs: Math.round(performance.now() - startedAt),
      };
      return entries;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`OS process enumeration failed (powershell.exe): ${detail}`, { cause: error });
    }
  }
  try {
    const output = execProcessList("ps", ["-axo", "pid=,ppid=,pgid=,command="], 5_000);
    const entries: ProcessSnapshotEntry[] = [];
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number.parseInt(match[1]!, 10);
      const ppid = Number.parseInt(match[2]!, 10);
      const pgid = Number.parseInt(match[3]!, 10);
      if (Number.isInteger(pid) && pid > 1) {
        entries.push({ pid, ppid, pgid, command: match[4]! });
      }
    }
    if (entries.length === 0) {
      throw new Error("ps returned an empty process list.");
    }
    lastProcessListDiagnosticsValue = {
      method: "ps",
      totalTasks: entries.length,
      helperCalls: 0,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
    return entries;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`OS process enumeration failed (ps): ${detail}`, { cause: error });
  }
}

/**
 * Return every live OS process (excluding the current test runner process)
 * whose command line references `needle` (normalized path match).
 *
 * Throws if OS process enumeration fails so a failed inspection can never
 * satisfy a zero-process assertion.
 */
export function findProcessesReferencingPath(
  needle: string,
  listProcesses: (extraPids?: Iterable<number>) => ProcessSnapshotEntry[] = listOsProcesses,
  extraPids?: Iterable<number>,
): ProcessSnapshotEntry[] {
  const normalized = needle.replaceAll("\\", "/").toLowerCase();
  const processes = listProcesses(extraPids);
  const unreadable = processes.filter((entry) => entry.pid !== process.pid && entry.commandLineUnreadable);
  if (unreadable.length > 0) {
    const trackedSet = new Set<number>(extraPids ?? []);
    const detail = unreadable
      .map(
        (entry) =>
          `pid=${entry.pid} ppid=${entry.ppid} tracked=${trackedSet.has(entry.pid)} alive=${isPidAlive(entry.pid)} exited=${String(entry.helperExited ?? null)}${entry.image ? ` image=${entry.image}` : ""}`,
      )
      .join(", ");
    throw new Error(
      `OS process enumeration returned unreadable command line(s) for live process(es) (${detail}); cannot verify zero processes reference ${needle}.`,
    );
  }
  if (!normalized) return [];
  return processes.filter(
    (entry) =>
      entry.pid !== process.pid &&
      entry.command.replaceAll("\\", "/").toLowerCase().includes(normalized),
  );
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function terminateProcessTrees(targets: ReadonlyArray<{ pid: number; pgid?: number }>): Promise<void> {
  if (targets.length === 0) return;
  if (process.platform === "win32") {
    for (const { pid } of targets) {
      if (!isPidAlive(pid)) continue;
      try {
        execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          timeout: 4_000,
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
    return;
  }
  const sendSignal = (signal: NodeJS.Signals) => {
    for (const { pid, pgid } of targets) {
      if (!isPidAlive(pid)) continue;
      // Signal the detached process group only when the target leads its own group (never the test runner's group).
      if (pgid && pgid === pid && pgid !== process.pid) {
        try { process.kill(-pgid, signal); } catch { /* fall back to direct pid */ }
      }
      try { process.kill(pid, signal); } catch { /* already gone */ }
    }
  };
  sendSignal("SIGTERM");
  const softDeadline = Date.now() + 800;
  while (Date.now() < softDeadline && targets.some(({ pid }) => isPidAlive(pid))) {
    await new Promise((r) => setTimeout(r, 40));
  }
  if (targets.some(({ pid }) => isPidAlive(pid))) {
    sendSignal("SIGKILL");
    const hardDeadline = Date.now() + 800;
    while (Date.now() < hardDeadline && targets.some(({ pid }) => isPidAlive(pid))) {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
}

/** The folder that each daemon starts in. */
const DAEMON_LAUNCH_FOLDER = DESKTOP_ROOT;

/**
 * The environment that a daemon starts with. One function for the start and for the choice of the
 * stand-in program, so that both find the daemon command with the same `PATH`.
 */
function daemonLaunchEnvironment(
  baseEnv: Record<string, string>,
  command: EdgeDaemonCommand,
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...allowedHostEnvironment(process.env),
    ...baseEnv,
    ...(command.env ?? {}),
    ...extraEnv,
  };
}

export function resolveDefaultDaemonCommand(): EdgeDaemonCommand {
  const overrideCommand = process.env.LETAGENTS_EDGE_DAEMON_CMD?.trim();
  if (overrideCommand) {
    const rawArgs = process.env.LETAGENTS_EDGE_DAEMON_ARGS?.trim();
    const args = rawArgs ? (JSON.parse(rawArgs) as string[]) : [];
    // A packaged app runs the daemon script only in Node mode, and the harness passes an allowlist of
    // variables to the daemon. So the command gets the variable here, with no wrapper file: a wrapper
    // would become "the program of the command", and the stand-ins must run under the daemon's real
    // program. The variable has no effect on a plain Node program or on a daemon in another language.
    return { command: overrideCommand, args, env: { ELECTRON_RUN_AS_NODE: "1" }, useNodeIpc: false };
  }
  const builtDaemon = join(DESKTOP_ROOT, "dist-daemon", "main.js");
  if (!existsSync(builtDaemon)) {
    throw new Error(
      `Built daemon entry not found at ${builtDaemon}. Run "npm --prefix apps/desktop run build:electron && npm --prefix apps/desktop run build:daemon" first.`,
    );
  }
  return { command: process.execPath, args: [builtDaemon], useNodeIpc: true };
}

/**
 * Black-box RPC client talking strictly over the daemon control socket/pipe.
 * Uses `shared/daemon-endpoint.mjs` for POSIX Unix sockets and Windows named
 * pipes (with mutual HMAC peer proof). Imports no daemon internal modules.
 */
export class EdgeDaemonClient {
  constructor(
    readonly stateDir: string,
    private readonly approvalKeyPair: { publicKeyBase64: string; privateKey: KeyObject; keyFingerprint: string },
  ) {}

  get connectPath(): string {
    return daemonEndpoint(this.stateDir).connectPath;
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; protocolVersion?: number } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const version = options.protocolVersion ?? DAEMON_PROTOCOL_VERSION;
    const id = randomUUID();
    const endpoint = daemonEndpoint(this.stateDir);
    return new Promise<T>((resolveReq, rejectReq) => {
      let settled = false;
      let socketRef: ReturnType<typeof connectDaemon> | null = null;
      const finish = (error: Error | null, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socketRef?.destroy();
        if (error) rejectReq(error);
        else resolveReq(value as T);
      };
      const timer = setTimeout(() => {
        finish(new Error(`Daemon RPC timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);

      const socket = connectDaemon(endpoint.connectPath, {
        ...(endpoint.proofPath ? { proofPath: endpoint.proofPath } : {}),
      });
      socketRef = socket;
      let buffer = "";
      socket.setEncoding("utf8");
      socket.once("error", (error: Error) => finish(error));
      socket.once("close", () => {
        if (!settled) finish(new Error(`Daemon RPC socket closed before response: ${method}`));
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        try {
          const response = JSON.parse(line) as { ok?: boolean; result?: T; error?: string };
          if (!response.ok) finish(new Error(response.error || `Daemon RPC failed: ${method}`));
          else finish(null, response.result);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.once("connect", () => {
        const frame = params === undefined
          ? { version, id, method }
          : { version, id, method, params };
        socket.write(`${JSON.stringify(frame)}\n`);
      });
    });
  }

  status(): Promise<EdgeDaemonStatus> {
    return this.request<EdgeDaemonStatus>("daemon.status", undefined, { timeoutMs: 5_000 });
  }

  negotiate(): Promise<EdgeDaemonStatus> {
    return this.request<EdgeDaemonStatus>("daemon.negotiate", undefined, { timeoutMs: 5_000 });
  }

  prepareHandoff(timeoutMs = 45_000): Promise<{ accepted: true; generation: number }> {
    return this.request("daemon.prepare_handoff", undefined, { timeoutMs });
  }

  listManifest(params?: { room_id?: string; activity?: "full" | "summary" }): Promise<EdgeManifestEntryView[]> {
    return this.request("manifest.list", params);
  }

  getEntry(entryId: string): Promise<EdgeManifestEntryView | null> {
    return this.request("manifest.get_entry", { entry_id: entryId });
  }

  putEntry(entry: Record<string, unknown>): Promise<EdgeManifestEntryView> {
    return this.request("manifest.put", { entry });
  }

  setDesiredState(id: string, desiredState: "running" | "paused" | "stopped"): Promise<EdgeManifestEntryView> {
    return this.request("manifest.set_desired_state", { id, desired_state: desiredState });
  }

  watchState(params: {
    after_daemon_generation?: number;
    after_sequence?: number;
    wait_ms?: number;
    changed_only?: boolean;
  } = {}): Promise<EdgeWatchStateResult> {
    const waitMs = params.wait_ms ?? 5_000;
    return this.request("manifest.watch_state", params, { timeoutMs: waitMs + 10_000 });
  }

  /**
   * Resolves either a synchronous legacy daemon reply or an asynchronous
   * `{ effect_id, daemon_generation }` acknowledgement delivered through
   * `manifest.watch_state` (`rpc_effects`), keeping upgrade-rig compatibility
   * with older baseline daemons.
   */
  async awaitAsyncRpcEffect<T>(method: string, response: unknown, timeoutMs = 60_000): Promise<T> {
    if (!isDaemonAsyncRpcAccepted(response)) {
      return response as T;
    }
    const deadline = Date.now() + timeoutMs;
    let afterGen = 0;
    let afterSeq = 0;
    while (Date.now() < deadline) {
      const remaining = Math.max(100, Math.min(5_000, deadline - Date.now()));
      const initial = afterGen === 0;
      const snapshot = await this.watchState({
        after_daemon_generation: afterGen,
        after_sequence: afterSeq,
        wait_ms: initial ? 0 : remaining,
        changed_only: !initial,
      });
      if (snapshot.daemon_generation !== response.daemon_generation) {
        throw new Error(
          `Supervisor daemon generation changed from ${response.daemon_generation} to ${snapshot.daemon_generation} while waiting for ${method} (${response.effect_id}).`,
        );
      }
      const match = snapshot.rpc_effects?.find((effect) => effect.effect_id === response.effect_id);
      const isCompleteSnapshot = snapshot.complete !== false;
      const resolvedEffect = match
        ?? (isCompleteSnapshot
          ? await this.request<DaemonRpcEffectView | null>("supervisor.get_rpc_effect", {
            effect_id: response.effect_id,
            daemon_generation: response.daemon_generation,
          }, { timeoutMs: 5_000 })
          : null);
      if (resolvedEffect) {
        if (resolvedEffect.state === "completed") return resolvedEffect.result as T;
        if (resolvedEffect.state === "failed" || resolvedEffect.state === "uncertain") {
          throw new Error(
            resolvedEffect.error
              || `Daemon RPC effect ${method} (${response.effect_id}) ended in state ${resolvedEffect.state}.`,
          );
        }
      } else if (isCompleteSnapshot) {
        throw new Error(
          `Supervisor daemon has no record of async RPC effect ${response.effect_id} for generation ${response.daemon_generation}.`,
        );
      }
      const noProgress = !initial && snapshot.daemon_generation === afterGen && snapshot.sequence === afterSeq;
      afterGen = snapshot.daemon_generation;
      afterSeq = snapshot.sequence;
      if (noProgress) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      }
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for async RPC effect ${method} (${response.effect_id}).`);
  }

  async installHostGrant(params: Record<string, unknown>): Promise<{ status: string; agent_session_id?: string }> {
    const raw = await this.request("supervisor.install_host_grant", params, { timeoutMs: 60_000 });
    return this.awaitAsyncRpcEffect("supervisor.install_host_grant", raw, 60_000);
  }

  installOpenModelCredential(params: Record<string, unknown>): Promise<{ status: string }> {
    return this.request("supervisor.install_open_model_credential", params, { timeoutMs: 15_000 });
  }

  async bootstrapRoomIngress(params: {
    entry_id: string;
    daemon_generation: number;
    initial_message?: string;
  }): Promise<{ status: string; last_observed_message_id: string | null }> {
    const raw = await this.request("supervisor.bootstrap_room_ingress", params, { timeoutMs: 45_000 });
    return this.awaitAsyncRpcEffect("supervisor.bootstrap_room_ingress", raw, 45_000);
  }

  controlTurn(params: {
    id: string;
    daemon_generation: number;
    room_id: string;
    work_attempt_id: string;
    execution_generation_id: string;
    provider_continuation_id: string;
    provider_turn_id: string;
    inbox_item_id: string;
    source_message_id: string;
    action_id: string;
    action_sequence: number;
    correction: string | null;
  }): Promise<Record<string, unknown>> {
    return this.request("manifest.control_turn", params, { timeoutMs: 20_000 });
  }

  hostApprovalChallenge(): Promise<EdgeHostApprovalChallenge | null> {
    return this.request("supervisor.host_approval_challenge");
  }

  private async signedHostApprovalRequest<T>(operation: string, input: unknown): Promise<T> {
    const challenge = await this.hostApprovalChallenge();
    if (!challenge) {
      throw new Error("Host approvals are unavailable on this daemon (no Ed25519 verifier enrolled).");
    }
    const issuedAt = Date.now();
    const payload = JSON.stringify({
      domain: "letagents.host-approval",
      version: 1,
      daemonGeneration: challenge.daemonGeneration,
      bootNonce: challenge.bootNonce,
      keyFingerprint: challenge.keyFingerprint,
      issuedAt,
      expiresAt: issuedAt + 25_000,
      operation,
      input,
    });
    const signature = sign(null, Buffer.from(payload, "utf8"), this.approvalKeyPair.privateKey).toString("base64");
    return this.request<T>("supervisor.host_approval_request", { payload, signature }, { timeoutMs: 20_000 });
  }

  listHostApprovals(roomId: string): Promise<EdgeHostApprovalCandidate[]> {
    return this.signedHostApprovalRequest("list", { roomId });
  }

  decideHostApproval(
    candidate: EdgeHostApprovalCandidate,
    decision: "allow_once" | "deny" | "allow_always",
    decisionId = randomUUID(),
  ): Promise<string> {
    const projectionSha256 = createHash("sha256")
      .update(JSON.stringify(candidate.presentation))
      .digest("hex");
    return this.signedHostApprovalRequest("decide", {
      expected: candidate.reference,
      decisionId,
      actorId: `host-${this.approvalKeyPair.keyFingerprint}`,
      decision,
      projectionSha256,
    });
  }
}

export class EdgeDaemonHarness {
  readonly stateDir: string;
  readonly databasePath: string;
  readonly binDir: string;
  readonly workspaceDir: string;
  readonly rpc: EdgeDaemonClient;
  readonly shimPaths: Readonly<Record<string, string>>;
  private activeDaemon: ManagedDaemonProcess | null = null;
  private readonly allProcesses: ManagedDaemonProcess[] = [];
  private readonly extraCleanup: Array<() => Promise<void> | void> = [];
  private readonly trackedProviderPids = new Set<number>();
  private readonly recoveryKeyBase64 = randomBytes(32).toString("base64");
  private disposed = false;

  constructor(
    readonly homeDir: string,
    readonly roomServer: FakeRoomServer,
    readonly devMcpEntryPath: string,
    private readonly baseCommand: EdgeDaemonCommand,
    private readonly baseEnv: Record<string, string>,
    private readonly readyTimeoutMs: number,
    private readonly keepHome: boolean,
    private readonly approvalKeyPair: { publicKeyBase64: string; privateKey: KeyObject; keyFingerprint: string },
    shimPaths: Record<string, string>,
    private readonly listProcesses: (extraPids?: Iterable<number>) => ProcessSnapshotEntry[] = listOsProcesses,
  ) {
    this.stateDir = join(homeDir, ".letagents");
    this.databasePath = join(this.stateDir, "daemon-state.sqlite");
    this.binDir = join(homeDir, "bin");
    this.workspaceDir = join(homeDir, "workspace");
    this.shimPaths = Object.freeze({ ...shimPaths });
    this.rpc = new EdgeDaemonClient(this.stateDir, approvalKeyPair);
  }

  get daemonPid(): number | null {
    return this.activeDaemon?.child.pid ?? null;
  }

  daemonOutput(): { stdout: string; stderr: string } {
    return {
      stdout: this.activeDaemon?.stdout.join("") ?? "",
      stderr: this.activeDaemon?.stderr.join("") ?? "",
    };
  }

  onDispose(cleanup: () => Promise<void> | void): void {
    this.extraCleanup.push(cleanup);
  }

  async addShim(
    name: string,
    scriptPath: string,
    options?: MaterializeNodeShimOptions,
  ): Promise<string> {
    return materializeNodeShim(this.binDir, name, scriptPath, {
      ...options,
      nodeBin: options?.nodeBin ?? resolveStandInRuntime(this.baseCommand, {
        env: daemonLaunchEnvironment(this.baseEnv, this.baseCommand),
        cwd: DAEMON_LAUNCH_FOLDER,
      }),
    });
  }

  openSqlite(): EdgeSqliteInspector {
    return new EdgeSqliteInspector(this.databasePath);
  }

  async readLifecycleLog(): Promise<Array<Record<string, unknown>>> {
    const logPath = join(this.stateDir, "daemon-lifecycle.jsonl");
    try {
      const raw = await readFile(logPath, "utf8");
      return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async startDaemonProcess(extraEnv: Record<string, string> = {}): Promise<EdgeDaemonStatus> {
    const command = this.baseCommand;
    const useNodeIpc = command.useNodeIpc !== false;
    const mergedEnv = daemonLaunchEnvironment(this.baseEnv, command, extraEnv);
    const child = spawn(command.command, command.args, {
      cwd: DAEMON_LAUNCH_FOLDER,
      env: mergedEnv,
      windowsHide: true,
      stdio: useNodeIpc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => stderr.push(chunk));

    if (useNodeIpc) {
      child.on("message", (raw: unknown) => {
        if (!raw || typeof raw !== "object" || !child.connected) return;
        const msg = raw as Record<string, unknown>;
        if (msg.type === "host_approval_verifier_request" && typeof msg.id === "string") {
          child.send({
            type: "host_approval_verifier",
            id: msg.id,
            publicKey: this.approvalKeyPair.publicKeyBase64,
          });
        } else if (msg.type === "state_recovery_key_request" && typeof msg.id === "string") {
          child.send({
            type: "state_recovery_key",
            id: msg.id,
            key: this.recoveryKeyBase64,
            sealedKey: "edge-sealed-recovery-key",
          });
        }
      });
    }

    const managed: ManagedDaemonProcess = {
      child,
      stdout,
      stderr,
      exitInfo: null,
      exited: new Promise((resolveExit) => {
        child.once("exit", (code, signal) => {
          managed.exitInfo = { code, signal };
          resolveExit(managed.exitInfo);
        });
        child.once("error", () => {
          managed.exitInfo = { code: -1, signal: null };
          resolveExit(managed.exitInfo);
        });
      }),
    };
    this.activeDaemon = managed;
    this.allProcesses.push(managed);

    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (managed.exitInfo) {
        throw new Error(
          `Daemon exited before becoming ready (code=${managed.exitInfo.code}, signal=${managed.exitInfo.signal}).\nstdout:\n${stdout.join("")}\nstderr:\n${stderr.join("")}`,
        );
      }
      try {
        const status = await this.rpc.status();
        if (status.healthy && status.pid === child.pid) {
          return status;
        }
      } catch {
        // Still booting
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    }
    throw new Error(
      `Timed out after ${this.readyTimeoutMs}ms waiting for daemon readiness.\nstdout:\n${stdout.join("")}\nstderr:\n${stderr.join("")}`,
    );
  }

  /**
   * Register and start a `daemon_inbox` agent purely via control-socket RPCs:
   * `manifest.put` -> optional `supervisor.install_open_model_credential`
   * -> `supervisor.install_host_grant` -> `supervisor.bootstrap_room_ingress`.
   */
  async startAgent(config: EdgeAgentRegistration): Promise<{
    daemonGeneration: number;
    entry: EdgeManifestEntryView;
    grant: {
      entry_id: string;
      room_id: string;
      agent_key: string;
      grant_id: string;
      supervisor_grant: string;
      grant_generation: number;
      api_url: string;
    };
  }> {
    const status = await this.rpc.status();
    const daemonGeneration = status.generation;
    const entry = await this.rpc.putEntry({
      id: config.entryId,
      room_id: config.roomId,
      display_name: config.displayName ?? `Edge ${config.provider}`,
      provider: config.provider,
      model: config.model ?? null,
      charter: config.charter ?? "Respond concisely in edge tests.",
      desired_state: "running",
      observed_state: "absent",
      condition: "none",
      permission_profile_id: config.permissionProfileId ?? null,
      delivery_mode: "daemon_inbox",
      ...(config.providerLaunchPolicy ? { provider_launch_policy: config.providerLaunchPolicy } : {}),
      created_by: "edge-test",
      created_at: new Date().toISOString(),
      source_repo_path: config.sourceRepoPath ?? null,
      workspace_path: null,
      work_attempt_id: null,
      last_worker_binding: null,
      activity: [],
    });

    if (config.openModelCredential) {
      const credRes = await this.rpc.installOpenModelCredential({
        entry_id: config.entryId,
        api_key: config.openModelCredential.apiKey,
        base_url: config.openModelCredential.baseUrl,
        model: config.openModelCredential.model,
        ...(config.openModelCredential.contextWindow !== undefined
          ? { context_window: config.openModelCredential.contextWindow }
          : {}),
        daemon_generation: daemonGeneration,
      });
      if (credRes.status !== "installed") {
        throw new Error(`Expected open-model credential installed, got ${JSON.stringify(credRes)}`);
      }
    }

    const grantParams = {
      entry_id: config.entryId,
      room_id: config.roomId,
      agent_key: config.agentKey ?? `agent-${config.entryId}`,
      grant_id: config.grantId ?? `grant-${config.entryId}`,
      supervisor_grant: config.supervisorGrant ?? `sup_grant_${config.entryId}`,
      grant_generation: config.grantGeneration ?? 1,
      api_url: this.roomServer.apiUrl,
      host_id: "host-edge-1",
      installation_id: "inst-edge-1",
      owner_account_id: null,
      scope_key: null,
      grant_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      daemon_generation: daemonGeneration,
      credential_only: false,
      recovery_only: false,
    };
    const grantRes = await this.rpc.installHostGrant(grantParams);
    if (grantRes.status !== "installed") {
      throw new Error(`Expected host grant installed, got ${JSON.stringify(grantRes)}`);
    }

    const bootstrapRes = await this.rpc.bootstrapRoomIngress({
      entry_id: config.entryId,
      daemon_generation: daemonGeneration,
      ...(config.initialMessage !== undefined ? { initial_message: config.initialMessage } : {}),
    });
    if (bootstrapRes.status !== "bootstrapped" && bootstrapRes.status !== "existing") {
      throw new Error(`Expected bootstrapped room ingress, got ${JSON.stringify(bootstrapRes)}`);
    }

    return {
      daemonGeneration,
      entry,
      grant: {
        entry_id: grantParams.entry_id,
        room_id: grantParams.room_id,
        agent_key: grantParams.agent_key,
        grant_id: grantParams.grant_id,
        supervisor_grant: grantParams.supervisor_grant,
        grant_generation: grantParams.grant_generation,
        api_url: grantParams.api_url,
      },
    };
  }

  /** Re-install in-memory credentials (host grant + optional open-model credential) after restart/handoff. */
  async reinstallCredentials(
    config: EdgeAgentRegistration,
    daemonGeneration: number,
  ): Promise<void> {
    if (config.openModelCredential) {
      const credRes = await this.rpc.installOpenModelCredential({
        entry_id: config.entryId,
        api_key: config.openModelCredential.apiKey,
        base_url: config.openModelCredential.baseUrl,
        model: config.openModelCredential.model,
        ...(config.openModelCredential.contextWindow !== undefined
          ? { context_window: config.openModelCredential.contextWindow }
          : {}),
        daemon_generation: daemonGeneration,
      });
      if (credRes.status !== "installed") {
        throw new Error(`Expected open-model credential reinstalled, got ${JSON.stringify(credRes)}`);
      }
    }
    const grantRes = await this.rpc.installHostGrant({
      entry_id: config.entryId,
      room_id: config.roomId,
      agent_key: config.agentKey ?? `agent-${config.entryId}`,
      grant_id: config.grantId ?? `grant-${config.entryId}`,
      supervisor_grant: config.supervisorGrant ?? `sup_grant_${config.entryId}`,
      grant_generation: config.grantGeneration ?? 1,
      api_url: this.roomServer.apiUrl,
      host_id: "host-edge-1",
      installation_id: "inst-edge-1",
      owner_account_id: null,
      scope_key: null,
      grant_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      daemon_generation: daemonGeneration,
      credential_only: false,
      recovery_only: false,
    });
    if (grantRes.status !== "installed") {
      throw new Error(`Expected host grant reinstalled, got ${JSON.stringify(grantRes)}`);
    }
  }

  /** Observe `manifest.watch_state` until `predicate` matches the target entry. */
  async waitForEntry(
    entryId: string,
    predicate: (entry: EdgeManifestEntryView) => boolean,
    timeoutMs = 20_000,
    description = `entry ${entryId} state`,
    options: { failOnStartError?: boolean } = {},
  ): Promise<EdgeManifestEntryView> {
    const failOnStartError = options.failOnStartError !== false;
    const deadline = Date.now() + timeoutMs;
    let afterGen = 0;
    let afterSeq = 0;
    let lastSeen: EdgeManifestEntryView | undefined;
    while (Date.now() < deadline) {
      const remaining = Math.max(100, Math.min(2_000, deadline - Date.now()));
      try {
        const snapshot = await this.rpc.watchState({
          after_daemon_generation: afterGen,
          after_sequence: afterSeq,
          wait_ms: remaining,
          changed_only: false,
        });
        afterGen = snapshot.daemon_generation;
        afterSeq = snapshot.sequence;
        const entry = snapshot.entries.find((item) => item.id === entryId);
        if (entry) {
          const pid = entry.provider_ref?.provider_connection?.pid;
          if (typeof pid === "number" && Number.isInteger(pid) && pid > 1) {
            this.trackedProviderPids.add(pid);
          }
          lastSeen = entry;
          if (predicate(entry)) return entry;
          if (
            failOnStartError &&
            entry.observed_state === "starting" &&
            typeof entry.last_error === "string" &&
            entry.last_error.trim().length > 0
          ) {
            throw new Error(
              `Agent ${entryId} reported a start error while waiting for ${description}: ${entry.last_error}\nLast entry: ${JSON.stringify(entry)}`,
            );
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(`Agent ${entryId} reported a start error`)) {
          throw error;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for ${description}. Last entry: ${JSON.stringify(lastSeen)}\nDaemon stderr:\n${this.daemonOutput().stderr}`,
    );
  }

  async waitForApproval(
    roomId: string,
    predicate: (candidate: EdgeHostApprovalCandidate) => boolean = (c) => c.status === "pending",
    timeoutMs = 15_000,
  ): Promise<EdgeHostApprovalCandidate> {
    const deadline = Date.now() + timeoutMs;
    let lastList: EdgeHostApprovalCandidate[] = [];
    while (Date.now() < deadline) {
      lastList = await this.rpc.listHostApprovals(roomId);
      const match = lastList.find(predicate);
      if (match) return match;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for host approval in ${roomId}. Last list: ${JSON.stringify(lastList)}`,
    );
  }

  /** Hard-kill the active daemon process (default SIGKILL) without graceful handoff. */
  async kill(signal: NodeJS.Signals = "SIGKILL"): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const current = this.activeDaemon;
    if (!current) throw new Error("No active daemon process to kill.");
    if (!current.exitInfo) {
      try { current.child.kill(signal); } catch { /* already gone */ }
    }
    const result = await current.exited;
    this.activeDaemon = null;
    return result;
  }

  /** Start a fresh daemon process on the same isolated home after a crash/kill. */
  async restart(extraEnv: Record<string, string> = {}): Promise<EdgeDaemonStatus> {
    if (this.activeDaemon && !this.activeDaemon.exitInfo) {
      await this.kill("SIGKILL");
    }
    return this.startDaemonProcess(extraEnv);
  }

  /** Perform a real update handoff: `daemon.prepare_handoff` -> wait for exit -> spawn successor daemon. */
  async handoffToSuccessor(extraEnv: Record<string, string> = {}): Promise<{
    predecessorExit: { code: number | null; signal: NodeJS.Signals | null };
    predecessorGeneration: number;
    successorStatus: EdgeDaemonStatus;
  }> {
    const predecessor = this.activeDaemon;
    if (!predecessor) throw new Error("No active daemon process for handoff.");
    const reply = await this.rpc.prepareHandoff();
    const predecessorExit = await Promise.race([
      predecessor.exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Predecessor daemon did not exit after prepare_handoff.")), 15_000)),
    ]);
    this.activeDaemon = null;
    const successorStatus = await this.startDaemonProcess(extraEnv);
    return {
      predecessorExit,
      predecessorGeneration: reply.generation,
      successorStatus,
    };
  }

  /** Alias for `handoffToSuccessor`. */
  spawnSuccessor(extraEnv: Record<string, string> = {}) {
    return this.handoffToSuccessor(extraEnv);
  }

  /** Register an extra detached provider PID so `dispose()` guarantees it is terminated. */
  trackProviderPid(pid: number | null | undefined): void {
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
      this.trackedProviderPids.add(pid);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    let cleanupError: Error | null = null;
    let verifiedClean = false;
    try {
      // Collect any live provider PIDs from the daemon before tearing down.
      if (this.activeDaemon && !this.activeDaemon.exitInfo) {
        try {
          const entries = await this.rpc.listManifest().catch(() => []);
          for (const entry of entries) {
            this.trackProviderPid(entry.provider_ref?.provider_connection?.pid);
            if (entry.desired_state !== "stopped") {
              await this.rpc.setDesiredState(entry.id, "stopped").catch(() => undefined);
            }
          }
          await this.rpc.prepareHandoff(3_000).catch(() => undefined);
          await Promise.race([
            this.activeDaemon.exited,
            new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
          ]);
        } catch {
          // Fall through to force kill below.
        }
      }
      for (const proc of this.allProcesses) {
        if (!proc.exitInfo) {
          try { proc.child.kill("SIGKILL"); } catch { /* already exited */ }
          await Promise.race([
            proc.exited,
            new Promise((resolveWait) => setTimeout(resolveWait, 1_000)),
          ]);
        }
      }

      const normalizedHome = this.homeDir.replaceAll("\\", "/").toLowerCase();
      const extraTrackedPids = new Set<number>(this.trackedProviderPids);
      for (const proc of this.allProcesses) {
        if (proc.child.pid) extraTrackedPids.add(proc.child.pid);
      }
      let snapshot: ProcessSnapshotEntry[] = [];
      try {
        snapshot = this.listProcesses(extraTrackedPids);
      } catch (error) {
        cleanupError = new Error(
          `Edge harness dispose could not verify process cleanup for ${this.homeDir}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      if (!cleanupError) {
        const byPid = new Map(snapshot.map((entry) => [entry.pid, entry]));
        const childrenByParent = new Map<number, ProcessSnapshotEntry[]>();
        for (const entry of snapshot) {
          const list = childrenByParent.get(entry.ppid) ?? [];
          list.push(entry);
          childrenByParent.set(entry.ppid, list);
        }

        const targetsByPid = new Map<number, { pid: number; pgid?: number }>();
        const addTargetWithDescendants = (rootPid: number) => {
          if (rootPid <= 1 || rootPid === process.pid || targetsByPid.has(rootPid)) return;
          const info = byPid.get(rootPid);
          targetsByPid.set(rootPid, { pid: rootPid, pgid: info?.pgid });
          for (const child of childrenByParent.get(rootPid) ?? []) {
            addTargetWithDescendants(child.pid);
          }
        };

        // 1. Any daemon child process that is somehow still alive after SIGKILL.
        for (const proc of this.allProcesses) {
          const pid = proc.child.pid;
          if (pid && isPidAlive(pid)) {
            addTargetWithDescendants(pid);
          }
        }

        // 2. Tracked provider PIDs whose command line references this isolated home (or that have a child referencing it).
        //    If a tracked live PID is omitted from the snapshot or its command line is unreadable,
        //    fail cleanup verification closed instead of assuming it is unrelated.
        const unverifiableTrackedPids: number[] = [];
        for (const pid of this.trackedProviderPids) {
          if (!isPidAlive(pid)) continue;
          const info = byPid.get(pid);
          if (!info || info.commandLineUnreadable || !info.command) {
            unverifiableTrackedPids.push(pid);
            continue;
          }
          const directMatch = info.command.replaceAll("\\", "/").toLowerCase().includes(normalizedHome);
          const childMatch = (childrenByParent.get(pid) ?? []).some(
            (child) => !child.commandLineUnreadable && child.command.replaceAll("\\", "/").toLowerCase().includes(normalizedHome),
          );
          if (directMatch || childMatch) addTargetWithDescendants(pid);
        }
        const unreadableEntries = snapshot.filter((entry) => entry.pid !== process.pid && entry.commandLineUnreadable);

        // 3. Any remaining OS process whose command line references this isolated temp home
        // (including detached provider servers and MCP stub children spawned under this home).
        for (const entry of snapshot) {
          if (entry.pid === process.pid || entry.commandLineUnreadable) continue;
          if (!entry.command.replaceAll("\\", "/").toLowerCase().includes(normalizedHome)) continue;
          addTargetWithDescendants(entry.pid);
          // If an edge dev-mcp stub child points to this temp home, also stop its detached provider parent.
          const parent = byPid.get(entry.ppid);
          if (
            parent &&
            parent.pid > 1 &&
            parent.pid !== process.pid &&
            entry.command.replaceAll("\\", "/").toLowerCase().includes("/dev-mcp/server.mjs") &&
            /\b(?:opencode|codex)\b/i.test(parent.command)
          ) {
            addTargetWithDescendants(parent.pid);
          }
        }

        if (targetsByPid.size > 0) {
          await terminateProcessTrees([...targetsByPid.values()]);
        }

        if (unverifiableTrackedPids.length > 0 || unreadableEntries.length > 0) {
          const detail = [
            ...(unverifiableTrackedPids.length > 0
              ? [`unverifiable live tracked pid(s): ${unverifiableTrackedPids.join(", ")}`]
              : []),
            ...(unreadableEntries.length > 0
              ? [
                  `unreadable commandLine pid(s): ${unreadableEntries
                    .map(
                      (e) =>
                        `${e.pid}(ppid=${e.ppid},tracked=${extraTrackedPids.has(e.pid)},alive=${isPidAlive(e.pid)},exited=${String(e.helperExited ?? null)}${e.image ? `,image=${e.image}` : ""})`,
                    )
                    .join(", ")}`,
                ]
              : []),
          ].join("; ");
          cleanupError = new Error(
            `Edge harness dispose could not verify process cleanup for ${this.homeDir}: ${detail}`,
          );
        } else if (targetsByPid.size === 0) {
          // The initial snapshot already confirmed zero live daemon PIDs, readable info for all
          // live tracked PIDs, and zero processes referencing this isolated home.
          verifiedClean = true;
          this.trackedProviderPids.clear();
        } else {
          // 4. Re-scan after termination; only run a third verification pass if stragglers were found.
          try {
            let remaining = findProcessesReferencingPath(this.homeDir, this.listProcesses, extraTrackedPids);
            if (remaining.length > 0) {
              await terminateProcessTrees(remaining.map((entry) => ({ pid: entry.pid, pgid: entry.pgid })));
              remaining = findProcessesReferencingPath(this.homeDir, this.listProcesses, extraTrackedPids);
            }
            const survivingTargets = [...targetsByPid.keys()].filter((pid) => isPidAlive(pid));
            const survivingDaemons = this.allProcesses
              .map((proc) => proc.child.pid)
              .filter((pid): pid is number => typeof pid === "number" && isPidAlive(pid));
            const survivingPids = [...new Set([...survivingTargets, ...survivingDaemons])].filter(
              (pid) => !remaining.some((entry) => entry.pid === pid),
            );
            if (remaining.length > 0 || survivingPids.length > 0) {
              const detail = [
                ...remaining.map((entry) => `pid=${entry.pid} cmd=${entry.command}`),
                ...survivingPids.map((pid) => `pid=${pid} (still alive)`),
              ].join("; ");
              cleanupError = new Error(
                `Edge harness dispose left live processes referencing ${this.homeDir}: ${detail}`,
              );
            } else {
              verifiedClean = true;
              this.trackedProviderPids.clear();
            }
          } catch (error) {
            cleanupError = new Error(
              `Edge harness dispose failed final survivor verification for ${this.homeDir}: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }
        }
      }
    } finally {
      for (const fn of this.extraCleanup.splice(0)) {
        try { await fn(); } catch { /* best effort */ }
      }
      await this.roomServer.close().catch(() => undefined);
      if (verifiedClean) {
        this.disposed = true;
        if (!this.keepHome) {
          await rm(this.homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }).catch(() => undefined);
        }
      }
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }
}

/**
 * Start a real, black-box supervisor daemon process in a fully isolated temp
 * home directory with an in-process fake room HTTP server and optional fake
 * provider executables.
 */
export async function startEdgeDaemon(options: EdgeDaemonOptions = {}): Promise<EdgeDaemonHarness> {
  if (EDGE_DAEMON_UNSUPPORTED_REASON && !options.daemonCommand && !process.env.LETAGENTS_EDGE_DAEMON_CMD?.trim()) {
    throw new Error(EDGE_DAEMON_UNSUPPORTED_REASON);
  }
  // Resolve the daemon command before allocating temp directories or sockets
  // so missing builds fail fast without leaking resources.
  const command = options.daemonCommand ?? resolveDefaultDaemonCommand();
  const baseTempDir = options.tempRoot ? resolve(options.tempRoot) : tmpdir();
  await mkdir(baseTempDir, { recursive: true });
  const homeDir = await realpath(await mkdtemp(join(baseTempDir, "letagents-edge-")));
  const roomServer = new FakeRoomServer();
  let harness: EdgeDaemonHarness | null = null;
  try {
    const binDir = join(homeDir, "bin");
    const workspaceDir = join(homeDir, "workspace");
    const devMcpDir = join(homeDir, "dev-mcp");
    const appDataDir = join(homeDir, "AppData", "Roaming");
    const localAppDataDir = join(homeDir, "AppData", "Local");
    const xdgConfigDir = join(homeDir, ".config");
    const xdgDataDir = join(homeDir, ".local", "share");
    const xdgStateDir = join(homeDir, ".local", "state");
    const xdgCacheDir = join(homeDir, ".cache");
    await Promise.all([
      mkdir(binDir, { recursive: true }),
      mkdir(workspaceDir, { recursive: true }),
      mkdir(appDataDir, { recursive: true }),
      mkdir(localAppDataDir, { recursive: true }),
      mkdir(xdgConfigDir, { recursive: true }),
      mkdir(xdgDataDir, { recursive: true }),
      mkdir(xdgStateDir, { recursive: true }),
      mkdir(xdgCacheDir, { recursive: true }),
    ]);

    const apiUrl = await roomServer.start();
    const devMcpEntryPath = await materializeDevMcpPackage(devMcpDir);

    const existingPath = process.env.PATH ?? process.env.Path ?? "";
    const prependedPath = existingPath ? `${binDir}${delimiter}${existingPath}` : binDir;
    const pathEnv: Record<string, string> = {
      PATH: prependedPath,
      ...(process.platform === "win32" ? { Path: prependedPath } : {}),
    };
    // The stand-in program is the daemon's program. Find the daemon command as the start of the daemon
    // finds it: with the daemon's own PATH (the command and the options can change it) and folder.
    const standInRuntime = resolveStandInRuntime(command, {
      env: daemonLaunchEnvironment({ ...pathEnv, ...(options.env ?? {}) }, command),
      cwd: DAEMON_LAUNCH_FOLDER,
    });
    const shimPaths: Record<string, string> = {};
    const shimEnv: Record<string, string> = {};
    for (const shim of options.shims ?? []) {
      const path = await materializeNodeShim(binDir, shim.name, shim.scriptPath, {
        env: {
          LETAGENTS_EDGE_TEST_RUNNER_PID: String(process.pid),
          ...(shim.env ?? {}),
        },
        nodeArgs: shim.nodeArgs,
        copyScript: shim.copyScript,
        // The daemon's sandbox admits the daemon's own program only: see resolveStandInRuntime.
        nodeBin: standInRuntime,
      });
      shimPaths[shim.name] = path;
      if (shim.envVar) shimEnv[shim.envVar] = path;
    }

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const publicKeyBase64 = spkiDer.toString("base64");
    const keyFingerprint = createHash("sha256").update(spkiDer).digest("hex");

    const windowsHelper = process.platform === "win32"
      ? (process.env.LETAGENTS_PROCESS_TREE_HELPER?.trim() || process.env.LETAGENTS_TEST_PROCESS_TREE_HELPER?.trim() || "")
      : "";
    const baseEnv: Record<string, string> = {
      HOME: homeDir,
      USERPROFILE: homeDir,
      APPDATA: appDataDir,
      LOCALAPPDATA: localAppDataDir,
      XDG_CONFIG_HOME: xdgConfigDir,
      XDG_DATA_HOME: xdgDataDir,
      XDG_STATE_HOME: xdgStateDir,
      XDG_CACHE_HOME: xdgCacheDir,
      ...pathEnv,
      ...(windowsHelper ? { LETAGENTS_PROCESS_TREE_HELPER: windowsHelper } : {}),
      LETAGENTS_API_URL: apiUrl,
      LETAGENTS_POLL_MAX_MS: "5000",
      LETAGENTS_DESKTOP_DEV_SERVER_URL: "http://127.0.0.1:5174",
      LETAGENTS_DEV_MCP_SERVER_ENTRY: devMcpEntryPath,
      ...shimEnv,
      ...(options.env ?? {}),
    };

    const readyTimeoutMs = options.readyTimeoutMs ?? (process.platform === "win32" ? 30_000 : 15_000);
    harness = new EdgeDaemonHarness(
      homeDir,
      roomServer,
      devMcpEntryPath,
      command,
      baseEnv,
      readyTimeoutMs,
      options.keepHome === true,
      { publicKeyBase64, privateKey, keyFingerprint },
      shimPaths,
      options.listProcesses ?? listOsProcesses,
    );

    await harness.startDaemonProcess();
    return harness;
  } catch (error) {
    if (harness) {
      try {
        await harness.dispose();
      } catch (disposeError) {
        const startMessage = error instanceof Error ? error.message : String(error);
        const disposeMessage = disposeError instanceof Error ? disposeError.message : String(disposeError);
        throw new Error(`${startMessage} (cleanup also failed: ${disposeMessage})`, { cause: error });
      }
    } else {
      await roomServer.close().catch(() => undefined);
      if (options.keepHome !== true) {
        await rm(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }).catch(() => undefined);
      }
    }
    throw error;
  }
}
