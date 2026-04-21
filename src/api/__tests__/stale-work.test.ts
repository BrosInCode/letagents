import assert from "node:assert/strict";
import test from "node:test";

import type { Message, RoomAgentPresence, StaleTaskPromptMute, Task } from "../db.js";
import {
  createStaleWorkPromptEmitter,
  getTaskStalePromptState,
  STALE_TASK_THRESHOLD_MS,
  STALE_WORK_PROMPT_COOLDOWN_MS,
  selectStaleTaskAutoPrompt,
} from "../stale-work.js";

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

function buildMessage(text: string, index: number): Message {
  return {
    id: `msg_${index}`,
    sender: "letagents",
    text,
    agent_prompt_kind: "auto",
    source: undefined,
    timestamp: new Date(NOW).toISOString(),
    reply_to: null,
  };
}

function buildMute(overrides: Partial<StaleTaskPromptMute> = {}): StaleTaskPromptMute {
  return {
    room_id: overrides.room_id ?? "github.com/brosincode/letagents",
    task_id: overrides.task_id ?? "task_59",
    task_updated_at: overrides.task_updated_at ?? isoMinutesAgo(120),
    muted_by: overrides.muted_by ?? "EmmyMay",
    created_at: overrides.created_at ?? isoMinutesAgo(5),
    updated_at: overrides.updated_at ?? isoMinutesAgo(5),
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

test("selectStaleTaskAutoPrompt skips stale tasks muted for the current task version", () => {
  const mutedTask = buildTask({
    id: "task_63",
    status: "in_review",
    updated_at: isoMinutesAgo(
      Math.ceil(STALE_TASK_THRESHOLD_MS.in_review_no_follow_up / 60_000) + 10
    ),
  });
  const prompt = selectStaleTaskAutoPrompt({
    tasks: [mutedTask],
    presence: [buildPresence()],
    stalePromptMutes: [
      buildMute({
        task_id: mutedTask.id,
        task_updated_at: mutedTask.updated_at,
      }),
    ],
    now: NOW,
  });

  assert.equal(prompt, null);
});

test("getTaskStalePromptState keeps a mute active only until the task changes", () => {
  const task = buildTask({
    id: "task_64",
    status: "blocked",
    updated_at: isoMinutesAgo(
      Math.ceil(STALE_TASK_THRESHOLD_MS.blocked_no_follow_up / 60_000) + 10
    ),
  });

  const activeMuteState = getTaskStalePromptState({
    task,
    mute: buildMute({
      task_id: task.id,
      task_updated_at: task.updated_at,
      muted_by: "EmmyMay",
    }),
    now: NOW,
  });
  const staleMuteState = getTaskStalePromptState({
    task,
    mute: buildMute({
      task_id: task.id,
      task_updated_at: isoMinutesAgo(5),
      muted_by: "EmmyMay",
    }),
    now: NOW,
  });

  assert.equal(activeMuteState.muted, true);
  assert.equal(activeMuteState.muted_by, "EmmyMay");
  assert.equal(staleMuteState.muted, false);
});

test("createStaleWorkPromptEmitter emits stale prompt and respects cooldown", async () => {
  let now = NOW;
  const staleTask = buildTask({
    id: "task_62",
    updated_at: isoMinutesAgo(
      Math.ceil(STALE_TASK_THRESHOLD_MS.accepted_unclaimed / 60_000) + 5
    ),
  });
  const taskCalls: Array<{ projectId: string; limit: number }> = [];
  const presenceCalls: Array<{ projectId: string; limit: number }> = [];
  const emitted: Array<{
    projectId: string;
    sender: string;
    text: string;
    task: { id: string; title: string };
    options: {
      agent_prompt_kind: "auto";
      parent_activity: string;
      parent_event_kind: "all_activity";
    };
  }> = [];
  const emitter = createStaleWorkPromptEmitter({
    getOpenTasks: async (projectId, options) => {
      taskCalls.push({ projectId, limit: options.limit });
      return { tasks: [staleTask] };
    },
    getRoomAgentPresence: async (projectId, options) => {
      presenceCalls.push({ projectId, limit: options.limit });
      return [buildPresence()];
    },
    getStaleTaskPromptMutes: async () => [],
    emitTaskAnchoredMessage: async (projectId, sender, text, task, options) => {
      emitted.push({ projectId, sender, text, task, options });
      return buildMessage(text, emitted.length);
    },
    now: () => now,
  });

  const firstMessage = await emitter.maybeEmitStaleWorkPrompt(
    "github.com/brosincode/letagents"
  );
  const secondMessage = await emitter.maybeEmitStaleWorkPrompt(
    "github.com/brosincode/letagents"
  );
  now += STALE_WORK_PROMPT_COOLDOWN_MS + 1;
  const thirdMessage = await emitter.maybeEmitStaleWorkPrompt(
    "github.com/brosincode/letagents"
  );

  assert.equal(firstMessage?.id, "msg_1");
  assert.equal(secondMessage, null);
  assert.equal(thirdMessage?.id, "msg_2");
  assert.deepEqual(taskCalls.map((call) => call.limit), [200, 200, 200]);
  assert.deepEqual(presenceCalls.map((call) => call.limit), [50, 50, 50]);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0]?.projectId, "github.com/brosincode/letagents");
  assert.equal(emitted[0]?.sender, "letagents");
  assert.equal(emitted[0]?.task.id, "task_62");
  assert.deepEqual(emitted[0]?.options, {
    agent_prompt_kind: "auto",
    parent_activity: "Stale-work prompt",
    parent_event_kind: "all_activity",
  });
});
