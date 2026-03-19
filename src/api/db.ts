import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

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
`);

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
    }
  }
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
    .prepare<[string], Project>("SELECT id, code, created_at FROM projects WHERE code = ?")
    .get(code);
}

export function getProjectById(id: string): Project | undefined {
  return db
    .prepare<[string], Project>("SELECT id, code, created_at FROM projects WHERE id = ?")
    .get(id);
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
