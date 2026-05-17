/**
 * Tests for Exposure Ledger — p4.1
 *
 * Uses node:test + node:assert/strict (project convention).
 * Tests the append / list / find / summary / authorization operations.
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
// Mock DB — filters by session_id and path
// ---------------------------------------------------------------------------

/**
 * Creates a mock DB that actually filters by session_id and path.
 * Uses a simple array store with field-matching filter logic.
 */
function createMockDb() {
  const store: Record<string, unknown>[] = [];

  const db = {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          store.push({ ...v });
          return [v];
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: (condition: unknown) => ({
          orderBy: async () => {
            // Filter rows using the condition.
            // Drizzle's eq/and produce objects with queryChunks.
            // We extract field values by inspecting the condition tree.
            const filters = extractFilters(condition);
            const filtered = store.filter((row) => {
              for (const [key, val] of Object.entries(filters)) {
                if (row[key] !== val) return false;
              }
              return true;
            });
            return [...filtered].reverse(); // newest first
          },
        }),
      }),
    }),
  } as unknown as ExposureLedgerDeps["db"];

  return { store, db };
}

/**
 * Extract field=value filters from drizzle eq/and conditions.
 * Drizzle's eq() produces objects like:
 *   { queryChunks: [Column, Param] }
 * We walk the tree to find session_id and path filters.
 */
function extractFilters(
  condition: unknown,
): Record<string, string> {
  const filters: Record<string, string> = {};

  if (!condition || typeof condition !== "object") return filters;

  const cond = condition as Record<string, unknown>;

  // Handle `and(eq(...), eq(...))`
  if (Array.isArray(cond.queryChunks)) {
    // Single eq()
    const chunks = cond.queryChunks as unknown[];
    if (chunks.length >= 2) {
      const col = chunks[0] as Record<string, unknown> | undefined;
      const param = chunks[1] as Record<string, unknown> | undefined;
      if (col?.name && param?.value !== undefined) {
        filters[col.name as string] = param.value as string;
      }
    }
  }

  // Handle `and()` wrapper — it's a SQL with nested queryChunks
  if (cond.queryChunks && Array.isArray(cond.queryChunks)) {
    for (const chunk of cond.queryChunks as unknown[]) {
      if (chunk && typeof chunk === "object") {
        const sub = chunk as Record<string, unknown>;
        if (sub.queryChunks && Array.isArray(sub.queryChunks)) {
          const subChunks = sub.queryChunks as unknown[];
          if (subChunks.length >= 2) {
            const col = subChunks[0] as Record<string, unknown> | undefined;
            const param = subChunks[1] as Record<string, unknown> | undefined;
            if (col?.name && param?.value !== undefined) {
              filters[col.name as string] = param.value as string;
            }
          }
        }
      }
    }
  }

  return filters;
}

let idCounter = 0;
function mockGenerateId(): string {
  return `exposure_test_${++idCounter}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExposureLedger — Recording", () => {
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
      path: "config/settings.ts",
      exposureType: "file",
      content: "SECRET_KEY=***REDACTED***",
      secretScanStatus: "redacted",
      redactionCount: 1,
    });

    assert.equal(result.secret_scan_status, "redacted");
    assert.equal(result.redaction_count, 1);
  });

  it("normalizes paths with . and .. segments", async () => {
    const { db, store } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    await recordExposure(deps, {
      sessionId: "session_norm",
      path: "src/./utils/../index.ts",
      exposureType: "file",
    });

    const stored = store[0];
    assert.equal(stored.path, "src/index.ts", "path should be normalized");
  });

  it("rejects traversal paths that escape repo root", async () => {
    const { db } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    await assert.rejects(
      () =>
        recordExposure(deps, {
          sessionId: "session_trav",
          path: "../../etc/passwd",
          exposureType: "file",
        }),
      /traversal/i,
      "should reject path traversal",
    );
  });

  it("rejects absolute paths", async () => {
    const { db } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    await assert.rejects(
      () =>
        recordExposure(deps, {
          sessionId: "session_abs",
          path: "/etc/passwd",
          exposureType: "file",
        }),
      /absolute/i,
      "should reject absolute paths",
    );
  });
});

describe("ExposureLedger — Query", () => {
  it("listExposures returns all exposures for a session", async () => {
    const { db } = createMockDb();
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
});

describe("ExposureLedger — isPathExposed authorization", () => {
  it("returns true for exposed file with passed scan", async () => {
    const { db } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    await recordExposure(deps, {
      sessionId: "session_auth_1",
      path: "src/exposed.ts",
      exposureType: "file",
      secretScanStatus: "passed",
    });

    const exposed = await isPathExposed(deps, "session_auth_1", "src/exposed.ts");
    assert.ok(exposed, "file with passed scan should be authorized");
  });

  it("returns true for exposed file with redacted scan", async () => {
    const { db } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    await recordExposure(deps, {
      sessionId: "session_auth_2",
      path: "src/redacted.ts",
      exposureType: "file",
      secretScanStatus: "redacted",
      redactionCount: 3,
    });

    const exposed = await isPathExposed(deps, "session_auth_2", "src/redacted.ts");
    assert.ok(exposed, "file with redacted scan should be authorized");
  });

  it("returns false for blocked exposures", async () => {
    const { db } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    await recordExposure(deps, {
      sessionId: "session_auth_3",
      path: "config/blocked.ts",
      exposureType: "file",
      secretScanStatus: "blocked",
    });

    const exposed = await isPathExposed(deps, "session_auth_3", "config/blocked.ts");
    assert.ok(!exposed, "blocked file should NOT be authorized");
  });

  it("returns false for non-file exposure types", async () => {
    const { db } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    await recordExposure(deps, {
      sessionId: "session_auth_4",
      path: "search_results",
      exposureType: "search_result",
    });

    const exposed = await isPathExposed(deps, "session_auth_4", "search_results");
    assert.ok(!exposed, "search_result should NOT authorize patch edits");
  });

  it("returns false for directory_listing type", async () => {
    const { db } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    await recordExposure(deps, {
      sessionId: "session_auth_5",
      path: "src",
      exposureType: "directory_listing",
    });

    const exposed = await isPathExposed(deps, "session_auth_5", "src");
    assert.ok(!exposed, "directory_listing should NOT authorize patch edits");
  });
});

describe("ExposureLedger — Summary", () => {
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
});

describe("ExposureLedger — Batch", () => {
  it("recordBatchExposures records multiple files", async () => {
    const { db, store } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    const count = await recordBatchExposures(deps, "session_8", [
      { path: "src/a.ts", content: "file a" },
      { path: "src/b.ts", content: "file b" },
      { path: "src/c.ts", content: "file c" },
    ]);

    assert.equal(count, 3, "should record 3 exposures");
    assert.equal(store.length, 3, "mock db should have 3 entries");
  });
});
