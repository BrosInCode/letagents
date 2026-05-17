/**
 * Signed Change Journal foundation for Rent-an-Agent Patch Gate.
 *
 * V1 does not attempt hash-chain provenance. It records tool-mediated
 * edits idempotently, stores enough content to reconstruct a unified
 * diff, and rejects idempotency-key reuse with a different request.
 */

import crypto from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { rental_patch_proposals } from "../db/schema.js";

export type RentalPatchProposalRow = typeof rental_patch_proposals.$inferSelect;

export type SignedChangeJournalErrorCode =
  | "invalid_input"
  | "idempotency_conflict";

export class SignedChangeJournalError extends Error {
  constructor(
    message: string,
    readonly code: SignedChangeJournalErrorCode,
    readonly status: number,
  ) {
    super(message);
    this.name = "SignedChangeJournalError";
  }
}

export interface SignedChangeEditInput {
  path: string;
  beforeContent: string;
  afterContent: string;
  summary?: string | null;
  actorAgentKey?: string | null;
  toolName?: string | null;
}

export interface AppendSignedChangeInput {
  sessionId: string;
  idempotencyKey: string;
  edit: SignedChangeEditInput;
}

export interface SignedChangeJournalEntry {
  version: 1;
  path: string;
  beforeContent: string;
  afterContent: string;
  beforeHash: string;
  afterHash: string;
  summary: string | null;
  actorAgentKey: string | null;
  toolName: string;
  createdAt: string;
}

export interface AppendSignedChangeResult {
  proposal: RentalPatchProposalRow;
  entry: SignedChangeJournalEntry;
  patch: string;
  idempotent: boolean;
}

export interface SignedChangeJournalDeps {
  loadByIdempotency(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<RentalPatchProposalRow | null>;
  loadJournalRows(sessionId: string): Promise<RentalPatchProposalRow[]>;
  insertProposal(
    row: typeof rental_patch_proposals.$inferInsert,
  ): Promise<RentalPatchProposalRow>;
  now(): Date;
  generateId(): string;
}

export const defaultSignedChangeJournalDeps: SignedChangeJournalDeps = {
  async loadByIdempotency(sessionId, idempotencyKey) {
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
  async loadJournalRows(sessionId) {
    return db
      .select()
      .from(rental_patch_proposals)
      .where(
        and(
          eq(rental_patch_proposals.session_id, sessionId),
          eq(rental_patch_proposals.source, "signed_change_journal"),
        ),
      )
      .orderBy(asc(rental_patch_proposals.created_at));
  },
  async insertProposal(row) {
    const [inserted] = await db
      .insert(rental_patch_proposals)
      .values(row)
      .returning();
    return inserted;
  },
  now: () => new Date(),
  generateId: () => `rpatch_${crypto.randomUUID().replace(/-/g, "")}`,
};

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")}}`;
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function stableHash(value: unknown): string {
  return sha256(stableJson(value));
}

export function contentHash(content: string): string {
  return `sha256:${sha256(content)}`;
}

function normalizeRepoPath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed) {
    throw new SignedChangeJournalError("edit path is required", "invalid_input", 400);
  }
  if (trimmed.startsWith("/") || trimmed.split("/").includes("..")) {
    throw new SignedChangeJournalError(
      "edit path must be repo-relative",
      "invalid_input",
      400,
    );
  }
  return trimmed;
}

function normalizeString(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new SignedChangeJournalError(`${label} must be a string`, "invalid_input", 400);
  }
  return value;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function splitLinesForWholeFileDiff(content: string): string[] {
  if (content === "") return [];
  const withoutFinalNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (withoutFinalNewline === "") return [];
  return withoutFinalNewline.split(/\r?\n/);
}

function hunkRange(lineCount: number): string {
  return lineCount === 0 ? "0,0" : `1,${lineCount}`;
}

export function buildUnifiedDiff(entry: Pick<SignedChangeJournalEntry, "path" | "beforeContent" | "afterContent">): string {
  const beforeLines = splitLinesForWholeFileDiff(entry.beforeContent);
  const afterLines = splitLinesForWholeFileDiff(entry.afterContent);
  const lines = [
    `diff --git a/${entry.path} b/${entry.path}`,
    `--- a/${entry.path}`,
    `+++ b/${entry.path}`,
    `@@ -${hunkRange(beforeLines.length)} +${hunkRange(afterLines.length)} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ];
  return `${lines.join("\n")}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseJournalEntry(value: unknown): SignedChangeJournalEntry {
  if (!isRecord(value)) {
    throw new SignedChangeJournalError("journal_entry is missing", "invalid_input", 500);
  }
  const entry = value as Partial<SignedChangeJournalEntry>;
  if (
    entry.version !== 1 ||
    typeof entry.path !== "string" ||
    typeof entry.beforeContent !== "string" ||
    typeof entry.afterContent !== "string" ||
    typeof entry.beforeHash !== "string" ||
    typeof entry.afterHash !== "string" ||
    typeof entry.toolName !== "string" ||
    typeof entry.createdAt !== "string"
  ) {
    throw new SignedChangeJournalError("journal_entry is malformed", "invalid_input", 500);
  }
  return {
    version: 1,
    path: entry.path,
    beforeContent: entry.beforeContent,
    afterContent: entry.afterContent,
    beforeHash: entry.beforeHash,
    afterHash: entry.afterHash,
    summary: typeof entry.summary === "string" ? entry.summary : null,
    actorAgentKey: typeof entry.actorAgentKey === "string" ? entry.actorAgentKey : null,
    toolName: entry.toolName,
    createdAt: entry.createdAt,
  };
}

function requestHashFor(input: {
  sessionId: string;
  path: string;
  beforeContent: string;
  afterContent: string;
  summary: string | null;
  actorAgentKey: string | null;
  toolName: string;
}): string {
  return stableHash(input);
}

function isIdempotencyUniqueViolation(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const message = typeof error.message === "string" ? error.message : "";
  return message.includes("rental_patch_proposals_session_idempotency_uq");
}

function assertSameRequest(existing: RentalPatchProposalRow, requestHash: string): void {
  if (existing.request_hash !== requestHash) {
    throw new SignedChangeJournalError(
      "idempotency key already used with a different edit request",
      "idempotency_conflict",
      409,
    );
  }
}

export async function appendSignedChange(
  input: AppendSignedChangeInput,
  deps: SignedChangeJournalDeps = defaultSignedChangeJournalDeps,
): Promise<AppendSignedChangeResult> {
  const sessionId = input.sessionId.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (!sessionId) {
    throw new SignedChangeJournalError("sessionId is required", "invalid_input", 400);
  }
  if (!idempotencyKey) {
    throw new SignedChangeJournalError("idempotencyKey is required", "invalid_input", 400);
  }

  const path = normalizeRepoPath(input.edit.path);
  const beforeContent = normalizeString(input.edit.beforeContent, "beforeContent");
  const afterContent = normalizeString(input.edit.afterContent, "afterContent");
  if (beforeContent === afterContent) {
    throw new SignedChangeJournalError("edit does not change content", "invalid_input", 400);
  }
  const summary = normalizeOptionalText(input.edit.summary);
  const actorAgentKey = normalizeOptionalText(input.edit.actorAgentKey);
  const toolName = normalizeOptionalText(input.edit.toolName) ?? "rental_propose_edit";
  const requestHash = requestHashFor({
    sessionId,
    path,
    beforeContent,
    afterContent,
    summary,
    actorAgentKey,
    toolName,
  });

  const existing = await deps.loadByIdempotency(sessionId, idempotencyKey);
  if (existing) {
    assertSameRequest(existing, requestHash);
    const entry = parseJournalEntry(existing.journal_entry);
    return {
      proposal: existing,
      entry,
      patch: buildUnifiedDiff(entry),
      idempotent: true,
    };
  }

  const entry: SignedChangeJournalEntry = {
    version: 1,
    path,
    beforeContent,
    afterContent,
    beforeHash: contentHash(beforeContent),
    afterHash: contentHash(afterContent),
    summary,
    actorAgentKey,
    toolName,
    createdAt: deps.now().toISOString(),
  };
  const patch = buildUnifiedDiff(entry);
  const proposalId = deps.generateId();
  const diffRef = `sha256:${sha256(patch)}`;
  const responseHash = stableHash({
    proposalId,
    sessionId,
    source: "signed_change_journal",
    diffRef,
    path,
  });

  try {
    const proposal = await deps.insertProposal({
      id: proposalId,
      session_id: sessionId,
      source: "signed_change_journal",
      diff_ref: diffRef,
      summary,
      gate_status: "pending",
      risk_score: null,
      warnings: [],
      check_results: {},
      journal_entry: entry as unknown as Record<string, unknown>,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      response_hash: responseHash,
    });
    return { proposal, entry, patch, idempotent: false };
  } catch (error) {
    if (!isIdempotencyUniqueViolation(error)) {
      throw error;
    }
    const winner = await deps.loadByIdempotency(sessionId, idempotencyKey);
    if (!winner) throw error;
    assertSameRequest(winner, requestHash);
    const winnerEntry = parseJournalEntry(winner.journal_entry);
    return {
      proposal: winner,
      entry: winnerEntry,
      patch: buildUnifiedDiff(winnerEntry),
      idempotent: true,
    };
  }
}

export function reconstructPatchFromRows(rows: RentalPatchProposalRow[]): string {
  const patches = rows
    .filter((row) => row.source === "signed_change_journal")
    .map((row) => buildUnifiedDiff(parseJournalEntry(row.journal_entry)));
  return patches.join("\n");
}

export async function reconstructPatch(
  sessionId: string,
  deps: SignedChangeJournalDeps = defaultSignedChangeJournalDeps,
): Promise<string> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new SignedChangeJournalError("sessionId is required", "invalid_input", 400);
  }
  const rows = await deps.loadJournalRows(normalizedSessionId);
  return reconstructPatchFromRows(rows);
}
