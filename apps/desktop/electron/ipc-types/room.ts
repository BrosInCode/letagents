import type { DesktopActivityEntry, DesktopAgentPresence, DesktopParticipantSummary, DesktopReasoningSession } from "./activity.js";
import type { RepoStatus } from "./core.js";
import type { DesktopRentalActivityEvent, DesktopRentalOwnQuotaStatus, DesktopRentalRenterTriggerSignal } from "./rental.js";
import type { DesktopTaskSummary } from "./tasks.js";

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
  source: string | null;
  timestamp: string;
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

export interface DesktopRoomMessage {
  id: string;
  sender: string;
  text: string;
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
  messages: DesktopRoomMessage[];
  githubEvents: DesktopGitHubEventsPage | null;
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
    }
  | {
      type: "message";
      roomIdentifier: string;
      message: DesktopRoomMessage;
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
  source: "configured" | "git_remote" | "local_fallback" | null;
  snapshot: DesktopRoomSnapshot | null;
  error: string | null;
  warning: string | null;
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
