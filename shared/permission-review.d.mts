export const PERMISSION_REVIEW_APPROVE_AT: number;
export const PERMISSION_REVIEW_RISKY_AT_MOST: number;
export const PERMISSION_REVIEW_MAX_COMMANDS: number;
export const PERMISSION_REVIEW_MAX_COMMAND_CHARS: number;
export const PERMISSION_REVIEW_MAX_PROJECT_CHARS: number;

export type PermissionReviewKind = "read" | "check" | "edit" | "risky";
export type PermissionReviewAnswers = {
  /** Null when the model did not give one consistent answer. */
  kinds: Record<PermissionReviewKind, number> | null;
};
export type PermissionReviewDecision = "allow" | "ask";

export type PermissionReviewRequest = {
  state: { commands: string[]; project: string };
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
};

/** True when a person must decide: no fixed rule can read the command in full. */
export function commandNeedsPerson(command: unknown, project: unknown): boolean;

/** True when each simple command in each part is, word for word, one in the whole command. */
export function partsAreInCommand(command: unknown, parts: unknown): boolean;

/** True when every part only reads project files, history, or this repository's pull requests and issues. */
export function commandOnlyReads(command: unknown, project: unknown): boolean;

export type RoutineCommandContext = {
  /** Whether a branch is the agent's own. */
  ownBranch(branch: string): boolean;
  /** The branch `origin` names as its default; null when it is not known. */
  defaultBranch: string | null;
};

/**
 * Null when a person must decide. Otherwise the parts Jev must still review,
 * each as written: none when the rules alone allow the whole command.
 */
export function routineCommandReview(command: unknown, project: unknown, context: RoutineCommandContext): string[] | null;

/** Null when the fixed rules already require a person. */
export function buildPermissionReviewRequest(input: {
  commands: readonly string[];
  project: string;
}): PermissionReviewRequest | null;

export function parsePermissionReviewAnswers(body: unknown): PermissionReviewAnswers;

export function decidePermissionReview(answers: PermissionReviewAnswers | null | undefined): PermissionReviewDecision;
