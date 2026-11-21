/**
 * Cross-process wire boundary rules shared by all language-neutral contracts.
 *
 * Everything that crosses a process boundary (the daemon control socket today,
 * and later any out-of-process provider adapter boundary) must obey one rule:
 *
 *   1. Plain JSON data only: strings, finite numbers, booleans, null, arrays,
 *      and plain string-keyed objects.
 *   2. No functions, callbacks, AbortSignals, class instances, symbols,
 *      BigInts, Dates, Maps, Sets, RegExps, transforms, pipes, or custom
 *      JS-only `.refine()` / `.superRefine()` predicates that cannot be
 *      expressed in JSON Schema Draft 2020-12.
 *   3. Every boundary schema must pass `assertWireBoundarySchema` and compile
 *      cleanly through `toWireJsonSchema` (which passes `unrepresentable: "throw"`
 *      in default output mode to Zod v4's JSON Schema emitter). If a future
 *      change introduces an unrepresentable type, transform, or custom
 *      predicate anywhere in the schema tree, schema generation and contract
 *      tests fail immediately.
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

/**
 * Arbitrary plain JSON value: string, finite number, boolean, null, JSON array,
 * or plain string-keyed JSON object. Rejects functions, Dates, BigInts,
 * Symbols, Infinity, NaN, undefined, Maps, Sets, RegExps, class instances, and
 * nested occurrences inside arrays/objects.
 */
export const jsonValueSchema = z.json();
export type JsonValue = z.output<typeof jsonValueSchema>;

/** Arbitrary plain JSON object record (string keys, plain JSON values). */
export const jsonRecordSchema = z.record(z.string(), jsonValueSchema);
export type JsonRecord = z.output<typeof jsonRecordSchema>;

/**
 * Plain JSON object that permits additional plain JSON properties while still
 * rejecting non-JSON values (unlike `z.looseObject`, whose catchall is
 * `z.unknown()`).
 */
export function looseJsonObject<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).catchall(jsonValueSchema);
}

/**
 * Runtime value guard for cross-process wire boundaries (reusable at in-process
 * boundaries such as provider adapter calls without JSON round-trip overhead).
 *
 * Verifies recursively that `value` is plain JSON data: strings, finite
 * numbers, booleans, null, plain arrays, and plain objects (`Object.prototype`
 * or `null` prototype) with data properties only, no Symbol keys, no
 * `undefined` entries, and no circular references. Throws an Error naming the
 * failing path without echoing raw values.
 */
export function assertPlainWireValue(value: unknown, path = "$"): JsonValue {
  const active = new WeakSet<object>();

  const walk = (candidate: unknown, currentPath: string): void => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new Error(`Wire value at ${currentPath} must be a finite number.`);
      }
      return;
    }
    if (typeof candidate !== "object") {
      throw new Error(`Wire value at ${currentPath} has unsupported type "${typeof candidate}".`);
    }
    if (active.has(candidate)) {
      throw new Error(`Wire value at ${currentPath} contains a circular reference.`);
    }
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        for (let i = 0; i < candidate.length; i += 1) {
          walk(candidate[i], `${currentPath}[${i}]`);
        }
        return;
      }
      const proto = Object.getPrototypeOf(candidate);
      if (proto !== Object.prototype && proto !== null) {
        const tag = candidate.constructor?.name || "non-plain object";
        throw new Error(`Wire value at ${currentPath} must be a plain object, not ${tag}.`);
      }
      if (Object.getOwnPropertySymbols(candidate).length > 0) {
        throw new Error(`Wire value at ${currentPath} must not contain symbol keys.`);
      }
      for (const key of Object.keys(candidate)) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor) continue;
        if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
          throw new Error(`Wire value at ${currentPath}.${key} must be a plain data property, not an accessor.`);
        }
        walk(descriptor.value, `${currentPath}.${key}`);
      }
    } finally {
      active.delete(candidate);
    }
  };

  walk(value, path);
  return value as JsonValue;
}

export function isPlainWireValue(value: unknown): value is JsonValue {
  try {
    assertPlainWireValue(value);
    return true;
  } catch {
    return false;
  }
}

const ALLOWED_WIRE_NODE_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "null",
  "literal",
  "enum",
  "never",
  "object",
  "array",
  "tuple",
  "record",
  "union",
  "intersection",
  "optional",
  "nullable",
  "readonly",
  "lazy",
]);

const ALLOWED_WIRE_CHECK_TYPES = new Set([
  "number_format",
  "greater_than",
  "less_than",
  "multiple_of",
  "min_length",
  "max_length",
  "length_equals",
  "string_format",
  "min_size",
  "max_size",
  "size_equals",
]);

interface InternalZodCheck {
  _zod?: {
    def?: {
      check?: unknown;
      type?: unknown;
    };
  };
}

interface InternalZodDef {
  type?: unknown;
  checks?: InternalZodCheck[];
  shape?: Record<string, unknown>;
  catchall?: unknown;
  element?: unknown;
  items?: unknown[];
  rest?: unknown;
  keyType?: unknown;
  valueType?: unknown;
  options?: unknown[];
  left?: unknown;
  right?: unknown;
  innerType?: unknown;
  getter?: () => unknown;
}

interface InternalZodNode {
  _zod?: {
    def?: InternalZodDef;
  };
}

/**
 * Walk a Zod schema tree recursively (handling `z.lazy` cycles) and throw if
 * any root or nested node uses an unrepresentable type (`unknown`, `any`,
 * `function`, `date`, `bigint`, `symbol`, `map`, `set`, `custom`, `transform`,
 * `pipe`, `default`, `catch`, etc.) or a custom JS check predicate (`.refine`,
 * `.superRefine`).
 */
export function assertWireBoundarySchema(schema: z.ZodType): void {
  const visited = new WeakSet<object>();

  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object") {
      throw new Error(`Wire boundary schema at ${path} is not a valid Zod schema.`);
    }
    if (visited.has(node)) return;
    visited.add(node);

    const def = (node as InternalZodNode)._zod?.def;
    const nodeType = typeof def?.type === "string" ? def.type : null;
    if (!def || !nodeType || !ALLOWED_WIRE_NODE_TYPES.has(nodeType)) {
      throw new Error(
        `Wire boundary schema at ${path} uses unrepresentable Zod type "${nodeType ?? "unknown"}".`,
      );
    }

    if (Array.isArray(def.checks)) {
      for (const check of def.checks) {
        const checkDef = check?._zod?.def;
        const checkKind = typeof checkDef?.check === "string"
          ? checkDef.check
          : typeof checkDef?.type === "string"
            ? checkDef.type
            : null;
        if (!checkKind || !ALLOWED_WIRE_CHECK_TYPES.has(checkKind)) {
          throw new Error(
            `Wire boundary schema at ${path} uses unrepresentable check "${checkKind ?? "custom"}".`,
          );
        }
      }
    }

    if (nodeType === "object") {
      if (def.shape) {
        for (const [key, child] of Object.entries(def.shape)) {
          walk(child, `${path}.${key}`);
        }
      }
      if (def.catchall !== undefined) {
        walk(def.catchall, `${path}.[additionalProperties]`);
      }
      return;
    }
    if (nodeType === "array") {
      walk(def.element, `${path}[]`);
      return;
    }
    if (nodeType === "tuple") {
      if (Array.isArray(def.items)) {
        def.items.forEach((item, index) => walk(item, `${path}[${index}]`));
      }
      if (def.rest !== undefined && def.rest !== null) {
        walk(def.rest, `${path}[...rest]`);
      }
      return;
    }
    if (nodeType === "record") {
      walk(def.keyType, `${path}[key]`);
      walk(def.valueType, `${path}[value]`);
      return;
    }
    if (nodeType === "union") {
      if (Array.isArray(def.options)) {
        def.options.forEach((option, index) => walk(option, `${path}|${index}`));
      }
      return;
    }
    if (nodeType === "intersection") {
      walk(def.left, `${path}&left`);
      walk(def.right, `${path}&right`);
      return;
    }
    if (nodeType === "optional" || nodeType === "nullable" || nodeType === "readonly") {
      walk(def.innerType, path);
      return;
    }
    if (nodeType === "lazy") {
      if (typeof def.getter !== "function") {
        throw new Error(`Wire boundary schema at ${path} has an invalid lazy getter.`);
      }
      walk(def.getter(), path);
    }
  };

  walk(schema, "$");
}

/**
 * Compile any Zod wire schema into a Draft 2020-12 JSON Schema object while
 * strictly enforcing the cross-process wire boundary rule at every nesting
 * depth. Any non-JSON-Schema construct (functions, Dates, Maps, Sets, Symbols,
 * BigInts, unknown/any, transforms, pipes, custom refinements, etc.) throws
 * immediately.
 */
export function toWireJsonSchema(
  schema: z.ZodType,
  metadata?: ReturnType<typeof z.registry<{ id?: string }>>,
): Record<string, unknown> {
  assertWireBoundarySchema(schema);
  const generated = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
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
