import type { GitRoomBinding, Project, TaskLease } from "../db.js";
import type {
  GitHubWebhookPayload,
  GitHubWebhookPullRequest,
  GitHubWebhookRepository,
} from "../github/app.js";
import type { GitHubRefRoomLifecycleDeps } from "../github/git-room-lifecycle.js";

export const REPO_ID = 1;
export const REPO_FULL_NAME = "BrosInCode/letagents";
export const REPO_ROOM_ID = "github.com/brosincode/letagents";
export const REPO_NAME = "letagents";
export const REPO_OWNER = "BrosInCode";
export const DEFAULT_BRANCH = "main";
export const PR_NUMBER = 42;
export const PR_URL = "https://github.com/BrosInCode/letagents/pull/42";
export const PR_MERGED_SUMMARY = "Pull request #42 merged.";

export const WEBHOOK_BRANCH = "codex/GitRooms";
export const WEBHOOK_BRANCH_ROOM_ID =
  "git-room:github.com:brosincode/letagents:branch:Y29kZXgvR2l0Um9vbXM";
export const WEBHOOK_BRANCH_FOCUS_KEY = "git:branch:Y29kZXgvR2l0Um9vbXM";

export const TASK_BRANCH = "codex/git-rooms";
export const TASK_BRANCH_ROOM_ID =
  "git-room:github.com:brosincode/letagents:branch:Y29kZXgvZ2l0LXJvb21z";
export const TASK_BRANCH_FOCUS_KEY = "git:branch:Y29kZXgvZ2l0LXJvb21z";

type GitHubWebhookHeadRepository = NonNullable<
  NonNullable<GitHubWebhookPullRequest["head"]>["repo"]
>;

export function githubRepository(
  overrides: Partial<GitHubWebhookRepository> = {}
): GitHubWebhookRepository {
  return {
    id: REPO_ID,
    full_name: REPO_FULL_NAME,
    name: REPO_NAME,
    default_branch: DEFAULT_BRANCH,
    ...overrides,
  };
}

export function githubHeadRepository(
  overrides: Partial<GitHubWebhookHeadRepository> = {}
): GitHubWebhookHeadRepository {
  return {
    id: REPO_ID,
    full_name: REPO_FULL_NAME,
    name: REPO_NAME,
    owner: { login: REPO_OWNER },
    ...overrides,
  };
}

export function pullRequestPayload(input: {
  action?: string;
  branch?: string;
  headRepository?: Partial<GitHubWebhookHeadRepository> | null;
  merged?: boolean;
  repository?: Partial<GitHubWebhookRepository>;
} = {}): GitHubWebhookPayload {
  const action = input.action ?? "opened";
  const headRepository = input.headRepository === null
    ? null
    : githubHeadRepository(input.headRepository);
  return {
    action,
    repository: githubRepository(input.repository),
    pull_request: {
      number: PR_NUMBER,
      title: "task_42: git room branch routing",
      html_url: PR_URL,
      ...(input.merged === undefined ? {} : {
        state: input.merged ? "closed" : "open",
        merged: input.merged,
      }),
      head: {
        ref: input.branch ?? WEBHOOK_BRANCH,
        sha: "abc123",
        ...(headRepository ? { repo: headRepository } : {}),
      },
      base: { ref: DEFAULT_BRANCH },
    },
  };
}

export function pushPayload(ref: string): GitHubWebhookPayload {
  return {
    ref,
    before: "111",
    after: "222",
    repository: githubRepository(),
  };
}

export function branchRefPayload(action: string): GitHubWebhookPayload {
  return {
    action,
    ref: WEBHOOK_BRANCH,
    ref_type: "branch",
    repository: githubRepository(),
  };
}

export function gitFocusRoom(overrides: Partial<Project> = {}): Project {
  return {
    id: WEBHOOK_BRANCH_ROOM_ID,
    code: null,
    display_name: `Branch: ${WEBHOOK_BRANCH}`,
    name: null,
    kind: "focus",
    parent_room_id: REPO_ROOM_ID,
    focus_key: WEBHOOK_BRANCH_FOCUS_KEY,
    source_task_id: null,
    focus_status: "active",
    focus_parent_visibility: null,
    focus_activity_scope: null,
    focus_github_event_routing: null,
    focus_archived_at: null,
    git_lifecycle_event_order_at: null,
    concluded_at: null,
    conclusion_summary: null,
    conclusion_details: null,
    created_at: "2026-06-28T10:00:00.000Z",
    ...overrides,
  };
}

export function lifecycleDeps(
  overrides: Partial<GitHubRefRoomLifecycleDeps> = {}
): { calls: unknown[]; deps: GitHubRefRoomLifecycleDeps } {
  const calls: unknown[] = [];
  return {
    calls,
    deps: {
      claimGitRefFocusRoomLifecycleEvent: async () => gitFocusRoom(),
      activateFocusRoom: async (...args) => calls.push(["activate", args]),
      archiveFocusRoom: async (...args) => calls.push(["archive", args]),
      concludeFocusRoom: async (...args) => calls.push(["conclude", args]),
      ...overrides,
    },
  };
}

export function repoBinding(overrides: Partial<GitRoomBinding> = {}): GitRoomBinding {
  return {
    room_id: "github.com/BrosInCode/letagents",
    provider: "github",
    host: "github.com",
    repository_id: "123",
    repository_full_name: REPO_FULL_NAME,
    repository_owner: REPO_OWNER,
    repository_name: REPO_NAME,
    ref_type: "default_branch",
    ref_name: DEFAULT_BRANCH,
    default_branch: DEFAULT_BRANCH,
    base_ref: null,
    head_ref: null,
    head_repository_id: null,
    head_repository_full_name: null,
    head_repository_owner: null,
    head_repository_name: null,
    visibility: "private",
    is_default: true,
    source: "github_repository",
    created_at: "2026-06-28T10:00:00.000Z",
    updated_at: "2026-06-28T10:00:00.000Z",
    ...overrides,
  };
}

export function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "focus_1",
    code: null,
    display_name: "Focus: Git Rooms",
    name: null,
    kind: "focus",
    parent_room_id: "github.com/BrosInCode/letagents",
    focus_key: "task_1",
    source_task_id: "task_1",
    focus_status: "active",
    focus_parent_visibility: null,
    focus_activity_scope: null,
    focus_github_event_routing: null,
    focus_archived_at: null,
    git_lifecycle_event_order_at: null,
    concluded_at: null,
    conclusion_summary: null,
    conclusion_details: null,
    created_at: "2026-06-28T10:00:00.000Z",
    ...overrides,
  };
}

export function workLease(branchRef: string): TaskLease {
  return {
    id: "lease_1",
    room_id: "github.com/BrosInCode/letagents",
    task_id: "task_1",
    kind: "work",
    status: "active",
    agent_key: "EmmyMay/timbercalm",
    agent_instance_id: null,
    agent_session_id: null,
    actor_label: "TimberCalm",
    branch_ref: branchRef,
    pr_url: null,
    output_intent: "Git Rooms",
    created_by: "TimberCalm",
    revoked_reason: null,
    expires_at: null,
    last_heartbeat_at: null,
    created_at: "2026-06-28T10:00:00.000Z",
    updated_at: "2026-06-28T10:00:00.000Z",
  };
}
