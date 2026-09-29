import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskUpdatePatch,
  evaluateTaskOwnership,
  getTaskOwnershipError,
  normalizeTaskActorKey,
  normalizeTaskActorLabel,
  requiresTaskOwnershipGuard,
  TASK_TITLE_MAX_LENGTH,
  TASK_DESCRIPTION_MAX_LENGTH,
} from "../tasks/ownership.js";

test("content patches trim titles, preserve Markdown, and distinguish clearing from omission", () => {
  const description = "# Plan\n\n- [ ] Ship\n\n```ts\nconst x = 1;\n```\n";
  assert.deepEqual(buildTaskUpdatePatch({ body: { title: "  New title  ", description } }).updates,
    { title: "New title", description });
  assert.deepEqual(buildTaskUpdatePatch({ body: { description: "" } }).updates, { description: "" });
  assert.deepEqual(buildTaskUpdatePatch({ body: { status: "accepted" } }).updates, { status: "accepted" });
  assert.equal(buildTaskUpdatePatch({ body: { title: "x".repeat(TASK_TITLE_MAX_LENGTH),
    description: "x".repeat(TASK_DESCRIPTION_MAX_LENGTH) } }).updates.description?.length, TASK_DESCRIPTION_MAX_LENGTH);
});

test("content patches reject blank titles, nonstrings, null and oversized values", () => {
  for (const body of [
    { title: "" }, { title: " \n " }, { title: null }, { title: 42 }, { title: {} },
    { title: "x".repeat(TASK_TITLE_MAX_LENGTH + 1) },
    { description: null }, { description: 42 }, { description: [] },
    { description: "x".repeat(TASK_DESCRIPTION_MAX_LENGTH + 1) },
  ]) {
    assert.throws(() => buildTaskUpdatePatch({ body }), { name: "RequestValidationError" });
  }
});

test("expected content matches exactly the edited fields and preserves original strings", () => {
  const patch = buildTaskUpdatePatch({ body: { title: "  Next  ", description: "",
    expected_content: { title: " Original ", description: "# Body\n" } } }).updates;
  assert.deepEqual(patch, { title: "Next", description: "",
    expected_content: { title: " Original ", description: "# Body\n" } });
  for (const body of [
    { title: "Next", expected_content: null }, { title: "Next", expected_content: [] },
    { title: "Next", expected_content: "Original" }, { title: "Next", expected_content: {} },
    { title: "Next", expected_content: { title: null } },
    { title: "Next", expected_content: { description: "Body" } },
    { title: "Next", description: "Body", expected_content: { title: "Original" } },
    { title: "Next", expected_content: { title: "Original", description: "Body" } },
    { title: "Next", expected_content: { title: "Original", status: "accepted" } },
    { status: "accepted", expected_content: { title: "Original" } },
  ]) {
    assert.throws(() => buildTaskUpdatePatch({ body }), /expected_content/);
  }
});

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
    actorKey: null,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(result.updates, "assignee"), false);
});

test("buildTaskUpdatePatch includes explicit assignee key updates", () => {
  const result = buildTaskUpdatePatch({
    body: {
      status: "assigned",
      assignee: "  MapleRidge | EmmyMay's agent | Agent  ",
      assignee_agent_key: "  EmmyMay/mapleridge  ",
      actor_label: "  MapleRidge | EmmyMay's agent | Agent  ",
      actor_key: "  EmmyMay/mapleridge  ",
    },
  });

  assert.deepEqual(result, {
    updates: {
      status: "assigned",
      assignee: "MapleRidge | EmmyMay's agent | Agent",
      assignee_agent_key: "EmmyMay/mapleridge",
    },
    actorLabel: "MapleRidge | EmmyMay's agent | Agent",
    actorKey: "EmmyMay/mapleridge",
  });
});

test("normalizeTaskActorKey trims valid agent keys", () => {
  assert.equal(normalizeTaskActorKey("  EmmyMay/gardenfern  "), "EmmyMay/gardenfern");
  assert.equal(normalizeTaskActorKey("   "), null);
});

test("normalizeTaskActorLabel trims valid actor labels", () => {
  assert.equal(
    normalizeTaskActorLabel("  GardenFern | EmmyMay's agent | Agent  "),
    "GardenFern | EmmyMay's agent | Agent"
  );
  assert.equal(normalizeTaskActorLabel("   "), null);
});

test("requiresTaskOwnershipGuard covers agent claim and reassignment paths", () => {
  assert.equal(
    requiresTaskOwnershipGuard({
      authKind: "owner_token",
      requestedStatus: "in_progress",
    }),
    true
  );
  assert.equal(
    requiresTaskOwnershipGuard({
      authKind: "owner_token",
      requestedAssignee: "MapleRidge | EmmyMay's agent | Agent",
    }),
    true
  );
  assert.equal(
    requiresTaskOwnershipGuard({
      authKind: "session",
      requestedStatus: "in_progress",
    }),
    false
  );
});

test("getTaskOwnershipError requires actor_key for owner-token active transitions", () => {
  assert.equal(
    getTaskOwnershipError({
      authKind: "owner_token",
      currentStatus: "assigned",
      currentAssignee: "GardenFern | EmmyMay's agent | Agent",
      currentAssigneeAgentKey: "EmmyMay/gardenfern",
      requestedStatus: "in_progress",
      actorLabel: "GardenFern | EmmyMay's agent | Agent",
      actorKey: null,
    }),
    "actor_key is required for agent-owned task transitions"
  );
});

test("getTaskOwnershipError rejects claiming a task for a different agent", () => {
  assert.equal(
    getTaskOwnershipError({
      authKind: "owner_token",
      currentStatus: "accepted",
      currentAssignee: null,
      currentAssigneeAgentKey: null,
      requestedStatus: "assigned",
      requestedAssignee: "SolarVista | EmmyMay's agent | Agent",
      requestedAssigneeAgentKey: "EmmyMay/solarvista",
      actorLabel: "GardenFern | EmmyMay's agent | Agent",
      actorKey: "EmmyMay/gardenfern",
    }),
    "Agents can only claim tasks for themselves"
  );
});

test("getTaskOwnershipError rejects assignee-only steals", () => {
  assert.equal(
    getTaskOwnershipError({
      authKind: "owner_token",
      currentStatus: "assigned",
      currentAssignee: "MapleRidge | EmmyMay's agent | Agent",
      currentAssigneeAgentKey: "EmmyMay/mapleridge",
      requestedAssignee: "GardenFern | EmmyMay's agent | Agent",
      requestedAssigneeAgentKey: "EmmyMay/gardenfern",
      actorLabel: "GardenFern | EmmyMay's agent | Agent",
      actorKey: "EmmyMay/gardenfern",
    }),
    "Agents cannot reassign a task after claim"
  );
});

test("getTaskOwnershipError rejects spoofed labels when agent keys differ", () => {
  assert.equal(
    getTaskOwnershipError({
      authKind: "owner_token",
      currentStatus: "assigned",
      currentAssignee: "GardenFern | EmmyMay's agent | Agent",
      currentAssigneeAgentKey: "EmmyMay/mapleridge",
      requestedStatus: "in_review",
      actorLabel: "GardenFern | EmmyMay's agent | Agent",
      actorKey: "EmmyMay/gardenfern",
    }),
    "Only the assigned agent can move this task to in_review"
  );
});

test("evaluateTaskOwnership backfills missing assignee agent keys for existing tasks", () => {
  assert.deepEqual(
    evaluateTaskOwnership({
      authKind: "owner_token",
      currentStatus: "assigned",
      currentAssignee: "GardenFern | EmmyMay's agent | Agent",
      currentAssigneeAgentKey: null,
      requestedStatus: "in_progress",
      actorLabel: "GardenFern | EmmyMay's agent | Agent",
      actorKey: "EmmyMay/gardenfern",
    }),
    {
      kind: "allow",
      assigneeAgentKey: "EmmyMay/gardenfern",
    }
  );
});

test("evaluateTaskOwnership allows the assigned agent to advance its task by key", () => {
  assert.deepEqual(
    evaluateTaskOwnership({
      authKind: "owner_token",
      currentStatus: "assigned",
      currentAssignee: "GardenFern | EmmyMay's agent | Agent",
      currentAssigneeAgentKey: "EmmyMay/gardenfern",
      requestedStatus: "in_progress",
      actorLabel: "GardenFern | EmmyMay's agent | Agent",
      actorKey: "EmmyMay/gardenfern",
    }),
    {
      kind: "allow",
    }
  );
});
