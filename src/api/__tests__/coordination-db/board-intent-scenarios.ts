import assert from "node:assert/strict";
import test from "node:test";

import {
  databaseTestOptions,
  dbApi,
} from "./harness.js";

test(
  "board intents expire pending rows before queue reads",
  databaseTestOptions,
  async () => {
    const {
      countBoardIntents,
      createBoardIntent,
      createProjectWithName,
      verifyBoardIntentApproval,
    } = dbApi;
    if (
      !countBoardIntents ||
      !createBoardIntent ||
      !createProjectWithName ||
      !verifyBoardIntentApproval
    ) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const room = await createProjectWithName("board-intent-expiry");
    const payload = {
      task_id: "task_1",
      status: "assigned",
      assignee: "BayOtter",
      assignee_agent_key: "EmmyMay/bayotter",
      pr_url: null,
    };
    const intent = await createBoardIntent({
      room_id: room.id,
      action_type: "task_claim",
      payload,
      expires_at: "2000-01-01T00:00:00.000Z",
      now: new Date("2026-07-03T10:00:00.000Z"),
    });

    assert.equal(intent.status, "pending");
    assert.equal(await countBoardIntents({ room_id: room.id, status: "pending" }), 0);

    const expiredDecision = await verifyBoardIntentApproval({
      room_id: room.id,
      action_type: "task_claim",
      payload,
      intent_id: intent.id,
      approval_token: "unused",
      now: new Date("2026-07-03T10:00:01.000Z"),
    });
    assert.deepEqual(expiredDecision, {
      kind: "deny",
      code: "board_intent_expired",
      error: `Board intent ${intent.id} has expired.`,
    });
  },
);

test(
  "expired pending board intents cannot be denied",
  databaseTestOptions,
  async () => {
    const {
      createBoardIntent,
      createProjectWithName,
      denyBoardIntent,
      verifyBoardIntentApproval,
    } = dbApi;
    if (
      !createBoardIntent ||
      !createProjectWithName ||
      !denyBoardIntent ||
      !verifyBoardIntentApproval
    ) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const room = await createProjectWithName("board-intent-deny-expired");
    const payload = {
      task_id: "task_4",
      status: "assigned",
      assignee: "HarborLight",
      assignee_agent_key: "EmmyMay/harborlight",
      pr_url: null,
    };
    const intent = await createBoardIntent({
      room_id: room.id,
      action_type: "task_claim",
      payload,
      expires_at: "2000-01-01T00:00:00.000Z",
      now: new Date("2026-07-03T09:30:00.000Z"),
    });

    const denied = await denyBoardIntent({
      room_id: room.id,
      intent_id: intent.id,
      decision_by: "Board Manager",
      now: new Date("2026-07-03T10:00:00.000Z"),
    });
    assert.equal(denied, null);

    const expiredDecision = await verifyBoardIntentApproval({
      room_id: room.id,
      action_type: "task_claim",
      payload,
      intent_id: intent.id,
      approval_token: "unused",
      now: new Date("2026-07-03T10:00:01.000Z"),
    });
    assert.deepEqual(expiredDecision, {
      kind: "deny",
      code: "board_intent_expired",
      error: `Board intent ${intent.id} has expired.`,
    });
  },
);

test(
  "board intent approvals are consumed exactly once",
  databaseTestOptions,
  async () => {
    const {
      approveBoardIntent,
      consumeBoardIntentApproval,
      createBoardIntent,
      createProjectWithName,
    } = dbApi;
    if (
      !approveBoardIntent ||
      !consumeBoardIntentApproval ||
      !createBoardIntent ||
      !createProjectWithName
    ) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const room = await createProjectWithName("board-intent-consume-once");
    const payload = {
      task_id: "task_2",
      status: "assigned",
      assignee: "DawnWinter",
      assignee_agent_key: "EmmyMay/dawnwinter",
      pr_url: null,
    };
    const intent = await createBoardIntent({
      room_id: room.id,
      action_type: "task_claim",
      payload,
      now: new Date("2026-07-03T10:00:00.000Z"),
    });
    const approved = await approveBoardIntent({
      room_id: room.id,
      intent_id: intent.id,
      decision_by: "Board Manager",
      now: new Date("2026-07-03T10:01:00.000Z"),
    });
    assert.ok(approved);

    const firstDecision = await consumeBoardIntentApproval({
      room_id: room.id,
      action_type: "task_claim",
      payload,
      intent_id: intent.id,
      approval_token: approved.approval_token,
      now: new Date("2026-07-03T10:02:00.000Z"),
    });
    assert.equal(firstDecision.kind, "allow");

    const secondDecision = await consumeBoardIntentApproval({
      room_id: room.id,
      action_type: "task_claim",
      payload,
      intent_id: intent.id,
      approval_token: approved.approval_token,
      now: new Date("2026-07-03T10:03:00.000Z"),
    });
    assert.deepEqual(secondDecision, {
      kind: "deny",
      code: "board_intent_not_approved",
      error: `Board intent ${intent.id} is used, not approved.`,
    });
  },
);

test(
  "approved board intents deny consumption after approval expiry",
  databaseTestOptions,
  async () => {
    const {
      approveBoardIntent,
      consumeBoardIntentApproval,
      createBoardIntent,
      createProjectWithName,
    } = dbApi;
    if (
      !approveBoardIntent ||
      !consumeBoardIntentApproval ||
      !createBoardIntent ||
      !createProjectWithName
    ) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const room = await createProjectWithName("board-intent-approval-expiry");
    const payload = {
      task_id: "task_3",
      status: "done",
      assignee: null,
      assignee_agent_key: null,
      pr_url: null,
    };
    const intent = await createBoardIntent({
      room_id: room.id,
      action_type: "task_close",
      payload,
      now: new Date("2026-07-03T10:00:00.000Z"),
    });
    const approved = await approveBoardIntent({
      room_id: room.id,
      intent_id: intent.id,
      decision_by: "Board Manager",
      now: new Date("2026-07-03T10:01:00.000Z"),
    });
    assert.ok(approved);

    const decision = await consumeBoardIntentApproval({
      room_id: room.id,
      action_type: "task_close",
      payload,
      intent_id: intent.id,
      approval_token: approved.approval_token,
      now: new Date("2026-07-03T10:31:01.000Z"),
    });
    assert.deepEqual(decision, {
      kind: "deny",
      code: "board_intent_expired",
      error: `Board intent ${intent.id} approval has expired.`,
    });
  },
);
