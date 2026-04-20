import assert from "node:assert/strict";
import test from "node:test";

import type { Task } from "../db.js";
import {
  createRepoRoomEventTaskResolver,
  emptyRepoRoomEventTaskResolution,
  getPullRequestWorkflowRef,
  toGitHubRoutingContext,
} from "../repo-event-task-resolution.js";
import type {
  RepoRoomEvent,
  TaskWorkflowArtifactMatch,
} from "../repo-workflow.js";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    room_id: overrides.room_id ?? "github.com/brosincode/letagents",
    title: overrides.title ?? `Task ${id}`,
    description: overrides.description ?? null,
    status: overrides.status ?? "accepted",
    assignee: overrides.assignee ?? null,
    created_by: overrides.created_by ?? "Agent",
    source_message_id: overrides.source_message_id ?? null,
    pr_url: overrides.pr_url ?? null,
    workflow_artifacts: overrides.workflow_artifacts ?? [],
    workflow_refs: overrides.workflow_refs ?? [],
    created_at: overrides.created_at ?? "2026-04-20T17:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-20T17:00:00.000Z",
  };
}

function makePullRequestEvent(overrides: Partial<RepoRoomEvent> = {}): RepoRoomEvent {
  return {
    provider: "github",
    kind: "pull_request",
    action: "opened",
    repositoryFullName: "BrosInCode/letagents",
    pullRequest: {
      number: 249,
      title: "Fix task_1",
      url: "https://github.com/BrosInCode/letagents/pull/249",
      body: null,
    },
    ...overrides,
  } as RepoRoomEvent;
}

function makeIssueEvent(overrides: Partial<RepoRoomEvent> = {}): RepoRoomEvent {
  return {
    provider: "github",
    kind: "issue",
    action: "opened",
    repositoryFullName: "BrosInCode/letagents",
    issue: {
      number: 12,
      title: "Investigate task_3",
      url: "https://github.com/BrosInCode/letagents/issues/12",
    },
    ...overrides,
  } as RepoRoomEvent;
}

function createHarness(input?: {
  artifactTask?: Task;
  prUrlTask?: Task;
  tasksById?: Record<string, Task | undefined>;
}) {
  const artifactMatchCalls: Array<{
    projectId: string;
    matches: TaskWorkflowArtifactMatch[];
  }> = [];
  const prUrlCalls: Array<{ projectId: string; prUrl: string }> = [];
  const taskByIdCalls: Array<{ projectId: string; taskId: string }> = [];

  const resolver = createRepoRoomEventTaskResolver({
    findTaskByWorkflowArtifactMatches: async (projectId, matches) => {
      artifactMatchCalls.push({ projectId, matches });
      return input?.artifactTask;
    },
    findTaskByPrUrl: async (projectId, prUrl) => {
      prUrlCalls.push({ projectId, prUrl });
      return input?.prUrlTask;
    },
    getTaskById: async (projectId, taskId) => {
      taskByIdCalls.push({ projectId, taskId });
      return input?.tasksById?.[taskId];
    },
  });

  return {
    artifactMatchCalls,
    prUrlCalls,
    resolver,
    taskByIdCalls,
  };
}

const project = { id: "github.com/brosincode/letagents" };

test("emptyRepoRoomEventTaskResolution returns the unrouted default shape", () => {
  assert.deepEqual(emptyRepoRoomEventTaskResolution(), {
    task: undefined,
    matchedByTaskReference: false,
    matchedByWorkflowArtifact: false,
  });
});

test("toGitHubRoutingContext maps task resolution flags", () => {
  assert.deepEqual(
    toGitHubRoutingContext({
      task: makeTask("task_1"),
      matchedByTaskReference: true,
      matchedByWorkflowArtifact: false,
    }),
    {
      matched_task_reference: true,
      matched_workflow_artifact: false,
    }
  );
});

test("getPullRequestWorkflowRef returns workflow refs for PR-backed events only", () => {
  const pullRequest = {
    number: 249,
    title: "Fix task_1",
    url: "https://github.com/BrosInCode/letagents/pull/249",
    body: null,
  };
  const pullRequestEvent = makePullRequestEvent({ pullRequest });
  const reviewEvent: RepoRoomEvent = {
    provider: "github",
    kind: "pull_request_review",
    action: "submitted",
    repositoryFullName: "BrosInCode/letagents",
    pullRequest,
    review: {
      id: "review_1",
      state: "approved",
      url: "https://github.com/BrosInCode/letagents/pull/249#pullrequestreview-1",
      body: null,
    },
  };

  assert.equal(getPullRequestWorkflowRef(pullRequestEvent), pullRequest);
  assert.equal(getPullRequestWorkflowRef(reviewEvent), pullRequest);
  assert.equal(getPullRequestWorkflowRef(makeIssueEvent()), null);
});

test("resolveLinkedTaskForRepoRoomEvent prefers workflow artifact matches", async () => {
  const task = makeTask("task_1");
  const { artifactMatchCalls, prUrlCalls, resolver, taskByIdCalls } = createHarness({
    artifactTask: task,
  });

  const resolution = await resolver.resolveLinkedTaskForRepoRoomEvent(
    project,
    makePullRequestEvent()
  );

  assert.equal(resolution.task, task);
  assert.equal(resolution.matchedByTaskReference, true);
  assert.equal(resolution.matchedByWorkflowArtifact, true);
  assert.equal(artifactMatchCalls.length, 1);
  assert.deepEqual(prUrlCalls, []);
  assert.deepEqual(taskByIdCalls, []);
});

test("resolveLinkedTaskForRepoRoomEvent falls back to pull request URL lookup", async () => {
  const task = makeTask("task_2");
  const { prUrlCalls, resolver, taskByIdCalls } = createHarness({
    prUrlTask: task,
  });

  const resolution = await resolver.resolveLinkedTaskForRepoRoomEvent(
    project,
    makePullRequestEvent({
      pullRequest: {
        number: 250,
        title: "Unreferenced title",
        url: "https://github.com/BrosInCode/letagents/pull/250",
        body: null,
      },
    })
  );

  assert.equal(resolution.task, task);
  assert.equal(resolution.matchedByTaskReference, false);
  assert.equal(resolution.matchedByWorkflowArtifact, true);
  assert.deepEqual(prUrlCalls, [
    {
      projectId: "github.com/brosincode/letagents",
      prUrl: "https://github.com/BrosInCode/letagents/pull/250",
    },
  ]);
  assert.deepEqual(taskByIdCalls, []);
});

test("resolveLinkedTaskForRepoRoomEvent falls back to referenced task ids", async () => {
  const task = makeTask("task_3");
  const { prUrlCalls, resolver, taskByIdCalls } = createHarness({
    tasksById: {
      task_3: task,
    },
  });

  const resolution = await resolver.resolveLinkedTaskForRepoRoomEvent(
    project,
    makeIssueEvent()
  );

  assert.equal(resolution.task, task);
  assert.equal(resolution.matchedByTaskReference, true);
  assert.equal(resolution.matchedByWorkflowArtifact, false);
  assert.deepEqual(prUrlCalls, []);
  assert.deepEqual(taskByIdCalls, [
    {
      projectId: "github.com/brosincode/letagents",
      taskId: "task_3",
    },
  ]);
});

test("resolveLinkedTaskForRepoRoomEvent returns empty resolution without matches or references", async () => {
  const { resolver, taskByIdCalls } = createHarness();

  const resolution = await resolver.resolveLinkedTaskForRepoRoomEvent(
    project,
    makeIssueEvent({
      issue: {
        number: 13,
        title: "No task reference",
        url: "https://github.com/BrosInCode/letagents/issues/13",
      },
    })
  );

  assert.deepEqual(resolution, emptyRepoRoomEventTaskResolution());
  assert.deepEqual(taskByIdCalls, []);
});
