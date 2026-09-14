import { assertKnowledgeReplay, RoomKnowledgeError } from './room-knowledge.mjs';

export function initializeRoomKnowledge(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS local_room_knowledge (
    room_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, version INTEGER NOT NULL,
    value TEXT NOT NULL, PRIMARY KEY(room_id, id));
    CREATE TABLE IF NOT EXISTS local_room_knowledge_revisions (
    room_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY(room_id, id, version));
    CREATE TABLE IF NOT EXISTS local_room_knowledge_outbox (room_id TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(room_id, id));`);
}
export function listLocalKnowledge(db, roomId, type) {
  initializeRoomKnowledge(db);
  const rows = db.prepare('SELECT value FROM local_room_knowledge WHERE room_id = ? AND type = ? ORDER BY json_extract(value, \'$.archived\') ASC, (json_extract(value, \'$.response\') IS NULL) DESC, json_extract(value, \'$.updated_at\') DESC LIMIT 201').all(roomId, type);
  return { records: rows.slice(0, 200).map(row => JSON.parse(row.value)), truncated: rows.length > 200 };
}
export function getLocalKnowledge(db, roomId, id) {
  initializeRoomKnowledge(db);
  const row = db.prepare('SELECT value FROM local_room_knowledge WHERE room_id = ? AND id = ?').get(roomId, id);
  return row ? JSON.parse(row.value) : null;
}
export function localKnowledgeHistory(db, roomId, id) {
  initializeRoomKnowledge(db);
  return db.prepare('SELECT value FROM local_room_knowledge_revisions WHERE room_id = ? AND id = ? ORDER BY version DESC LIMIT 100').all(roomId, id).map(row => JSON.parse(row.value));
}
export function saveLocalKnowledge(db, record, expectedVersion) {
  initializeRoomKnowledge(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = getLocalKnowledge(db, record.room_id, record.id);
    if (record.source_message_id) assertLocalKnowledgeSource(db, record);
    if (expectedVersion === undefined && existing) {
      const row = db.prepare('SELECT value FROM local_room_knowledge_revisions WHERE room_id = ? AND id = ? AND version = 1').get(record.room_id, record.id);
      if (!row) throw new RoomKnowledgeError('The original version is unavailable. Please refresh.', 409);
      const initial = JSON.parse(row.value);
      assertKnowledgeReplay(initial, record);
      db.exec('COMMIT');
      return existing;
    }
    if (expectedVersion !== undefined && existing?.version !== expectedVersion) throw new RoomKnowledgeError('This changed since you opened it. Refresh to see the latest version.', 409);
    db.prepare('INSERT INTO local_room_knowledge VALUES (?, ?, ?, ?, ?) ON CONFLICT(room_id, id) DO UPDATE SET version = excluded.version, value = excluded.value').run(record.room_id, record.id, record.type, record.version, JSON.stringify(record));
    db.prepare('INSERT INTO local_room_knowledge_revisions VALUES (?, ?, ?, ?)').run(record.room_id, record.id, record.version, JSON.stringify(record));
    if (record.type === 'attention' && record.response) db.prepare('INSERT OR IGNORE INTO local_room_knowledge_outbox VALUES (?, ?, ?)').run(record.room_id, record.id, JSON.stringify(record));
    db.exec('COMMIT');
    return record;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function assertLocalKnowledgeSource(db, record) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_chat_messages'").get();
  const row = table && db.prepare("SELECT number FROM local_chat_messages WHERE room_id = ? AND number = ? AND NOT (COALESCE(agent_prompt_kind, '') = 'auto' AND TRIM(text) = '')").get(record.room_id, Number(record.source_message_id.slice(4)));
  if (!row) throw new RoomKnowledgeError('The source message does not exist or is not visible in this local room.');
}
