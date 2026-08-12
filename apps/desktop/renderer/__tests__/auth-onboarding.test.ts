import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isAuthSnapshotPending,
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
