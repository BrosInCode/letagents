import {
  POSTGRES_INTEGER_MAX,
  parsePositivePgIntegerScopedId as parseSharedPositivePgIntegerScopedId,
} from "../../shared/message-contracts.mjs";

export { POSTGRES_INTEGER_MAX };

/** Parse the canonical `<prefix>_<positive PostgreSQL integer>` wire form. */
export function parsePositivePgIntegerScopedId(value: unknown, prefix: string): number | null {
  return parseSharedPositivePgIntegerScopedId(value, prefix);
}
