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
}

export interface DesktopFocusRoomInfo {
  roomId: string;
  identifier: string;
  displayName: string;
  code: string | null;
  sourceTaskId: string | null;
  focusStatus: "active" | "concluded" | null;
  createdAt: string;
}

export interface DesktopRoomMessageReply {
  id: string;
  sender: string;
  text: string;
  source: string | null;
  timestamp: string;
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
  } | null;
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

export interface DesktopRoomSnapshot {
  roomIdentifier: string | null;
  access: DesktopRoomAccess;
  room: DesktopRoomInfo | null;
  focusRooms: DesktopFocusRoomInfo[];
  tasks: DesktopTaskSummary[];
  participants: DesktopParticipantSummary[];
  participantHiddenCount: number;
  presence: DesktopAgentPresence[];
  reasoningSessions: DesktopReasoningSession[];
  recentActivity: DesktopActivityEntry[];
  messages: DesktopRoomMessage[];
}

export interface DesktopSendRoomMessageResult {
  message: DesktopRoomMessage;
}

export interface DesktopRoomMessagesPage {
  messages: DesktopRoomMessage[];
  hasOlder: boolean;
}

export interface DesktopRoomLatestMessage {
  roomIdentifier: string;
  latestMessageId: string | null;
  latestMessageAt: string | null;
}

export interface DesktopChatStorageSettings {
  mode: "cloud" | "local";
  databasePath: string;
  settingsPath: string;
  savedAt: string;
}

export interface DesktopLocalChatSyncResult {
  roomIdentifier: string;
  syncedCount: number;
  skippedCount: number;
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
