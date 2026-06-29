import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import type { GitHubRoomEvent, Project } from "../db.js";
import type {
  GitHubRoomEventProjectionDeps,
} from "../github/room-event-projection.js";
import type { MaterializedGitHubRoomEvent } from "../github/room-events.js";
import type { RepoRoomEvent } from "../repo-workflow.js";
import { emptyRepoRoomEventTaskResolution } from "../github/repo-event-task-resolution.js";

const {
  handleMaterializedGitHubRoomEvent,
} = await import("../github/room-event-projection.js");

function createProject(id = "room_repo"): Project {
  return {
    id,
    code: null,
    display_name: "github.com/brosincode/letagents",
    name: "github.com/brosincode/letagents",
    kind: "main",
    parent_room_id: null,
    focus_key: null,
    source_task_id: null,
    focus_status: null,
    focus_parent_visibility: null,
    focus_activity_scope: null,
    focus_github_event_routing: null,
    focus_archived_at: null,
    git_lifecycle_event_order_at: null,
    concluded_at: null,
    conclusion_summary: null,
    conclusion_details: null,
    created_at: "2026-06-28T10:00:00.000Z",
  };
}

const pullRequestRoomEvent: RepoRoomEvent = {
  provider: "github",
  kind: "pull_request",
  action: "opened",
  repositoryFullName: "BrosInCode/letagents",
  senderLogin: "octocat",
  pullRequest: {
    number: 42,
    title: "task_42: retry projection",
    url: "https://github.com/BrosInCode/letagents/pull/42",
    headRef: "codex/git-rooms",
    headSha: "abc123",
    authorLogin: "octocat",
  },
};

function createMaterializedEvent(): MaterializedGitHubRoomEvent {
  return {
    event_type: "pull_request",
    action: "opened",
    idempotency_key: "github:delivery-retry-projection",
    semantic_id: "github:pr:42",
    github_object_id: "42",
    github_object_url: "https://github.com/BrosInCode/letagents/pull/42",
    title: "task_42: retry projection",
    state: "open",
    actor_login: "octocat",
    provider_event_at: "2026-06-28T10:01:00.000Z",
    provider_object_updated_at: "2026-06-28T10:01:00.000Z",
    ref: "codex/git-rooms",
    base_ref: "main",
    head_ref: "codex/git-rooms",
    head_sha: "abc123",
    metadata: null,
    roomEvent: pullRequestRoomEvent,
  };
}

function createPersistedEvent(event: MaterializedGitHubRoomEvent): GitHubRoomEvent {
  return {
    id: "gre_retry_projection",
    room_id: "room_repo",
    delivery_id: "delivery-retry-projection",
    event_type: event.event_type,
    action: event.action,
    idempotency_key: event.idempotency_key,
    semantic_id: event.semantic_id,
    github_object_id: event.github_object_id,
    github_object_url: event.github_object_url,
    title: event.title,
    state: event.state,
    actor_login: event.actor_login,
    provider_event_at: event.provider_event_at,
    provider_object_updated_at: event.provider_object_updated_at,
    event_order_at: "2026-06-28T10:01:00.000Z",
    ref: event.ref,
    base_ref: event.base_ref,
    head_ref: event.head_ref,
    head_sha: event.head_sha,
    metadata: event.metadata,
    linked_task_id: null,
    created_at: "2026-06-28T10:01:00.000Z",
  };
}

function createProjectionDeps(
  calls: string[],
  messageIdBases: Array<string | null | undefined>
): GitHubRoomEventProjectionDeps {
  return {
    resolveLinkedTaskForRepoRoomEvent: async () => {
      calls.push("resolve-task");
      return emptyRepoRoomEventTaskResolution();
    },
    getHardIsolatedFocusRoomForGitHubEvent: async () => {
      calls.push("resolve-isolation");
      return null;
    },
    persistMaterializedGitHubRoomEvent: async (event, input) => {
      calls.push(`persist:${input.deliveryId}:${input.roomId ?? "null"}`);
      return {
        event: createPersistedEvent(event),
        duplicate: true,
      };
    },
    getProjectForResolvedTask: async (project) => {
      calls.push("resolve-task-project");
      return project;
    },
    maybeAutoCreateTaskForFailedCheckRun: async () => {
      calls.push("auto-create-check-task");
      return undefined;
    },
    updateGitHubRoomEventLinkedTaskId: async () => {
      calls.push("update-linked-task");
    },
    applyRepoRoomEventToTask: async (_project, _task, _event, input) => {
      calls.push("project-task");
      messageIdBases.push(input.messageIdBase);
      return {
        task: undefined,
        authoritative: false,
      };
    },
    syncRoomSharedArtifactsForGitHubRoomEvent: async () => {
      calls.push("sync-artifacts");
      return [];
    },
    emitRoomArtifactUpdateEvents: () => {
      calls.push("emit-artifacts");
    },
    emitGitHubRoomEventUpdate: () => {
      calls.push("emit-github-event");
    },
    emitRepoRoomEventProjectionMessage: async (input) => {
      calls.push("emit-message");
      messageIdBases.push(input.messageIdBase);
    },
    applyGitHubRefRoomLifecycle: async () => {
      calls.push("apply-lifecycle");
    },
  };
}

function expectedMessageIdBase(event: MaterializedGitHubRoomEvent): string {
  const digest = crypto
    .createHash("sha256")
    .update(event.semantic_id ?? event.idempotency_key)
    .digest("hex");
  return `github-event:${digest}`;
}

test("duplicate GitHub room events skip projection unless retrying a failed delivery", async () => {
  const project = createProject();
  const event = createMaterializedEvent();
  const calls: string[] = [];
  const messageIdBases: Array<string | null | undefined> = [];

  const result = await handleMaterializedGitHubRoomEvent(project, event, {
    deliveryId: "delivery-retry-projection",
    installationId: "123",
    githubRepoId: "456",
    retryFailedDelivery: false,
    deps: createProjectionDeps(calls, messageIdBases),
  });

  assert.deepEqual(result, {
    status: "processed",
    installationId: "123",
    githubRepoId: "456",
    roomId: "room_repo",
  });
  assert.deepEqual(calls, [
    "resolve-task",
    "resolve-isolation",
    "persist:delivery-retry-projection:room_repo",
  ]);
  assert.deepEqual(messageIdBases, []);
});

test("failed duplicate GitHub webhook deliveries continue through room projection", async () => {
  const project = createProject();
  const event = createMaterializedEvent();
  const calls: string[] = [];
  const messageIdBases: Array<string | null | undefined> = [];

  const result = await handleMaterializedGitHubRoomEvent(project, event, {
    deliveryId: "delivery-retry-projection",
    installationId: "123",
    githubRepoId: "456",
    retryFailedDelivery: true,
    deps: createProjectionDeps(calls, messageIdBases),
  });

  assert.deepEqual(result, {
    status: "processed",
    installationId: "123",
    githubRepoId: "456",
    roomId: "room_repo",
  });
  assert.deepEqual(calls, [
    "resolve-task",
    "resolve-isolation",
    "persist:delivery-retry-projection:room_repo",
    "resolve-task-project",
    "project-task",
    "sync-artifacts",
    "emit-artifacts",
    "emit-github-event",
    "emit-message",
    "apply-lifecycle",
  ]);
  assert.deepEqual(messageIdBases, [
    expectedMessageIdBase(event),
    expectedMessageIdBase(event),
  ]);
});
