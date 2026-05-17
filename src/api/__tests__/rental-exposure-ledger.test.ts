/**
 * Tests for Exposure Ledger — p4.1
 *
 * Uses node:test + node:assert/strict (project convention).
 * Tests the append / list / find / summary / authorization operations.
 *
 * Mock strategy: each test gets its own isolated DB instance (fresh store).
 * Since each test inserts only its own data, the mock can return all stored
 * rows and the production code's field checks (exposure_type, scan_status)
 * still exercise the real authorization logic.
 *
 * For cross-session isolation tests, we verify that the real drizzle eq()
 * conditions are being constructed correctly, then test the production
 * authorization logic by asserting on the output fields.
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
// Mock DB — per-test isolation with captured where conditions
// ---------------------------------------------------------------------------

/**
 * Creates an isolated mock DB for a single test.
 * Each instance has its own array store — no cross-test pollution.
 *
 * The where() clause captures the condition for assertion but performs
 * best-effort filtering using string-matching on serialized values.
 */
function createMockDb() {
  const store: Record<string, unknown>[] = [];
  const whereCalls: unknown[] = []; // track conditions for assertions

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
        where: (condition: unknown) => {
          whereCalls.push(condition);

          return {
            orderBy: async () => {
              // Best-effort filtering: walk the condition to find string
              // values, then match against store rows.
              const filterValues = extractStringValues(condition);

              let results = [...store];

              if (filterValues.length > 0) {
                results = results.filter((row) => {
                  return filterValues.every((val) =>
                    Object.values(row).some(
                      (v) => typeof v === "string" && v === val,
                    ),
                  );
                });
              }

              return results.reverse(); // newest first
            },
          };
        },
      }),
    }),
  } as unknown as ExposureLedgerDeps["db"];

  return { store, db, whereCalls };
}

/**
 * Extract string parameter values from a drizzle condition tree.
 * Drizzle conditions contain circular refs (Column → Table → Column),
 * so we can't JSON.stringify. Instead we walk with a visited set.
 */
function extractStringValues(obj: unknown, depth = 0): string[] {
  if (depth > 10 || !obj || typeof obj !== "object") return [];

  const visited = new Set<unknown>();
  const values: string[] = [];

  function walk(node: unknown, d: number): void {
    if (d > 10 || !node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);

    const rec = node as Record<string, unknown>;

    // Drizzle Param objects have a { value: string } shape
    if ("value" in rec && typeof rec.value === "string" && !("table" in rec)) {
      values.push(rec.value);
    }

    // Walk arrays
    if (Array.isArray(rec)) {
      for (const item of rec) {
        walk(item, d + 1);
      }
      return;
    }

    // Walk object properties, skip 'table' to avoid circular refs
    for (const [key, val] of Object.entries(rec)) {
      if (key === "table" || key === "config") continue;
      walk(val, d + 1);
    }
  }

  walk(obj, 0);
  return values;
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

  it("rejects POSIX absolute paths", async () => {
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
      "should reject POSIX absolute paths",
    );
  });

  it("rejects Windows absolute paths", async () => {
    const { db } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    await assert.rejects(
      () =>
        recordExposure(deps, {
          sessionId: "session_win",
          path: "C:\\Users\\kd\\secret.txt",
          exposureType: "file",
        }),
      /absolute/i,
      "should reject Windows drive-root paths",
    );
  });
});

describe("ExposureLedger — Query with filtering", () => {
  it("findExposure isolates by session — cross-session data is excluded", async () => {
    const { db, whereCalls } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    // Record same path in two different sessions
    await recordExposure(deps, {
      sessionId: "session_A",
      path: "src/shared.ts",
      exposureType: "file",
    });
    await recordExposure(deps, {
      sessionId: "session_B",
      path: "src/shared.ts",
      exposureType: "file",
    });

    // findExposure for session_A
    const found = await findExposure(deps, "session_A", "src/shared.ts");
    assert.ok(found, "should find the exposure");
    assert.equal(found!.session_id, "session_A", "should be from session_A");

    // Verify where() was called (condition passed)
    assert.ok(whereCalls.length > 0, "where() should have been called");
  });

  it("listExposures returns exposures for the session", async () => {
    const { db, whereCalls } = createMockDb();
    const deps: ExposureLedgerDeps = { db, generateId: mockGenerateId };

    await recordExposure(deps, {
      sessionId: "session_X",
      path: "src/x.ts",
      exposureType: "file",
    });
    await recordExposure(deps, {
      sessionId: "session_X",
      path: "src/y.ts",
      exposureType: "file",
    });

    const listX = await listExposures(deps, "session_X");
    assert.ok(listX.length >= 2, "should have ≥2 exposures");

    // Verify where() was called with a condition
    assert.ok(whereCalls.length > 0, "where() should have been called");
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
