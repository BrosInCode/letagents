export const EXECUTION_APPROVAL_PROJECTION_VERSION: 1;
export const EXECUTION_APPROVAL_PROJECTION_MAX_FILES: 128;
export const EXECUTION_APPROVAL_PROJECTION_MAX_PATH_BYTES: 4096;
export const EXECUTION_APPROVAL_PROJECTION_MAX_BYTES: number;

export type ExecutionApprovalProjectionChangeKind = "add" | "delete" | "update" | "move";
export type ExecutionApprovalProjectionChange = {
  path: string;
  kind: ExecutionApprovalProjectionChangeKind;
  move_path: string | null;
  added_lines: number;
  removed_lines: number;
  diff_bytes: number;
};
export type ExecutionApprovalProjectionV1 = {
  version: 1;
  category: "file_change";
  path_scope: "workspace_relative";
  changes: ExecutionApprovalProjectionChange[];
  totals: {
    file_count: number;
    added_lines: number;
    removed_lines: number;
    diff_bytes: number;
  };
};

export function isExecutionApprovalProjectionPath(value: unknown): value is string;
/** Return the canonical allowlisted projection, or reject it as a whole. */
export function parseExecutionApprovalProjectionV1(value: unknown): ExecutionApprovalProjectionV1 | null;
/** Serialize only the canonical, bounded bytes that a delegate may see. */
export function serializeExecutionApprovalProjectionV1(value: unknown): string | null;
