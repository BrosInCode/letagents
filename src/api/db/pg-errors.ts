import { findPgError } from "./utils.js";

/**
 * True when `text` contains `name` as a whole identifier: not as part of a
 * longer one (`…_uq` does not match `…_uq_v2`).
 */
function containsIdentifier(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(text);
}

/**
 * The message of the Postgres error in the cause chain names `name` as a
 * whole identifier. Only the Postgres error is read: Drizzle's own message
 * is "Failed query: <sql>\nparams: <params>", and the params can hold text
 * a caller supplied (an idempotency key that spells a constraint name).
 */
export function pgErrorMentions(error: unknown, name: string): boolean {
  const message = findPgError(error)?.message;
  return typeof message === "string" && containsIdentifier(message, name);
}

/**
 * A duplicate key (23505) on one named constraint, wrapped by Drizzle or not.
 * Postgres sets `constraint` on every unique violation, and that field
 * decides. Only when it is absent does the Postgres error's message decide,
 * by the whole constraint name.
 */
export function isUniqueViolationOf(error: unknown, constraint: string): boolean {
  const pg = findPgError(error);
  if (pg?.code !== "23505") return false;
  if (typeof pg.constraint === "string") return pg.constraint === constraint;
  return pgErrorMentions(error, constraint);
}
