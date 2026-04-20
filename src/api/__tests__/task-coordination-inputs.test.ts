import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTaskCoordinationMutation,
  getTaskUpdatePrUrlBinding,
  normalizeOptionalString,
} from "../task-coordination-inputs.js";

test("normalizeOptionalString trims non-empty strings and normalizes other values", () => {
  assert.equal(normalizeOptionalString(" value "), "value");
  assert.equal(normalizeOptionalString("   "), null);
  assert.equal(normalizeOptionalString(null), null);
  assert.equal(normalizeOptionalString(42), null);
});

test("classifyTaskCoordinationMutation classifies lifecycle mutations in priority order", () => {
  assert.deepEqual(classifyTaskCoordinationMutation({ status: "assigned" }), {
    mutation: "task_claim",
    leaseKind: "work",
    claim: true,
  });
  assert.deepEqual(classifyTaskCoordinationMutation({ status: "in_review" }), {
    mutation: "task_complete",
    leaseKind: "work",
    claim: false,
  });
  assert.deepEqual(
    classifyTaskCoordinationMutation({ status: "assigned", pr_url: "https://example.test/pr/1" }),
    {
      mutation: "task_claim",
      leaseKind: "work",
      claim: true,
    }
  );
});

test("classifyTaskCoordinationMutation classifies workflow artifacts before general updates", () => {
  assert.deepEqual(
    classifyTaskCoordinationMutation({ status: "in_progress", pr_url: null }),
    {
      mutation: "workflow_artifact_attach",
      leaseKind: "work",
      claim: false,
    }
  );
  assert.deepEqual(
    classifyTaskCoordinationMutation({ workflow_artifacts: [] }),
    {
      mutation: "workflow_artifact_attach",
      leaseKind: "work",
      claim: false,
    }
  );
  assert.deepEqual(classifyTaskCoordinationMutation({ status: "blocked" }), {
    mutation: "task_update",
    leaseKind: "work",
    claim: false,
  });
  assert.equal(classifyTaskCoordinationMutation({ status: "done" }), null);
});

test("getTaskUpdatePrUrlBinding distinguishes absent, null, and string bindings", () => {
  assert.equal(getTaskUpdatePrUrlBinding({}), undefined);
  assert.equal(getTaskUpdatePrUrlBinding({ pr_url: null }), null);
  assert.equal(getTaskUpdatePrUrlBinding({ pr_url: undefined }), null);
  assert.equal(
    getTaskUpdatePrUrlBinding({ pr_url: "https://github.com/BrosInCode/letagents/pull/253" }),
    "https://github.com/BrosInCode/letagents/pull/253"
  );
});
