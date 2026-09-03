import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  EXECUTION_APPROVAL_PROJECTION_VERSION,
  parseExecutionApprovalProjectionV1,
  serializeExecutionApprovalProjectionV1,
  type ExecutionApprovalProjectionV1,
} from "../../../shared/execution-approval-projection.mjs";
import { executionApprovalProjectionPathsAreSafe } from "./execution-approval-projection-policy.js";
import { ApprovalJournalError, getExecutionApproval, type ApprovalReference } from "./execution-approval-journal.js";
import {
  ExecutionApprovalProjectionError,
  type ProducedExecutionApprovalProjection,
} from "./execution-approval-projection.js";

type Row = Record<string, unknown>;
export type ExecutionApprovalProjectionRecord = {
  requestId: string;
  requestVersion: number;
  requestSha256: string;
  agentId: string;
  roomId: string;
  executionGenerationId: string;
  turnId: string;
  producedAtMs: number;
  value: ExecutionApprovalProjectionV1;
  json: string;
  sha256: string;
};

function reject(code: ExecutionApprovalProjectionError["code"]): never {
  throw new ExecutionApprovalProjectionError(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameReference(left: ApprovalReference, right: ApprovalReference): boolean {
  return Object.entries(left).every(([key, value]) => right[key as keyof ApprovalReference] === value)
    && Object.keys(left).length === Object.keys(right).length;
}

function recordFromRow(row: Row): ExecutionApprovalProjectionRecord {
  if (typeof row.projection_json !== "string") reject("corrupt");
  let value: unknown;
  try { value = JSON.parse(row.projection_json); } catch { reject("corrupt"); }
  const parsed = parseExecutionApprovalProjectionV1(value);
  const canonical = parsed && serializeExecutionApprovalProjectionV1(parsed);
  const paths = parsed?.changes.flatMap(change => change.move_path === null ? [change.path] : [change.path, change.move_path]);
  if (!parsed || canonical !== row.projection_json || sha256(row.projection_json) !== row.projection_sha256
    || row.projection_version !== EXECUTION_APPROVAL_PROJECTION_VERSION
    || !paths || !executionApprovalProjectionPathsAreSafe(paths)) reject("corrupt");
  return {
    requestId: String(row.request_id), requestVersion: Number(row.request_version),
    requestSha256: String(row.request_sha256), agentId: String(row.agent_id), roomId: String(row.room_id),
    executionGenerationId: String(row.execution_generation_id), turnId: String(row.turn_id),
    producedAtMs: Number(row.produced_at_ms), value: parsed, json: row.projection_json,
    sha256: String(row.projection_sha256),
  };
}

export function readExecutionApprovalProjection(
  database: DatabaseSync,
  expected: ApprovalReference,
): ExecutionApprovalProjectionRecord | null {
  const row = database.prepare(`SELECT * FROM execution_approval_projections
    WHERE request_id=? AND request_version=?`).get(expected.requestId, expected.requestVersion) as Row | undefined;
  if (!row) return null;
  try {
    if (!getExecutionApproval(database, expected)) reject("corrupt");
  } catch (error) {
    if (error instanceof ApprovalJournalError) reject("corrupt");
    throw error;
  }
  const record = recordFromRow(row);
  if (record.requestSha256 !== expected.requestSha256 || record.agentId !== expected.agentId
    || record.roomId !== expected.roomId || record.executionGenerationId !== expected.executionGenerationId
    || record.turnId !== expected.turnId) reject("corrupt");
  return record;
}

/** Record one immutable projection inside the caller's fenced transaction. */
export function recordExecutionApprovalProjection(
  database: DatabaseSync,
  input: { expected: ApprovalReference; projection: ProducedExecutionApprovalProjection; producedAtMs: number },
): { created: boolean; projection: ExecutionApprovalProjectionRecord } {
  if (!database.isTransaction || !Number.isSafeInteger(input.producedAtMs) || input.producedAtMs < 0) reject("invalid_input");
  const approval = getExecutionApproval(database, input.expected);
  if (!approval || approval.request.kind !== "file_change" || approval.request.risk !== "low"
    || !approval.request.delegatable || approval.request.state !== "requested" || approval.decision) reject("not_eligible");
  if (!sameReference(input.projection.expected, input.expected)) reject("conflict");
  const parsed = parseExecutionApprovalProjectionV1(input.projection.value);
  const canonical = parsed && serializeExecutionApprovalProjectionV1(parsed);
  const paths = parsed?.changes.flatMap(change => change.move_path === null ? [change.path] : [change.path, change.move_path]);
  if (!parsed || canonical !== input.projection.json || sha256(canonical) !== input.projection.sha256
    || !paths || !executionApprovalProjectionPathsAreSafe(paths)) reject("invalid_input");
  const prior = readExecutionApprovalProjection(database, input.expected);
  if (prior) {
    if (prior.json !== canonical || prior.sha256 !== input.projection.sha256) reject("conflict");
    return { created: false, projection: prior };
  }
  if (input.producedAtMs < approval.request.createdAtMs || input.producedAtMs >= approval.request.expiresAtMs) reject("expired");
  const request = approval.request;
  database.prepare(`INSERT INTO execution_approval_projections(
    request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,request_delegatable,
    request_sha256,projection_version,projection_json,projection_sha256,produced_at_ms
  ) VALUES(?,?,?,?,?,?,1,?,?,?,?,?)`).run(
    request.requestId, request.requestVersion, request.agentId, request.roomId, request.executionGenerationId,
    request.turnId, request.requestSha256, EXECUTION_APPROVAL_PROJECTION_VERSION, canonical,
    input.projection.sha256, input.producedAtMs,
  );
  return { created: true, projection: readExecutionApprovalProjection(database, input.expected)! };
}
