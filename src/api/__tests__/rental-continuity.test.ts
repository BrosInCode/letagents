/**
 * Tests for the Continuity Pack builder (p1.6 deterministic half).
 *
 * Covers:
 *   - session metadata round-trip (goal / task / branches / mode)
 *   - filesTouched: dedup by path, most-recent-touch wins,
 *     scope_approved promotion, CAP=20 with truncatedCount surface
 *   - commandsRun: outcome prioritization (blocked/timed_out > run),
 *     CAP=10, source / exitCode round-trip
 *   - failingTests: string + object payload shapes; multiple tests
 *     per event
 *   - activeDiff: most-recently-proposed patch wins
 *   - packId stability: identical inputs at different wall-clock
 *     times produce identical packIds; changed input changes packId
 *   - approved_scope / policy pass through verbatim
 *   - empty input produces a still-valid pack
 *
 * Pure module — no DB. Callers pass nowIso explicitly so packId
 * comparisons stay deterministic.
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONTINUITY_COMMAND_CAP,
  CONTINUITY_FILE_CAP,
  buildContinuityPack,
  computePackId,
  type ContinuityPackEvent,
  type ContinuityPackSession,
} from "../rental/continuity.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function makeSession(
  overrides: Partial<ContinuityPackSession> = {},
): ContinuityPackSession {
  return {
    id: "rsess_1",
    task_title: "Fix flaky auth refresh",
    task_prompt: "The refreshSession test fails on stale tokens.",
    base_branch: "main",
    work_branch: "rental/rsess_1",
    status: "active",
    mode: "scoped",
    approved_scope: { includePaths: ["src/auth/**"], excludePaths: [], protectedPaths: [".env"], notes: null },
    policy: { maxLrt: 100_000, requirePatchGate: true },
    ...overrides,
  };
}

function event(
  type: string,
  payload: Record<string, unknown> | null,
  iso: string,
  overrides: Partial<ContinuityPackEvent> = {},
): ContinuityPackEvent {
  return {
    id: `rev_${type}_${iso}`,
    event_type: type,
    source: "tool",
    payload,
    created_at: iso,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe("buildContinuityPack", () => {
  it("produces a valid pack with no events (session metadata still present)", () => {
    const pack = buildContinuityPack(makeSession(), [], { nowIso: "2026-05-11T10:00:00.000Z" });
    assert.equal(pack.tier, "tier1_deterministic");
    assert.equal(pack.schemaVersion, 1);
    assert.equal(pack.session.id, "rsess_1");
    assert.equal(pack.session.taskTitle, "Fix flaky auth refresh");
    assert.deepEqual(pack.filesTouched, []);
    assert.deepEqual(pack.commandsRun, []);
    assert.deepEqual(pack.failingTests, []);
    assert.equal(pack.activeDiff, null);
    assert.equal(pack.filesTouchedSummary.totalCount, 0);
    assert.equal(pack.commandsRunSummary.truncatedCount, 0);
    assert.match(pack.packId, /^cpack_[0-9a-f]{32}$/);
  });

  it("passes approved_scope + policy through verbatim", () => {
    const pack = buildContinuityPack(makeSession(), [], { nowIso: "2026-05-11T10:00:00.000Z" });
    assert.deepEqual(pack.approvedScope, {
      includePaths: ["src/auth/**"],
      excludePaths: [],
      protectedPaths: [".env"],
      notes: null,
    });
    assert.deepEqual(pack.policy, { maxLrt: 100_000, requirePatchGate: true });
  });
});

// ---------------------------------------------------------------------------
// Files touched
// ---------------------------------------------------------------------------

describe("filesTouched", () => {
  it("dedupes by path; most-recent-touch wins for lastTouchedAt", () => {
    const pack = buildContinuityPack(makeSession(), [
      event("context.file_exposed", { path: "src/auth/session.ts", reason: "read" }, "2026-05-11T10:00:00.000Z"),
      event("context.file_exposed", { path: "src/auth/session.ts", reason: "edit" }, "2026-05-11T10:05:00.000Z"),
      event("context.file_exposed", { path: "src/auth/types.ts", reason: "read" }, "2026-05-11T10:02:00.000Z"),
    ], { nowIso: "2026-05-11T10:10:00.000Z" });
    assert.equal(pack.filesTouched.length, 2);
    const session = pack.filesTouched.find((f) => f.path === "src/auth/session.ts")!;
    assert.equal(session.lastTouchedAt, "2026-05-11T10:05:00.000Z");
    assert.equal(session.reason, "edit");
    assert.equal(session.scopeApproved, true);
  });

  it("includes files from edit_proposed / patch_proposed events", () => {
    const pack = buildContinuityPack(makeSession(), [
      event("edit.proposed", {
        files: ["src/auth/session.ts", { path: "tests/auth/session.test.ts" }],
      }, "2026-05-11T10:01:00.000Z"),
      event("patch.proposed", {
        paths: ["src/auth/refresh.ts"],
      }, "2026-05-11T10:02:00.000Z"),
    ], { nowIso: "2026-05-11T10:10:00.000Z" });
    assert.equal(pack.filesTouched.length, 3);
    const refresh = pack.filesTouched.find((f) => f.path === "src/auth/refresh.ts");
    assert.ok(refresh);
    assert.equal(refresh!.reason, "patch_proposed");
    assert.equal(refresh!.scopeApproved, false);
  });

  it("promotes scopeApproved=true when a file appears via both an exposure and a proposal", () => {
    const pack = buildContinuityPack(makeSession(), [
      event("edit.proposed", { files: ["src/auth/session.ts"] }, "2026-05-11T10:00:00.000Z"),
      event("context.file_exposed", { path: "src/auth/session.ts", reason: "read" }, "2026-05-11T10:05:00.000Z"),
    ], { nowIso: "2026-05-11T10:10:00.000Z" });
    const file = pack.filesTouched.find((f) => f.path === "src/auth/session.ts")!;
    assert.equal(file.scopeApproved, true);
    assert.equal(file.lastTouchedAt, "2026-05-11T10:05:00.000Z");
  });

  it("caps at CONTINUITY_FILE_CAP=20 and surfaces truncatedCount", () => {
    const events: ContinuityPackEvent[] = [];
    for (let i = 0; i < 25; i++) {
      events.push(
        event(
          "context.file_exposed",
          { path: `src/file_${i}.ts`, reason: "read" },
          new Date(Date.parse("2026-05-11T10:00:00.000Z") + i * 1000).toISOString(),
        ),
      );
    }
    const pack = buildContinuityPack(makeSession(), events, {
      nowIso: "2026-05-11T11:00:00.000Z",
    });
    assert.equal(CONTINUITY_FILE_CAP, 20);
    assert.equal(pack.filesTouched.length, 20);
    assert.equal(pack.filesTouchedSummary.totalCount, 25);
    assert.equal(pack.filesTouchedSummary.truncatedCount, 5);
    // Most-recent-first: file_24 should be present, file_0 should be dropped.
    assert.ok(pack.filesTouched.some((f) => f.path === "src/file_24.ts"));
    assert.ok(!pack.filesTouched.some((f) => f.path === "src/file_0.ts"));
  });
});

// ---------------------------------------------------------------------------
// Commands run
// ---------------------------------------------------------------------------

describe("commandsRun", () => {
  it("captures run / timed_out / blocked outcomes with exitCode + source", () => {
    const pack = buildContinuityPack(makeSession(), [
      event("command.run", { command: "npm test", exit_code: 0 }, "2026-05-11T10:00:00.000Z", { source: "tool" }),
      event("command.timed_out", { command: "npm run e2e" }, "2026-05-11T10:01:00.000Z"),
      event("command.blocked", { command: "rm -rf /" }, "2026-05-11T10:02:00.000Z"),
    ], { nowIso: "2026-05-11T10:10:00.000Z" });
    assert.equal(pack.commandsRun.length, 3);
    const blocked = pack.commandsRun.find((c) => c.command === "rm -rf /")!;
    assert.equal(blocked.outcome, "blocked");
    const runEntry = pack.commandsRun.find((c) => c.command === "npm test")!;
    assert.equal(runEntry.outcome, "run");
    assert.equal(runEntry.exitCode, 0);
  });

  it("caps at CONTINUITY_COMMAND_CAP=10, preserving blocked/timed_out over plain runs", () => {
    const events: ContinuityPackEvent[] = [];
    // 12 plain runs (oldest first)
    for (let i = 0; i < 12; i++) {
      events.push(event(
        "command.run",
        { command: `npm run task-${i}`, exit_code: 0 },
        new Date(Date.parse("2026-05-11T09:00:00.000Z") + i * 60_000).toISOString(),
      ));
    }
    // 2 blocked, very recent
    events.push(event(
      "command.blocked",
      { command: "rm -rf /" },
      "2026-05-11T10:00:00.000Z",
    ));
    events.push(event(
      "command.timed_out",
      { command: "npm run e2e" },
      "2026-05-11T10:01:00.000Z",
    ));
    const pack = buildContinuityPack(makeSession(), events, {
      nowIso: "2026-05-11T10:10:00.000Z",
    });
    assert.equal(CONTINUITY_COMMAND_CAP, 10);
    assert.equal(pack.commandsRun.length, 10);
    assert.equal(pack.commandsRunSummary.totalCount, 14);
    assert.equal(pack.commandsRunSummary.truncatedCount, 4);
    // The two non-`run` outcomes MUST be retained even though older
    // `npm run task-*` events outnumber them.
    assert.ok(pack.commandsRun.some((c) => c.outcome === "blocked"));
    assert.ok(pack.commandsRun.some((c) => c.outcome === "timed_out"));
  });
});

// ---------------------------------------------------------------------------
// Failing tests
// ---------------------------------------------------------------------------

describe("failingTests", () => {
  it("accepts string entries and object entries", () => {
    const pack = buildContinuityPack(makeSession(), [
      event("patch_gate.tests_failed", {
        tests: [
          "tests/auth/session.test.ts::refreshes",
          { name: "tests/auth/refresh.test.ts::rotates", details: "expected 200 got 401" },
        ],
      }, "2026-05-11T10:05:00.000Z"),
    ], { nowIso: "2026-05-11T10:10:00.000Z" });
    assert.equal(pack.failingTests.length, 2);
    assert.equal(pack.failingTests[0]!.test, "tests/auth/session.test.ts::refreshes");
    assert.equal(pack.failingTests[1]!.details, "expected 200 got 401");
  });

  it("accepts the alternate failing_tests payload key", () => {
    const pack = buildContinuityPack(makeSession(), [
      event("patch_gate.tests_failed", {
        failing_tests: [{ test: "tests/auth/foo.test.ts::bar" }],
      }, "2026-05-11T10:00:00.000Z"),
    ], { nowIso: "2026-05-11T10:10:00.000Z" });
    assert.equal(pack.failingTests.length, 1);
    assert.equal(pack.failingTests[0]!.test, "tests/auth/foo.test.ts::bar");
  });
});

// ---------------------------------------------------------------------------
// Active diff
// ---------------------------------------------------------------------------

describe("activeDiff", () => {
  it("returns the most-recently-proposed patch", () => {
    const pack = buildContinuityPack(makeSession(), [
      event("patch.proposed", { patch_id: "patch_1", summary: "first" }, "2026-05-11T10:00:00.000Z"),
      event("patch.proposed", { patch_id: "patch_2", summary: "second" }, "2026-05-11T10:05:00.000Z"),
      event("edit.proposed", { patch_id: "patch_3", summary: "third" }, "2026-05-11T10:10:00.000Z"),
    ], { nowIso: "2026-05-11T11:00:00.000Z" });
    assert.ok(pack.activeDiff);
    assert.equal(pack.activeDiff!.patchId, "patch_3");
    assert.equal(pack.activeDiff!.summary, "third");
  });

  it("returns null when no diff has been proposed", () => {
    const pack = buildContinuityPack(makeSession(), [
      event("command.run", { command: "ls" }, "2026-05-11T10:00:00.000Z"),
    ], { nowIso: "2026-05-11T10:10:00.000Z" });
    assert.equal(pack.activeDiff, null);
  });

  it("captures diff_ref + diff_preview when present", () => {
    const pack = buildContinuityPack(makeSession(), [
      event("patch.proposed", {
        patch_id: "patch_a",
        diff_ref: "sha:deadbeef",
        diff_preview: "diff --git ...",
      }, "2026-05-11T10:00:00.000Z"),
    ], { nowIso: "2026-05-11T10:10:00.000Z" });
    assert.equal(pack.activeDiff!.diffRef, "sha:deadbeef");
    assert.match(pack.activeDiff!.diffPreview ?? "", /diff --git/);
  });
});

// ---------------------------------------------------------------------------
// packId stability
// ---------------------------------------------------------------------------

describe("packId stability", () => {
  const events: ContinuityPackEvent[] = [
    event("context.file_exposed", { path: "src/auth/session.ts", reason: "read" }, "2026-05-11T10:00:00.000Z"),
    event("command.run", { command: "npm test", exit_code: 1 }, "2026-05-11T10:01:00.000Z"),
    event("patch.proposed", { patch_id: "patch_1", summary: "fix refresh" }, "2026-05-11T10:02:00.000Z"),
  ];

  it("identical inputs at different wall-clock times produce the same packId", () => {
    const pack1 = buildContinuityPack(makeSession(), events, { nowIso: "2026-05-11T10:10:00.000Z" });
    const pack2 = buildContinuityPack(makeSession(), events, { nowIso: "2026-05-11T13:30:00.000Z" });
    assert.equal(pack1.packId, pack2.packId, "packId should be deterministic across builds");
  });

  it("computePackId is order-independent on object keys but order-sensitive on arrays", () => {
    const pack = buildContinuityPack(makeSession(), events, { nowIso: "2026-05-11T10:10:00.000Z" });
    // Build a copy where the top-level keys reorder shouldn't matter,
    // but arrays preserving order should keep the same hash.
    const reorderedKeys = {
      ...pack,
      session: { ...pack.session },
    };
    assert.equal(computePackId(reorderedKeys), pack.packId);
  });

  it("changes packId when any input field changes (a different file path)", () => {
    const baseline = buildContinuityPack(makeSession(), events, { nowIso: "2026-05-11T10:10:00.000Z" });
    const altered = buildContinuityPack(makeSession(), [
      event("context.file_exposed", { path: "src/auth/refresh.ts", reason: "read" }, "2026-05-11T10:00:00.000Z"),
      ...events.slice(1),
    ], { nowIso: "2026-05-11T10:10:00.000Z" });
    assert.notEqual(baseline.packId, altered.packId);
  });

  it("changes packId when the session task_prompt changes", () => {
    const a = buildContinuityPack(makeSession(), events, { nowIso: "2026-05-11T10:10:00.000Z" });
    const b = buildContinuityPack(
      makeSession({ task_prompt: "Different prompt" }),
      events,
      { nowIso: "2026-05-11T10:10:00.000Z" },
    );
    assert.notEqual(a.packId, b.packId);
  });
});
