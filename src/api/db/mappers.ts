import { normalizeBoardManagerFailoverMode } from "../../shared/board-manager-failover.js";
import { normalizeAgentPromptKind } from "../../shared/room-agent-prompts.js";
import { buildRoomActivitySourceFlags, deriveRoomAgentActivityState } from "../../shared/room-agent-activity.js";
import { buildTaskWorkflowRefs, normalizeTaskWorkflowArtifacts } from "../repo-workflow.js";
import { isInviteCode } from "../rooms/routing.js";
import { board_intents, board_manager_assignments, github_app_installations, github_app_repositories, github_repositories, github_webhook_deliveries, room_aliases, room_board_settings, rooms, room_git_bindings, room_shared_artifact_tasks, room_shared_artifacts } from "./schema.js";
import { formatAttachmentId, formatMessageId, formatTaskId } from "./utils.js";
import type { BoardIntent, BoardIntentRow, BoardManagerAssignment, BoardManagerAssignmentRow, CoordinationEvent, CoordinationEventRow, FocusRoomStatus, GitRoomBinding, GitHubAppInstallation, GitHubAppRepository, GitHubRepositoryLink, GitHubWebhookDelivery, GitHubWebhookDeliveryStatus, Message, MessageAttachment, MessageAttachmentData, MessageAttachmentRow, MessageAttachmentUpload, MessageAttachmentUploadRow, MessageReplyReference, MessageRow, MessageThreadSummary, Project, ReasoningSession, ReasoningSessionRow, ReasoningSessionUpdate, ReasoningSessionUpdateRow, RoomAgentDeliverySession, RoomAgentDeliverySessionRow, RoomAgentLivenessObservation, RoomAgentLivenessObservationRow, RoomAgentPresence, RoomAgentPresenceRow, RoomAgentSession, RoomAgentSessionRow, RoomAlias, RoomBoardSettings, RoomBoardSettingsRow, RoomKind, RoomParticipant, RoomParticipantRow, RoomSharedArtifact, RoomSharedArtifactTaskLink, StaleTaskPromptMute, StaleTaskPromptMuteRow, Task, TaskLease, TaskLeaseRow, TaskLock, TaskLockRow, TaskRow } from "./types.js";

export function toProject(row: typeof rooms.$inferSelect): Project {
  const inviteRoom = isInviteCode(row.id);
  return {
    id: row.id,
    code: inviteRoom ? row.id : null,
    display_name: row.display_name,
    name: inviteRoom ? undefined : row.id,
    kind: row.kind as RoomKind,
    parent_room_id: row.parent_room_id,
    focus_key: row.focus_key,
    source_task_id: row.source_task_id,
    focus_status: row.focus_status as FocusRoomStatus | null,
    focus_parent_visibility: row.focus_parent_visibility,
    focus_activity_scope: row.focus_activity_scope,
    focus_github_event_routing: row.focus_github_event_routing,
    focus_archived_at: row.focus_archived_at,
    git_lifecycle_event_order_at: row.git_lifecycle_event_order_at,
    concluded_at: row.concluded_at,
    conclusion_summary: row.conclusion_summary,
    conclusion_details: row.conclusion_details ?? null,
    created_at: row.created_at,
  };
}

export function toRoomAlias(row: typeof room_aliases.$inferSelect): RoomAlias {
  return {
    alias: row.alias,
    room_id: row.room_id,
    created_at: row.created_at,
  };
}

export function toGitHubRepositoryLink(
  row: typeof github_repositories.$inferSelect
): GitHubRepositoryLink {
  return {
    github_repo_id: row.github_repo_id,
    room_id: row.room_id,
    owner_login: row.owner_login,
    repo_name: row.repo_name,
    full_name: row.full_name,
    default_branch: row.default_branch,
    visibility: row.visibility as GitHubRepositoryLink["visibility"],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toGitRoomBinding(row: typeof room_git_bindings.$inferSelect): GitRoomBinding {
  return {
    room_id: row.room_id,
    provider: row.provider,
    host: row.host,
    repository_id: row.repository_id,
    repository_full_name: row.repository_full_name,
    repository_owner: row.repository_owner,
    repository_name: row.repository_name,
    ref_type: row.ref_type,
    ref_name: row.ref_name,
    default_branch: row.default_branch,
    base_ref: row.base_ref,
    head_ref: row.head_ref,
    head_repository_id: row.head_repository_id,
    head_repository_full_name: row.head_repository_full_name,
    head_repository_owner: row.head_repository_owner,
    head_repository_name: row.head_repository_name,
    visibility: row.visibility,
    is_default: row.is_default,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toRoomSharedArtifact(
  row: typeof room_shared_artifacts.$inferSelect,
  linkedTaskIds: string[] = []
): RoomSharedArtifact {
  return {
    room_id: row.room_id,
    identity_key: row.identity_key,
    provider: row.provider,
    kind: row.kind,
    artifact_id: row.artifact_id,
    artifact_number: row.artifact_number,
    title: row.title,
    url: row.url,
    ref: row.ref,
    state: row.state,
    detail: row.detail ?? null,
    source: row.source,
    first_seen_at: row.first_seen_at,
    updated_at: row.updated_at,
    linked_task_ids: linkedTaskIds,
  };
}

export function toRoomSharedArtifactTaskLink(
  row: typeof room_shared_artifact_tasks.$inferSelect
): RoomSharedArtifactTaskLink {
  return {
    room_id: row.room_id,
    artifact_identity_key: row.artifact_identity_key,
    task_id: row.task_id,
    source: row.source,
    linked_at: row.linked_at,
    updated_at: row.updated_at,
  };
}

export function toGitHubAppInstallation(
  row: typeof github_app_installations.$inferSelect
): GitHubAppInstallation {
  return {
    installation_id: row.installation_id,
    target_type: row.target_type,
    target_login: row.target_login,
    target_github_id: row.target_github_id,
    repository_selection: row.repository_selection,
    permissions_json: row.permissions_json,
    suspended_at: row.suspended_at,
    uninstalled_at: row.uninstalled_at,
    last_synced_at: row.last_synced_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toGitHubAppRepository(
  row: typeof github_app_repositories.$inferSelect
): GitHubAppRepository {
  return {
    github_repo_id: row.github_repo_id,
    installation_id: row.installation_id,
    owner_login: row.owner_login,
    repo_name: row.repo_name,
    full_name: row.full_name,
    room_id: row.room_id,
    removed_at: row.removed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toGitHubWebhookDelivery(
  row: typeof github_webhook_deliveries.$inferSelect
): GitHubWebhookDelivery {
  return {
    delivery_id: row.delivery_id,
    event_name: row.event_name,
    action: row.action,
    installation_id: row.installation_id,
    github_repo_id: row.github_repo_id,
    room_id: row.room_id,
    status: row.status as GitHubWebhookDeliveryStatus,
    error: row.error,
    received_at: row.received_at,
    processed_at: row.processed_at,
  };
}

export function formatMessageAttachmentDownloadUrl(row: Pick<MessageAttachmentRow, "room_id" | "message_number" | "attachment_number">): string {
  return `/rooms/${encodeURIComponent(row.room_id)}/messages/${formatMessageId(row.message_number)}/attachments/${formatAttachmentId(row.attachment_number)}`;
}

export function toMessageAttachment(row: MessageAttachmentRow): MessageAttachment {
  return {
    id: formatAttachmentId(row.attachment_number),
    filename: row.filename,
    file_name: row.filename,
    content_type: row.content_type,
    mime_type: row.content_type,
    byte_size: row.byte_size,
    size_bytes: row.byte_size,
    download_url: formatMessageAttachmentDownloadUrl(row),
  };
}

export function toMessageAttachmentData(row: MessageAttachmentRow): MessageAttachmentData {
  return {
    ...toMessageAttachment(row),
    storage_provider: row.storage_provider,
    bucket: row.bucket,
    object_key: row.object_key,
  };
}

export function toMessageAttachmentUpload(row: MessageAttachmentUploadRow): MessageAttachmentUpload {
  return {
    upload_id: row.upload_id,
    room_id: row.room_id,
    filename: row.filename,
    content_type: row.content_type,
    byte_size: row.byte_size,
    storage_provider: row.storage_provider,
    bucket: row.bucket,
    object_key: row.object_key,
    status: row.status === "attached" ? "attached" : "pending",
    expires_at: row.expires_at,
    attached_message_number: row.attached_message_number,
    created_at: row.created_at,
    attached_at: row.attached_at,
  };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: formatMessageId(row.number),
    client_message_id: row.client_message_id ?? null,
    agent_identity: row.publisher_agent_key
      ? {
          actor_label: row.sender,
          agent_key: row.publisher_agent_key,
          agent_session_id: row.publisher_agent_session_id ?? null,
        }
      : null,
    sender: row.sender,
    text: row.text,
    agent_prompt_kind: normalizeAgentPromptKind(row.agent_prompt_kind),
    source: row.source ?? null,
    timestamp: row.timestamp,
    thread_root_id: formatMessageId(row.thread_root_number ?? row.number),
    thread_reply_to_id: row.reply_to_number ? formatMessageId(row.reply_to_number) : null,
    thread: null,
    reply_to: null,
    attachments: [],
  };
}

export function toMessageReplyReference(row: Pick<MessageRow, "number" | "sender" | "text" | "source" | "timestamp">): MessageReplyReference {
  return {
    id: formatMessageId(row.number),
    sender: row.sender,
    text: row.text,
    source: row.source ?? null,
    timestamp: row.timestamp,
  };
}

export function toMessageWithReply(
  row: MessageRow,
  replyReference: MessageReplyReference | null,
  attachments: MessageAttachment[] = [],
  thread: MessageThreadSummary | null = null,
): Message {
  return {
    id: formatMessageId(row.number),
    client_message_id: row.client_message_id ?? null,
    agent_identity: row.publisher_agent_key
      ? {
          actor_label: row.sender,
          agent_key: row.publisher_agent_key,
          agent_session_id: row.publisher_agent_session_id ?? null,
        }
      : null,
    sender: row.sender,
    text: row.text,
    agent_prompt_kind: normalizeAgentPromptKind(row.agent_prompt_kind),
    source: row.source ?? null,
    timestamp: row.timestamp,
    thread_root_id: formatMessageId(row.thread_root_number ?? row.number),
    thread_reply_to_id: row.reply_to_number ? formatMessageId(row.reply_to_number) : null,
    thread,
    reply_to: replyReference,
    attachments,
  };
}

export function toTask(row: TaskRow): Task {
  const workflowArtifacts = normalizeTaskWorkflowArtifacts({
    artifacts: row.workflow_artifacts,
    prUrl: row.pr_url,
  });
  return {
    id: formatTaskId(row.number),
    room_id: row.room_id,
    title: row.title,
    description: row.description,
    status: row.status,
    assignee: row.assignee,
    assignee_agent_key: row.assignee_agent_key,
    created_by: row.created_by,
    source_message_id: row.source_message_id,
    pr_url: row.pr_url,
    workflow_artifacts: workflowArtifacts,
    workflow_refs: buildTaskWorkflowRefs({
      artifacts: workflowArtifacts,
      prUrl: row.pr_url,
    }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toStaleTaskPromptMute(row: StaleTaskPromptMuteRow): StaleTaskPromptMute {
  return {
    room_id: row.room_id,
    task_id: row.task_id,
    task_updated_at: row.task_updated_at,
    muted_by: row.muted_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toTaskLease(row: TaskLeaseRow): TaskLease {
  return {
    id: row.id,
    room_id: row.room_id,
    task_id: row.task_id,
    kind: row.kind,
    status: row.status,
    agent_key: row.agent_key,
    agent_instance_id: row.agent_instance_id,
    agent_session_id: row.agent_session_id,
    actor_label: row.actor_label,
    epoch: row.epoch,
    branch_ref: row.branch_ref,
    pr_url: row.pr_url,
    output_intent: row.output_intent,
    expires_at: row.expires_at,
    last_heartbeat_at: row.last_heartbeat_at,
    revoked_reason: row.revoked_reason,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toTaskLock(row: TaskLockRow): TaskLock {
  return {
    id: row.id,
    room_id: row.room_id,
    task_id: row.task_id,
    scope: row.scope,
    reason: row.reason,
    message: row.message,
    created_by: row.created_by,
    created_at: row.created_at,
    cleared_by: row.cleared_by,
    cleared_at: row.cleared_at,
  };
}

export function toCoordinationEvent(row: CoordinationEventRow): CoordinationEvent {
  return {
    id: row.id,
    room_id: row.room_id,
    task_id: row.task_id,
    lease_id: row.lease_id,
    lock_id: row.lock_id,
    event_type: row.event_type,
    decision: row.decision,
    actor_label: row.actor_label,
    actor_key: row.actor_key,
    actor_instance_id: row.actor_instance_id,
    reason: row.reason,
    metadata: row.metadata,
    created_at: row.created_at,
  };
}

export function toRoomBoardSettings(row: typeof room_board_settings.$inferSelect | RoomBoardSettingsRow): RoomBoardSettings {
  return {
    room_id: row.room_id,
    manager_mode: row.manager_mode as RoomBoardSettings["manager_mode"],
    manager_failover: normalizeBoardManagerFailoverMode(row.manager_failover),
    stall_nudged_at: row.stall_nudged_at,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toBoardManagerAssignment(
  row: typeof board_manager_assignments.$inferSelect | BoardManagerAssignmentRow
): BoardManagerAssignment {
  return {
    id: row.id,
    room_id: row.room_id,
    agent_session_id: row.agent_session_id,
    agent_key: row.agent_key,
    actor_label: row.actor_label,
    runtime_source: row.runtime_source as BoardManagerAssignment["runtime_source"],
    assigned_by: row.assigned_by,
    status: row.status as BoardManagerAssignment["status"],
    last_heartbeat_at: row.last_heartbeat_at,
    released_by: row.released_by,
    release_reason: row.release_reason,
    released_at: row.released_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toBoardIntent(row: typeof board_intents.$inferSelect | BoardIntentRow): BoardIntent {
  return {
    id: row.id,
    room_id: row.room_id,
    task_id: row.task_id,
    action_type: row.action_type as BoardIntent["action_type"],
    payload: row.payload,
    payload_hash: row.payload_hash,
    status: row.status as BoardIntent["status"],
    proposer_actor_label: row.proposer_actor_label,
    proposer_actor_key: row.proposer_actor_key,
    proposer_actor_instance_id: row.proposer_actor_instance_id,
    proposer_agent_session_id: row.proposer_agent_session_id,
    decision_by: row.decision_by,
    decision_reason: row.decision_reason,
    approval_token_hash: row.approval_token_hash,
    decided_at: row.decided_at,
    expires_at: row.expires_at,
    escalated_at: row.escalated_at,
    auto_approved: row.auto_approved,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toRoomAgentPresence(row: RoomAgentPresenceRow): RoomAgentPresence {
  return {
    room_id: row.room_id,
    actor_label: row.actor_label,
    agent_key: row.agent_key,
    agent_instance_id: null,
    agent_session_id: row.agent_session_id,
    session_kind: row.session_kind,
    runtime: row.runtime,
    display_name: row.display_name,
    owner_label: row.owner_label,
    ide_label: row.ide_label,
    repo_branch: row.repo_branch ?? null,
    status: row.status,
    status_text: row.status_text,
    last_heartbeat_at: row.last_heartbeat_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    freshness: "stale",
    activity_state: deriveRoomAgentActivityState({
      hidden: false,
      hasPresence: false,
      freshness: "stale",
      status: null,
    }),
    source_flags: buildRoomActivitySourceFlags(["presence"]),
    liveness_observation: null,
  };
}

export function toRoomAgentLivenessObservation(
  row: RoomAgentLivenessObservationRow
): RoomAgentLivenessObservation {
  return {
    room_id: row.room_id,
    agent_session_id: row.agent_session_id,
    source: row.source,
    host_id: row.host_id,
    host_kind: row.host_kind,
    host_label: row.host_label,
    liveness_capability: row.liveness_capability,
    tool_bridge_id: row.tool_bridge_id,
    last_observed_at: row.last_observed_at,
    last_tool_call_at: row.last_tool_call_at,
    detail: row.detail,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toRoomAgentDeliverySession(row: RoomAgentDeliverySessionRow): RoomAgentDeliverySession {
  return {
    room_id: row.room_id,
    delivery_key: row.delivery_key,
    actor_label: row.actor_label,
    agent_key: row.agent_key,
    agent_instance_id: row.agent_instance_id,
    agent_session_id: row.agent_session_id,
    session_kind: row.session_kind,
    runtime: row.runtime,
    display_name: row.display_name,
    owner_label: row.owner_label,
    ide_label: row.ide_label,
    repo_branch: row.repo_branch ?? null,
    transport: row.transport,
    active_connection_count: row.active_connection_count,
    last_connected_at: row.last_connected_at,
    last_disconnected_at: row.last_disconnected_at,
    reconnect_grace_expires_at: row.reconnect_grace_expires_at,
    offline_announced_at: row.offline_announced_at,
    recovery_announced_at: row.recovery_announced_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toRoomAgentSession(row: RoomAgentSessionRow): RoomAgentSession {
  return {
    session_id: row.session_id,
    room_id: row.room_id,
    session_kind: row.session_kind,
    runtime: row.runtime,
    host_id: row.host_id,
    host_kind: row.host_kind,
    host_label: row.host_label,
    liveness_capability: row.liveness_capability,
    tool_bridge_id: row.tool_bridge_id,
    actor_label: row.actor_label,
    agent_key: row.agent_key,
    agent_instance_id: row.agent_instance_id,
    display_name: row.display_name,
    assigned_base_display_name: row.assigned_base_display_name ?? null,
    owner_account_id: row.owner_account_id,
    supervisor_grant_id: row.supervisor_grant_id,
    owner_label: row.owner_label,
    ide_label: row.ide_label,
    repo_branch: row.repo_branch ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_seen_at: row.last_seen_at,
    ended_at: row.ended_at,
  };
}

export function toRoomParticipant(row: RoomParticipantRow): RoomParticipant {
  return {
    room_id: row.room_id,
    participant_key: row.participant_key,
    kind: row.kind,
    actor_label: row.actor_label,
    agent_key: row.agent_key,
    github_login: row.github_login,
    display_name: row.display_name,
    owner_label: row.owner_label,
    ide_label: row.ide_label,
    hidden_at: row.hidden_at,
    hidden_by: row.hidden_by,
    last_seen_at: row.last_seen_at,
    last_room_activity_at: row.last_seen_at,
    last_live_heartbeat_at: null,
    activity_state: null,
    source_flags: [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toReasoningSession(row: ReasoningSessionRow): ReasoningSession {
  return {
    id: row.id,
    room_id: row.room_id,
    task_id: row.task_id,
    anchor_message_id: row.anchor_message_id,
    actor_label: row.actor_label,
    agent_key: row.agent_key,
    status: row.status,
    summary: row.summary,
    latest_payload: row.latest_payload,
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
  };
}

export function toReasoningSessionUpdate(row: ReasoningSessionUpdateRow): ReasoningSessionUpdate {
  return {
    id: row.id,
    room_id: row.room_id,
    session_id: row.session_id,
    actor_label: row.actor_label,
    status: row.status,
    summary: row.summary,
    milestone: row.milestone,
    payload: row.payload,
    created_at: row.created_at,
  };
}
