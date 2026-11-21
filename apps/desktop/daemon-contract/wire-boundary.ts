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

export const MAX_WIRE_VALUE_DEPTH = 128;

export interface PlainWireValueOptions {
  /** Root path label used in error messages (defaults to "$"). */
  path?: string;
  /**
   * When true, permits own enumerable plain-object data properties whose value
   * is `undefined` (matching `JSON.stringify` omission semantics for optional
   * TypeScript fields at in-process boundaries). Array elements still reject
   * `undefined`. Defaults to false (strict JSON).
   */
  allowUndefinedProperties?: boolean;
  /** Maximum object/array nesting depth (defaults to `MAX_WIRE_VALUE_DEPTH`). */
  maxDepth?: number;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

/**
 * Runtime value guard for cross-process wire boundaries (reusable at in-process
 * boundaries such as provider adapter calls without JSON round-trip overhead).
 *
 * Verifies recursively (without invoking getters/accessors) that `value` is
 * plain JSON data:
 * - primitives: string, finite number, boolean, null
 * - arrays: plain `Array.prototype` dense arrays with enumerable data elements
 *   only, no extra own properties (including `toJSON` or non-enumerable hooks),
 *   and no Symbol keys
 * - objects: plain `Object.prototype` or `null`-prototype objects with
 *   enumerable data properties only, no Symbol keys, no non-enumerable
 *   properties (including `toJSON`), no `undefined` entries unless
 *   `allowUndefinedProperties` is set, no circular references, and bounded
 *   nesting depth.
 *
 * Throws an Error naming the failing path without echoing raw values.
 */
export function assertPlainWireValue(
  value: unknown,
  pathOrOptions: string | PlainWireValueOptions = "$",
): JsonValue {
  const options: PlainWireValueOptions = typeof pathOrOptions === "string"
    ? { path: pathOrOptions }
    : pathOrOptions;
  const rootPath = options.path ?? "$";
  const allowUndefinedProperties = options.allowUndefinedProperties === true;
  const maxDepth = options.maxDepth ?? MAX_WIRE_VALUE_DEPTH;
  const active = new WeakSet<object>();

  const walk = (candidate: unknown, currentPath: string, depth: number): void => {
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
    if (depth >= maxDepth) {
      throw new Error(`Wire value at ${currentPath} exceeds maximum nesting depth (${maxDepth}).`);
    }
    if (active.has(candidate)) {
      throw new Error(`Wire value at ${currentPath} contains a circular reference.`);
    }
    active.add(candidate);
    try {
      if (Object.getOwnPropertySymbols(candidate).length > 0) {
        throw new Error(`Wire value at ${currentPath} must not contain symbol keys.`);
      }
      const proto = Object.getPrototypeOf(candidate);
      if (Array.isArray(candidate)) {
        if (proto !== Array.prototype) {
          const tag = candidate.constructor?.name || "Array subclass";
          throw new Error(`Wire value at ${currentPath} must be a plain Array, not ${tag}.`);
        }
        for (const key of Object.getOwnPropertyNames(candidate)) {
          if (key === "length") continue;
          if (!isCanonicalArrayIndex(key, candidate.length)) {
            throw new Error(`Wire array at ${currentPath} must not contain extra property "${key}".`);
          }
        }
        for (let i = 0; i < candidate.length; i += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(i));
          if (!descriptor) {
            throw new Error(`Wire array at ${currentPath}[${i}] must not be sparse.`);
          }
          if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
            throw new Error(`Wire array at ${currentPath}[${i}] must be a plain data element, not an accessor.`);
          }
          if (!descriptor.enumerable) {
            throw new Error(`Wire array at ${currentPath}[${i}] must be enumerable.`);
          }
          walk(descriptor.value, `${currentPath}[${i}]`, depth + 1);
        }
        return;
      }
      if (proto !== Object.prototype && proto !== null) {
        const tag = candidate.constructor?.name || "non-plain object";
        throw new Error(`Wire value at ${currentPath} must be a plain object, not ${tag}.`);
      }
      for (const key of Object.getOwnPropertyNames(candidate)) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor) continue;
        if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
          throw new Error(`Wire value at ${currentPath}.${key} must be a plain data property, not an accessor.`);
        }
        if (!descriptor.enumerable) {
          throw new Error(`Wire value at ${currentPath}.${key} must not contain non-enumerable property "${key}".`);
        }
        if (allowUndefinedProperties && descriptor.value === undefined) {
          continue;
        }
        walk(descriptor.value, `${currentPath}.${key}`, depth + 1);
      }
    } finally {
      active.delete(candidate);
    }
  };

  walk(value, rootPath, 0);
  return value as JsonValue;
}

export function isPlainWireValue(
  value: unknown,
  options?: PlainWireValueOptions,
): value is JsonValue {
  try {
    assertPlainWireValue(value, options);
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

const ALLOWED_STRING_FORMATS = new Set([
  "regex",
  "email",
  "uuid",
  "guid",
  "url",
  "uri",
  "datetime",
  "date",
  "time",
  "duration",
  "ipv4",
  "ipv6",
  "hostname",
]);

interface InternalZodCheck {
  _zod?: {
    def?: {
      check?: unknown;
      type?: unknown;
      format?: unknown;
      fn?: unknown;
    };
  };
}

interface InternalZodDef {
  type?: unknown;
  coerce?: unknown;
  format?: unknown;
  fn?: unknown;
  values?: unknown[];
  entries?: Record<string, unknown>;
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

function isPlainJsonLiteral(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return false;
}

function unwrapsToOptional(node: unknown, seen = new WeakSet<object>()): boolean {
  if (node === null || typeof node !== "object" || seen.has(node)) return false;
  seen.add(node);
  const def = (node as InternalZodNode)._zod?.def;
  if (!def) return false;
  if (def.type === "optional") return true;
  if (def.type === "readonly") return unwrapsToOptional(def.innerType, seen);
  if (def.type === "lazy" && typeof def.getter === "function") return unwrapsToOptional(def.getter(), seen);
  return false;
}

/**
 * Walk a Zod schema tree recursively (handling `z.lazy` cycles) and throw if
 * any root or nested node uses:
 * - an unrepresentable type (`unknown`, `any`, `function`, `date`, `bigint`,
 *   `symbol`, `map`, `set`, `custom`, `transform`, `pipe`, `default`, `catch`,
 *   etc.)
 * - runtime coercion (`z.coerce.*`)
 * - custom JS predicates (`.refine()`, `.superRefine()`, `z.stringFormat(name, fn)`)
 *   or non-standard string format names
 * - non-JSON literal/enum values (such as `z.literal(1n)`)
 * - `optional` elements directly inside an array, record value, or tuple
 *   (where JSON has no `undefined` slot).
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
    if (def.coerce === true) {
      throw new Error(`Wire boundary schema at ${path} must not use runtime coercion.`);
    }
    if (typeof def.fn === "function") {
      throw new Error(`Wire boundary schema at ${path} must not use a custom JS predicate function.`);
    }
    if (def.format !== undefined) {
      if (typeof def.format !== "string" || !ALLOWED_STRING_FORMATS.has(def.format)) {
        throw new Error(
          `Wire boundary schema at ${path} uses unrepresentable string format "${String(def.format)}".`,
        );
      }
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
        if (typeof checkDef?.fn === "function") {
          throw new Error(
            `Wire boundary schema at ${path} uses a custom JS check predicate.`,
          );
        }
        if (checkKind === "string_format" && checkDef?.format !== undefined) {
          if (typeof checkDef.format !== "string" || !ALLOWED_STRING_FORMATS.has(checkDef.format)) {
            throw new Error(
              `Wire boundary schema at ${path} uses unrepresentable string format "${String(checkDef.format)}".`,
            );
          }
        }
      }
    }

    if (nodeType === "literal") {
      if (!Array.isArray(def.values) || def.values.some((entry) => !isPlainJsonLiteral(entry))) {
        throw new Error(`Wire boundary schema at ${path} contains a non-JSON literal value.`);
      }
      return;
    }
    if (nodeType === "enum") {
      const entries = def.entries ? Object.values(def.entries) : [];
      if (entries.some((entry) => typeof entry !== "string" && !(typeof entry === "number" && Number.isFinite(entry)))) {
        throw new Error(`Wire boundary schema at ${path} contains a non-JSON enum value.`);
      }
      return;
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
      if (unwrapsToOptional(def.element)) {
        throw new Error(`Wire boundary schema at ${path}[] must not use optional array elements.`);
      }
      walk(def.element, `${path}[]`);
      return;
    }
    if (nodeType === "tuple") {
      if (Array.isArray(def.items)) {
        def.items.forEach((item, index) => {
          if (unwrapsToOptional(item)) {
            throw new Error(`Wire boundary schema at ${path}[${index}] must not use optional tuple elements.`);
          }
          walk(item, `${path}[${index}]`);
        });
      }
      if (def.rest !== undefined && def.rest !== null) {
        if (unwrapsToOptional(def.rest)) {
          throw new Error(`Wire boundary schema at ${path}[...rest] must not use optional rest elements.`);
        }
        walk(def.rest, `${path}[...rest]`);
      }
      return;
    }
    if (nodeType === "record") {
      if (unwrapsToOptional(def.valueType)) {
        throw new Error(`Wire boundary schema at ${path}[value] must not use optional record values.`);
      }
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
 * depth.
 *
 * `assertWireBoundarySchema` runs first to fail closed on all transforms,
 * pipes, coercions, custom predicates, non-JSON literals, and unrepresentable
 * types. Zod's emitter then runs with `io: "input"` and `unrepresentable: "throw"`
 * so ordinary `z.object(...)` request/result schemas preserve wire parity with
 * runtime validation (allowing forward-compatible extra JSON fields), while
 * `z.strictObject(...)` still emits `additionalProperties: false` and
 * `looseJsonObject(...)` emits `additionalProperties: { $ref: ... }`.
 */
export function toWireJsonSchema(
  schema: z.ZodType,
  metadata?: ReturnType<typeof z.registry<{ id?: string }>>,
): Record<string, unknown> {
  assertWireBoundarySchema(schema);
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
