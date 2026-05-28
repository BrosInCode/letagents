export type PatchGateVerdict =
  | "passed"
  | "passed_with_warnings"
  | "needs_renter_approval"
  | "rejected";

export interface PatchFile {
  /** Repo-relative file path (must match an exposed file). */
  path: string;
  /** The operation: modify existing, create new, or delete. */
  operation: "modify" | "create" | "delete";
  /** New content (required for modify/create, omitted for delete). */
  content?: string;
  /** Unified diff — currently rejected; reserved for future use. */
  diff?: string;
}

export interface PatchProposal {
  sessionId: string;
  /** Unique key for idempotent processing. */
  idempotencyKey: string;
  /** Files being changed. */
  files: PatchFile[];
  /** Optional summary from the agent. */
  summary?: string;
}

export interface PatchCheckResult {
  file: string;
  operation: string;
  passed: boolean;
  reason?: string;
  warnings: string[];
  secretsRedacted: number;
  /** The content that will actually be written (after redaction). */
  sanitizedContent?: string;
}

export interface PatchGateResult {
  verdict: PatchGateVerdict;
  proposal: PatchProposal;
  checks: PatchCheckResult[];
  warnings: string[];
  rejectionReasons: string[];
  appliedAt?: Date;
}

export interface PatchGateDeps {
  /** Check if a file path was exposed for this session. */
  isPathExposed: (sessionId: string, filePath: string) => Promise<boolean>;
  /** Scan content for secrets, returns { blocked, redactionCount, content }. */
  scanContent?: (
    filePath: string,
    content: string,
  ) => Promise<{
    blocked: boolean;
    redactionCount: number;
    content: string;
  }>;
  /** Absolute path to the workspace root. */
  workspacePath: string;
  log?: (msg: string) => void;
}
