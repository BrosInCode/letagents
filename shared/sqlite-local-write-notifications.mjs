/**
 * Install the durable, cross-process signal used by local room consumers.
 *
 * SQLite does not expose a portable cross-process notification primitive. A
 * trigger-maintained sequence keeps the signal crash-atomic with the message
 * insert and lets readers poll one indexed scalar instead of repeatedly
 * hydrating the messages table while a room is idle.
 */
export function ensureLocalChatWriteNotificationSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS local_chat_room_write_sequences_v1 (
      room_id TEXT PRIMARY KEY,
      write_sequence INTEGER NOT NULL CHECK (write_sequence >= 0)
    );
    CREATE TRIGGER IF NOT EXISTS local_chat_messages_notify_insert_v1
    AFTER INSERT ON local_chat_messages
    BEGIN
      INSERT INTO local_chat_room_write_sequences_v1 (room_id, write_sequence)
      VALUES (NEW.room_id, 1)
      ON CONFLICT(room_id) DO UPDATE SET
        write_sequence = write_sequence + 1;
    END;
  `);
  const table = database
    .prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'local_chat_room_write_sequences_v1'
    `)
    .get();
  const columns = database
    .prepare("PRAGMA table_info(local_chat_room_write_sequences_v1)")
    .all();
  const tableDefinition = normalizeSchemaSql(table?.sql);
  const tableShapeIsValid =
    columns.length === 2
    && isColumn(columns[0], {
      cid: 0,
      name: "room_id",
      type: "TEXT",
      notnull: 0,
      primaryKey: 1,
    })
    && isColumn(columns[1], {
      cid: 1,
      name: "write_sequence",
      type: "INTEGER",
      notnull: 1,
      primaryKey: 0,
    })
    && tableDefinition === normalizeSchemaSql(`
      CREATE TABLE local_chat_room_write_sequences_v1 (
        room_id TEXT PRIMARY KEY,
        write_sequence INTEGER NOT NULL CHECK (write_sequence >= 0)
      )
    `);
  if (!tableShapeIsValid) {
    throw new Error("Local chat write notification table v1 is invalid.");
  }
  const trigger = database
    .prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'trigger' AND name = 'local_chat_messages_notify_insert_v1'
    `)
    .get();
  const definition = normalizeSchemaSql(trigger?.sql);
  const expectedDefinition = normalizeSchemaSql(`
    CREATE TRIGGER local_chat_messages_notify_insert_v1
    AFTER INSERT ON local_chat_messages
    BEGIN
      INSERT INTO local_chat_room_write_sequences_v1 (room_id, write_sequence)
      VALUES (NEW.room_id, 1)
      ON CONFLICT(room_id) DO UPDATE SET
        write_sequence = write_sequence + 1;
    END
  `);
  if (definition !== expectedDefinition) {
    throw new Error("Local chat write notification trigger v1 is invalid.");
  }
}

function normalizeSchemaSql(value) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().toLowerCase()
    : "";
}

function isColumn(value, expected) {
  return value
    && Number(value.cid) === expected.cid
    && value.name === expected.name
    && String(value.type).toUpperCase() === expected.type
    && Number(value.notnull) === expected.notnull
    && value.dflt_value === null
    && Number(value.pk) === expected.primaryKey;
}

export function getLocalChatRoomWriteSequence(database, roomId) {
  let row;
  try {
    row = database
      .prepare(`
        SELECT write_sequence
        FROM local_chat_room_write_sequences_v1
        WHERE room_id = ?
      `)
      .get(roomId);
  } catch {
    throw new Error("Local chat write sequence is invalid.");
  }
  if (!row) return 0;
  const sequence = Number(row?.write_sequence ?? 0);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Local chat write sequence is invalid.");
  }
  return sequence;
}
