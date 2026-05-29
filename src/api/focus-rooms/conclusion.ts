export const FOCUS_ROOM_REVIEW_STATES = [
  "reviewed",
  "needs_review",
  "not_required",
] as const;

export const FOCUS_ROOM_BLOCKER_STATES = [
  "none",
  "resolved",
  "blocked",
] as const;

export const FOCUS_ROOM_PARENT_TASK_NEXT_ACTIONS = [
  "keep_open",
  "move_to_review",
  "mark_blocked",
  "mark_done",
  "follow_up",
] as const;

export type FocusRoomReviewState = (typeof FOCUS_ROOM_REVIEW_STATES)[number];
export type FocusRoomBlockerState = (typeof FOCUS_ROOM_BLOCKER_STATES)[number];
export type FocusRoomParentTaskNextAction = (typeof FOCUS_ROOM_PARENT_TASK_NEXT_ACTIONS)[number];

export interface FocusRoomConclusionDetails {
  artifact: string;
  review_state: FocusRoomReviewState;
  blocker_state: FocusRoomBlockerState;
  parent_task_next: FocusRoomParentTaskNextAction;
  next_owner: string;
}

const MAX_DETAIL_LENGTH = 500;

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`conclusion_details.${field} is required`);
  }

  const normalized = value.trim();
  if (normalized.length > MAX_DETAIL_LENGTH) {
    throw new Error(`conclusion_details.${field} must be ${MAX_DETAIL_LENGTH} characters or less`);
  }

  return normalized;
}

function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`conclusion_details.${field} is invalid`);
  }
  return value as T;
}

export function normalizeFocusRoomConclusionDetails(
  value: unknown,
  options: { required?: boolean } = {}
): FocusRoomConclusionDetails | null {
  if (value === undefined || value === null) {
    if (options.required) {
      throw new Error("conclusion_details is required for task-linked Focus Rooms");
    }
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("conclusion_details must be an object");
  }

  const record = value as Record<string, unknown>;
  return {
    artifact: normalizeRequiredString(record.artifact, "artifact"),
    review_state: normalizeEnum(record.review_state, FOCUS_ROOM_REVIEW_STATES, "review_state"),
    blocker_state: normalizeEnum(record.blocker_state, FOCUS_ROOM_BLOCKER_STATES, "blocker_state"),
    parent_task_next: normalizeEnum(
      record.parent_task_next,
      FOCUS_ROOM_PARENT_TASK_NEXT_ACTIONS,
      "parent_task_next"
    ),
    next_owner: normalizeRequiredString(record.next_owner, "next_owner"),
  };
}

const reviewStateLabels: Record<FocusRoomReviewState, string> = {
  reviewed: "reviewed",
  needs_review: "needs review",
  not_required: "review not required",
};

const blockerStateLabels: Record<FocusRoomBlockerState, string> = {
  none: "none",
  resolved: "resolved",
  blocked: "still blocked",
};

const parentTaskNextLabels: Record<FocusRoomParentTaskNextAction, string> = {
  keep_open: "keep open",
  move_to_review: "move to review",
  mark_blocked: "mark blocked",
  mark_done: "mark done",
  follow_up: "follow up",
};

export function focusRoomReviewStateLabel(value: FocusRoomReviewState): string {
  return reviewStateLabels[value];
}

export function focusRoomBlockerStateLabel(value: FocusRoomBlockerState): string {
  return blockerStateLabels[value];
}

export function focusRoomParentTaskNextLabel(value: FocusRoomParentTaskNextAction): string {
  return parentTaskNextLabels[value];
}
