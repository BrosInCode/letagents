import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskUpdatePatch,
  evaluateTaskOwnership,
  getTaskOwnershipError,
  inferTaskActorKeyFromOwnerAgents,
  normalizeTaskActorKey,
  normalizeTaskActorLabel,
  requiresTaskOwnershipGuard,
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

test("inferTaskActorKeyFromOwnerAgents resolves a unique actor label match", () => {
  assert.equal(
    inferTaskActorKeyFromOwnerAgents({
      actorLabel: "Garden Fern | EmmyMay's agent | Agent",
      ownerAgents: [
        {
          canonical_key: "EmmyMay/garden-fern",
          name: "garden-fern",
          display_name: "Garden Fern",
          owner_label: "EmmyMay",
        },
      ],
    }),
    "EmmyMay/garden-fern"
  );
});

test("inferTaskActorKeyFromOwnerAgents returns null for ambiguous actor labels", () => {
  assert.equal(
    inferTaskActorKeyFromOwnerAgents({
      actorLabel: "Garden Fern | EmmyMay's agent | Agent",
      ownerAgents: [
        {
          canonical_key: "EmmyMay/garden-fern",
          name: "garden-fern",
          display_name: "Garden Fern",
          owner_label: "EmmyMay",
        },
        {
          canonical_key: "EmmyMay/garden-fern-2",
          name: "garden-fern-2",
          display_name: "Garden Fern",
          owner_label: "EmmyMay",
        },
      ],
    }),
    null
  );
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
