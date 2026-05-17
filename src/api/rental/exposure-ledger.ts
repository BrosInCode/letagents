/**
 * Exposure Ledger Service — p4.1
 *
 * Per spec §19.4, manages the exposure audit trail for rental sessions.
 * Records every file, search result, directory listing, or command output
 * exposed to the provider agent.
 *
 * Used by:
 * - Context Broker: records exposures when files are served
 * - Patch Gate: validates edits only touch exposed files
 * - Renter UI: shows what was shared during a session
 * - Post-session audit: full disclosure record
 */

import { and, eq, desc, sql } from "drizzle-orm";
import { createHash } from "crypto";
import {
  rental_workspace_exposures,
  type rentalExposureTypeEnum,
  type rentalSecretScanStatusEnum,
} from "../db/schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExposureType = "file" | "search_result" | "directory_listing" | "command_output";
export type SecretScanStatus = "passed" | "redacted" | "blocked";

export interface RecordExposureInput {
  sessionId: string;
  path: string;
  exposureType: ExposureType;
  content?: string | Buffer;
  reason?: string;
  redactionCount?: number;
  secretScanStatus?: SecretScanStatus;
  requestedBy?: string;
  approvedBy?: string;
  scopeId?: string;
}

export interface ExposureRecord {
  id: string;
  session_id: string;
  path: string;
  exposure_type: ExposureType;
  reason: string | null;
  redaction_count: number;
  secret_scan_status: SecretScanStatus;
  requested_by: string | null;
  approved_by: string | null;
  scope_id: string | null;
  bytes_exposed: number;
  content_hash: string | null;
  created_at: Date;
}

export interface ExposureSummary {
  sessionId: string;
  totalExposures: number;
  totalBytes: number;
  byType: Record<ExposureType, number>;
  redactedCount: number;
  blockedCount: number;
}

export interface ExposureLedgerDeps {
  db: {
    insert: (table: typeof rental_workspace_exposures) => {
      values: (v: unknown) => { returning: () => Promise<unknown[]> };
    };
    select: () => {
      from: (table: typeof rental_workspace_exposures) => {
        where: (c: unknown) => {
          orderBy: (o: unknown) => Promise<unknown[]>;
        };
      };
    };
  };
  generateId: () => string;
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Record a file or context exposure in the ledger.
 */
export async function recordExposure(
  deps: ExposureLedgerDeps,
  input: RecordExposureInput,
): Promise<ExposureRecord> {
  const log = deps.log ?? (() => {});
  const id = deps.generateId();

  // Compute content hash and size if content is provided
  let bytesExposed = 0;
  let contentHash: string | null = null;

  if (input.content) {
    const buf =
      typeof input.content === "string"
        ? Buffer.from(input.content, "utf-8")
        : input.content;
    bytesExposed = buf.length;
    contentHash = createHash("sha256").update(buf).digest("hex");
  }

  const row = {
    id,
    session_id: input.sessionId,
    path: input.path,
    exposure_type: input.exposureType,
    reason: input.reason ?? null,
    redaction_count: input.redactionCount ?? 0,
    secret_scan_status: input.secretScanStatus ?? "passed",
    requested_by: input.requestedBy ?? null,
    approved_by: input.approvedBy ?? null,
    scope_id: input.scopeId ?? null,
    bytes_exposed: bytesExposed,
    content_hash: contentHash,
    created_at: new Date(),
  };

  const [inserted] = await deps.db
    .insert(rental_workspace_exposures)
    .values(row)
    .returning();

  log(
    `Recorded exposure: ${input.path} (${input.exposureType}) → ${id}`,
  );

  return inserted as ExposureRecord;
}

/**
 * List all exposures for a session, ordered by creation time (newest first).
 */
export async function listExposures(
  deps: ExposureLedgerDeps,
  sessionId: string,
): Promise<ExposureRecord[]> {
  const rows = await deps.db
    .select()
    .from(rental_workspace_exposures)
    .where(eq(rental_workspace_exposures.session_id, sessionId))
    .orderBy(desc(rental_workspace_exposures.created_at));

  return rows as ExposureRecord[];
}

/**
 * Find a specific exposure by session + path.
 * Returns the most recent exposure for that path.
 */
export async function findExposure(
  deps: ExposureLedgerDeps,
  sessionId: string,
  filePath: string,
): Promise<ExposureRecord | null> {
  const rows = await deps.db
    .select()
    .from(rental_workspace_exposures)
    .where(
      and(
        eq(rental_workspace_exposures.session_id, sessionId),
        eq(rental_workspace_exposures.path, filePath),
      ),
    )
    .orderBy(desc(rental_workspace_exposures.created_at));

  return (rows as ExposureRecord[])[0] ?? null;
}

/**
 * Check if a file path was exposed in a session.
 * Used by Patch Gate to validate edits.
 */
export async function isPathExposed(
  deps: ExposureLedgerDeps,
  sessionId: string,
  filePath: string,
): Promise<boolean> {
  const exposure = await findExposure(deps, sessionId, filePath);
  return exposure !== null;
}

/**
 * Get a summary of all exposures for a session.
 */
export async function getExposureSummary(
  deps: ExposureLedgerDeps,
  sessionId: string,
): Promise<ExposureSummary> {
  const exposures = await listExposures(deps, sessionId);

  const byType: Record<ExposureType, number> = {
    file: 0,
    search_result: 0,
    directory_listing: 0,
    command_output: 0,
  };

  let totalBytes = 0;
  let redactedCount = 0;
  let blockedCount = 0;

  for (const e of exposures) {
    byType[e.exposure_type]++;
    totalBytes += e.bytes_exposed;
    if (e.secret_scan_status === "redacted") redactedCount++;
    if (e.secret_scan_status === "blocked") blockedCount++;
  }

  return {
    sessionId,
    totalExposures: exposures.length,
    totalBytes,
    byType,
    redactedCount,
    blockedCount,
  };
}

/**
 * Record multiple file exposures at once (batch append).
 * Used during workspace materialization to record all scope-matched files.
 */
export async function recordBatchExposures(
  deps: ExposureLedgerDeps,
  sessionId: string,
  files: Array<{
    path: string;
    content?: string | Buffer;
    reason?: string;
    secretScanStatus?: SecretScanStatus;
    redactionCount?: number;
  }>,
): Promise<number> {
  const log = deps.log ?? (() => {});
  let count = 0;

  for (const file of files) {
    await recordExposure(deps, {
      sessionId,
      path: file.path,
      exposureType: "file",
      content: file.content,
      reason: file.reason ?? "scope glob match",
      secretScanStatus: file.secretScanStatus ?? "passed",
      redactionCount: file.redactionCount ?? 0,
      approvedBy: "auto",
    });
    count++;
  }

  log(`Batch recorded ${count} file exposures for session ${sessionId}`);
  return count;
}
