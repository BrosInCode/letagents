import type { RentalActivityEventType } from "../activity-event-types.js";

/**
 * Minimal rental-session shape the Continuity Pack reads. Mirrors
 * the columns the deterministic half cares about so the function
 * is trivially mockable in tests.
 */
export interface ContinuityPackSession {
  id: string;
  task_title: string;
  task_prompt: string;
  base_branch: string;
  work_branch: string | null;
  status: string;
  mode: string;
  approved_scope: unknown;
  policy: unknown;
}

/**
 * Activity event shape we read. A subset of `rental_activity_events`.
 */
export interface ContinuityPackEvent {
  id: string;
  event_type: RentalActivityEventType | string;
  source: string;
  payload: unknown;
  created_at: Date | string;
}

export interface ContinuityFileEntry {
  path: string;
  reason: string;
  lastTouchedAt: string;
  source: string;
  /**
   * Whether the file appeared via an explicit `context.file_exposed`
   * (renter-approved) event. Files exposed by a tool action with
   * pre-approved scope are still flagged via this field for the
   * model-generated half to highlight scope choices.
   */
  scopeApproved: boolean;
}

export interface ContinuityCommandEntry {
  command: string;
  ranAt: string;
  outcome: "run" | "timed_out" | "blocked";
  exitCode: number | null;
  source: string;
}

export interface ContinuityFailingTestEntry {
  test: string;
  failedAt: string;
  details: string | null;
}

export interface ContinuityActiveDiff {
  patchId: string | null;
  proposedAt: string;
  source: string;
  summary: string | null;
  diffRef: string | null;
  diffPreview: string | null;
}

export interface ContinuityPack {
  /** Stable hash over the canonicalized contents. */
  packId: string;
  schemaVersion: 1;
  tier: "tier1_deterministic";
  generatedAt: string;
  session: {
    id: string;
    taskTitle: string;
    taskPrompt: string;
    baseBranch: string;
    workBranch: string | null;
    status: string;
    mode: string;
  };
  approvedScope: unknown;
  policy: unknown;
  filesTouched: ContinuityFileEntry[];
  filesTouchedSummary: { totalCount: number; truncatedCount: number };
  commandsRun: ContinuityCommandEntry[];
  commandsRunSummary: { totalCount: number; truncatedCount: number };
  failingTests: ContinuityFailingTestEntry[];
  activeDiff: ContinuityActiveDiff | null;
}

export interface BuildContinuityPackOptions {
  /** Override clock for deterministic generatedAt in tests. */
  nowIso?: string;
}
