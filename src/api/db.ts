import crypto from "crypto";
import { and, asc, eq, inArray, lte, notInArray, sql } from "drizzle-orm";

import { db } from "./db/client.js";
import {
  accounts,
  agents,
  auth_sessions,
  auth_states,
  github_app_installations,
  github_app_repositories,
  github_webhook_deliveries,
  github_repositories,
  id_sequences,
  messages,
  owner_tokens,
  project_admins,
  room_aliases,
  rooms,
  tasks,
} from "./db/schema.js";
import { generateRoomDisplayName, normalizeRoomDisplayName } from "./room-display-name.js";
import { isInviteCode, normalizeRoomId, normalizeRoomName } from "./room-routing.js";
import {
  isPromptOnlyAgentMessage,
  normalizeAgentPromptKind,
  type AgentPromptKind,
} from "../shared/room-agent-prompts.js";

export interface Project {
  id: string;
  code: string | null;
  display_name: string;
  name?: string;
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

export interface Message {
  id: string;
  sender: string;
  text: string;
  agent_prompt_kind: AgentPromptKind | null;
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

export interface Task {
  id: string;
  room_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee: string | null;
  created_by: string;
  source_message_id: string | null;
  pr_url: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  room_id: string;
  number: number;
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
  created_by: string;
  source_message_id: string | null;
  pr_url: string | null;
  created_at: string;
  updated_at: string;
}

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  proposed: ["accepted", "cancelled"],
  accepted: ["assigned", "cancelled"],
  assigned: ["in_progress", "cancelled"],
  in_progress: ["blocked", "in_review", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  in_review: ["merged", "in_progress", "cancelled"],
  merged: ["done"],
  done: [],
  cancelled: [],
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
  };
}

function toTask(row: TaskRow): Task {
  return {
    id: formatTaskId(row.number),
    room_id: row.room_id,
    title: row.title,
    description: row.description,
    status: row.status,
    assignee: row.assignee,
    created_by: row.created_by,
    source_message_id: row.source_message_id,
    pr_url: row.pr_url,
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
  const rows = await db.select().from(rooms).orderBy(asc(rooms.created_at));
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
  }
): Promise<Message> {
  const promptKind = options?.agent_prompt_kind ?? null;
  return db.transaction(async (tx) => {
    const message: MessageRow = {
      room_id: roomId,
      number: await nextRoomScopedNumber("messages", roomId, tx),
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

    return toMessage(message);
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
  return { messages: bounded.map(toMessage), has_more };
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
    created_by: createdBy,
    source_message_id: sourceMessageId ?? null,
    pr_url: null,
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

export async function getTaskById(roomId: string, taskId: string): Promise<Task | undefined> {
  const taskNumber = parseScopedId(taskId, "task");
  if (!taskNumber) {
    return undefined;
  }

  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.room_id, roomId), eq(tasks.number, taskNumber)))
    .limit(1);

  return task ? toTask(task as TaskRow) : undefined;
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

export async function updateTask(
  roomId: string,
  taskId: string,
  updates: { status?: TaskStatus; assignee?: string; pr_url?: string }
): Promise<Task | null> {
  const task = await getTaskById(roomId, taskId);
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
  const newAssignee = updates.assignee ?? task.assignee;
  const newPrUrl = updates.pr_url ?? task.pr_url;
  const now = new Date().toISOString();

  await db
    .update(tasks)
    .set({
      status: newStatus,
      assignee: newAssignee,
      pr_url: newPrUrl,
      updated_at: now,
    })
    .where(and(eq(tasks.room_id, roomId), eq(tasks.number, taskNumber)));

  return {
    ...task,
    status: newStatus,
    assignee: newAssignee,
    pr_url: newPrUrl,
    updated_at: now,
  };
}
