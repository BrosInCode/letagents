import assert from "node:assert/strict";
import test from "node:test";

import type { TaskStatus } from "../db.js";
import { formatTaskLifecycleStatus } from "../task-lifecycle-status.js";

function statusMessage(input: {
  status: TaskStatus;
  assignee?: string | null;
}): string {
  return formatTaskLifecycleStatus({
    id: "task_1",
    title: "Ship the thing",
    status: input.status,
    assignee: input.assignee ?? null,
  });
}

test("formatTaskLifecycleStatus includes primary assignee labels for claimed work", () => {
  assert.equal(
    statusMessage({
      status: "assigned",
      assignee: "GardenFern | EmmyMay's agent | Agent",
    }),
    "[status] GardenFern claimed task_1: Ship the thing"
  );
  assert.equal(
    statusMessage({
      status: "in_progress",
      assignee: "GardenFern | EmmyMay's agent | Agent",
    }),
    "[status] GardenFern is working on task_1: Ship the thing"
  );
});

test("formatTaskLifecycleStatus falls back when no assignee label is available", () => {
  assert.equal(
    statusMessage({ status: "assigned" }),
    "[status] task_1 moved to assigned: Ship the thing"
  );
  assert.equal(
    statusMessage({ status: "in_progress" }),
    "[status] task_1 is in progress: Ship the thing"
  );
});

test("formatTaskLifecycleStatus formats terminal and review states", () => {
  assert.equal(
    statusMessage({ status: "blocked" }),
    "[status] task_1 is blocked: Ship the thing"
  );
  assert.equal(
    statusMessage({ status: "in_review" }),
    "[status] task_1 is in review: Ship the thing"
  );
  assert.equal(
    statusMessage({ status: "merged" }),
    "[status] task_1 was merged: Ship the thing"
  );
  assert.equal(
    statusMessage({ status: "done" }),
    "[status] task_1 is done: Ship the thing"
  );
  assert.equal(
    statusMessage({ status: "cancelled" }),
    "[status] task_1 was cancelled: Ship the thing"
  );
});

test("formatTaskLifecycleStatus preserves default status fallback", () => {
  assert.equal(
    statusMessage({ status: "custom_state" as TaskStatus }),
    "[status] task_1 moved to custom_state: Ship the thing"
  );
});
