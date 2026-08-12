import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyReasoningStream } from "../src/domain/reasoning";

describe("classifyReasoningStream", () => {
  it("treats an explicit blocked status as authoritative over the Codex reasoning-summary heuristic", () => {
    // Regression: a blocked session whose text trips the Codex heuristic used to
    // classify as "live" and render the green "Live thinking" state around a Blocker.
    const result = classifyReasoningStream({
      status: "blocked",
      summary: "Readable reasoning summary — stuck waiting on a credential",
    });
    assert.equal(result.state, "blocked");
    assert.equal(result.label, "Blocked");
    assert.equal(result.description, "Blocked");
  });

  it("blocked also outranks the Codex snapshot heuristic", () => {
    const result = classifyReasoningStream({
      status: "blocked",
      summary: "snapshot-derived from codex_app_server",
    });
    assert.equal(result.state, "blocked");
    assert.equal(result.label, "Blocked");
  });

  it("classifies a working Codex reasoning-summary stream as live", () => {
    const result = classifyReasoningStream({
      status: "working",
      summary: "reasoning summary — exploring the failing test",
    });
    assert.equal(result.state, "live");
    assert.equal(result.label, "Live thinking");
    assert.equal(result.description, "Readable Codex reasoning summary stream");
    assert.equal(result.isCodexReasoningSummary, true);
  });

  it("infers live thinking from Codex text even without a status", () => {
    const result = classifyReasoningStream({ status: "", summary: "readable reasoning trace" });
    assert.equal(result.state, "live");
    assert.equal(result.label, "Live thinking");
  });

  it("classifies a Codex snapshot when text matches and the status is not active or blocked", () => {
    const result = classifyReasoningStream({ status: "", summary: "app-server snapshot" });
    assert.equal(result.state, "snapshot");
    assert.equal(result.label, "Snapshot");
    assert.equal(result.description, "Codex app-server snapshot");
  });

  it("maps working / reviewing statuses to live with a titleized label", () => {
    assert.equal(classifyReasoningStream({ status: "working" }).state, "live");
    assert.equal(classifyReasoningStream({ status: "working" }).label, "Working");
    assert.equal(classifyReasoningStream({ status: "reviewing" }).state, "live");
  });

  it("falls back to recent / Reasoning for unknown or empty state", () => {
    const empty = classifyReasoningStream({ status: "" });
    assert.equal(empty.state, "recent");
    assert.equal(empty.label, "Reasoning");
    const done = classifyReasoningStream({ status: "done" });
    assert.equal(done.state, "recent");
    assert.equal(done.label, "Done");
  });

  it("maps idle (the enum's fourth status) to recent, but still infers live from Codex text", () => {
    assert.equal(classifyReasoningStream({ status: "idle" }).state, "recent");
    assert.equal(classifyReasoningStream({ status: "idle" }).label, "Idle");
    // idle is not a contradicting state like blocked, so heuristic text still promotes to live.
    assert.equal(classifyReasoningStream({ status: "idle", summary: "reasoning summary" }).state, "live");
  });

  it("titleizes multi-word / underscored statuses", () => {
    assert.equal(classifyReasoningStream({ status: "in_review" }).label, "In Review");
  });

  describe("staleness decay", () => {
    const base = 1_000_000_000_000; // fixed clock (ms) so the tests never touch the wall clock
    const at = (ms: number) => new Date(ms).toISOString();

    it("keeps a fresh heuristic-derived live stream live", () => {
      const result = classifyReasoningStream({
        summary: "readable reasoning trace",
        updatedAt: at(base),
        now: base + 10_000,
      });
      assert.equal(result.state, "live");
      assert.equal(result.label, "Live thinking");
    });

    it("decays a stale heuristic-derived live stream to recent / Stale (not Idle)", () => {
      const result = classifyReasoningStream({
        summary: "readable reasoning trace",
        updatedAt: at(base),
        now: base + 300_000,
      });
      assert.equal(result.state, "recent");
      assert.equal(result.label, "Stale");
      assert.equal(result.description, "No reasoning updates recently");
    });

    it("decays a stale working stream too (worker died mid-run)", () => {
      const result = classifyReasoningStream({
        status: "working",
        updatedAt: at(base),
        now: base + 300_000,
      });
      assert.equal(result.state, "recent");
      assert.equal(result.label, "Stale");
    });

    it("never decays blocked, even when very stale", () => {
      const result = classifyReasoningStream({
        status: "blocked",
        summary: "reasoning summary",
        updatedAt: at(base),
        now: base + 10_000_000,
      });
      assert.equal(result.state, "blocked");
      assert.equal(result.label, "Blocked");
    });

    it("does not decay non-live states (a stale snapshot stays a snapshot)", () => {
      const result = classifyReasoningStream({
        summary: "app-server snapshot",
        updatedAt: at(base),
        now: base + 10_000_000,
      });
      assert.equal(result.state, "snapshot");
    });

    it("does not decay when no clock is supplied (backward compatible)", () => {
      const result = classifyReasoningStream({
        status: "working",
        summary: "reasoning summary",
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
      assert.equal(result.state, "live");
    });

    it("does not decay when updatedAt is missing or unparseable", () => {
      assert.equal(classifyReasoningStream({ status: "working", now: base }).state, "live");
      assert.equal(
        classifyReasoningStream({ status: "working", updatedAt: "not-a-date", now: base }).state,
        "live",
      );
    });

    it("respects a custom staleAfterMs threshold", () => {
      const result = classifyReasoningStream({
        status: "working",
        updatedAt: at(base),
        now: base + 5_000,
        staleAfterMs: 1_000,
      });
      assert.equal(result.state, "recent");
    });
  });
});
