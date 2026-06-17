/**
 * Rental Session State Machine — §18.2
 *
 * Valid transitions for the rental session lifecycle.
 * Extracted from sessions.ts for testability without DB dependency.
 */

/**
 * Valid state transitions per §18.2 state diagram.
 */
export const VALID_TRANSITIONS: Record<string, string[]> = {
  requested: ["accepted", "cancelled"],
  accepted: ["provisioning", "cancelled"],
  provisioning: ["active", "failed", "cancelled"],
  active: [
    "blocked",
    "patch_review",
    "budget_exhausted",
    "cancelled",
    "expired",
    "stale",
  ],
  blocked: ["active", "cancelled"],
  patch_review: ["active", "pr_opened", "cancelled"],
  pr_opened: ["completed", "cancelled"],
  budget_exhausted: ["active", "completed", "cancelled"],
  stale: ["active", "expired", "cancelled"],
};

/**
 * Check if a state transition is valid per §18.2.
 */
export function isValidTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}
