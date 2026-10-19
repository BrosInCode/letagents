import { inspectorUsageSchema } from "./agents/provider-usage.js";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, appendFile, chmod, mkdir, stat } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { withDaemonMaintenanceOperation, readDaemonMaintenance, daemonMaintenancePath, DAEMON_MAINTENANCE_MESSAGE } from "../../../../shared/daemon-maintenance.mjs";
import { forceStopDaemon, waitForConfirmedDaemonExit } from "./force-daemon-restart.js";

import type {
  DesktopSupervisorActivityEvent,
  DesktopSupervisorAttemptDetail,
  DesktopSupervisorCreateInput,
  DesktopSupervisorDaemonStatus,
  DesktopSupervisorDesiredState,
  DesktopLifecycleCaptureAdmissionStatus,
  DesktopLifecycleProjectionDiagnostics,
  DesktopLifecycleProjectionProvider,
  DesktopSupervisorManifestEntry,
  DesktopSupervisorRoomDeliveryRetryInput,
  DesktopSupervisorStateSnapshot,
  DesktopSupervisorServiceSnapshot,
  DesktopSupervisorTurnControlInput,
  DesktopSupervisorTurnControlResolutionInput,
  DesktopSupervisorTurnControlResult,
} from "../ipc-types.js";
import { apiUrl, desktopRoot, workspaceRoot } from "./paths.js";
import {
  desktopRuntimeEnvironment,
  desktopShellEnvironmentReady,
} from "./desktop-shell-environment.js";
import { defaultGetProcessIdentity, redactCredentialText, safeStreamPayload } from "./agents/provider-evidence.js";
import { supervisedDeliveryModeForProvider } from "./agents/provider-registry.js";
import { LETAGENTS_MCP_RUNTIME_TREE_SHA256 } from "./agents/letagents-mcp-runtime.js";
import { prepareSupervisorState } from "./supervisor-state-recovery.js";
import { loadHostApprovalSigner, type HostApprovalSigner } from "./host-approval-auth.js";
import type { HostApprovalChallenge } from "../../shared/host-approval-auth.js";
import type { DesktopHostApproval, DesktopHostApprovalSnapshot, HostApprovalCandidate, HostApprovalSelection, HostApprovalStatus } from "../../shared/host-approvals.js";
import type { RetainedExecutionDetail } from "../../shared/execution-protocol.js";
import { SUPERVISOR_DAEMON_PROTOCOL_VERSION, SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION, SUPERVISOR_STATE_ACTIVITY_SUMMARY_LIMIT, REQUEST_TIMEOUT_MS, MANIFEST_LIST_REQUEST_TIMEOUT_MS, CONFIGURATION_APPLY_REQUEST_TIMEOUT_MS, RETIRE_REQUEST_TIMEOUT_MS, BOOTSTRAP_INGRESS_REQUEST_TIMEOUT_MS, INSTALL_HOST_GRANT_REQUEST_TIMEOUT_MS, RECOVERY_REQUEST_TIMEOUT_MS, HANDOFF_DRAIN_REQUEST_TIMEOUT_MS, TURN_CONTROL_REQUEST_TIMEOUT_MS, START_TIMEOUT_MS, NATURAL_EXIT_TIMEOUT_MS, TERMINATE_EXIT_TIMEOUT_MS, KILL_EXIT_TIMEOUT_MS, PROCESS_POLL_INTERVAL_MS } from "./supervisor-daemon/constants.js";
export { SUPERVISOR_DAEMON_PROTOCOL_VERSION, SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION, SUPERVISOR_STATE_ACTIVITY_SUMMARY_LIMIT, BOOTSTRAP_INGRESS_REQUEST_TIMEOUT_MS } from "./supervisor-daemon/constants.js";
import type { WireResponse, WireEntry, WireActivityEvent, DaemonProcessState, DaemonProcessIdentity, DaemonIdentityInspection, RetiredDaemonObservation, DaemonHandoffDiagnostic, SupervisorDaemonLifecycleOptions } from "./supervisor-daemon/types.js";
export type { DaemonProcessState, DaemonProcessIdentity, DaemonHandoffDiagnostic, SupervisorDaemonLifecycleOptions } from "./supervisor-daemon/types.js";
import { SupervisorDaemonProtocolMismatchError, SupervisorDaemonRequestTimeoutError, isConnectionUnavailable } from "./supervisor-daemon/errors.js";
export { SupervisorDaemonProtocolMismatchError } from "./supervisor-daemon/errors.js";
import { defaultInspectDaemonProcess } from "./supervisor-daemon/process-identity.js";
export { defaultInspectDaemonProcess } from "./supervisor-daemon/process-identity.js";
import { appendDaemonLifecycleEvent } from "./supervisor-daemon/lifecycle-log.js";
import type { DesktopDaemonLifecycleEvent } from "./supervisor-daemon/lifecycle-log.js";
import { supervisorDaemonSpawnEnvironment, supervisorCompatibilityFingerprint, supervisorRuntimeEnvironmentFingerprint } from "./supervisor-daemon/spawn-environment.js";
export { supervisorDaemonSpawnEnvironment, supervisorCompatibilityFingerprint, supervisorRuntimeEnvironmentFingerprint } from "./supervisor-daemon/spawn-environment.js";
import { booleanField, record, nonEmptyString, validTurnControlActionId, nullableString, nullableNonEmptyString, enumValue } from "./supervisor-daemon/wire-values.js";
import type { UnknownRecord } from "./supervisor-daemon/wire-values.js";
import { mapStatus } from "./supervisor-daemon/status-mapping.js";
import { mapAgentConfiguration, mapRoomMove, mapAgentInspectorDetail } from "./supervisor-daemon/agent-mapping.js";
export { mapAgentInspectorDetail } from "./supervisor-daemon/agent-mapping.js";
import { mapEntry, mapActivity } from "./supervisor-daemon/entry-mapping.js";
export { mapEntry } from "./supervisor-daemon/entry-mapping.js";
import { STATE_WATCH_RETRY_BASE_MS, supervisorStateWatchRetryDelay, supervisorStateWatchAcceptsStatus } from "./supervisor-daemon/state-watch-policy.js";
export { supervisorStateWatchRetryDelay, supervisorStateWatchAcceptsStatus } from "./supervisor-daemon/state-watch-policy.js";
import { SupervisorDaemonClientBase } from "./supervisor-daemon/client-base.js";

/**
 * While a focused agent's feed sits ended, re-poll at this cadence. The daemon
 * ends the feed when a provider generation exits but keeps the entry so the next
 * generation reopens it; this idle picks that reopen up without spinning against
 * a daemon that answers an ended feed immediately.
 */
const AGENT_STREAM_REOPEN_POLL_MS = 1_000;
const activityEmitter = new EventEmitter();
const stateEmitter = new EventEmitter();
const agentStreamEmitter = new EventEmitter();
let stateWatchOperation: Promise<void> | null = null;
let stateWatchUnsupportedGeneration: number | null = null;
/** Newest pushed manifest state; absent until the watch delivers one. */
let latestSupervisorState: DesktopSupervisorStateSnapshot | null = null;
/** The single agent whose live feed is currently subscribed (inspector focus). */
let focusedAgentStreamEntryId: string | null = null;
let focusedAgentStreamEpoch = 0;
let agentStreamWatchOperation: Promise<void> | null = null;
let agentStreamWatchAbortController: AbortController | null = null;

/** Main-process lifecycle signal. Renderer IPC never receives this hook. */
export function onSupervisorDaemonGeneration(
  listener: (status: DesktopSupervisorDaemonStatus) => void,
): () => void {
  return supervisorDaemonClient.onGeneration(listener);
}

const approvalId = z.string().min(1).max(256);
const approvalSha = z.string().regex(/^[a-f0-9]{64}$/);
const approvalStatus = z.enum(["pending", "decision_recorded", "decision_sent", "uncertain", "request_closed", "resolved", "unavailable"]);
const approvalChallenge = z.strictObject({ daemonGeneration: z.number().int().positive().safe(),
  bootNonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), keyFingerprint: approvalSha });
const hostToolLabel = approvalId.regex(/^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/);
const projectHostToolScope = z.strictObject({
  agentId: approvalId, accountId: approvalId, projectId: approvalSha, projectName: hostToolLabel, sourceRepoPath: z.string().min(1).max(4096),
  canonicalSourcePath: z.string().min(1).max(4096), repository: z.string().min(1).max(4096), remoteUrl: z.string().min(1).max(4096),
  provider: z.enum(["codex", "claude-code", "open-model"]), toolId: approvalId, toolLabel: hostToolLabel, policySha256: approvalSha,
});
const hostToolScope = z.union([projectHostToolScope, z.strictObject({
  kind: z.literal("room_workspace"), version: z.literal(1), agentId: approvalId, accountId: approvalId, roomId: approvalId,
  workAttemptId: z.string().uuid(), workspacePath: z.string().min(1).max(4096), canonicalWorkspacePath: z.string().min(1).max(4096),
  provider: z.enum(["codex", "claude-code", "open-model"]), toolId: approvalId, toolLabel: hostToolLabel, policySha256: approvalSha,
})]);
const hostToolRule = z.strictObject({ id: approvalId, revision: z.number().int().positive().safe(), ownerId: approvalId,
  scope: hostToolScope, createdAtMs: z.number().int().nonnegative().safe() });
const approvalCandidate = z.strictObject({
  reference: z.strictObject({ requestId: approvalId, requestVersion: z.number().int().positive().safe(), requestSha256: approvalSha,
    agentId: approvalId, roomId: approvalId, executionGenerationId: approvalId, runtimeGenerationId: approvalId,
    turnId: approvalId, providerContinuationId: approvalId, providerTurnId: approvalId, connectionId: approvalId,
    nativeRequestId: z.union([approvalId, z.number().int().nonnegative().safe()]) }).nullable(),
  presentation: z.strictObject({ agentId: approvalId, displayName: z.string().max(256),
    provider: z.enum(["codex", "open-model", "claude-code"]), title: z.enum(["Run a command", "Run a tool", "Change files", "Grant for this turn", "Approval unavailable"]),
    details: z.string().max(24 * 1024), denyScope: z.enum(["request", "session_pending"]), alwaysAllow: hostToolScope.optional() }),
  status: approvalStatus, detail: z.string().max(1024).nullable(),
  recordedDecision: z.strictObject({ decisionId: approvalId, actorId: approvalId,
    decision: z.enum(["allow_once", "deny"]), projectionSha256: approvalSha.nullable() }).nullable(),
});

export class SupervisorDaemonClient extends SupervisorDaemonClientBase {
  async isMaintenanceHeld(): Promise<boolean> {
    if (this.maintenanceRequested) return true;
    const hold = await readDaemonMaintenance(this.maintenancePath);
    return this.maintenanceRequested || Boolean(hold);
  }
  async getMaintenanceStatus(): Promise<{ held: boolean; ready: boolean }> {
    const hold = await readDaemonMaintenance(this.maintenancePath);
    if (!hold) return { held: false, ready: false };
    const status = await this.request<Record<string, unknown>>("daemon.negotiate", undefined,
      SUPERVISOR_DAEMON_PROTOCOL_VERSION, this.requestTimeoutMs, false, undefined, undefined, true).catch(() => null);
    return { held: true, ready: status?.maintenance_hold_id === hold.id };
  }
  /** Native-confirmed action. The caller relaunches Electron after success. */
  stopForMaintenance(resume = false): Promise<void> {
    if (this.applicationUpdatePrepared) return Promise.reject(new Error("The application update is already being installed."));
    if (this.maintenanceOperation) return this.maintenanceOperation;
    this.maintenanceRequested = true;
    this.invalidateReadyStatus();
    for (const cancel of this.maintenanceRequests) cancel();
    const operation = withDaemonMaintenanceOperation(async owner => {
      const hold = await owner.read();
      const observed: { negotiated: Record<string, unknown> | null } = { negotiated: null };
      const identify = async () => {
        try {
          observed.negotiated = await this.request<Record<string, unknown>>("daemon.negotiate", undefined,
            SUPERVISOR_DAEMON_PROTOCOL_VERSION, this.requestTimeoutMs, false, undefined, undefined, true);
          return this.captureRetiredDaemon(observed.negotiated);
        } catch (error) {
          if (observed.negotiated || !this.maintenanceTarget) throw error;
          return this.maintenanceTarget;
        }
      };
      if (resume) {
        const target = await identify();
        if (!hold || observed.negotiated?.maintenance_hold_id !== hold.id) {
          throw new Error("Force restart the service before resuming supervision.");
        }
        await this.request("daemon.prepare_handoff", undefined, SUPERVISOR_DAEMON_PROTOCOL_VERSION,
          this.requestTimeoutMs, false, undefined, undefined, true);
        // macOS may briefly lose process identity during clean exit. Wait for
        // positive exit evidence without signalling or accepting a later match.
        const stopped = await waitForConfirmedDaemonExit({
          observe: identity => this.observeRetiredDaemon(identity), now: Date.now,
          delay, pollIntervalMs: this.processPollIntervalMs,
        }, target, this.observeRetiredDaemon(target), this.terminateTimeoutMs);
        if (!["absent", "zombie"].includes(stopped.kind) || !await this.isSocketReleased(SUPERVISOR_DAEMON_PROTOCOL_VERSION, true)) {
          throw new Error("The maintenance service has not stopped. Supervision remains paused.");
        }
        await owner.clear(hold.id);
      } else {
        await forceStopDaemon({ identify, persistHold: () => owner.create(),
          observe: target => this.observeRetiredDaemon(target), signal: (target, signal) => this.guardedSignalRetiredDaemon(target, signal),
          delay, now: Date.now, pollIntervalMs: this.processPollIntervalMs,
          socketReleased: () => this.isSocketReleased(SUPERVISOR_DAEMON_PROTOCOL_VERSION, true),
          terminateTimeoutMs: this.terminateTimeoutMs, killTimeoutMs: this.killTimeoutMs });
      }
      this.stopAttachedDaemonObservation();
      this.ownedDaemon = null;
    }, this.maintenancePath);
    this.maintenanceOperation = operation;
    void operation.finally(() => { if (this.maintenanceOperation === operation) this.maintenanceOperation = null; }).catch(() => undefined);
    return operation;
  }

  ensureRunning(startupPreparation?: Promise<void>): Promise<DesktopSupervisorDaemonStatus> {
    if (this.maintenanceRequested) return Promise.reject(new Error(DAEMON_MAINTENANCE_MESSAGE));
    if (process.platform !== "darwin" && process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON !== "1") {
      return Promise.reject(new Error("Supervised agents currently require macOS."));
    }
    if (this.applicationUpdateHandoff || this.applicationUpdatePrepared) {
      return Promise.reject(new Error("Supervisor startup is paused while LetAgents installs an application update."));
    }
    if (this.environmentRefreshHandoff) return this.environmentRefreshHandoff;
    if (!this.ensureOperation) {
      const cached = this.readyStatus;
      if (cached && Date.now() < cached.expiresAt && !this.drainingCurrentDaemon
        && !this.maintenanceOperation && (!this.ownedDaemon || this.ownedDaemon.ready)) {
        return Promise.resolve(cached.status);
      }
      this.readyStatus = null;
      this.ensureOperation = Promise.resolve(startupPreparation)
        .then(() => desktopShellEnvironmentReady())
        .then(() => this.ensureRunningOnce())
        .then((status) => this.cacheReadyStatus(this.rememberReadyStatus(status)))
        .finally(() => { this.ensureOperation = null; });
    }
    return this.ensureOperation;
  }

  /** Join startup already registered by the app without starting another service. */
  async waitForStartup(): Promise<void> {
    if (!this.ensureOperation || this.drainingCurrentDaemon) return;
    let release!: () => void;
    const currentDaemonReady = new Promise<void>(resolve => { release = resolve; });
    this.startupApprovalWaiters.add(release);
    try {
      // A negotiated old daemon may need a human approval before startup can
      // replace it. Also wake reads that joined startup before negotiation.
      await Promise.race([this.ensureOperation, currentDaemonReady]);
    } finally { this.startupApprovalWaiters.delete(release); }
  }

  /** Main computes and remembers what it actually presents; renderer IDs carry no authority. */
  async listHostApprovals(roomId: string): Promise<DesktopHostApprovalSnapshot> {
    try {
      if (!approvalId.safeParse(roomId).success) throw new Error("Invalid approval room.");
      // Opening a composer must not spawn, hand off, or reconfigure a provider.
      // Wait only for startup already owned by the app; an absent or failed
      // service still returns unavailable without initiating any recovery.
      await this.waitForStartup();
      const rawChallenge = await this.request<unknown>("supervisor.host_approval_challenge");
      if (rawChallenge === null) {
        this.clearApprovalPresentations(roomId);
        return { available: false, approvals: [], error: "Host approval signing was not enrolled. Unlock secure storage and restart the background service before approving." };
      }
      const challenge = approvalChallenge.parse(rawChallenge);
      const signer = await this.signerForApproval(challenge);
      const raw = await this.request<unknown>("supervisor.host_approval_request",
        signer.sign(challenge, "list", { roomId }), undefined, MANIFEST_LIST_REQUEST_TIMEOUT_MS);
      if (!Array.isArray(raw) || raw.length > 128) throw new Error("Invalid approval presentation.");
      for (const candidate of raw) {
        const parsed = approvalCandidate.safeParse(candidate);
        if (!parsed.success || Buffer.byteLength(JSON.stringify(candidate)) > 32 * 1024
          || (parsed.data.reference && (parsed.data.reference.roomId !== roomId
            || parsed.data.reference.agentId !== parsed.data.presentation.agentId))
          || (parsed.data.presentation.alwaysAllow && (parsed.data.presentation.alwaysAllow.agentId !== parsed.data.presentation.agentId
            || parsed.data.presentation.alwaysAllow.provider !== parsed.data.presentation.provider))
          || (!parsed.data.reference && parsed.data.status !== "unavailable")
          || (parsed.data.presentation.title === "Approval unavailable" && parsed.data.status !== "unavailable"
            && !(parsed.data.status === "uncertain" && parsed.data.reference && parsed.data.recordedDecision))
          || (parsed.data.presentation.provider === "open-model") !== (parsed.data.presentation.denyScope === "session_pending")) {
          throw new Error("Invalid approval presentation.");
        }
      }
      // Preserve the transmitted property order used by the daemon's digest.
      const candidates = structuredClone(raw) as HostApprovalCandidate[];
      const now = this.now().getTime();
      for (const [key, item] of this.approvalPresentations) {
        if (now - item.touchedAt > 30 * 60 * 1000) this.approvalPresentations.delete(key);
      }
      const approvals: DesktopHostApproval[] = [];
      for (const candidate of candidates) {
        const presentationSha256 = createHash("sha256").update(JSON.stringify(candidate.presentation)).digest("hex");
        let cached = [...this.approvalPresentations.values()].find(item =>
          item.roomId === roomId && JSON.stringify(item.challenge) === JSON.stringify(challenge) && item.presentationSha256 === presentationSha256
          && JSON.stringify(item.candidate.reference) === JSON.stringify(candidate.reference));
        if (!cached) {
          cached = { roomId, view: { id: randomUUID(), presentation: candidate.presentation, status: candidate.status, detail: candidate.detail, retryDecision: null, dismissKey: null,
            requestKey: candidate.reference ? createHash("sha256").update(JSON.stringify(["host-approval-request", roomId, candidate.reference.requestId])).digest("hex") : null },
            candidate, challenge, presentationSha256, touchedAt: now, decision: null };
          this.approvalPresentations.set(cached.view.id, cached);
        }
        // Polling the same authenticated snapshot must not revoke an in-flight
        // decision. Any changed candidate still invalidates its dispatch fence.
        if (!isDeepStrictEqual(cached.candidate, candidate)) cached.candidate = candidate;
        cached.touchedAt = now;
        cached.view.status = candidate.status;
        cached.view.detail = candidate.detail;
        cached.view.retryDecision = null;
        const recorded = candidate.recordedDecision;
        if (recorded) {
          cached.decision = { id: recorded.decisionId, choice: recorded.decision, projectionSha256: recorded.projectionSha256 };
          // The retry is signed against the digest the choice was made on. The card can differ from it by now
          // (a saved mode changes the tool scope inside it) while the request does not; the daemon checks the request.
          if (candidate.status === "decision_recorded" && recorded.actorId === `host-${challenge.keyFingerprint}`
            && recorded.projectionSha256 !== null) cached.view.retryDecision = recorded.decision;
          else if (candidate.status === "pending" || candidate.status === "decision_recorded") {
            cached.view.status = "unavailable";
            cached.view.detail = "The recorded decision cannot be retried against this presentation. No new decision will be created.";
          }
        } else if (candidate.status === "decision_recorded") {
          cached.view.status = "unavailable";
          cached.view.detail = "The recorded decision identity is unavailable. No new decision will be created.";
        }
        // The daemon keeps an undecidable record visible across restarts until it
        // expires on a retired runtime, and the presentation ID is random per
        // session. Give the owner's dismissal a stable identity. Only a durable
        // record carries a reference with this reserved title; a prompt still on
        // a live lane keeps its own title even once expired, and must reappear.
        cached.view.dismissKey = candidate.reference && candidate.presentation.title === "Approval unavailable"
          ? createHash("sha256").update(JSON.stringify(["host-approval-dismissal", roomId,
            candidate.reference.requestId, candidate.reference.requestVersion, cached.view.status])).digest("hex")
          : null;
        approvals.push(structuredClone(cached.view));
      }
      const retained = new Set(approvals.map(item => item.id));
      for (const [key, item] of this.approvalPresentations) if (item.roomId === roomId && !retained.has(key)) this.approvalPresentations.delete(key);
      while (this.approvalPresentations.size > 128) this.approvalPresentations.delete(this.approvalPresentations.keys().next().value!);
      return { available: true, approvals, error: null };
    } catch {
      this.clearApprovalPresentations(roomId);
      return { available: false, approvals: [], error: "Could not load host approvals. Check secure storage and the background service, then refresh." };
    }
  }

  private clearApprovalPresentations(roomId: string): void {
    for (const [key, item] of this.approvalPresentations) if (item.roomId === roomId) this.approvalPresentations.delete(key);
  }

  private signerForApproval(challenge: HostApprovalChallenge): Promise<HostApprovalSigner> {
    if (this.approvalSigner?.fingerprint === challenge.keyFingerprint) return this.approvalSigner.promise;
    const pending = { fingerprint: challenge.keyFingerprint, promise: this.loadApprovalSigner().then(signer => {
      if (createHash("sha256").update(Buffer.from(signer.publicKey, "base64")).digest("hex") !== challenge.keyFingerprint) {
        throw new Error("Host approval signer does not match this daemon.");
      }
      return signer;
    }) };
    this.approvalSigner = pending;
    void pending.promise.catch(() => { if (this.approvalSigner === pending) this.approvalSigner = null; });
    return pending.promise;
  }

  async decideHostApproval(input: { id: string; decision: HostApprovalSelection }, assertCaller?: () => void): Promise<HostApprovalStatus> {
    if (!input || Object.keys(input).length !== 2 || typeof input.id !== "string"
      || !["allow_once", "deny", "allow_always"].includes(input.decision)) throw new Error("Invalid approval decision.");
    const selection = { id: input.id, decision: input.decision };
    assertCaller?.();
    const cached = this.approvalPresentations.get(selection.id);
    if (!cached?.candidate.reference || this.now().getTime() - cached.touchedAt > 30 * 60 * 1000) throw new Error("Refresh the approval before deciding.");
    const assertEligible = () => {
      if (selection.decision === "allow_always" && !cached.view.presentation.alwaysAllow) throw new Error("This request has no reusable tool permission.");
      if (this.approvalPresentations.get(selection.id) !== cached || this.now().getTime() - cached.touchedAt > 30 * 60 * 1000
        || (cached.view.status !== "pending" && !(cached.view.status === "decision_recorded" && cached.view.retryDecision === selection.decision))) {
        throw new Error("Refresh the approval before deciding; this request cannot currently be sent.");
      }
      if (cached.decision && cached.decision.choice !== selection.decision) throw new Error("A different decision is already recorded for this request.");
    };
    assertEligible();
    const presented = cached.candidate;
    const expected = structuredClone(cached.candidate.reference);
    const signer = await this.signerForApproval(cached.challenge);
    const challenge = approvalChallenge.parse(await this.request<unknown>("supervisor.host_approval_challenge"));
    if (JSON.stringify(challenge) !== JSON.stringify(cached.challenge)) throw new Error("The background service changed. Refresh the approval before deciding.");
    assertCaller?.();
    assertEligible();
    if (cached.candidate !== presented) throw new Error("The approval was refreshed while deciding. Check it before trying again.");
    const decision = cached.decision ?? { id: randomUUID(), choice: selection.decision, projectionSha256: null };
    const envelope = signer.sign(challenge, "decide", { expected,
      decisionId: decision.id, actorId: `host-${challenge.keyFingerprint}`,
      decision: decision.choice, projectionSha256: decision.projectionSha256 ?? cached.presentationSha256 });
    cached.decision = decision;
    cached.view.status = "uncertain";
    cached.view.retryDecision = null;
    try {
      const status = await this.request<HostApprovalStatus>("supervisor.host_approval_request", envelope,
        undefined, MANIFEST_LIST_REQUEST_TIMEOUT_MS, false, undefined, () => {
          assertCaller?.();
          if (this.approvalPresentations.get(selection.id) !== cached || cached.candidate !== presented
            || this.now().getTime() - cached.touchedAt > 30 * 60 * 1000 || cached.decision !== decision) {
            throw new Error("The approval changed before dispatch.");
          }
        });
      if (!approvalStatus.safeParse(status).success || status === "pending") throw new Error();
      if (cached.candidate === presented && cached.decision === decision) {
        cached.view.status = status;
        cached.view.retryDecision = null;
      }
      return status;
    } catch {
      // Keep the exact decision identity: the daemon may have committed it.
      if (cached.candidate === presented && cached.decision === decision) {
        cached.view.status = "uncertain";
        cached.view.retryDecision = null;
      }
      throw new Error("Could not confirm the decision. Refresh to check it; no new decision has been created.");
    }
  }

  async listHostToolRules(agentId: string): Promise<import("../../shared/host-tool-rules.js").HostToolRule[]> {
    approvalId.parse(agentId);
    await this.waitForStartup();
    const challenge = approvalChallenge.parse(await this.request<unknown>("supervisor.host_approval_challenge"));
    const signer = await this.signerForApproval(challenge);
    const raw = await this.request<unknown>("supervisor.host_approval_request", signer.sign(challenge, "list_tool_rules", { agentId }));
    const rules = z.array(hostToolRule).parse(raw);
    if (rules.some(rule => rule.scope.agentId !== agentId || rule.ownerId !== `host-${challenge.keyFingerprint}`)) throw new Error("Invalid saved permissions.");
    return rules;
  }

  async revokeHostToolRule(input: { agentId: string; ruleId: string; revision: number }, assertCaller?: () => void): Promise<void> {
    const value = z.strictObject({ agentId: approvalId, ruleId: approvalId, revision: z.number().int().positive().safe() }).parse(input);
    assertCaller?.();
    await this.waitForStartup();
    const challenge = approvalChallenge.parse(await this.request<unknown>("supervisor.host_approval_challenge"));
    const signer = await this.signerForApproval(challenge);
    assertCaller?.();
    await this.request("supervisor.host_approval_request", signer.sign(challenge, "revoke_tool_rule", value),
      undefined, MANIFEST_LIST_REQUEST_TIMEOUT_MS, false, undefined, assertCaller);
  }

  /**
   * Retire the serving daemon without touching provider processes. The next
   * desktop version will start its bundled daemon and recover exact provider
   * generations during normal startup reconciliation.
   */
  prepareForApplicationUpdate(): Promise<void> {
    this.invalidateReadyStatus();
    if (this.maintenanceRequested) return Promise.reject(new Error(DAEMON_MAINTENANCE_MESSAGE));
    if (process.platform !== "darwin" && process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON !== "1") {
      return Promise.reject(new Error("Application update handoff currently requires macOS."));
    }
    if (this.applicationUpdatePrepared) return Promise.resolve();
    if (!this.applicationUpdateHandoff) {
      this.applicationUpdateHandoff = this.prepareForApplicationUpdateOnce()
        .then(() => {
          this.applicationUpdatePrepared = true;
        })
        .finally(() => {
          this.applicationUpdateHandoff = null;
        });
    }
    return this.applicationUpdateHandoff;
  }

  /** Restore the current app's daemon only when Squirrel failed to take over. */
  resumeAfterApplicationUpdateFailure(): Promise<DesktopSupervisorDaemonStatus> {
    this.applicationUpdatePrepared = false;
    this.invalidateReadyStatus();
    return this.ensureRunning();
  }

  /** Explicit setup action: reconcile provider environment without replacing an already current service. */
  restartForEnvironmentRefresh(): Promise<DesktopSupervisorDaemonStatus> {
    if (this.maintenanceRequested) return Promise.reject(new Error(DAEMON_MAINTENANCE_MESSAGE));
    if (process.platform !== "darwin" && process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON !== "1") {
      return Promise.reject(new Error("Supervised agents currently require macOS."));
    }
    if (!this.environmentRefreshHandoff) {
      this.environmentRefreshHandoff = (async () => {
        await desktopShellEnvironmentReady();
        if (this.ensureOperation) await this.ensureOperation;
        if (this.applicationUpdateHandoff || this.applicationUpdatePrepared) {
          throw new Error("Supervisor startup is paused while LetAgents installs an application update.");
        }
        this.invalidateReadyStatus();
        this.ensureOperation = this.ensureRunningOnce(true)
          .then((status) => this.cacheReadyStatus(this.rememberReadyStatus(status)))
          .finally(() => { this.ensureOperation = null; });
        return this.ensureOperation;
      })().finally(() => {
        this.environmentRefreshHandoff = null;
      });
    }
    return this.environmentRefreshHandoff;
  }

  /** Compare only: opening setup must not retire the owner of live approval connections. */
  async isRuntimeEnvironmentCurrent(): Promise<boolean> {
    await this.waitForStartup();
    try {
      const negotiated = await this.request<Record<string, unknown>>("daemon.negotiate");
      return negotiated.runtime_environment_fingerprint ===
        supervisorDaemonSpawnEnvironment().LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT;
    } catch (error) {
      // An absent daemon will inherit this environment when explicitly started.
      if (isConnectionUnavailable(error)) return true;
      throw error;
    }
  }

  /**
   * Observe an existing daemon without becoming its lifecycle owner.
   * Subscriptions use this path so merely registering an IPC listener can
   * never spawn or resurrect the supervisor process.
   */
  async connectIfRunning(): Promise<DesktopSupervisorDaemonStatus | null> {
    if (process.platform !== "darwin" && process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON !== "1") {
      return null;
    }
    try {
      const negotiated = await this.request<Record<string, unknown>>(
        "daemon.negotiate",
        undefined,
        SUPERVISOR_DAEMON_PROTOCOL_VERSION,
      );
      const status = mapStatus(negotiated);
      this.observeAttachedDaemon(status);
      return this.rememberReadyStatus(status);
    } catch (error) {
      if (isConnectionUnavailable(error)) {
        this.recordAttachedDaemonDisconnect();
        return null;
      }
      throw error;
    }
  }

  /** Troubleshooting observes the service without taking lifecycle ownership. */
  async getServiceSnapshot(): Promise<DesktopSupervisorServiceSnapshot> {
    const status = await this.connectIfRunning();
    let state: DesktopSupervisorStateSnapshot | null = null;
    if (status && !status.maintenanceHoldId && status.capabilities.agentStateSubscription
      && supervisorStateWatchAcceptsStatus(status)) {
      state = await this.watchState({ afterDaemonGeneration: 0, afterSequence: 0, waitMs: 0 });
      if (state.daemonGeneration !== status.generation) {
        throw new Error("The background service restarted during this read. Refresh to see its current state.");
      }
    }
    return { status, state, observedAt: this.now().toISOString() };
  }

  async list(roomIdentifier?: string | null): Promise<DesktopSupervisorManifestEntry[]> {
    await this.ensureRunning();
    // Rich manifest projections open several durable stores and can be slower
    // on their first read. This must not share the tight timeout used by small
    // control requests or a healthy cold daemon is misreported as unavailable.
    // manifest.list stays the full-history read: it backs first load, the
    // stale-subscription repair, and the Inspector's payload detail. It is also
    // the expensive one, so ask the daemon to project and serialize only the
    // room this caller will keep. The client-side filter stays as well: a
    // daemon that ignored the scope still yields a correct answer.
    const entries = await this.request<WireEntry[]>(
      "manifest.list",
      roomIdentifier ? { room_id: roomIdentifier } : undefined,
      SUPERVISOR_DAEMON_PROTOCOL_VERSION,
      MANIFEST_LIST_REQUEST_TIMEOUT_MS,
    );
    return entries.map((entry) => mapEntry(entry)).filter((entry) => !roomIdentifier || entry.roomId === roomIdentifier);
  }

  async watchState(input: {
    afterDaemonGeneration: number;
    afterSequence: number;
    waitMs?: number;
  }): Promise<DesktopSupervisorStateSnapshot> {
    const waitMs = Math.max(0, Math.min(30_000, input.waitMs ?? 25_000));
    const value = await this.request<{
      daemon_generation: number;
      sequence: number;
      entries: WireEntry[];
    }>("manifest.watch_state", {
      after_daemon_generation: input.afterDaemonGeneration,
      after_sequence: input.afterSequence,
      wait_ms: waitMs,
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, waitMs + this.requestTimeoutMs, true);
    if (
      !Number.isSafeInteger(value.daemon_generation)
      || value.daemon_generation < 1
      || !Number.isSafeInteger(value.sequence)
      || value.sequence < 1
      || !Array.isArray(value.entries)
    ) {
      throw new Error("Supervisor daemon returned an invalid state snapshot.");
    }
    return {
      daemonGeneration: value.daemon_generation,
      sequence: value.sequence,
      entries: value.entries.map((entry) => mapEntry(entry, SUPERVISOR_STATE_ACTIVITY_SUMMARY_LIMIT)),
    };
  }

  async watchAgentStream(input: {
    entryId: string;
    afterSequence: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<{ sequence: number; streamGeneration: number; droppedEvents: number; events: import("../ipc-types/agents.js").DesktopAgentStreamEvent[]; ended: boolean }> {
    const waitMs = Math.max(0, Math.min(30_000, input.waitMs ?? 25_000));
    const value = await this.request<{
      sequence: number;
      stream_generation: number;
      dropped_events: number;
      events: Array<{ sequence: number; observed_at: string; kind: string; method: string; summary: string | null; payload: unknown }>;
      ended: boolean;
    }>("supervisor.watch_agent_stream", {
      entry_id: input.entryId,
      after_sequence: input.afterSequence,
      wait_ms: waitMs,
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, waitMs + this.requestTimeoutMs, true, input.signal);
    return {
      sequence: Number(value.sequence ?? input.afterSequence),
      streamGeneration: Number(value.stream_generation ?? 0),
      droppedEvents: Number(value.dropped_events ?? 0),
      ended: value.ended === true,
      events: (Array.isArray(value.events) ? value.events : []).map((event) => ({
        sequence: Number(event.sequence),
        observedAt: String(event.observed_at ?? ""),
        kind: String(event.kind ?? ""),
        method: String(event.method ?? ""),
        summary: typeof event.summary === "string" ? event.summary : null,
        payload: event.payload,
      })),
    };
  }

  /**
   * Save a new supervised entry. A normal launch is saved as `running`: the
   * daemon starts the provider only once owner authority and room delivery
   * are installed, so the entry waits durably without a separate claim step.
   * A rental launch is saved `paused` and activated after the rental server
   * acknowledges provisioning.
   */
  async create(
    input: DesktopSupervisorCreateInput,
    options: { desiredState?: "running" | "paused" } = {},
  ): Promise<DesktopSupervisorManifestEntry> {
    if (!input.charter.trim()) throw new Error("A supervised agent initial message is required.");
    const creationRequestId = input.creationRequestId?.trim() || randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(creationRequestId)) {
      throw new Error("A valid supervised agent creation request id is required.");
    }
    const now = this.now().toISOString();
    const entry: WireEntry = {
      id: `supervised_${creationRequestId}`,
      room_id: input.roomIdentifier,
      ...(input.localRoomId ? { local_room_id: input.localRoomId } : {}),
      display_name: input.displayName.trim() || "Supervised agent",
      provider: input.providerId,
      model: input.model?.trim() || null,
      charter: input.charter.trim(),
      desired_state: options.desiredState ?? "running",
      observed_state: "absent",
      condition: "none",
      permission_profile_id: input.permissionProfileId ?? null,
      // Admission declares the durable ingress owner independently from the
      // provider's opaque native launch policy. Provider descriptors opt into
      // daemon delivery only after their bounded-turn adapter is ready.
      delivery_mode: supervisedDeliveryModeForProvider(input.providerId),
      // A caller-supplied policy belongs to the selected native provider. Do
      // not reinterpret it as a LetAgents permission profile on its way to
      // the daemon. The Codex default remains only for the existing UI that
      // has not supplied an explicit provider policy yet.
      provider_launch_policy: input.launchPolicy ?? (input.providerId === "codex" && (!input.permissionProfileId || input.permissionProfileId === "full_access")
        ? { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }
        : {}),
      created_by: "desktop",
      created_at: now,
      source_repo_path: input.repoRootPath?.trim() || null,
      workspace_path: null,
      work_attempt_id: null,
      workplace_liveness: { state: "unknown", observed_at: null, detail: "Awaiting room registration." },
      native_liveness: { state: "unknown", observed_at: null, detail: "Awaiting native provider launch." },
      activity: [],
      // Creation is the one authoritative point where the desktop can prove
      // no worker session has ever been minted for this immutable entry id.
      // Legacy entries that omitted this field remain revocation-unknown.
      last_worker_binding: null,
    };
    await this.ensureRunning();
    return mapEntry(await this.request<WireEntry>("manifest.put", { entry }));
  }

  async setDesiredState(id: string, desiredState: DesktopSupervisorDesiredState): Promise<DesktopSupervisorManifestEntry> {
    if (!nonEmptyString(id) || !["running", "paused", "stopped"].includes(desiredState)) throw new Error("Agent lifecycle requires an exact identity and desired state.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentLifecycle) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable agent lifecycle operations; rebuild the desktop daemon."); }
    return mapEntry(await this.request<WireEntry>("manifest.set_desired_state", { id, desired_state: desiredState }));
  }

  async recoverAgentRuntime(id: string, recovery?: import("../ipc-types.js").DesktopSupervisorRuntimeRecoveryInput["recovery"]): Promise<DesktopSupervisorManifestEntry> {
    if (!nonEmptyString(id) || id !== id.trim()) {
      throw new Error("Agent runtime recovery requires an exact identity.");
    }
    const status = await this.ensureRunning();
    if (recovery && !status.capabilities.agentRuntimeRecoveryV2) {
      this.invalidateReadyStatus();
      throw new Error("Update the background service to use reconnect and runtime restart controls.");
    }
    if (!status.capabilities.agentRuntimeRecovery) {
      this.invalidateReadyStatus();
      throw new Error("This supervisor is too old for safe provider runtime recovery; rebuild the desktop daemon.");
    }
    const result = await this.request<{ outcome: "recovering"; entry: WireEntry }>(
      "supervisor.recover_agent_runtime",
      { entry_id: id, daemon_generation: status.generation, ...(recovery ? { mode: recovery.mode,
        operation_id: recovery.operationId, room_id: recovery.roomId,
        execution_generation_id: recovery.executionGenerationId, runtime_generation_id: recovery.runtimeGenerationId } : {}) },
      SUPERVISOR_DAEMON_PROTOCOL_VERSION,
      RECOVERY_REQUEST_TIMEOUT_MS,
    );
    return mapEntry(result.entry);
  }

  async setDisplayName(id: string, displayName: string): Promise<DesktopSupervisorManifestEntry> {
    const normalized = displayName.trim();
    if (!nonEmptyString(id) || !normalized || normalized.length > 120) {
      throw new Error("Agent naming requires an exact identity and display name.");
    }
    const status = await this.ensureRunning();
    if (!status.capabilities.agentLifecycle) {
      this.invalidateReadyStatus();
      throw new Error("This supervisor is too old for durable agent naming; rebuild the desktop daemon.");
    }
    return mapEntry(await this.request<WireEntry>("manifest.set_display_name", {
      id,
      display_name: normalized,
    }));
  }

  /** This call deliberately accepts only a renderer-safe exact identity tuple. */
  async retryRoomDelivery(input: DesktopSupervisorRoomDeliveryRetryInput): Promise<void> {
    const status = await this.ensureRunning();
    if (!status.capabilities.roomDeliveryRetry) {
      this.invalidateReadyStatus();
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

  async restoreAgentConversation(input: import("../ipc-types/agents.js").DesktopSupervisorConversationRestoreInput): Promise<void> {
    const status = await this.ensureRunning();
    if (!status.capabilities.providerContinuationRepair) {
      this.invalidateReadyStatus();
      throw new Error("This supervisor does not support provider conversation restoration.");
    }
    await this.request<{ accepted: boolean }>("supervisor.restore_agent_conversation", {
      entry_id: input.entryId,
      room_id: input.roomId,
      source_message_id: input.sourceMessageId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      agent_session_id: input.agentSessionId,
      daemon_generation: status.generation,
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, this.turnControlRequestTimeoutMs);
  }

  async skipRoomDelivery(input: import("../ipc-types/agents.js").DesktopSupervisorRoomDeliverySkipInput): Promise<void> {
    const status = await this.ensureRunning();
    if (!status.capabilities.roomDeliverySkip) {
      this.invalidateReadyStatus();
      throw new Error("This supervisor does not support safely skipping a blocked room message.");
    }
    await this.request<{ accepted: boolean }>("supervisor.skip_room_delivery", {
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
    if (!nonEmptyString(id) || !["running", "paused", "stopped"].includes(expectedDesiredState) || !["running", "paused", "stopped"].includes(desiredState)) throw new Error("Agent lifecycle compare-and-set requires exact typed fields.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentLifecycle) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable agent lifecycle operations; rebuild the desktop daemon."); }
    const result = await this.request<{ applied: boolean; entry: WireEntry }>("manifest.compare_and_set_desired_state", {
      id,
      expected_desired_state: expectedDesiredState,
      desired_state: desiredState,
    });
    return result.applied ? mapEntry(result.entry) : null;
  }

  async controlTurn(input: DesktopSupervisorTurnControlInput): Promise<DesktopSupervisorTurnControlResult> {
    if (!input || !nonEmptyString(input.entryId) || !nonEmptyString(input.roomId)
      || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1
      || !nonEmptyString(input.workAttemptId) || !nonEmptyString(input.executionGenerationId)
      || !nonEmptyString(input.providerContinuationId) || !nonEmptyString(input.providerTurnId)
      || !nonEmptyString(input.inboxItemId) || !nonEmptyString(input.sourceMessageId)
      || !validTurnControlActionId(input.actionId)
      || !Number.isSafeInteger(input.actionSequence) || input.actionSequence < 1
      || (input.correction !== null && input.correction !== undefined && typeof input.correction !== "string")) {
      throw new Error("Turn control requires exact typed identity and a bounded action id.");
    }
    const status = await this.ensureRunning();
    if (status.generation !== input.daemonGeneration) {
      this.invalidateReadyStatus();
      throw new Error("The supervisor generation changed before turn control was sent.");
    }
    return this.request<DesktopSupervisorTurnControlResult>("manifest.control_turn", {
      id: input.entryId,
      daemon_generation: input.daemonGeneration,
      room_id: input.roomId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      provider_continuation_id: input.providerContinuationId,
      provider_turn_id: input.providerTurnId,
      inbox_item_id: input.inboxItemId,
      source_message_id: input.sourceMessageId,
      action_id: input.actionId,
      action_sequence: input.actionSequence,
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
    const detail = await this.request<Record<string, unknown>>("attempt.read", { id }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, MANIFEST_LIST_REQUEST_TIMEOUT_MS);
    return {
      entryId: String(detail.entry_id ?? id),
      workAttemptId: typeof detail.work_attempt_id === "string" ? detail.work_attempt_id : null,
      workspacePath: typeof detail.workspace_path === "string" ? detail.workspace_path : null,
      lastTerminal: detail.last_terminal && typeof detail.last_terminal === "object" ? detail.last_terminal as Record<string, unknown> : null,
      restartCount: Number(detail.restart_count ?? 0),
      activity: Array.isArray(detail.activity) ? detail.activity.map((event) => mapActivity(event as WireActivityEvent)) : [],
    };
  }
  async getAgentInspectorDetail(input: import("../ipc-types/agents.js").DesktopSupervisorAgentInspectorDetailInput): Promise<import("../ipc-types/agents.js").DesktopSupervisorAgentInspectorDetail> {
    if (!nonEmptyString(input.entryId) || !nonEmptyString(input.roomId) || (input.sourceMessageId !== undefined && input.sourceMessageId !== null && !nonEmptyString(input.sourceMessageId))) throw new Error("Agent inspector detail requires exact non-empty entry, room, and optional source identities.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentInspectorDetail) { this.invalidateReadyStatus(); throw new Error("This supervisor does not support agent inspector detail history."); }
    const detail = await this.request<Record<string, unknown>>("supervisor.get_agent_inspector_detail", { entry_id: input.entryId, room_id: input.roomId, source_message_id: input.sourceMessageId ?? null }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, MANIFEST_LIST_REQUEST_TIMEOUT_MS);
    return mapAgentInspectorDetail(detail, input);
  }

  async getAgentConfiguration(entryId: string, daemonGeneration: number): Promise<import("../ipc-types/agents.js").DesktopSupervisorAgentConfiguration> {
    if (!nonEmptyString(entryId) || !Number.isSafeInteger(daemonGeneration) || daemonGeneration < 1) throw new Error("Agent configuration requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentInspectorSettings) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for Inspector settings; rebuild the desktop daemon."); }
    const value = await this.request<Record<string, unknown>>("supervisor.get_agent_configuration", { entry_id: entryId, daemon_generation: daemonGeneration }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, MANIFEST_LIST_REQUEST_TIMEOUT_MS);
    return mapAgentConfiguration(value, entryId, daemonGeneration);
  }

  async updateAgentConfiguration(input: import("../ipc-types/agents.js").DesktopSupervisorAgentConfigurationUpdateInput): Promise<import("../ipc-types/agents.js").DesktopSupervisorAgentConfigurationUpdateResult> {
    if (!input || !nonEmptyString(input.entryId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || !input.configuration || typeof input.configuration !== "object"
      || !Object.hasOwn(input.configuration, "model") || !Object.hasOwn(input.configuration, "reasoningEffort") || !Object.hasOwn(input.configuration, "charter") || !Object.hasOwn(input.configuration, "permissionProfileId")) throw new Error("Agent configuration update requires exact typed coordinates and fields.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentInspectorSettings) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for Inspector settings; rebuild the desktop daemon."); }
    const result = await this.request<Record<string, unknown>>("supervisor.update_agent_configuration", { entry_id: input.entryId, daemon_generation: input.daemonGeneration, expected_revision: input.expectedRevision, configuration: {
      model: input.configuration.model, reasoning_effort: input.configuration.reasoningEffort, charter: input.configuration.charter,
      permission_profile_id: input.configuration.permissionProfileId,
      ...(typeof input.configuration.imageInput === "boolean" ? { image_input: input.configuration.imageInput } : {}),
    } });
    if (result.outcome === "invalid") {
      if (typeof result.error !== "string" || !result.error.trim()) throw new Error("Supervisor returned an invalid configuration error response.");
      return { outcome: "invalid", error: result.error };
    }
    if (result.outcome !== "updated" && result.outcome !== "conflict") throw new Error("Supervisor returned an invalid configuration update result.");
    return { outcome: result.outcome, configuration: mapAgentConfiguration(record(result.configuration) ?? {}, input.entryId, input.daemonGeneration) };
  }

  /**
   * Let one agent use the owner's own provider setup, or stop it. The request
   * is signed with the desktop app's own key, so the daemon accepts it from
   * nothing else that can reach its socket: not an agent, and not an agent's
   * tools.
   */
  async setAgentHomeHarness(
    input: import("../ipc-types/agents.js").DesktopSupervisorAgentHomeHarnessInput,
    assertCaller?: () => void,
  ): Promise<import("../ipc-types/agents.js").DesktopSupervisorAgentHomeHarnessResult> {
    const value = z.strictObject({
      entryId: approvalId, daemonGeneration: z.number().int().positive().safe(),
      expectedRevision: z.number().int().positive().safe(), enabled: z.boolean(),
    }).parse(input);
    assertCaller?.();
    await this.waitForStartup();
    const rawChallenge = await this.request<unknown>("supervisor.host_approval_challenge");
    if (rawChallenge === null) {
      return { outcome: "invalid", error: "This app could not prove the change came from you. Unlock secure storage and restart the background service, then try again." };
    }
    const challenge = approvalChallenge.parse(rawChallenge);
    const signer = await this.signerForApproval(challenge);
    assertCaller?.();
    const result = record(await this.request<unknown>("supervisor.host_approval_request", signer.sign(challenge, "set_home_harness", value),
      undefined, MANIFEST_LIST_REQUEST_TIMEOUT_MS, false, undefined, assertCaller)) ?? {};
    if (result.outcome === "invalid") {
      if (typeof result.error !== "string" || !result.error.trim()) throw new Error("Supervisor returned an invalid configuration error response.");
      return { outcome: "invalid", error: result.error };
    }
    if (result.outcome !== "updated" && result.outcome !== "conflict") throw new Error("Supervisor returned an invalid configuration update result.");
    // Present only when turning it off met a process that still had the owner's setup.
    const restart = !Object.hasOwn(result, "apply") ? {}
      : { restart: result.apply === "restarting" ? "restarting" as const : result.apply === "busy_active_turn" ? "busy" as const : "not_restarted" as const };
    return { outcome: result.outcome, configuration: mapAgentConfiguration(record(result.configuration) ?? {}, value.entryId, value.daemonGeneration), ...restart };
  }

  /**
   * Share one agent's live activity with its room, or stop. Signed like the
   * owner's-setup choice, so nothing else that reaches the daemon's socket,
   * an agent included, can share an agent's work with its room.
   */
  async setAgentLiveSharing(
    input: import("../ipc-types/agents.js").DesktopSupervisorAgentLiveSharingInput,
    assertCaller?: () => void,
  ): Promise<import("../ipc-types/agents.js").DesktopSupervisorAgentConfigurationUpdateResult> {
    const value = z.strictObject({
      entryId: approvalId, daemonGeneration: z.number().int().positive().safe(), enabled: z.boolean(),
    }).parse(input);
    assertCaller?.();
    await this.waitForStartup();
    const rawChallenge = await this.request<unknown>("supervisor.host_approval_challenge");
    if (rawChallenge === null) {
      return { outcome: "invalid", error: "This app could not prove the change came from you. Unlock secure storage and restart the background service, then try again." };
    }
    const challenge = approvalChallenge.parse(rawChallenge);
    const signer = await this.signerForApproval(challenge);
    assertCaller?.();
    const result = record(await this.request<unknown>("supervisor.host_approval_request", signer.sign(challenge, "set_live_sharing", value),
      undefined, MANIFEST_LIST_REQUEST_TIMEOUT_MS, false, undefined, assertCaller)) ?? {};
    if (result.outcome === "invalid") {
      if (typeof result.error !== "string" || !result.error.trim()) throw new Error("Supervisor returned an invalid configuration error response.");
      return { outcome: "invalid", error: result.error };
    }
    if (result.outcome !== "updated") throw new Error("Supervisor returned an invalid configuration update result.");
    return { outcome: "updated", configuration: mapAgentConfiguration(record(result.configuration) ?? {}, value.entryId, value.daemonGeneration) };
  }

  async applyAgentConfiguration(input: import("../ipc-types/agents.js").DesktopSupervisorAgentConfigurationApplyInput): Promise<import("../ipc-types/agents.js").DesktopSupervisorAgentConfigurationApplyResult> {
    if (!input || !nonEmptyString(input.entryId)
      || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1
      || !Number.isSafeInteger(input.expectedConfigurationRevision) || input.expectedConfigurationRevision < 1) {
      throw new Error("Agent configuration apply requires exact typed coordinates.");
    }
    const status = await this.ensureRunning();
    if (!status.capabilities.agentInspectorSettings) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for Inspector settings; rebuild the desktop daemon."); }
    const result = await this.request<Record<string, unknown>>(
      "supervisor.apply_agent_configuration",
      {
        entry_id: input.entryId,
        daemon_generation: input.daemonGeneration,
        expected_configuration_revision: input.expectedConfigurationRevision,
      },
      SUPERVISOR_DAEMON_PROTOCOL_VERSION,
      CONFIGURATION_APPLY_REQUEST_TIMEOUT_MS,
    );
    if (result.outcome !== "already_applied"
      && result.outcome !== "restarting"
      && result.outcome !== "busy_active_turn"
      && result.outcome !== "conflict"
      && result.outcome !== "unsupported") {
      throw new Error("Supervisor returned an invalid configuration apply result.");
    }
    return { outcome: result.outcome };
  }

  async prepareRoomMove(input: import("../ipc-types/agents.js").DesktopSupervisorRoomMovePrepareInput): Promise<import("../ipc-types/agents.js").DesktopSupervisorRoomMove> {
    if (!nonEmptyString(input.entryId) || !nonEmptyString(input.destinationRoomId) || !nonEmptyString(input.requestId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Room-move preparation requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    return mapRoomMove(await this.request<Record<string, unknown>>("supervisor.prepare_room_move", { entry_id: input.entryId, destination_room_id: input.destinationRoomId, request_id: input.requestId, daemon_generation: input.daemonGeneration }), input.entryId);
  }

  async commitRoomMove(input: import("../ipc-types/agents.js").DesktopSupervisorRoomMoveOperationInput): Promise<import("../ipc-types/agents.js").DesktopSupervisorRoomMove> {
    if (!nonEmptyString(input.operationId) || !nonEmptyString(input.entryId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Room-move commit requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    return mapRoomMove(await this.request<Record<string, unknown>>("supervisor.commit_room_move", { operation_id: input.operationId, entry_id: input.entryId, daemon_generation: input.daemonGeneration }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 15_000), input.entryId, input.operationId);
  }

  async acknowledgeRoomMoveSourceRevocation(input: import("../ipc-types/agents.js").DesktopSupervisorRoomMoveOperationInput & { sourceAgentSessionId: string }): Promise<import("../ipc-types/agents.js").DesktopSupervisorRoomMove> {
    if (!nonEmptyString(input.operationId) || !nonEmptyString(input.entryId) || !nonEmptyString(input.sourceAgentSessionId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Room-move credential acknowledgement requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    return mapRoomMove(await this.request<Record<string, unknown>>("supervisor.acknowledge_room_move_source_revocation", {
      operation_id: input.operationId, entry_id: input.entryId, source_agent_session_id: input.sourceAgentSessionId, daemon_generation: input.daemonGeneration,
    }), input.entryId, input.operationId);
  }

  async rollbackRoomMove(input: import("../ipc-types/agents.js").DesktopSupervisorRoomMoveOperationInput & { error: string }): Promise<import("../ipc-types/agents.js").DesktopSupervisorRoomMove> {
    if (!nonEmptyString(input.operationId) || !nonEmptyString(input.entryId) || !nonEmptyString(input.error) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Room-move rollback requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    return mapRoomMove(await this.request<Record<string, unknown>>("supervisor.rollback_room_move", {
      operation_id: input.operationId, entry_id: input.entryId, error: input.error, daemon_generation: input.daemonGeneration,
    }), input.entryId, input.operationId);
  }

  async getRoomMove(input: import("../ipc-types/agents.js").DesktopSupervisorRoomMoveOperationInput): Promise<import("../ipc-types/agents.js").DesktopSupervisorRoomMove> {
    if (!nonEmptyString(input.operationId) || !nonEmptyString(input.entryId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Room-move status requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    return mapRoomMove(await this.request<Record<string, unknown>>("supervisor.get_room_move", { operation_id: input.operationId, entry_id: input.entryId, daemon_generation: input.daemonGeneration }), input.entryId, input.operationId);
  }

  async getCurrentRoomMove(input: import("../ipc-types/agents.js").DesktopSupervisorCurrentRoomMoveInput): Promise<import("../ipc-types/agents.js").DesktopSupervisorRoomMove | null> {
    if (!nonEmptyString(input.entryId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Current room-move discovery requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    const result = await this.request<Record<string, unknown> | null>("supervisor.get_current_room_move", {
      entry_id: input.entryId,
      daemon_generation: input.daemonGeneration,
    });
    return result === null ? null : mapRoomMove(result, input.entryId);
  }

  async retireAgent(
    entryId: string,
    daemonGeneration: number,
    revokedAgentSessionId: string | null = null,
    grantRevokedWithoutWorkerSession = false,
  ): Promise<{
    outcome: "retired" | "invalid" | "revocation_required";
    revocationKind?: "worker_session" | "grant_only";
    agentSessionId?: string;
    error?: string;
  }> {
    if (!nonEmptyString(entryId) || !Number.isSafeInteger(daemonGeneration) || daemonGeneration < 1
      || !(revokedAgentSessionId === null || nonEmptyString(revokedAgentSessionId))
      || (revokedAgentSessionId !== null && grantRevokedWithoutWorkerSession)
      || typeof grantRevokedWithoutWorkerSession !== "boolean") throw new Error("Retire requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentLifecycle) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable agent lifecycle operations; rebuild the desktop daemon."); }
    const result = await this.request<Record<string, unknown>>("supervisor.retire_agent", {
      entry_id: entryId,
      daemon_generation: daemonGeneration,
      revoked_agent_session_id: revokedAgentSessionId,
      grant_revoked_without_worker_session: grantRevokedWithoutWorkerSession,
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, RETIRE_REQUEST_TIMEOUT_MS);
    if (result.outcome === "retired") return { outcome: "retired" };
    if (result.outcome === "revocation_required") {
      if (result.revocation_kind === "worker_session"
        && typeof result.agent_session_id === "string" && result.agent_session_id.trim()) {
        return { outcome: "revocation_required", revocationKind: "worker_session", agentSessionId: result.agent_session_id };
      }
      if (result.revocation_kind === "grant_only" && result.agent_session_id === undefined) {
        return { outcome: "revocation_required", revocationKind: "grant_only" };
      }
    }
    if (result.outcome === "invalid" && typeof result.error === "string" && result.error.trim()) {
      return { outcome: "invalid", error: result.error };
    }
    throw new Error("Supervisor returned an invalid retirement result.");
  }

  async purgeAgent(
    entryId: string,
    daemonGeneration: number,
    revokedAgentSessionId: string | null = null,
    grantRevokedWithoutWorkerSession = false,
    includeCleanupIdentity = false,
  ): Promise<{
    outcome: "purged" | "invalid" | "revocation_required";
    operationId?: string;
    revocationKind?: "worker_session" | "grant_only";
    agentSessionId?: string;
    purgedWorkAttemptId?: string;
    error?: string;
  }> {
    if (!nonEmptyString(entryId) || !Number.isSafeInteger(daemonGeneration) || daemonGeneration < 1
      || !(revokedAgentSessionId === null || nonEmptyString(revokedAgentSessionId))
      || (revokedAgentSessionId !== null && grantRevokedWithoutWorkerSession)
      || typeof grantRevokedWithoutWorkerSession !== "boolean"
      || typeof includeCleanupIdentity !== "boolean") throw new Error("Purge requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentLifecycle) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable agent lifecycle operations; rebuild the desktop daemon."); }
    const result = await this.request<Record<string, unknown>>("supervisor.purge_agent", {
      entry_id: entryId,
      daemon_generation: daemonGeneration,
      revoked_agent_session_id: revokedAgentSessionId,
      grant_revoked_without_worker_session: grantRevokedWithoutWorkerSession,
    });
    if (result.outcome === "purged") {
      return {
        outcome: "purged",
        ...(includeCleanupIdentity && typeof result.purged_work_attempt_id === "string" && result.purged_work_attempt_id.trim()
          ? { purgedWorkAttemptId: result.purged_work_attempt_id }
          : {}),
      };
    }
    if (result.outcome === "revocation_required" && typeof result.operation_id === "string" && result.operation_id.trim()) {
      if (result.revocation_kind === "worker_session"
        && typeof result.agent_session_id === "string" && result.agent_session_id.trim()) {
        return {
          outcome: "revocation_required",
          operationId: result.operation_id,
          revocationKind: "worker_session",
          agentSessionId: result.agent_session_id,
        };
      }
      if (result.revocation_kind === "grant_only" && result.agent_session_id === undefined) {
        return { outcome: "revocation_required", operationId: result.operation_id, revocationKind: "grant_only" };
      }
    }
    if (result.outcome === "invalid" && typeof result.error === "string" && result.error.trim()) return { outcome: "invalid", error: result.error };
    throw new Error("Supervisor returned an invalid purge result.");
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
    if (result.status !== "installed") this.invalidateReadyStatus();
    return result.status === "installed" ? "installed" : "stale";
  }

  /**
   * Main-process-only Open Model credential ingress. The provider key is
   * decrypted by Electron and crosses only the owner-only daemon socket.
   */
  async installOpenModelCredential(input: {
    entryId: string;
    apiKey: string | null;
    baseUrl: string;
    model: string;
    contextWindow?: number | null;
    daemonGeneration: number;
  }): Promise<"installed" | "stale"> {
    if (!input.baseUrl.trim() || !input.model.trim()) {
      throw new Error("An Open Model endpoint and model are required.");
    }
    const status = await this.ensureRunning();
    if (status.generation !== input.daemonGeneration) { this.invalidateReadyStatus(); return "stale"; }
    const result = await this.request<{ status?: unknown }>(
      "supervisor.install_open_model_credential",
      {
        entry_id: input.entryId,
        api_key: input.apiKey,
        base_url: input.baseUrl,
        model: input.model,
        ...(input.contextWindow != null ? { context_window: input.contextWindow } : {}),
        daemon_generation: input.daemonGeneration,
      },
    );
    if (result.status !== "installed") this.invalidateReadyStatus();
    return result.status === "installed" ? "installed" : "stale";
  }

  /**
   * Main-process-only grant ingress.  This is deliberately not represented in
   * IPC types: a supervisor bearer may cross only the owner-only Unix socket
   * to the exact daemon generation that will hold it in process memory.
   */
  async installHostGrant(input: {
    entryId: string;
    roomId: string;
    agentKey: string;
    grantId: string;
    supervisorGrant: string;
    grantGeneration: number;
    daemonGeneration: number;
    hostId: string;
    installationId: string;
    ownerAccountId: string | null;
    scopeKey: string | null;
    expiresAt: string;
    apiUrl?: string;
    /** Rebind only an already-live exact provider generation; never converge. */
    credentialOnly?: boolean;
    /** Install owner authority for explicit runtime replacement; never attach or converge. */
    recoveryOnly?: boolean;
  }): Promise<"installed" | "stale" | "provider_unavailable"> {
    if (input.credentialOnly && input.recoveryOnly) {
      throw new Error("Host grant installation cannot be both reconnect-only and recovery-only.");
    }
    if (!input.supervisorGrant.trim()) throw new Error("A supervised host grant is required.");
    const status = await this.ensureRunning();
    // Never let a request started against an old process install into its
    // successor. The daemon independently checks this fence too.
    if (status.generation !== input.daemonGeneration) { this.invalidateReadyStatus(); return "stale"; }
    const result = await this.request<{ status?: unknown }>("supervisor.install_host_grant", {
      entry_id: input.entryId,
      room_id: input.roomId,
      agent_key: input.agentKey,
      grant_id: input.grantId,
      supervisor_grant: input.supervisorGrant,
      grant_generation: input.grantGeneration,
      host_id: input.hostId,
      installation_id: input.installationId,
      owner_account_id: input.ownerAccountId,
      scope_key: input.scopeKey,
      grant_expires_at: input.expiresAt,
      api_url: input.apiUrl ?? apiUrl,
      daemon_generation: input.daemonGeneration,
      credential_only: Boolean(input.credentialOnly),
      ...(input.recoveryOnly ? { recovery_only: true } : {}),
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, INSTALL_HOST_GRANT_REQUEST_TIMEOUT_MS);
    if (result.status === "installed" || result.status === "provider_unavailable") return result.status;
    this.invalidateReadyStatus();
    return "stale";
  }

  /** Queue exact host-side delegation discovery; no authority crosses IPC. */
  async syncExecutionDelegations(roomId: string): Promise<"queued" | "stale"> {
    const status = await this.ensureRunning();
    const result = await this.request<{ status?: unknown }>("supervisor.sync_execution_delegations", {
      room_id: roomId,
      daemon_generation: status.generation,
    });
    if (result.status !== "queued") this.invalidateReadyStatus();
    return result.status === "queued" ? "queued" : "stale";
  }

  /** Establish a daemon-inbox entry's one-time durable room boundary. */
  async bootstrapRoomIngress(entryId: string, daemonGeneration: number, initialMessage?: string): Promise<"bootstrapped" | "existing" | "stale"> {
    const status = await this.ensureRunning();
    if (status.generation !== daemonGeneration) { this.invalidateReadyStatus(); return "stale"; }
    const result = await this.request<{ status?: unknown }>("supervisor.bootstrap_room_ingress", {
      entry_id: entryId,
      daemon_generation: daemonGeneration,
      ...(initialMessage?.trim() ? { initial_message: initialMessage.trim() } : {}),
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, BOOTSTRAP_INGRESS_REQUEST_TIMEOUT_MS);
    if (result.status !== "bootstrapped" && result.status !== "existing") this.invalidateReadyStatus();
    return result.status === "bootstrapped" || result.status === "existing" ? result.status : "stale";
  }

  private async ensureRunningOnce(refreshRuntimeEnvironment = false): Promise<DesktopSupervisorDaemonStatus> {
    await this.waitForOwnedDaemonReadiness();
    this.assertNotRestarting();
    const hold = await readDaemonMaintenance(this.maintenancePath);
    const spawnEnvironment = supervisorDaemonSpawnEnvironment();
    const expectedRuntimeEnvironmentFingerprint = spawnEnvironment.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT!;
    let retiredGeneration: number | undefined;
    try {
      const negotiated = await this.request<Record<string, unknown>>("daemon.negotiate", undefined, SUPERVISOR_DAEMON_PROTOCOL_VERSION)
        .catch((error: unknown) => {
          if (!(error instanceof SupervisorDaemonRequestTimeoutError) || error.method !== "daemon.negotiate") throw error;
          this.assertNotRestarting();
          // Sibling provider starts can briefly delay the service. Retry only
          // this read, once, with the existing rich-read bound. A timeout is
          // never evidence that another daemon may be spawned.
          return this.request<Record<string, unknown>>("daemon.negotiate", undefined,
            SUPERVISOR_DAEMON_PROTOCOL_VERSION, MANIFEST_LIST_REQUEST_TIMEOUT_MS);
        });
      this.assertNotRestarting();
      if (hold && negotiated.maintenance_hold_id !== hold.id) throw new Error("Service maintenance is pending. Use Force restart service in Settings → Updates.");
      const daemonVersion = Number(negotiated.protocol_version ?? 0);
      const implementationVersion = String(negotiated.implementation_version ?? "unknown");
      if (
        daemonVersion === SUPERVISOR_DAEMON_PROTOCOL_VERSION
        && Boolean(hold) === Boolean(negotiated.maintenance_hold_id)
        && implementationVersion === SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION
        && negotiated.compatibility_fingerprint === spawnEnvironment.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT
        && (!refreshRuntimeEnvironment || negotiated.runtime_environment_fingerprint === expectedRuntimeEnvironmentFingerprint)
      ) {
        const status = mapStatus(negotiated);
        this.observeAttachedDaemon(status);
        return status;
      }
      const retired = this.captureRetiredDaemon(negotiated);
      retiredGeneration = Number(negotiated.generation);
      // Handoff drains in-flight provider dispatch reservations, which can
      // span a full provider launch; the tight control timeout aborted real
      // upgrades attempted while any agent was mid-launch.
      await this.drainCurrentDaemon(daemonVersion);
      this.stopAttachedDaemonObservation();
      await this.enforceRetiredDaemonExit(retired, daemonVersion, implementationVersion);
      if (this.ownedDaemon?.pid === retired.pid) this.ownedDaemon = null;
    } catch (error) {
      if (!isConnectionUnavailable(error)) throw error;
      this.recordAttachedDaemonDisconnect();
      // A previously ready child can also temporarily lose its socket. Only
      // its exit/handoff, never a failed connection, permits another launch.
      if (this.ownedDaemon) throw error;
    }
    await access(this.daemonScriptPath);
    this.stopAttachedDaemonObservation();
    await mkdir(this.daemonWorkingDirectory, { recursive: true, mode: 0o700 });
    // OS-backed signing may wait for disk or a Keychain dialog. Finish that
    // before the child starts its bounded verifier handshake, rather than
    // racing secure storage against the child's one-second IPC deadline.
    const signer = hold ? null : await this.loadApprovalSigner().catch(() => null);
    const approvalPublicKey = signer?.publicKey ?? null;
    this.assertNotRestarting();
    if (signer) this.approvalSigner = {
      fingerprint: createHash("sha256").update(Buffer.from(signer.publicKey, "base64")).digest("hex"),
      promise: Promise.resolve(signer),
    };
    const child = this.spawnDaemon(this.daemonScriptPath, this.daemonWorkingDirectory, spawnEnvironment);
    if (child.pid) {
      const identity = this.safeInspectDaemon(child.pid);
      if (identity?.state === "live" && identity.pid === child.pid) this.maintenanceTarget = { ...identity, expectedScriptPath: this.daemonScriptPath };
    }
    const statePreparation = prepareSupervisorState(child, undefined, this.statePreparationWaitMs,
      async () => approvalPublicKey);
    const childPid = Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0 ? child.pid! : null;
    const owned = {
      pid: childPid,
      ready: false,
      retiredGeneration,
      runtimeEnvironmentFingerprint: expectedRuntimeEnvironmentFingerprint,
      compatibilityFingerprint: spawnEnvironment.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT!,
    };
    this.ownedDaemon = owned;
    appendDaemonLifecycleEvent(this.lifecycleLogPath, { event: "daemon_spawned", pid: childPid });
    child.once("error", (error) => {
      // An error after a successful spawn may be an IPC/signalling error,
      // not process death. A failed spawn has no native PID to preserve.
      this.invalidateReadyStatus();
      if (childPid === null && this.ownedDaemon === owned) this.ownedDaemon = null;
      appendDaemonLifecycleEvent(this.lifecycleLogPath, {
        event: "daemon_spawn_error",
        pid: childPid,
        detail: error instanceof Error ? error.stack || error.message : String(error),
      });
    });
    child.once("exit", (exitCode, signal) => {
      this.invalidateReadyStatus();
      if (this.ownedDaemon === owned) this.ownedDaemon = null;
      appendDaemonLifecycleEvent(this.lifecycleLogPath, {
        event: "daemon_exited",
        pid: childPid,
        exitCode,
        signal,
      });
    });
    // Migration/OS-key custody has its own bootstrap protocol. The socket's
    // short startup deadline must not expire while a large backup is fsyncing.
    await statePreparation;
    const status = await this.waitForHealthy(owned.retiredGeneration,
      owned.runtimeEnvironmentFingerprint, owned.compatibilityFingerprint);
    owned.ready = true;
    return status;
  }

  private async waitForOwnedDaemonReadiness(): Promise<void> {
    const owned = this.ownedDaemon;
    if (!owned || owned.ready) return;
    await this.waitForHealthy(owned.retiredGeneration,
      owned.runtimeEnvironmentFingerprint, owned.compatibilityFingerprint);
    owned.ready = true;
  }

  private async drainCurrentDaemon(daemonVersion: number): Promise<void> {
    this.invalidateReadyStatus();
    this.drainingCurrentDaemon = true;
    for (const ready of this.startupApprovalWaiters) ready();
    try {
      // Approval reads must reach this live owner even when ensureOperation is
      // waiting for an upgrade. Joining that promise would deadlock the turn.
      await this.request("daemon.prepare_handoff", undefined, daemonVersion, HANDOFF_DRAIN_REQUEST_TIMEOUT_MS);
    } finally {
      this.drainingCurrentDaemon = false;
    }
  }

  private async prepareForApplicationUpdateOnce(): Promise<void> {
    if (this.ensureOperation) await this.ensureOperation;
    await this.waitForOwnedDaemonReadiness();
    let negotiated: Record<string, unknown>;
    try {
      negotiated = await this.request<Record<string, unknown>>(
        "daemon.negotiate",
        undefined,
        SUPERVISOR_DAEMON_PROTOCOL_VERSION,
      );
    } catch (error) {
      // A failed or never-started supervisor has no owner-only socket to
      // relinquish. Keep the update fence active, but do not prevent Squirrel
      // from replacing the app that may contain the daemon recovery fix.
      if (isConnectionUnavailable(error) && !this.ownedDaemon) return;
      throw error;
    }
    const daemonVersion = Number(negotiated.protocol_version ?? 0);
    const implementationVersion = String(negotiated.implementation_version ?? "unknown");
    const retired = this.captureRetiredDaemon(negotiated);
    await this.drainCurrentDaemon(daemonVersion);
    this.stopAttachedDaemonObservation();
    await this.enforceRetiredDaemonExit(retired, daemonVersion, implementationVersion);
    if (this.ownedDaemon?.pid === retired.pid) this.ownedDaemon = null;
  }

  private async waitForHealthy(
    retiredGeneration: number | undefined,
    expectedRuntimeEnvironmentFingerprint: string,
    expectedCompatibilityFingerprint: string,
  ): Promise<DesktopSupervisorDaemonStatus> {
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
        if (result.runtime_environment_fingerprint !== expectedRuntimeEnvironmentFingerprint) {
          throw new Error("Replacement supervisor daemon did not inherit the current provider runtime environment.");
        }
        if (result.compatibility_fingerprint !== expectedCompatibilityFingerprint) {
          throw new Error("Replacement supervisor daemon did not inherit the current state and runtime identity.");
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
    // A prior app install or a local development build can legitimately own
    // the stable daemon socket. Let that negotiated daemon retire itself, but
    // retain the current script path as the hard boundary for TERM/KILL: only
    // the exact executable this desktop expected to launch may be signalled.
    return this.maintenanceTarget = { ...inspected, expectedScriptPath: this.daemonScriptPath };
  }

  private observeAttachedDaemon(status: DesktopSupervisorDaemonStatus): void {
    if (status.pid === this.ownedDaemon?.pid) {
      this.stopAttachedDaemonObservation();
      return;
    }
    if (
      this.attachedDaemonObservation?.identity.pid === status.pid
      && this.attachedDaemonObservation.generation === status.generation
    ) return;
    this.stopAttachedDaemonObservation();
    const inspected = this.safeInspectDaemon(status.pid);
    if (!inspected || inspected.state !== "live" || inspected.pid !== status.pid) return;
    const observation = {
      identity: { ...inspected, expectedScriptPath: this.daemonScriptPath },
      generation: status.generation,
    };
    this.attachedDaemonObservation = observation;
    this.maintenanceTarget = observation.identity;
  }

  private recordAttachedDaemonDisconnect(): void {
    this.invalidateReadyStatus();
    const observation = this.attachedDaemonObservation;
    if (!observation) return;
    const current = this.observeRetiredDaemon(observation.identity);
    if (current.kind === "same" || current.kind === "unverifiable") return;
    this.attachedDaemonObservation = null;
    appendDaemonLifecycleEvent(this.lifecycleLogPath, {
      event: current.kind === "changed" ? "daemon_identity_changed" : "daemon_disappeared",
      pid: observation.identity.pid,
      generation: observation.generation,
      detail: current.kind === "changed"
        ? current.reason
        : `Observed daemon became ${current.kind}.`,
    });
  }

  private stopAttachedDaemonObservation(): void {
    this.attachedDaemonObservation = null;
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

    if (!this.commandPointsAtExpectedDaemon(retired.command, retired.expectedScriptPath)) {
      throw new Error(authorityReleased
        ? "A LetAgents daemon from another installation released its socket but did not exit; it was not signalled and the replacement was not started."
        : "A LetAgents daemon from another installation did not retire after the negotiated handoff; it was not signalled and the replacement was not started.");
    }

    if (implementationVersion === "2.0.25" && authorityReleased) {
      this.emitHandoffDiagnostic(retired, implementationVersion, authorityReleased, "legacy_sigterm_expected", "Daemon 2.0.25 released authority but retains live RPC handles; SIGTERM escalation is expected.");
    }
    this.assertNotRestarting();
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

    this.assertNotRestarting();
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

  private async isSocketReleased(daemonVersion: number, maintenance = false): Promise<boolean> {
    try {
      await this.request("daemon.negotiate", undefined, daemonVersion, this.requestTimeoutMs, false, undefined, undefined, maintenance);
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

}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const supervisorDaemonClient = new SupervisorDaemonClient();
supervisorDaemonClient.onGeneration((status) => {
  if (stateWatchUnsupportedGeneration !== status.generation) {
    stateWatchUnsupportedGeneration = null;
  }
  if (stateEmitter.listenerCount("state") > 0) ensureSupervisorStateWatch();
});

export function onSupervisorActivity(
  listener: (payload: { entryId: string; event: DesktopSupervisorActivityEvent }) => void,
): () => void {
  activityEmitter.on("activity", listener);
  return () => activityEmitter.off("activity", listener);
}

export function onSupervisorState(
  listener: (snapshot: DesktopSupervisorStateSnapshot) => void,
): () => void {
  stateEmitter.on("state", listener);
  ensureSupervisorStateWatch();
  return () => stateEmitter.off("state", listener);
}

/**
 * Agents that are not retired, from the last pushed state and without activity
 * history. App-wide attention reads this instead of a full-history
 * `manifest.list` of every room; null until the watch has delivered state.
 */
export function liveSupervisorStateEntries(): DesktopSupervisorManifestEntry[] | null {
  return latestSupervisorState ? projectLiveSupervisorEntries(latestSupervisorState.entries) : null;
}

export function projectLiveSupervisorEntries(entries: readonly DesktopSupervisorManifestEntry[]): DesktopSupervisorManifestEntry[] {
  return entries.filter((entry) => entry.desiredState !== "stopped").map((entry) => ({ ...entry, activity: [] }));
}

function ensureSupervisorStateWatch(): void {
  if (stateWatchOperation || stateEmitter.listenerCount("state") === 0) return;
  stateWatchOperation = runSupervisorStateWatch().finally(() => {
    stateWatchOperation = null;
  });
}

async function runSupervisorStateWatch(): Promise<void> {
  try { await watchSupervisorState(); }
  // Attention reads only what the current watch has confirmed: never state
  // from a stopped, replaced, unsupported or unreachable daemon.
  finally { latestSupervisorState = null; }
}

async function watchSupervisorState(): Promise<void> {
  let afterDaemonGeneration = 0;
  let afterSequence = 0;
  let consecutiveFailures = 0;
  while (stateEmitter.listenerCount("state") > 0) {
    try {
      const status = await supervisorDaemonClient.connectIfRunning();
      if (!status) return;
      if (!supervisorStateWatchAcceptsStatus(status)) {
        latestSupervisorState = null;
        // Startup may briefly attach to the previous desktop build's daemon
        // while the lifecycle owner performs a negotiated handoff. Do not
        // project its additive wire shape as current durable state.
        await unrefDelay(STATE_WATCH_RETRY_BASE_MS);
        continue;
      }
      if (stateWatchUnsupportedGeneration === status.generation) return;
      if (!status.capabilities.agentStateSubscription) {
        stateWatchUnsupportedGeneration = status.generation;
        return;
      }
      if (afterDaemonGeneration !== status.generation) {
        afterDaemonGeneration = 0;
        afterSequence = 0;
      }
      const snapshot = await supervisorDaemonClient.watchState({
        afterDaemonGeneration,
        afterSequence,
      });
      afterDaemonGeneration = snapshot.daemonGeneration;
      afterSequence = snapshot.sequence;
      consecutiveFailures = 0;
      latestSupervisorState = snapshot;
      stateEmitter.emit("state", snapshot);
    } catch {
      // The renderer keeps its last authoritative snapshot. Reconnection is a
      // transport concern and must not transiently dismantle its live controls.
      // A capped exponential delay avoids turning a persistent failure into a
      // tight background loop.
      latestSupervisorState = null;
      consecutiveFailures += 1;
      await unrefDelay(supervisorStateWatchRetryDelay(consecutiveFailures));
    }
  }
}

function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export function onSupervisorAgentStream(
  listener: (batch: import("../ipc-types/agents.js").DesktopAgentStreamBatch) => void,
): () => void {
  agentStreamEmitter.on("agent-stream", listener);
  return () => agentStreamEmitter.off("agent-stream", listener);
}

/**
 * Focus the live feed on exactly one agent (or clear it). Only the inspected
 * agent's token firehose is streamed; switching focus abandons the previous
 * long-poll and starts a fresh one. Passing null stops streaming entirely.
 */
export function setFocusedAgentStream(entryId: string | null): void {
  if (focusedAgentStreamEntryId === entryId) return;
  focusedAgentStreamEntryId = entryId;
  // The epoch distinguishes close→reopen of the same agent while an old
  // long-poll is still in flight. Entry identity alone cannot observe that
  // lifecycle edge, and would otherwise resume the stale cursor/feed.
  focusedAgentStreamEpoch += 1;
  // Destroy the old long-poll socket now. Waiting for its 25-second server
  // timeout would make close→reopen of the same agent appear frozen even
  // though the renderer requested a new viewer lifecycle.
  agentStreamWatchAbortController?.abort();
  if (entryId && !agentStreamWatchOperation) {
    agentStreamWatchOperation = runAgentStreamWatch().finally(() => { agentStreamWatchOperation = null; });
  }
}

async function runAgentStreamWatch(): Promise<void> {
  let afterSequence = 0;
  let watchedEntryId: string | null = null;
  let watchedGeneration = 0;
  let watchedFocusEpoch = -1;
  let consecutiveFailures = 0;
  let endedNotified = false;
  let watchedStreamGeneration = 0;
  while (focusedAgentStreamEntryId !== null) {
    const entryId = focusedAgentStreamEntryId;
    const focusEpoch = focusedAgentStreamEpoch;
    try {
      const status = await supervisorDaemonClient.connectIfRunning();
      if (!status) return;
      if (focusedAgentStreamEntryId !== entryId || focusedAgentStreamEpoch !== focusEpoch) continue;
      if (!status.capabilities.agentActivityStream) {
        // Old daemon: tell the renderer the feed is unavailable, then stop.
        agentStreamEmitter.emit("agent-stream", {
          entryId,
          events: [],
          ended: true,
          reset: true,
          droppedEvents: 0,
        });
        return;
      }
      // A focus change or daemon restart resets the cursor and the ended latch.
      if (watchedEntryId !== entryId || watchedGeneration !== status.generation || watchedFocusEpoch !== focusEpoch) {
        watchedEntryId = entryId;
        watchedGeneration = status.generation;
        watchedFocusEpoch = focusEpoch;
        afterSequence = 0;
        endedNotified = false;
        watchedStreamGeneration = 0;
      }
      const watchController = new AbortController();
      agentStreamWatchAbortController = watchController;
      const batch = await supervisorDaemonClient.watchAgentStream({
        entryId,
        afterSequence,
        signal: watchController.signal,
      }).finally(() => {
        if (agentStreamWatchAbortController === watchController) agentStreamWatchAbortController = null;
      });
      consecutiveFailures = 0;
      if (focusedAgentStreamEntryId !== entryId || focusedAgentStreamEpoch !== focusEpoch) continue; // focus moved or closed/reopened mid-poll
      afterSequence = batch.sequence;
      const reset = watchedStreamGeneration !== batch.streamGeneration;
      watchedStreamGeneration = batch.streamGeneration;
      // A reopened provider generation reuses the daemon buffer and keeps its
      // monotonic cursor, so post-reopen events climb past ours and clear the
      // latch; the renderer un-ends the feed on the next non-ended batch.
      if (batch.events.length > 0) endedNotified = false;
      if (reset || batch.events.length > 0 || batch.droppedEvents > 0 || (batch.ended && !endedNotified)) {
        agentStreamEmitter.emit("agent-stream", {
          entryId,
          events: batch.events,
          ended: batch.ended,
          reset,
          droppedEvents: batch.droppedEvents,
        });
      }
      if (batch.ended) {
        // `ended` is a generation boundary, not a terminal state: the daemon
        // keeps the entry so the next generation reopens the feed. Notify the
        // renderer once and stay subscribed while this entry is focused, idling
        // so a permanently ended feed re-polls slowly instead of spinning.
        endedNotified = true;
        if (focusedAgentStreamEntryId === entryId) await unrefDelay(AGENT_STREAM_REOPEN_POLL_MS);
      }
    } catch {
      if (focusedAgentStreamEntryId !== entryId || focusedAgentStreamEpoch !== focusEpoch) continue;
      consecutiveFailures += 1;
      await unrefDelay(supervisorStateWatchRetryDelay(consecutiveFailures));
    }
  }
}

