/**
 * Tests for p5.1 Patch Gate schema + Signed Change Journal foundation.
 *
 * Covers:
 * - rental_patch_proposals schema shape and enums
 * - appendSignedChange idempotency and conflict handling
 * - reconstructPatch whole-file unified diff output
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  RentalPatchProposalRow,
  SignedChangeJournalDeps,
} from "../rental/signed-change-journal.js";

const {
  appendSignedChange,
  contentHash,
  reconstructPatch,
  SignedChangeJournalError,
} = await import("../rental/signed-change-journal.js");
const {
  rental_patch_proposals,
  rentalPatchGateStatusEnum,
  rentalPatchProposalSourceEnum,
} = await import("../db/schema.js");

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("rental_patch_proposals schema", () => {
  it("has source enum values per spec §19.5", () => {
    assert.deepEqual(rentalPatchProposalSourceEnum.enumValues, [
      "signed_change_journal",
      "explicit_patch",
      "raw_diff",
    ]);
  });

  it("has Patch Gate statuses aligned with renderer and §14.5", () => {
    assert.deepEqual(rentalPatchGateStatusEnum.enumValues, [
      "pending",
      "passed",
      "passed_with_warnings",
      "needs_renter_approval",
      "rejected",
      "needs_revision",
      "timed_out",
    ]);
  });

  it("exposes all p5.1 columns", () => {
    const cols = Object.keys(rental_patch_proposals);
    const required = [
      "id",
      "session_id",
      "source",
      "diff_ref",
      "summary",
      "gate_status",
      "risk_score",
      "warnings",
      "check_results",
      "journal_entry",
      "idempotency_key",
      "request_hash",
      "response_hash",
      "created_at",
      "updated_at",
    ];
    for (const col of required) {
      assert.ok(cols.includes(col), `missing column ${col}`);
    }
  });

  it("idempotency metadata is required", () => {
    assert.equal(rental_patch_proposals.idempotency_key.notNull, true);
    assert.equal(rental_patch_proposals.request_hash.notNull, true);
    assert.equal(rental_patch_proposals.response_hash.notNull, true);
  });

  it("gate status defaults to pending", () => {
    assert.equal(rental_patch_proposals.gate_status.notNull, true);
    assert.notEqual(rental_patch_proposals.gate_status.default, undefined);
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeProposalRow(
  overrides: Partial<RentalPatchProposalRow> = {},
): RentalPatchProposalRow {
  return {
    id: "rpatch_1",
    session_id: "rsess_1",
    source: "signed_change_journal",
    diff_ref: "sha256:diff",
    summary: null,
    gate_status: "pending",
    risk_score: null,
    warnings: [],
    check_results: {},
    journal_entry: null,
    idempotency_key: "edit-1",
    request_hash: "request-hash",
    response_hash: "response-hash",
    created_at: new Date("2026-05-17T20:00:00.000Z"),
    updated_at: new Date("2026-05-17T20:00:00.000Z"),
    ...overrides,
  } as RentalPatchProposalRow;
}

function buildDeps(initialRows: RentalPatchProposalRow[] = []) {
  const rows = [...initialRows];
  const inserted: RentalPatchProposalRow[] = [];
  let idCounter = 0;
  let nowCounter = 0;
  const deps: SignedChangeJournalDeps = {
    async loadByIdempotency(sessionId, idempotencyKey) {
      return rows.find((row) => (
        row.session_id === sessionId &&
        row.idempotency_key === idempotencyKey
      )) ?? null;
    },
    async loadJournalRows(sessionId) {
      return rows
        .filter((row) => row.session_id === sessionId && row.source === "signed_change_journal")
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    },
    async insertProposal(row) {
      const date = new Date(Date.parse("2026-05-17T20:00:00.000Z") + nowCounter * 1000);
      nowCounter += 1;
      const insertedRow = makeProposalRow({
        ...row,
        created_at: row.created_at ?? date,
        updated_at: row.updated_at ?? date,
      } as Partial<RentalPatchProposalRow>);
      rows.push(insertedRow);
      inserted.push(insertedRow);
      return insertedRow;
    },
    now() {
      return new Date(Date.parse("2026-05-17T20:00:00.000Z") + nowCounter * 1000);
    },
    generateId() {
      idCounter += 1;
      return `rpatch_test_${idCounter}`;
    },
  };
  return { deps, inserted, rows };
}

function afterContentFromWholeFileDiff(diff: string): string {
  const afterLines = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  return `${afterLines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Signed Change Journal
// ---------------------------------------------------------------------------

describe("appendSignedChange", () => {
  it("persists a signed journal edit and returns an equivalent unified diff", async () => {
    const { deps, inserted } = buildDeps();
    const beforeContent = "export const value = 1;\n";
    const afterContent = "export const value = 2;\n";

    const result = await appendSignedChange({
      sessionId: "rsess_1",
      idempotencyKey: "edit-1",
      edit: {
        path: "src/value.ts",
        beforeContent,
        afterContent,
        summary: "Update value",
        actorAgentKey: "agent/provider",
      },
    }, deps);

    assert.equal(inserted.length, 1);
    assert.equal(result.idempotent, false);
    assert.equal(result.proposal.id, "rpatch_test_1");
    assert.equal(result.proposal.source, "signed_change_journal");
    assert.equal(result.proposal.gate_status, "pending");
    assert.match(result.proposal.diff_ref ?? "", /^sha256:/);
    assert.equal(result.entry.path, "src/value.ts");
    assert.equal(result.entry.beforeHash, contentHash(beforeContent));
    assert.equal(result.entry.afterHash, contentHash(afterContent));
    assert.match(result.patch, /^diff --git a\/src\/value\.ts b\/src\/value\.ts/m);
    assert.equal(afterContentFromWholeFileDiff(result.patch), afterContent);
  });

  it("returns the original row when the same idempotency key repeats the same edit", async () => {
    const { deps, inserted } = buildDeps();
    const input = {
      sessionId: "rsess_1",
      idempotencyKey: "edit-1",
      edit: {
        path: "src/value.ts",
        beforeContent: "one\n",
        afterContent: "two\n",
      },
    };

    const first = await appendSignedChange(input, deps);
    const second = await appendSignedChange(input, deps);

    assert.equal(inserted.length, 1);
    assert.equal(second.idempotent, true);
    assert.equal(second.proposal.id, first.proposal.id);
    assert.equal(second.patch, first.patch);
  });

  it("rejects idempotency key reuse with a different edit request", async () => {
    const { deps } = buildDeps();
    await appendSignedChange({
      sessionId: "rsess_1",
      idempotencyKey: "edit-1",
      edit: {
        path: "src/value.ts",
        beforeContent: "one\n",
        afterContent: "two\n",
      },
    }, deps);

    await assert.rejects(
      appendSignedChange({
        sessionId: "rsess_1",
        idempotencyKey: "edit-1",
        edit: {
          path: "src/value.ts",
          beforeContent: "one\n",
          afterContent: "three\n",
        },
      }, deps),
      (error) => {
        assert.ok(error instanceof SignedChangeJournalError);
        assert.equal(error.code, "idempotency_conflict");
        assert.equal(error.status, 409);
        return true;
      },
    );
  });

  it("rejects absolute or parent-relative edit paths", async () => {
    const { deps } = buildDeps();
    await assert.rejects(
      appendSignedChange({
        sessionId: "rsess_1",
        idempotencyKey: "edit-1",
        edit: {
          path: "../secret.ts",
          beforeContent: "one\n",
          afterContent: "two\n",
        },
      }, deps),
      /repo-relative/,
    );
  });
});

describe("reconstructPatch", () => {
  it("reconstructs journal edits for a session in append order", async () => {
    const { deps } = buildDeps();
    await appendSignedChange({
      sessionId: "rsess_1",
      idempotencyKey: "edit-1",
      edit: {
        path: "src/a.ts",
        beforeContent: "a1\n",
        afterContent: "a2\n",
      },
    }, deps);
    await appendSignedChange({
      sessionId: "rsess_1",
      idempotencyKey: "edit-2",
      edit: {
        path: "src/b.ts",
        beforeContent: "b1\n",
        afterContent: "b2\n",
      },
    }, deps);

    const patch = await reconstructPatch("rsess_1", deps);
    assert.match(patch, /diff --git a\/src\/a\.ts b\/src\/a\.ts/);
    assert.match(patch, /diff --git a\/src\/b\.ts b\/src\/b\.ts/);
    assert.ok(
      patch.indexOf("diff --git a/src/a.ts b/src/a.ts") <
        patch.indexOf("diff --git a/src/b.ts b/src/b.ts"),
      "first edit should appear before second edit",
    );
  });
});
