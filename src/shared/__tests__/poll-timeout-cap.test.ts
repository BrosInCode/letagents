import assert from "node:assert/strict";
import test from "node:test";

import { getPollTimeoutCapMs } from "../poll-timeout-cap.js";

test("getPollTimeoutCapMs returns 180000 when env is unset", () => {
  const saved = process.env.LETAGENTS_POLL_MAX_MS;
  delete process.env.LETAGENTS_POLL_MAX_MS;
  try {
    assert.equal(getPollTimeoutCapMs(), 180_000);
  } finally {
    if (saved !== undefined) process.env.LETAGENTS_POLL_MAX_MS = saved;
  }
});

test("getPollTimeoutCapMs returns 180000 for empty string", () => {
  const saved = process.env.LETAGENTS_POLL_MAX_MS;
  process.env.LETAGENTS_POLL_MAX_MS = "";
  try {
    assert.equal(getPollTimeoutCapMs(), 180_000);
  } finally {
    if (saved !== undefined) process.env.LETAGENTS_POLL_MAX_MS = saved;
    else delete process.env.LETAGENTS_POLL_MAX_MS;
  }
});

test("getPollTimeoutCapMs respects custom values", () => {
  const saved = process.env.LETAGENTS_POLL_MAX_MS;
  process.env.LETAGENTS_POLL_MAX_MS = "36000000";
  try {
    assert.equal(getPollTimeoutCapMs(), 36_000_000);
  } finally {
    if (saved !== undefined) process.env.LETAGENTS_POLL_MAX_MS = saved;
    else delete process.env.LETAGENTS_POLL_MAX_MS;
  }
});

test("getPollTimeoutCapMs clamps to 24 hours ceiling", () => {
  const saved = process.env.LETAGENTS_POLL_MAX_MS;
  process.env.LETAGENTS_POLL_MAX_MS = "999999999";
  try {
    assert.equal(getPollTimeoutCapMs(), 86_400_000);
  } finally {
    if (saved !== undefined) process.env.LETAGENTS_POLL_MAX_MS = saved;
    else delete process.env.LETAGENTS_POLL_MAX_MS;
  }
});

test("getPollTimeoutCapMs falls back to default for values under 1 second", () => {
  const saved = process.env.LETAGENTS_POLL_MAX_MS;
  process.env.LETAGENTS_POLL_MAX_MS = "500";
  try {
    assert.equal(getPollTimeoutCapMs(), 180_000);
  } finally {
    if (saved !== undefined) process.env.LETAGENTS_POLL_MAX_MS = saved;
    else delete process.env.LETAGENTS_POLL_MAX_MS;
  }
});

test("getPollTimeoutCapMs falls back to default for NaN values", () => {
  const saved = process.env.LETAGENTS_POLL_MAX_MS;
  process.env.LETAGENTS_POLL_MAX_MS = "not-a-number";
  try {
    assert.equal(getPollTimeoutCapMs(), 180_000);
  } finally {
    if (saved !== undefined) process.env.LETAGENTS_POLL_MAX_MS = saved;
    else delete process.env.LETAGENTS_POLL_MAX_MS;
  }
});
