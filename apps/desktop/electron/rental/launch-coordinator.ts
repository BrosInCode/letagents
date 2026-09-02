import { createHash } from "node:crypto";

import type {
  DesktopRentalLaunchConfiguration,
  DesktopRentalSession,
} from "../ipc-types/rental.js";
import type { DesktopSupervisorManifestEntry } from "../ipc-types/agents.js";
import { getOrCreateDesktopHostId } from "../main/agents/state.js";
import {
  assertRentalSafePermissionProfile,
  isRentalSafePermissionProfile,
} from "../main/agents/rental-permission-profiles.js";
import { runDesktopAgentProviderPreflight } from "../main/agents/providers.js";
import { redactCredentialText } from "../main/agents/provider-evidence.js";
import {
  getOrCreateDesktopSupervisorAgentIdentity,
} from "../main/supervisor-grant.js";
import {
  supervisorDaemonClient,
  type SupervisorDaemonClient,
} from "../main/supervisor-daemon.js";
import {
  supervisorGrantCoordinator,
  type SupervisorGrantCoordinator,
} from "../main/supervisor-grant-coordinator.js";
import { mapApiSession } from "./api-mapper.js";
import type { RentalApiClient, RentalApiResult } from "./api-client.js";
import {
  listRentalLaunches,
  pruneRentalLaunches,
  readRentalLaunch,
  writeRentalLaunch,
  type RentalLaunchJournalEntry,
} from "./launch-journal.js";
import { rentalProviderInstallationId } from "./provider-host-manager.js";

type Json = Record<string, unknown>;
const READY_TIMEOUT_MS = 45_000;
const READY_POLL_MS = 500;
const RECONCILE_MS = 30_000;
const TERMINAL_SESSION_STATUSES = new Set(["budget_exhausted", "completed", "cancelled", "expired", "failed"]);

export type RentalLaunchFailureCode =
  | "invalid_configuration"
  | "provider_unavailable"
  | "accept_failed"
  | "authority_failed"
  | "daemon_unavailable"
  | "launch_failed"
  | "launch_timeout"
  | "ack_failed";

export class RentalLaunchError extends Error {
  constructor(readonly code: RentalLaunchFailureCode, message: string, readonly retryable = true) {
    super(message);
    this.name = "RentalLaunchError";
  }
}

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function unwrapSession(value: unknown): Json {
  const body = object(value);
  return Object.keys(object(body.session)).length ? object(body.session) : body;
}

function sessionRoom(value: unknown): string | null {
  const session = unwrapSession(value);
  return string(session.roomIdentifier) || string(session.room_id) || string(session.targetRoomId) || string(session.target_room_id);
}

function launchAttempt(value: unknown): number {
  const session = unwrapSession(value);
  return number(session.launchAttempt ?? session.launch_attempt, 1);
}

function launchId(sessionId: string, attempt: number): string {
  return `rental_${createHash("sha256").update(`${sessionId}\0${attempt}`).digest("hex").slice(0, 32)}`;
}

function requireOk(result: RentalApiResult<unknown>, code: RentalLaunchFailureCode, operation: string): unknown {
  if (result.ok) return result.body;
  const nonRetryable = result.error === "request_expired"
    || result.error === "unsafe_rental_runtime_profile"
    || result.error === "accept_selection_mismatch"
    || result.error === "launch_selection_required"
    || result.error === "launch_state_transition_invalid"
    || result.error.startsWith("invalid_transition");
  throw new RentalLaunchError(
    code,
    `${operation} failed (${result.error}).`,
    !nonRetryable && (result.status === 0 || result.status >= 500 || result.status === 409),
  );
}

function mappedSession(value: unknown): DesktopRentalSession {
  const mapped = mapApiSession(unwrapSession(value));
  if (!mapped) throw new RentalLaunchError("ack_failed", "LetAgents returned an invalid rental session.");
  return mapped;
}

function isExactActiveLaunch(
  value: unknown,
  attempt: number,
  entryId: string,
  roomAgentSessionId: string,
): boolean {
  const session = unwrapSession(value);
  return string(session.launchState ?? session.launch_state) === "active"
    && Number(session.launchAttempt ?? session.launch_attempt) === attempt
    && string(session.daemonEntryId ?? session.daemon_entry_id) === entryId
    && string(session.roomAgentSessionId ?? session.room_agent_session_id) === roomAgentSessionId;
}

export class RentalLaunchCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly api: RentalApiClient,
    private readonly daemon: SupervisorDaemonClient = supervisorDaemonClient,
    private readonly grants: SupervisorGrantCoordinator = supervisorGrantCoordinator,
    private readonly hostId: () => string = getOrCreateDesktopHostId,
    private readonly resolveIdentity: typeof getOrCreateDesktopSupervisorAgentIdentity = getOrCreateDesktopSupervisorAgentIdentity,
    private readonly preflight: typeof runDesktopAgentProviderPreflight = runDesktopAgentProviderPreflight,
  ) {}

  async acceptAndLaunch(sessionId: string, configuration: DesktopRentalLaunchConfiguration): Promise<DesktopRentalSession> {
    return this.serialize(sessionId, () => this.acceptAndLaunchOnce(sessionId, configuration));
  }

  /** Reinstall normal supervisor authority elsewhere, then restore only the
   * rental-specific acknowledgement/deadline journal in this coordinator. */
  async recover(): Promise<void> {
    await pruneRentalLaunches().catch(() => undefined);
    const launches = await listRentalLaunches();
    for (const launch of launches) {
      if (launch.state === "active" || launch.state === "launching" || launch.state === "stopping") {
        this.schedulePersistedDeadline(launch);
      }
    }
    const entries = await this.daemon.list(null).catch(() => null);
    await Promise.allSettled(launches.map(async (launch) => {
      if (launch.state === "accepting") {
        if (!launch.configuration) {
          await this.record({ ...launch, state: "failed" });
          return;
        }
        await this.acceptAndLaunch(launch.sessionId, launch.configuration).catch(() => undefined);
        return;
      }
      const recoveredEntry = entries?.find((candidate) => candidate.id === launch.entryId);
      // Transport failure is not proof that the worker is absent. The periodic
      // reconciliation loop will retry once the daemon can be queried.
      if (!entries && (launch.state === "active" || launch.state === "launching")) return;
      if (recoveredEntry && !isRentalSafePermissionProfile(
        recoveredEntry.provider,
        recoveredEntry.permissionProfileId,
      )) {
        await this.fenceRecoveredLaunch(launch, recoveredEntry, "The stored rental permission profile is no longer safe.");
        return;
      }
      if (launch.state === "active") {
        if (!this.isHealthyRentalEntry(recoveredEntry)) {
          await this.fenceRecoveredLaunch(launch, recoveredEntry, "The rental worker was not found during recovery.");
          return;
        }
        const result = await this.api.getSession(launch.sessionId);
        if (!result.ok) return;
        const session = mappedSession(result.body);
        if (TERMINAL_SESSION_STATUSES.has(session.status)) {
          await this.teardown(launch.sessionId);
          return;
        }
        this.scheduleDeadline(launch, session);
        return;
      }
      if (launch.state !== "launching") return;
      const entry = recoveredEntry;
      if (!entry || entry.desiredState !== "running") {
        await this.fenceRecoveredLaunch(launch, entry, "The rental worker was not found during recovery.");
        return;
      }
      const ready = await this.waitForEntry(entry.id, (candidate) => this.isHealthyRentalEntry(candidate), READY_TIMEOUT_MS).catch(() => null);
      if (!ready) {
        await this.fenceRecoveredLaunch(launch, entry, "The rental worker did not become ready during recovery.");
        return;
      }
      await this.acknowledgeRecoveredLaunch(launch, ready);
    }));
    this.startReconciliation();
  }

  async teardown(sessionId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      const launch = await readRentalLaunch(sessionId);
      if (!launch || launch.state === "stopped") return;
      await this.record({ ...launch, state: "stopping" });
      const timer = this.deadlineTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      this.deadlineTimers.delete(sessionId);
      await this.stopAndPurge(launch.entryId);
      await this.record({ ...launch, state: "stopped" });
    });
  }

  private async acceptAndLaunchOnce(sessionId: string, configuration: DesktopRentalLaunchConfiguration): Promise<DesktopRentalSession> {
    const id = sessionId.trim();
    if (!id || !["codex", "claude-code", "cursor", "open-model"].includes(configuration.providerId)) {
      throw new RentalLaunchError("invalid_configuration", "Choose an available local runtime.", false);
    }
    // A provider-side path is never renter repository authority. The scoped
    // rental workspace materializer will supply a future repository bundle.
    let permissionProfileId: string;
    try {
      permissionProfileId = assertRentalSafePermissionProfile(
        configuration.providerId,
        configuration.permissionProfileId,
      ).id;
    } catch (error) {
      throw new RentalLaunchError(
        "invalid_configuration",
        error instanceof Error ? error.message : "Choose a rental-safe permission profile.",
        false,
      );
    }
    const readiness = await this.preflight(configuration.providerId, {
      repoRootPath: process.cwd(),
      launchMode: "supervised",
      model: configuration.model,
      permissionProfileId,
    }).catch(() => null);
    if (!readiness?.canStart) {
      throw new RentalLaunchError("provider_unavailable", readiness?.detail || readiness?.message || "The selected runtime is unavailable.");
    }

    const existing = await readRentalLaunch(id);
    if (existing?.state === "active") {
      return mappedSession(requireOk(await this.api.getSession(id), "ack_failed", "Rental refresh"));
    }
    const hostId = this.hostId();
    const durableConfiguration: DesktopRentalLaunchConfiguration = {
      providerId: configuration.providerId,
      model: configuration.model?.trim() || null,
      permissionProfileId,
    };
    await this.record({
      sessionId: id,
      launchAttempt: 0,
      entryId: `supervised_${launchId(id, 0)}`,
      roomId: "",
      state: "accepting",
      configuration: durableConfiguration,
      updatedAt: new Date().toISOString(),
    });
    let acceptedBody: unknown;
    try {
      acceptedBody = requireOk(await this.api.acceptRequest(id, {
        hostId,
        installationId: rentalProviderInstallationId(hostId),
        runtime: {
          kind: durableConfiguration.providerId,
          modelLabel: durableConfiguration.model,
          permissionProfileId,
        },
      }), "accept_failed", "Rental acceptance");
    } catch (error) {
      if (error instanceof RentalLaunchError && !error.retryable) {
        const current = await readRentalLaunch(id);
        if (current) await this.record({ ...current, state: "failed" });
      }
      throw error;
    }
    const roomId = sessionRoom(acceptedBody);
    if (!roomId) throw new RentalLaunchError("accept_failed", "The accepted rental has no target room.", false);
    const attempt = launchAttempt(acceptedBody);
    const creationRequestId = launchId(id, attempt);
    const entryId = `supervised_${creationRequestId}`;
    await this.record({
      sessionId: id,
      launchAttempt: attempt,
      entryId,
      roomId,
      state: "launching",
      configuration: durableConfiguration,
      updatedAt: new Date().toISOString(),
    });

    let prepared: DesktopSupervisorManifestEntry | null = null;
    let activationMayHaveCommitted = false;
    try {
      await this.daemon.ensureRunning().catch(() => { throw new RentalLaunchError("daemon_unavailable", "Background agent management is unavailable."); });
      const agentKey = await this.resolveIdentity({
        entryId,
        displayName: `Rented ${configuration.providerId}`,
        providerId: configuration.providerId,
      });
      const authorityBody = requireOk(await this.api.requestLaunchAuthority(id, {
        agentKey,
        agentInstanceId: entryId,
        displayName: `Rented ${configuration.providerId}`,
        ideLabel: configuration.providerId,
      }), "authority_failed", "Rental launch authority");
      const authority = object(authorityBody);
      const grant = object(authority.grant);
      const token = string(grant.supervisor_grant ?? grant.supervisorGrant);
      const grantId = string(grant.grant_id ?? grant.grantId);
      const expiresAt = string(grant.expires_at ?? grant.expiresAt);
      if (!token || !grantId || !expiresAt) throw new RentalLaunchError("authority_failed", "Rental launch authority is incomplete.", false);
      const grantGeneration = number(grant.current_generation ?? grant.generation, 1);
      const { entry } = await this.grants.createRentalPausedAndInstall({
        creationRequestId,
        roomIdentifier: roomId,
        displayName: `Rented ${configuration.providerId}`,
        providerId: configuration.providerId,
        model: configuration.model?.trim() || null,
        charter: this.rentalCharter(string(unwrapSession(acceptedBody).taskPrompt ?? unwrapSession(acceptedBody).task_prompt)),
        permissionProfileId,
        repoRootPath: null,
        agentKey,
        preparedGrant: {
          metadata: {
            grantId,
            hostId,
            installationId: rentalProviderInstallationId(hostId),
            allowedRoomIds: [roomId],
            allowedAgentKeys: [agentKey],
            generation: grantGeneration,
            expiresAt,
          },
          // This endpoint does not currently attest the stable owner/scope
          // tuple, so rental grants remain ineligible for remote delegation.
          authority: null,
          token,
        },
      });
      prepared = entry;
      requireOk(await this.api.acknowledgeLaunch(id, {
        launchAttempt: attempt,
        state: "provisioning",
        daemonEntryId: entry.id,
      }), "ack_failed", "Rental provisioning acknowledgement");
      const activated = await this.daemon.compareAndSetDesiredState(entry.id, "paused", "running");
      if (!activated) throw new RentalLaunchError("launch_failed", "The rental launch changed before activation.");
      const ready = await this.waitForEntry(entry.id, (candidate) => this.isHealthyRentalEntry(candidate), READY_TIMEOUT_MS);
      const roomAgentSessionId = ready.agentSessionId;
      if (!roomAgentSessionId) throw new RentalLaunchError("launch_failed", "The rental worker lost its room binding before activation.");
      activationMayHaveCommitted = true;
      const activeResult = await this.api.acknowledgeLaunch(id, {
        launchAttempt: attempt,
        state: "active",
        daemonEntryId: ready.id,
        roomAgentSessionId,
        agentKey,
      });
      let activeBody: unknown;
      if (activeResult.ok) {
        activeBody = activeResult.body;
      } else {
        const refreshed = await this.api.getSession(id).catch(() => null);
        if (refreshed?.ok && isExactActiveLaunch(
          refreshed.body,
          attempt,
          ready.id,
          roomAgentSessionId,
        )) {
          activeBody = refreshed.body;
        } else {
          if (activeResult.status >= 400 && activeResult.status < 500) {
            activationMayHaveCommitted = false;
          }
          activeBody = requireOk(activeResult, "ack_failed", "Rental activation acknowledgement");
        }
      }
      const session = mappedSession(activeBody);
      const activeLaunch = { sessionId: id, launchAttempt: attempt, entryId: ready.id, roomId, state: "active" as const, configuration: durableConfiguration, updatedAt: new Date().toISOString() };
      await this.record(activeLaunch);
      activationMayHaveCommitted = false;
      this.scheduleDeadline(activeLaunch, session);
      return session;
    } catch (error) {
      const rawFailure = error instanceof RentalLaunchError
        ? error
        : new RentalLaunchError("launch_failed", redactCredentialText(error instanceof Error ? error.message : String(error)).value);
      const failure = new RentalLaunchError(
        rawFailure.code,
        redactCredentialText(rawFailure.message).value,
        rawFailure.retryable,
      );
      if (activationMayHaveCommitted) {
        throw new RentalLaunchError(
          failure.code,
          `${failure.message} The local worker was preserved while LetAgents confirms activation.`,
          true,
        );
      }
      if (prepared) await this.stopAndPurge(prepared.id).catch(() => undefined);
      await this.api.acknowledgeLaunch(id, {
        launchAttempt: attempt,
        state: "launch_failed",
        daemonEntryId: prepared?.id,
        errorCode: failure.code,
        errorMessage: failure.message,
      }).catch(() => undefined);
      await this.record({ sessionId: id, launchAttempt: attempt, entryId, roomId, state: "failed", updatedAt: new Date().toISOString() });
      throw failure;
    }
  }

  private async waitForEntry(
    entryId: string,
    predicate: (entry: DesktopSupervisorManifestEntry) => boolean,
    timeoutMs: number,
  ): Promise<DesktopSupervisorManifestEntry> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entry = (await this.daemon.list(null)).find((candidate) => candidate.id === entryId);
      if (entry && predicate(entry)) return entry;
      if (entry?.observedState === "failed" || entry?.condition === "quarantined") {
        throw new RentalLaunchError("launch_failed", entry.lastError || "The supervised rental runtime failed.");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    throw new RentalLaunchError("launch_timeout", "The rented agent did not become ready in time.");
  }

  private async purge(entry: DesktopSupervisorManifestEntry): Promise<void> {
    const generation = (await this.daemon.ensureRunning()).generation;
    const prepared = await this.daemon.purgeAgent(entry.id, generation);
    if (prepared.outcome !== "revocation_required") return;
    if (prepared.revocationKind === "worker_session" && prepared.agentSessionId) {
      await this.grants.revokeEntryForPurge(entry.id, prepared.agentSessionId);
      await this.daemon.purgeAgent(entry.id, generation, prepared.agentSessionId);
      return;
    }
    await this.grants.revokeEntryForPurgeWithoutWorkerSession(entry.id);
    await this.daemon.purgeAgent(entry.id, generation, null, true);
  }

  private async stopAndPurge(entryId: string): Promise<void> {
    await this.daemon.setDesiredState(entryId, "stopped");
    const stopped = await this.waitForEntry(
      entryId,
      (entry) => entry.observedState === "stopped"
        || entry.observedState === "absent"
        || entry.observedState === "failed",
      15_000,
    );
    await this.purge(stopped);
  }

  private scheduleDeadline(launch: RentalLaunchJournalEntry, session: DesktopRentalSession): void {
    // A persisted deadline is authoritative across restarts and temporary API
    // outages. Recomputing it from a later refresh would silently extend the
    // renter's lease.
    if (this.schedulePersistedDeadline(launch)) return;
    const duration = session.timeLimitMinutes;
    if (!duration || duration <= 0) return;
    const startedAt = session.startedAt ? Date.parse(session.startedAt) : Date.now();
    const deadlineAt = Number.isFinite(startedAt) ? startedAt + duration * 60_000 : Date.now() + duration * 60_000;
    this.armDeadline(launch.sessionId, deadlineAt);
    void this.record({ ...launch, deadlineAt: new Date(deadlineAt).toISOString() }).catch(() => undefined);
  }

  private schedulePersistedDeadline(launch: RentalLaunchJournalEntry): boolean {
    const deadlineAt = launch.deadlineAt ? Date.parse(launch.deadlineAt) : Number.NaN;
    if (!Number.isFinite(deadlineAt)) return false;
    this.armDeadline(launch.sessionId, deadlineAt);
    return true;
  }

  private armDeadline(sessionId: string, deadlineAt: number): void {
    const previous = this.deadlineTimers.get(sessionId);
    if (previous) clearTimeout(previous);
    const delay = Math.max(0, deadlineAt - Date.now());
    const timer = setTimeout(() => void this.completeAtDeadline(sessionId), delay);
    timer.unref();
    this.deadlineTimers.set(sessionId, timer);
  }

  private rentalCharter(taskPrompt: string | null): string {
    const task = taskPrompt || "Work with the renter in this room within the granted capability envelope.";
    return `${task}\n\nRental context: you may inspect the full room history with the room tools. Earlier messages are context, not new tasks; act on this rental task and subsequent room messages.`;
  }

  private async completeAtDeadline(sessionId: string): Promise<void> {
    this.deadlineTimers.delete(sessionId);
    // The provider owns the active capacity lease, so a deadline must update
    // server state as well as stopping the local process. Completion is safe
    // to retry; a terminal/conflict response still proceeds with teardown.
    const completion = await this.api.completeSession(sessionId, { summary: "Rental time limit reached." }).catch(() => null);
    await this.teardown(sessionId).catch(() => undefined);
    if (!completion?.ok) {
      const launch = await readRentalLaunch(sessionId);
      if (launch) await this.record({ ...launch, state: "stopping" }).catch(() => undefined);
    }
  }

  private startReconciliation(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      void this.reconcileActiveSessions().catch(() => undefined);
    }, RECONCILE_MS);
    this.reconcileTimer.unref();
  }

  private async reconcileActiveSessions(): Promise<void> {
    const launches = await listRentalLaunches();
    for (const launch of launches) {
      if (launch.state === "active" || launch.state === "launching" || launch.state === "stopping") {
        this.schedulePersistedDeadline(launch);
      }
    }
    const entries = await this.daemon.list(null).catch(() => null);
    await Promise.allSettled(launches.map(async (launch) => {
      if (launch.state === "accepting") {
        if (launch.configuration) {
          await this.acceptAndLaunch(launch.sessionId, launch.configuration).catch(() => undefined);
        }
        return;
      }
      if (launch.state !== "active" && launch.state !== "stopping" && launch.state !== "launching") return;
      if (!entries) return;
      const entry = entries.find((candidate) => candidate.id === launch.entryId);
      if (launch.state === "launching") {
        if (!this.isHealthyRentalEntry(entry)) {
          await this.fenceRecoveredLaunch(launch, entry, "The rental worker is no longer available.");
        } else {
          await this.acknowledgeRecoveredLaunch(launch, entry);
        }
        return;
      }
      if (launch.state === "active" && !this.isHealthyRentalEntry(entry)) {
        await this.fenceRecoveredLaunch(launch, entry, "The rental worker is no longer available.");
        return;
      }
      const result = await this.api.getSession(launch.sessionId);
      if (!result.ok) return;
      const session = mappedSession(result.body);
      if (TERMINAL_SESSION_STATUSES.has(session.status)) {
        if (entry) await this.teardown(launch.sessionId);
        else await this.record({ ...launch, state: "stopped" });
        return;
      }
      if (launch.state === "stopping") {
        const completion = await this.api.completeSession(launch.sessionId, { summary: "Rental time limit reached." });
        if (completion.ok) {
          if (entry) await this.teardown(launch.sessionId);
          else await this.record({ ...launch, state: "stopped" });
        }
        return;
      }
      this.scheduleDeadline(launch, session);
    }));
  }

  private async record(entry: RentalLaunchJournalEntry): Promise<void> {
    await writeRentalLaunch({ ...entry, updatedAt: new Date().toISOString() });
  }

  private isHealthyRentalEntry(entry: DesktopSupervisorManifestEntry | undefined): entry is DesktopSupervisorManifestEntry {
    return Boolean(
      entry
      && entry.desiredState === "running"
      && entry.agentSessionId
      && entry.agentSessionBindingState === "active"
      && entry.readyReachedAt
      && entry.observedState !== "failed"
      && entry.observedState !== "stopped"
      && entry.condition !== "quarantined",
    );
  }

  private async acknowledgeRecoveredLaunch(
    launch: RentalLaunchJournalEntry,
    entry: DesktopSupervisorManifestEntry,
  ): Promise<void> {
    if (!entry.agentSessionId) return;
    const result = await this.api.acknowledgeLaunch(launch.sessionId, {
      launchAttempt: launch.launchAttempt,
      state: "active",
      daemonEntryId: entry.id,
      roomAgentSessionId: entry.agentSessionId,
    }).catch(() => null);
    let body: unknown;
    if (result?.ok) {
      body = result.body;
    } else {
      const refreshed = await this.api.getSession(launch.sessionId).catch(() => null);
      if (!refreshed?.ok || !isExactActiveLaunch(
        refreshed.body,
        launch.launchAttempt,
        entry.id,
        entry.agentSessionId,
      )) return;
      body = refreshed.body;
    }
    const session = mappedSession(body);
    const recovered = { ...launch, state: "active" as const };
    await this.record(recovered);
    this.scheduleDeadline(recovered, session);
  }

  private async fenceRecoveredLaunch(
    launch: RentalLaunchJournalEntry,
    entry: DesktopSupervisorManifestEntry | undefined,
    reason: string,
  ): Promise<void> {
    const timer = this.deadlineTimers.get(launch.sessionId);
    if (timer) clearTimeout(timer);
    this.deadlineTimers.delete(launch.sessionId);
    if (launch.state === "active" || launch.state === "stopping") {
      await this.record({ ...launch, state: "stopping" });
      const completion = await this.api.completeSession(launch.sessionId, { summary: reason }).catch(() => null);
      if (!completion?.ok) return;
      if (entry) {
        try {
          await this.stopAndPurge(entry.id);
        } catch {
          return;
        }
      }
      await this.record({ ...launch, state: "stopped" });
      return;
    }
    if (launch.state === "launching") {
      const acknowledgement = await this.api.acknowledgeLaunch(launch.sessionId, {
        launchAttempt: launch.launchAttempt,
        state: "launch_failed",
        daemonEntryId: entry?.id,
        errorCode: "launch_failed",
        errorMessage: reason,
      }).catch(() => null);
      if (!acknowledgement?.ok) return;
      if (entry) {
        try {
          await this.stopAndPurge(entry.id);
        } catch {
          return;
        }
      }
      await this.record({ ...launch, state: "failed" });
    }
  }

  private async serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.catch(() => undefined).then(() => gate);
    this.tails.set(sessionId, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      await current;
      if (this.tails.get(sessionId) === current) this.tails.delete(sessionId);
    }
  }
}
