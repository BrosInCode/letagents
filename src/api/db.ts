import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export interface Project {
  id: string;
  code: string;
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

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "letagents.db");

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS id_sequences (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'proposed',
    assignee TEXT,
    created_by TEXT NOT NULL,
    source_message_id TEXT,
    pr_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    login TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(provider, provider_user_id)
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    provider_access_token TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS auth_states (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL UNIQUE,
    redirect_to TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    canonical_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    owner_account_id TEXT NOT NULL,
    owner_login TEXT NOT NULL,
    owner_label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(owner_account_id, name)
  );

  CREATE TABLE IF NOT EXISTS project_admins (
    project_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    assigned_at TEXT NOT NULL,
    PRIMARY KEY (project_id, account_id),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );
`);

// Migration: add 'name' column if it doesn't exist (for existing databases)
// SQLite doesn't support ADD COLUMN with UNIQUE constraint, so we add the
// column first, then create a unique index separately.
try {
  db.exec(`ALTER TABLE projects ADD COLUMN name TEXT`);
} catch {
  // Column already exists — ignore
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects(name)`);


const nextSequenceTx = db.transaction((name: string) => {
  const current = db
    .prepare<[string], { value: number }>("SELECT value FROM id_sequences WHERE name = ?")
    .get(name);

  const nextValue = (current?.value ?? 0) + 1;

  db.prepare(
    `
      INSERT INTO id_sequences (name, value)
      VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET value = excluded.value
    `
  ).run(name, nextValue);

  return nextValue;
});

function nextPrefixedId(sequenceName: string, prefix: string): string {
  return `${prefix}_${nextSequenceTx(sequenceName)}`;
}

function generateCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const seg1 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const seg2 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${seg1}-${seg2}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}

export function createProject(): Project {
  const created_at = new Date().toISOString();

  while (true) {
    const project: Project = {
      id: nextPrefixedId("projects", "proj"),
      code: generateCode(),
      created_at,
    };

    try {
      db.prepare("INSERT INTO projects (id, code, created_at) VALUES (?, ?, ?)").run(
        project.id,
        project.code,
        project.created_at
      );
      return project;
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
  }
}

export function createProjectWithName(name: string): Project {
  const created_at = new Date().toISOString();

  while (true) {
    const project: Project = {
      id: nextPrefixedId("projects", "proj"),
      code: generateCode(),
      name,
      created_at,
    };

    try {
      db.prepare("INSERT INTO projects (id, code, name, created_at) VALUES (?, ?, ?, ?)").run(
        project.id,
        project.code,
        project.name,
        project.created_at
      );
      return project;
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      // If the UNIQUE violation is on 'name' (race condition — another request
      // created the same room), return the existing project instead of retrying
      const existing = getProjectByName(name);
      if (existing) {
        return existing;
      }
      // Otherwise it was a code collision — retry with a new code
    }
  }
}

/**
 * Atomic create-or-return by name. Returns existing project if name is taken,
 * otherwise creates a new one.
 */
export function getOrCreateProjectByName(name: string): { project: Project; created: boolean } {
  const existing = getProjectByName(name);
  if (existing) return { project: existing, created: false };
  return { project: createProjectWithName(name), created: true };
}

export function getProjectByName(name: string): Project | undefined {
  return db
    .prepare<[string], Project>("SELECT id, code, name, created_at FROM projects WHERE name = ?")
    .get(name);
}

export function getAllProjects(): Pick<Project, "id" | "code">[] {
  return db
    .prepare<[], Pick<Project, "id" | "code">>("SELECT id, code FROM projects ORDER BY created_at")
    .all();
}

export function getProjectByCode(code: string): Project | undefined {
  return db
    .prepare<[string], Project>("SELECT id, code, name, created_at FROM projects WHERE code = ?")
    .get(code);
}

export function getProjectById(id: string): Project | undefined {
  return db
    .prepare<[string], Project>("SELECT id, code, name, created_at FROM projects WHERE id = ?")
    .get(id);
}

export function rotateProjectCode(projectId: string): Project | null {
  const project = getProjectById(projectId);
  if (!project) return null;

  while (true) {
    const nextCode = generateCode();
    try {
      db.prepare("UPDATE projects SET code = ? WHERE id = ?").run(nextCode, projectId);
      return { ...project, code: nextCode };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
  }
}

export function addMessage(projectId: string, sender: string, text: string): Message {
  const message: MessageRow = {
    id: nextPrefixedId("messages", "msg"),
    project_id: projectId,
    sender,
    text,
    timestamp: new Date().toISOString(),
  };

  db.prepare(
    "INSERT INTO messages (id, project_id, sender, text, timestamp) VALUES (?, ?, ?, ?, ?)"
  ).run(message.id, message.project_id, message.sender, message.text, message.timestamp);

  return {
    id: message.id,
    sender: message.sender,
    text: message.text,
    timestamp: message.timestamp,
  };
}

export function getMessages(projectId: string): Message[] {
  return db
    .prepare<[string], Message>(
      `
        SELECT id, sender, text, timestamp
        FROM messages
        WHERE project_id = ?
        ORDER BY CAST(SUBSTR(id, 5) AS INTEGER)
      `
    )
    .all(projectId);
}

export function getMessagesAfter(projectId: string, afterMessageId: string | undefined): Message[] {
  if (!afterMessageId) {
    return getMessages(projectId);
  }

  const match = /^msg_(\d+)$/.exec(afterMessageId);
  if (!match) {
    return getMessages(projectId);
  }

  return db
    .prepare<[string, number], Message>(
      `
        SELECT id, sender, text, timestamp
        FROM messages
        WHERE project_id = ?
          AND CAST(SUBSTR(id, 5) AS INTEGER) > ?
        ORDER BY CAST(SUBSTR(id, 5) AS INTEGER)
      `
    )
    .all(projectId, Number(match[1]));
}

export function hasMessagesFromSender(projectId: string, sender: string): boolean {
  const row = db
    .prepare<[string, string], { count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM messages
        WHERE project_id = ?
          AND lower(sender) = lower(?)
      `
    )
    .get(projectId, sender);

  return (row?.count ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Identity & Sessions
// ---------------------------------------------------------------------------

export function createAuthState(state: string, redirectTo?: string): AuthState {
  const authState: AuthState = {
    id: nextPrefixedId("auth_states", "auth_state"),
    state,
    redirect_to: redirectTo ?? null,
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `
      INSERT INTO auth_states (id, state, redirect_to, created_at)
      VALUES (?, ?, ?, ?)
    `
  ).run(authState.id, authState.state, authState.redirect_to, authState.created_at);

  return authState;
}

export function consumeAuthState(state: string): AuthState | null {
  const authState = db
    .prepare<[string], AuthState>(
      "SELECT id, state, redirect_to, created_at FROM auth_states WHERE state = ?"
    )
    .get(state);

  if (!authState) return null;

  db.prepare("DELETE FROM auth_states WHERE state = ?").run(state);
  return authState;
}

export function upsertAccount(input: {
  provider: string;
  provider_user_id: string;
  login: string;
  display_name?: string | null;
  avatar_url?: string | null;
}): Account {
  const existing = db
    .prepare<[string, string], Account>(
      `
        SELECT id, provider, provider_user_id, login, display_name, avatar_url, created_at, updated_at
        FROM accounts
        WHERE provider = ? AND provider_user_id = ?
      `
    )
    .get(input.provider, input.provider_user_id);

  const now = new Date().toISOString();

  if (existing) {
    db.prepare(
      `
        UPDATE accounts
        SET login = ?, display_name = ?, avatar_url = ?, updated_at = ?
        WHERE id = ?
      `
    ).run(input.login, input.display_name ?? null, input.avatar_url ?? null, now, existing.id);

    return {
      ...existing,
      login: input.login,
      display_name: input.display_name ?? null,
      avatar_url: input.avatar_url ?? null,
      updated_at: now,
    };
  }

  const account: Account = {
    id: nextPrefixedId("accounts", "acct"),
    provider: input.provider,
    provider_user_id: input.provider_user_id,
    login: input.login,
    display_name: input.display_name ?? null,
    avatar_url: input.avatar_url ?? null,
    created_at: now,
    updated_at: now,
  };

  db.prepare(
    `
      INSERT INTO accounts (
        id, provider, provider_user_id, login, display_name, avatar_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    account.id,
    account.provider,
    account.provider_user_id,
    account.login,
    account.display_name,
    account.avatar_url,
    account.created_at,
    account.updated_at
  );

  return account;
}

export function createSession(
  accountId: string,
  token: string,
  expiresAt: string,
  providerAccessToken?: string | null
): Session {
  const session: Session = {
    id: nextPrefixedId("auth_sessions", "sess"),
    account_id: accountId,
    token,
    provider_access_token: providerAccessToken ?? null,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `
      INSERT INTO auth_sessions (id, account_id, token, provider_access_token, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
  ).run(
    session.id,
    session.account_id,
    session.token,
    session.provider_access_token,
    session.expires_at,
    session.created_at
  );

  return session;
}

export function getSessionAccountByToken(token: string): SessionAccount | null {
  const session = db
    .prepare<[string], SessionAccount>(
      `
        SELECT
          s.id,
          s.account_id,
          s.token,
          s.provider_access_token,
          s.expires_at,
          s.created_at,
          a.provider,
          a.provider_user_id,
          a.login,
          a.display_name,
          a.avatar_url
        FROM auth_sessions s
        JOIN accounts a ON a.id = s.account_id
        WHERE s.token = ?
      `
    )
    .get(token);

  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
    return null;
  }

  return session;
}

export function deleteSessionByToken(token: string): void {
  db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
}

export function registerAgentIdentity(input: {
  owner_account_id: string;
  owner_login: string;
  owner_label: string;
  name: string;
  display_name?: string;
}): AgentIdentity {
  const canonicalKey = `${input.owner_login}/${input.name}`;
  const existing = db
    .prepare<[string], AgentIdentity>(
      `
        SELECT
          id,
          canonical_key,
          name,
          display_name,
          owner_account_id,
          owner_login,
          owner_label,
          created_at,
          updated_at
        FROM agents
        WHERE canonical_key = ?
      `
    )
    .get(canonicalKey);

  const now = new Date().toISOString();
  const displayName = input.display_name?.trim() || input.name;

  if (existing) {
    db.prepare(
      `
        UPDATE agents
        SET display_name = ?, owner_label = ?, updated_at = ?
        WHERE id = ?
      `
    ).run(displayName, input.owner_label, now, existing.id);

    return {
      ...existing,
      display_name: displayName,
      owner_label: input.owner_label,
      updated_at: now,
    };
  }

  const agent: AgentIdentity = {
    id: nextPrefixedId("agents", "agent"),
    canonical_key: canonicalKey,
    name: input.name,
    display_name: displayName,
    owner_account_id: input.owner_account_id,
    owner_login: input.owner_login,
    owner_label: input.owner_label,
    created_at: now,
    updated_at: now,
  };

  db.prepare(
    `
      INSERT INTO agents (
        id,
        canonical_key,
        name,
        display_name,
        owner_account_id,
        owner_login,
        owner_label,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    agent.id,
    agent.canonical_key,
    agent.name,
    agent.display_name,
    agent.owner_account_id,
    agent.owner_login,
    agent.owner_label,
    agent.created_at,
    agent.updated_at
  );

  return agent;
}

export function getAgentIdentitiesForOwner(ownerAccountId: string): AgentIdentity[] {
  return db
    .prepare<[string], AgentIdentity>(
      `
        SELECT
          id,
          canonical_key,
          name,
          display_name,
          owner_account_id,
          owner_login,
          owner_label,
          created_at,
          updated_at
        FROM agents
        WHERE owner_account_id = ?
        ORDER BY name
      `
    )
    .all(ownerAccountId);
}

export function assignProjectAdmin(projectId: string, accountId: string): void {
  db.prepare(
    `
      INSERT INTO project_admins (project_id, account_id, assigned_at)
      VALUES (?, ?, ?)
      ON CONFLICT(project_id, account_id) DO NOTHING
    `
  ).run(projectId, accountId, new Date().toISOString());
}

export function isProjectAdmin(projectId: string, accountId: string): boolean {
  const row = db
    .prepare<[string, string], { count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM project_admins
        WHERE project_id = ? AND account_id = ?
      `
    )
    .get(projectId, accountId);

  return (row?.count ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Task Board
// ---------------------------------------------------------------------------

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

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function createTask(
  projectId: string,
  title: string,
  createdBy: string,
  description?: string,
  sourceMessageId?: string
): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: nextPrefixedId("tasks", "task"),
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

  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, status, assignee, created_by, source_message_id, pr_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    task.id,
    task.project_id,
    task.title,
    task.description,
    task.status,
    task.assignee,
    task.created_by,
    task.source_message_id,
    task.pr_url,
    task.created_at,
    task.updated_at
  );

  return task;
}

export function getTasks(projectId: string, statusFilter?: string): Task[] {
  if (statusFilter) {
    return db
      .prepare<[string, string], Task>(
        `SELECT * FROM tasks WHERE project_id = ? AND status = ? ORDER BY created_at`
      )
      .all(projectId, statusFilter);
  }
  return db
    .prepare<[string], Task>(
      `SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at`
    )
    .all(projectId);
}

export function getOpenTasks(projectId: string): Task[] {
  return db
    .prepare<[string], Task>(
      `SELECT * FROM tasks WHERE project_id = ? AND status NOT IN ('done', 'cancelled') ORDER BY created_at`
    )
    .all(projectId);
}

export function getTaskById(taskId: string): Task | undefined {
  return db
    .prepare<[string], Task>("SELECT * FROM tasks WHERE id = ?")
    .get(taskId);
}

export function updateTask(
  taskId: string,
  updates: { status?: TaskStatus; assignee?: string; pr_url?: string }
): Task | null {
  const task = getTaskById(taskId);
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

  db.prepare(
    `UPDATE tasks SET status = ?, assignee = ?, pr_url = ?, updated_at = ? WHERE id = ?`
  ).run(newStatus, newAssignee, newPrUrl, now, taskId);

  return { ...task, status: newStatus, assignee: newAssignee, pr_url: newPrUrl, updated_at: now };
}
