/**
 * Tests for Exposure Ledger — p4.1
 *
 * Uses node:test + node:assert/strict (project convention).
 * Tests the append / list / find / summary operations.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  recordExposure,
  listExposures,
  findExposure,
  isPathExposed,
  getExposureSummary,
  recordBatchExposures,
  type ExposureLedgerDeps,
  type ExposureRecord,
} from "../rental/exposure-ledger.js";

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

function createMockDb() {
  const exposures = new Map<string, Record<string, unknown>>();

  return {
    exposures,
    db: {
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          returning: async () => {
            exposures.set(v.id as string, { ...v });
            return [v];
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: (condition: unknown) => ({
            orderBy: async () => Array.from(exposures.values()),
          }),
        }),
      }),
    } as unknown as ExposureLedgerDeps["db"],
  };
}

let idCounter = 0;
function mockGenerateId(): string {
  return `exposure_test_${++idCounter}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExposureLedger", () => {
  it("records a file exposure with content hash", async () => {
    const { db } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    const result = await recordExposure(deps, {
      sessionId: "session_1",
      path: "src/index.ts",
      exposureType: "file",
      content: 'export const hello = "world";',
      reason: "scope glob match",
      approvedBy: "auto",
    });

    assert.ok(result.id, "should have an ID");
    assert.equal(result.session_id, "session_1");
    assert.equal(result.path, "src/index.ts");
    assert.equal(result.exposure_type, "file");
    assert.ok(result.content_hash, "should have content hash");
    assert.equal(result.content_hash!.length, 64, "SHA-256 = 64 hex chars");
    assert.ok(result.bytes_exposed > 0, "should count bytes");
  });

  it("records exposure without content (size 0, no hash)", async () => {
    const { db } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    const result = await recordExposure(deps, {
      sessionId: "session_2",
      path: "docs/README.md",
      exposureType: "directory_listing",
    });

    assert.equal(result.bytes_exposed, 0);
    assert.equal(result.content_hash, null);
  });

  it("records redacted exposure", async () => {
    const { db } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    const result = await recordExposure(deps, {
      sessionId: "session_3",
      path: ".env",
      exposureType: "file",
      content: "SECRET_KEY=***REDACTED***",
      secretScanStatus: "redacted",
      redactionCount: 1,
    });

    assert.equal(result.secret_scan_status, "redacted");
    assert.equal(result.redaction_count, 1);
  });

  it("listExposures returns all exposures for a session", async () => {
    const { db, exposures } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    await recordExposure(deps, {
      sessionId: "session_4",
      path: "src/a.ts",
      exposureType: "file",
    });
    await recordExposure(deps, {
      sessionId: "session_4",
      path: "src/b.ts",
      exposureType: "file",
    });

    const list = await listExposures(deps, "session_4");
    assert.ok(list.length >= 2, "should have ≥2 exposures");
  });

  it("findExposure returns a specific exposure by path", async () => {
    const { db } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    await recordExposure(deps, {
      sessionId: "session_5",
      path: "src/target.ts",
      exposureType: "file",
    });

    const found = await findExposure(deps, "session_5", "src/target.ts");
    assert.ok(found, "should find the exposure");
  });

  it("isPathExposed returns true for exposed paths", async () => {
    const { db } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    await recordExposure(deps, {
      sessionId: "session_6",
      path: "src/exposed.ts",
      exposureType: "file",
    });

    const exposed = await isPathExposed(deps, "session_6", "src/exposed.ts");
    assert.ok(exposed, "should be exposed");
  });

  it("getExposureSummary computes correct totals", async () => {
    const { db } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    await recordExposure(deps, {
      sessionId: "session_7",
      path: "src/a.ts",
      exposureType: "file",
      content: "hello",
    });
    await recordExposure(deps, {
      sessionId: "session_7",
      path: "src/b.ts",
      exposureType: "file",
      content: "world",
      secretScanStatus: "redacted",
      redactionCount: 2,
    });
    await recordExposure(deps, {
      sessionId: "session_7",
      path: "results",
      exposureType: "search_result",
    });

    const summary = await getExposureSummary(deps, "session_7");
    assert.equal(summary.sessionId, "session_7");
    assert.equal(summary.totalExposures, 3);
    assert.ok(summary.totalBytes > 0, "should sum bytes");
    assert.equal(summary.byType.file, 2);
    assert.equal(summary.byType.search_result, 1);
    assert.equal(summary.redactedCount, 1);
  });

  it("recordBatchExposures records multiple files", async () => {
    const { db, exposures } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    const count = await recordBatchExposures(deps, "session_8", [
      { path: "src/a.ts", content: "file a" },
      { path: "src/b.ts", content: "file b" },
      { path: "src/c.ts", content: "file c" },
    ]);

    assert.equal(count, 3, "should record 3 exposures");
    assert.equal(exposures.size, 3, "mock db should have 3 entries");
  });
});
