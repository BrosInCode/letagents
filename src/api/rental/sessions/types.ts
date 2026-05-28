import type { rental_listings, rental_sessions } from "../../db/schema.js";

export interface CreateSessionInput {
  listingId: string;
  renterAccountId: string;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
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
}

export type RentalSessionRow = typeof rental_sessions.$inferSelect;
export type RentalListingRow = typeof rental_listings.$inferSelect;
