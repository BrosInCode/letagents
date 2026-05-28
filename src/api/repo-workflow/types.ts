export type RepoWorkflowProvider = "github" | "gitlab" | "bitbucket";

export interface RepoRoomRef {
  provider: RepoWorkflowProvider;
  host: string;
  namespace: string;
  repo: string;
  fullName: string;
}

export interface RepoPullRequestRef {
  number: number;
  title: string;
  url: string;
  body?: string | null;
  headRef?: string | null;
  headSha?: string | null;
  merged?: boolean;
  authorLogin?: string | null;
  mergedByLogin?: string | null;
}

export interface RepoIssueRef {
  number: number;
  title: string;
  url: string;
  isPullRequest?: boolean;
}

export interface RepoIssueCommentRef {
  body: string;
  url: string;
}

export interface RepoReviewRef {
  id: string;
  state: string;
  url: string;
  body?: string | null;
}

export interface RepoCheckRunRef {
  id: string;
  suiteId?: number | null;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  appName?: string | null;
}

export interface RepoRoomEventBase {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  senderLogin?: string | null;
}

export interface RepoPullRequestEvent extends RepoRoomEventBase {
  kind: "pull_request";
  pullRequest: RepoPullRequestRef;
}

export interface RepoIssueEvent extends RepoRoomEventBase {
  kind: "issue";
  issue: RepoIssueRef;
}

export interface RepoIssueCommentEvent extends RepoRoomEventBase {
  kind: "issue_comment";
  issue: RepoIssueRef;
  comment: RepoIssueCommentRef;
}

export interface RepoPullRequestReviewEvent extends RepoRoomEventBase {
  kind: "pull_request_review";
  pullRequest: RepoPullRequestRef;
  review: RepoReviewRef;
}

export interface RepoCheckRunEvent extends RepoRoomEventBase {
  kind: "check_run";
  checkRun: RepoCheckRunRef;
}

export interface RepoRepositoryEvent extends RepoRoomEventBase {
  kind: "repository";
  oldFullName?: string | null;
}

export type RepoRoomEvent =
  | RepoPullRequestEvent
  | RepoIssueEvent
  | RepoIssueCommentEvent
  | RepoPullRequestReviewEvent
  | RepoCheckRunEvent
  | RepoRepositoryEvent;

export type TaskWorkflowRefProvider = RepoWorkflowProvider | "unknown";
export type TaskWorkflowArtifactKind =
  | "issue"
  | "branch"
  | "pull_request"
  | "merge_request"
  | "review"
  | "check_run"
  | "merge";
export type TaskWorkflowRefKind = TaskWorkflowArtifactKind;

export interface TaskWorkflowArtifact {
  provider: TaskWorkflowRefProvider;
  kind: TaskWorkflowArtifactKind;
  id?: string | null;
  number?: number | null;
  title?: string | null;
  url?: string | null;
  ref?: string | null;
  state?: string | null;
}

export interface TaskWorkflowArtifactMatch {
  provider: TaskWorkflowRefProvider;
  kind: TaskWorkflowArtifactKind;
  id?: string | null;
  number?: number | null;
  title?: string | null;
  url?: string | null;
  ref?: string | null;
}

export interface TaskWorkflowRef {
  provider: TaskWorkflowRefProvider;
  kind: TaskWorkflowRefKind;
  label: string;
  url: string;
}
