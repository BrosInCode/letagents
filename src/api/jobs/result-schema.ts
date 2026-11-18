import { z } from "zod";

import { ApiError, describeIssues } from "../../../shared/api/core.mjs";
import { JOB_LIMITS, type JobResultSchema } from "../../../shared/api/jobs.mjs";

/** Serialized size in bytes; undefined counts as null. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function depth(schema: JobResultSchema): number {
  const children = [...Object.values(schema.properties ?? {}), ...(schema.items ? [schema.items] : [])];
  return 1 + Math.max(0, ...children.map(depth));
}

/**
 * The contract already limits a result schema to the supported keywords; this
 * bounds its size and nesting, which a zod schema cannot express.
 */
export function assertJobResultSchemaBounds(schema: JobResultSchema): void {
  if (jsonBytes(schema) > JOB_LIMITS.resultSchemaBytes) {
    throw new ApiError("too_large", `resultSchema is larger than ${JOB_LIMITS.resultSchemaBytes} bytes.`);
  }
  if (depth(schema) > JOB_LIMITS.resultSchemaDepth) {
    throw new ApiError("invalid_input", `resultSchema nests deeper than ${JOB_LIMITS.resultSchemaDepth} levels.`);
  }
}

/**
 * Checks an agent's result against the job's result schema. The schema is
 * converted with zod's own `z.fromJSONSchema`; only the subset the contract
 * accepts ever reaches it. Returns one line per problem, or an empty list.
 */
export function jobResultProblems(schema: JobResultSchema, result: unknown): string[] {
  const parsed = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]).safeParse(result);
  if (parsed.success) return [];
  return describeIssues(parsed.error).map(({ path, message }) => (path ? `${path}: ${message}` : message));
}
