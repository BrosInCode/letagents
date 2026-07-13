export const BOARD_MANAGER_FAILOVER_MODES = ["off", "announce", "auto"] as const;

export type BoardManagerFailoverMode = (typeof BOARD_MANAGER_FAILOVER_MODES)[number];

/**
 * What the liveness sweep does when the active Board Manager's worker session
 * goes unreachable: 'off' ignores it, 'announce' posts a room warning with a
 * suggested successor, 'auto' (default) promotes the best reachable worker.
 */
export const DEFAULT_BOARD_MANAGER_FAILOVER: BoardManagerFailoverMode = "auto";

export function isBoardManagerFailoverMode(value: unknown): value is BoardManagerFailoverMode {
  return BOARD_MANAGER_FAILOVER_MODES.includes(value as BoardManagerFailoverMode);
}

export function normalizeBoardManagerFailoverMode(
  value: string | null | undefined
): BoardManagerFailoverMode {
  const normalized = value?.trim().toLowerCase();
  return normalized && isBoardManagerFailoverMode(normalized)
    ? normalized
    : DEFAULT_BOARD_MANAGER_FAILOVER;
}
