import crypto from "crypto";
import { and, asc, eq, inArray, lte, notInArray, sql } from "drizzle-orm";

import { db } from "./db/client.js";
import {
  accounts,
  agents,
  auth_sessions,
  auth_states,
  id_sequences,
  messages,
  owner_tokens,
  project_admins,
  rooms,
  tasks,
} from "./db/schema.js";
import { generateRoomDisplayName, normalizeRoomDisplayName } from "./room-display-name.js";
import { isInviteCode, normalizeRoomName } from "./room-routing.js";

export interface Project {
  id: string;
  code: string | null;
  display_name: string;
  name?: string;
  created_at: string;
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

async function nextRoomScopedNumber(sequenceName: string, roomId: string): Promise<number> {
  const [next] = await db
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

  return getProjectById(normalizedCode);
}

export async function getProjectById(id: string): Promise<Project | undefined> {
  const [project] = await db.select().from(rooms).where(eq(rooms.id, id)).limit(1);
  return project ? toProject(project) : undefined;
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

export async function addMessage(roomId: string, sender: string, text: string, source?: string): Promise<Message> {
  const message: MessageRow = {
    room_id: roomId,
    number: await nextRoomScopedNumber("messages", roomId),
    sender,
    text,
    source: source ?? null,
    timestamp: new Date().toISOString(),
  };

  await db.insert(messages).values(message);

  return toMessage(message);
}

export async function getMessages(roomId: string): Promise<Message[]> {
  const rows = await db
    .select({
      room_id: messages.room_id,
      number: messages.number,
      sender: messages.sender,
      text: messages.text,
      source: messages.source,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(eq(messages.room_id, roomId))
    .orderBy(asc(messages.number));

  return rows.map(toMessage);
}

export async function getMessagesAfter(
  roomId: string,
  afterMessageId: string | undefined
): Promise<Message[]> {
  const afterNumber = afterMessageId ? parseScopedId(afterMessageId, "msg") : null;
  if (!afterNumber) {
    return getMessages(roomId);
  }

  const rows = await db
    .select({
      room_id: messages.room_id,
      number: messages.number,
      sender: messages.sender,
      text: messages.text,
      source: messages.source,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(and(eq(messages.room_id, roomId), sql`${messages.number} > ${afterNumber}`))
    .orderBy(asc(messages.number));

  return rows.map(toMessage);
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

export async function getTasks(roomId: string, statusFilter?: string): Promise<Task[]> {
  const query = db
    .select()
    .from(tasks)
    .where(
      statusFilter
        ? and(eq(tasks.room_id, roomId), eq(tasks.status, statusFilter as TaskStatus))
        : eq(tasks.room_id, roomId)
    )
    .orderBy(asc(tasks.number));

  const rows = (await query) as TaskRow[];
  return rows.map(toTask);
}

export async function getOpenTasks(roomId: string): Promise<Task[]> {
  const rows = (await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.room_id, roomId), notInArray(tasks.status, ["done", "cancelled"])))
    .orderBy(asc(tasks.number))) as TaskRow[];

  return rows.map(toTask);
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
