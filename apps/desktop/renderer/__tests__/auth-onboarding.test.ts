import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isAuthSnapshotPending,
  isMembershipRefusal,
  joinAskedLabel,
  joinRetryLabel,
  resolveJoinCardState,
  nextRetryStep,
  resolveAuthCardState,
  retryDeadlineAt,
  retrySecondsLeft,
} from "../src/components/desktop/content/auth-onboarding";

test("auth snapshot stays pending through root and selected room loading", () => {
  assert.equal(isAuthSnapshotPending({ rootLoading: true, selectedLoading: false, hasSnapshot: false }), true);
  assert.equal(isAuthSnapshotPending({ rootLoading: false, selectedLoading: true, hasSnapshot: false }), true);
  assert.equal(isAuthSnapshotPending({ rootLoading: true, selectedLoading: true, hasSnapshot: true }), false);
  assert.equal(isAuthSnapshotPending({ rootLoading: false, selectedLoading: false, hasSnapshot: false }), false);
});

test("pending snapshots override provisional access errors", () => {
  assert.equal(resolveAuthCardState({
    snapshotPending: true,
    status: "unavailable",
    hasPendingAuth: false,
    authenticated: false,
  }), "loading");
});

test("auth card state follows access and device-flow state", () => {
  assert.equal(resolveAuthCardState({
    snapshotPending: false,
    status: "auth_required",
    hasPendingAuth: false,
    authenticated: false,
  }), "connect");
  assert.equal(resolveAuthCardState({
    snapshotPending: false,
    status: "auth_required",
    hasPendingAuth: true,
    authenticated: false,
  }), "code");
  assert.equal(resolveAuthCardState({
    snapshotPending: false,
    status: "auth_required",
    hasPendingAuth: false,
    authenticated: true,
  }), "connected");
  assert.equal(resolveAuthCardState({
    snapshotPending: false,
    status: "forbidden",
    hasPendingAuth: false,
    authenticated: true,
  }), "forbidden");
});

test("retry deadlines and steps clamp to the configured backoff", () => {
  const now = 1_000;
  assert.equal(retryDeadlineAt(now, -1), 9_000);
  assert.equal(retryDeadlineAt(now, 1), 16_000);
  assert.equal(retryDeadlineAt(now, 99), 31_000);
  assert.equal(nextRetryStep(0), 1);
  assert.equal(nextRetryStep(2), 2);
});

test("retry countdown uses absolute deadlines", () => {
  assert.equal(retrySecondsLeft(1_000, 0), null);
  assert.equal(retrySecondsLeft(1_000, 8_001), 8);
  assert.equal(retrySecondsLeft(9_000, 8_000), 0);
});

test("membership refusals get their own cards", () => {
  for (const [status, card] of [["membership_required", "membership"], ["repo_collaborator_required", "repo_collaborator"]] as const) {
    assert.equal(resolveAuthCardState({ snapshotPending: false, status, hasPendingAuth: false, authenticated: true }), card);
    assert.equal(isMembershipRefusal(status), true);
  }
  assert.equal(isMembershipRefusal("forbidden"), false);
  assert.equal(isMembershipRefusal("ready"), false);
});

test("the join card follows the latest request and its decline wait", () => {
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  const request = { id: "rjr_1", created_at: "2026-11-04T11:55:00.000Z", decided_at: null, retry_after: null };
  assert.deepEqual(resolveJoinCardState(null, now), { kind: "ask", declined: false });
  assert.deepEqual(resolveJoinCardState({ ...request, state: "cancelled" }, now), { kind: "ask", declined: false });
  assert.deepEqual(resolveJoinCardState({ ...request, state: "approved" }, now), { kind: "ask", declined: false });
  assert.deepEqual(resolveJoinCardState({ ...request, state: "pending" }, now),
    { kind: "pending", requestId: "rjr_1", askedAt: "2026-11-04T11:55:00.000Z" });
  assert.deepEqual(resolveJoinCardState({ ...request, state: "declined", retry_after: "2026-11-04T12:30:00.000Z" }, now),
    { kind: "declined", retryAt: Date.parse("2026-11-04T12:30:00.000Z") });
  assert.deepEqual(resolveJoinCardState({ ...request, state: "declined", retry_after: "2026-11-04T11:00:00.000Z" }, now),
    { kind: "ask", declined: true });
  assert.deepEqual(resolveJoinCardState({ ...request, state: "declined" }, now), { kind: "ask", declined: true });
  assert.equal(joinRetryLabel(now + 30 * 60_000, now), "in 30 min");
  assert.equal(joinRetryLabel(now + 3 * 60 * 60_000, now), "in 3 h");
  assert.match(joinRetryLabel(now + 20 * 60 * 60_000, now), /^(today|tomorrow) at /);
  assert.equal(joinAskedLabel("2026-11-04T11:59:30.000Z", now), "just now");
  assert.equal(joinAskedLabel("2026-11-04T11:55:00.000Z", now), "5 min ago");
  assert.equal(joinAskedLabel("not a time", now), "earlier");
});
