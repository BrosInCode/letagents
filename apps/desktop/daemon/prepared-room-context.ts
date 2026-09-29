import type { PreparedRoomContext } from "../shared/message-outcome.js";
import type { DatabaseSync } from "node:sqlite";

const TABLE = `CREATE TABLE IF NOT EXISTS supervised_agent_prepared_context (
  inbox_item_id TEXT PRIMARY KEY REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
) STRICT`;

export function applyPreparedRoomContextSchema(database: DatabaseSync): void {
  database.exec(TABLE);
  validatePreparedRoomContextSchema(database);
}

export function validatePreparedRoomContextSchema(database: DatabaseSync): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_prepared_context'").get() as { sql: string } | undefined;
  const normalize = (sql: string) => sql.replace(/IF NOT EXISTS\s+/gi, "").replace(/\s+/g, "").toLowerCase();
  if (!row || normalize(row.sql) !== normalize(TABLE)) throw new Error("Prepared room context storage has an invalid schema.");
}

/** Keep only room text, never attachment payloads, runtime credentials, or arbitrary provider fields. */
export function prepareRoomContext(messages: readonly unknown[], preparedAt: string): PreparedRoomContext {
  const retained = messages.slice(0, 30).map(value => {
    const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const text = typeof row.text === "string" ? row.text : null;
    return {
      id: typeof row.id === "string" ? row.id.slice(0, 256) : null,
      sender: typeof row.sender === "string" ? row.sender.slice(0, 256) : null,
      text: text?.slice(0, 2_000) ?? null,
      truncated: text !== null && text.length > 2_000,
    };
  });
  return { preparedAt, totalMessages: messages.length, omittedMessages: messages.length - retained.length, messages: retained };
}
