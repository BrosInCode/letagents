import type { DatabaseSync } from 'node:sqlite';
import { parseRoomAgentWorkSummary, type RoomAgentWorkSummary } from '../../../shared/room-agent-work.mjs';

const schema = `CREATE TABLE room_workspace_captures (
  agent_id TEXT NOT NULL, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
  work_attempt_id TEXT NOT NULL, inbox_item_id TEXT NOT NULL,
  baseline TEXT CHECK(baseline IS NULL OR (length(baseline) IN (40,64) AND baseline NOT GLOB '*[^0-9a-f]*')),
  settled_json TEXT CHECK(settled_json IS NULL OR (length(settled_json)<=524288 AND json_valid(settled_json))),
  PRIMARY KEY(agent_id,room_id,source_message_id),
  FOREIGN KEY(agent_id,room_id,source_message_id) REFERENCES room_work_publications(agent_id,room_id,source_message_id)
) STRICT`;
export function applyRoomWorkspaceSchema(db: DatabaseSync): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='room_workspace_captures'").get()) db.exec(schema);
  validateRoomWorkspaceSchema(db);
}
export function validateRoomWorkspaceSchema(db: DatabaseSync): void {
  const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  if (normalize(String(db.prepare("SELECT sql FROM sqlite_master WHERE name='room_workspace_captures'").get()?.sql)) !== normalize(schema)) throw new Error('Invalid workspace capture schema.');
  for (const row of db.prepare('SELECT settled_json FROM room_workspace_captures WHERE settled_json IS NOT NULL').iterate()) {
    if (parseRoomAgentWorkSummary(JSON.parse(String(row.settled_json)))?.version !== 3) throw new Error('Invalid settled workspace capture.');
  }
}
export type WorkspaceCaptureIdentity = { agentId: string; roomId: string; sourceMessageId: string; workAttemptId: string; inboxItemId: string };
const keys = (key: WorkspaceCaptureIdentity) => [key.agentId, key.roomId, key.sourceMessageId, key.workAttemptId, key.inboxItemId];
export class RoomWorkspaceStore {
  constructor(private readonly db: DatabaseSync) {}
  begin(key: WorkspaceCaptureIdentity): boolean {
    // A second native invocation for the same source is ambiguous. Do not reuse a
    // previous invocation's baseline, even if the provider never returned a turn id.
    const existing = this.db.prepare('SELECT 1 FROM room_workspace_captures WHERE agent_id=? AND room_id=? AND source_message_id=?').get(...keys(key).slice(0, 3));
    if (existing) {
      this.db.prepare('UPDATE room_workspace_captures SET baseline=NULL WHERE agent_id=? AND room_id=? AND source_message_id=? AND settled_json IS NULL').run(...keys(key).slice(0, 3));
      return false;
    }
    this.db.prepare('INSERT INTO room_workspace_captures(agent_id,room_id,source_message_id,work_attempt_id,inbox_item_id) VALUES(?,?,?,?,?)').run(...keys(key));
    return true;
  }
  baseline(key: WorkspaceCaptureIdentity): string | null {
    const row = this.db.prepare('SELECT baseline FROM room_workspace_captures WHERE agent_id=? AND room_id=? AND source_message_id=? AND work_attempt_id=? AND inbox_item_id=?').get(...keys(key));
    return typeof row?.baseline === 'string' ? row.baseline : null;
  }
  setBaseline(key: WorkspaceCaptureIdentity, tree: string | null): void {
    this.db.prepare('UPDATE room_workspace_captures SET baseline=? WHERE agent_id=? AND room_id=? AND source_message_id=? AND work_attempt_id=? AND inbox_item_id=? AND settled_json IS NULL').run(tree, ...keys(key));
  }
  settled(agentId: string, roomId: string, sourceMessageId: string): RoomAgentWorkSummary | null {
    const row = this.db.prepare('SELECT settled_json FROM room_workspace_captures WHERE agent_id=? AND room_id=? AND source_message_id=?').get(agentId, roomId, sourceMessageId);
    return row?.settled_json ? parseRoomAgentWorkSummary(JSON.parse(String(row.settled_json))) : null;
  }
  settle(key: WorkspaceCaptureIdentity, summary: RoomAgentWorkSummary): void {
    const parsed = parseRoomAgentWorkSummary(summary);
    if (parsed?.version !== 3) throw new Error('Invalid settled workspace capture.');
    this.db.prepare('UPDATE room_workspace_captures SET settled_json=? WHERE agent_id=? AND room_id=? AND source_message_id=? AND work_attempt_id=? AND inbox_item_id=? AND settled_json IS NULL').run(JSON.stringify(parsed), ...keys(key));
  }
}
