import { findPgError } from "./utils.js";

/**
 * A duplicate key (23505) on one named constraint, wrapped by Drizzle or not.
 * The Postgres error names the constraint in `constraint` and in its message;
 * Drizzle's own message holds the SQL text instead, so only the Postgres
 * error (found through the cause chain) is read.
 */
export function isUniqueViolationOf(error: unknown, constraint: string): boolean {
  const pg = findPgError(error);
  return pg?.code === "23505"
    && (pg.constraint === constraint || (typeof pg.message === "string" && pg.message.includes(constraint)));
}

/** True when the message of the error or of one of its first five causes contains `text`. */
export function errorChainMentions(error: unknown, text: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth <= 5 && typeof current === "object" && current !== null; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && message.includes(text)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
