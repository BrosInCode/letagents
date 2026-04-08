import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskUpdatePatch,
  getTaskOwnershipError,
  normalizeTaskActorLabel,
} from "../task-ownership.js";

test("buildTaskUpdatePatch preserves assignee when the field is omitted", () => {
  const result = buildTaskUpdatePatch({
    body: {
      status: "in_progress",
    },
  });

  assert.deepEqual(result, {
    updates: {
      status: "in_progress",
    },
    actorLabel: null,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(result.updates, "assignee"), false);
});

test("buildTaskUpdatePatch includes explicit assignee clears", () => {
  const result = buildTaskUpdatePatch({
    body: {
      status: "assigned",
      assignee: null,
      actor_label: "  MapleRidge | EmmyMay's agent | Agent  ",
    },
  });

  assert.deepEqual(result, {
    updates: {
      status: "assigned",
      assignee: null,
    },
    actorLabel: "MapleRidge | EmmyMay's agent | Agent",
  });
});

test("normalizeTaskActorLabel trims valid actor labels", () => {
  assert.equal(
    normalizeTaskActorLabel("  GardenFern | EmmyMay's agent | Agent  "),
    "GardenFern | EmmyMay's agent | Agent"
  );
  assert.equal(normalizeTaskActorLabel("   "), null);
});

test("getTaskOwnershipError requires actor_label for owner-token active transitions", () => {
  assert.equal(
    getTaskOwnershipError({
      authKind: "owner_token",
      currentStatus: "assigned",
      currentAssignee: "GardenFern | EmmyMay's agent | Agent",
      requestedStatus: "in_progress",
      actorLabel: null,
    }),
    "actor_label is required for agent-owned task transitions"
  );
});

test("getTaskOwnershipError rejects claiming a task for a different agent", () => {
  assert.equal(
    getTaskOwnershipError({
      authKind: "owner_token",
      currentStatus: "accepted",
      currentAssignee: null,
      requestedStatus: "assigned",
      requestedAssignee: "SolarVista | EmmyMay's agent | Agent",
      actorLabel: "GardenFern | EmmyMay's agent | Agent",
    }),
    "Agents can only claim tasks for themselves"
  );
});

test("getTaskOwnershipError rejects advancing another agent's task", () => {
  assert.equal(
    getTaskOwnershipError({
      authKind: "owner_token",
      currentStatus: "assigned",
      currentAssignee: "SolarVista | EmmyMay's agent | Agent",
      requestedStatus: "in_review",
      actorLabel: "GardenFern | EmmyMay's agent | Agent",
    }),
    "Only the assigned agent can move this task to in_review"
  );
});

test("getTaskOwnershipError allows the assigned agent to advance its task", () => {
  assert.equal(
    getTaskOwnershipError({
      authKind: "owner_token",
      currentStatus: "assigned",
      currentAssignee: "GardenFern | EmmyMay's agent | Agent",
      requestedStatus: "in_progress",
      actorLabel: "GardenFern | EmmyMay's agent | Agent",
    }),
    null
  );
});
