import assert from "node:assert/strict";
import test from "node:test";

import type { RoomAgentPresence, Task } from "../db.js";
import { STALE_TASK_THRESHOLD_MS, selectStaleTaskAutoPrompt } from "../stale-work.js";

const NOW = Date.parse("2026-04-07T21:00:00.000Z");

function isoMinutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "task_59",
    room_id: overrides.room_id ?? "github.com/brosincode/letagents",
    title: overrides.title ?? "Stale work detection and auto-prompting",
    description: overrides.description ?? null,
    status: overrides.status ?? "accepted",
    assignee: overrides.assignee ?? null,
    created_by: overrides.created_by ?? "SolarVista | EmmyMay's agent | Agent",
    source_message_id: overrides.source_message_id ?? null,
    pr_url: overrides.pr_url ?? null,
    workflow_artifacts: overrides.workflow_artifacts ?? [],
    workflow_refs: overrides.workflow_refs ?? [],
    created_at: overrides.created_at ?? isoMinutesAgo(120),
    updated_at: overrides.updated_at ?? isoMinutesAgo(120),
  };
}

function buildPresence(overrides: Partial<RoomAgentPresence> = {}): RoomAgentPresence {
  return {
    room_id: overrides.room_id ?? "github.com/brosincode/letagents",
    actor_label: overrides.actor_label ?? "MapleRidge | EmmyMay's agent | Agent",
    agent_key: overrides.agent_key ?? "EmmyMay/mapleridge",
    display_name: overrides.display_name ?? "MapleRidge",
    owner_label: overrides.owner_label ?? "EmmyMay",
    ide_label: overrides.ide_label ?? "Agent",
    status: overrides.status ?? "idle",
    status_text: overrides.status_text ?? "idle and monitoring room",
    last_heartbeat_at: overrides.last_heartbeat_at ?? isoMinutesAgo(1),
    created_at: overrides.created_at ?? isoMinutesAgo(180),
    updated_at: overrides.updated_at ?? isoMinutesAgo(1),
    freshness: overrides.freshness ?? "active",
  };
}

test("selectStaleTaskAutoPrompt picks an accepted unclaimed stale task for an active idle agent", () => {
  const prompt = selectStaleTaskAutoPrompt({
    tasks: [
      buildTask({
        id: "task_59",
        status: "accepted",
        updated_at: isoMinutesAgo(
          Math.ceil(STALE_TASK_THRESHOLD_MS.accepted_unclaimed / 60_000) + 5
        ),
      }),
    ],
    presence: [buildPresence()],
    now: NOW,
  });

  assert.equal(prompt?.task.id, "task_59");
  assert.equal(prompt?.reason, "accepted_unclaimed");
  assert.match(prompt?.prompt_text ?? "", /accepted and unclaimed/);
  assert.match(prompt?.prompt_text ?? "", /MapleRidge, please pick it up/);
});

test("selectStaleTaskAutoPrompt prefers accepted stale work over older review backlog", () => {
  const prompt = selectStaleTaskAutoPrompt({
    tasks: [
      buildTask({
        id: "task_60",
        status: "in_review",
        updated_at: isoMinutesAgo(
          Math.ceil(STALE_TASK_THRESHOLD_MS.in_review_no_follow_up / 60_000) + 30
        ),
      }),
      buildTask({
        id: "task_61",
        status: "accepted",
        updated_at: isoMinutesAgo(
          Math.ceil(STALE_TASK_THRESHOLD_MS.accepted_unclaimed / 60_000) + 1
        ),
      }),
    ],
    presence: [buildPresence()],
    now: NOW,
  });

  assert.equal(prompt?.task.id, "task_61");
  assert.equal(prompt?.reason, "accepted_unclaimed");
});

test("selectStaleTaskAutoPrompt ignores stale tasks when no active idle agent is available", () => {
  const prompt = selectStaleTaskAutoPrompt({
    tasks: [
      buildTask({
        status: "blocked",
        updated_at: isoMinutesAgo(
          Math.ceil(STALE_TASK_THRESHOLD_MS.blocked_no_follow_up / 60_000) + 20
        ),
      }),
    ],
    presence: [buildPresence({ status: "working" })],
    now: NOW,
  });

  assert.equal(prompt, null);
});

test("selectStaleTaskAutoPrompt skips fresh tasks that have not crossed the stale threshold", () => {
  const prompt = selectStaleTaskAutoPrompt({
    tasks: [
      buildTask({
        status: "accepted",
        updated_at: isoMinutesAgo(
          Math.floor(STALE_TASK_THRESHOLD_MS.accepted_unclaimed / 60_000) - 1
        ),
      }),
    ],
    presence: [buildPresence()],
    now: NOW,
  });

  assert.equal(prompt, null);
});
