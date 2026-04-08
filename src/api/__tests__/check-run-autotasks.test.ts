import assert from "node:assert/strict";
import test from "node:test";

import type { Task } from "../db.js";
import type { RepoCheckRunEvent } from "../repo-workflow.js";
import {
  buildFailedCheckRunTaskDescription,
  buildFailedCheckRunTaskTitle,
  buildFailedCheckRunTaskWorkflowArtifacts,
  isFailedCheckRunEvent,
  mergeFailedCheckRunTaskWorkflowArtifacts,
  shouldReopenTaskForFailedCheckRun,
} from "../check-run-autotasks.js";

function buildCheckRunEvent(
  overrides: Partial<RepoCheckRunEvent["checkRun"]> = {}
): RepoCheckRunEvent {
  const suiteId =
    Object.prototype.hasOwnProperty.call(overrides, "suiteId") ? overrides.suiteId : 77;
  const conclusion =
    Object.prototype.hasOwnProperty.call(overrides, "conclusion")
      ? overrides.conclusion
      : "failure";

  return {
    provider: "github",
    action: "completed",
    repositoryFullName: "brosincode/letagents",
    senderLogin: "github-actions[bot]",
    kind: "check_run",
    checkRun: {
      id: overrides.id ?? "9001",
      suiteId,
      name: overrides.name ?? "ci / build",
      status: overrides.status ?? "completed",
      conclusion,
      url: overrides.url ?? "https://github.com/BrosInCode/letagents/actions/runs/9001",
      appName: overrides.appName ?? "GitHub Actions",
    },
  };
}

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "task_61",
    room_id: overrides.room_id ?? "github.com/brosincode/letagents",
    title: overrides.title ?? "Fix CI: ci / build",
    description: overrides.description ?? null,
    status: overrides.status ?? "done",
    assignee: overrides.assignee ?? "MapleRidge | EmmyMay's agent | Agent",
    created_by: overrides.created_by ?? "letagents",
    source_message_id: overrides.source_message_id ?? null,
    pr_url: overrides.pr_url ?? null,
    workflow_artifacts: overrides.workflow_artifacts ?? [],
    workflow_refs: overrides.workflow_refs ?? [],
    created_at: overrides.created_at ?? "2026-04-08T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-08T00:00:00.000Z",
  };
}

test("isFailedCheckRunEvent is narrow to completed failures", () => {
  assert.equal(isFailedCheckRunEvent(buildCheckRunEvent()), true);
  assert.equal(
    isFailedCheckRunEvent(buildCheckRunEvent({ conclusion: "success" })),
    false
  );
  assert.equal(
    isFailedCheckRunEvent(buildCheckRunEvent({ status: "queued", conclusion: null })),
    false
  );
});

test("buildFailedCheckRunTaskTitle and description describe the failing check", () => {
  const event = buildCheckRunEvent();

  assert.equal(buildFailedCheckRunTaskTitle(event), "Fix CI: ci / build");
  assert.match(
    buildFailedCheckRunTaskDescription(event),
    /Auto-created from a failed GitHub check run/
  );
  assert.match(buildFailedCheckRunTaskDescription(event), /GitHub Actions/);
});

test("buildFailedCheckRunTaskWorkflowArtifacts includes both suite and latest run identifiers", () => {
  const artifacts = buildFailedCheckRunTaskWorkflowArtifacts(buildCheckRunEvent());

  assert.deepEqual(artifacts, [
    {
      provider: "github",
      kind: "check_run",
      number: 77,
      title: "ci / build",
      state: "failure",
    },
    {
      provider: "github",
      kind: "check_run",
      id: "9001",
      title: "ci / build",
      url: "https://github.com/BrosInCode/letagents/actions/runs/9001",
      state: "failure",
    },
  ]);
});

test("mergeFailedCheckRunTaskWorkflowArtifacts deduplicates repeated suite and run artifacts", () => {
  const event = buildCheckRunEvent();
  const merged = mergeFailedCheckRunTaskWorkflowArtifacts(
    buildFailedCheckRunTaskWorkflowArtifacts(event),
    event
  );

  assert.deepEqual(merged, buildFailedCheckRunTaskWorkflowArtifacts(event));
});

test("shouldReopenTaskForFailedCheckRun only reopens closed tasks", () => {
  assert.equal(shouldReopenTaskForFailedCheckRun(buildTask({ status: "done" })), true);
  assert.equal(shouldReopenTaskForFailedCheckRun(buildTask({ status: "merged" })), true);
  assert.equal(
    shouldReopenTaskForFailedCheckRun(buildTask({ status: "cancelled" })),
    true
  );
  assert.equal(
    shouldReopenTaskForFailedCheckRun(buildTask({ status: "in_progress" })),
    false
  );
});
