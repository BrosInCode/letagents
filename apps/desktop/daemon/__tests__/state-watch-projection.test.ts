import assert from "node:assert/strict";
import test from "node:test";

import {
  projectStateWatchActivity,
  projectStateWatchEntries,
  STATE_WATCH_ACTIVITY_SUMMARY_LIMIT,
} from "../state-watch-projection.js";
import type { DaemonActivityEvent, DaemonManifestEntryView } from "../types.js";

function activityEvent(sequence: number): DaemonActivityEvent {
  return {
    observed_at: new Date(1_700_000_000_000 + sequence * 1_000).toISOString(),
    sequence,
    provider: "claude",
    kind: "provider_stream",
    method: "item/tool_call",
    summary: `Ran a tool for step ${sequence}`,
    status: "working",
    // A redacted payload is capped at 8 KiB, so history is the dominant cost.
    payload: { text: "x".repeat(400), sequence },
    payload_truncated: false,
    payload_redacted: false,
    durable_payload_ref: null,
  };
}

function entry(id: string, activityCount: number): DaemonManifestEntryView {
  return {
    id,
    room_id: "github.com/BrosInCode/letagents",
    display_name: `Agent ${id}`,
    provider: "claude",
    model: "claude-opus-5",
    charter: "Work on the room's tasks and report back with evidence.",
    desired_state: "stopped",
    observed_state: "idle",
    condition: "none",
    last_error: null,
    permission_profile_id: "supervised_default",
    created_by: "host",
    created_at: "2026-09-01T00:00:00.000Z",
    source_repo_path: "/Users/host/Projects/letagents",
    workspace_path: "/Users/host/Projects/letagents",
    work_attempt_id: `attempt_${id}`,
    ready_reached_at: "2026-09-01T00:01:00.000Z",
    provider_ref: {
      execution_generation_id: `exec_${id}`,
      provider_continuation_id: `cont_${id}`,
      provider_connection: { kind: "claude", pid: 4242, processIdentity: "identity" },
    } as DaemonManifestEntryView["provider_ref"],
    workplace_liveness: { state: "reachable", observed_at: "2026-09-01T00:02:00.000Z", detail: null },
    native_liveness: { state: "idle", observed_at: "2026-09-01T00:02:00.000Z", detail: null },
    last_turn_control_sequence: 12,
    activity: Array.from({ length: activityCount }, (_unused, index) => activityEvent(index + 1)),
  } as DaemonManifestEntryView;
}

test("state watch activity keeps only the newest summaries and drops payloads", () => {
  const events = Array.from({ length: 200 }, (_unused, index) => activityEvent(index + 1));
  const projected = projectStateWatchActivity(events);

  assert.equal(projected.length, STATE_WATCH_ACTIVITY_SUMMARY_LIMIT);
  assert.equal(projected[0]!.sequence, 200 - STATE_WATCH_ACTIVITY_SUMMARY_LIMIT + 1);
  assert.equal(projected.at(-1)!.sequence, 200);
  assert.ok(projected.every((event) => event.payload === null));
  // Everything a room-level view renders survives.
  assert.deepEqual(
    projected.at(-1)!,
    { ...activityEvent(200), payload: null },
  );
  assert.deepEqual(projectStateWatchActivity(undefined), []);
  assert.deepEqual(projectStateWatchActivity([]), []);
});

test("state watch activity orders by sequence before truncating", () => {
  const shuffled = [activityEvent(9), activityEvent(1), activityEvent(5)];
  assert.deepEqual(projectStateWatchActivity(shuffled).map((event) => event.sequence), [1, 5, 9]);
});

test("state watch entries preserve every field the launch and inspector views derive from", () => {
  const [projected] = projectStateWatchEntries([entry("agent_1", 200)]);
  const original = entry("agent_1", 200);

  for (const field of [
    "id", "room_id", "display_name", "provider", "model", "charter", "desired_state",
    "observed_state", "condition", "last_error", "permission_profile_id", "created_by",
    "created_at", "source_repo_path", "workspace_path", "work_attempt_id",
    "ready_reached_at", "last_turn_control_sequence",
  ] as const) {
    assert.deepEqual(projected![field], original[field], `${field} must be carried through`);
  }
  assert.deepEqual(projected!.provider_ref, original.provider_ref);
  assert.deepEqual(projected!.workplace_liveness, original.workplace_liveness);
  assert.deepEqual(projected!.native_liveness, original.native_liveness);
  assert.equal(projected!.activity!.length, STATE_WATCH_ACTIVITY_SUMMARY_LIMIT);
});

test("state watch entries without activity are returned untouched", () => {
  const bare = { ...entry("agent_2", 0) };
  delete (bare as { activity?: unknown }).activity;
  const [projected] = projectStateWatchEntries([bare]);
  assert.equal(projected, bare, "an entry with no activity field is not copied");
});

test("a 150-entry snapshot is an order of magnitude smaller than full history", () => {
  const entries = Array.from({ length: 150 }, (_unused, index) => entry(`agent_${index}`, 200));
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const projected = projectStateWatchEntries(entries);
  const before = bytes({ daemon_generation: 1, sequence: 2, entries });
  const after = bytes({ daemon_generation: 1, sequence: 2, entries: projected });
  const activityBefore = entries.reduce((total, row) => total + bytes(row.activity), 0);
  const activityAfter = projected.reduce((total, row) => total + bytes(row.activity), 0);

  // Printed so a reviewer sees the measured shape, not only the assertion.
  const mib = (value: number) => `${(value / 1_048_576).toFixed(2)} MiB`;
  console.log(
    `state snapshot (150 entries x 200 activity events): total ${mib(before)} -> ${mib(after)} `
    + `(${(before / after).toFixed(1)}x); activity ${mib(activityBefore)} -> ${mib(activityAfter)} `
    + `(${(activityBefore / activityAfter).toFixed(1)}x); non-activity floor ${mib(before - activityBefore)}`,
  );
  assert.ok(before > 10 * 1_048_576, `synthetic baseline should reproduce a multi-megabyte snapshot, saw ${before}`);
  assert.ok(after < 1_048_576, `projected snapshot must stay under 1 MiB, saw ${after}`);
  assert.ok(before / after > 10, `projection must cut the snapshot by more than 10x, saw ${(before / after).toFixed(1)}x`);
  assert.ok(
    activityBefore / activityAfter > 20,
    `activity is the cost being removed, saw only ${(activityBefore / activityAfter).toFixed(1)}x`,
  );
});
