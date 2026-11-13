import type { WorkspaceChangeSummary } from "./workspace-change-summary.mjs";
export const ROOM_WORK_STATES: readonly ["active", "completed", "completed_no_reply", "failed", "interrupted", "lost", "unknown"];
export const ROOM_WORK_OPERATION_OUTCOMES: readonly ["unresolved", "succeeded", "failed", "denied_before_start", "cancelled_before_start", "interrupted_after_start", "lost_after_start"];
/** One file that the agent changed with its own edit tools during the turn. `patch` holds unified-diff
 * hunks only ("@@ -a,b +c,d @@" and the lines below it), in the order of the edit calls; it is empty and
 * `patch_truncated` is true when the text is cut or withheld. The counts are sums over the edit calls. */
export type RoomContributionEditFile = { path: string; additions: number; deletions: number; patch: string; patch_truncated: boolean };
/** A summary taken from the provider's edit events. It is not proof: a shell command leaves no edit event,
 * so the compared trees in `changes` stay the record of what changed. */
export type RoomContributionEdits = { files: RoomContributionEditFile[]; hidden_files: number };
/** The commit the workspace was on when the turn started: its commit date, and whether the settled HEAD
 * still has it in its history. `false` means the comparison in `changes` can include other project history. */
export type RoomContributionStart = { committed_at: string | null; in_history: boolean | null };
export const ROOM_CONTRIBUTION_EDIT_LIMITS: { readonly files: 20; readonly patchChars: 8000; readonly totalPatchChars: 48000 };
export type RoomAgentWorkSummary = {
  version: 1 | 2 | 3 | 4;
  /** v4 always carries `edits` and `start` (each may be null); v3 never carries them. */
  contribution?: { changes: WorkspaceChangeSummary; summary: string | null; edits?: RoomContributionEdits | null; start?: RoomContributionStart | null };
  workspace?: WorkspaceChangeSummary;
  recorded_state: typeof ROOM_WORK_STATES[number];
  evidence_incomplete: boolean;
  elapsed_ms: number | null;
  operation_counts: Record<typeof ROOM_WORK_OPERATION_OUTCOMES[number], number>;
};
// Server-issued availability marker, not a publisher-supplied execution state.
export type ClearedRoomAgentWorkSummary = { version: 1; availability: "cleared" };
export type RoomAgentWork = {
  attempt_id: string;
  room_id: string;
  source_message_id: string;
  agent_key: string;
  revision: number;
  summary: RoomAgentWorkSummary | ClearedRoomAgentWorkSummary;
  updated_at: string;
};
export type RoomAgentWorkSnapshot = { work: RoomAgentWork[]; truncated: boolean };
/** Synchronizes the latest-50 view, not intermediate events or complete history.
 * A changed snapshot replaces the client's bounded cache; it must not be merged.
 * The server-issued cursor is a comparison hint, never authorization. */
export type RoomAgentWorkPollResponse = { room_id: string; cursor: string } & (
  | { changed: true; snapshot: RoomAgentWorkSnapshot }
  | { changed: false; snapshot: null }
);
export function isClearedRoomAgentWorkSummary(value: unknown): value is ClearedRoomAgentWorkSummary;
export function hasReviewableRoomContribution(summary: RoomAgentWorkSummary | ClearedRoomAgentWorkSummary | null | undefined): boolean;
/** Return a canonical allowlisted copy, or reject without echoing private input. */
export function parseRoomAgentWorkSummary(value: unknown): RoomAgentWorkSummary | null;
