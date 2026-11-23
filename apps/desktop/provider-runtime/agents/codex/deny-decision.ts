/**
 * The decision a Deny sends for a Codex approval request.
 *
 * Codex names the decisions that it accepts for a request. A command or a file change can list `cancel` and not
 * `decline` (codex-cli 0.162.1 does for a command). Both deny the request; `cancel` can also end the current turn.
 * A Deny is then sent as `cancel`. `decline` is used whenever Codex accepts it, and when Codex sends no list.
 *
 * The adapter (dispatch) and the approval broker (presentation) both use this rule, so the hint the user sees
 * before clicking matches the decision that is sent.
 */
export function codexDenyDecision(method: string | undefined, params: unknown): "decline" | "cancel" {
  if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval") return "decline";
  const listed = params && typeof params === "object" && Array.isArray((params as { availableDecisions?: unknown }).availableDecisions)
    ? (params as { availableDecisions: unknown[] }).availableDecisions
    : null;
  return listed && !listed.includes("decline") && listed.includes("cancel") ? "cancel" : "decline";
}
