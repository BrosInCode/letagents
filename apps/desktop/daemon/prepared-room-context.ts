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

/**
 * A file outcome a later turn on the same conversation can rely on: shown,
 * refused for good by its bytes, or noted for a provider that takes no
 * images (turning images on starts a new conversation).
 */
export type RoomTurnFileOutcome = "image" | "not_image" | "too_large" | "provider_unsupported";
/** The room files a provider turn was given or refused for good, for the conversation that holds them. */
export type PreparedRoomTurnFiles = {
  continuation: string;
  files: Array<{ message_id: string; attachment_id: string; outcome: RoomTurnFileOutcome }>;
};
const ROOM_FILES_KEY = "room_files";
/**
 * What a conversation received counts only from the agent's latest turns in
 * the room. A provider may compact its history without a new continuation,
 * and a compacted image is gone from it: an image still in view after this
 * many turns is offered once more.
 */
const RECENT_TURNS_SEARCHED = 20;

/** The prepared context the Inspector reads: room text only, without this turn's file record. */
export function inspectorPreparedRoomContext(snapshot: unknown): PreparedRoomContext | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const { [ROOM_FILES_KEY]: _files, ...context } = snapshot as Record<string, unknown>;
  return context as unknown as PreparedRoomContext;
}

/** Add what a turn's provider received to that turn's own prepared context row. */
export function recordPreparedRoomTurnFiles(database: DatabaseSync, inboxItemId: string, files: PreparedRoomTurnFiles): void {
  database.prepare(`UPDATE supervised_agent_prepared_context SET snapshot_json=json_set(snapshot_json,'$.${ROOM_FILES_KEY}',json(?))
    WHERE inbox_item_id=?`).run(JSON.stringify(files), inboxItemId);
}

/** What the agent's latest turns of this conversation in this room received, as `${messageId}\n${attachmentId}`. */
export function readPreparedRoomTurnFiles(database: DatabaseSync, input: {
  agentId: string; roomId: string; continuation: string;
}): Map<string, RoomTurnFileOutcome> {
  const rows = database.prepare(`SELECT json_extract(c.snapshot_json,'$.${ROOM_FILES_KEY}.files') AS files
    FROM (SELECT inbox_item_id FROM supervised_agent_inbox WHERE agent_id=? AND room_id=? ORDER BY rowid DESC LIMIT ?) i
    JOIN supervised_agent_prepared_context c ON c.inbox_item_id=i.inbox_item_id
    WHERE json_extract(c.snapshot_json,'$.${ROOM_FILES_KEY}.continuation')=?`)
    .all(input.agentId, input.roomId, RECENT_TURNS_SEARCHED, input.continuation) as Array<{ files: unknown }>;
  const outcomes = new Map<string, RoomTurnFileOutcome>();
  for (const row of rows) {
    let files: unknown;
    try { files = typeof row.files === "string" ? JSON.parse(row.files) : null; } catch { continue; }
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      const entry = file && typeof file === "object" ? file as Record<string, unknown> : {};
      if (typeof entry.message_id !== "string" || typeof entry.attachment_id !== "string"
        || !["image", "not_image", "too_large", "provider_unsupported"].includes(String(entry.outcome))) continue;
      const key = `${entry.message_id}\n${entry.attachment_id}`;
      // Shown once is what matters most; a refusal never hides that.
      if (outcomes.get(key) !== "image") outcomes.set(key, entry.outcome as RoomTurnFileOutcome);
    }
  }
  return outcomes;
}
