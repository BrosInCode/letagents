import type { rental_sessions } from "../../db/schema.js";
import type {
  IngestUsageReport,
  RentalUsageIngestDeps,
  RentalUsageMeterRow,
} from "../../rental/usage-ingest.js";
import type {
  BudgetReconcileInput,
  BudgetReconcileResult,
  BudgetReserveInput,
  BudgetReserveResult,
} from "../../rental/budget-orchestrator.js";
import type {
  HeartbeatDeps,
  SessionRecord,
} from "../../rental/heartbeat.js";
import type {
  ActivityEvent,
  EmitActivityEventInput,
} from "../../rental/activity-emitter.js";
import type {
  ReleaseLeaseInput,
  ReleaseSessionLeaseResult,
} from "../../rental/quota-lease-orchestrator.js";
import type {
  ContextReadFileInput,
  ContextReadFileResult,
  ContextSearchInput,
  ContextSearchResult,
} from "../../rental/context-broker.js";
import type {
  AppendSignedChangeInput,
  AppendSignedChangeResult,
} from "../../rental/signed-change-journal.js";
import type {
  PersistedPatchProposal,
  ProposePatchInput,
} from "../../rental/patch-proposal.js";
import type {
  RunWorkspaceCommandInput,
  RunWorkspaceCommandResult,
} from "../../rental/command-broker.js";

export interface RentalInternalRouteDeps {
  ingestUsage: (
    sessionId: string,
    report: IngestUsageReport,
    deps?: RentalUsageIngestDeps,
  ) => Promise<RentalUsageMeterRow>;
  reserveBudget: (
    sessionId: string,
    input: BudgetReserveInput,
  ) => Promise<BudgetReserveResult>;
  reconcileBudget: (
    sessionId: string,
    input: BudgetReconcileInput,
  ) => Promise<BudgetReconcileResult>;
  /**
   * Resolve which roles (renter, provider) a session-bound account
   * has for the rental. Returns null when no such session.
   */
  resolveSessionAccess: (
    sessionId: string,
    accountId: string,
  ) => Promise<"renter" | "provider" | null>;
  /**
   * Resolve heartbeat-backing dependencies. Lazily called per-process
   * (the underlying `createDefaultDeps()` opens DB clients on import,
   * so we defer until route hit to keep test isolation).
   */
  heartbeatDeps: () => Promise<HeartbeatDeps>;
  /**
   * Read a session row for the refresh-quota route (p2.13). Returns
   * the full row so the projector can read the renter-lane provider
   * for the optional hint-match audit.
   */
  getSessionForRefreshQuota?: (
    sessionId: string,
  ) => Promise<typeof rental_sessions.$inferSelect | null>;
  /**
   * Read a session by id for liveness reporting. Mirrors the
   * `getSession` shape from heartbeat.ts so tests can inject one
   * implementation for both routes.
   */
  getSessionForLiveness: (
    sessionId: string,
  ) => Promise<SessionRecord | null>;
  getSessionLifecycle: (
    sessionId: string,
  ) => Promise<{
    status: typeof rental_sessions.$inferSelect["status"];
    room_id: string | null;
  } | null>;
  updateSessionLifecycle: (
    sessionId: string,
    update: {
      status: "completed" | "cancelled";
      endedAt: Date;
    },
  ) => Promise<typeof rental_sessions.$inferSelect | null>;
  emitActivityEvent: (input: EmitActivityEventInput) => Promise<ActivityEvent>;
  releaseSessionLease?: (
    input: ReleaseLeaseInput,
  ) => Promise<ReleaseSessionLeaseResult>;
  readContextFile: (
    sessionId: string,
    input: Omit<ContextReadFileInput, "sessionId">,
  ) => Promise<ContextReadFileResult>;
  searchContext: (
    sessionId: string,
    input: Omit<ContextSearchInput, "sessionId">,
  ) => Promise<ContextSearchResult>;
  appendSignedChange: (
    sessionId: string,
    input: Omit<AppendSignedChangeInput, "sessionId">,
  ) => Promise<AppendSignedChangeResult>;
  proposePatch: (
    sessionId: string,
    input: Omit<ProposePatchInput, "sessionId">,
  ) => Promise<PersistedPatchProposal>;
  runWorkspaceCommand: (
    sessionId: string,
    input: Omit<RunWorkspaceCommandInput, "sessionId">,
  ) => Promise<RunWorkspaceCommandResult>;
}
