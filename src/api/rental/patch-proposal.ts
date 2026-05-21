/**
 * Patch proposal service — p5.3
 *
 * Bridges MCP/API patch proposals to the Patch Gate and persists the
 * idempotent result in `rental_patch_proposals`.
 */

import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { and, eq } from "drizzle-orm";

import {
  rental_patch_proposals,
  rental_workspace_manifests,
} from "../db/schema.js";
import { isPathExposed } from "./exposure-ledger.js";
import {
  type PatchFile,
  type PatchGateResult,
  type PatchProposal,
  validatePatch,
} from "./patch-gate.js";
import { scanFile } from "./secret-firewall.js";
import {
  stableHash,
  sha256,
  type RentalPatchProposalRow,
} from "./signed-change-journal.js";

export interface PatchProposalManifest {
  id: string;
  session_id: string;
  workspace_path: string | null;
  retention_status: string;
}

export interface PersistedPatchProposal {
  proposal: RentalPatchProposalRow;
  gate: PatchGateResult;
  idempotent: boolean;
}

export interface PatchProposalDeps {
  getActiveManifest(sessionId: string): Promise<PatchProposalManifest | null>;
  isPathExposed(sessionId: string, path: string): Promise<boolean>;
  loadByIdempotency(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<RentalPatchProposalRow | null>;
  insertProposal(
    row: typeof rental_patch_proposals.$inferInsert,
  ): Promise<RentalPatchProposalRow>;
  now(): Date;
  generateId(): string;
}

export interface ProposePatchInput {
  sessionId: string;
  idempotencyKey: string;
  summary?: string | null;
  files: PatchFile[];
}

export function createDefaultPatchProposalDeps(): PatchProposalDeps {
  return {
    async getActiveManifest(sessionId) {
      const { db } = await import("../db/client.js");
      const [row] = await db
        .select()
        .from(rental_workspace_manifests)
        .where(
          and(
            eq(rental_workspace_manifests.session_id, sessionId),
            eq(rental_workspace_manifests.retention_status, "active"),
          ),
        );
      return (row as PatchProposalManifest | undefined) ?? null;
    },
    async isPathExposed(sessionId, path) {
      const { db } = await import("../db/client.js");
      return isPathExposed({ db: db as any, generateId: () => "" }, sessionId, path);
    },
    async loadByIdempotency(sessionId, idempotencyKey) {
      const { db } = await import("../db/client.js");
      const [row] = await db
        .select()
        .from(rental_patch_proposals)
        .where(
          and(
            eq(rental_patch_proposals.session_id, sessionId),
            eq(rental_patch_proposals.idempotency_key, idempotencyKey),
          ),
        );
      return row ?? null;
    },
    async insertProposal(row) {
      const { db } = await import("../db/client.js");
      const [inserted] = await db
        .insert(rental_patch_proposals)
        .values(row)
        .returning();
      return inserted;
    },
    now: () => new Date(),
    generateId: () => `rpatch_${randomUUID().replace(/-/g, "")}`,
  };
}

export async function proposePatch(
  deps: PatchProposalDeps,
  input: ProposePatchInput,
): Promise<PersistedPatchProposal> {
  const sessionId = input.sessionId.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (!sessionId) throw new PatchProposalError("sessionId is required", 400);
  if (!idempotencyKey) throw new PatchProposalError("idempotencyKey is required", 400);

  const files = normalizePatchFiles(input.files);
  const summary = normalizeOptionalText(input.summary);
  const requestHash = stableHash({ sessionId, idempotencyKey, summary, files });
  const existing = await deps.loadByIdempotency(sessionId, idempotencyKey);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new PatchProposalError(
        "idempotency key already used with a different patch request",
        409,
      );
    }
    return {
      proposal: existing,
      gate: gateFromStoredProposal(
        existing,
        sessionId,
        idempotencyKey,
        summary,
        filesFromStoredProposal(existing) ?? files,
      ),
      idempotent: true,
    };
  }

  const manifest = await deps.getActiveManifest(sessionId);
  const workspaceRoot = await resolveWorkspaceRoot(manifest);
  const patchProposal: PatchProposal = {
    sessionId,
    idempotencyKey,
    files,
    summary: summary ?? undefined,
  };
  const gate = await validatePatch({
    isPathExposed: deps.isPathExposed,
    workspacePath: workspaceRoot,
    scanContent: async (filePath, content) => {
      const scan = scanFile(filePath, content);
      return {
        blocked: scan.verdict === "blocked",
        redactionCount: scan.redactionCount,
        content: scan.content ?? "",
      };
    },
  }, patchProposal);

  const proposalId = deps.generateId();
  const checkResults = gateToCheckResults(gate, manifest?.id ?? null);
  const sanitizedFiles = filesWithSanitizedContent(files, gate);
  const responseHash = stableHash({
    proposalId,
    sessionId,
    gateStatus: gate.verdict,
    checkResults,
  });

  try {
    const proposal = await deps.insertProposal({
      id: proposalId,
      session_id: sessionId,
      source: "explicit_patch",
      diff_ref: `sha256:${sha256(JSON.stringify(sanitizedFiles))}`,
      summary,
      gate_status: gate.verdict,
      risk_score: null,
      warnings: gate.warnings.map((message) => ({ message })),
      check_results: checkResults,
      journal_entry: {
        version: 1,
        files: sanitizedFiles,
        proposedAt: deps.now().toISOString(),
      },
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      response_hash: responseHash,
    });
    return { proposal, gate, idempotent: false };
  } catch (err) {
    if (!isIdempotencyUniqueViolation(err)) throw err;
    const winner = await deps.loadByIdempotency(sessionId, idempotencyKey);
    if (!winner || winner.request_hash !== requestHash) throw err;
    return {
      proposal: winner,
      gate: gateFromStoredProposal(
        winner,
        sessionId,
        idempotencyKey,
        summary,
        filesFromStoredProposal(winner) ?? files,
      ),
      idempotent: true,
    };
  }
}

export class PatchProposalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PatchProposalError";
  }
}

async function resolveWorkspaceRoot(
  manifest: PatchProposalManifest | null,
): Promise<string> {
  if (!manifest || manifest.retention_status !== "active") {
    throw new PatchProposalError("workspace_not_ready", 409);
  }
  if (!manifest.workspace_path) {
    throw new PatchProposalError("workspace_path_missing", 409);
  }
  try {
    const root = await fs.realpath(manifest.workspace_path);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      throw new PatchProposalError("workspace_path_not_directory", 409);
    }
    return root;
  } catch (err) {
    if (err instanceof PatchProposalError) throw err;
    throw new PatchProposalError("workspace_path_missing", 409);
  }
}

function normalizePatchFiles(files: PatchFile[]): PatchFile[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new PatchProposalError("files must be a non-empty array", 400);
  }
  return files.map((file) => {
    if (!file || typeof file !== "object") {
      throw new PatchProposalError("each file must be an object", 400);
    }
    if (typeof file.path !== "string" || !file.path.trim()) {
      throw new PatchProposalError("file.path is required", 400);
    }
    if (!["modify", "create", "delete"].includes(file.operation)) {
      throw new PatchProposalError("file.operation must be modify, create, or delete", 400);
    }
    return {
      path: file.path.trim(),
      operation: file.operation,
      content: typeof file.content === "string" ? file.content : undefined,
      diff: typeof file.diff === "string" ? file.diff : undefined,
    };
  });
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function gateToCheckResults(
  gate: PatchGateResult,
  manifestId: string | null,
): Record<string, unknown> {
  return {
    verdict: gate.verdict,
    checks: gate.checks,
    warnings: gate.warnings,
    rejectionReasons: gate.rejectionReasons,
    manifestId,
  };
}

function filesWithSanitizedContent(
  files: PatchFile[],
  gate: PatchGateResult,
): PatchFile[] {
  return files.map((file, index) => {
    const check = gate.checks[index];
    const sanitizedContent = check?.sanitizedContent;
    return {
      ...file,
      path: check?.file ?? file.path,
      content: sanitizedContent ?? file.content,
    };
  });
}

function filesFromStoredProposal(
  row: RentalPatchProposalRow,
): PatchFile[] | null {
  const journalEntry = row.journal_entry;
  if (!isRecord(journalEntry) || !Array.isArray(journalEntry.files)) {
    return null;
  }
  return journalEntry.files.filter(isRecord).map((file) => ({
    path: typeof file.path === "string" ? file.path : "",
    operation:
      file.operation === "modify" ||
      file.operation === "create" ||
      file.operation === "delete"
        ? file.operation
        : "modify",
    content: typeof file.content === "string" ? file.content : undefined,
    diff: typeof file.diff === "string" ? file.diff : undefined,
  }));
}

function gateFromStoredProposal(
  row: RentalPatchProposalRow,
  sessionId: string,
  idempotencyKey: string,
  summary: string | null,
  files: PatchFile[],
): PatchGateResult {
  const checks = row.check_results as {
    checks?: PatchGateResult["checks"];
    warnings?: string[];
    rejectionReasons?: string[];
  };
  return {
    verdict: row.gate_status as PatchGateResult["verdict"],
    proposal: {
      sessionId,
      idempotencyKey,
      files,
      summary: summary ?? undefined,
    },
    checks: Array.isArray(checks.checks) ? checks.checks : [],
    warnings: Array.isArray(checks.warnings) ? checks.warnings : [],
    rejectionReasons: Array.isArray(checks.rejectionReasons)
      ? checks.rejectionReasons
      : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdempotencyUniqueViolation(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const message = typeof error.message === "string" ? error.message : "";
  return message.includes("rental_patch_proposals_session_idempotency_uq");
}
