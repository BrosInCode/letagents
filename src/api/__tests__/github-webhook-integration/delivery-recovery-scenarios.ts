import assert from "node:assert/strict";

import {
  createRepoRoom,
  pool,
  postGitHubWebhook,
  webhookIntegrationTest,
} from "./harness.js";
import { buildCheckRunPayload } from "./payloads.js";

webhookIntegrationTest(
  "a redelivery of a delivery a stopped process left 'received' is processed, not skipped",
  async (context) => {
    const { getTasks, port } = context;
    const room = await createRepoRoom(context);
    const deliveryId = "delivery-left-received-1";
    // The process that first took this delivery stopped before marking it.
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await pool!.query(
      `INSERT INTO github_webhook_deliveries (delivery_id, event_name, action, status, received_at, claimed_at, attempts)
       VALUES ($1, 'check_run', 'completed', 'received', $2, $2, 1)`,
      [deliveryId, startedAt],
    );

    const result = await postGitHubWebhook({
      port,
      deliveryId,
      eventName: "check_run",
      payload: buildCheckRunPayload({ id: 902, name: "ci / test", suiteId: 78 }),
    });
    assert.equal(result.duplicate, undefined);
    assert.equal(result.status, "processed");
    assert.equal((await getTasks(room.id)).tasks.length, 1, "the event reached the room");

    const stored = await pool!.query(
      "SELECT status, attempts, payload FROM github_webhook_deliveries WHERE delivery_id = $1",
      [deliveryId],
    );
    assert.equal(stored.rows[0].status, "processed");
    assert.equal(stored.rows[0].attempts, 2);
    assert.equal(stored.rows[0].payload, null, "the body is dropped once processed");

    const again = await postGitHubWebhook({
      port,
      deliveryId,
      eventName: "check_run",
      payload: buildCheckRunPayload({ id: 902, name: "ci / test", suiteId: 78 }),
    });
    assert.equal(again.duplicate, true, "a processed delivery stays a duplicate");
  }
);
