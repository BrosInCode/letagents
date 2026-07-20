import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { EventEmitter } from "node:events";

import type {
  DesktopSupervisorActivityEvent,
  DesktopSupervisorAttemptDetail,
  DesktopSupervisorCreateInput,
  DesktopSupervisorDaemonStatus,
  DesktopSupervisorDesiredState,
  DesktopSupervisorManifestEntry,
  DesktopSupervisorRoomDeliveryRetryInput,
  DesktopSupervisorTurnControlInput,
  DesktopSupervisorTurnControlResolutionInput,
  DesktopSupervisorTurnControlResult,
} from "../ipc-types.js";
import { desktopRoot, workspaceRoot } from "./paths.js";
import { defaultGetProcessIdentity, redactCredentialText, safeStreamPayload } from "./agents/provider-evidence.js";

export const SUPERVISOR_DAEMON_PROTOCOL_VERSION = 2;
// Keep in sync with daemon/types.ts. Protocol compatibility permits a clean
// handoff; implementation equality decides whether the already-running daemon
// actually contains this desktop build's fixes.
export const SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION = "2.0.27";
const REQUEST_TIMEOUT_MS = 3_000;
const TURN_CONTROL_REQUEST_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 8_000;
const NATURAL_EXIT_TIMEOUT_MS = 2_000;
const TERMINATE_EXIT_TIMEOUT_MS = 2_000;
const KILL_EXIT_TIMEOUT_MS = 1_000;
const PROCESS_POLL_INTERVAL_MS = 25;
const activityEmitter = new EventEmitter();
const activitySequences = new Map<string, number>();

type WireResponse = { version: number; id?: string; ok: boolean; result?: unknown; error?: string };
type WireEntry = {
  id: string;
  room_id: string;
  display_name: string;
  provider: string;
  model: string | null;
  charter: string;
  desired_state: DesktopSupervisorDesiredState;
  observed_state: DesktopSupervisorManifestEntry["observedState"];
  condition: DesktopSupervisorManifestEntry["condition"];
  last_error?: string | null;
  permission_profile_id: string | null;
  delivery_mode?: "mcp_polling" | "desktop_events" | "daemon_inbox";
  provider_launch_policy?: unknown;
  created_by: string;
  created_at: string;
  source_repo_path?: string | null;
  workspace_path?: string | null;
  work_attempt_id?: string | null;
  provider_ref?: {
    provider_continuation_id: string;
    execution_generation_id: string;
    provider_connection?: { pid?: number | null } | null;
  } | null;
  worker_binding?: {
    agent_session_id: string;
    work_attempt_id: string;
    execution_generation_id: string;
    updated_at: string;
  } | null;
  last_worker_binding?: {
    agent_session_id: string;
    work_attempt_id: string;
    execution_generation_id: string;
    updated_at: string;
  } | null;
  workplace_liveness?: { state: string; observed_at: string | null; detail: string | null };
  native_liveness?: { state: string; observed_at: string | null; detail: string | null };
  ready_reached_at?: string | null;
  activity?: WireActivityEvent[];
  reconciliation?: { exit_timestamps_ms?: number[]; last_terminal?: Record<string, unknown> };
  turn_control?: {
    action_id: string;
    work_attempt_id: string;
    execution_generation_id: string;
    status: "prepared" | "dispatching" | "completed" | "retryable" | "uncertain";
    capability: "native_interrupt" | "restart_resume" | "unsupported";
    interrupted: boolean | null;
    resumed: boolean | null;
    state: "idle" | "working" | null;
    stages: DesktopSupervisorTurnControlResult["stages"];
    error: string | null;
    recorded_at: string;
    updated_at: string;
  } | null;
  room_agent_state?: {
    connection: { state: string; observed_at: string | null; detail: string | null };
    inbox: { state: string; pending_count: number; blocked_by_message_id: string | null; detail: string | null };
    turn: { state: string; inbox_item_id: string | null; source_message_id: string | null; provider_turn_id: string | null; detail: string | null };
    task: { state: string; task_id: string | null; title: string | null };
  } | null;
  delivery_receipts?: Array<{
    inbox_item_id: string; source_message_id: string; state: string; attempt_count: number;
    provider_turn_id: string | null; blocked_by_message_id: string | null; error: string | null; updated_at: string;
    timeline?: Array<{ phase: string; observed_at: string; detail: string | null }>;
  }>;
};
type WireActivityEvent = {
  observed_at: string;
  sequence: number;
  provider: string;
  kind: string;
  method: string;
  summary: string;
  status: DesktopSupervisorActivityEvent["status"];
  payload: unknown;
  payload_truncated: boolean;
  payload_redacted: boolean;
  durable_payload_ref: string | null;
};
type WireLegacyLaneOwner = {
  reservation_id: string;
  room_id: string;
  provider: string;
  owner_pid: number;
  owner_process_identity: string;
  state: "reserved" | "active";
  session_id: string | null;
  created_at: string;
  updated_at: string;
};

export type DaemonProcessState = "live" | "zombie";
export type DaemonProcessIdentity = {
  pid: number;
  kernelStartTime: string;
  command: string;
  state: DaemonProcessState;
  expectedScriptPath: string;
};

type DaemonIdentityInspection = Omit<DaemonProcessIdentity, "expectedScriptPath">;
type RetiredDaemonObservation =
  | { kind: "same"; identity: DaemonProcessIdentity }
  | { kind: "absent" }
  | { kind: "zombie" }
  | { kind: "unverifiable" }
  | { kind: "changed"; reason: string };

export type DaemonHandoffDiagnostic = {
  event: "supervisor_daemon_handoff";
  outcome: string;
  pid: number;
  implementationVersion: string;
  authorityReleased: boolean;
  detail: string;
};

const PS_DAEMON_IDENTITY = /^(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+)$/;

export function defaultInspectDaemonProcess(pid: number): DaemonIdentityInspection | null | undefined {
  try {
    const output = execFileSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "state=", "-o", "command="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const match = output.match(PS_DAEMON_IDENTITY);
    if (!match) return undefined;
    return {
      pid,
      kernelStartTime: match[1]!.replace(/\s+/g, " "),
      state: match[2]!.startsWith("Z") ? "zombie" : "live",
      command: match[3]!,
    };
  } catch {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? null : undefined;
    }
  }
}

export class SupervisorDaemonProtocolMismatchError extends Error {
  constructor(readonly clientVersion: number, readonly daemonVersion: number, message: string) {
    super(message);
  }
}

export interface SupervisorDaemonLifecycleOptions {
  socketPath?: string;
  daemonScriptPath?: string;
  daemonWorkingDirectory?: string;
  spawnDaemon?: (scriptPath: string, cwd: string) => ChildProcess;
  /** @deprecated Prefer signalDaemon so tests can distinguish TERM from KILL. */
  terminateDaemon?: (pid: number) => void;
  signalDaemon?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  inspectDaemonProcess?: (pid: number) => DaemonIdentityInspection | null | undefined;
  reportHandoffDiagnostic?: (diagnostic: DaemonHandoffDiagnostic) => void;
  handoffTimeoutMs?: number;
  terminateTimeoutMs?: number;
  killTimeoutMs?: number;
  processPollIntervalMs?: number;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  turnControlRequestTimeoutMs?: number;
  now?: () => Date;
}

export function supervisorDaemonSpawnEnvironment(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  sourceWorkspaceRoot = workspaceRoot,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  // Never trust a caller's cwd/cache-derived dev entry. The desktop's compiled
  // location is the authority for the repo build paired with this dev renderer.
  delete result.LETAGENTS_DEV_MCP_SERVER_ENTRY;
  if (env.LETAGENTS_DESKTOP_DEV_SERVER_URL?.trim()) {
    result.LETAGENTS_DEV_MCP_SERVER_ENTRY = join(sourceWorkspaceRoot, "dist", "mcp", "server.js");
  }
  return result;
}

export class SupervisorDaemonClient {
  readonly socketPath: string;
  readonly daemonScriptPath: string;
  private ensureOperation: Promise<DesktopSupervisorDaemonStatus> | null = null;
  private readonly spawnDaemon: (scriptPath: string, cwd: string) => ChildProcess;
  private readonly daemonWorkingDirectory: string;
  private readonly signalDaemon: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  private readonly inspectDaemonProcess: (pid: number) => DaemonIdentityInspection | null | undefined;
  private readonly reportHandoffDiagnostic: (diagnostic: DaemonHandoffDiagnostic) => void;
  private readonly naturalExitTimeoutMs: number;
  private readonly terminateTimeoutMs: number;
  private readonly killTimeoutMs: number;
  private readonly processPollIntervalMs: number;
  private readonly startTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly turnControlRequestTimeoutMs: number;
  private readonly now: () => Date;

  constructor(options: SupervisorDaemonLifecycleOptions = {}) {
    this.socketPath = options.socketPath ?? join(homedir(), ".letagents", "daemon.sock");
    this.daemonScriptPath = options.daemonScriptPath ?? join(desktopRoot, "dist-daemon", "main.js");
    this.daemonWorkingDirectory = options.daemonWorkingDirectory ?? dirname(this.socketPath);
    this.signalDaemon = options.signalDaemon ?? ((pid, signal) => {
      if (signal === "SIGTERM" && options.terminateDaemon) {
        options.terminateDaemon(pid);
        return;
      }
      process.kill(pid, signal);
    });
    this.inspectDaemonProcess = options.inspectDaemonProcess ?? defaultInspectDaemonProcess;
    this.reportHandoffDiagnostic = options.reportHandoffDiagnostic ?? ((diagnostic) => {
      console.error(JSON.stringify(diagnostic));
    });
    this.naturalExitTimeoutMs = options.handoffTimeoutMs ?? NATURAL_EXIT_TIMEOUT_MS;
    this.terminateTimeoutMs = options.terminateTimeoutMs ?? TERMINATE_EXIT_TIMEOUT_MS;
    this.killTimeoutMs = options.killTimeoutMs ?? KILL_EXIT_TIMEOUT_MS;
    this.processPollIntervalMs = options.processPollIntervalMs ?? PROCESS_POLL_INTERVAL_MS;
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.turnControlRequestTimeoutMs = options.turnControlRequestTimeoutMs ?? TURN_CONTROL_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.spawnDaemon = options.spawnDaemon ?? ((scriptPath, cwd) => {
      const child = spawn(process.execPath, [scriptPath], {
        cwd,
        detached: true,
        stdio: "ignore",
        env: supervisorDaemonSpawnEnvironment(),
      });
      child.unref();
      return child;
    });
  }

  ensureRunning(): Promise<DesktopSupervisorDaemonStatus> {
    if (process.platform !== "darwin" && process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON !== "1") {
      return Promise.reject(new Error("Supervised agents currently require macOS."));
    }
    if (!this.ensureOperation) {
      this.ensureOperation = this.ensureRunningOnce().finally(() => { this.ensureOperation = null; });
    }
    return this.ensureOperation;
  }

  async list(roomIdentifier?: string | null): Promise<DesktopSupervisorManifestEntry[]> {
    await this.ensureRunning();
    const entries = await this.request<WireEntry[]>("manifest.list");
    return entries.map(mapEntry).filter((entry) => !roomIdentifier || entry.roomId === roomIdentifier);
  }

  async create(input: DesktopSupervisorCreateInput): Promise<DesktopSupervisorManifestEntry> {
    if (!input.charter.trim()) throw new Error("A supervised agent charter is required.");
    const creationRequestId = input.creationRequestId?.trim() || randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(creationRequestId)) {
      throw new Error("A valid supervised agent creation request id is required.");
    }
    const now = this.now().toISOString();
    const entry: WireEntry = {
      id: `supervised_${creationRequestId}`,
      room_id: input.roomIdentifier,
      display_name: input.displayName.trim() || "Supervised agent",
      provider: input.providerId,
      model: input.model?.trim() || null,
      charter: input.charter.trim(),
      // This durable paused claim is the engine-ownership fence. Electron
      // stops any legacy owner only after this CAS succeeds, then activates it.
      desired_state: "paused",
      observed_state: "absent",
      condition: "none",
      permission_profile_id: input.permissionProfileId ?? null,
      // Supervised Codex is daemon-driven.  This is a durable routing fact,
      // deliberately separate from opaque native app-server launch policy.
      delivery_mode: input.providerId === "codex" ? "daemon_inbox" : "mcp_polling",
      // A caller-supplied policy belongs to the selected native provider. Do
      // not reinterpret it as a LetAgents permission profile on its way to
      // the daemon. The Codex default remains only for the existing UI that
      // has not supplied an explicit provider policy yet.
      provider_launch_policy: input.launchPolicy ?? (input.providerId === "codex" && (!input.permissionProfileId || input.permissionProfileId === "full_access")
        ? { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }
        : {}),
      created_by: "desktop",
      created_at: now,
      source_repo_path: input.repoRootPath,
      workspace_path: null,
      work_attempt_id: null,
      workplace_liveness: { state: "unknown", observed_at: null, detail: "Awaiting room registration." },
      native_liveness: { state: "unknown", observed_at: null, detail: "Awaiting native provider launch." },
      activity: [],
    };
    await this.ensureRunning();
    return mapEntry(await this.request<WireEntry>("manifest.put", { entry }));
  }

  async assertLegacyStartAllowed(roomIdentifier: string, provider: string): Promise<void> {
    const owner = (await this.list(roomIdentifier)).find((entry) => entry.provider === provider && entry.desiredState !== "stopped");
    if (owner) {
      throw new Error(`${owner.displayName} already owns the ${provider} lane through the supervised engine. Stop it before starting a legacy agent.`);
    }
  }

  async reserveLegacyLane(roomIdentifier: string, provider: string, reservationId: string): Promise<WireLegacyLaneOwner> {
    await this.ensureRunning();
    const ownerProcessIdentity = defaultGetProcessIdentity(process.pid);
    if (typeof ownerProcessIdentity !== "string" || !ownerProcessIdentity) {
      throw new Error("Could not prove the Electron process birth identity for a legacy lane reservation.");
    }
    return this.request<WireLegacyLaneOwner>("lane.reserve_legacy", {
      reservation_id: reservationId,
      room_id: roomIdentifier,
      provider,
      owner_pid: process.pid,
      owner_process_identity: ownerProcessIdentity,
    });
  }

  async activateLegacyLane(reservationId: string, sessionId: string): Promise<WireLegacyLaneOwner> {
    await this.ensureRunning();
    return this.request<WireLegacyLaneOwner>("lane.activate_legacy", {
      reservation_id: reservationId,
      session_id: sessionId,
    });
  }

  async releaseLegacyLane(input: { reservationId?: string | null; sessionId?: string | null; roomIdentifier?: string | null; provider?: string | null }): Promise<boolean> {
    await this.ensureRunning();
    const result = await this.request<{ released: boolean }>("lane.release_legacy", {
      reservation_id: input.reservationId ?? null,
      session_id: input.sessionId ?? null,
      room_id: input.roomIdentifier ?? null,
      provider: input.provider ?? null,
    });
    return result.released;
  }

  async setDesiredState(id: string, desiredState: DesktopSupervisorDesiredState): Promise<DesktopSupervisorManifestEntry> {
    await this.ensureRunning();
    return mapEntry(await this.request<WireEntry>("manifest.set_desired_state", { id, desired_state: desiredState }));
  }

  /** This call deliberately accepts only a renderer-safe exact identity tuple. */
  async retryRoomDelivery(input: DesktopSupervisorRoomDeliveryRetryInput): Promise<void> {
    const status = await this.ensureRunning();
    if (!status.capabilities.roomDeliveryRetry) {
      throw new Error("This supervisor does not support room delivery retry.");
    }
    await this.request<{ accepted: boolean }>("supervisor.retry_room_delivery", {
      entry_id: input.entryId,
      room_id: input.roomId,
      source_message_id: input.sourceMessageId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      agent_session_id: input.agentSessionId,
      daemon_generation: status.generation,
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, this.turnControlRequestTimeoutMs);
  }

  async compareAndSetDesiredState(
    id: string,
    expectedDesiredState: DesktopSupervisorDesiredState,
    desiredState: DesktopSupervisorDesiredState,
  ): Promise<DesktopSupervisorManifestEntry | null> {
    await this.ensureRunning();
    const result = await this.request<{ applied: boolean; entry: WireEntry }>("manifest.compare_and_set_desired_state", {
      id,
      expected_desired_state: expectedDesiredState,
      desired_state: desiredState,
    });
    return result.applied ? mapEntry(result.entry) : null;
  }

  async controlTurn(input: DesktopSupervisorTurnControlInput): Promise<DesktopSupervisorTurnControlResult> {
    await this.ensureRunning();
    return this.request<DesktopSupervisorTurnControlResult>("manifest.control_turn", {
      id: input.entryId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      action_id: input.actionId,
      correction: input.correction ?? null,
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, this.turnControlRequestTimeoutMs);
  }

  async resolveTurnControl(input: DesktopSupervisorTurnControlResolutionInput): Promise<DesktopSupervisorManifestEntry> {
    await this.ensureRunning();
    return mapEntry(await this.request<WireEntry>("manifest.resolve_turn_control", {
      id: input.entryId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      action_id: input.actionId,
      resolution: input.resolution,
    }));
  }

  async readAttempt(id: string): Promise<DesktopSupervisorAttemptDetail> {
    await this.ensureRunning();
    const detail = await this.request<Record<string, unknown>>("attempt.read", { id });
    return {
      entryId: String(detail.entry_id ?? id),
      workAttemptId: typeof detail.work_attempt_id === "string" ? detail.work_attempt_id : null,
      workspacePath: typeof detail.workspace_path === "string" ? detail.workspace_path : null,
      lastTerminal: detail.last_terminal && typeof detail.last_terminal === "object" ? detail.last_terminal as Record<string, unknown> : null,
      restartCount: Number(detail.restart_count ?? 0),
      activity: Array.isArray(detail.activity) ? detail.activity.map((event) => mapActivity(event as WireActivityEvent)) : [],
    };
  }

  async appendActivity(id: string, event: DesktopSupervisorActivityEvent): Promise<DesktopSupervisorManifestEntry> {
    await this.ensureRunning();
    return mapEntry(await this.request<WireEntry>("manifest.append_activity", { id, event: wireActivity(event) }));
  }

  async updateWorkplaceLiveness(id: string, state: "reachable" | "stale" | "unknown", detail: string | null): Promise<DesktopSupervisorManifestEntry> {
    await this.ensureRunning();
    return mapEntry(await this.request<WireEntry>("manifest.update_workplace_liveness", {
      id,
      state,
      detail,
      observed_at: this.now().toISOString(),
    }));
  }

  /** Main-process only: a secret crosses only the owner-only local socket. */
  async installWorkerCredential(input: {
    entryId: string; roomId: string; workAttemptId: string;
    executionGenerationId: string; agentSessionId: string; credential: string;
  }): Promise<"installed" | "stale"> {
    if (!input.credential.trim()) throw new Error("A supervised worker credential is required.");
    const status = await this.ensureRunning();
    const result = await this.request<{ status?: unknown }>("supervisor.install_worker_credential", {
      entry_id: input.entryId, room_id: input.roomId, work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId, agent_session_id: input.agentSessionId,
      agent_session_token: input.credential, daemon_generation: status.generation,
    });
    return result.status === "installed" ? "installed" : "stale";
  }

  private async ensureRunningOnce(): Promise<DesktopSupervisorDaemonStatus> {
    let retiredGeneration: number | undefined;
    try {
      const negotiated = await this.request<Record<string, unknown>>("daemon.negotiate", undefined, SUPERVISOR_DAEMON_PROTOCOL_VERSION);
      const daemonVersion = Number(negotiated.protocol_version ?? 0);
      const implementationVersion = String(negotiated.implementation_version ?? "unknown");
      if (
        daemonVersion === SUPERVISOR_DAEMON_PROTOCOL_VERSION
        && implementationVersion === SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION
      ) return mapStatus(negotiated);
      const retired = this.captureRetiredDaemon(negotiated);
      retiredGeneration = Number(negotiated.generation);
      await this.request("daemon.prepare_handoff", undefined, daemonVersion);
      await this.enforceRetiredDaemonExit(retired, daemonVersion, implementationVersion);
    } catch (error) {
      if (!isConnectionUnavailable(error)) throw error;
    }
    await access(this.daemonScriptPath);
    await mkdir(this.daemonWorkingDirectory, { recursive: true, mode: 0o700 });
    const child = this.spawnDaemon(this.daemonScriptPath, this.daemonWorkingDirectory);
    child.once("error", () => undefined);
    return this.waitForHealthy(retiredGeneration);
  }

  private async waitForHealthy(retiredGeneration?: number): Promise<DesktopSupervisorDaemonStatus> {
    const deadline = Date.now() + this.startTimeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        const result = await this.request<Record<string, unknown>>("daemon.negotiate");
        const status = mapStatus(result);
        if (status.protocolVersion !== SUPERVISOR_DAEMON_PROTOCOL_VERSION) {
          throw new SupervisorDaemonProtocolMismatchError(SUPERVISOR_DAEMON_PROTOCOL_VERSION, status.protocolVersion, "Replacement daemon protocol does not match the desktop.");
        }
        if (status.implementationVersion !== SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION) {
          throw new Error(
            `Replacement supervisor daemon is still ${status.implementationVersion}; expected ${SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION}. Rebuild the desktop daemon and try again.`,
          );
        }
        if (retiredGeneration !== undefined && status.generation <= retiredGeneration) {
          throw new Error(
            `Replacement supervisor daemon did not acquire a newer singleton generation; received ${status.generation} after ${retiredGeneration}.`,
          );
        }
        return status;
      } catch (error) {
        lastError = error;
        await delay(50);
      }
    }
    throw new Error(`Timed out waiting for the supervisor daemon: ${lastError instanceof Error ? lastError.message : "unreachable"}`);
  }

  private captureRetiredDaemon(negotiated: Record<string, unknown>): DaemonProcessIdentity {
    const pid = Number(negotiated.pid);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
      throw new Error("Refusing daemon handoff because the serving daemon PID is invalid.");
    }
    const inspected = this.safeInspectDaemon(pid);
    if (!inspected || inspected.state === "zombie") {
      throw new Error("Refusing daemon handoff because the serving daemon process identity is unverifiable.");
    }
    if (inspected.pid !== pid) {
      throw new Error("Refusing daemon handoff because the inspected daemon PID does not match the serving daemon.");
    }
    if (!this.commandPointsAtExpectedDaemon(inspected.command)) {
      throw new Error("Refusing daemon handoff because the serving PID does not point at the expected daemon script.");
    }
    return { ...inspected, expectedScriptPath: this.daemonScriptPath };
  }

  private async enforceRetiredDaemonExit(
    retired: DaemonProcessIdentity,
    daemonVersion: number,
    implementationVersion: string,
  ): Promise<void> {
    let observation = await this.waitForRetiredProcessChange(retired, this.naturalExitTimeoutMs);
    let authorityReleased = await this.isSocketReleased(daemonVersion);
    if (observation.kind === "absent" || observation.kind === "zombie") {
      if (!authorityReleased) throw new Error("Retired daemon process ended without releasing its control socket.");
      if (observation.kind === "zombie") {
        this.emitHandoffDiagnostic(retired, implementationVersion, true, "zombie_after_natural_exit", "Retired daemon is a zombie after authority release; replacement may proceed.");
      }
      return;
    }
    if (observation.kind !== "same") {
      if (!authorityReleased) {
        throw new Error(`Existing supervisor daemon still owns its socket and its process identity is ${observation.kind}; leaving it serving.`);
      }
      this.emitHandoffDiagnostic(retired, implementationVersion, true, observation.kind, this.observationDetail(observation));
      return;
    }

    if (implementationVersion === "2.0.25" && authorityReleased) {
      this.emitHandoffDiagnostic(retired, implementationVersion, authorityReleased, "legacy_sigterm_expected", "Daemon 2.0.25 released authority but retains live RPC handles; SIGTERM escalation is expected.");
    }
    observation = this.guardedSignalRetiredDaemon(retired, "SIGTERM");
    if (observation.kind === "same") {
      observation = await this.waitForRetiredProcessChange(retired, this.terminateTimeoutMs);
    }
    authorityReleased = await this.isSocketReleased(daemonVersion);
    if (observation.kind === "absent" || observation.kind === "zombie") {
      if (!authorityReleased) throw new Error("Retired daemon did not release its control socket after SIGTERM.");
      return;
    }
    if (observation.kind !== "same") {
      if (!authorityReleased) {
        throw new Error(`Existing supervisor daemon still owns its socket after SIGTERM and its process identity is ${observation.kind}; leaving it serving.`);
      }
      this.emitHandoffDiagnostic(retired, implementationVersion, true, observation.kind, this.observationDetail(observation));
      return;
    }

    observation = this.guardedSignalRetiredDaemon(retired, "SIGKILL");
    if (observation.kind === "same") {
      observation = await this.waitForRetiredProcessChange(retired, this.killTimeoutMs);
    }
    authorityReleased = await this.isSocketReleased(daemonVersion);
    if (!authorityReleased) {
      throw new Error("Existing supervisor daemon still owns its socket after bounded TERM/KILL enforcement; replacement was not started.");
    }
    if (observation.kind === "same") {
      this.emitHandoffDiagnostic(retired, implementationVersion, true, "non_zombie_survived_sigkill", "Retired daemon survived SIGKILL but no longer owns authority; replacement will prove singleton acquisition.");
      return;
    }
    if (observation.kind === "zombie") {
      this.emitHandoffDiagnostic(retired, implementationVersion, true, "zombie_after_sigkill", "Retired daemon became a zombie after SIGKILL; replacement will prove singleton acquisition.");
      return;
    }
    if (observation.kind !== "absent") {
      this.emitHandoffDiagnostic(retired, implementationVersion, true, observation.kind, this.observationDetail(observation));
    }
  }

  private guardedSignalRetiredDaemon(
    retired: DaemonProcessIdentity,
    signal: "SIGTERM" | "SIGKILL",
  ): RetiredDaemonObservation {
    const observation = this.observeRetiredDaemon(retired);
    if (observation.kind !== "same") return observation;
    if (!Number.isSafeInteger(retired.pid) || retired.pid <= 1 || retired.pid === process.pid) {
      return { kind: "changed", reason: "invalid daemon PID" };
    }
    // Deliberately signal the exact positive daemon PID. Provider-stop code may
    // signal provider process groups; daemon replacement must never do so.
    try {
      this.signalDaemon(retired.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return this.observeRetiredDaemon(retired);
      }
      throw error;
    }
    return observation;
  }

  private async waitForRetiredProcessChange(
    retired: DaemonProcessIdentity,
    timeoutMs: number,
  ): Promise<RetiredDaemonObservation> {
    const deadline = Date.now() + timeoutMs;
    let observation = this.observeRetiredDaemon(retired);
    while (observation.kind === "same" && Date.now() < deadline) {
      await delay(Math.min(this.processPollIntervalMs, Math.max(0, deadline - Date.now())));
      observation = this.observeRetiredDaemon(retired);
    }
    return observation;
  }

  private observeRetiredDaemon(retired: DaemonProcessIdentity): RetiredDaemonObservation {
    const current = this.safeInspectDaemon(retired.pid);
    if (current === null) return { kind: "absent" };
    if (current === undefined) return { kind: "unverifiable" };
    if (current.pid !== retired.pid) return { kind: "changed", reason: "inspected PID changed" };
    if (current.kernelStartTime !== retired.kernelStartTime) {
      return { kind: "changed", reason: "kernel start time changed (PID reuse)" };
    }
    if (current.state === "zombie") return { kind: "zombie" };
    if (current.command !== retired.command) return { kind: "changed", reason: "full command changed" };
    if (!this.commandPointsAtExpectedDaemon(current.command, retired.expectedScriptPath)) {
      return { kind: "changed", reason: "command no longer points at expected daemon script" };
    }
    return { kind: "same", identity: retired };
  }

  private safeInspectDaemon(pid: number): DaemonIdentityInspection | null | undefined {
    try {
      return this.inspectDaemonProcess(pid);
    } catch {
      return undefined;
    }
  }

  private commandPointsAtExpectedDaemon(command: string, expectedScriptPath = this.daemonScriptPath): boolean {
    return command === expectedScriptPath || command.endsWith(` ${expectedScriptPath}`);
  }

  private async isSocketReleased(daemonVersion: number): Promise<boolean> {
    try {
      await this.request("daemon.negotiate", undefined, daemonVersion);
      return false;
    } catch (error) {
      if (isConnectionUnavailable(error)) return true;
      // A timeout, malformed response, or daemon error still proves that the
      // socket was connectable; it does not prove authority release. Keep the
      // result conservative so an exact identity-guarded TERM/KILL can retire
      // an acknowledged-but-unresponsive predecessor.
      return false;
    }
  }

  private observationDetail(observation: Exclude<RetiredDaemonObservation, { kind: "same" }>): string {
    return observation.kind === "changed"
      ? `Retired daemon identity changed: ${observation.reason}. It was not signalled.`
      : `Retired daemon identity is ${observation.kind}. It was not signalled.`;
  }

  private emitHandoffDiagnostic(
    retired: DaemonProcessIdentity,
    implementationVersion: string,
    authorityReleased: boolean,
    outcome: string,
    detail: string,
  ): void {
    this.reportHandoffDiagnostic({
      event: "supervisor_daemon_handoff",
      outcome,
      pid: retired.pid,
      implementationVersion,
      authorityReleased,
      detail,
    });
  }

  private request<T = unknown>(
    method: string,
    params?: unknown,
    version = SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID();
      const socket = createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error); else resolve(value as T);
      };
      socket.setEncoding("utf8");
      socket.setTimeout(timeoutMs, () => finish(new Error(`Supervisor daemon request timed out: ${method}`)));
      socket.once("error", (error) => finish(error));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as WireResponse;
          if (response.id !== id) throw new Error("Supervisor daemon response id mismatch.");
          if (!response.ok) {
            if (/Protocol version mismatch/i.test(response.error ?? "")) {
              throw new SupervisorDaemonProtocolMismatchError(version, response.version, response.error ?? "Protocol version mismatch.");
            }
            throw new Error(response.error || `Supervisor daemon request failed: ${method}`);
          }
          finish(undefined, response.result as T);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Invalid supervisor daemon response."));
        }
      });
      socket.once("connect", () => socket.write(`${JSON.stringify({ version, id, method, params })}\n`));
    });
  }
}

function mapStatus(value: Record<string, unknown>): DesktopSupervisorDaemonStatus {
  return {
    healthy: value.healthy === true,
    protocolVersion: Number(value.protocol_version ?? 0),
    implementationVersion: String(value.implementation_version ?? "unknown"),
    capabilities: { roomDeliveryRetry: booleanField(value.capabilities, "room_delivery_retry") },
    generation: Number(value.generation ?? 0),
    pid: Number(value.pid ?? 0),
    startedAt: String(value.started_at ?? ""),
  };
}

function booleanField(value: unknown, key: string): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Reflect.get(value, key) === true;
}

/**
 * The daemon socket is a process boundary, not a typed function call.  Keep
 * the causal projection deliberately fail-closed: it is ephemeral UI state,
 * so a malformed row must never make the desktop accept a partly-coerced
 * delivery identity (or crash while rendering the manifest).
 */
export function mapEntry(entry: WireEntry): DesktopSupervisorManifestEntry {
  const activeWorkerBinding = entry.worker_binding ?? null;
  const workerBinding = activeWorkerBinding ?? entry.last_worker_binding ?? null;
  return {
    id: entry.id,
    roomId: entry.room_id,
    displayName: entry.display_name,
    provider: entry.provider,
    model: entry.model,
    charter: entry.charter,
    desiredState: entry.desired_state,
    observedState: entry.observed_state,
    condition: entry.condition,
    lastError: entry.last_error ?? null,
    permissionProfileId: entry.permission_profile_id,
    deliveryMode: entry.delivery_mode ?? "mcp_polling",
    createdBy: entry.created_by,
    createdAt: entry.created_at,
    workspacePath: entry.workspace_path ?? null,
    workAttemptId: entry.work_attempt_id ?? null,
    agentSessionId: workerBinding?.agent_session_id ?? null,
    agentSessionBindingState: activeWorkerBinding ? "active" : workerBinding ? "historical" : "none",
    bindingUpdatedAt: workerBinding?.updated_at ?? null,
    executionGenerationId: entry.provider_ref?.execution_generation_id ?? null,
    providerContinuationId: entry.provider_ref?.provider_continuation_id ?? null,
    providerPid: entry.provider_ref?.provider_connection?.pid ?? null,
    workplaceLiveness: {
      state: entry.workplace_liveness?.state ?? "unknown",
      observedAt: entry.workplace_liveness?.observed_at ?? null,
      detail: entry.workplace_liveness?.detail ?? null,
    },
    nativeLiveness: {
      state: entry.native_liveness?.state ?? "unknown",
      observedAt: entry.native_liveness?.observed_at ?? null,
      detail: entry.native_liveness?.detail ?? null,
    },
    readyReachedAt: entry.ready_reached_at ?? null,
    restartCount: entry.reconciliation?.exit_timestamps_ms?.length ?? 0,
    lastTerminal: entry.reconciliation?.last_terminal ?? null,
    activity: (entry.activity ?? []).map(mapActivity),
    roomAgentState: projectRoomAgentState(entry.room_agent_state),
    deliveryReceipts: projectDeliveryReceipts(entry.delivery_receipts),
    turnControl: entry.turn_control ? {
      actionId: entry.turn_control.action_id,
      workAttemptId: entry.turn_control.work_attempt_id,
      executionGenerationId: entry.turn_control.execution_generation_id,
      status: entry.turn_control.status,
      capability: entry.turn_control.capability,
      interrupted: entry.turn_control.interrupted,
      resumed: entry.turn_control.resumed,
      state: entry.turn_control.state,
      stages: entry.turn_control.stages,
      error: entry.turn_control.error,
      recordedAt: entry.turn_control.recorded_at,
      updatedAt: entry.turn_control.updated_at,
    } : null,
  };
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function nullableNonEmptyString(value: unknown): string | null | undefined {
  return value === null || (typeof value === "string" && value.trim().length > 0) ? value : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : null;
}

function projectRoomAgentState(value: unknown): DesktopSupervisorManifestEntry["roomAgentState"] {
  const root = record(value);
  if (!root) return null;
  const connection = record(root.connection);
  const inbox = record(root.inbox);
  const turn = record(root.turn);
  const task = record(root.task);
  if (!connection || !inbox || !turn || !task) return null;

  const connectionState = enumValue(connection.state, ["connected", "reconnecting", "disconnected"] as const);
  const inboxState = enumValue(inbox.state, ["empty", "queued", "blocked", "waiting_for_desktop_credentials"] as const);
  const turnState = enumValue(turn.state, ["idle", "dispatching", "responding", "publishing", "retrying", "failed"] as const);
  const taskState = enumValue(task.state, ["none", "assigned", "working", "blocked"] as const);
  const observedAt = nullableNonEmptyString(connection.observed_at);
  const connectionDetail = nullableString(connection.detail);
  const blockedByMessageId = nullableNonEmptyString(inbox.blocked_by_message_id);
  const inboxDetail = nullableString(inbox.detail);
  const inboxItemId = nullableNonEmptyString(turn.inbox_item_id);
  const sourceMessageId = nullableNonEmptyString(turn.source_message_id);
  const providerTurnId = nullableNonEmptyString(turn.provider_turn_id);
  const turnDetail = nullableString(turn.detail);
  const taskId = nullableNonEmptyString(task.task_id);
  const title = nullableString(task.title);
  if (!connectionState || !inboxState || !turnState || !taskState
    || observedAt === undefined || connectionDetail === undefined || blockedByMessageId === undefined || inboxDetail === undefined
    || inboxItemId === undefined || sourceMessageId === undefined || providerTurnId === undefined || turnDetail === undefined
    || taskId === undefined || title === undefined
    || typeof inbox.pending_count !== "number" || !Number.isFinite(inbox.pending_count) || !Number.isInteger(inbox.pending_count) || inbox.pending_count < 0) return null;
  return {
    connection: { state: connectionState, observedAt, detail: connectionDetail },
    inbox: { state: inboxState, pendingCount: inbox.pending_count, blockedByMessageId, detail: inboxDetail },
    turn: { state: turnState, inboxItemId, sourceMessageId, providerTurnId, detail: turnDetail },
    task: { state: taskState, taskId, title },
  };
}

function projectDeliveryReceipts(value: unknown): DesktopSupervisorManifestEntry["deliveryReceipts"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const receipt = record(candidate);
    if (!receipt) return [];
    const inboxItemId = nonEmptyString(receipt.inbox_item_id);
    const sourceMessageId = nonEmptyString(receipt.source_message_id);
    const state = enumValue(receipt.state, ["queued", "dispatching", "awaiting_result", "publishing", "acknowledged", "acknowledged_no_reply", "retryable", "blocked", "queued_behind_blocked"] as const);
    const providerTurnId = nullableNonEmptyString(receipt.provider_turn_id);
    const blockedByMessageId = nullableNonEmptyString(receipt.blocked_by_message_id);
    const error = nullableString(receipt.error);
    const updatedAt = nonEmptyString(receipt.updated_at);
    if (!inboxItemId || !sourceMessageId || !state || providerTurnId === undefined || blockedByMessageId === undefined || error === undefined || !updatedAt
      || typeof receipt.attempt_count !== "number" || !Number.isFinite(receipt.attempt_count) || !Number.isInteger(receipt.attempt_count) || receipt.attempt_count < 0
      || !Array.isArray(receipt.timeline)) return [];
    const timeline: NonNullable<DesktopSupervisorManifestEntry["deliveryReceipts"]>[number]["timeline"] = [];
    for (const event of receipt.timeline) {
      const value = record(event);
      if (!value) return [];
      const phase = enumValue(value.phase, ["received", "queued", "turn_started", "turn_finished", "publish_started", "published", "no_reply", "retry_scheduled", "blocked"] as const);
      const observedAt = nonEmptyString(value.observed_at);
      const detail = nullableString(value.detail);
      if (!phase || !observedAt || detail === undefined) return [];
      timeline.push({ phase, observedAt, detail });
    }
    return [{ inboxItemId, sourceMessageId, state, attemptCount: receipt.attempt_count, providerTurnId, blockedByMessageId, error, updatedAt, timeline }];
  });
}

function mapActivity(event: WireActivityEvent): DesktopSupervisorActivityEvent {
  return sanitizeDesktopActivityEvent({
    observedAt: event.observed_at,
    sequence: event.sequence,
    provider: event.provider,
    kind: event.kind,
    method: event.method,
    summary: event.summary,
    status: event.status,
    payload: event.payload,
    payloadTruncated: event.payload_truncated,
    payloadRedacted: event.payload_redacted,
    durablePayloadRef: event.durable_payload_ref,
  });
}

function wireActivity(event: DesktopSupervisorActivityEvent): WireActivityEvent {
  const safe = sanitizeDesktopActivityEvent(event);
  return {
    observed_at: safe.observedAt,
    sequence: safe.sequence,
    provider: safe.provider,
    kind: safe.kind,
    method: safe.method,
    summary: safe.summary,
    status: safe.status,
    payload: safe.payload,
    payload_truncated: safe.payloadTruncated,
    payload_redacted: safe.payloadRedacted,
    durable_payload_ref: safe.durablePayloadRef,
  };
}

function sanitizeDesktopActivityEvent(event: DesktopSupervisorActivityEvent): DesktopSupervisorActivityEvent {
  const payload = safeStreamPayload(event.payload);
  const provider = redactCredentialText(event.provider);
  const kind = redactCredentialText(event.kind);
  const method = redactCredentialText(event.method);
  const summary = redactCredentialText(event.summary);
  const durableRef = event.durablePayloadRef === null ? null : redactCredentialText(event.durablePayloadRef);
  const bound = (value: string, max: number) => {
    if (value.length <= max) return value;
    const markerStart = value.lastIndexOf("[REDACTED]", max);
    if (markerStart >= 0 && markerStart < max && markerStart + "[REDACTED]".length > max) return value.slice(-max);
    return value.slice(0, max);
  };
  const providerValue = bound(provider.value, 160);
  const kindValue = bound(kind.value, 160);
  const methodValue = bound(method.value, 500);
  const summaryValue = bound(summary.value, 500);
  const durableValue = durableRef ? bound(durableRef.value, 2_048) : null;
  return {
    ...event,
    provider: providerValue,
    kind: kindValue,
    method: methodValue,
    summary: summaryValue,
    payload: payload.payload,
    payloadTruncated: event.payloadTruncated || payload.payloadTruncated
      || provider.value.length > providerValue.length || kind.value.length > kindValue.length
      || method.value.length > methodValue.length || summary.value.length > summaryValue.length
      || (durableRef?.value.length ?? 0) > (durableValue?.length ?? 0),
    payloadRedacted: event.payloadRedacted || payload.payloadRedacted || provider.redacted || kind.redacted || method.redacted || summary.redacted || durableRef?.redacted === true,
    durablePayloadRef: durableValue,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConnectionUnavailable(error: unknown): boolean {
  return ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}

export const supervisorDaemonClient = new SupervisorDaemonClient();

export function onSupervisorActivity(
  listener: (payload: { entryId: string; event: DesktopSupervisorActivityEvent }) => void,
): () => void {
  activityEmitter.on("activity", listener);
  return () => activityEmitter.off("activity", listener);
}

export async function publishSupervisorActivity(input: {
  entryId: string;
  provider: string;
  kind: string;
  method: string;
  summary: string;
  status: DesktopSupervisorActivityEvent["status"];
  payload?: unknown;
}): Promise<DesktopSupervisorManifestEntry> {
  const sequence = Math.max((activitySequences.get(input.entryId) ?? 0) + 1, Date.now());
  activitySequences.set(input.entryId, sequence);
  const { value: redactedPayload, redacted } = redactActivityPayload(input.payload ?? { summary: input.summary });
  const serialized = safeJson(redactedPayload);
  const truncated = serialized.length > 8_192;
  const event = sanitizeDesktopActivityEvent({
    observedAt: new Date().toISOString(),
    sequence,
    provider: input.provider,
    kind: input.kind,
    method: input.method,
    summary: input.summary,
    status: input.status,
    payload: truncated ? `${serialized.slice(0, 8_192)}…` : redactedPayload,
    payloadTruncated: truncated,
    payloadRedacted: redacted,
    durablePayloadRef: null,
  });
  const entry = await supervisorDaemonClient.appendActivity(input.entryId, event);
  activityEmitter.emit("activity", { entryId: input.entryId, event });
  return entry;
}

function redactActivityPayload(payload: unknown): { value: unknown; redacted: boolean } {
  let redacted = false;
  const seen = new WeakSet<object>();
  const walk = (value: unknown, key = "", depth = 0): unknown => {
    if (/token|secret|password|authorization|api[_-]?key|credential/i.test(key)) {
      redacted = true;
      return "[redacted]";
    }
    if (depth > 8) { redacted = true; return "[truncated-depth]"; }
    if (typeof value === "string") {
      const safe = redactCredentialText(value);
      redacted ||= safe.redacted;
      return safe.value.length > 4_096 ? (redacted = true, `${safe.value.slice(0, 4_096)}…`) : safe.value;
    }
    if (typeof value === "bigint") return value.toString();
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) { redacted = true; return "[circular]"; }
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => walk(item, key, depth + 1));
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([nextKey, nextValue]) => [nextKey, walk(nextValue, nextKey, depth + 1)]));
  };
  return { value: walk(payload), redacted };
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return JSON.stringify("[unserializable]"); }
}
