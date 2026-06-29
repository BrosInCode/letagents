import {
  linkRoomSharedArtifactToTask,
  upsertRoomSharedArtifact,
  type RoomSharedArtifact,
} from "../db.js";
import type {
  RepoRoomEvent,
  TaskWorkflowArtifact,
} from "../repo-workflow.js";
import type { MaterializedGitHubRoomEvent } from "./room-events.js";

export interface GitHubRoomEventArtifactSyncDeps {
  upsertRoomSharedArtifact: typeof upsertRoomSharedArtifact;
  linkRoomSharedArtifactToTask: typeof linkRoomSharedArtifactToTask;
}

const defaultGitHubRoomEventArtifactSyncDeps: GitHubRoomEventArtifactSyncDeps = {
  upsertRoomSharedArtifact,
  linkRoomSharedArtifactToTask,
};

function pullRequestArtifact(
  event: MaterializedGitHubRoomEvent,
  roomEvent: Extract<RepoRoomEvent, { kind: "pull_request" }>
): TaskWorkflowArtifact {
  return {
    provider: roomEvent.provider,
    kind: "pull_request",
    number: roomEvent.pullRequest.number,
    title: roomEvent.pullRequest.title,
    url: roomEvent.pullRequest.url,
    ref: roomEvent.pullRequest.headRef ?? event.head_ref,
    state: event.state,
  };
}

function issueArtifact(
  event: MaterializedGitHubRoomEvent,
  roomEvent: Extract<RepoRoomEvent, { kind: "issue" | "issue_comment" }>
): TaskWorkflowArtifact {
  return {
    provider: roomEvent.provider,
    kind: roomEvent.issue.isPullRequest ? "pull_request" : "issue",
    number: roomEvent.issue.number,
    title: roomEvent.issue.title,
    url: roomEvent.issue.url,
    state: event.state,
  };
}

function reviewArtifacts(
  event: MaterializedGitHubRoomEvent,
  roomEvent: Extract<RepoRoomEvent, { kind: "pull_request_review" }>
): TaskWorkflowArtifact[] {
  return [
    {
      provider: roomEvent.provider,
      kind: "review",
      id: roomEvent.review.id,
      title: `Review on PR #${roomEvent.pullRequest.number}`,
      url: roomEvent.review.url,
      state: roomEvent.review.state,
    },
    {
      provider: roomEvent.provider,
      kind: "pull_request",
      number: roomEvent.pullRequest.number,
      title: roomEvent.pullRequest.title,
      url: roomEvent.pullRequest.url,
      ref: roomEvent.pullRequest.headRef ?? event.head_ref,
    },
  ];
}

function checkRunArtifact(
  roomEvent: Extract<RepoRoomEvent, { kind: "check_run" }>
): TaskWorkflowArtifact {
  return {
    provider: roomEvent.provider,
    kind: "check_run",
    id: roomEvent.checkRun.id,
    number: roomEvent.checkRun.suiteId ?? null,
    title: roomEvent.checkRun.name,
    url: roomEvent.checkRun.url,
    state: roomEvent.checkRun.conclusion ?? roomEvent.checkRun.status,
  };
}

function branchArtifact(
  event: MaterializedGitHubRoomEvent,
  roomEvent: Extract<RepoRoomEvent, { kind: "push" | "branch_ref" }>
): TaskWorkflowArtifact | null {
  const ref = roomEvent.kind === "push" ? roomEvent.push.ref : roomEvent.branch.ref;
  const refType = roomEvent.kind === "push" ? roomEvent.push.refType : roomEvent.branch.refType;
  if (refType !== "branch") {
    return null;
  }

  return {
    provider: roomEvent.provider,
    kind: "branch",
    title: `Branch ${ref}`,
    ref,
    state: event.state,
  };
}

export function buildGitHubRoomEventArtifacts(
  event: MaterializedGitHubRoomEvent
): TaskWorkflowArtifact[] {
  const roomEvent = event.roomEvent;
  if (!roomEvent) {
    return [];
  }

  switch (roomEvent.kind) {
    case "pull_request":
      return [pullRequestArtifact(event, roomEvent)];
    case "issue":
    case "issue_comment":
      return [issueArtifact(event, roomEvent)];
    case "pull_request_review":
      return reviewArtifacts(event, roomEvent);
    case "check_run":
      return [checkRunArtifact(roomEvent)];
    case "push":
    case "branch_ref": {
      const artifact = branchArtifact(event, roomEvent);
      return artifact ? [artifact] : [];
    }
    case "repository":
      return [];
    default:
      return [];
  }
}

export async function syncRoomSharedArtifactsForGitHubRoomEvent(
  input: {
    room_id: string;
    event: MaterializedGitHubRoomEvent;
    linked_task_id?: string | null;
  },
  deps: GitHubRoomEventArtifactSyncDeps = defaultGitHubRoomEventArtifactSyncDeps
): Promise<RoomSharedArtifact[]> {
  const artifacts = buildGitHubRoomEventArtifacts(input.event);
  const synced: RoomSharedArtifact[] = [];

  for (const artifact of artifacts) {
    const sharedArtifact = await deps.upsertRoomSharedArtifact({
      room_id: input.room_id,
      artifact,
      source: "github_event",
    });
    synced.push(sharedArtifact);

    if (input.linked_task_id) {
      await deps.linkRoomSharedArtifactToTask({
        room_id: input.room_id,
        artifact_identity_key: sharedArtifact.identity_key,
        task_id: input.linked_task_id,
        source: "github_event",
      });
    }
  }

  return synced;
}
