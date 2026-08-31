import type { DaemonToolAgentSession } from "./supervised-tool-runtime.js";

export const WORKER_BEARER_ROTATION_LEAD_MS = 60_000;
export const WORKER_MINT_FALLBACK_FRESH_MS = 2 * 60_000;

export type LiveBindingIdentity = {
  agentSessionId: string;
  executionGenerationId: string;
  updatedAt: string;
};

export type PendingResumeBinding = {
  roomId: string;
  workAttemptId: string;
  predecessorExecutionGenerationId: string;
  successorExecutionGenerationId: string;
  agentSessionId: string;
  providerContinuationId: string;
};

export type InstalledHostGrant = {
  entryId: string;
  roomId: string;
  agentKey: string;
  grantId: string;
  supervisorGrant: string;
  grantGeneration: number;
  apiUrl: string;
  daemonGeneration: number;
  hostId: string;
  installationId: string;
  expiresAt: string;
};

export type InstalledOpenModelCredential = {
  entryId: string;
  apiKey: string | null;
  baseUrl: string;
  model: string;
  daemonGeneration: number;
};

/** A short-lived, process-only worker bearer. It is intentionally never durable. */
export type CachedWorkerAuthorization = {
  entryId: string;
  roomId: string;
  agentKey: string;
  workAttemptId: string | null;
  grantId: string;
  grantGeneration: number;
  daemonGeneration: number;
  apiUrl: string;
  agentSessionId: string;
  bearer: string;
  bearerId: string;
  expiresAt: string | null;
  mintedAtMs: number;
  /** Exact server-issued public identity paired with this bearer. */
  agentSession?: DaemonToolAgentSession;
};

export type MintedWorkerAuthorization = Pick<CachedWorkerAuthorization,
  "agentSessionId" | "bearer" | "bearerId" | "expiresAt" | "agentSession"
> & {
  apiUrl: string;
  /** Process-only mint authority; grant object identity fences replacement during awaits. */
  authority: {
    entryId: string;
    roomId: string;
    workAttemptId: string | null;
    grant: InstalledHostGrant;
  };
};

export type BoundWorkerAuthorization = MintedWorkerAuthorization & {
  executionGenerationId: string;
};

export type RuntimeEntryScope = {
  entryId: string;
  roomId: string;
};

export type WorkerAuthorizationScope = RuntimeEntryScope & {
  workAttemptId: string | null | undefined;
};

export type WorkerRuntimeCustodyOptions = {
  workerBearerRotationLeadMs?: number;
  workerMintFallbackFreshMs?: number;
};

/**
 * Owns only process-memory worker identity and credential custody. Durable
 * stores, remote mint/revoke calls, singleton assertions, lifecycle work, and
 * clocks remain with the daemon; callers pass the exact authority facts and
 * current time at each pure lookup boundary.
 */
export class WorkerRuntimeCustody {
  private readonly liveBindingIdentities = new Map<string, LiveBindingIdentity>();
  private readonly pendingResumeBindings = new Map<string, PendingResumeBinding>();
  private readonly hostGrants = new Map<string, InstalledHostGrant>();
  private readonly openModelCredentials = new Map<string, InstalledOpenModelCredential>();
  private readonly cachedWorkerAuthorizations = new Map<string, CachedWorkerAuthorization>();

  private readonly workerBearerRotationLeadMs: number;
  private readonly workerMintFallbackFreshMs: number;

  constructor(options: WorkerRuntimeCustodyOptions = {}) {
    this.workerBearerRotationLeadMs = options.workerBearerRotationLeadMs
      ?? WORKER_BEARER_ROTATION_LEAD_MS;
    this.workerMintFallbackFreshMs = options.workerMintFallbackFreshMs
      ?? WORKER_MINT_FALLBACK_FRESH_MS;
  }

  liveBinding(entryId: string): LiveBindingIdentity | undefined {
    return this.liveBindingIdentities.get(entryId);
  }

  liveBindingForGeneration(entryId: string, executionGenerationId: string): LiveBindingIdentity | null {
    const binding = this.liveBindingIdentities.get(entryId);
    return binding?.executionGenerationId === executionGenerationId ? binding : null;
  }

  installLiveBinding(entryId: string, identity: LiveBindingIdentity): void {
    this.liveBindingIdentities.set(entryId, identity);
  }

  deleteLiveBinding(entryId: string): boolean {
    return this.liveBindingIdentities.delete(entryId);
  }

  pendingResumeBinding(entryId: string): PendingResumeBinding | undefined {
    return this.pendingResumeBindings.get(entryId);
  }

  hasPendingResumeBinding(entryId: string): boolean {
    return this.pendingResumeBindings.has(entryId);
  }

  installPendingResumeBinding(entryId: string, binding: PendingResumeBinding): void {
    this.pendingResumeBindings.set(entryId, binding);
  }

  deletePendingResumeBinding(entryId: string): boolean {
    return this.pendingResumeBindings.delete(entryId);
  }

  hostGrant(entryId: string): InstalledHostGrant | undefined {
    return this.hostGrants.get(entryId);
  }

  currentHostGrant(
    scope: RuntimeEntryScope,
    daemonGeneration: number,
    handoffScheduled: boolean,
  ): InstalledHostGrant | null {
    const grant = this.hostGrants.get(scope.entryId);
    if (!grant || handoffScheduled || grant.daemonGeneration !== daemonGeneration
      || grant.entryId !== scope.entryId || grant.roomId !== scope.roomId) return null;
    return grant;
  }

  hostGrantIsCurrent(entryId: string, grant: InstalledHostGrant): boolean {
    return this.hostGrants.get(entryId) === grant;
  }

  installHostGrant(grant: InstalledHostGrant): void {
    this.hostGrants.set(grant.entryId, grant);
  }

  replaceHostGrantIfCurrent(
    entryId: string,
    current: InstalledHostGrant,
    replacement: InstalledHostGrant,
  ): boolean {
    if (this.hostGrants.get(entryId) !== current) return false;
    this.hostGrants.set(entryId, replacement);
    return true;
  }

  deleteHostGrant(entryId: string): boolean {
    return this.hostGrants.delete(entryId);
  }

  /**
   * Revoke only the exact installed object. This identity fence prevents a
   * stale async operation from destroying a replacement grant or its secrets.
   */
  destroyHostGrantIfCurrent(entryId: string, grant: InstalledHostGrant): boolean {
    if (this.hostGrants.get(entryId) !== grant) return false;
    this.hostGrants.delete(entryId);
    this.openModelCredentials.delete(entryId);
    this.cachedWorkerAuthorizations.delete(entryId);
    return true;
  }

  openModelCredential(entryId: string): InstalledOpenModelCredential | undefined {
    return this.openModelCredentials.get(entryId);
  }

  currentOpenModelCredential(entryId: string, daemonGeneration: number): InstalledOpenModelCredential | null {
    const credential = this.openModelCredentials.get(entryId);
    return credential?.daemonGeneration === daemonGeneration ? credential : null;
  }

  installOpenModelCredential(credential: InstalledOpenModelCredential): void {
    this.openModelCredentials.set(credential.entryId, credential);
  }

  deleteOpenModelCredential(entryId: string): boolean {
    return this.openModelCredentials.delete(entryId);
  }

  workerAuthorization(entryId: string): CachedWorkerAuthorization | undefined {
    return this.cachedWorkerAuthorizations.get(entryId);
  }

  installWorkerAuthorization(authorization: CachedWorkerAuthorization): void {
    this.cachedWorkerAuthorizations.set(authorization.entryId, authorization);
  }

  deleteWorkerAuthorization(entryId: string): boolean {
    return this.cachedWorkerAuthorizations.delete(entryId);
  }

  /**
   * Returns only the exact, fresh authorization for the installed grant and
   * entry scope. Invalid cache entries are destroyed eagerly. A pre-attempt
   * authorization is claimed once by the first durable work attempt.
   */
  currentWorkerAuthorization(
    scope: WorkerAuthorizationScope,
    grant: InstalledHostGrant,
    nowMs: number,
  ): CachedWorkerAuthorization | null {
    const cached = this.cachedWorkerAuthorizations.get(scope.entryId);
    if (!cached) return null;
    const expiresAt = cached.expiresAt ? Date.parse(cached.expiresAt) : Number.NaN;
    const fresh = Number.isFinite(expiresAt)
      ? expiresAt > nowMs + this.workerBearerRotationLeadMs
      : cached.mintedAtMs + this.workerMintFallbackFreshMs > nowMs;
    const exact = cached.entryId === scope.entryId
      && cached.roomId === scope.roomId
      && cached.agentKey === grant.agentKey
      && cached.grantId === grant.grantId
      && cached.grantGeneration === grant.grantGeneration
      && cached.daemonGeneration === grant.daemonGeneration
      && cached.apiUrl === grant.apiUrl;
    if (!fresh || !exact) {
      this.cachedWorkerAuthorizations.delete(scope.entryId);
      return null;
    }
    if (cached.workAttemptId === null && scope.workAttemptId) {
      cached.workAttemptId = scope.workAttemptId;
    }
    if (cached.workAttemptId !== scope.workAttemptId) {
      this.cachedWorkerAuthorizations.delete(scope.entryId);
      return null;
    }
    return cached;
  }

  /** Prepare-handoff parity: retire owner/provider secrets, but let admitted workers drain. */
  destroyOwnerCredentials(): void {
    this.hostGrants.clear();
    this.openModelCredentials.clear();
  }

  /** Stop/lost-authority parity: destroy every process-memory credential. */
  destroyAllCredentials(): void {
    this.hostGrants.clear();
    this.openModelCredentials.clear();
    this.cachedWorkerAuthorizations.clear();
  }
}
