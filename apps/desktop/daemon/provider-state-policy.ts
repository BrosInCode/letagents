import {
  sameProviderActionConnectionSnapshot,
  type ProviderActionConnectionRef,
} from "./provider-action-port.js";

const CURSOR_PENDING_CONTINUATION_PREFIX = "cursor-pending:";

export function isIdleCursorConnection(
  connection: ProviderActionConnectionRef | null | undefined,
): connection is Extract<ProviderActionConnectionRef, { kind: "cursor_cli" }> {
  return connection?.kind === "cursor_cli"
    && connection.pid === null
    && (connection.processIdentity ?? null) === null;
}

export function isLiveCursorConnection(
  connection: ProviderActionConnectionRef | null | undefined,
): connection is Extract<ProviderActionConnectionRef, { kind: "cursor_cli" }> {
  return connection?.kind === "cursor_cli"
    && connection.pid !== null
    && Boolean(connection.processIdentity?.trim());
}

/**
 * Cursor's CLI child is born and retired per turn. Its PID and process birth
 * are therefore not durable authority when the caller has already fenced the
 * stable handle, continuation, work attempt, and execution generation.
 */
export function isCursorChildConnection(
  connection: ProviderActionConnectionRef | null | undefined,
): connection is Extract<ProviderActionConnectionRef, { kind: "cursor_cli" }> {
  return isIdleCursorConnection(connection) || isLiveCursorConnection(connection);
}

export function isAllowedCursorProviderStateTransition(
  expectedContinuationId: string | null,
  expectedConnection: ProviderActionConnectionRef | null | undefined,
  nextContinuationId: string,
  nextConnection: ProviderActionConnectionRef,
): boolean {
  if (!expectedContinuationId || expectedConnection?.kind !== "cursor_cli" || nextConnection.kind !== "cursor_cli") return false;
  const expectedIdle = isIdleCursorConnection(expectedConnection);
  const nextIdle = isIdleCursorConnection(nextConnection);
  const expectedLive = isLiveCursorConnection(expectedConnection);
  const nextLive = isLiveCursorConnection(nextConnection);
  if ((!expectedIdle && !expectedLive) || (!nextIdle && !nextLive)) return false;
  const sameContinuation = expectedContinuationId === nextContinuationId;
  const initializesPendingContinuation = expectedContinuationId.startsWith(CURSOR_PENDING_CONTINUATION_PREFIX)
    && !nextContinuationId.startsWith(CURSOR_PENDING_CONTINUATION_PREFIX);
  if (!sameContinuation && !initializesPendingContinuation) return false;
  if (expectedLive && nextLive) {
    return sameProviderActionConnectionSnapshot(expectedConnection, nextConnection);
  }
  // A prepared wrapper may retire to idle, including recovery that adopts the
  // real session proved by its init. Idle-to-live belongs to the atomic
  // prepared-turn transaction, not this generic transition path.
  return (expectedLive && nextIdle) || (expectedIdle && nextIdle);
}
