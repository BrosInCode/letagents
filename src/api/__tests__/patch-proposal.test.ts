/**
 * Tests for p5.3 explicit patch proposal persistence.
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import type { RentalPatchProposalRow } from "../rental/signed-change-journal.js";
import type {
  PatchProposalDeps,
  PatchProposalManifest,
} from "../rental/patch-proposal.js";

const { PatchProposalError, proposePatch } = await import("../rental/patch-proposal.js");

let workspaceRoot: string;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "patch-proposal-test-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "index.ts"), "export const value = 1;\n");
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

function makeRow(
  overrides: Partial<RentalPatchProposalRow>,
): RentalPatchProposalRow {
  return {
    id: "rpatch_1",
    session_id: "rsess_1",
    source: "explicit_patch",
    diff_ref: "sha256:diff",
    summary: null,
    gate_status: "pending",
    risk_score: null,
    warnings: [],
    check_results: {},
    journal_entry: null,
    idempotency_key: "patch-1",
    request_hash: "request",
    response_hash: "response",
    created_at: new Date("2026-05-17T23:00:00.000Z"),
    updated_at: new Date("2026-05-17T23:00:00.000Z"),
    ...overrides,
  } as RentalPatchProposalRow;
}

function makeDeps(exposed = new Set(["src/index.ts"])) {
  const rows: RentalPatchProposalRow[] = [];
  const inserted: RentalPatchProposalRow[] = [];
  const manifest: PatchProposalManifest = {
    id: "manifest_1",
    session_id: "rsess_1",
    workspace_path: workspaceRoot,
    retention_status: "active",
  };
  let counter = 0;
  const deps: PatchProposalDeps = {
    async getActiveManifest() {
      return manifest;
    },
    async isPathExposed(_sessionId, filePath) {
      return exposed.has(filePath);
    },
    async loadByIdempotency(sessionId, idempotencyKey) {
      return rows.find((row) => (
        row.session_id === sessionId &&
        row.idempotency_key === idempotencyKey
      )) ?? null;
    },
    async insertProposal(row) {
      const insertedRow = makeRow(row as Partial<RentalPatchProposalRow>);
      rows.push(insertedRow);
      inserted.push(insertedRow);
      return insertedRow;
    },
    now: () => new Date("2026-05-17T23:00:00.000Z"),
    generateId() {
      counter += 1;
      return `rpatch_test_${counter}`;
    },
  };
  return { deps, inserted, rows };
}

describe("proposePatch", () => {
  it("validates and persists an explicit patch proposal", async () => {
    const { deps, inserted } = makeDeps();
    const result = await proposePatch(deps, {
      sessionId: "rsess_1",
      idempotencyKey: "patch-1",
      summary: "Update value",
      files: [
        {
          path: "src/index.ts",
          operation: "modify",
          content: "export const value = 2;\n",
        },
      ],
    });

    assert.equal(result.idempotent, false);
    assert.equal(result.gate.verdict, "passed");
    assert.equal(result.proposal.gate_status, "passed");
    assert.equal(result.proposal.source, "explicit_patch");
    assert.equal(inserted.length, 1);
    assert.equal(
      (inserted[0]!.check_results as { manifestId?: string }).manifestId,
      "manifest_1",
    );
  });

  it("returns the stored row on same idempotency key and request", async () => {
    const { deps, inserted } = makeDeps();
    const input = {
      sessionId: "rsess_1",
      idempotencyKey: "patch-1",
      files: [
        {
          path: "src/index.ts",
          operation: "modify" as const,
          content: "export const value = 2;\n",
        },
      ],
    };

    const first = await proposePatch(deps, input);
    const second = await proposePatch(deps, input);

    assert.equal(inserted.length, 1);
    assert.equal(second.idempotent, true);
    assert.equal(second.proposal.id, first.proposal.id);
  });

  it("persists and replays redacted patch content after Secret Firewall sanitization", async () => {
    const { deps, inserted } = makeDeps();
    const secret = `ghp_${"A".repeat(36)}`;
    const content = `export const token = "${secret}";\n`;
    const input = {
      sessionId: "rsess_1",
      idempotencyKey: "patch-1",
      files: [
        {
          path: "src/index.ts",
          operation: "modify" as const,
          content,
        },
      ],
    };

    const first = await proposePatch(deps, input);
    const journalEntry = inserted[0]!.journal_entry as {
      files: Array<{ content?: string }>;
    };
    const persistedJson = JSON.stringify(journalEntry);

    assert.equal(first.gate.verdict, "passed_with_warnings");
    assert.doesNotMatch(persistedJson, /ghp_/);
    assert.match(journalEntry.files[0]!.content ?? "", /REDACTED_GITHUB_PAT/);
    assert.equal(
      inserted[0]!.diff_ref,
      `sha256:${sha256(JSON.stringify(journalEntry.files))}`,
    );
    assert.notEqual(
      inserted[0]!.diff_ref,
      `sha256:${sha256(JSON.stringify(input.files))}`,
    );

    const second = await proposePatch(deps, input);
    assert.equal(second.idempotent, true);
    assert.doesNotMatch(JSON.stringify(second.gate.proposal.files), /ghp_/);
    assert.match(
      second.gate.proposal.files[0]?.content ?? "",
      /REDACTED_GITHUB_PAT/,
    );
  });

  it("persists rejected gate results for unexposed files", async () => {
    const { deps, inserted } = makeDeps(new Set());
    const result = await proposePatch(deps, {
      sessionId: "rsess_1",
      idempotencyKey: "patch-1",
      files: [
        {
          path: "src/index.ts",
          operation: "modify",
          content: "export const value = 2;\n",
        },
      ],
    });

    assert.equal(result.gate.verdict, "rejected");
    assert.equal(inserted[0]!.gate_status, "rejected");
    assert.match(result.gate.rejectionReasons.join("\n"), /not exposed/);
  });

  it("rejects idempotency conflicts", async () => {
    const { deps } = makeDeps();
    await proposePatch(deps, {
      sessionId: "rsess_1",
      idempotencyKey: "patch-1",
      files: [{ path: "src/index.ts", operation: "modify", content: "one\n" }],
    });

    await assert.rejects(
      proposePatch(deps, {
        sessionId: "rsess_1",
        idempotencyKey: "patch-1",
        files: [{ path: "src/index.ts", operation: "modify", content: "two\n" }],
      }),
      (err) => {
        assert.ok(err instanceof PatchProposalError);
        assert.equal(err.status, 409);
        return true;
      },
    );
  });
});
