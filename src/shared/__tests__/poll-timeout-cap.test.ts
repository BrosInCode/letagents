import assert from "node:assert/strict";
import test from "node:test";

import { getPollTimeoutCapMs, getWaitTimeoutCapMs, REMOTE_MCP_WAIT_MAX_MS } from "../poll-timeout-cap.js";

test("a remote wait_for_messages is capped at 30 s; stdio keeps the server cap", () => {
  const previous = process.env.LETAGENTS_POLL_MAX_MS;
  try {
    delete process.env.LETAGENTS_POLL_MAX_MS;
    assert.equal(getPollTimeoutCapMs(), 180_000);
    assert.equal(getWaitTimeoutCapMs(false), 180_000);
    assert.equal(getWaitTimeoutCapMs(true), REMOTE_MCP_WAIT_MAX_MS);
    assert.equal(REMOTE_MCP_WAIT_MAX_MS, 30_000);

    process.env.LETAGENTS_POLL_MAX_MS = "1500";
    assert.equal(getWaitTimeoutCapMs(false), 1500, "a lower server cap applies to both");
    assert.equal(getWaitTimeoutCapMs(true), 1500);

    process.env.LETAGENTS_POLL_MAX_MS = "36000000";
    assert.equal(getWaitTimeoutCapMs(false), 36_000_000);
    assert.equal(getWaitTimeoutCapMs(true), 30_000, "a raised server cap never raises the remote bound");
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_POLL_MAX_MS;
    else process.env.LETAGENTS_POLL_MAX_MS = previous;
  }
});
