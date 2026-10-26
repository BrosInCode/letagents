import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempDir = mkdtempSync(join(tmpdir(), "letagents-liveness-registration-"));
process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
const { getSessionLivenessRegistration } = await import("../server/runtime/identity/liveness.js");

test.after(() => rmSync(tempDir, { recursive: true, force: true }));

test("every npm-package session reports its own activity, Codex included, since 0.12.46 removed the Codex stream", () => {
  for (const runtime of ["codex", "Codex", "claude-code", "antigravity"]) {
    assert.equal(getSessionLivenessRegistration(runtime).liveness_capability, "session_activity", runtime);
  }
});
