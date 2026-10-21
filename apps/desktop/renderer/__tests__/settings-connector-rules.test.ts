import assert from "node:assert/strict";
import test from "node:test";

import type { TrackerRuleInput } from "../../../../shared/ticket-connectors.mjs";
import {
  emptyRuleDraft,
  ruleDraftFrom,
  ruleFieldsFor,
  ruleInputFromDraft,
  ruleSummary,
} from "../src/components/desktop/settings/connector-rules.js";
import { auditResultText, readableAuditEvent } from "../src/components/desktop/content/room-board/governance-presentation.js";

const rule: TrackerRuleInput = {
  name: "Merged into main: Done",
  room_id: "room-billing",
  trigger: { event: "pull_request", action: "closed", merged: true, baseBranch: "main" },
  actions: [{ kind: "transition", toStatus: "Done" }, { kind: "comment", template: "Merged: {{pr_url}}" }],
};

test("a rule survives the editor unchanged", () => {
  const draft = ruleDraftFrom(rule, "trule_1");
  assert.equal(draft.id, "trule_1");
  assert.deepEqual(ruleInputFromDraft(draft), { ...rule, enabled: true });
});

test("the editor drops trigger fields that do not fit the event", () => {
  const draft = { ...emptyRuleDraft(), name: " Review ", event: "pull_request_review" as const, action: "submitted",
    merged: "true" as const, draft: "false" as const, reviewState: "approved", approvalsAtLeast: "2", conclusion: "failure" };
  assert.deepEqual(ruleInputFromDraft(draft).trigger, { event: "pull_request_review", action: "submitted", reviewState: "approved", approvalsAtLeast: 2 });
  assert.equal(ruleInputFromDraft(draft).name, "Review");
  assert.deepEqual(ruleFieldsFor("check_run", "completed"), {
    merged: false, draft: false, baseBranch: false, reviewState: false, approvalsAtLeast: false, conclusion: true,
  });
  assert.equal(ruleFieldsFor("pull_request", "opened").merged, false);
  assert.equal(ruleFieldsFor("pull_request", "closed").merged, true);
});

test("a rule reads as one line", () => {
  assert.equal(ruleSummary(rule), "Pull request closed, merged, into main → move to Done, comment");
});

test("a rule run reads in the governance audit with rule, event, card and outcome", () => {
  const entry = {
    id: "trun_1", kind: "tracker_rule_run" as const, eventType: "tracker_rule_run", actorLabel: "Rule: Opened",
    reason: null, createdAt: "2026-10-21T00:00:00.000Z",
    metadata: { rule_name: "Opened", event_type: "pull_request", event_action: "opened", task_id: "task_7", external_ref: "jira:HT-1234", outcome: "succeeded" },
  };
  assert.equal(readableAuditEvent(entry), "Rule \"Opened\" ran");
  assert.equal(auditResultText(entry), "On pull request opened for task_7 · jira:HT-1234: done.");
});
