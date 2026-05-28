import assert from "node:assert/strict";
import test from "node:test";

import { databaseTestOptions, dbApi } from "./harness.js";

test(
  "createTaskLease expires stale active leases before inserting a replacement lease",
  databaseTestOptions,
  async () => {
    const { createProjectWithName, createTask, createTaskLease, getActiveTaskLeases } =
      dbApi;
    if (!createProjectWithName || !createTask || !createTaskLease || !getActiveTaskLeases) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const now = Date.now();
    const expiredAt = new Date(now - 60_000).toISOString();
    const replacementExpiresAt = new Date(now + 60 * 60_000).toISOString();

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const task = await createTask(room.id, "Lease expiry coverage", "StoneCloud");

    const expired = await createTaskLease({
      room_id: room.id,
      task_id: task.id,
      kind: "work",
      agent_key: "EmmyMay/bayotter",
      agent_instance_id: "instance:old",
      actor_label: "BayOtter | EmmyMay's agent | Agent",
      created_by: "StoneCloud | EmmyMay's agent | Agent",
      expires_at: expiredAt,
    });

    const replacement = await createTaskLease({
      room_id: room.id,
      task_id: task.id,
      kind: "work",
      agent_key: "EmmyMay/stonecloud",
      agent_instance_id: "instance:new",
      actor_label: "StoneCloud | EmmyMay's agent | Agent",
      created_by: "StoneCloud | EmmyMay's agent | Agent",
      expires_at: replacementExpiresAt,
    });

    const activeLeases = await getActiveTaskLeases(room.id, task.id);
    assert.equal(activeLeases.length, 1);
    assert.equal(activeLeases[0].id, replacement.id);
    assert.notEqual(activeLeases[0].id, expired.id);
  },
);
