import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  EXECUTION_APPROVAL_PROJECTION_VERSION,
  parseExecutionApprovalProjectionV1,
  serializeExecutionApprovalProjectionV1,
  type ExecutionApprovalProjectionV1,
} from "../../../shared/execution-approval-projection.mjs";
import type { CodexPermissionFileChange } from "../shared/provider-permissions.js";
import { executionApprovalProjectionPathsAreSafe } from "./execution-approval-projection-policy.js";

export type PreparedExecutionApprovalProjection = {
  requestSha256: string;
  workAttemptId: string;
  value: ExecutionApprovalProjectionV1;
  json: string;
  sha256: string;
};
export type ExecutionApprovalProjectionPreparation = Readonly<{
  requestSha256: string;
  workAttemptId: string;
}>;
export type ExecutionApprovalProjectionSource = Readonly<{
  request: unknown;
  changes: readonly CodexPermissionFileChange[];
}>;

export class ExecutionApprovalProjectionError extends Error {
  constructor(readonly code: "invalid_input" | "unsafe_path" | "not_eligible" | "expired" | "conflict" | "corrupt") {
    super(`Execution approval projection rejected: ${code}.`);
    this.name = "ExecutionApprovalProjectionError";
  }
}

function reject(code: ExecutionApprovalProjectionError["code"]): never {
  throw new ExecutionApprovalProjectionError(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

async function assertNoSymlink(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const part of relativePath.split("/")) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) reject("unsafe_path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

type WorkspacePath = { path: string; filesystemIdentity: string | null };

async function workspaceRelativePath(logicalRoot: string, canonicalRoot: string, input: string): Promise<WorkspacePath> {
  if (!input || input.includes("\\")) reject("unsafe_path");
  const normalizedInput = input.normalize("NFC");
  if (normalizedInput !== input) reject("unsafe_path");
  const pathParts = normalizedInput.split("/");
  if (pathParts.slice(normalizedInput.startsWith("/") ? 1 : 0)
    .some((part) => !part || part === "." || part === "..")) reject("unsafe_path");
  let candidate: string;
  if (isAbsolute(normalizedInput)) {
    const absolute = resolve(normalizedInput);
    if (isInside(logicalRoot, absolute)) candidate = resolve(canonicalRoot, relative(logicalRoot, absolute));
    else if (isInside(canonicalRoot, absolute)) candidate = absolute;
    else reject("unsafe_path");
  } else {
    candidate = resolve(canonicalRoot, normalizedInput);
  }
  if (!isInside(canonicalRoot, candidate)) reject("unsafe_path");
  const projected = relative(canonicalRoot, candidate).split(sep).join("/").normalize("NFC");
  if (!projected || projected === ".") reject("unsafe_path");
  await assertNoSymlink(canonicalRoot, projected);
  try {
    const identity = await lstat(candidate);
    return { path: projected, filesystemIdentity: `${identity.dev}:${identity.ino}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: projected, filesystemIdentity: null };
    throw error;
  }
}

function diffCounts(diff: string): { added_lines: number; removed_lines: number; diff_bytes: number } {
  let added_lines = 0;
  let removed_lines = 0;
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk && (line.startsWith("+++ ") || line.startsWith("--- "))) continue;
    if (line.startsWith("+")) added_lines += 1;
    if (line.startsWith("-")) removed_lines += 1;
  }
  return { added_lines, removed_lines, diff_bytes: Buffer.byteLength(diff, "utf8") };
}

function workspacePathForAttempt(database: DatabaseSync, workAttemptId: string): string {
  const row = database.prepare("SELECT workspace_path FROM work_attempts WHERE work_attempt_id=?")
    .get(workAttemptId) as { workspace_path?: unknown } | undefined;
  if (!row || typeof row.workspace_path !== "string" || !isAbsolute(row.workspace_path)) reject("invalid_input");
  return row.workspace_path;
}

/** Prepare the exact bounded bytes a remote delegate may later be shown. */
export async function prepareExecutionApprovalProjection(
  database: DatabaseSync,
  input: ExecutionApprovalProjectionPreparation,
  source: ExecutionApprovalProjectionSource,
): Promise<PreparedExecutionApprovalProjection> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== 2 || !/^[a-f0-9]{64}$/.test(input.requestSha256)
    || typeof input.workAttemptId !== "string" || !input.workAttemptId) reject("invalid_input");
  if (!source || typeof source !== "object" || Array.isArray(source)
    || Object.keys(source).length !== 2 || !Object.hasOwn(source, "request") || !Object.hasOwn(source, "changes")) reject("invalid_input");
  let requestJson: string | undefined;
  try { requestJson = JSON.stringify(source); } catch { reject("invalid_input"); }
  if (!requestJson || sha256(requestJson) !== input.requestSha256) reject("invalid_input");
  const fileChanges = source.changes;
  if (!Array.isArray(fileChanges) || fileChanges.length < 1 || fileChanges.length > 128) reject("invalid_input");
  const logicalRoot = resolve(workspacePathForAttempt(database, input.workAttemptId));
  const canonicalRoot = await realpath(logicalRoot);
  const resolvedChanges = await Promise.all(fileChanges.map(async (change) => {
    if (!change || typeof change.path !== "string" || typeof change.diff !== "string") reject("invalid_input");
    const path = await workspaceRelativePath(logicalRoot, canonicalRoot, change.path);
    const movePath = change.kind.type === "update" && change.kind.move_path !== null
      ? await workspaceRelativePath(logicalRoot, canonicalRoot, change.kind.move_path)
      : null;
    const kind = change.kind.type === "update" && movePath !== null ? "move" as const : change.kind.type;
    return { path, kind, movePath, ...diffCounts(change.diff) };
  }));
  const filesystemIdentities = new Set<string>();
  for (const resolved of resolvedChanges.flatMap(change => change.movePath === null
    ? [change.path]
    : [change.path, change.movePath])) {
    if (resolved.filesystemIdentity !== null && filesystemIdentities.has(resolved.filesystemIdentity)) reject("not_eligible");
    if (resolved.filesystemIdentity !== null) filesystemIdentities.add(resolved.filesystemIdentity);
  }
  const changes = resolvedChanges.map(change => ({
    path: change.path.path,
    kind: change.kind,
    move_path: change.movePath?.path ?? null,
    added_lines: change.added_lines,
    removed_lines: change.removed_lines,
    diff_bytes: change.diff_bytes,
  }));
  if (!executionApprovalProjectionPathsAreSafe(changes.flatMap((change) => change.move_path === null
    ? [change.path]
    : [change.path, change.move_path]))) reject("not_eligible");
  const totals = changes.reduce((sum, change) => ({
    file_count: sum.file_count + 1,
    added_lines: sum.added_lines + change.added_lines,
    removed_lines: sum.removed_lines + change.removed_lines,
    diff_bytes: sum.diff_bytes + change.diff_bytes,
  }), { file_count: 0, added_lines: 0, removed_lines: 0, diff_bytes: 0 });
  const json = serializeExecutionApprovalProjectionV1({
    version: EXECUTION_APPROVAL_PROJECTION_VERSION,
    category: "file_change",
    path_scope: "workspace_relative",
    changes,
    totals,
  });
  if (!json) reject("invalid_input");
  return {
    requestSha256: input.requestSha256,
    workAttemptId: input.workAttemptId,
    value: parseExecutionApprovalProjectionV1(JSON.parse(json))!,
    json,
    sha256: sha256(json),
  };
}
