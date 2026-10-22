import type { RoomSharedArtifactDetail } from "../db/schema/artifacts.js";

export type {
  RoomSharedArtifactChangedFile,
  RoomSharedArtifactChangeSummaryDetail,
  RoomSharedArtifactDetail,
} from "../db/schema/artifacts.js";

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
  draft?: boolean;
  authorLogin?: string | null;
  /** The author's immutable GitHub user id, when the webhook carried it. */
  authorId?: string | null;
  /** GitHub's `author_association` for the pull request's author. */
  authorAssociation?: string | null;
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
  /** GitHub's `author_association` for the reviewer. */
  authorAssociation?: string | null;
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

export interface RepoPushRef {
  ref: string;
  refType: string;
  beforeSha?: string | null;
  afterSha?: string | null;
  compareUrl?: string | null;
  headCommitMessage?: string | null;
}

export interface RepoBranchRef {
  ref: string;
  refType: string;
  defaultBranch?: string | null;
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

/** A reviewer or assignee that GitHub added to or removed from a pull request. */
export interface RepoPullRequestParticipant {
  role: "reviewer" | "assignee";
  change: "added" | "removed";
  /** The GitHub login of a person. Null for a team. */
  login: string | null;
  github_user_id: string | null;
  team_slug: string | null;
  team_name: string | null;
}

export interface RepoPullRequestParticipantEvent extends RepoRoomEventBase {
  kind: "pull_request_participant";
  pullRequest: RepoPullRequestRef;
  participant: RepoPullRequestParticipant;
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

export interface RepoPushEvent extends RepoRoomEventBase {
  kind: "push";
  push: RepoPushRef;
}

export interface RepoBranchLifecycleEvent extends RepoRoomEventBase {
  kind: "branch_ref";
  branch: RepoBranchRef;
}

export type RepoRoomEvent =
  | RepoPullRequestEvent
  | RepoPullRequestParticipantEvent
  | RepoIssueEvent
  | RepoIssueCommentEvent
  | RepoPullRequestReviewEvent
  | RepoCheckRunEvent
  | RepoRepositoryEvent
  | RepoPushEvent
  | RepoBranchLifecycleEvent;

export type TaskWorkflowRefProvider = RepoWorkflowProvider | "git" | "unknown";
export type TaskWorkflowArtifactKind =
  | "issue"
  | "branch"
  | "commit"
  | "diff"
  | "change_summary"
  | "pull_request"
  | "merge_request"
  | "review"
  | "check_run"
  | "merge";
export type TaskWorkflowRefKind = TaskWorkflowArtifactKind;

export type TaskWorkflowArtifactLinkMark = "ticket_key" | "jev_suggested" | "jev_confirmed";

export interface TaskWorkflowArtifact {
  provider: TaskWorkflowRefProvider;
  kind: TaskWorkflowArtifactKind;
  id?: string | null;
  number?: number | null;
  title?: string | null;
  url?: string | null;
  ref?: string | null;
  state?: string | null;
  detail?: RoomSharedArtifactDetail | null;
  /**
   * Set by the server when a ticket key, not a lease or an explicit link,
   * attached this pull request to the card (`ticket_key`), or when Jev
   * suggested the link (`jev_suggested`) and a person confirmed it
   * (`jev_confirmed`). Never accepted from a client.
   */
  linked_by?: TaskWorkflowArtifactLinkMark | null;
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
