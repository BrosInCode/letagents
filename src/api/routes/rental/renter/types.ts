import type { rental_sessions } from "../../../db/schema.js";
import type {
  PublicListingsQuery,
} from "../../../rental/listings.js";
import type {
  BudgetExtensionApprovalInput,
  BudgetExtensionDenialInput,
  BudgetExtensionRequestInput,
  BudgetExtensionDecisionResult,
  BudgetExtensionRequestResult,
} from "../../../rental/budget-extension.js";
import type {
  RenterQuotaStateStore,
} from "../../../rental/renter-quota-state.js";
import type {
  SessionActivityRole,
  SessionActivityRow,
} from "../../../rental/session-activity.js";
import type {
  RentalPatchReviewDecisionResult,
  RentalPatchReviewProjection,
} from "../../../rental/patch-review.js";
import type { ListingsRateLimiter } from "./rate-limiter.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import type { Response } from "express";
import type { PublicRentalProvider } from "../../../rental/provider-hosts.js";

export type Session = typeof rental_sessions.$inferSelect;

// ===== Public deps =====

export interface RentalRenterRouteDeps {
  publicListings: PublicListingsQuery;
  publicProviders?: (viewerAccountId?: string) => Promise<PublicRentalProvider[]>;
  /**
   * Rate-limit gate. Returns `true` if the call should proceed,
   * `false` if the renter is currently throttled. Default uses
   * {@link buildInMemoryListingsRateLimiter}.
   */
  shouldAllowListingsQuery: ListingsRateLimiter;
  // Session management (p1.3)
  createSession(input: {
    listingId: string;
    renterAccountId: string;
    targetRoomId?: string;
    roomHistoryAccess?: "full" | "filtered";
    capabilityEnvelope?: Record<string, unknown> | null;
    repoOwner?: string;
    repoName?: string;
    baseBranch?: string;
    taskTitle: string;
    taskPrompt: string;
    mode?: "scoped" | "trusted_open";
    continuityMode?: "smart_handoff" | "full_transcript";
    startTrigger?: "quota_exhausted" | "user_initiated" | "scheduled" | "task_handoff";
    triggerConfidence?: "exact" | "inferred" | "manual";
    renterLaneProvider?: string;
    renterLaneModel?: string;
    renterLaneExhaustedAt?: Date;
    renterLaneRefreshEta?: Date;
    renterQuotaSignal?: Record<string, unknown>;
    approvedScope?: unknown;
    policy?: unknown;
    lrtLimit?: number;
    timeLimitMinutes?: number;
  }): Promise<Session>;
  resolveAuthorizedTargetRoom?: (
    req: AuthenticatedRequest,
    res: Response,
    roomId: string,
  ) => Promise<string | null>;
  getSessionById(sessionId: string, accountId: string): Promise<Session | null>;
  cancelSession(
    sessionId: string,
    accountId: string,
    role: "renter" | "provider"
  ): Promise<Session | null>;
  requestBudgetExtension?: (
    sessionId: string,
    requesterAccountId: string,
    input: BudgetExtensionRequestInput,
  ) => Promise<BudgetExtensionRequestResult>;
  approveBudgetExtension?: (
    sessionId: string,
    approverAccountId: string,
    requestId: string,
    input?: BudgetExtensionApprovalInput,
  ) => Promise<BudgetExtensionDecisionResult>;
  denyBudgetExtension?: (
    sessionId: string,
    approverAccountId: string,
    requestId: string,
    input?: BudgetExtensionDenialInput,
  ) => Promise<BudgetExtensionDecisionResult>;
  // p2.6c renter-trigger state mirror
  renterQuotaState?: RenterQuotaStateStore;
  /**
   * p2.10a — session-activity read used by the desktop session-detail
   * modal. Defaults to `listSessionActivityForUi` (DB-backed).
   * Injection is intended for unit tests.
   */
  listSessionActivity?: (
    sessionId: string,
    opts: {
      role: SessionActivityRole;
      limit?: number;
      verifiedOnly?: boolean;
    },
  ) => Promise<SessionActivityRow[]>;
  listPatchProposals?: (
    sessionId: string,
  ) => Promise<RentalPatchReviewProjection[]>;
  approvePatch?: (
    session: Session,
    renterAccountId: string,
    patchId: string,
    input?: { note?: string | null },
  ) => Promise<RentalPatchReviewDecisionResult>;
  requestPatchChanges?: (
    session: Session,
    renterAccountId: string,
    patchId: string,
    input?: { note?: string | null },
  ) => Promise<RentalPatchReviewDecisionResult>;
}
