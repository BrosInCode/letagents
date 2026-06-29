import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const {
  buildGitHubRoomEventArtifacts,
  syncRoomSharedArtifactsForGitHubRoomEvent,
} = await import("../github/room-event-artifacts.js");
const { emitRoomArtifactUpdateEvents } = await import("../github/room-event-projection.js");
const { materializeGitHubWebhookEvent } = await import("../github-room-events.js");

test("GitHub pull request events index the pull request artifact", () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    {
      action: "opened",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
      pull_request: {
        number: 42,
        title: "task_42: git room artifact spine",
        html_url: "https://github.com/BrosInCode/letagents/pull/42",
        state: "open",
        head: {
          ref: "codex/git-rooms",
          sha: "abc123",
        },
        base: {
          ref: "main",
        },
      },
    },
    "delivery-pr-artifact"
  );

  assert.ok(event);
  assert.deepEqual(buildGitHubRoomEventArtifacts(event), [
    {
      provider: "github",
      kind: "pull_request",
      number: 42,
      title: "task_42: git room artifact spine",
      url: "https://github.com/BrosInCode/letagents/pull/42",
      ref: "codex/git-rooms",
      state: "open",
    },
  ]);
});

test("GitHub pull request review events index both review and pull request artifacts", () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request_review",
    {
      action: "submitted",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
      pull_request: {
        number: 42,
        title: "task_42: git room artifact spine",
        html_url: "https://github.com/BrosInCode/letagents/pull/42",
        head: {
          ref: "codex/git-rooms",
          sha: "abc123",
        },
        base: {
          ref: "main",
        },
      },
      review: {
        id: 9001,
        state: "approved",
        html_url: "https://github.com/BrosInCode/letagents/pull/42#pullrequestreview-9001",
        submitted_at: "2026-06-28T10:00:00Z",
      },
    },
    "delivery-review-artifact"
  );

  assert.ok(event);
  assert.deepEqual(buildGitHubRoomEventArtifacts(event), [
    {
      provider: "github",
      kind: "review",
      id: "9001",
      title: "Review on PR #42",
      url: "https://github.com/BrosInCode/letagents/pull/42#pullrequestreview-9001",
      state: "approved",
    },
    {
      provider: "github",
      kind: "pull_request",
      number: 42,
      title: "task_42: git room artifact spine",
      url: "https://github.com/BrosInCode/letagents/pull/42",
      ref: "codex/git-rooms",
    },
  ]);
});

test("GitHub check run events keep large suite ids as artifact numbers", () => {
  const event = materializeGitHubWebhookEvent(
    "check_run",
    {
      action: "completed",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
      check_run: {
        id: 84113022815,
        name: "deploy",
        html_url: "https://github.com/BrosInCode/letagents/actions/runs/28389422373/job/84113022815",
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-06-29T17:12:00Z",
        head_sha: "abc123",
        check_suite: {
          id: 76648989646,
          head_branch: "staging",
          head_sha: "abc123",
        },
        app: {
          name: "GitHub Actions",
        },
      },
    },
    "delivery-check-run-artifact"
  );

  assert.ok(event);
  assert.deepEqual(buildGitHubRoomEventArtifacts(event), [
    {
      provider: "github",
      kind: "check_run",
      id: "84113022815",
      number: 76648989646,
      title: "deploy",
      url: "https://github.com/BrosInCode/letagents/actions/runs/28389422373/job/84113022815",
      state: "failure",
    },
  ]);
});

test("GitHub ref events index branch artifacts without mislabeling tags", () => {
  const branchEvent = materializeGitHubWebhookEvent(
    "push",
    {
      ref: "refs/heads/codex/git-rooms",
      before: "111",
      after: "222",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
    },
    "delivery-branch-artifact"
  );
  const tagEvent = materializeGitHubWebhookEvent(
    "push",
    {
      ref: "refs/tags/v1.2.3",
      before: "111",
      after: "222",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
    },
    "delivery-tag-artifact"
  );

  assert.ok(branchEvent);
  assert.ok(tagEvent);
  assert.deepEqual(buildGitHubRoomEventArtifacts(branchEvent), [
    {
      provider: "github",
      kind: "branch",
      title: "Branch codex/git-rooms",
      ref: "codex/git-rooms",
      state: "pushed",
    },
  ]);
  assert.deepEqual(buildGitHubRoomEventArtifacts(tagEvent), []);
});

test("GitHub event artifact sync writes github_event source and authoritative task links", async () => {
  const event = materializeGitHubWebhookEvent(
    "issues",
    {
      action: "opened",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
      issue: {
        number: 7,
        title: "Track Git Room artifacts",
        html_url: "https://github.com/BrosInCode/letagents/issues/7",
        state: "open",
      },
    },
    "delivery-issue-artifact-sync"
  );
  assert.ok(event);

  const upserts: unknown[] = [];
  const links: unknown[] = [];
  const deps = {
    upsertRoomSharedArtifact: async (input: {
      room_id: string;
      artifact: { kind: string; number?: number | null; ref?: string | null };
      source?: string;
    }) => {
      upserts.push(input);
      return {
        room_id: input.room_id,
        identity_key: `${input.artifact.kind}:${input.artifact.number ?? input.artifact.ref}`,
        provider: "github",
        kind: input.artifact.kind,
        artifact_id: null,
        artifact_number: input.artifact.number ?? null,
        title: null,
        url: null,
        ref: input.artifact.ref ?? null,
        state: null,
        source: "github_event",
        first_seen_at: "2026-06-28T10:00:00.000Z",
        updated_at: "2026-06-28T10:00:00.000Z",
        linked_task_ids: [],
      };
    },
    linkRoomSharedArtifactToTask: async (input: unknown) => {
      links.push(input);
      return input;
    },
  } as never;

  await syncRoomSharedArtifactsForGitHubRoomEvent(
    {
      room_id: "focus_27",
      event,
      linked_task_id: "task_7",
    },
    deps
  );

  assert.deepEqual(upserts, [
    {
      room_id: "focus_27",
      artifact: {
        provider: "github",
        kind: "issue",
        number: 7,
        title: "Track Git Room artifacts",
        url: "https://github.com/BrosInCode/letagents/issues/7",
        state: "open",
      },
      source: "github_event",
    },
  ]);
  assert.deepEqual(links, [
    {
      room_id: "focus_27",
      artifact_identity_key: "issue:7",
      task_id: "task_7",
      source: "github_event",
    },
  ]);
});

test("GitHub event artifact projection emits artifact update invalidations", () => {
  const events = new EventEmitter();
  const emitted: unknown[] = [];
  events.on("artifact:updated", (event) => emitted.push(event));

  const artifact = {
    room_id: "focus_27",
    identity_key: "github:issue:number:7",
    provider: "github",
    kind: "issue",
    artifact_id: null,
    artifact_number: 7,
    title: "Track Git Room artifacts",
    url: "https://github.com/BrosInCode/letagents/issues/7",
    ref: null,
    state: "open",
    source: "github_event",
    first_seen_at: "2026-06-28T10:00:00.000Z",
    updated_at: "2026-06-28T10:00:00.000Z",
    linked_task_ids: ["task_7"],
  };

  emitRoomArtifactUpdateEvents("focus_27", [artifact] as never, events);

  assert.deepEqual(emitted, [{
    projectId: "focus_27",
    artifact,
  }]);
});
