import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parseRoomAgentWorkSummary, type RoomAgentWorkSummary } from "../../../shared/room-agent-work.mjs";

export type RoomWorkOrigin = {
  agentId: string; roomId: string; apiOrigin: string; agentKey: string; agentInstanceId: string;
  hostId: string; installationId: string; sourceSessionId: string;
};
export type RoomWorkPublicationIdentity = RoomWorkOrigin & { sourceMessageId: string };
export type RoomWorkPublication = RoomWorkPublicationIdentity & {
  attemptId: string | null; revision: number; summary: RoomAgentWorkSummary | null; digest: string | null;
  acknowledgedRevision: number; state: "open" | "cleared" | "conflict";
};

const table = "room_work_publications";
// Whole-daemon budget also bounds publisher caches. At capacity, new work
// remains local-only; existing immutable provenance is never evicted/reused.
const MAX_PINS = 10_000;
const originColumns = {
  agentId: "agent_id", roomId: "room_id", apiOrigin: "api_origin", agentKey: "agent_key",
  agentInstanceId: "agent_instance_id", hostId: "host_id", installationId: "installation_id", sourceSessionId: "source_session_id",
} as const;
const identityColumns = { ...originColumns, sourceMessageId: "source_message_id" } as const;
const identityFields = Object.keys(identityColumns) as (keyof RoomWorkPublicationIdentity)[];
const columns = Object.values(identityColumns);
const schema = [
  `CREATE TABLE ${table} (
    ${Object.values(originColumns).map(column => `${column} TEXT NOT NULL CHECK(length(${column}) BETWEEN 1 AND 512)`).join(",\n    ")},
    source_message_id TEXT NOT NULL CHECK(source_message_id GLOB 'msg_[1-9]*'
      AND substr(source_message_id,5) NOT GLOB '*[^0-9]*' AND length(source_message_id)<=14
      AND CAST(substr(source_message_id,5) AS INTEGER) BETWEEN 1 AND 2147483647),
    attempt_id TEXT CHECK(attempt_id IS NULL OR length(attempt_id)=36),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
    summary_json TEXT CHECK(summary_json IS NULL OR (length(summary_json)<=2048 AND json_valid(summary_json))),
    digest TEXT CHECK(digest IS NULL OR (length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*')),
    acknowledged_revision INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged_revision BETWEEN 0 AND revision),
    state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','cleared','conflict')),
    PRIMARY KEY(agent_id,room_id,source_message_id),
    CHECK((revision=0 AND attempt_id IS NULL AND summary_json IS NULL AND digest IS NULL AND acknowledged_revision=0 AND state='open')
      OR (revision>0 AND attempt_id IS NOT NULL AND digest IS NOT NULL
        AND ((state='cleared' AND summary_json IS NULL) OR (state IN ('open','conflict') AND summary_json IS NOT NULL))))
  ) STRICT`,
  `CREATE INDEX room_work_publications_open_agent ON ${table}(agent_id) WHERE state='open'`,
  `CREATE TRIGGER room_work_publication_capacity BEFORE INSERT ON ${table}
    WHEN (SELECT COUNT(*) FROM (SELECT 1 FROM ${table} LIMIT ${MAX_PINS}))>=${MAX_PINS}
    BEGIN SELECT RAISE(ABORT,'Room work publication capacity reached'); END`,
  `CREATE TRIGGER room_work_publication_immutable BEFORE UPDATE ON ${table}
    WHEN ${columns.map(column => `NEW.${column} IS NOT OLD.${column}`).join(" OR ")}
      OR (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NOT OLD.attempt_id)
      OR NEW.revision NOT IN (OLD.revision,OLD.revision+1)
      OR NEW.acknowledged_revision<OLD.acknowledged_revision
      OR (NEW.acknowledged_revision<>OLD.acknowledged_revision AND NEW.acknowledged_revision<>NEW.revision)
      OR (OLD.state<>'open' AND (NEW.state IS NOT OLD.state OR NEW.revision<>OLD.revision
        OR NEW.summary_json IS NOT OLD.summary_json OR NEW.digest IS NOT OLD.digest OR NEW.acknowledged_revision<>OLD.acknowledged_revision))
      OR (NEW.revision=OLD.revision AND (NEW.attempt_id IS NOT OLD.attempt_id OR NEW.digest IS NOT OLD.digest
        OR (NEW.summary_json IS NOT OLD.summary_json AND NOT (OLD.state='open' AND NEW.state='cleared' AND NEW.summary_json IS NULL))))
      OR (NEW.revision<>OLD.revision AND (OLD.state<>'open' OR NEW.state<>'open' OR NEW.digest IS OLD.digest))
    BEGIN SELECT RAISE(ABORT,'Room work publication identity and receipts are immutable'); END`,
  `CREATE TRIGGER room_work_publication_no_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT,'Room work publication provenance cannot be removed'); END`,
];

function invalid(): never { throw new Error("Room work publication has invalid identity or receipt."); }
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}
function sourceId(value: unknown): string {
  if (typeof value !== "string" || !/^msg_[1-9]\d{0,9}$/.test(value) || Number(value.slice(4)) > 2147483647) invalid();
  return value;
}
function origin(value: RoomWorkOrigin): RoomWorkOrigin {
  if (!value || typeof value !== "object") invalid();
  const result = Object.fromEntries(Object.keys(originColumns).map(key => [key, text(value[key as keyof RoomWorkOrigin])])) as RoomWorkOrigin;
  let url: URL;
  try { url = new URL(result.apiOrigin); } catch { return invalid(); }
  if (url.origin !== result.apiOrigin || url.username || url.password
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) invalid();
  return result;
}
function identity(value: RoomWorkPublicationIdentity): RoomWorkPublicationIdentity {
  return { ...origin(value), sourceMessageId: sourceId(value.sourceMessageId) };
}
function sameIdentity(left: RoomWorkPublicationIdentity, right: RoomWorkPublicationIdentity): boolean {
  return identityFields.every(field => left[field] === right[field]);
}
function summaryReceipt(value: unknown): { summary: RoomAgentWorkSummary; json: string; digest: string } {
  const summary = parseRoomAgentWorkSummary(value);
  if (!summary) invalid();
  const json = JSON.stringify(summary);
  return { summary, json, digest: createHash("sha256").update(json).digest("hex") };
}
function attemptId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid();
  return value;
}
function decode(row: Record<string, unknown>): RoomWorkPublication {
  const key = identity(Object.fromEntries(identityFields.map(field => [field, row[identityColumns[field]]])) as RoomWorkPublicationIdentity);
  const revision = Number(row.revision); const acknowledgedRevision = Number(row.acknowledged_revision);
  if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(acknowledgedRevision)
    || acknowledgedRevision < 0 || acknowledgedRevision > revision || !["open", "cleared", "conflict"].includes(String(row.state))) invalid();
  let summary: RoomAgentWorkSummary | null = null;
  if (row.summary_json !== null) {
    if (typeof row.summary_json !== "string" || row.summary_json.length > 2048) invalid();
    let parsed: unknown;
    try { parsed = JSON.parse(row.summary_json); } catch { return invalid(); }
    const receipt = summaryReceipt(parsed);
    if (receipt.json !== row.summary_json || receipt.digest !== row.digest) invalid();
    summary = receipt.summary;
  }
  if (revision === 0) {
    if (row.attempt_id !== null || summary !== null || row.digest !== null || row.state !== "open" || acknowledgedRevision !== 0) invalid();
  } else if (!attemptId(row.attempt_id) || typeof row.digest !== "string" || !/^[0-9a-f]{64}$/.test(row.digest)
    || (row.state === "cleared" ? summary !== null : summary === null)) invalid();
  return { ...key, attemptId: row.attempt_id as string | null, revision, summary, digest: row.digest as string | null,
    acknowledgedRevision, state: row.state as RoomWorkPublication["state"] };
}
function normalizedSql(sql: string): string {
  return (sql.match(/'(?:''|[^'])*'|[^']+/g) ?? []).map(part => part.startsWith("'") ? part
    : part.replaceAll('"', "").replace(/\s+/g, "").toLowerCase()).join("").replace(/;$/, "");
}

/** Separate from operational state: no token, provider payload, or manifest FK. */
export function applyRoomWorkPublicationSchema(database: DatabaseSync): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) {
    for (const definition of schema) database.exec(definition);
  }
  validateRoomWorkPublicationSchema(database);
}
export function validateRoomWorkPublicationSchema(database: DatabaseSync): void {
  const actual = database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND sql IS NOT NULL").all(table)
    .map(row => normalizedSql(String(row.sql))).sort();
  const expected = schema.map(normalizedSql).sort();
  if (actual.length !== expected.length || actual.some((definition, index) => definition !== expected[index])) {
    throw new Error("Room work publication journal has invalid or missing schema.");
  }
  const integrity = database.prepare(`PRAGMA integrity_check(${table})`).all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") invalid();
  let count = 0;
  for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY agent_id,room_id,source_message_id`).iterate()) {
    if (++count > MAX_PINS) invalid();
    decode(row);
  }
}

/** Optional publication receipts only. Each synchronous mutation owns a tiny
 * transaction; no caller may hold it across HTTP, provider work, or an await. */
export class RoomWorkPublicationStore {
  constructor(private readonly database: DatabaseSync) {}
  private transaction<T>(body: () => T): T {
    if (this.database.isTransaction) throw new Error("Room work publication requires its own transaction.");
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = body(); this.database.exec("COMMIT"); return result; }
    catch (error) { try { this.database.exec("ROLLBACK"); } catch { /* Already rolled back. */ } throw error; }
  }
  get(agentId: string, roomId: string, sourceMessageId: string): RoomWorkPublication | null {
    const row = this.database.prepare(`SELECT * FROM ${table} WHERE agent_id=? AND room_id=? AND source_message_id=?`)
      .get(text(agentId), text(roomId), sourceId(sourceMessageId));
    return row ? decode(row) : null;
  }
  list(agentId: string): RoomWorkPublication[] {
    const rows = this.database.prepare(`SELECT * FROM ${table} WHERE agent_id=? ORDER BY room_id,source_message_id LIMIT ${MAX_PINS + 1}`).all(text(agentId));
    if (rows.length > MAX_PINS) throw new Error("Room work publication capacity reached.");
    return rows.map(decode);
  }
  pin(value: RoomWorkOrigin, sourceMessageIds: readonly string[]): void {
    const pinned = origin(value);
    if (!Array.isArray(sourceMessageIds) || sourceMessageIds.length > MAX_PINS) invalid();
    const sources = [...new Set(sourceMessageIds.map(sourceId))];
    this.transaction(() => {
      let count = Number(this.database.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} LIMIT ${MAX_PINS + 1})`).get()!.n);
      for (const sourceMessageId of sources) {
        const expected = { ...pinned, sourceMessageId };
        const existing = this.get(pinned.agentId, pinned.roomId, sourceMessageId);
        if (existing) { if (!sameIdentity(existing, expected)) invalid(); continue; }
        if (this.database.prepare("SELECT 1 FROM execution_message_attempts WHERE agent_id=? AND room_id=? AND source_message_id=?")
          .get(pinned.agentId, pinned.roomId, sourceMessageId)) throw new Error("Room work publication cannot attribute previously captured history.");
        if (++count > MAX_PINS) throw new Error("Room work publication capacity reached.");
        this.database.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
          .run(...identityFields.map(field => expected[field]));
      }
    });
  }
  stage(value: RoomWorkPublicationIdentity, captured: { attemptId: string; summary: RoomAgentWorkSummary }): RoomWorkPublication {
    const key = identity(value); const attempt = attemptId(captured.attemptId); const receipt = summaryReceipt(captured.summary);
    return this.transaction(() => {
      const current = this.get(key.agentId, key.roomId, key.sourceMessageId);
      if (!current || !sameIdentity(current, key) || current.state !== "open" || (current.attemptId !== null && current.attemptId !== attempt)) invalid();
      const capturedAttempt = this.database.prepare("SELECT attempt_id FROM execution_message_attempts WHERE agent_id=? AND room_id=? AND source_message_id=?")
        .get(key.agentId, key.roomId, key.sourceMessageId);
      if (capturedAttempt?.attempt_id !== attempt) invalid();
      if (current.digest === receipt.digest) return current;
      if (current.revision === Number.MAX_SAFE_INTEGER) invalid();
      this.database.prepare(`UPDATE ${table} SET attempt_id=?,revision=revision+1,summary_json=?,digest=? WHERE agent_id=? AND room_id=? AND source_message_id=?`)
        .run(attempt, receipt.json, receipt.digest, key.agentId, key.roomId, key.sourceMessageId);
      return this.get(key.agentId, key.roomId, key.sourceMessageId)!;
    });
  }
  acknowledge(sent: RoomWorkPublication): boolean {
    const key = identity(sent);
    if (!Number.isSafeInteger(sent.revision) || sent.revision < 1 || !sent.digest || !sent.attemptId) invalid();
    return this.transaction(() => {
      const current = this.get(key.agentId, key.roomId, key.sourceMessageId);
      if (!current || !sameIdentity(current, key) || current.state !== "open" || current.attemptId !== sent.attemptId
        || current.revision !== sent.revision || current.digest !== sent.digest) return false;
      this.database.prepare(`UPDATE ${table} SET acknowledged_revision=revision WHERE agent_id=? AND room_id=? AND source_message_id=?`)
        .run(key.agentId, key.roomId, key.sourceMessageId);
      return true;
    });
  }
  stop(sent: RoomWorkPublication, state: "cleared" | "conflict"): void {
    const key = identity(sent);
    if (!["cleared", "conflict"].includes(state) || !Number.isSafeInteger(sent.revision) || sent.revision < 1 || !sent.digest || !sent.attemptId) invalid();
    this.transaction(() => {
      const current = this.get(key.agentId, key.roomId, key.sourceMessageId);
      if (!current || !sameIdentity(current, key) || current.attemptId !== sent.attemptId || sent.revision > current.revision) invalid();
      if (sent.revision === current.revision && sent.digest !== current.digest) invalid();
      if (current.state !== "open") return;
      this.database.prepare(`UPDATE ${table} SET state=?,summary_json=CASE WHEN ?='cleared' THEN NULL ELSE summary_json END
        WHERE agent_id=? AND room_id=? AND source_message_id=?`).run(state, state, key.agentId, key.roomId, key.sourceMessageId);
    });
  }
}
