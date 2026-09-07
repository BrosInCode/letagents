import type { DesktopActivityEntry, DesktopAgentPresence, DesktopParticipantSummary, DesktopReasoningSession } from "./activity.js";
import type { RepoStatus } from "./core.js";
import type { DesktopRentalActivityEvent, DesktopRentalOwnQuotaStatus, DesktopRentalRenterTriggerSignal } from "./rental.js";
import type { DesktopTaskSummary } from "./tasks.js";
import type {
  ClearedRoomAgentWorkSummary,
  RoomAgentWorkSummary,
} from "../../../../shared/room-agent-work.mjs";

export interface DesktopRoomAgentWork {
  attemptId: string;
  roomId: string;
  sourceMessageId: string;
  agentKey: string;
  revision: number;
  summary: RoomAgentWorkSummary | ClearedRoomAgentWorkSummary;
  updatedAt: string;
}

export interface DesktopRoomAgentWorkSnapshot {
  work: DesktopRoomAgentWork[];
  truncated: boolean;
}

export type DesktopRoomAgentWorkPollResponse = {
  roomId: string;
  cursor: string;
} & (
  | { changed: true; snapshot: DesktopRoomAgentWorkSnapshot }
  | { changed: false; snapshot: null }
);

export type DesktopRoomAgentWorkPollResult =
  | { status: "ready"; response: DesktopRoomAgentWorkPollResponse }
  | { status: "local" | "access_revoked" | "invalid"; response: null };

export interface DesktopRoomAccess {
  status: "ready" | "missing_room" | "auth_required" | "forbidden" | "unavailable";
  title: string;
  message: string;
  roomIdentifier: string | null;
  deviceFlowUrl: string | null;
  code: string | null;
  httpStatus: number | null;
}

export interface DesktopRoomInfo {
  identifier: string;
  code: string;
  name: string;
  displayName: string;
  role: string;
  authenticated: boolean;
  kind: "main" | "focus";
  parentRoomId: string | null;
  focusKey: string | null;
  sourceTaskId: string | null;
  focusStatus: "active" | "concluded" | null;
  focusParentVisibility: DesktopFocusParentVisibility | null;
  focusActivityScope: DesktopFocusActivityScope | null;
  focusGitHubEventRouting: DesktopFocusGitHubEventRouting | null;
  focusSettings: DesktopFocusRoomSettings | null;
  focusArchivedAt: string | null;
  concludedAt: string | null;
  conclusionSummary: string | null;
  conclusionDetails: DesktopFocusRoomConclusionDetails | null;
  gitRoom: DesktopGitRoomInfo | null;
}

export type DesktopRoomSharedArtifactProvider =
  | "git"
  | "github"
  | "gitlab"
  | "bitbucket"
  | "unknown";
export type DesktopRoomSharedArtifactKind =
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
export type DesktopRoomSharedArtifactSource =
  | "task_workflow_artifact"
  | "github_event"
  | "manual";

// Structured per-artifact detail, mirroring the API's RoomSharedArtifactDetail.
// Discriminated on `type` + `version`; only change_summary today. For change
// summaries this is file paths + counts (numstat) — never source code.
export interface DesktopRoomSharedArtifactChangedFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface DesktopRoomSharedArtifactChangeSummaryDetail {
  type: "change_summary";
  version: 1;
  changedFileCount: number;
  additions: number;
  deletions: number;
  stagedFileCount: number;
  unstagedFileCount: number;
  untrackedFileCount: number;
  hiddenFileCount: number;
  files: DesktopRoomSharedArtifactChangedFile[];
}

export type DesktopRoomSharedArtifactDetail = DesktopRoomSharedArtifactChangeSummaryDetail;

export interface DesktopRoomSharedArtifact {
  roomId: string;
  identityKey: string;
  provider: DesktopRoomSharedArtifactProvider;
  kind: DesktopRoomSharedArtifactKind;
  artifactId: string | null;
  artifactNumber: number | null;
  title: string | null;
  url: string | null;
  ref: string | null;
  state: string | null;
  detail: DesktopRoomSharedArtifactDetail | null;
  source: DesktopRoomSharedArtifactSource;
  firstSeenAt: string;
  updatedAt: string;
  linkedTaskIds: string[];
}

export type DesktopGitRoomVisibility = "public" | "private" | "local" | "unknown";
export type DesktopGitRoomRefType = "default_branch" | "branch" | "tag" | "pull_request";

export interface DesktopGitRoomRepositoryInfo {
  id: string | null;
  fullName: string;
  owner: string;
  name: string;
}

export interface DesktopGitRoomInfo {
  provider: string;
  host: string;
  repository: DesktopGitRoomRepositoryInfo;
  ref: {
    type: DesktopGitRoomRefType;
    name: string | null;
    defaultBranch: string | null;
    baseRef: string | null;
    headRef: string | null;
    headRepository: DesktopGitRoomRepositoryInfo | null;
  };
  visibility: DesktopGitRoomVisibility;
  accessMode: DesktopGitRoomVisibility;
  isDefault: boolean;
  source: string;
}

export type DesktopFocusParentVisibility =
  | "summary_only"
  | "major_activity"
  | "all_activity"
  | "silent";

export type DesktopFocusActivityScope = "task_and_branch" | "task_only" | "room";

export type DesktopFocusGitHubEventRouting =
  | "task_and_branch"
  | "focus_owned_only"
  | "task_only"
  | "all_parent_repo"
  | "off";

export interface DesktopFocusRoomSettings {
  parent_visibility: DesktopFocusParentVisibility;
  activity_scope: DesktopFocusActivityScope;
  github_event_routing: DesktopFocusGitHubEventRouting;
}

export type DesktopFocusRoomSettingsPatch = Partial<DesktopFocusRoomSettings>;

export type DesktopFocusRoomReviewState = "reviewed" | "needs_review" | "not_required";
export type DesktopFocusRoomBlockerState = "none" | "resolved" | "blocked";
export type DesktopFocusRoomParentTaskNextAction =
  | "keep_open"
  | "move_to_review"
  | "mark_blocked"
  | "mark_done"
  | "follow_up";

export interface DesktopFocusRoomConclusionDetails {
  artifact: string;
  review_state: DesktopFocusRoomReviewState;
  blocker_state: DesktopFocusRoomBlockerState;
  parent_task_next: DesktopFocusRoomParentTaskNextAction;
  next_owner: string;
}

export interface DesktopFocusRoomInfo {
  roomId: string;
  identifier: string;
  name: string | null;
  displayName: string;
  code: string | null;
  kind: "focus";
  attachmentsEnabled: boolean;
  parentRoomId: string | null;
  focusKey: string | null;
  sourceTaskId: string | null;
  focusStatus: "active" | "concluded" | null;
  focusParentVisibility: DesktopFocusParentVisibility | null;
  focusActivityScope: DesktopFocusActivityScope | null;
  focusGitHubEventRouting: DesktopFocusGitHubEventRouting | null;
  focusSettings: DesktopFocusRoomSettings | null;
  focusArchivedAt: string | null;
  concludedAt: string | null;
  conclusionSummary: string | null;
  conclusionDetails: DesktopFocusRoomConclusionDetails | null;
  gitRoom: DesktopGitRoomInfo | null;
  createdAt: string;
}

export interface DesktopFocusRoomMutationResult {
  focusRoom: DesktopFocusRoomInfo;
  created?: boolean;
  parentMessagePosted?: boolean;
}

export interface DesktopRoomMessageReply {
  id: string;
  sender: string;
  text: string;
  displayText?: string | null;
  source: string | null;
  timestamp: string;
  agentIdentity?: {
    name: string | null;
    displayName: string | null;
    ownerLabel: string | null;
    ownerAttribution: string | null;
    ideLabel: string | null;
    actorLabel: string | null;
    agentKey: string | null;
    agentSessionId: string | null;
  } | null;
}

export interface DesktopRoomMessageThreadParticipant {
  sender: string;
  source: string | null;
  messageCount: number;
  latestMessageId: string;
}

export interface DesktopRoomMessageThreadSummary {
  rootMessageId: string;
  replyCount: number;
  unreadCount: number;
  hasUnread: boolean;
  latestReply: DesktopRoomMessageReply | null;
  participants: DesktopRoomMessageThreadParticipant[];
  participantCount: number;
  participantsTruncated: boolean;
  lastReadMessageId: string | null;
}

export interface DesktopRoomMessageAttachment {
  id: string | null;
  name: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  url: string | null;
  downloadUrl: string | null;
  dataUrl: string | null;
  contentBase64: string | null;
}

/** Public Message-info projection (cloud rooms). Mirrors GET /rooms/:room/messages/:id/info. */
export interface DesktopMessageInfo {
  message: {
    id: string;
    sender: string;
    textPreview: string;
    timestamp: string;
    threadRootId: string;
    replyToId: string | null;
  };
  seenByPeople: Array<{ name: string; avatarUrl: string | null; seenAt: string }>;
  agentsAsked: Array<{
    receiptId: string;
    agentKey: string;
    actorLabel: string;
    activationReasonLabel: string;
    receiptState: string;
    observed: boolean;
    replyMessageId: string | null;
  }>;
  alsoObserved: Array<{ agentKey: string; displayName: string }>;
  summaryCounts: { seenCount: number; askedCount: number; replyCount: number; observedCount: number };
}

export interface DesktopRoomMessage {
  id: string;
  /** Exact idempotency identity supplied by the message publisher. */
  clientMessageId?: string | null;
  sender: string;
  text: string;
  displayText?: string | null;
  attachments: DesktopRoomMessageAttachment[];
  agentPromptKind: string | null;
  source: string | null;
  timestamp: string;
  actorLabel: string | null;
  agentIdentity: {
    name: string | null;
    displayName: string | null;
    ownerLabel: string | null;
    ownerAttribution: string | null;
    ideLabel: string | null;
    actorLabel: string | null;
    agentKey: string | null;
    agentSessionId: string | null;
  } | null;
  threadRootId: string;
  threadReplyToId: string | null;
  thread: DesktopRoomMessageThreadSummary | null;
  replyTo: DesktopRoomMessageReply | null;
  /** Trusted provenance retained only for local/forked dispatch decisions. */
  localControlAuthorized?: boolean;
  /** Account-scoped, non-rendered managed-agent dispatch metadata. */
  accountAgentRouting?:
    | {
      version: 1;
      authority: "receipts";
      recipientAgentKeys: string[];
      /** Exact receipt targets. Present-empty is authoritative. */
      recipientSessions: Array<{
        agentKey: string;
        agentSessionId: string;
        successorAgentSessionId?: string;
      }>;
      /** Missing on older servers and therefore treated as false. */
      controlAuthorized?: boolean;
    }
    | {
      version: 1;
      authority: "legacy";
      recipientAgentKeys: string[];
      /** Exact room-global targets. Present-empty is authoritative. */
      recipientSessions: Array<{
        agentKey: string;
        agentSessionId: string;
        activationReason: string;
      }>;
      /** Missing on older servers and therefore treated as false. */
      controlAuthorized?: boolean;
    }
    | { version: 1; authority: "invalid" };
}

export interface DesktopGitHubIntegrationStatus {
  roomId: string;
  accessRoomId: string | null;
  configured: boolean;
  setupManifestAvailable: boolean;
  connected: boolean;
  installUrlAvailable: boolean;
  repository: { fullName: string } | null;
}

export interface DesktopGitHubIntegrationActionResult {
  opened: boolean;
  message: string;
}

export type DesktopGitHubRoomEventType =
  | "pull_request"
  | "pull_request_review"
  | "issue"
  | "issue_comment"
  | "check_run"
  | "repository"
  | "installation"
  | "installation_repositories";

export interface DesktopGitHubRoomEvent {
  id: string;
  eventType: DesktopGitHubRoomEventType;
  action: string;
  githubObjectId: string | null;
  githubObjectUrl: string | null;
  title: string | null;
  state: string | null;
  actorLogin: string | null;
  metadata: Record<string, unknown>;
  linkedTaskId: string | null;
  createdAt: string;
}

export interface DesktopGitHubEventsQuery {
  limit?: number;
  after?: string | null;
  eventType?: DesktopGitHubRoomEventType | null;
  objectId?: string | null;
  actor?: string | null;
  since?: string | null;
  until?: string | null;
}

export interface DesktopGitHubEventsPage {
  roomIdentifier: string;
  githubRoomIdentifier: string | null;
  events: DesktopGitHubRoomEvent[];
  hasMore: boolean;
}

export interface DesktopBoardSettingsSummary {
  managerMode: "off" | "manager_optional" | "intent_required";
  activeManager: {
    agentSessionId: string;
    agentKey: string;
    actorLabel: string;
    runtimeSource: "desktop_managed" | "open_model" | "external" | "unknown";
  } | null;
  pendingIntentCount: number;
}

/**
 * Which room snapshot source a per-source status refers to. These mirror the
 * fields loaded by the snapshot fetcher so the UI can tell "genuinely empty"
 * apart from "this source failed to load".
 */
export type DesktopSnapshotSourceKey =
  | "focusRooms"
  | "tasks"
  | "participants"
  | "presence"
  | "reasoning"
  | "activityHistory"
  | "roomArtifacts"
  | "boardSettings"
  | "messages"
  | "githubEvents";

export interface DesktopSnapshotSourceState {
  status: "ready" | "error";
  /** Human-readable failure detail when status is "error"; null when ready. */
  error: string | null;
}

export type DesktopSnapshotSourceStates = Record<
  DesktopSnapshotSourceKey,
  DesktopSnapshotSourceState
>;

export interface DesktopRoomSnapshot {
  roomIdentifier: string | null;
  access: DesktopRoomAccess;
  room: DesktopRoomInfo | null;
  storage: DesktopRoomStorageState;
  focusRooms: DesktopFocusRoomInfo[];
  tasks: DesktopTaskSummary[];
  participants: DesktopParticipantSummary[];
  participantHiddenCount: number;
  presence: DesktopAgentPresence[];
  reasoningSessions: DesktopReasoningSession[];
  recentActivity: DesktopActivityEntry[];
  roomArtifacts: DesktopRoomSharedArtifact[];
  messages: DesktopRoomMessage[];
  githubEvents: DesktopGitHubEventsPage | null;
  boardSettings: DesktopBoardSettingsSummary;
  /**
   * Per-source load status for this snapshot. A source that failed to load is
   * marked "error" (with its data falling back to empty) so consumers can show
   * a degraded state instead of a false-empty view. Defaults to all-ready.
   */
  sourceStates: DesktopSnapshotSourceStates;
}

/** Durable snapshot deltas replayed only to managed agents after a live gap. */
export interface DesktopRoomDeliveryRepair {
  token: number;
  messages: DesktopRoomMessage[];
  tasks: DesktopTaskSummary[];
}

/**
 * Poll-only room metadata — the subset of a snapshot that the server pushes no
 * events for and must therefore be re-polled on a cadence: focus rooms,
 * participants, presence, recent activity, and board settings. Everything else
 * a room shows (messages, tasks, GitHub events, artifacts, reasoning) is
 * event-fed, so the periodic refresh fetches only these sections and applies
 * them onto the current snapshot, leaving the event-fed sections untouched.
 */
export type DesktopRoomLiveMetadataSourceKey = Extract<
  DesktopSnapshotSourceKey,
  "focusRooms" | "participants" | "presence" | "activityHistory" | "boardSettings"
>;

export type DesktopRoomLiveMetadataSourceStates = Record<
  DesktopRoomLiveMetadataSourceKey,
  DesktopSnapshotSourceState
>;

export interface DesktopRoomLiveMetadata {
  roomIdentifier: string | null;
  focusRooms: DesktopFocusRoomInfo[];
  participants: DesktopParticipantSummary[];
  participantHiddenCount: number;
  presence: DesktopAgentPresence[];
  recentActivity: DesktopActivityEntry[];
  boardSettings: DesktopBoardSettingsSummary;
  /**
   * Per-source load status for just the poll-only sections. A section that
   * failed to load is marked "error" (data falling back to empty) so the
   * renderer keeps its previously loaded data for that section instead of
   * blanking it — matching the full snapshot's graceful degradation.
   */
  sourceStates: DesktopRoomLiveMetadataSourceStates;
}

export interface DesktopSendRoomMessageResult {
  message: DesktopRoomMessage;
}

export interface DesktopRoomMessagesPage {
  messages: DesktopRoomMessage[];
  hasOlder: boolean;
}

export interface DesktopRoomThreadPage {
  root: DesktopRoomMessage;
  replies: DesktopRoomMessage[];
  summary: DesktopRoomMessageThreadSummary;
  hasOlder: boolean;
}

export type DesktopRoomThreadInboxFilter = "all" | "unread";

export interface DesktopRoomThreadInboxItem {
  root: DesktopRoomMessage;
  summary: DesktopRoomMessageThreadSummary;
}

export interface DesktopRoomThreadInboxPage {
  threads: DesktopRoomThreadInboxItem[];
  hasMore: boolean;
  unreadThreadCount: number;
}

export interface DesktopRoomThreadReadResult {
  thread: DesktopRoomMessageThreadSummary;
}

export interface DesktopRoomLatestMessage {
  roomIdentifier: string;
  latestMessageId: string | null;
  latestMessageAt: string | null;
}

export interface DesktopChatStorageSettings {
  mode: "cloud" | "local";
  defaultMode: "cloud" | "local";
  roomOverrides: Record<string, DesktopRoomStorageOverrideMode>;
  databasePath: string;
  localFilesPath: string;
  settingsPath: string;
  savedAt: string;
}

export type DesktopRoomStorageOverrideMode = "inherit" | "cloud" | "local";

export interface DesktopRoomStorageState {
  roomIdentifier: string | null;
  defaultMode: "cloud" | "local";
  overrideMode: DesktopRoomStorageOverrideMode;
  effectiveMode: "cloud" | "local";
  isLocalRoom: boolean;
  localRoom: DesktopLocalRoomInfo | null;
  databasePath: string;
  localFilesPath: string;
}

export interface DesktopLocalRoomInfo {
  roomIdentifier: string;
  displayName: string;
  cloudRoomIdentifier: string | null;
  publishStatus: "local_only" | "linked";
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  gitRoom: DesktopGitRoomInfo | null;
}

export interface DesktopLocalChatSyncResult {
  roomIdentifier: string;
  cloudRoomIdentifier: string | null;
  syncedCount: number;
  skippedCount: number;
  syncedTaskCount: number;
  skippedTaskCount: number;
}

export interface DesktopLocalRoomMutationResult {
  roomIdentifier: string;
  snapshot: DesktopRoomSnapshot;
}

export type DesktopRoomStreamEvent =
  | {
      type: "open";
      roomIdentifier: string;
      /** Durable message checkpoint established after server listeners attach. */
      checkpoint?: string | null;
      /** True only when the requested cursor cannot be reconciled incrementally. */
      gap?: boolean;
      /** True when this boundary came from the server room_sync handshake. */
      verified?: boolean;
      /** Correlates an authoritative snapshot with a verified broker gap. */
      deliveryRepairToken?: number;
    }
  | {
      type: "message";
      roomIdentifier: string;
      message: DesktopRoomMessage;
    }
  | {
      /** Bounded authoritative tail used after a very large durable catch-up. */
      type: "message_window";
      roomIdentifier: string;
      messages: DesktopRoomMessage[];
    }
  | {
      /** One durable-history page, merged in one renderer pass. */
      type: "message_batch";
      roomIdentifier: string;
      messages: DesktopRoomMessage[];
    }
  | {
      type: "task_update";
      roomIdentifier: string;
      task: DesktopTaskSummary;
    }
  | {
      type: "github_event";
      roomIdentifier: string;
      event: DesktopGitHubRoomEvent;
    }
  | {
      type: "artifact_update";
      roomIdentifier: string;
      artifactIdentityKey: string | null;
      artifact?: DesktopRoomSharedArtifact | null;
    }
  | {
      type: "reasoning_update";
      roomIdentifier: string;
      session: DesktopReasoningSession;
    }
  | {
      type: "reasoning_remove";
      roomIdentifier: string;
      sessionId: string;
    }
  | {
      type: "resource_invalidation";
      roomIdentifier: string;
      resource: "agent_work";
    }
  | {
      type: "rental_activity";
      roomIdentifier: string;
      activity: DesktopRentalActivityEvent;
    }
  | {
      type: "rental_patch";
      roomIdentifier: string;
      activity: DesktopRentalActivityEvent | null;
      patchId: string | null;
    }
  | {
      type: "rental_usage";
      roomIdentifier: string;
      activity: DesktopRentalActivityEvent | null;
      sessionId: string | null;
    }
  | {
      type: "rental_quota_exhausted";
      roomIdentifier: string;
      signal: DesktopRentalRenterTriggerSignal;
      status: DesktopRentalOwnQuotaStatus;
    }
  | {
      type: "session_disconnect" | "error";
      roomIdentifier: string;
      message: string | null;
    };

export interface DesktopStagedAttachment {
  uploadId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  previewDataUrl: string | null;
}

export interface DesktopDroppedAttachmentContent {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentBase64: string;
}

export interface DesktopRepoRoomSelection {
  canceled: boolean;
  repoPath: string | null;
  repoStatus: RepoStatus | null;
  roomIdentifier: string | null;
  source: "configured" | "git_remote" | "local_git" | "local_folder" | null;
  snapshot: DesktopRoomSnapshot | null;
  error: string | null;
  warning: string | null;
  projectBinding: DesktopProjectBinding | null;
}

export type DesktopProjectBindingSource =
  | "configured"
  | "git_remote"
  | "local_git"
  | "local_folder";

/**
 * Device-local context used to resolve a room to its project folder. Branch and
 * focus room identifiers are aliases of the same project, never independent
 * folder selections.
 */
export interface DesktopProjectBindingContext {
  roomIdentifier?: string | null;
  gitRoom?: DesktopGitRoomInfo | null;
}

/** The durable, device-local representation of a project room. */
export interface DesktopProjectBinding {
  id: string;
  /** Immutable room-side identity used to replace, never merge, bindings. */
  identityKey: string;
  /** Filesystem-derived identities that must still match before use. */
  verificationKeys: string[];
  aliases: string[];
  rootPath: string;
  source: DesktopProjectBindingSource;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopLegacyProjectBindingCandidate {
  legacyKey?: string | null;
  context: DesktopProjectBindingContext;
  rootPath: string;
}

export interface DesktopProjectBindingMigrationResult {
  bindings: DesktopProjectBinding[];
  retryLegacyKeys: string[];
}

export interface DesktopProjectConnectionResult {
  canceled: boolean;
  binding: DesktopProjectBinding | null;
  repoStatus: RepoStatus | null;
  error: string | null;
}

export interface DesktopInviteRoomCreation {
  roomIdentifier: string;
  code: string;
  snapshot: DesktopRoomSnapshot;
}

export interface DesktopAccountFocusRoomEntry {
  roomIdentifier: string;
  displayName: string;
  name: string;
  kind: "focus";
  parentRoomId: string | null;
  focusKey: string | null;
  sourceTaskId: string | null;
  focusStatus: "active" | "concluded" | null;
  role: "admin" | "participant";
  source: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  latestMessageId: string | null;
  latestMessageAt: string | null;
  gitRoom: DesktopGitRoomInfo | null;
}

export interface DesktopAccountRoomEntry {
  roomIdentifier: string;
  displayName: string;
  name: string;
  kind: "main";
  parentRoomId: string | null;
  focusKey: string | null;
  sourceTaskId: string | null;
  focusStatus: "active" | "concluded" | null;
  role: "admin" | "participant";
  source: string | null;
  pinned: boolean;
  archived: boolean;
  canLeave: boolean;
  canDelete: boolean;
  deleteReason: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  latestMessageId: string | null;
  latestMessageAt: string | null;
  gitRoom: DesktopGitRoomInfo | null;
  focusRooms: DesktopAccountFocusRoomEntry[];
}

export interface DesktopAccountRoomActionResult {
  roomIdentifier: string;
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
}

export interface DesktopAccountRoomListOptions {
  includeArchived?: boolean;
  limit?: number;
}
