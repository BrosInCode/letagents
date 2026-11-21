/**
 * Cross-process wire boundary rules shared by all language-neutral contracts.
 *
 * Everything that crosses a process boundary (the daemon control socket today,
 * and later any out-of-process provider adapter boundary) must obey one rule:
 *
 *   1. Plain JSON data only: strings, finite numbers, booleans, null, arrays,
 *      and plain string-keyed objects.
 *   2. No functions, callbacks, AbortSignals, class instances, symbols,
 *      BigInts, Dates, Maps, Sets, RegExps, or custom JS-only predicates that
 *      cannot be expressed in JSON Schema Draft 2020-12.
 *   3. Every boundary schema must compile cleanly through `toWireJsonSchema`,
 *      which passes `unrepresentable: "throw"` to Zod v4's JSON Schema emitter.
 *      If a future change introduces an unrepresentable type, schema generation
 *      and contract tests fail immediately.
 */
import { z } from "zod";

export const WIRE_JSON_SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema" as const;

/** A non-empty string with no leading or trailing whitespace. */
export const EXACT_NON_EMPTY_STRING_PATTERN = /^\S(?:[\s\S]*\S)?$/;

/** Exact non-empty identifier (no leading/trailing whitespace). */
export const exactNonEmptyString = z.string().min(1).regex(EXACT_NON_EMPTY_STRING_PATTERN);

/** Non-empty string containing at least one non-whitespace character. */
export const nonEmptyTrimmedString = z.string().min(1).regex(/\S/);

/** Positive safe integer (>= 1, <= Number.MAX_SAFE_INTEGER). */
export const positiveSafeInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Non-negative safe integer (>= 0, <= Number.MAX_SAFE_INTEGER). */
export const nonNegativeSafeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Arbitrary plain JSON object record (string keys, JSON values). */
export const jsonRecordSchema = z.record(z.string(), z.unknown());

/** Arbitrary plain JSON value. */
export const jsonValueSchema = z.unknown();

/**
 * Compile any Zod wire schema into a Draft 2020-12 JSON Schema object while
 * strictly enforcing the cross-process wire boundary rule. Any non-JSON-Schema
 * construct (functions, Dates, Maps, Sets, Symbols, BigInts, transforms, etc.)
 * throws immediately.
 */
export function toWireJsonSchema(
  schema: z.ZodType,
  metadata?: ReturnType<typeof z.registry<{ id?: string }>>,
): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    io: "input",
    ...(metadata ? { metadata } : {}),
  }) as Record<string, unknown>;
  // Omit redundant nested $schema markers when embedding under a single root
  // contract document; callers emitting a standalone file add $schema at root.
  const { $schema: _omitted, ...rest } = generated;
  return rest;
}

/**
 * Deterministically normalize any JSON-serializable object tree by sorting
 * object keys lexicographically so generated JSON Schema files are stable
 * across Node/V8 runs and platforms.
 */
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const sorted: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      sorted[key] = canonicalizeJson(entryValue);
    }
    return sorted;
  }
  return value;
}
