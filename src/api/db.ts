import crypto from "crypto";
import { and, asc, desc, eq, inArray, lte, notInArray, sql, or } from "drizzle-orm";

import { db } from "./db/client.js";
import {
  accounts,
  agents,
  auth_sessions,
  auth_states,
  coordination_events,
  github_app_installations,
  github_app_repositories,
  github_room_events,
  github_webhook_deliveries,
  github_repositories,
  id_sequences,
  messages,
  owner_tokens,
  project_admins,
  room_agent_presence,
  room_participants,
  room_aliases,
  rooms,
  task_leases,
  task_locks,
  tasks,
} from "./db/schema.js";
import type {
  CoordinationEventMetadata,
  GitHubRoomEventMetadata,
  GitHubRoomEventType,
} from "./db/schema.js";
import { generateRoomDisplayName, normalizeRoomDisplayName } from "./room-display-name.js";
import { isInviteCode, normalizeRoomId, normalizeRoomName } from "./room-routing.js";
import {
  isPromptOnlyAgentMessage,
  normalizeAgentPromptKind,
  type AgentPromptKind,
} from "../shared/room-agent-prompts.js";
import {
  getAgentPresenceFreshness,
  type AgentPresenceFreshness,
  type AgentPresenceStatus,
} from "../shared/agent-presence.js";
import {
  buildTaskWorkflowRefs,
  normalizeTaskWorkflowArtifacts,
  synchronizeTaskWorkflowArtifactsWithPrUrl,
  type TaskWorkflowArtifact,
  type TaskWorkflowArtifactMatch,
  type TaskWorkflowRef,
} from "./repo-workflow.js";
import {
  DEFAULT_FOCUS_ROOM_SETTINGS,
  type FocusActivityScope,
  type FocusGitHubEventRouting,
  type FocusParentVisibility,
  type FocusRoomSettingsPatch,
} from "./focus-room-settings.js";

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
  display_name: string;
  owner_label: string | null;
  ide_label: string | null;
  status: AgentPresenceStatus;
  status_text: string | null;
  last_heartbeat_at: string;
  created_at: string;
  updated_at: string;
  freshness: AgentPresenceFreshness;
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
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  sender: string;
  text: string;
  agent_prompt_kind: AgentPromptKind | null;
  source: string | null;
  timestamp: string;
  reply_to: MessageReplyReference | null;
}

export interface MessageReplyReference {
  id: string;
  sender: string;
  text: string;
  source: string | null;
  timestamp: string;
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
  active_leases?: TaskLease[];
  active_locks?: TaskLock[];
}

export interface TaskLease {
  id: string;
  room_id: string;
  task_id: string;
  kind: TaskLeaseKind;
  status: TaskLeaseStatus;
  agent_key: string;
  agent_instance_id: string | null;
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

interface MessageRow {
  room_id: string;
  number: number;
  reply_to_number: number | null;
  sender: string;
  text: string;
  agent_prompt_kind: string | null;
  source: string | null;
  timestamp: string;
}

interface TaskRow {
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

interface TaskLeaseRow {
  id: string;
  room_id: string;
  task_id: string;
  kind: TaskLeaseKind;
  status: TaskLeaseStatus;
  agent_key: string;
  agent_instance_id: string | null;
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

interface TaskLockRow {
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

interface CoordinationEventRow {
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

interface RoomAgentPresenceRow {
  room_id: string;
  actor_label: string;
  agent_key: string | null;
  display_name: string;
  owner_label: string | null;
  ide_label: string | null;
  status: AgentPresenceStatus;
  status_text: string | null;
  last_heartbeat_at: string;
  created_at: string;
  updated_at: string;
}

interface RoomParticipantRow {
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

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  proposed: ["accepted", "cancelled"],
  accepted: ["assigned", "cancelled"],
  assigned: ["in_progress", "in_review", "cancelled"],
  in_progress: ["blocked", "in_review", "done", "cancelled"],
  blocked: ["in_progress", "in_review", "cancelled"],
  in_review: ["merged", "in_progress", "blocked", "done", "cancelled"],
  merged: ["done", "accepted"],
  done: ["accepted"],
  cancelled: ["accepted"],
};

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;

function clampLimit(requested: number | undefined, defaultVal = DEFAULT_LIST_LIMIT, maxVal = MAX_LIST_LIMIT): number {
  if (requested === undefined || requested === null || Number.isNaN(requested) || requested <= 0) {
    return defaultVal;
  }
  return Math.min(requested, maxVal);
}

function generateCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const seg1 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const seg2 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const seg3 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${seg1}-${seg2}-${seg3}`;
}

function isUniqueConstraintError(error: unknown): error is { code?: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function toProject(row: typeof rooms.$inferSelect): Project {
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
    concluded_at: row.concluded_at,
    conclusion_summary: row.conclusion_summary,
    created_at: row.created_at,
  };
}

function toRoomAlias(row: typeof room_aliases.$inferSelect): RoomAlias {
  return {
    alias: row.alias,
    room_id: row.room_id,
    created_at: row.created_at,
  };
}

function toGitHubRepositoryLink(
  row: typeof github_repositories.$inferSelect
): GitHubRepositoryLink {
  return {
    github_repo_id: row.github_repo_id,
    room_id: row.room_id,
    owner_login: row.owner_login,
    repo_name: row.repo_name,
    full_name: row.full_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toGitHubAppInstallation(
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

function toGitHubAppRepository(
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

function toGitHubWebhookDelivery(
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

function formatMessageId(number: number): string {
  return `msg_${number}`;
}

function formatTaskId(number: number): string {
  return `task_${number}`;
}

function parseScopedId(id: string, prefix: string): number | null {
  const match = new RegExp(`^${prefix}_(\\d+)$`).exec(id);
  if (!match) {
    return null;
  }

  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function toMessage(row: MessageRow): Message {
  return {
    id: formatMessageId(row.number),
    sender: row.sender,
    text: row.text,
    agent_prompt_kind: normalizeAgentPromptKind(row.agent_prompt_kind),
    source: row.source ?? null,
    timestamp: row.timestamp,
    reply_to: null,
  };
}

function toMessageReplyReference(row: Pick<MessageRow, "number" | "sender" | "text" | "source" | "timestamp">): MessageReplyReference {
  return {
    id: formatMessageId(row.number),
    sender: row.sender,
    text: row.text,
    source: row.source ?? null,
    timestamp: row.timestamp,
  };
}

function toMessageWithReply(
  row: MessageRow,
  replyReference: MessageReplyReference | null
): Message {
  return {
    id: formatMessageId(row.number),
    sender: row.sender,
    text: row.text,
    agent_prompt_kind: normalizeAgentPromptKind(row.agent_prompt_kind),
    source: row.source ?? null,
    timestamp: row.timestamp,
    reply_to: replyReference,
  };
}

function toTask(row: TaskRow): Task {
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

function toTaskLease(row: TaskLeaseRow): TaskLease {
  return {
    id: row.id,
    room_id: row.room_id,
    task_id: row.task_id,
    kind: row.kind,
    status: row.status,
    agent_key: row.agent_key,
    agent_instance_id: row.agent_instance_id,
    actor_label: row.actor_label,
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

function toTaskLock(row: TaskLockRow): TaskLock {
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

function toCoordinationEvent(row: CoordinationEventRow): CoordinationEvent {
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

function toRoomAgentPresence(row: RoomAgentPresenceRow): RoomAgentPresence {
  return {
    room_id: row.room_id,
    actor_label: row.actor_label,
    agent_key: row.agent_key,
    display_name: row.display_name,
    owner_label: row.owner_label,
    ide_label: row.ide_label,
    status: row.status,
    status_text: row.status_text,
    last_heartbeat_at: row.last_heartbeat_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    freshness: getAgentPresenceFreshness(row.last_heartbeat_at),
  };
}

function toRoomParticipant(row: RoomParticipantRow): RoomParticipant {
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
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const AUTH_STATE_TTL_MS = 15 * 60 * 1000;

async function nextPrefixedId(sequenceName: string, prefix: string): Promise<string> {
  const [next] = await db
    .insert(id_sequences)
    .values({ name: sequenceName, value: 1 })
    .onConflictDoUpdate({
      target: id_sequences.name,
      set: {
        value: sql`${id_sequences.value} + 1`,
      },
    })
    .returning({ value: id_sequences.value });

  return `${prefix}_${next.value}`;
}

type RoomSequenceExecutor = Pick<typeof db, "insert" | "delete" | "select" | "update">;

async function nextRoomScopedNumber(
  sequenceName: string,
  roomId: string,
  executor: RoomSequenceExecutor = db
): Promise<number> {
  const [next] = await executor
    .insert(id_sequences)
    .values({ name: `${sequenceName}:${roomId}`, value: 1 })
    .onConflictDoUpdate({
      target: id_sequences.name,
      set: {
        value: sql`${id_sequences.value} + 1`,
      },
    })
    .returning({ value: id_sequences.value });

  return next.value;
}

function getRoomScopedSequenceNames(roomId: string): [string, string] {
  return [`messages:${roomId}`, `tasks:${roomId}`];
}

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export async function createProject(): Promise<Project> {
  const created_at = new Date().toISOString();

  while (true) {
    const roomId = generateCode();
    const display_name = generateRoomDisplayName(roomId);

    try {
      await db.transaction(async (tx) => {
        await tx.insert(rooms).values({ id: roomId, display_name, created_at });
        await tx
          .delete(id_sequences)
          .where(inArray(id_sequences.name, getRoomScopedSequenceNames(roomId)));
      });
      return {
        id: roomId,
        code: roomId,
        display_name,
        kind: "main",
        parent_room_id: null,
        focus_key: null,
        source_task_id: null,
        focus_status: null,
        focus_parent_visibility: null,
        focus_activity_scope: null,
        focus_github_event_routing: null,
        concluded_at: null,
        conclusion_summary: null,
        created_at,
      };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
  }
}

export async function createProjectWithName(name: string): Promise<Project> {
  return (await getOrCreateCanonicalRoom(normalizeRoomName(name))).room;
}

export async function getOrCreateProjectByName(
  name: string
): Promise<{ project: Project; created: boolean }> {
  const canonicalName = normalizeRoomName(name);
  const { room, created } = await getOrCreateCanonicalRoom(canonicalName);
  return { project: room, created };
}

/**
 * Create or retrieve a room using a canonical ID (e.g., "github.com/user/repo").
 * Unlike createProjectWithName, the room's `id` IS the canonical identifier —
 * no separate `name` column needed.
 */
export async function getOrCreateCanonicalRoom(
  canonicalId: string
): Promise<{ room: Project; created: boolean }> {
  const existing = await getProjectById(canonicalId);
  if (existing) {
    return { room: existing, created: false };
  }

  const created_at = new Date().toISOString();
  const display_name = generateRoomDisplayName(canonicalId);
  try {
    await db.transaction(async (tx) => {
      await tx.insert(rooms).values({ id: canonicalId, display_name, created_at });
      await tx
        .delete(id_sequences)
        .where(inArray(id_sequences.name, getRoomScopedSequenceNames(canonicalId)));
    });
    return {
      room: {
        id: canonicalId,
        code: null,
        display_name,
        name: canonicalId,
        kind: "main",
        parent_room_id: null,
        focus_key: null,
        source_task_id: null,
        focus_status: null,
        focus_parent_visibility: null,
        focus_activity_scope: null,
        focus_github_event_routing: null,
        concluded_at: null,
        conclusion_summary: null,
        created_at,
      },
      created: true,
    };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const retried = await getProjectById(canonicalId);
      if (retried) {
        return { room: retried, created: false };
      }
    }
    throw error;
  }
}

export async function getProjectByName(name: string): Promise<Project | undefined> {
  return getProjectById(normalizeRoomName(name));
}

export async function getAllProjects(): Promise<Pick<Project, "id" | "code" | "display_name">[]> {
  const rows = await db
    .select()
    .from(rooms)
    .where(eq(rooms.kind, "main"))
    .orderBy(asc(rooms.created_at));
  return rows.map((row) => {
    const project = toProject(row);
    return { id: project.id, code: project.code, display_name: project.display_name };
  });
}

export async function getProjectByCode(code: string): Promise<Project | undefined> {
  const normalizedCode = code.toUpperCase();
  if (!isInviteCode(normalizedCode)) {
    return undefined;
  }

  const [project] = await db.select().from(rooms).where(eq(rooms.id, normalizedCode)).limit(1);
  return project ? toProject(project) : undefined;
}

export async function getRoomAlias(alias: string): Promise<RoomAlias | undefined> {
  const normalizedAlias = normalizeRoomName(alias);
  const [roomAlias] = await db
    .select()
    .from(room_aliases)
    .where(eq(room_aliases.alias, normalizedAlias))
    .limit(1);

  return roomAlias ? toRoomAlias(roomAlias) : undefined;
}

export async function getGitHubRepositoryLinkById(
  githubRepoId: string
): Promise<GitHubRepositoryLink | undefined> {
  const [repo] = await db
    .select()
    .from(github_repositories)
    .where(eq(github_repositories.github_repo_id, githubRepoId))
    .limit(1);

  return repo ? toGitHubRepositoryLink(repo) : undefined;
}

export async function getProjectById(id: string): Promise<Project | undefined> {
  const normalizedId = normalizeRoomId(id);
  const [project] = await db.select().from(rooms).where(eq(rooms.id, normalizedId)).limit(1);
  if (project) {
    return toProject(project);
  }

  if (isInviteCode(normalizedId)) {
    return undefined;
  }

  const roomAlias = await getRoomAlias(normalizedId);
  if (!roomAlias) {
    return undefined;
  }

  const [aliasedProject] = await db
    .select()
    .from(rooms)
    .where(eq(rooms.id, roomAlias.room_id))
    .limit(1);
  return aliasedProject ? toProject(aliasedProject) : undefined;
}

export async function rotateProjectCode(projectId: string): Promise<Project | null> {
  const project = await getProjectById(projectId);
  if (!project || !project.code) return null;

  while (true) {
    const nextCode = generateCode();

    try {
      await db.transaction(async (tx) => {
        await tx.update(rooms).set({ id: nextCode }).where(eq(rooms.id, projectId));
        await tx
          .update(id_sequences)
          .set({ name: `messages:${nextCode}` })
          .where(eq(id_sequences.name, `messages:${projectId}`));
        await tx
          .update(id_sequences)
          .set({ name: `tasks:${nextCode}` })
          .where(eq(id_sequences.name, `tasks:${projectId}`));
      });

      return {
        id: nextCode,
        code: nextCode,
        display_name: project.display_name,
        kind: project.kind,
        parent_room_id: project.parent_room_id,
        focus_key: project.focus_key,
        source_task_id: project.source_task_id,
        focus_status: project.focus_status,
        focus_parent_visibility: project.focus_parent_visibility,
        focus_activity_scope: project.focus_activity_scope,
        focus_github_event_routing: project.focus_github_event_routing,
        concluded_at: project.concluded_at,
        conclusion_summary: project.conclusion_summary,
        created_at: project.created_at,
      };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
  }
}

export async function updateProjectDisplayName(
  projectId: string,
  displayName: string
): Promise<Project | null> {
  const normalizedDisplayName = normalizeRoomDisplayName(displayName);

  const [updated] = await db
    .update(rooms)
    .set({ display_name: normalizedDisplayName })
    .where(eq(rooms.id, projectId))
    .returning();

  return updated ? toProject(updated) : null;
}

async function buildFocusRoomId(): Promise<string> {
  return nextPrefixedId("focus_rooms", "focus");
}

function truncateDisplayName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= 64) {
    return normalized;
  }

  return `${normalized.slice(0, 61).trimEnd()}...`;
}

function buildFocusRoomDisplayName(task: Task, displayName?: string): string {
  if (displayName?.trim()) {
    return normalizeRoomDisplayName(displayName);
  }

  return normalizeRoomDisplayName(truncateDisplayName(`Focus: ${task.title}`));
}

function buildFocusRoomDisplayNameFromIntent(intentTitle: string, displayName?: string): string {
  if (displayName?.trim()) {
    return normalizeRoomDisplayName(displayName);
  }

  return normalizeRoomDisplayName(truncateDisplayName(`Focus: ${intentTitle}`));
}

function normalizeFocusIntentTitle(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("focus intent title is required");
  }
  return truncateDisplayName(normalized);
}

function buildAdHocFocusKey(intentTitle: string): string {
  const slug = intentTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `focus-${slug || "room"}-${suffix}`;
}

export async function getFocusRoomsForParent(parentRoomId: string): Promise<Project[]> {
  const rows = await db
    .select()
    .from(rooms)
    .where(and(eq(rooms.parent_room_id, parentRoomId), eq(rooms.kind, "focus")))
    .orderBy(asc(rooms.created_at));

  return rows.map(toProject);
}

export async function getActiveFocusRoomForTask(
  parentRoomId: string,
  taskId: string
): Promise<Project | undefined> {
  const [focusRoom] = await db
    .select()
    .from(rooms)
    .where(
      and(
        eq(rooms.parent_room_id, parentRoomId),
        eq(rooms.source_task_id, taskId),
        eq(rooms.kind, "focus"),
        eq(rooms.focus_status, "active")
      )
    )
    .limit(1);

  return focusRoom ? toProject(focusRoom) : undefined;
}

export async function getFocusRoomByKey(
  parentRoomId: string,
  focusKey: string
): Promise<Project | undefined> {
  const [focusRoom] = await db
    .select()
    .from(rooms)
    .where(
      and(
        eq(rooms.parent_room_id, parentRoomId),
        eq(rooms.focus_key, focusKey),
        eq(rooms.kind, "focus")
      )
    )
    .limit(1);

  return focusRoom ? toProject(focusRoom) : undefined;
}

export async function concludeFocusRoom(
  parentRoomId: string,
  focusKey: string,
  summary: string
): Promise<{ room: Project; task: Task | undefined; updated: boolean } | null> {
  const normalizedSummary = summary.trim();
  if (!normalizedSummary) {
    throw new Error("conclusion summary is required");
  }

  const focusRoom = await getFocusRoomByKey(parentRoomId, focusKey);
  if (!focusRoom) {
    return null;
  }

  const task = focusRoom.source_task_id
    ? await getTaskById(parentRoomId, focusRoom.source_task_id)
    : undefined;

  if (focusRoom.focus_status === "concluded") {
    return { room: focusRoom, task, updated: false };
  }

  const [updated] = await db
    .update(rooms)
    .set({
      focus_status: "concluded",
      concluded_at: new Date().toISOString(),
      conclusion_summary: normalizedSummary,
    })
    .where(and(eq(rooms.id, focusRoom.id), eq(rooms.focus_status, "active")))
    .returning();

  if (updated) {
    return { room: toProject(updated), task, updated: true };
  }

  const current = await getFocusRoomByKey(parentRoomId, focusKey);
  return current ? { room: current, task, updated: false } : null;
}

export async function updateFocusRoomSettings(
  parentRoomId: string,
  focusKey: string,
  settings: FocusRoomSettingsPatch
): Promise<Project | null> {
  const patch: Partial<Pick<
    typeof rooms.$inferInsert,
    "focus_parent_visibility" | "focus_activity_scope" | "focus_github_event_routing"
  >> = {};

  if (Object.prototype.hasOwnProperty.call(settings, "parent_visibility")) {
    patch.focus_parent_visibility = settings.parent_visibility;
  }
  if (Object.prototype.hasOwnProperty.call(settings, "activity_scope")) {
    patch.focus_activity_scope = settings.activity_scope;
  }
  if (Object.prototype.hasOwnProperty.call(settings, "github_event_routing")) {
    patch.focus_github_event_routing = settings.github_event_routing;
  }

  if (Object.keys(patch).length === 0) {
    return (await getFocusRoomByKey(parentRoomId, focusKey)) ?? null;
  }

  const [updated] = await db
    .update(rooms)
    .set(patch)
    .where(
      and(
        eq(rooms.parent_room_id, parentRoomId),
        eq(rooms.focus_key, focusKey),
        eq(rooms.kind, "focus")
      )
    )
    .returning();

  return updated ? toProject(updated) : null;
}

export async function createFocusRoomFromIntent(
  parentRoomId: string,
  intentTitle: string,
  options?: { displayName?: string }
): Promise<{ room: Project; created: true }> {
  const parent = await getProjectById(parentRoomId);
  if (!parent) {
    throw new Error("Parent room not found");
  }
  if (parent.kind === "focus") {
    throw new Error("Focus rooms can only be opened from a main room");
  }

  const normalizedTitle = normalizeFocusIntentTitle(intentTitle);
  const display_name = buildFocusRoomDisplayNameFromIntent(normalizedTitle, options?.displayName);

  while (true) {
    const id = await buildFocusRoomId();
    const focus_key = buildAdHocFocusKey(normalizedTitle);
    const created_at = new Date().toISOString();

    try {
      await db.transaction(async (tx) => {
        await tx.insert(rooms).values({
          id,
          display_name,
          kind: "focus",
          parent_room_id: parent.id,
          focus_key,
          source_task_id: null,
          focus_status: "active",
          focus_parent_visibility: DEFAULT_FOCUS_ROOM_SETTINGS.parent_visibility,
          focus_activity_scope: DEFAULT_FOCUS_ROOM_SETTINGS.activity_scope,
          focus_github_event_routing: DEFAULT_FOCUS_ROOM_SETTINGS.github_event_routing,
          created_at,
        });
        await tx
          .delete(id_sequences)
          .where(inArray(id_sequences.name, getRoomScopedSequenceNames(id)));
      });

      const room = await getProjectById(id);
      if (!room) {
        throw new Error("Focus room was created but could not be loaded");
      }

      return { room, created: true };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
  }
}

export async function createFocusRoomForTask(
  parentRoomId: string,
  taskId: string,
  options?: { displayName?: string }
): Promise<{ room: Project; task: Task; created: boolean } | null> {
  const parent = await getProjectById(parentRoomId);
  if (!parent) {
    return null;
  }
  if (parent.kind === "focus") {
    throw new Error("Focus rooms can only be opened from a main room");
  }

  const task = await getTaskById(parent.id, taskId);
  if (!task) {
    return null;
  }

  const existing = await getActiveFocusRoomForTask(parent.id, task.id);
  if (existing) {
    return { room: existing, task, created: false };
  }

  const display_name = buildFocusRoomDisplayName(task, options?.displayName);

  while (true) {
    const id = await buildFocusRoomId();
    const created_at = new Date().toISOString();

    try {
      await db.transaction(async (tx) => {
        await tx.insert(rooms).values({
          id,
          display_name,
          kind: "focus",
          parent_room_id: parent.id,
          focus_key: task.id,
          source_task_id: task.id,
          focus_status: "active",
          focus_parent_visibility: DEFAULT_FOCUS_ROOM_SETTINGS.parent_visibility,
          focus_activity_scope: DEFAULT_FOCUS_ROOM_SETTINGS.activity_scope,
          focus_github_event_routing: DEFAULT_FOCUS_ROOM_SETTINGS.github_event_routing,
          created_at,
        });
        await tx
          .delete(id_sequences)
          .where(inArray(id_sequences.name, getRoomScopedSequenceNames(id)));
      });

      const room = await getProjectById(id);
      if (!room) {
        throw new Error("Focus room was created but could not be loaded");
      }

      return { room, task, created: true };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const retried = await getActiveFocusRoomForTask(parent.id, task.id);
      if (retried) {
        return { room: retried, task, created: false };
      }
      const keyed = await getFocusRoomByKey(parent.id, task.id);
      if (keyed) {
        return { room: keyed, task, created: false };
      }
    }
  }
}

function serializeGitHubPermissions(
  permissions: Record<string, string> | null | undefined
): string | null {
  if (!permissions) {
    return null;
  }

  const entries = Object.entries(permissions).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return null;
  }

  return JSON.stringify(Object.fromEntries(entries));
}

async function assertRoomAliasAvailable(
  alias: string,
  roomId: string,
  executor: RoomSequenceExecutor = db
): Promise<void> {
  const [occupiedRoom] = await executor
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.id, alias))
    .limit(1);
  if (occupiedRoom && occupiedRoom.id !== roomId) {
    throw new Error(`Alias '${alias}' is already a canonical room id`);
  }

  const [occupiedAlias] = await executor
    .select()
    .from(room_aliases)
    .where(eq(room_aliases.alias, alias))
    .limit(1);
  if (occupiedAlias && occupiedAlias.room_id !== roomId) {
    throw new Error(`Alias '${alias}' is already assigned to a different room`);
  }
}

export async function createRoomAlias(roomId: string, alias: string): Promise<RoomAlias> {
  const normalizedAlias = normalizeRoomName(alias);
  if (isInviteCode(normalizedAlias)) {
    throw new Error("Invite codes cannot be registered as room aliases");
  }
  if (normalizedAlias === roomId) {
    throw new Error("Alias must differ from the canonical room id");
  }

  const created_at = new Date().toISOString();
  return db.transaction(async (tx) => {
    await assertRoomAliasAvailable(normalizedAlias, roomId, tx);

    const [existing] = await tx
      .select()
      .from(room_aliases)
      .where(eq(room_aliases.alias, normalizedAlias))
      .limit(1);
    if (existing) {
      return toRoomAlias(existing);
    }

    const [created] = await tx
      .insert(room_aliases)
      .values({
        alias: normalizedAlias,
        room_id: roomId,
        created_at,
      })
      .returning();

    return toRoomAlias(created);
  });
}

export async function upsertGitHubRepositoryLink(input: {
  github_repo_id: string;
  room_id: string;
  owner_login: string;
  repo_name: string;
}): Promise<GitHubRepositoryLink> {
  const created_at = new Date().toISOString();
  const updated_at = created_at;
  const full_name = `${input.owner_login}/${input.repo_name}`;

  const [repo] = await db
    .insert(github_repositories)
    .values({
      github_repo_id: input.github_repo_id,
      room_id: input.room_id,
      owner_login: input.owner_login,
      repo_name: input.repo_name,
      full_name,
      created_at,
      updated_at,
    })
    .onConflictDoUpdate({
      target: github_repositories.github_repo_id,
      set: {
        room_id: input.room_id,
        owner_login: input.owner_login,
        repo_name: input.repo_name,
        full_name,
        updated_at,
      },
    })
    .returning();

  return toGitHubRepositoryLink(repo);
}

export async function migrateGitHubRepositoryCanonicalRoom(input: {
  github_repo_id: string;
  owner_login: string;
  repo_name: string;
}): Promise<Project | null> {
  const existing = await getGitHubRepositoryLinkById(input.github_repo_id);
  if (!existing) {
    return null;
  }

  const nextRoomId = normalizeRoomName(`github.com/${input.owner_login}/${input.repo_name}`);
  if (existing.room_id === nextRoomId) {
    await upsertGitHubRepositoryLink({
      github_repo_id: input.github_repo_id,
      room_id: nextRoomId,
      owner_login: input.owner_login,
      repo_name: input.repo_name,
    });
    return (await getProjectById(nextRoomId)) ?? null;
  }

  const updated_at = new Date().toISOString();
  await db.transaction(async (tx) => {
    await assertRoomAliasAvailable(nextRoomId, existing.room_id, tx);

    const [existingAlias] = await tx
      .select()
      .from(room_aliases)
      .where(eq(room_aliases.alias, nextRoomId))
      .limit(1);
    if (existingAlias?.room_id === existing.room_id) {
      await tx.delete(room_aliases).where(eq(room_aliases.alias, nextRoomId));
    }

    await tx
      .update(rooms)
      .set({ id: nextRoomId })
      .where(eq(rooms.id, existing.room_id));

    await tx
      .insert(room_aliases)
      .values({
        alias: existing.room_id,
        room_id: nextRoomId,
        created_at: updated_at,
      })
      .onConflictDoNothing();

    await tx
      .update(github_repositories)
      .set({
        room_id: nextRoomId,
        owner_login: input.owner_login,
        repo_name: input.repo_name,
        full_name: `${input.owner_login}/${input.repo_name}`,
        updated_at,
      })
      .where(eq(github_repositories.github_repo_id, input.github_repo_id));
  });

  return (await getProjectById(nextRoomId)) ?? null;
}

export async function upsertGitHubAppInstallation(input: {
  installation_id: string;
  target_type: string;
  target_login: string;
  target_github_id: string;
  repository_selection: string;
  permissions?: Record<string, string> | null;
  suspended_at?: string | null;
  uninstalled_at?: string | null;
}): Promise<GitHubAppInstallation> {
  const now = new Date().toISOString();
  const permissions_json = serializeGitHubPermissions(input.permissions);

  const [installation] = await db
    .insert(github_app_installations)
    .values({
      installation_id: input.installation_id,
      target_type: input.target_type,
      target_login: input.target_login,
      target_github_id: input.target_github_id,
      repository_selection: input.repository_selection,
      permissions_json,
      suspended_at: input.suspended_at ?? null,
      uninstalled_at: input.uninstalled_at ?? null,
      last_synced_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: github_app_installations.installation_id,
      set: {
        target_type: input.target_type,
        target_login: input.target_login,
        target_github_id: input.target_github_id,
        repository_selection: input.repository_selection,
        permissions_json,
        suspended_at: input.suspended_at ?? null,
        uninstalled_at: input.uninstalled_at ?? null,
        last_synced_at: now,
        updated_at: now,
      },
    })
    .returning();

  return toGitHubAppInstallation(installation);
}

export async function markGitHubAppInstallationUninstalled(
  installationId: string,
  uninstalledAt = new Date().toISOString()
): Promise<void> {
  await db
    .update(github_app_installations)
    .set({
      uninstalled_at: uninstalledAt,
      last_synced_at: uninstalledAt,
      updated_at: uninstalledAt,
    })
    .where(eq(github_app_installations.installation_id, installationId));
}

export async function setGitHubAppInstallationSuspended(
  installationId: string,
  suspendedAt: string | null
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(github_app_installations)
    .set({
      suspended_at: suspendedAt,
      last_synced_at: now,
      updated_at: now,
    })
    .where(eq(github_app_installations.installation_id, installationId));
}

export async function upsertGitHubAppRepository(input: {
  github_repo_id: string;
  installation_id: string;
  owner_login: string;
  repo_name: string;
}): Promise<GitHubAppRepository> {
  const now = new Date().toISOString();
  const full_name = `${input.owner_login}/${input.repo_name}`;
  const room_id = normalizeRoomName(`github.com/${full_name}`);

  const [repository] = await db
    .insert(github_app_repositories)
    .values({
      github_repo_id: input.github_repo_id,
      installation_id: input.installation_id,
      owner_login: input.owner_login,
      repo_name: input.repo_name,
      full_name,
      room_id,
      removed_at: null,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: github_app_repositories.github_repo_id,
      set: {
        installation_id: input.installation_id,
        owner_login: input.owner_login,
        repo_name: input.repo_name,
        full_name,
        room_id,
        removed_at: null,
        updated_at: now,
      },
    })
    .returning();

  return toGitHubAppRepository(repository);
}

export async function markGitHubAppRepositoryRemoved(
  githubRepoId: string,
  removedAt = new Date().toISOString()
): Promise<void> {
  await db
    .update(github_app_repositories)
    .set({
      removed_at: removedAt,
      updated_at: removedAt,
    })
    .where(eq(github_app_repositories.github_repo_id, githubRepoId));
}

export async function getGitHubAppRepositoryByFullName(
  fullName: string
): Promise<GitHubAppRepository | undefined> {
  const [repository] = await db
    .select()
    .from(github_app_repositories)
    .where(eq(github_app_repositories.full_name, fullName))
    .limit(1);

  return repository ? toGitHubAppRepository(repository) : undefined;
}

export async function getGitHubAppRepositoryByRoomId(
  roomId: string
): Promise<GitHubAppRepository | undefined> {
  const [repository] = await db
    .select()
    .from(github_app_repositories)
    .where(eq(github_app_repositories.room_id, roomId))
    .orderBy(desc(github_app_repositories.updated_at))
    .limit(1);

  return repository ? toGitHubAppRepository(repository) : undefined;
}

export async function getGitHubAppInstallationById(
  installationId: string
): Promise<GitHubAppInstallation | undefined> {
  const [installation] = await db
    .select()
    .from(github_app_installations)
    .where(eq(github_app_installations.installation_id, installationId))
    .limit(1);

  return installation ? toGitHubAppInstallation(installation) : undefined;
}

export async function recordGitHubWebhookDelivery(input: {
  delivery_id: string;
  event_name: string;
  action?: string | null;
  installation_id?: string | null;
  github_repo_id?: string | null;
  room_id?: string | null;
}): Promise<{ delivery: GitHubWebhookDelivery; duplicate: boolean }> {
  const received_at = new Date().toISOString();
  const [created] = await db
    .insert(github_webhook_deliveries)
    .values({
      delivery_id: input.delivery_id,
      event_name: input.event_name,
      action: input.action ?? null,
      installation_id: input.installation_id ?? null,
      github_repo_id: input.github_repo_id ?? null,
      room_id: input.room_id ?? null,
      status: "received",
      error: null,
      received_at,
      processed_at: null,
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return {
      delivery: toGitHubWebhookDelivery(created),
      duplicate: false,
    };
  }

  const [existing] = await db
    .select()
    .from(github_webhook_deliveries)
    .where(eq(github_webhook_deliveries.delivery_id, input.delivery_id))
    .limit(1);

  if (!existing) {
    throw new Error(`Webhook delivery '${input.delivery_id}' could not be recorded`);
  }

  return {
    delivery: toGitHubWebhookDelivery(existing),
    duplicate: true,
  };
}

export async function markGitHubWebhookDeliveryProcessed(
  deliveryId: string,
  input: {
    status: Exclude<GitHubWebhookDeliveryStatus, "received">;
    error?: string | null;
    installation_id?: string | null;
    github_repo_id?: string | null;
    room_id?: string | null;
  }
): Promise<void> {
  const update: Partial<typeof github_webhook_deliveries.$inferInsert> = {
    status: input.status,
    processed_at: new Date().toISOString(),
  };

  if (input.error !== undefined) {
    update.error = input.error;
  }
  if (input.installation_id !== undefined) {
    update.installation_id = input.installation_id;
  }
  if (input.github_repo_id !== undefined) {
    update.github_repo_id = input.github_repo_id;
  }
  if (input.room_id !== undefined) {
    update.room_id = input.room_id;
  }

  await db
    .update(github_webhook_deliveries)
    .set(update)
    .where(eq(github_webhook_deliveries.delivery_id, deliveryId));
}

export async function addMessage(
  roomId: string,
  sender: string,
  text: string,
  options?: {
    source?: string;
    agent_prompt_kind?: AgentPromptKind | null;
    reply_to_message_id?: string | null;
  }
): Promise<Message> {
  const promptKind = options?.agent_prompt_kind ?? null;
  return db.transaction(async (tx) => {
    let replyReference: MessageReplyReference | null = null;
    const replyToNumber =
      options?.reply_to_message_id
        ? parseScopedId(options.reply_to_message_id, "msg")
        : null;

    if (options?.reply_to_message_id && !replyToNumber) {
      throw new Error("reply_to must be a valid message id");
    }

    if (replyToNumber) {
      const [replyTarget] = await tx
        .select({
          number: messages.number,
          sender: messages.sender,
          text: messages.text,
          agent_prompt_kind: messages.agent_prompt_kind,
          source: messages.source,
          timestamp: messages.timestamp,
        })
        .from(messages)
        .where(and(eq(messages.room_id, roomId), eq(messages.number, replyToNumber)))
        .limit(1);

      if (!replyTarget) {
        throw new Error("reply_to must reference an existing message in this room");
      }

      if (isPromptOnlyAgentMessage(replyTarget.text, normalizeAgentPromptKind(replyTarget.agent_prompt_kind))) {
        throw new Error("reply_to must reference a visible message");
      }

      replyReference = toMessageReplyReference(replyTarget);
    }

    const message: MessageRow = {
      room_id: roomId,
      number: await nextRoomScopedNumber("messages", roomId, tx),
      reply_to_number: replyToNumber,
      sender,
      text,
      agent_prompt_kind: promptKind,
      source: options?.source ?? null,
      timestamp: new Date().toISOString(),
    };

    await tx.insert(messages).values(message);
    if (isPromptOnlyAgentMessage(message.text, promptKind)) {
      await tx
        .delete(messages)
        .where(
          and(
            eq(messages.room_id, roomId),
            eq(messages.sender, sender),
            eq(messages.agent_prompt_kind, "auto"),
            sql`BTRIM(${messages.text}) = ''`,
            sql`${messages.number} < ${message.number}`
          )
        );
    }

    return toMessageWithReply(message, replyReference);
  });
}

export async function getMessages(
  roomId: string,
  options?: { limit?: number; after?: string; include_prompt_only?: boolean }
): Promise<{ messages: Message[]; has_more: boolean }> {
  const limit = clampLimit(options?.limit);
  const afterNumber = options?.after ? parseScopedId(options.after, "msg") : null;
  const visibilityCondition = options?.include_prompt_only
    ? sql`TRUE`
    : sql`NOT (${messages.agent_prompt_kind} = 'auto' AND BTRIM(${messages.text}) = '')`;

  const rows = await db
    .select({
      room_id: messages.room_id,
      number: messages.number,
      reply_to_number: messages.reply_to_number,
      sender: messages.sender,
      text: messages.text,
      agent_prompt_kind: messages.agent_prompt_kind,
      source: messages.source,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(
      afterNumber
        ? and(eq(messages.room_id, roomId), sql`${messages.number} > ${afterNumber}`, visibilityCondition)
        : and(eq(messages.room_id, roomId), visibilityCondition)
    )
    .orderBy(asc(messages.number))
    .limit(limit + 1);

  const has_more = rows.length > limit;
  const bounded = has_more ? rows.slice(0, limit) : rows;
  const hydratedMessages = await hydrateMessageReplies(roomId, bounded);

  return {
    messages: hydratedMessages,
    has_more,
  };
}

export async function getLatestMessages(
  roomId: string,
  options?: { limit?: number; include_prompt_only?: boolean }
): Promise<{ messages: Message[]; has_more: boolean }> {
  const limit = clampLimit(options?.limit);
  const visibilityCondition = options?.include_prompt_only
    ? sql`TRUE`
    : sql`NOT (${messages.agent_prompt_kind} = 'auto' AND BTRIM(${messages.text}) = '')`;

  const rows = await db
    .select({
      room_id: messages.room_id,
      number: messages.number,
      reply_to_number: messages.reply_to_number,
      sender: messages.sender,
      text: messages.text,
      agent_prompt_kind: messages.agent_prompt_kind,
      source: messages.source,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(and(eq(messages.room_id, roomId), visibilityCondition))
    .orderBy(desc(messages.number))
    .limit(limit + 1);

  const has_more = rows.length > limit;
  const bounded = (has_more ? rows.slice(0, limit) : rows).reverse();
  const hydratedMessages = await hydrateMessageReplies(roomId, bounded);

  return {
    messages: hydratedMessages,
    has_more,
  };
}

export async function getMessagesBefore(
  roomId: string,
  beforeMessageId: string | undefined,
  options?: { limit?: number; include_prompt_only?: boolean }
): Promise<{ messages: Message[]; has_more: boolean }> {
  const beforeNumber = beforeMessageId ? parseScopedId(beforeMessageId, "msg") : null;
  if (!beforeNumber) {
    return getLatestMessages(roomId, options);
  }

  const limit = clampLimit(options?.limit);
  const visibilityCondition = options?.include_prompt_only
    ? sql`TRUE`
    : sql`NOT (${messages.agent_prompt_kind} = 'auto' AND BTRIM(${messages.text}) = '')`;

  const rows = await db
    .select({
      room_id: messages.room_id,
      number: messages.number,
      reply_to_number: messages.reply_to_number,
      sender: messages.sender,
      text: messages.text,
      agent_prompt_kind: messages.agent_prompt_kind,
      source: messages.source,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(and(eq(messages.room_id, roomId), sql`${messages.number} < ${beforeNumber}`, visibilityCondition))
    .orderBy(desc(messages.number))
    .limit(limit + 1);

  const has_more = rows.length > limit;
  const bounded = (has_more ? rows.slice(0, limit) : rows).reverse();
  const hydratedMessages = await hydrateMessageReplies(roomId, bounded);

  return {
    messages: hydratedMessages,
    has_more,
  };
}

async function hydrateMessageReplies(roomId: string, bounded: MessageRow[]): Promise<Message[]> {
  const replyToNumbers = Array.from(
    new Set(
      bounded
        .map((row) => row.reply_to_number)
        .filter((value): value is number => value !== null && Number.isInteger(value) && value > 0)
    )
  );

  const replyMap = new Map<number, MessageReplyReference>();
  if (replyToNumbers.length > 0) {
    const replyRows = await db
      .select({
        number: messages.number,
        sender: messages.sender,
        text: messages.text,
        source: messages.source,
        timestamp: messages.timestamp,
      })
      .from(messages)
      .where(and(eq(messages.room_id, roomId), inArray(messages.number, replyToNumbers)));

    for (const replyRow of replyRows) {
      replyMap.set(replyRow.number, toMessageReplyReference(replyRow));
    }
  }

  return bounded.map((row) =>
    toMessageWithReply(row, row.reply_to_number ? replyMap.get(row.reply_to_number) ?? null : null)
  );
}

export async function getMessagesAfter(
  roomId: string,
  afterMessageId: string | undefined,
  options?: { limit?: number; include_prompt_only?: boolean }
): Promise<{ messages: Message[]; has_more: boolean }> {
  return getMessages(roomId, { ...options, after: afterMessageId });
}

export async function hasMessagesFromSender(roomId: string, sender: string): Promise<boolean> {
  const [row] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
    })
    .from(messages)
    .where(and(eq(messages.room_id, roomId), sql`LOWER(${messages.sender}) = LOWER(${sender})`));

  return (row?.count ?? 0) > 0;
}

export async function upsertRoomAgentPresence(input: {
  room_id: string;
  actor_label: string;
  agent_key?: string | null;
  display_name: string;
  owner_label?: string | null;
  ide_label?: string | null;
  status: AgentPresenceStatus;
  status_text?: string | null;
}): Promise<RoomAgentPresence> {
  const now = new Date().toISOString();

  const [presence] = await db
    .insert(room_agent_presence)
    .values({
      room_id: input.room_id,
      actor_label: input.actor_label,
      agent_key: input.agent_key ?? null,
      display_name: input.display_name,
      owner_label: input.owner_label ?? null,
      ide_label: input.ide_label ?? null,
      status: input.status,
      status_text: input.status_text ?? null,
      last_heartbeat_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [room_agent_presence.room_id, room_agent_presence.actor_label],
      set: {
        agent_key: input.agent_key ?? null,
        display_name: input.display_name,
        owner_label: input.owner_label ?? null,
        ide_label: input.ide_label ?? null,
        status: input.status,
        status_text: input.status_text ?? null,
        last_heartbeat_at: now,
        updated_at: now,
      },
    })
    .returning();

  return toRoomAgentPresence(presence as RoomAgentPresenceRow);
}

export async function getRoomAgentPresence(
  roomId: string,
  options?: { limit?: number }
): Promise<RoomAgentPresence[]> {
  const limit = clampLimit(options?.limit, 50, 200);
  const rows = await db
    .select()
    .from(room_agent_presence)
    .where(eq(room_agent_presence.room_id, roomId))
    .orderBy(desc(room_agent_presence.last_heartbeat_at), asc(room_agent_presence.display_name))
    .limit(limit);

  return (rows as RoomAgentPresenceRow[]).map(toRoomAgentPresence);
}

export async function upsertRoomParticipant(input: {
  room_id: string;
  participant_key: string;
  kind: "human" | "agent";
  actor_label?: string | null;
  agent_key?: string | null;
  github_login?: string | null;
  display_name: string;
  owner_label?: string | null;
  ide_label?: string | null;
  last_seen_at?: string | null;
}): Promise<RoomParticipant> {
  const now = new Date().toISOString();
  const lastSeenAt = input.last_seen_at ?? now;

  const [participant] = await db
    .insert(room_participants)
    .values({
      room_id: input.room_id,
      participant_key: input.participant_key,
      kind: input.kind,
      actor_label: input.actor_label ?? null,
      agent_key: input.agent_key ?? null,
      github_login: input.github_login ?? null,
      display_name: input.display_name,
      owner_label: input.owner_label ?? null,
      ide_label: input.ide_label ?? null,
      hidden_at: null,
      hidden_by: null,
      last_seen_at: lastSeenAt,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [room_participants.room_id, room_participants.participant_key],
      set: {
        kind: input.kind,
        actor_label: input.actor_label ?? null,
        agent_key: input.agent_key ?? null,
        github_login: input.github_login ?? null,
        display_name: input.display_name,
        owner_label: input.owner_label ?? null,
        ide_label: input.ide_label ?? null,
        hidden_at: null,
        hidden_by: null,
        last_seen_at: lastSeenAt,
        updated_at: now,
      },
    })
    .returning();

  return toRoomParticipant(participant as RoomParticipantRow);
}

export async function getRoomParticipants(
  roomId: string,
  options?: { limit?: number; includeHidden?: boolean }
): Promise<RoomParticipant[]> {
  const limit = clampLimit(options?.limit, 50, 200);
  const conditions = [eq(room_participants.room_id, roomId)];
  if (!options?.includeHidden) {
    conditions.push(sql`${room_participants.hidden_at} IS NULL`);
  }

  const rows = await db
    .select()
    .from(room_participants)
    .where(and(...conditions))
    .orderBy(desc(room_participants.last_seen_at), asc(room_participants.display_name))
    .limit(limit);

  return (rows as RoomParticipantRow[]).map(toRoomParticipant);
}

export async function getRoomParticipantsForRooms(
  roomIds: readonly string[],
  options?: { includeHidden?: boolean }
): Promise<RoomParticipant[]> {
  if (roomIds.length === 0) {
    return [];
  }

  const conditions = [inArray(room_participants.room_id, [...roomIds])];
  if (!options?.includeHidden) {
    conditions.push(sql`${room_participants.hidden_at} IS NULL`);
  }

  const rows = await db
    .select()
    .from(room_participants)
    .where(and(...conditions))
    .orderBy(desc(room_participants.last_seen_at), asc(room_participants.display_name));

  return (rows as RoomParticipantRow[]).map(toRoomParticipant);
}

export async function setRoomParticipantsHidden(input: {
  room_id: string;
  participant_keys: readonly string[];
  hidden: boolean;
  hidden_by?: string | null;
}): Promise<number> {
  if (input.participant_keys.length === 0) {
    return 0;
  }

  const now = new Date().toISOString();
  const result = await db
    .update(room_participants)
    .set({
      hidden_at: input.hidden ? now : null,
      hidden_by: input.hidden ? input.hidden_by ?? null : null,
      updated_at: now,
    })
    .where(
      and(
        eq(room_participants.room_id, input.room_id),
        inArray(room_participants.participant_key, [...input.participant_keys])
      )
    );

  return Number(result.rowCount ?? 0);
}

export async function getTasksForRooms(roomIds: readonly string[]): Promise<Task[]> {
  if (roomIds.length === 0) {
    return [];
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.room_id, [...roomIds]))
    .orderBy(desc(tasks.updated_at), asc(tasks.number));

  return (rows as TaskRow[]).map(toTask);
}

export async function createAuthState(state: string, redirectTo?: string): Promise<AuthState> {
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + AUTH_STATE_TTL_MS).toISOString();

  await db.delete(auth_states).where(lte(auth_states.expires_at, createdAt));

  const authState: AuthState = {
    id: await nextPrefixedId("auth_states", "auth_state"),
    state,
    redirect_to: redirectTo ?? null,
    expires_at: expiresAt,
    created_at: createdAt,
  };

  await db.insert(auth_states).values(authState);
  return authState;
}

export async function consumeAuthState(state: string): Promise<AuthState | null> {
  return db.transaction(async (tx) => {
    const now = new Date().toISOString();
    await tx.delete(auth_states).where(lte(auth_states.expires_at, now));

    const [authState] = await tx.select().from(auth_states).where(eq(auth_states.state, state)).limit(1);
    if (!authState) {
      return null;
    }

    await tx.delete(auth_states).where(eq(auth_states.state, state));
    return authState;
  });
}

export async function upsertAccount(input: {
  provider: string;
  provider_user_id: string;
  login: string;
  display_name?: string | null;
  avatar_url?: string | null;
}): Promise<Account> {
  const [existing] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, input.provider),
        eq(accounts.provider_user_id, input.provider_user_id)
      )
    )
    .limit(1);

  const now = new Date().toISOString();

  if (existing) {
    await db
      .update(accounts)
      .set({
        login: input.login,
        display_name: input.display_name ?? null,
        avatar_url: input.avatar_url ?? null,
        updated_at: now,
      })
      .where(eq(accounts.id, existing.id));

    return {
      ...existing,
      login: input.login,
      display_name: input.display_name ?? null,
      avatar_url: input.avatar_url ?? null,
      updated_at: now,
    };
  }

  const account: Account = {
    id: await nextPrefixedId("accounts", "acct"),
    provider: input.provider,
    provider_user_id: input.provider_user_id,
    login: input.login,
    display_name: input.display_name ?? null,
    avatar_url: input.avatar_url ?? null,
    created_at: now,
    updated_at: now,
  };

  await db.insert(accounts).values(account);
  return account;
}

export async function createSession(
  accountId: string,
  token: string,
  expiresAt: string,
  providerAccessToken?: string | null
): Promise<Session> {
  const tokenHash = hashToken(token);
  const session: Session = {
    id: await nextPrefixedId("auth_sessions", "sess"),
    account_id: accountId,
    token_hash: tokenHash,
    provider_access_token: providerAccessToken ?? null,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  };

  await db.insert(auth_sessions).values(session);
  return session;
}

export async function refreshProviderAccessTokenForAccount(
  accountId: string,
  providerAccessToken: string | null | undefined
): Promise<void> {
  if (!providerAccessToken) {
    return;
  }

  const now = new Date().toISOString();

  await Promise.all([
    db
      .update(auth_sessions)
      .set({
        provider_access_token: providerAccessToken,
      })
      .where(eq(auth_sessions.account_id, accountId)),
    db
      .update(owner_tokens)
      .set({
        provider_access_token: providerAccessToken,
        updated_at: now,
      })
      .where(eq(owner_tokens.account_id, accountId)),
  ]);
}

export async function getSessionAccountByToken(token: string): Promise<SessionAccount | null> {
  const tokenHash = hashToken(token);
  const [session] = await db
    .select({
      id: auth_sessions.id,
      account_id: auth_sessions.account_id,
      token_hash: auth_sessions.token_hash,
      provider_access_token: auth_sessions.provider_access_token,
      expires_at: auth_sessions.expires_at,
      created_at: auth_sessions.created_at,
      provider: accounts.provider,
      provider_user_id: accounts.provider_user_id,
      login: accounts.login,
      display_name: accounts.display_name,
      avatar_url: accounts.avatar_url,
    })
    .from(auth_sessions)
    .innerJoin(accounts, eq(auth_sessions.account_id, accounts.id))
    .where(eq(auth_sessions.token_hash, tokenHash))
    .limit(1);

  if (!session) {
    return null;
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await deleteSessionByToken(token);
    return null;
  }

  return session;
}

export async function deleteSessionByToken(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await db.delete(auth_sessions).where(eq(auth_sessions.token_hash, tokenHash));
}

export async function createOwnerToken(input: {
  accountId: string;
  githubUserId: string;
  token: string;
  providerAccessToken?: string | null;
  oauthTokenExpiresAt?: string | null;
}): Promise<OwnerToken> {
  const now = new Date().toISOString();
  const tokenHash = hashToken(input.token);

  const ownerToken: OwnerToken = {
    token_id: await nextPrefixedId("owner_tokens", "owner_token"),
    account_id: input.accountId,
    github_user_id: input.githubUserId,
    token_hash: tokenHash,
    provider_access_token: input.providerAccessToken ?? null,
    oauth_token_expires_at: input.oauthTokenExpiresAt ?? null,
    created_at: now,
    updated_at: now,
  };

  await db.insert(owner_tokens).values(ownerToken);
  return ownerToken;
}

export async function getOwnerTokenAccountByToken(token: string): Promise<OwnerTokenAccount | null> {
  const tokenHash = hashToken(token);

  const [ownerToken] = await db
    .select({
      token_id: owner_tokens.token_id,
      account_id: owner_tokens.account_id,
      github_user_id: owner_tokens.github_user_id,
      token_hash: owner_tokens.token_hash,
      provider_access_token: owner_tokens.provider_access_token,
      oauth_token_expires_at: owner_tokens.oauth_token_expires_at,
      created_at: owner_tokens.created_at,
      updated_at: owner_tokens.updated_at,
      provider: accounts.provider,
      provider_user_id: accounts.provider_user_id,
      login: accounts.login,
      display_name: accounts.display_name,
      avatar_url: accounts.avatar_url,
    })
    .from(owner_tokens)
    .innerJoin(accounts, eq(owner_tokens.account_id, accounts.id))
    .where(eq(owner_tokens.token_hash, tokenHash))
    .limit(1);

  return ownerToken ?? null;
}

export async function registerAgentIdentity(input: {
  owner_account_id: string;
  owner_login: string;
  owner_label: string;
  name: string;
  display_name?: string;
}): Promise<AgentIdentity> {
  const canonicalKey = `${input.owner_login}/${input.name}`;
  const [existing] = await db
    .select()
    .from(agents)
    .where(eq(agents.canonical_key, canonicalKey))
    .limit(1);

  const now = new Date().toISOString();
  const displayName = input.display_name?.trim() || input.name;

  if (existing) {
    await db
      .update(agents)
      .set({
        display_name: displayName,
        owner_label: input.owner_label,
        updated_at: now,
      })
      .where(eq(agents.id, existing.id));

    return {
      ...existing,
      display_name: displayName,
      owner_label: input.owner_label,
      updated_at: now,
    };
  }

  const agent: AgentIdentity = {
    id: await nextPrefixedId("agents", "agent"),
    canonical_key: canonicalKey,
    name: input.name,
    display_name: displayName,
    owner_account_id: input.owner_account_id,
    owner_login: input.owner_login,
    owner_label: input.owner_label,
    created_at: now,
    updated_at: now,
  };

  await db.insert(agents).values(agent);
  return agent;
}

export async function getAgentIdentityByCanonicalKey(
  canonicalKey: string
): Promise<AgentIdentity | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.canonical_key, canonicalKey))
    .limit(1);

  return agent ?? null;
}

export async function getAgentIdentitiesForOwner(ownerAccountId: string): Promise<AgentIdentity[]> {
  return db
    .select()
    .from(agents)
    .where(eq(agents.owner_account_id, ownerAccountId))
    .orderBy(asc(agents.name));
}

export async function assignProjectAdmin(projectId: string, accountId: string): Promise<void> {
  await db
    .insert(project_admins)
    .values({
      project_id: projectId,
      account_id: accountId,
      assigned_at: new Date().toISOString(),
    })
    .onConflictDoNothing();
}

export async function isProjectAdmin(projectId: string, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
    })
    .from(project_admins)
    .where(
      and(eq(project_admins.project_id, projectId), eq(project_admins.account_id, accountId))
    );

  return (row?.count ?? 0) > 0;
}

export async function createTask(
  roomId: string,
  title: string,
  createdBy: string,
  description?: string,
  sourceMessageId?: string
): Promise<Task> {
  const now = new Date().toISOString();
  const task: TaskRow = {
    room_id: roomId,
    number: await nextRoomScopedNumber("tasks", roomId),
    title,
    description: description ?? null,
    status: "proposed",
    assignee: null,
    assignee_agent_key: null,
    created_by: createdBy,
    source_message_id: sourceMessageId ?? null,
    pr_url: null,
    workflow_artifacts: [],
    created_at: now,
    updated_at: now,
  };

  await db.insert(tasks).values(task);

  return toTask(task);
}

export async function getTasks(
  roomId: string,
  statusFilter?: string,
  options?: { limit?: number; after?: string }
): Promise<{ tasks: Task[]; has_more: boolean }> {
  const limit = clampLimit(options?.limit);
  const afterNumber = options?.after ? parseScopedId(options.after, "task") : null;

  const conditions = [eq(tasks.room_id, roomId)];
  if (statusFilter) conditions.push(eq(tasks.status, statusFilter as TaskStatus));
  if (afterNumber) conditions.push(sql`${tasks.number} > ${afterNumber}`);

  const query = db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.number))
    .limit(limit + 1);

  const rows = (await query) as TaskRow[];
  const has_more = rows.length > limit;
  const bounded = has_more ? rows.slice(0, limit) : rows;
  return { tasks: bounded.map(toTask), has_more };
}

export async function getOpenTasks(
  roomId: string,
  options?: { limit?: number; after?: string }
): Promise<{ tasks: Task[]; has_more: boolean }> {
  const limit = clampLimit(options?.limit);
  const afterNumber = options?.after ? parseScopedId(options.after, "task") : null;

  const conditions = [
    eq(tasks.room_id, roomId),
    notInArray(tasks.status, ["done", "cancelled"]),
  ];
  if (afterNumber) conditions.push(sql`${tasks.number} > ${afterNumber}`);

  const rows = (await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.number))
    .limit(limit + 1)) as TaskRow[];

  const has_more = rows.length > limit;
  const bounded = has_more ? rows.slice(0, limit) : rows;
  return { tasks: bounded.map(toTask), has_more };
}

async function getTaskRowById(roomId: string, taskId: string): Promise<TaskRow | undefined> {
  const taskNumber = parseScopedId(taskId, "task");
  if (!taskNumber) {
    return undefined;
  }

  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.room_id, roomId), eq(tasks.number, taskNumber)))
    .limit(1);

  return task as TaskRow | undefined;
}

export async function getTaskById(roomId: string, taskId: string): Promise<Task | undefined> {
  const task = await getTaskRowById(roomId, taskId);
  return task ? toTask(task) : undefined;
}

export async function getTaskOwnershipState(
  roomId: string,
  taskId: string
): Promise<TaskOwnershipState | undefined> {
  const task = await getTaskRowById(roomId, taskId);
  if (!task) {
    return undefined;
  }

  return {
    status: task.status,
    assignee: task.assignee,
    assignee_agent_key: task.assignee_agent_key,
  };
}

export async function findTaskByPrUrl(roomId: string, prUrl: string): Promise<Task | undefined> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.room_id, roomId), eq(tasks.pr_url, prUrl)))
    .orderBy(asc(tasks.number))
    .limit(1);

  return task ? toTask(task as TaskRow) : undefined;
}

function hasTaskWorkflowArtifactMatchIdentifier(match: TaskWorkflowArtifactMatch): boolean {
  return (
    Boolean(match.url) ||
    Boolean(match.id) ||
    Boolean(match.ref) ||
    Boolean(match.title) ||
    (match.number !== undefined && match.number !== null)
  );
}

function toTaskWorkflowArtifactMatchJson(match: TaskWorkflowArtifactMatch): string {
  const artifact: Record<string, string | number> = {
    provider: match.provider,
    kind: match.kind,
  };

  if (match.id) {
    artifact.id = match.id;
  }

  if (match.number !== undefined && match.number !== null) {
    artifact.number = match.number;
  }

  if (match.title) {
    artifact.title = match.title;
  }

  if (match.url) {
    artifact.url = match.url;
  }

  if (match.ref) {
    artifact.ref = match.ref;
  }

  return JSON.stringify([artifact]);
}

export async function findTaskByWorkflowArtifactMatches(
  roomId: string,
  matches: TaskWorkflowArtifactMatch[]
): Promise<Task | undefined> {
  for (const match of matches) {
    if (!hasTaskWorkflowArtifactMatchIdentifier(match)) {
      continue;
    }

    const [task] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.room_id, roomId),
          sql`${tasks.workflow_artifacts} @> ${toTaskWorkflowArtifactMatchJson(match)}::jsonb`
        )
      )
      .orderBy(asc(tasks.number))
      .limit(1);

    if (task) {
      return toTask(task as TaskRow);
    }
  }

  return undefined;
}

export async function updateTask(
  roomId: string,
  taskId: string,
  updates: {
    status?: TaskStatus;
    assignee?: string | null;
    assignee_agent_key?: string | null;
    pr_url?: string;
    workflow_artifacts?: TaskWorkflowArtifact[];
  }
): Promise<Task | null> {
  const task = await getTaskRowById(roomId, taskId);
  if (!task) return null;

  if (updates.status && !isValidTransition(task.status, updates.status)) {
    throw new Error(
      `Invalid transition: ${task.status} → ${updates.status}. ` +
        `Allowed: ${VALID_TRANSITIONS[task.status].join(", ") || "none"}`
    );
  }

  const taskNumber = parseScopedId(taskId, "task");
  if (!taskNumber) {
    return null;
  }

  const newStatus = updates.status ?? task.status;
  const hasAssigneeUpdate = Object.prototype.hasOwnProperty.call(updates, "assignee");
  const hasAssigneeAgentKeyUpdate = Object.prototype.hasOwnProperty.call(
    updates,
    "assignee_agent_key"
  );
  const newAssignee = hasAssigneeUpdate
    ? updates.assignee ?? null
    : task.assignee;
  const newAssigneeAgentKey = hasAssigneeUpdate
    ? hasAssigneeAgentKeyUpdate
      ? updates.assignee_agent_key ?? null
      : null
    : hasAssigneeAgentKeyUpdate
      ? updates.assignee_agent_key ?? null
      : task.assignee_agent_key;
  const newPrUrl = updates.pr_url ?? task.pr_url;
  const newWorkflowArtifacts = updates.workflow_artifacts
    ? normalizeTaskWorkflowArtifacts({
        artifacts: updates.workflow_artifacts,
        prUrl: newPrUrl,
      })
    : synchronizeTaskWorkflowArtifactsWithPrUrl({
        artifacts: task.workflow_artifacts,
        previousPrUrl: task.pr_url,
        nextPrUrl: newPrUrl,
      });
  const now = new Date().toISOString();

  await db
    .update(tasks)
    .set({
      status: newStatus,
      assignee: newAssignee,
      assignee_agent_key: newAssigneeAgentKey,
      pr_url: newPrUrl,
      workflow_artifacts: newWorkflowArtifacts,
      updated_at: now,
    })
    .where(and(eq(tasks.room_id, roomId), eq(tasks.number, taskNumber)));

  return toTask({
    ...task,
    status: newStatus,
    assignee: newAssignee,
    assignee_agent_key: newAssigneeAgentKey,
    pr_url: newPrUrl,
    workflow_artifacts: newWorkflowArtifacts,
    updated_at: now,
  });
}

function coordinationId(prefix: "tl" | "lock" | "ce"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function expireStaleTaskLeases(
  roomId: string,
  at: Date = new Date()
): Promise<number> {
  const now = at.toISOString();
  const expired = await db
    .update(task_leases)
    .set({
      status: "expired",
      updated_at: now,
    })
    .where(
      and(
        eq(task_leases.room_id, roomId),
        eq(task_leases.status, "active" as TaskLeaseStatus),
        sql`${task_leases.expires_at} IS NOT NULL`,
        lte(task_leases.expires_at, now)
      )
    )
    .returning({ id: task_leases.id });

  return expired.length;
}

export async function createTaskLease(input: {
  room_id: string;
  task_id: string;
  kind: TaskLeaseKind;
  agent_key: string;
  actor_label: string;
  created_by: string;
  agent_instance_id?: string | null;
  branch_ref?: string | null;
  pr_url?: string | null;
  output_intent?: string | null;
  expires_at?: string | null;
}): Promise<TaskLease> {
  const now = new Date().toISOString();
  await expireStaleTaskLeases(input.room_id, new Date(now));
  const row: TaskLeaseRow = {
    id: coordinationId("tl"),
    room_id: input.room_id,
    task_id: input.task_id,
    kind: input.kind,
    status: "active",
    agent_key: input.agent_key,
    agent_instance_id: input.agent_instance_id ?? null,
    actor_label: input.actor_label,
    branch_ref: input.branch_ref ?? null,
    pr_url: input.pr_url ?? null,
    output_intent: input.output_intent ?? null,
    expires_at: input.expires_at ?? null,
    last_heartbeat_at: now,
    revoked_reason: null,
    created_by: input.created_by,
    created_at: now,
    updated_at: now,
  };

  await db.insert(task_leases).values(row);
  return toTaskLease(row);
}

export async function getActiveTaskLeases(
  roomId: string,
  taskId?: string
): Promise<TaskLease[]> {
  const now = new Date().toISOString();
  await expireStaleTaskLeases(roomId, new Date(now));
  const conditions = [
    eq(task_leases.room_id, roomId),
    eq(task_leases.status, "active" as TaskLeaseStatus),
    sql`(${task_leases.expires_at} IS NULL OR ${task_leases.expires_at} > ${now})`,
  ];
  if (taskId) {
    conditions.push(eq(task_leases.task_id, taskId));
  }

  const rows = (await db
    .select()
    .from(task_leases)
    .where(and(...conditions))
    .orderBy(asc(task_leases.created_at))) as TaskLeaseRow[];

  return rows.map(toTaskLease);
}

export async function revokeTaskLease(
  roomId: string,
  leaseId: string,
  revokedReason: string
): Promise<TaskLease | null> {
  const now = new Date().toISOString();
  await db
    .update(task_leases)
    .set({
      status: "revoked",
      revoked_reason: revokedReason,
      updated_at: now,
    })
    .where(and(eq(task_leases.room_id, roomId), eq(task_leases.id, leaseId)));

  const [row] = (await db
    .select()
    .from(task_leases)
    .where(and(eq(task_leases.room_id, roomId), eq(task_leases.id, leaseId)))
    .limit(1)) as TaskLeaseRow[];

  return row ? toTaskLease(row) : null;
}

export async function updateTaskLeaseWorkflowRefs(
  roomId: string,
  leaseId: string,
  updates: {
    branch_ref?: string | null;
    pr_url?: string | null;
  }
): Promise<TaskLease | null> {
  const now = new Date().toISOString();
  const patch: {
    branch_ref?: string | null;
    pr_url?: string | null;
    updated_at: string;
  } = {
    updated_at: now,
  };
  if (Object.prototype.hasOwnProperty.call(updates, "branch_ref")) {
    patch.branch_ref = updates.branch_ref ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "pr_url")) {
    patch.pr_url = updates.pr_url ?? null;
  }

  await db
    .update(task_leases)
    .set(patch)
    .where(and(eq(task_leases.room_id, roomId), eq(task_leases.id, leaseId)));

  const [row] = (await db
    .select()
    .from(task_leases)
    .where(and(eq(task_leases.room_id, roomId), eq(task_leases.id, leaseId)))
    .limit(1)) as TaskLeaseRow[];

  return row ? toTaskLease(row) : null;
}

export async function createTaskLock(input: {
  room_id: string;
  scope: TaskLockScope;
  reason: TaskLockReason;
  created_by: string;
  task_id?: string | null;
  message?: string | null;
}): Promise<TaskLock> {
  const now = new Date().toISOString();
  const row: TaskLockRow = {
    id: coordinationId("lock"),
    room_id: input.room_id,
    task_id: input.task_id ?? null,
    scope: input.scope,
    reason: input.reason,
    message: input.message ?? null,
    created_by: input.created_by,
    created_at: now,
    cleared_by: null,
    cleared_at: null,
  };

  await db.insert(task_locks).values(row);
  return toTaskLock(row);
}

export async function getActiveTaskLocks(
  roomId: string,
  taskId?: string
): Promise<TaskLock[]> {
  const conditions = [
    eq(task_locks.room_id, roomId),
    sql`${task_locks.cleared_at} IS NULL`,
  ];
  if (taskId) {
    conditions.push(
      or(
        eq(task_locks.scope, "room" as TaskLockScope),
        and(eq(task_locks.scope, "task" as TaskLockScope), eq(task_locks.task_id, taskId))
      )!
    );
  }

  const rows = (await db
    .select()
    .from(task_locks)
    .where(and(...conditions))
    .orderBy(asc(task_locks.created_at))) as TaskLockRow[];

  return rows.map(toTaskLock);
}

export async function clearTaskLock(
  roomId: string,
  lockId: string,
  clearedBy: string
): Promise<TaskLock | null> {
  const now = new Date().toISOString();
  await db
    .update(task_locks)
    .set({
      cleared_by: clearedBy,
      cleared_at: now,
    })
    .where(and(eq(task_locks.room_id, roomId), eq(task_locks.id, lockId)));

  const [row] = (await db
    .select()
    .from(task_locks)
    .where(and(eq(task_locks.room_id, roomId), eq(task_locks.id, lockId)))
    .limit(1)) as TaskLockRow[];

  return row ? toTaskLock(row) : null;
}

export async function createCoordinationEvent(input: {
  room_id: string;
  event_type: string;
  decision?: CoordinationDecision;
  task_id?: string | null;
  lease_id?: string | null;
  lock_id?: string | null;
  actor_label?: string | null;
  actor_key?: string | null;
  actor_instance_id?: string | null;
  reason?: string | null;
  metadata?: CoordinationEventMetadata | null;
}): Promise<CoordinationEvent> {
  const row: CoordinationEventRow = {
    id: coordinationId("ce"),
    room_id: input.room_id,
    task_id: input.task_id ?? null,
    lease_id: input.lease_id ?? null,
    lock_id: input.lock_id ?? null,
    event_type: input.event_type,
    decision: input.decision ?? "record",
    actor_label: input.actor_label ?? null,
    actor_key: input.actor_key ?? null,
    actor_instance_id: input.actor_instance_id ?? null,
    reason: input.reason ?? null,
    metadata: input.metadata ?? null,
    created_at: new Date().toISOString(),
  };

  await db.insert(coordination_events).values(row);
  return toCoordinationEvent(row);
}

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

export async function insertGitHubRoomEvent(input: {
  room_id?: string | null;
  delivery_id?: string | null;
  event_type: GitHubRoomEventType;
  action: string;
  idempotency_key: string;
  github_object_id?: string | null;
  github_object_url?: string | null;
  title?: string | null;
  state?: string | null;
  actor_login?: string | null;
  metadata?: GitHubRoomEventMetadata | null;
  linked_task_id?: string | null;
}): Promise<{ event: GitHubRoomEvent; duplicate: boolean }> {
  const id = `gre_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date().toISOString();

  const [created] = await db
    .insert(github_room_events)
    .values({
      id,
      room_id: input.room_id ?? null,
      delivery_id: input.delivery_id ?? null,
      event_type: input.event_type,
      action: input.action,
      idempotency_key: input.idempotency_key,
      github_object_id: input.github_object_id ?? null,
      github_object_url: input.github_object_url ?? null,
      title: input.title ?? null,
      state: input.state ?? null,
      actor_login: input.actor_login ?? null,
      metadata: input.metadata ?? null,
      linked_task_id: input.linked_task_id ?? null,
      created_at: now,
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return { event: created as GitHubRoomEvent, duplicate: false };
  }

  // Idempotency key conflict — fetch the existing record (key is globally unique)
  const [existing] = await db
    .select()
    .from(github_room_events)
    .where(eq(github_room_events.idempotency_key, input.idempotency_key))
    .limit(1);

  if (!existing) {
    throw new Error(
      `GitHub room event with idempotency key '${input.idempotency_key}' could not be recorded`
    );
  }

  return { event: existing as GitHubRoomEvent, duplicate: true };
}

export async function updateGitHubRoomEventLinkedTaskId(
  idempotencyKey: string,
  linkedTaskId: string | null
): Promise<void> {
  await db
    .update(github_room_events)
    .set({
      linked_task_id: linkedTaskId,
    })
    .where(eq(github_room_events.idempotency_key, idempotencyKey));
}

export async function getGitHubRoomEvents(input: {
  room_id: string;
  event_type?: string;
  github_object_id?: string;
  actor_login?: string;
  since?: string;
  until?: string;
  after?: string;
  limit?: number;
}): Promise<{ events: GitHubRoomEvent[]; has_more: boolean }> {
  const MAX_LIMIT = 100;
  const limit = Math.min(input.limit ?? 50, MAX_LIMIT);
  const conditions = [eq(github_room_events.room_id, input.room_id)];

  if (input.event_type) {
    conditions.push(eq(github_room_events.event_type, input.event_type));
  }
  if (input.github_object_id) {
    conditions.push(eq(github_room_events.github_object_id, input.github_object_id));
  }
  if (input.actor_login) {
    conditions.push(eq(github_room_events.actor_login, input.actor_login));
  }
  if (input.since) {
    conditions.push(sql`${github_room_events.created_at} >= ${input.since}`);
  }
  if (input.until) {
    conditions.push(sql`${github_room_events.created_at} <= ${input.until}`);
  }
  if (input.after) {
    // Keyset cursor: fetch events strictly after the cursor using (created_at, id)
    // to avoid skipping events with identical timestamps
    const [cursorRow] = await db
      .select({
        created_at: github_room_events.created_at,
        id: github_room_events.id,
      })
      .from(github_room_events)
      .where(and(
        eq(github_room_events.id, input.after),
        eq(github_room_events.room_id, input.room_id),
      ))
      .limit(1);
    if (cursorRow) {
      conditions.push(
        sql`(${github_room_events.created_at}, ${github_room_events.id}) < (${cursorRow.created_at}, ${cursorRow.id})`
      );
    }
  }

  const rows = await db
    .select()
    .from(github_room_events)
    .where(and(...conditions))
    .orderBy(desc(github_room_events.created_at), desc(github_room_events.id))
    .limit(limit + 1);

  const has_more = rows.length > limit;
  const events = (has_more ? rows.slice(0, limit) : rows) as GitHubRoomEvent[];

  return { events, has_more };
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
  pr_actor: string | null;
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

/**
 * Get GitHub artifact status for all tasks in a room that have linked events.
 * Uses linked_task_id from github_room_events to aggregate per task.
 */
export async function getTasksGitHubArtifactStatus(
  roomId: string
): Promise<Map<string, TaskGitHubArtifactStatus>> {
  const queryResults = await db
    .select({
      event: github_room_events,
      taskId: sql<string>`'task_' || ${tasks.number}`,
    })
    .from(github_room_events)
    .innerJoin(
      tasks,
      and(
        eq(tasks.room_id, roomId),
        or(
          eq(github_room_events.linked_task_id, sql`'task_' || ${tasks.number}`),
          eq(github_room_events.github_object_url, tasks.pr_url),
          sql`${tasks.workflow_artifacts} @> jsonb_build_array(jsonb_build_object('url', ${github_room_events.github_object_url}))`
        )
      )
    )
    .where(eq(github_room_events.room_id, roomId))
    .orderBy(desc(github_room_events.created_at))
    .limit(500);

  const statusMap = new Map<string, TaskGitHubArtifactStatus>();

  for (const row of queryResults) {
    const event = row.event;
    const taskId = row.taskId;

    if (!statusMap.has(taskId)) {
      statusMap.set(taskId, {
        task_id: taskId,
        pr_state: null,
        pr_title: null,
        pr_url: null,
        pr_number: null,
        pr_actor: null,
        checks: [],
        reviews: [],
        check_summary: { total: 0, success: 0, failure: 0, pending: 0 },
        review_summary: { total: 0, approved: 0, changes_requested: 0 },
      });
    }

    const status = statusMap.get(taskId)!;

    if (event.event_type === "pull_request" && status.pr_state === null) {
      status.pr_state = event.state;
      status.pr_title = event.title;
      status.pr_url = event.github_object_url;
      status.pr_number = event.github_object_id;
      status.pr_actor = event.actor_login;
    }

    if (event.event_type === "check_run") {
      const checkName = event.title ?? event.github_object_id ?? "unknown";
      if (!status.checks.some((c) => c.name === checkName)) {
        const conclusion = event.state ?? (event.metadata as Record<string, unknown> | null)?.conclusion as string | null ?? null;
        status.checks.push({
          name: checkName,
          conclusion,
          state: event.action,
          actor: event.actor_login,
        });
      }
    }

    if (event.event_type === "pull_request_review") {
      const actor = event.actor_login;
      if (!status.reviews.some((r) => r.actor === actor)) {
        status.reviews.push({
          actor,
          state: event.state ?? event.action,
        });
      }
    }
  }

  for (const status of statusMap.values()) {
    status.check_summary.total = status.checks.length;
    for (const check of status.checks) {
      const conclusion = check.conclusion?.toLowerCase();
      if (conclusion === "success") status.check_summary.success++;
      else if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "cancelled") status.check_summary.failure++;
      else status.check_summary.pending++;
    }

    status.review_summary.total = status.reviews.length;
    for (const review of status.reviews) {
      const state = review.state?.toLowerCase();
      if (state === "approved") status.review_summary.approved++;
      else if (state === "changes_requested") status.review_summary.changes_requested++;
    }
  }

  return statusMap;
}
