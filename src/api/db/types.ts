import type { FocusRoomConclusionDetails } from "../focus-room-conclusion.js";
import type { FocusActivityScope, FocusGitHubEventRouting, FocusParentVisibility } from "../focus-room-settings.js";
import type { TaskWorkflowArtifact, TaskWorkflowRef } from "../repo-workflow.js";
import type { CoordinationEventMetadata, GitHubRoomEventMetadata, GitHubRoomEventType, ReasoningSnapshot } from "./schema.js";
import type { AgentPresenceFreshness, AgentPresenceStatus, RoomAgentDeliveryTransport, RoomAgentSessionKind } from "../../shared/agent-presence.js";
import type { RoomActivitySourceFlag, RoomAgentActivityState } from "../../shared/room-agent-activity.js";
import type { AgentPromptKind } from "../../shared/room-agent-prompts.js";

export type RoomKind = "main" | "focus";

export type FocusRoomStatus = "active" | "concluded";

export interface Project {
  id: string;
  code: string | null;
  display_name: string;
  name?: string;
  kind: RoomKind;
  parent_room_id: string | null;
  focus_key: string | null;
  source_task_id: string | null;
  focus_status: FocusRoomStatus | null;
  focus_parent_visibility: FocusParentVisibility | null;
  focus_activity_scope: FocusActivityScope | null;
  focus_github_event_routing: FocusGitHubEventRouting | null;
  concluded_at: string | null;
  conclusion_summary: string | null;
  conclusion_details: FocusRoomConclusionDetails | null;
  created_at: string;
}

export interface RoomAlias {
  alias: string;
  room_id: string;
  created_at: string;
}

export interface GitHubRepositoryLink {
  github_repo_id: string;
  room_id: string;
  owner_login: string;
  repo_name: string;
  full_name: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubAppInstallation {
  installation_id: string;
  target_type: string;
  target_login: string;
  target_github_id: string;
  repository_selection: string;
  permissions_json: string | null;
  suspended_at: string | null;
  uninstalled_at: string | null;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubAppRepository {
  github_repo_id: string;
  installation_id: string;
  owner_login: string;
  repo_name: string;
  full_name: string;
  room_id: string;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type GitHubWebhookDeliveryStatus = "received" | "processed" | "ignored" | "failed";

export interface GitHubWebhookDelivery {
  delivery_id: string;
  event_name: string;
  action: string | null;
  installation_id: string | null;
  github_repo_id: string | null;
  room_id: string | null;
  status: GitHubWebhookDeliveryStatus;
  error: string | null;
  received_at: string;
  processed_at: string | null;
}

export interface Account {
  id: string;
  provider: string;
  provider_user_id: string;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  account_id: string;
  token_hash: string;
  provider_access_token: string | null;
  expires_at: string;
  created_at: string;
}

export interface SessionAccount extends Session {
  provider: string;
  provider_user_id: string;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface OwnerToken {
  token_id: string;
  account_id: string;
  github_user_id: string;
  token_hash: string;
  provider_access_token: string | null;
  oauth_token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OwnerTokenAccount extends OwnerToken {
  provider: string;
  provider_user_id: string;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface AuthState {
  id: string;
  state: string;
  redirect_to: string | null;
  expires_at: string;
  created_at: string;
}

export interface AgentIdentity {
  id: string;
  canonical_key: string;
  name: string;
  display_name: string;
  owner_account_id: string;
  owner_login: string;
  owner_label: string;
  created_at: string;
  updated_at: string;
}

export interface RoomAgentPresence {
  room_id: string;
  actor_label: string;
  agent_key: string | null;
  agent_instance_id: string | null;
  agent_session_id: string | null;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  display_name: string;
  owner_label: string | null;
  ide_label: string | null;
  status: AgentPresenceStatus;
  status_text: string | null;
  last_heartbeat_at: string;
  created_at: string;
  updated_at: string;
  freshness: AgentPresenceFreshness;
  activity_state: RoomAgentActivityState;
  source_flags: RoomActivitySourceFlag[];
  liveness_observation: RoomAgentLivenessObservation | null;
}

export interface RoomAgentRegistrationLiveness {
  host_id?: string | null;
  host_kind?: string | null;
  host_label?: string | null;
  liveness_capability?: string | null;
  tool_bridge_id?: string | null;
}

export interface RoomAgentLivenessObservation {
  room_id: string;
  agent_session_id: string;
  source: string;
  host_id: string | null;
  host_kind: string | null;
  host_label: string | null;
  liveness_capability: string;
  tool_bridge_id: string | null;
  last_observed_at: string;
  last_tool_call_at: string | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoomAgentDeliverySession {
  room_id: string;
  delivery_key: string;
  actor_label: string;
  agent_key: string | null;
  agent_instance_id: string | null;
  agent_session_id: string | null;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  display_name: string;
  owner_label: string | null;
  ide_label: string | null;
  transport: RoomAgentDeliveryTransport;
  active_connection_count: number;
  last_connected_at: string;
  last_disconnected_at: string | null;
  reconnect_grace_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoomAgentSession {
  session_id: string;
  room_id: string;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  host_id: string | null;
  host_kind: string | null;
  host_label: string | null;
  liveness_capability: string | null;
  tool_bridge_id: string | null;
  actor_label: string;
  agent_key: string;
  agent_instance_id: string | null;
  display_name: string;
  owner_account_id: string;
  owner_label: string;
  ide_label: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  ended_at: string | null;
}

export interface CreatedRoomAgentSession extends RoomAgentSession {
  session_token: string;
}

export interface RoomParticipant {
  room_id: string;
  participant_key: string;
  kind: "human" | "agent";
  actor_label: string | null;
  agent_key: string | null;
  github_login: string | null;
  display_name: string;
  owner_label: string | null;
  ide_label: string | null;
  hidden_at: string | null;
  hidden_by: string | null;
  last_seen_at: string;
  last_room_activity_at: string | null;
  last_live_heartbeat_at: string | null;
  activity_state: RoomAgentActivityState | null;
  source_flags: RoomActivitySourceFlag[];
  created_at: string;
  updated_at: string;
}

export interface RoomActivityActorCount {
  actor_label: string;
  count: number;
}

export interface ReasoningSession {
  id: string;
  room_id: string;
  task_id: string | null;
  anchor_message_id: string | null;
  actor_label: string;
  agent_key: string | null;
  status: AgentPresenceStatus | null;
  summary: string;
  latest_payload: ReasoningSnapshot;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface ReasoningSessionUpdate {
  id: string;
  room_id: string;
  session_id: string;
  actor_label: string;
  status: AgentPresenceStatus | null;
  summary: string;
  milestone: string | null;
  payload: ReasoningSnapshot;
  created_at: string;
}

export interface Message {
  id: string;
  sender: string;
  text: string;
  agent_prompt_kind: AgentPromptKind | null;
  source: string | null;
  timestamp: string;
  reply_to: MessageReplyReference | null;
  attachments: MessageAttachment[];
}

export interface MessageReplyReference {
  id: string;
  sender: string;
  text: string;
  source: string | null;
  timestamp: string;
}

export interface MessageAttachment {
  id: string;
  filename: string;
  file_name: string;
  content_type: string;
  mime_type: string;
  byte_size: number;
  size_bytes: number;
  download_url: string;
}

export interface MessageAttachmentData extends MessageAttachment {
  storage_provider: string;
  bucket: string;
  object_key: string;
}

export interface MessageAttachmentUpload {
  upload_id: string;
  room_id: string;
  filename: string;
  content_type: string;
  byte_size: number;
  storage_provider: string;
  bucket: string;
  object_key: string;
  status: "pending" | "attached";
  expires_at: string;
  attached_message_number: number | null;
  created_at: string;
  attached_at: string | null;
}

export type TaskStatus =
  | "proposed"
  | "accepted"
  | "assigned"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "merged"
  | "done"
  | "cancelled";

export type TaskLeaseKind = "work" | "review";

export type TaskLeaseStatus = "active" | "released" | "revoked" | "expired";

export type TaskLockScope = "room" | "task";

export type TaskLockReason = "human_stop" | "duplicate" | "manager_pause" | "revoked" | "policy";

export type CoordinationDecision = "allow" | "deny" | "record";

export interface Task {
  id: string;
  room_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee: string | null;
  assignee_agent_key: string | null;
  created_by: string;
  source_message_id: string | null;
  pr_url: string | null;
  workflow_artifacts: TaskWorkflowArtifact[];
  workflow_refs: TaskWorkflowRef[];
  created_at: string;
  updated_at: string;
  stale_prompt_state?: TaskStalePromptState | null;
  active_leases?: TaskLease[];
  active_locks?: TaskLock[];
}

export interface TaskStalePromptState {
  is_stale: boolean;
  reason: string | null;
  stale_for_ms: number | null;
  muted: boolean;
  muted_by: string | null;
  muted_at: string | null;
}

export interface TaskLease {
  id: string;
  room_id: string;
  task_id: string;
  kind: TaskLeaseKind;
  status: TaskLeaseStatus;
  agent_key: string;
  agent_instance_id: string | null;
  agent_session_id: string | null;
  actor_label: string;
  branch_ref: string | null;
  pr_url: string | null;
  output_intent: string | null;
  expires_at: string | null;
  last_heartbeat_at: string | null;
  revoked_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TaskLock {
  id: string;
  room_id: string;
  task_id: string | null;
  scope: TaskLockScope;
  reason: TaskLockReason;
  message: string | null;
  created_by: string;
  created_at: string;
  cleared_by: string | null;
  cleared_at: string | null;
}

export interface StaleTaskPromptMute {
  room_id: string;
  task_id: string;
  task_updated_at: string;
  muted_by: string;
  created_at: string;
  updated_at: string;
}

export interface CoordinationEvent {
  id: string;
  room_id: string;
  task_id: string | null;
  lease_id: string | null;
  lock_id: string | null;
  event_type: string;
  decision: CoordinationDecision;
  actor_label: string | null;
  actor_key: string | null;
  actor_instance_id: string | null;
  reason: string | null;
  metadata: CoordinationEventMetadata | null;
  created_at: string;
}

export interface TaskOwnershipState {
  status: TaskStatus;
  assignee: string | null;
  assignee_agent_key: string | null;
}

export type TaskWorkLeaseActionConflict = "task_not_found" | "lease_not_active" | "target_unreachable";

// ── GitHub Room Events ──────────────────────────────────────────────────────

export interface GitHubRoomEvent {
  id: string;
  room_id: string | null;
  delivery_id: string | null;
  event_type: GitHubRoomEventType;
  action: string;
  idempotency_key: string;
  github_object_id: string | null;
  github_object_url: string | null;
  title: string | null;
  state: string | null;
  actor_login: string | null;
  metadata: GitHubRoomEventMetadata | null;
  linked_task_id: string | null;
  created_at: string;
}

/**
 * GitHub artifact status summary for a single task.
 * Materialized from github_room_events linked to the task.
 */
export interface TaskGitHubArtifactStatus {
  task_id: string;
  pr_state: string | null;
  pr_title: string | null;
  pr_url: string | null;
  pr_number: string | null;
  pr_author: string | null;
  pr_actor: string | null;
  pr_draft: boolean | null;
  pr_merged: boolean | null;
  checks: Array<{
    name: string;
    conclusion: string | null;
    state: string | null;
    actor: string | null;
  }>;
  reviews: Array<{
    actor: string | null;
    state: string | null;
  }>;
  check_summary: {
    total: number;
    success: number;
    failure: number;
    pending: number;
  };
  review_summary: {
    total: number;
    approved: number;
    changes_requested: number;
  };
}

export interface MessageRow {
  room_id: string;
  number: number;
  reply_to_number: number | null;
  sender: string;
  text: string;
  agent_prompt_kind: string | null;
  source: string | null;
  timestamp: string;
}

export interface MessageAttachmentRow {
  room_id: string;
  message_number: number;
  attachment_number: number;
  upload_id: string;
  filename: string;
  content_type: string;
  byte_size: number;
  storage_provider: string;
  bucket: string;
  object_key: string;
  created_at: string;
}

export interface MessageAttachmentUploadRow {
  upload_id: string;
  room_id: string;
  filename: string;
  content_type: string;
  byte_size: number;
  storage_provider: string;
  bucket: string;
  object_key: string;
  status: string;
  expires_at: string;
  attached_message_number: number | null;
  created_at: string;
  attached_at: string | null;
}

export interface TaskRow {
  room_id: string;
  number: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee: string | null;
  assignee_agent_key: string | null;
  created_by: string;
  source_message_id: string | null;
  pr_url: string | null;
  workflow_artifacts: TaskWorkflowArtifact[];
  created_at: string;
  updated_at: string;
}

export interface TaskLeaseRow {
  id: string;
  room_id: string;
  task_id: string;
  kind: TaskLeaseKind;
  status: TaskLeaseStatus;
  agent_key: string;
  agent_instance_id: string | null;
  agent_session_id: string | null;
  actor_label: string;
  branch_ref: string | null;
  pr_url: string | null;
  output_intent: string | null;
  expires_at: string | null;
  last_heartbeat_at: string | null;
  revoked_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface StaleTaskPromptMuteRow {
  room_id: string;
  task_id: string;
  task_updated_at: string;
  muted_by: string;
  created_at: string;
  updated_at: string;
}

export interface TaskLockRow {
  id: string;
  room_id: string;
  task_id: string | null;
  scope: TaskLockScope;
  reason: TaskLockReason;
  message: string | null;
  created_by: string;
  created_at: string;
  cleared_by: string | null;
  cleared_at: string | null;
}

export interface CoordinationEventRow {
  id: string;
  room_id: string;
  task_id: string | null;
  lease_id: string | null;
  lock_id: string | null;
  event_type: string;
  decision: CoordinationDecision;
  actor_label: string | null;
  actor_key: string | null;
  actor_instance_id: string | null;
  reason: string | null;
  metadata: CoordinationEventMetadata | null;
  created_at: string;
}

export interface RoomAgentPresenceRow {
  room_id: string;
  actor_label: string;
  agent_key: string | null;
  agent_session_id: string | null;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  display_name: string;
  owner_label: string | null;
  ide_label: string | null;
  status: AgentPresenceStatus;
  status_text: string | null;
  last_heartbeat_at: string;
  created_at: string;
  updated_at: string;
}

export interface RoomAgentLivenessObservationRow {
  room_id: string;
  agent_session_id: string;
  source: string;
  host_id: string | null;
  host_kind: string | null;
  host_label: string | null;
  liveness_capability: string;
  tool_bridge_id: string | null;
  last_observed_at: string;
  last_tool_call_at: string | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoomAgentDeliverySessionRow {
  room_id: string;
  delivery_key: string;
  actor_label: string;
  agent_key: string | null;
  agent_instance_id: string | null;
  agent_session_id: string | null;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  display_name: string;
  owner_label: string | null;
  ide_label: string | null;
  transport: RoomAgentDeliveryTransport;
  active_connection_count: number;
  last_connected_at: string;
  last_disconnected_at: string | null;
  reconnect_grace_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoomAgentSessionRow {
  session_id: string;
  room_id: string;
  token_hash: string;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  host_id: string | null;
  host_kind: string | null;
  host_label: string | null;
  liveness_capability: string | null;
  tool_bridge_id: string | null;
  actor_label: string;
  agent_key: string;
  agent_instance_id: string | null;
  display_name: string;
  owner_account_id: string;
  owner_label: string;
  ide_label: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  ended_at: string | null;
}

export interface RoomLiveAgentSuppressionRow {
  room_id: string;
  actor_label: string;
  suppressed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoomParticipantRow {
  room_id: string;
  participant_key: string;
  kind: "human" | "agent";
  actor_label: string | null;
  agent_key: string | null;
  github_login: string | null;
  display_name: string;
  owner_label: string | null;
  ide_label: string | null;
  hidden_at: string | null;
  hidden_by: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface ReasoningSessionRow {
  id: string;
  room_id: string;
  task_id: string | null;
  anchor_message_id: string | null;
  actor_label: string;
  agent_key: string | null;
  status: AgentPresenceStatus | null;
  summary: string;
  latest_payload: ReasoningSnapshot;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface ReasoningSessionUpdateRow {
  id: string;
  room_id: string;
  session_id: string;
  actor_label: string;
  status: AgentPresenceStatus | null;
  summary: string;
  milestone: string | null;
  payload: ReasoningSnapshot;
  created_at: string;
}
