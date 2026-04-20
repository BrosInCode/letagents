import assert from "node:assert/strict";
import test from "node:test";

import type { AgentPromptKind } from "../../shared/room-agent-prompts.js";
import type { Message, Project } from "../db.js";
import { createTaskActivityMessageEmitters } from "../task-activity-messages.js";

interface EmittedMessage {
  projectId: string;
  sender: string;
  text: string;
  options?: {
    source?: string;
    agent_prompt_kind?: AgentPromptKind | null;
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? "parent",
    code: overrides.code ?? null,
    display_name: overrides.display_name ?? "Parent Room",
    name: overrides.name,
    kind: overrides.kind ?? "main",
    parent_room_id: overrides.parent_room_id ?? null,
    focus_key: overrides.focus_key ?? null,
    source_task_id: overrides.source_task_id ?? null,
    focus_status: overrides.focus_status ?? null,
    focus_parent_visibility: overrides.focus_parent_visibility ?? null,
    focus_activity_scope: overrides.focus_activity_scope ?? null,
    focus_github_event_routing: overrides.focus_github_event_routing ?? null,
    concluded_at: overrides.concluded_at ?? null,
    conclusion_summary: overrides.conclusion_summary ?? null,
    created_at: overrides.created_at ?? "2026-04-20T17:00:00.000Z",
  };
}

function makeFocusRoom(overrides: Partial<Project> = {}): Project {
  return makeProject({
    id: "focus_1",
    display_name: "Focus One",
    kind: "focus",
    parent_room_id: "parent",
    focus_key: "task_1",
    source_task_id: "task_1",
    focus_status: "active",
    focus_parent_visibility: "summary_only",
    focus_activity_scope: "task_and_branch",
    focus_github_event_routing: "task_and_branch",
    ...overrides,
  });
}

function makeMessage(input: EmittedMessage, index: number): Message {
  return {
    id: `msg_${index}`,
    sender: input.sender,
    text: input.text,
    agent_prompt_kind: input.options?.agent_prompt_kind ?? null,
    source: input.options?.source,
    timestamp: "2026-04-20T17:00:00.000Z",
    reply_to: null,
  };
}

function createHarness(input?: {
  project?: Project | null;
  activeFocusRoom?: Project | null;
  parentFocusRooms?: Project[];
}) {
  const emitted: EmittedMessage[] = [];
  const emitters = createTaskActivityMessageEmitters({
    getProjectById: async () => input?.project ?? makeProject(),
    getActiveFocusRoomForTask: async () => input?.activeFocusRoom ?? null,
    getFocusRoomsForParent: async () => input?.parentFocusRooms ?? [],
    emitProjectMessage: async (projectId, sender, text, options) => {
      const emittedMessage = { projectId, sender, text, options };
      emitted.push(emittedMessage);
      return makeMessage(emittedMessage, emitted.length);
    },
  });

  return { emitted, emitters };
}

const task = { id: "task_1", title: "Ship it" };

test("emitTaskAnchoredMessage falls back to parent room without active focus", async () => {
  const { emitted, emitters } = createHarness();

  const message = await emitters.emitTaskAnchoredMessage("parent", "letagents", "hello", task, {
    agent_prompt_kind: "auto",
  });

  assert.equal(message.id, "msg_1");
  assert.deepEqual(emitted, [
    {
      projectId: "parent",
      sender: "letagents",
      text: "hello",
      options: { source: undefined, agent_prompt_kind: "auto" },
    },
  ]);
});

test("emitTaskAnchoredMessage routes to focus and posts configured parent anchor", async () => {
  const focusRoom = makeFocusRoom({ focus_parent_visibility: "major_activity" });
  const { emitted, emitters } = createHarness({ activeFocusRoom: focusRoom });

  await emitters.emitTaskAnchoredMessage("parent", "letagents", "focus update", task, {
    parent_activity: "Task status",
    parent_event_kind: "major_activity",
  });

  assert.equal(emitted.length, 2);
  assert.equal(emitted[0]?.projectId, "focus_1");
  assert.equal(emitted[0]?.text, "focus update");
  assert.equal(emitted[1]?.projectId, "parent");
  assert.equal(
    emitted[1]?.text,
    "[status] Task status for task_1: Ship it is in Focus Room Focus One (task_1)."
  );
});

test("emitTaskAnchoredMessage skips parent anchor for hard-isolated GitHub focus events", async () => {
  const focusRoom = makeFocusRoom({
    focus_parent_visibility: "all_activity",
    focus_github_event_routing: "focus_owned_only",
  });
  const { emitted, emitters } = createHarness({ activeFocusRoom: focusRoom });

  await emitters.emitTaskAnchoredMessage("parent", "github", "github update", task, {
    source: "github",
    event_kind: "github",
    github_routing_context: { matched_workflow_artifact: true },
  });

  assert.deepEqual(emitted.map((entry) => entry.projectId), ["focus_1"]);
  assert.equal(emitted[0]?.options?.source, "github");
});

test("emitTaskLifecycleStatusMessage reuses task status formatting", async () => {
  const { emitted, emitters } = createHarness();

  await emitters.emitTaskLifecycleStatusMessage("parent", {
    id: "task_1",
    title: "Ship it",
    status: "done",
    assignee: null,
  });

  assert.equal(emitted[0]?.text, "[status] task_1 is done: Ship it");
});

test("emitGitHubEventToAllParentRepoFocusRooms filters concluded, excluded, and unrouted rooms", async () => {
  const routed = makeFocusRoom({
    id: "focus_routed",
    focus_github_event_routing: "all_parent_repo",
  });
  const excluded = makeFocusRoom({
    id: "focus_excluded",
    focus_github_event_routing: "all_parent_repo",
  });
  const concluded = makeFocusRoom({
    id: "focus_concluded",
    focus_status: "concluded",
    focus_github_event_routing: "all_parent_repo",
  });
  const off = makeFocusRoom({
    id: "focus_off",
    focus_github_event_routing: "off",
  });
  const { emitted, emitters } = createHarness({
    parentFocusRooms: [routed, excluded, concluded, off],
  });

  await emitters.emitGitHubEventToAllParentRepoFocusRooms("parent", "github", "repo event", {
    excludeRoomIds: new Set(["focus_excluded"]),
  });

  assert.deepEqual(emitted.map((entry) => entry.projectId), ["focus_routed"]);
  assert.equal(emitted[0]?.options?.source, "github");
});
