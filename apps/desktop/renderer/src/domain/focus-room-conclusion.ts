import type {
  DesktopFocusRoomBlockerState,
  DesktopFocusRoomConclusionDetails,
  DesktopFocusRoomParentTaskNextAction,
  DesktopFocusRoomReviewState,
} from "../../../electron/ipc-types";

type ConclusionOption<T extends string> = {
  value: T;
  label: string;
};

export type FocusRoomConclusionInput = {
  summary: string;
  details: DesktopFocusRoomConclusionDetails | null;
};

export type FocusRoomConcludedEvent = {
  focusRoomIdentifier: string;
  parentRoomIdentifier: string;
  displayName: string;
};

export const focusRoomReviewStateOptions: ReadonlyArray<ConclusionOption<DesktopFocusRoomReviewState>> = [
  { value: "reviewed", label: "Reviewed" },
  { value: "needs_review", label: "Needs review" },
  { value: "not_required", label: "Not required" },
];

export const focusRoomBlockerStateOptions: ReadonlyArray<ConclusionOption<DesktopFocusRoomBlockerState>> = [
  { value: "none", label: "None" },
  { value: "resolved", label: "Resolved" },
  { value: "blocked", label: "Blocked" },
];

export const focusRoomParentTaskNextOptions: ReadonlyArray<ConclusionOption<DesktopFocusRoomParentTaskNextAction>> = [
  { value: "keep_open", label: "Keep open" },
  { value: "move_to_review", label: "Move to review" },
  { value: "mark_blocked", label: "Mark blocked" },
  { value: "mark_done", label: "Mark done" },
  { value: "follow_up", label: "Follow-up" },
];

export function createDefaultFocusRoomConclusionDetails(): DesktopFocusRoomConclusionDetails {
  return {
    artifact: "",
    review_state: "needs_review",
    blocker_state: "none",
    parent_task_next: "keep_open",
    next_owner: "",
  };
}

export function canSubmitFocusRoomConclusion(
  summary: string,
  sourceTaskId: string | null | undefined,
  details: DesktopFocusRoomConclusionDetails,
): boolean {
  if (!summary.trim()) return false;
  if (!sourceTaskId) return true;
  return Boolean(details.artifact.trim() && details.next_owner.trim());
}

export function buildFocusRoomConclusionInput(
  summary: string,
  sourceTaskId: string | null | undefined,
  details: DesktopFocusRoomConclusionDetails,
): FocusRoomConclusionInput {
  return {
    summary: summary.trim(),
    details: sourceTaskId
      ? {
          ...details,
          artifact: details.artifact.trim(),
          next_owner: details.next_owner.trim(),
        }
      : null,
  };
}
