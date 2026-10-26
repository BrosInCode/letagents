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
 * A received image counts only from the agent's latest dispatched turns in
 * the room. A provider may compact its history without a new continuation,
 * and a compacted image is gone from it: an image still in view after this
 * many turns is offered once more. A refusal for good, or a note that the
 * agent cannot view images, stays for every turn the inbox still retains.
 */
const RECENT_TURNS_WITH_IMAGES = 20;

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

/** What earlier dispatched turns of this conversation in this room received or refused, as `${messageId}\n${attachmentId}`. */
export function readPreparedRoomTurnFiles(database: DatabaseSync, input: {
  agentId: string; roomId: string; continuation: string;
  /** The turn being prepared, which is not one of its own earlier turns. */
  inboxItemId: string;
}): Map<string, RoomTurnFileOutcome> {
  // Turns in the order they were prepared for dispatch: a human message can
  // overtake an older queued one, so the inbox row order is not that order.
  const rows = database.prepare(`SELECT files,turn FROM (
      SELECT json_extract(c.snapshot_json,'$.${ROOM_FILES_KEY}.files') AS files,
        json_extract(c.snapshot_json,'$.${ROOM_FILES_KEY}.continuation') AS continuation,
        ROW_NUMBER() OVER (ORDER BY json_extract(c.snapshot_json,'$.preparedAt') DESC, i.rowid DESC) AS turn
      FROM supervised_agent_prepared_context c JOIN supervised_agent_inbox i ON i.inbox_item_id=c.inbox_item_id
      WHERE i.agent_id=? AND i.room_id=? AND i.inbox_item_id<>?
    ) WHERE continuation=?`).all(input.agentId, input.roomId, input.inboxItemId, input.continuation) as Array<{ files: unknown; turn: number }>;
  const outcomes = new Map<string, RoomTurnFileOutcome>();
  for (const row of rows) {
    let files: unknown;
    try { files = typeof row.files === "string" ? JSON.parse(row.files) : null; } catch { continue; }
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      const entry = file && typeof file === "object" ? file as Record<string, unknown> : {};
      if (typeof entry.message_id !== "string" || typeof entry.attachment_id !== "string"
        || !["image", "not_image", "too_large", "provider_unsupported"].includes(String(entry.outcome))) continue;
      if (entry.outcome === "image" && Number(row.turn) > RECENT_TURNS_WITH_IMAGES) continue;
      const key = `${entry.message_id}\n${entry.attachment_id}`;
      // Shown once is what matters most; a refusal never hides that.
      if (outcomes.get(key) !== "image") outcomes.set(key, entry.outcome as RoomTurnFileOutcome);
    }
  }
  return outcomes;
}
