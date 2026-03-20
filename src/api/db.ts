import { and, asc, eq, notInArray, sql } from "drizzle-orm";

import { db } from "./db/client.js";
import { id_sequences, messages, rooms, tasks } from "./db/schema.js";

export interface Project {
  id: string;
  code: string;
  name?: string;
  created_at: string;
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
  project_id: string;
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
  project_id: string;
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

function toProject(row: typeof rooms.$inferSelect): Project {
  return {
    ...row,
    name: row.name ?? undefined,
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

export async function createProject(): Promise<Project> {
  const created_at = new Date().toISOString();

  while (true) {
    const project: Project = {
      id: await nextPrefixedId("projects", "proj"),
      code: generateCode(),
      created_at,
    };

    try {
      await db.insert(rooms).values(project);
      return project;
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
  }
}

export async function createProjectWithName(name: string): Promise<Project> {
  const created_at = new Date().toISOString();

  while (true) {
    const project: Project = {
      id: await nextPrefixedId("projects", "proj"),
      code: generateCode(),
      name,
      created_at,
    };

    try {
      await db.insert(rooms).values(project);
      return project;
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const existing = await getProjectByName(name);
      if (existing) {
        return existing;
      }
    }
  }
}

export async function getOrCreateProjectByName(
  name: string
): Promise<{ project: Project; created: boolean }> {
  const existing = await getProjectByName(name);
  if (existing) {
    return { project: existing, created: false };
  }

  return { project: await createProjectWithName(name), created: true };
}

export async function getProjectByName(name: string): Promise<Project | undefined> {
  const [project] = await db.select().from(rooms).where(eq(rooms.name, name)).limit(1);
  return project ? toProject(project) : undefined;
}

export async function getAllProjects(): Promise<Pick<Project, "id" | "code">[]> {
  return db.select({ id: rooms.id, code: rooms.code }).from(rooms).orderBy(asc(rooms.created_at));
}

export async function getProjectByCode(code: string): Promise<Project | undefined> {
  const [project] = await db.select().from(rooms).where(eq(rooms.code, code)).limit(1);
  return project ? toProject(project) : undefined;
}

export async function getProjectById(id: string): Promise<Project | undefined> {
  const [project] = await db.select().from(rooms).where(eq(rooms.id, id)).limit(1);
  return project ? toProject(project) : undefined;
}

export async function addMessage(projectId: string, sender: string, text: string): Promise<Message> {
  const message: MessageRow = {
    id: await nextPrefixedId("messages", "msg"),
    project_id: projectId,
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
    .where(eq(messages.project_id, projectId))
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
    .where(and(eq(messages.project_id, projectId), sql`${messageOrderSql} > ${afterNumber}`))
    .orderBy(messageOrderSql);
}

export async function hasMessagesFromSender(projectId: string, sender: string): Promise<boolean> {
  const [row] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
    })
    .from(messages)
    .where(and(eq(messages.project_id, projectId), sql`LOWER(${messages.sender}) = LOWER(${sender})`));

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
    project_id: projectId,
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
      .where(and(eq(tasks.project_id, projectId), eq(tasks.status, statusFilter as TaskStatus)))
      .orderBy(asc(tasks.created_at));
  }

  return db.select().from(tasks).where(eq(tasks.project_id, projectId)).orderBy(asc(tasks.created_at));
}

export async function getOpenTasks(projectId: string): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.project_id, projectId), notInArray(tasks.status, ["done", "cancelled"])))
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
