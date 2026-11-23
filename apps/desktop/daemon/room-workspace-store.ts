import { encodeWorkspaceReview, REVIEW_PAGE_SIZE, type WorkspaceReview, type WorkspaceReviewPage } from '../../../shared/workspace-review.mjs';
import { archiveWorkspaceReview, pruneUnreferencedReviewArchives, readArchivedReviewPage, reviewArchiveReference } from '../../../shared/workspace-review-archive.mjs';
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
const reviewSchema = `CREATE TABLE IF NOT EXISTS room_workspace_reviews (
  agent_id TEXT NOT NULL, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
  digest TEXT NOT NULL, data TEXT NOT NULL CHECK(length(data)<=134217728),
  uploaded_pages INTEGER NOT NULL DEFAULT 0 CHECK(uploaded_pages>=0),
  PRIMARY KEY(agent_id,room_id,source_message_id),
  FOREIGN KEY(agent_id,room_id,source_message_id) REFERENCES room_workspace_captures(agent_id,room_id,source_message_id)
) STRICT`;
export function validateRoomWorkspaceReviewSchema(db: DatabaseSync): void {
  const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='room_workspace_reviews'").get()?.sql ?? '');
  const normalize = (value: string) => value.replace('IF NOT EXISTS ', '').replace(/\s+/g, ' ').trim();
  if (normalize(sql) !== normalize(reviewSchema)) throw new Error('Invalid full workspace review schema.');
}
export function applyRoomWorkspaceSchema(db: DatabaseSync): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='room_workspace_captures'").get()) db.exec(schema);
  validateRoomWorkspaceSchema(db);
  db.exec(reviewSchema);
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
  private readonly reviewSizeSql: 'octet_length(data)' | 'length(data)';
  private readonly databasePath: string | null;
  private lastArchiveRow = 0;
  private finishedArchiveMigration = false;
  private pruneAfter = 0;
  constructor(private readonly db: DatabaseSync) {
    // In-memory inspection/test databases are self-contained. Only a fenced
    // v54+ on-disk supervisor may commit an external archive reference.
    const file = db.prepare("SELECT file FROM pragma_database_list WHERE name='main'").get()?.file;
    this.databasePath = file && Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 54 ? String(file) : null;
    // Reviews are gzip/base64 ASCII. In UTF-8, byte length comes from SQLite's
    // record metadata, without reading an already-uploaded archive again.
    // Other database encodings retain the original character-count semantics.
    this.reviewSizeSql = db.prepare('PRAGMA encoding').get()?.encoding === 'UTF-8'
      ? 'octet_length(data)' : 'length(data)';
  }
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
  settle(key: WorkspaceCaptureIdentity, summary: RoomAgentWorkSummary, review?: WorkspaceReview): void {
    const parsed = parseRoomAgentWorkSummary(summary);
    if (parsed?.version !== 3) throw new Error('Invalid settled workspace capture.');
    let encoded: ReturnType<typeof encodeWorkspaceReview> | null = null;
    try { encoded = review ? encodeWorkspaceReview(review) : null; }
    catch (error) { if (!(error instanceof RangeError)) throw error; } // Optional archive capacity must never discard a valid preview.
    this.db.exec('SAVEPOINT workspace_review');
    try {
      const result = this.db.prepare('UPDATE room_workspace_captures SET settled_json=? WHERE agent_id=? AND room_id=? AND source_message_id=? AND work_attempt_id=? AND inbox_item_id=? AND settled_json IS NULL').run(JSON.stringify(parsed), ...keys(key));
      if (result.changes && encoded) {
        const data = this.databasePath ? archiveWorkspaceReview(this.databasePath, encoded.data, encoded.digest) : encoded.data;
        this.db.prepare('INSERT INTO room_workspace_reviews(agent_id,room_id,source_message_id,digest,data) VALUES(?,?,?,?,?)')
          .run(...keys(key).slice(0, 3), encoded.digest, data);
      }
      this.db.exec('RELEASE workspace_review');
    } catch (error) { this.db.exec('ROLLBACK TO workspace_review; RELEASE workspace_review'); throw error; }
  }

  /** After startup, move one historical review per publisher pass. The original
   * row remains authoritative until its fsynced archive has been read back. */
  maintainArchives(now: number): boolean {
    if (!this.databasePath || (this.finishedArchiveMigration && now < this.pruneAfter)) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.finishedArchiveMigration) {
        const row = this.db.prepare(`SELECT rowid,digest,data FROM room_workspace_reviews
          WHERE rowid>? AND (${this.reviewSizeSql}>90 OR data NOT GLOB '@review1:*') ORDER BY rowid LIMIT 1`).get(this.lastArchiveRow);
        if (row) {
          this.lastArchiveRow = Number(row.rowid);
          const data = archiveWorkspaceReview(this.databasePath, String(row.data), String(row.digest));
          this.db.prepare('UPDATE room_workspace_reviews SET data=? WHERE rowid=?').run(data, row.rowid);
          this.db.exec('COMMIT');
          return true;
        }
        this.finishedArchiveMigration = true;
      }
      this.pruneAfter = now + 24 * 60 * 60 * 1000;
      pruneUnreferencedReviewArchives(this.databasePath, this.db.prepare(`SELECT data FROM room_workspace_reviews
        WHERE ${this.reviewSizeSql}<=90 AND data GLOB '@review1:*'`).iterate());
      this.db.exec('COMMIT');
      return false;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  pendingPage(agentId: string, roomId: string, sourceMessageId: string): WorkspaceReviewPage | null {
    // A v1 reference fits in 90 bytes. The length guard avoids fetching a
    // completed legacy archive just to find out which representation it uses.
    const row = this.db.prepare(`SELECT digest,uploaded_pages,${this.reviewSizeSql} AS size,
      CASE WHEN ${this.reviewSizeSql}<=90 THEN data
        WHEN uploaded_pages*? < ${this.reviewSizeSql} THEN substr(data,uploaded_pages*?+1,?) END AS page
      FROM room_workspace_reviews WHERE agent_id=? AND room_id=? AND source_message_id=?`)
      .get(REVIEW_PAGE_SIZE, REVIEW_PAGE_SIZE, REVIEW_PAGE_SIZE, agentId, roomId, sourceMessageId);
    if (!row) return null;
    const index = Number(row.uploaded_pages);
    const reference = reviewArchiveReference(row.page);
    const size = reference?.size ?? Number(row.size);
    if (index * REVIEW_PAGE_SIZE >= size) return null;
    const digest = String(row.digest);
    if (reference && !this.databasePath) throw new Error('Workspace review archive location is unavailable.');
    const data = reference ? readArchivedReviewPage(this.databasePath!, reference, digest, index) : String(row.page);
    return { digest, index, total: Math.ceil(size / REVIEW_PAGE_SIZE), data };
  }
  acknowledgePage(agentId: string, roomId: string, sourceMessageId: string, page: WorkspaceReviewPage): void {
    this.db.prepare('UPDATE room_workspace_reviews SET uploaded_pages=uploaded_pages+1 WHERE agent_id=? AND room_id=? AND source_message_id=? AND digest=? AND uploaded_pages=?')
      .run(agentId, roomId, sourceMessageId, page.digest, page.index);
  }
}
