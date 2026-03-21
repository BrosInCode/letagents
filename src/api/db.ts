import { and, asc, eq, notInArray, sql } from "drizzle-orm";

import { db } from "./db/client.js";
import {
  accounts,
  agents,
  auth_sessions,
  auth_states,
  id_sequences,
  messages,
  project_admins,
  rooms,
  tasks,
} from "./db/schema.js";

export interface Room {
  id: string;
  code: string | null;
  name: string | null;
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
  token: string;
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

export interface AuthState {
  id: string;
  state: string;
  redirect_to: string | null;
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

interface MessageRow extends Message {
  room_id: string;
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
  return `${seg1}-${seg2}`;
}

function isUniqueConstraintError(error: unknown): error is { code?: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function toRoom(row: typeof rooms.$inferSelect): Room {
  return {
    id: row.id,
    code: row.code ?? null,
    name: row.name ?? null,
    created_at: row.created_at,
  };
}

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

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export async function createAdHocRoom(): Promise<Room> {
  const created_at = new Date().toISOString();

  while (true) {
    const room: Room = {
      id: generateCode(),
      code: null,
      name: null,
      created_at,
    };

    try {
      await db.insert(rooms).values(room);
      return room;
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
  }
}

export async function createRoom(id: string): Promise<Room> {
  const created_at = new Date().toISOString();
  const room: Room = { id, code: null, name: null, created_at };
  await db.insert(rooms).values(room);
  return room;
}

export async function getRoomById(id: string): Promise<Room | undefined> {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, id)).limit(1);
  return room ? toRoom(room) : undefined;
}

export async function getRoomByCode(code: string): Promise<Room | undefined> {
  const [room] = await db.select().from(rooms).where(eq(rooms.code, code)).limit(1);
  return room ? toRoom(room) : undefined;
}

export async function getOrCreateRoom(id: string): Promise<{ room: Room; created: boolean }> {
  const existing = await getRoomById(id);
  if (existing) {
    return { room: existing, created: false };
  }
  try {
    const room = await createRoom(id);
    return { room, created: true };
  } catch (error) {
    // Handle race condition: another concurrent join may have created the room
    if (isUniqueConstraintError(error)) {
      const retried = await getRoomById(id);
      if (retried) {
        return { room: retried, created: false };
      }
    }
    throw error;
  }
}

export async function addMessage(projectId: string, sender: string, text: string): Promise<Message> {
  const message: MessageRow = {
    id: await nextPrefixedId("messages", "msg"),
    room_id: projectId,
    sender,
    text,
    timestamp: new Date().toISOString(),
  };

  await db.insert(messages).values(message);

  return {
    id: message.id,
    sender: message.sender,
    text: message.text,
    timestamp: message.timestamp,
  };
}

const messageOrderSql = sql<number>`CAST(SUBSTRING(${messages.id} FROM 5) AS integer)`;

export async function getMessages(projectId: string): Promise<Message[]> {
  return db
    .select({
      id: messages.id,
      sender: messages.sender,
      text: messages.text,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(eq(messages.room_id, projectId))
    .orderBy(messageOrderSql);
}

export async function getMessagesAfter(
  projectId: string,
  afterMessageId: string | undefined
): Promise<Message[]> {
  if (!afterMessageId) {
    return getMessages(projectId);
  }

  const match = /^msg_(\d+)$/.exec(afterMessageId);
  if (!match) {
    return getMessages(projectId);
  }

  const afterNumber = Number(match[1]);

  return db
    .select({
      id: messages.id,
      sender: messages.sender,
      text: messages.text,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(and(eq(messages.room_id, projectId), sql`${messageOrderSql} > ${afterNumber}`))
    .orderBy(messageOrderSql);
}

export async function hasMessagesFromSender(projectId: string, sender: string): Promise<boolean> {
  const [row] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
    })
    .from(messages)
    .where(and(eq(messages.room_id, projectId), sql`LOWER(${messages.sender}) = LOWER(${sender})`));

  return (row?.count ?? 0) > 0;
}

export async function createAuthState(state: string, redirectTo?: string): Promise<AuthState> {
  const authState: AuthState = {
    id: await nextPrefixedId("auth_states", "auth_state"),
    state,
    redirect_to: redirectTo ?? null,
    created_at: new Date().toISOString(),
  };

  await db.insert(auth_states).values(authState);
  return authState;
}

export async function consumeAuthState(state: string): Promise<AuthState | null> {
  return db.transaction(async (tx) => {
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
  const session: Session = {
    id: await nextPrefixedId("auth_sessions", "sess"),
    account_id: accountId,
    token,
    provider_access_token: providerAccessToken ?? null,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  };

  await db.insert(auth_sessions).values(session);
  return session;
}

export async function getSessionAccountByToken(token: string): Promise<SessionAccount | null> {
  const [session] = await db
    .select({
      id: auth_sessions.id,
      account_id: auth_sessions.account_id,
      token: auth_sessions.token,
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
    .where(eq(auth_sessions.token, token))
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
  await db.delete(auth_sessions).where(eq(auth_sessions.token, token));
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
      room_id: projectId,
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
      and(eq(project_admins.room_id, projectId), eq(project_admins.account_id, accountId))
    );

  return (row?.count ?? 0) > 0;
}

export async function createTask(
  projectId: string,
  title: string,
  createdBy: string,
  description?: string,
  sourceMessageId?: string
): Promise<Task> {
  const now = new Date().toISOString();
  const task: Task = {
    id: await nextPrefixedId("tasks", "task"),
    room_id: projectId,
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

  return task;
}

export async function getTasks(projectId: string, statusFilter?: string): Promise<Task[]> {
  if (statusFilter) {
    return db
      .select()
      .from(tasks)
      .where(and(eq(tasks.room_id, projectId), eq(tasks.status, statusFilter as TaskStatus)))
      .orderBy(asc(tasks.created_at));
  }

  return db.select().from(tasks).where(eq(tasks.room_id, projectId)).orderBy(asc(tasks.created_at));
}

export async function getOpenTasks(projectId: string): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.room_id, projectId), notInArray(tasks.status, ["done", "cancelled"])))
    .orderBy(asc(tasks.created_at));
}

export async function getTaskById(taskId: string): Promise<Task | undefined> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return task;
}

export async function updateTask(
  taskId: string,
  updates: { status?: TaskStatus; assignee?: string; pr_url?: string }
): Promise<Task | null> {
  const task = await getTaskById(taskId);
  if (!task) return null;

  if (updates.status && !isValidTransition(task.status, updates.status)) {
    throw new Error(
      `Invalid transition: ${task.status} → ${updates.status}. ` +
        `Allowed: ${VALID_TRANSITIONS[task.status].join(", ") || "none"}`
    );
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
    .where(eq(tasks.id, taskId));

  return {
    ...task,
    status: newStatus,
    assignee: newAssignee,
    pr_url: newPrUrl,
    updated_at: now,
  };
}
