import assert from "node:assert/strict";
import test from "node:test";

import {
  managedAgentFailure,
  managedAgentFailureRoomMessage,
} from "../main/agents/managed-agent-failures.js";

test("quota errors are non-retryable and safe for room display", () => {
  const failure = managedAgentFailure({
    error: "You've hit your usage limit. Set a Spend Limit to continue.",
    eventId: "msg_1",
    occurredAt: "2026-07-11T00:05:16.000Z",
  });
  assert.equal(failure.code, "quota_exhausted");
  assert.equal(failure.retryable, false);
  assert.equal(failure.eventId, "msg_1");
  assert.doesNotMatch(failure.message, /7\/30|raw|Spend Limit/);
  assert.match(managedAgentFailureRoomMessage({ displayName: "Cursor", failure }), /Cursor could not reply/);
});

test("unexpected provider errors remain retryable", () => {
  const failure = managedAgentFailure({
    error: "socket closed unexpectedly",
    occurredAt: "2026-07-11T00:05:16.000Z",
  });
  assert.equal(failure.code, "provider_error");
  assert.equal(failure.retryable, true);
});

test("transient throttling and context limits do not permanently block the agent", () => {
  for (const error of [
    "rate limit exceeded; retry after 2 seconds",
    "429 Too Many Requests",
    "token limit exceeded for this context",
  ]) {
    const failure = managedAgentFailure({
      error,
      occurredAt: "2026-07-11T00:05:16.000Z",
    });
    assert.equal(failure.code, "provider_error", error);
    assert.equal(failure.retryable, true, error);
  }
});
