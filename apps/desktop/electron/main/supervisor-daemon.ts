import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { EventEmitter } from "node:events";

import type {
  DesktopSupervisorActivityEvent,
  DesktopSupervisorAttemptDetail,
  DesktopSupervisorCreateInput,
  DesktopSupervisorDaemonStatus,
  DesktopSupervisorDesiredState,
  DesktopSupervisorManifestEntry,
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
export const SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION = "2.0.18";
const REQUEST_TIMEOUT_MS = 3_000;
const TURN_CONTROL_REQUEST_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 8_000;
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
  terminateDaemon?: (pid: number) => void;
  handoffTimeoutMs?: number;
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
  private readonly terminateDaemon: (pid: number) => void;
  private readonly handoffTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly turnControlRequestTimeoutMs: number;
  private readonly now: () => Date;

  constructor(options: SupervisorDaemonLifecycleOptions = {}) {
    this.socketPath = options.socketPath ?? join(homedir(), ".letagents", "daemon.sock");
    this.daemonScriptPath = options.daemonScriptPath ?? join(desktopRoot, "dist-daemon", "main.js");
    this.daemonWorkingDirectory = options.daemonWorkingDirectory ?? dirname(this.socketPath);
    this.terminateDaemon = options.terminateDaemon ?? ((pid) => process.kill(pid, "SIGTERM"));
    this.handoffTimeoutMs = options.handoffTimeoutMs ?? START_TIMEOUT_MS;
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

  private async ensureRunningOnce(): Promise<DesktopSupervisorDaemonStatus> {
    try {
      const negotiated = await this.request<Record<string, unknown>>("daemon.negotiate", undefined, SUPERVISOR_DAEMON_PROTOCOL_VERSION);
      const daemonVersion = Number(negotiated.protocol_version ?? 0);
      const implementationVersion = String(negotiated.implementation_version ?? "unknown");
      if (
        daemonVersion === SUPERVISOR_DAEMON_PROTOCOL_VERSION
        && implementationVersion === SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION
      ) return mapStatus(negotiated);
      await this.request("daemon.prepare_handoff", undefined, daemonVersion);
      try {
        await this.waitForSocketDown();
      } catch (error) {
        await this.terminateStalledDaemon(negotiated, daemonVersion, error);
      }
    } catch (error) {
      if (!isConnectionUnavailable(error)) throw error;
    }
    await access(this.daemonScriptPath);
    await mkdir(this.daemonWorkingDirectory, { recursive: true, mode: 0o700 });
    const child = this.spawnDaemon(this.daemonScriptPath, this.daemonWorkingDirectory);
    child.once("error", () => undefined);
    return this.waitForHealthy();
  }

  private async waitForHealthy(): Promise<DesktopSupervisorDaemonStatus> {
    const deadline = Date.now() + START_TIMEOUT_MS;
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
        return status;
      } catch (error) {
        lastError = error;
        await delay(50);
      }
    }
    throw new Error(`Timed out waiting for the supervisor daemon: ${lastError instanceof Error ? lastError.message : "unreachable"}`);
  }

  private async waitForSocketDown(): Promise<void> {
    const deadline = Date.now() + this.handoffTimeoutMs;
    while (Date.now() < deadline) {
      try { await this.request("daemon.negotiate"); } catch (error) { if (isConnectionUnavailable(error)) return; throw error; }
      await delay(25);
    }
    throw new Error("Existing supervisor daemon did not complete negotiated handoff; it was left running.");
  }

  private async terminateStalledDaemon(
    negotiated: Record<string, unknown>,
    daemonVersion: number,
    handoffError: unknown,
  ): Promise<void> {
    const current = await this.request<Record<string, unknown>>("daemon.negotiate", undefined, daemonVersion);
    const pid = Number(current.pid);
    const sameDaemon = Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid
      && current.generation === negotiated.generation
      && current.implementation_version === negotiated.implementation_version
      && current.started_at === negotiated.started_at;
    if (!sameDaemon) throw handoffError;
    this.terminateDaemon(pid);
    await this.waitForSocketDown();
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
    generation: Number(value.generation ?? 0),
    pid: Number(value.pid ?? 0),
    startedAt: String(value.started_at ?? ""),
  };
}

function mapEntry(entry: WireEntry): DesktopSupervisorManifestEntry {
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
