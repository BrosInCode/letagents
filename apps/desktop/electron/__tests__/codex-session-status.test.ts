import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({ prefix: "letagents-codex-session-status-", paths: [] });

const {
  extractThreadStatus,
  extractTurnStatus,
  isActiveCodexTurnStatus,
} = await import("../main/agents/codex-session-status.js");

test("active Codex turn statuses are recognised so turns do not overlap", () => {
  for (const status of ["inProgress", "active", "running", "queued", "pending", "cancelling"]) {
    assert.equal(isActiveCodexTurnStatus(status), true);
  }
  assert.equal(isActiveCodexTurnStatus("  Running "), true);

  for (const status of ["completed", "interrupted", "failed", "", null, undefined]) {
    assert.equal(isActiveCodexTurnStatus(status), false);
  }
});

test("Codex turn status reads both the string and the object shape", () => {
  assert.equal(extractTurnStatus({ status: "inProgress" }), "inProgress");
  assert.equal(extractTurnStatus({ status: { status: "completed" } }), "completed");
  assert.equal(extractTurnStatus({ status: {} }), null);
  assert.equal(extractTurnStatus({}), null);
  assert.equal(extractTurnStatus(null), null);
  assert.equal(extractTurnStatus(undefined), null);
});

test("Codex thread status reads both the string and the typed shape", () => {
  assert.equal(extractThreadStatus({ status: "idle" }), "idle");
  assert.equal(extractThreadStatus({ status: { type: "active" } }), "active");
  assert.equal(extractThreadStatus({ status: {} }), null);
  assert.equal(extractThreadStatus({}), null);
  assert.equal(extractThreadStatus(undefined), null);
});
