import { DatabaseSync } from "node:sqlite";

import type { ApprovalReference } from "./execution-approval-journal.js";
import type { LocalExecutionDelegation } from "./execution-delegation-journal.js";
import type { WorkerPublicationOrigin } from "./worker-publication-authority.js";

export type ExecutionApprovalPublicationPin = WorkerPublicationOrigin & {
  sourceMessageId: string;
  inboxItemId: string;
  workAttemptId: string;
  delegationInstanceId: string;
  delegationRevision: number;
  delegationScopeSha256: string;
  approverAccountId: string;
  expected: ApprovalReference;
  projectionSha256: string;
  producedAtMs: number;
  expiresAtMs: number;
};

export type ExecutionApprovalPublicationRecord = ExecutionApprovalPublicationPin & {
  state: "open" | "attempted" | "acknowledged" | "closing" | "closed" | "conflict" | "expired" | "invalid";
  publicationId: string | null;
  publicationDigest: string | null;
  publishedAtMs: number | null;
  closedAtMs: number | null;
};

const table = "execution_approval_publications";
const MAX_PINS = 10_000;
const TERMINAL_RETAIN = 5_000;
const identityColumns = ["agent_id", "room_id", "delegation_instance_id", "delegation_revision", "request_id", "request_version"];
const immutableColumns = [
  "agent_id", "room_id", "api_origin", "agent_key", "agent_instance_id", "host_id", "installation_id", "source_session_id",
  "source_message_id", "inbox_item_id", "work_attempt_id", "delegation_instance_id", "delegation_revision",
  "delegation_scope_sha256", "approver_account_id", "request_id", "request_version", "request_sha256",
  "execution_generation_id", "runtime_generation_id", "turn_id", "provider_continuation_id", "provider_turn_id",
  "connection_id", "native_request_id_type", "native_request_id", "projection_sha256", "produced_at_ms", "expires_at_ms",
];
const schema = [
  `CREATE TABLE ${table} (
    agent_id TEXT NOT NULL, room_id TEXT NOT NULL, api_origin TEXT NOT NULL, agent_key TEXT NOT NULL,
    agent_instance_id TEXT NOT NULL, host_id TEXT NOT NULL, installation_id TEXT NOT NULL, source_session_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL, inbox_item_id TEXT NOT NULL, work_attempt_id TEXT NOT NULL,
    delegation_instance_id TEXT NOT NULL, delegation_revision INTEGER NOT NULL CHECK(delegation_revision BETWEEN 1 AND 2147483647),
    delegation_scope_sha256 TEXT NOT NULL CHECK(length(delegation_scope_sha256)=64 AND delegation_scope_sha256 NOT GLOB '*[^0-9a-f]*'),
    approver_account_id TEXT NOT NULL, request_id TEXT NOT NULL,
    request_version INTEGER NOT NULL CHECK(request_version BETWEEN 1 AND 2147483647),
    request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
    execution_generation_id TEXT NOT NULL, runtime_generation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    provider_continuation_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL, connection_id TEXT NOT NULL,
    native_request_id_type TEXT NOT NULL CHECK(native_request_id_type IN ('string','number')), native_request_id TEXT NOT NULL,
    projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256)=64 AND projection_sha256 NOT GLOB '*[^0-9a-f]*'),
    produced_at_ms INTEGER NOT NULL CHECK(produced_at_ms>=0), expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>produced_at_ms),
    state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','attempted','acknowledged','closing','closed','conflict','expired','invalid')),
    publication_id TEXT, publication_digest TEXT CHECK(publication_digest IS NULL OR (length(publication_digest)=64 AND publication_digest NOT GLOB '*[^0-9a-f]*')),
    published_at_ms INTEGER, closed_at_ms INTEGER,
    PRIMARY KEY(agent_id,room_id,delegation_instance_id,delegation_revision,request_id,request_version),
    CHECK(native_request_id_type='string' OR (json_valid(native_request_id) AND json_type(native_request_id) IN ('integer','real'))),
    CHECK((state IN ('open','attempted') AND publication_id IS NULL AND publication_digest IS NULL AND published_at_ms IS NULL AND closed_at_ms IS NULL)
      OR (state IN ('acknowledged','closing') AND publication_id IS NOT NULL AND publication_digest IS NOT NULL
        AND published_at_ms>=0 AND published_at_ms<expires_at_ms AND closed_at_ms IS NULL)
      OR (state='closed' AND publication_id IS NOT NULL AND publication_digest IS NOT NULL
        AND published_at_ms>=0 AND published_at_ms<expires_at_ms AND closed_at_ms>=0)
      OR (state IN ('conflict','expired','invalid') AND closed_at_ms IS NULL AND (
        (publication_id IS NULL AND publication_digest IS NULL AND published_at_ms IS NULL)
        OR (publication_id IS NOT NULL AND publication_digest IS NOT NULL AND published_at_ms>=0 AND published_at_ms<expires_at_ms))))
  ) STRICT`,
  `CREATE INDEX execution_approval_publications_open_agent ON ${table}(agent_id)
    WHERE state IN ('open','attempted','acknowledged','closing')`,
  `CREATE TRIGGER execution_approval_publication_capacity BEFORE INSERT ON ${table}
    WHEN (SELECT COUNT(*) FROM (SELECT 1 FROM ${table} LIMIT ${MAX_PINS}))>=${MAX_PINS}
    BEGIN SELECT RAISE(ABORT,'Execution approval publication capacity reached'); END`,
  `CREATE TRIGGER execution_approval_publication_immutable BEFORE UPDATE ON ${table}
    WHEN ${immutableColumns.map(column => `NEW.${column} IS NOT OLD.${column}`).join(" OR ")}
      OR OLD.state NOT IN ('open','attempted','acknowledged','closing')
      OR (OLD.state='open' AND NEW.state NOT IN ('attempted','conflict','expired','invalid'))
      OR (OLD.state='attempted' AND NEW.state NOT IN ('acknowledged','conflict','expired','invalid'))
      OR (OLD.state='acknowledged' AND NEW.state NOT IN ('closing','expired','invalid'))
      OR (OLD.state='closing' AND NEW.state NOT IN ('closed','conflict','expired','invalid'))
      OR ((OLD.state<>'attempted' OR NEW.state<>'acknowledged') AND (
        NEW.publication_id IS NOT OLD.publication_id OR NEW.publication_digest IS NOT OLD.publication_digest
        OR NEW.published_at_ms IS NOT OLD.published_at_ms))
      OR ((OLD.state<>'closing' OR NEW.state<>'closed') AND NEW.closed_at_ms IS NOT OLD.closed_at_ms)
    BEGIN SELECT RAISE(ABORT,'Execution approval publication custody is immutable'); END`,
  `CREATE TRIGGER execution_approval_publication_open_no_delete BEFORE DELETE ON ${table}
    WHEN OLD.state IN ('open','attempted','acknowledged','closing')
    BEGIN SELECT RAISE(ABORT,'Pending execution approval publication custody cannot be removed'); END`,
];

function invalid(): never { throw new Error("Execution approval publication has invalid custody or receipt."); }
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid();
  return value;
}
function int(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) invalid();
  return Number(value);
}
function sourceMessage(value: unknown): string {
  if (typeof value !== "string" || !/^msg_[1-9]\d{0,9}$/.test(value) || Number(value.slice(4)) > 2_147_483_647) invalid();
  return value;
}
function origin(value: WorkerPublicationOrigin): WorkerPublicationOrigin {
  const result = { agentId: text(value.agentId), roomId: text(value.roomId), apiOrigin: text(value.apiOrigin),
    agentKey: text(value.agentKey), agentInstanceId: text(value.agentInstanceId), hostId: text(value.hostId),
    installationId: text(value.installationId), sourceSessionId: text(value.sourceSessionId) };
  let url: URL;
  try { url = new URL(result.apiOrigin); } catch { return invalid(); }
  const loopback = ["127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.origin !== result.apiOrigin || url.username || url.password
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) invalid();
  return result;
}
function pin(value: ExecutionApprovalPublicationPin): ExecutionApprovalPublicationPin {
  const expected = value.expected;
  if (!expected || typeof expected !== "object" || expected.agentId !== value.agentId || expected.roomId !== value.roomId) invalid();
  const nativeRequestId = typeof expected.nativeRequestId === "number"
    ? int(expected.nativeRequestId) : text(expected.nativeRequestId);
  return {
    ...origin(value), sourceMessageId: sourceMessage(value.sourceMessageId), inboxItemId: text(value.inboxItemId),
    workAttemptId: text(value.workAttemptId), delegationInstanceId: text(value.delegationInstanceId),
    delegationRevision: int(value.delegationRevision, 2_147_483_647), delegationScopeSha256: digest(value.delegationScopeSha256),
    approverAccountId: text(value.approverAccountId),
    expected: { requestId: text(expected.requestId), requestVersion: int(expected.requestVersion, 2_147_483_647),
      requestSha256: digest(expected.requestSha256), agentId: text(expected.agentId), roomId: text(expected.roomId),
      executionGenerationId: text(expected.executionGenerationId), runtimeGenerationId: text(expected.runtimeGenerationId),
      turnId: text(expected.turnId), providerContinuationId: text(expected.providerContinuationId),
      providerTurnId: text(expected.providerTurnId), connectionId: text(expected.connectionId), nativeRequestId },
    projectionSha256: digest(value.projectionSha256), producedAtMs: int(value.producedAtMs), expiresAtMs: int(value.expiresAtMs),
  };
}
function values(value: ExecutionApprovalPublicationPin): unknown[] {
  const p = pin(value); const e = p.expected;
  return [p.agentId, p.roomId, p.apiOrigin, p.agentKey, p.agentInstanceId, p.hostId, p.installationId, p.sourceSessionId,
    p.sourceMessageId, p.inboxItemId, p.workAttemptId, p.delegationInstanceId, p.delegationRevision,
    p.delegationScopeSha256, p.approverAccountId, e.requestId, e.requestVersion, e.requestSha256,
    e.executionGenerationId, e.runtimeGenerationId, e.turnId, e.providerContinuationId, e.providerTurnId, e.connectionId,
    typeof e.nativeRequestId, typeof e.nativeRequestId === "number" ? JSON.stringify(e.nativeRequestId) : e.nativeRequestId,
    p.projectionSha256, p.producedAtMs, p.expiresAtMs];
}
function decode(row: Record<string, unknown>): ExecutionApprovalPublicationRecord {
  const nativeRequestId = row.native_request_id_type === "number" ? JSON.parse(String(row.native_request_id)) : String(row.native_request_id);
  const base = pin({ agentId: String(row.agent_id), roomId: String(row.room_id), apiOrigin: String(row.api_origin),
    agentKey: String(row.agent_key), agentInstanceId: String(row.agent_instance_id), hostId: String(row.host_id),
    installationId: String(row.installation_id), sourceSessionId: String(row.source_session_id),
    sourceMessageId: String(row.source_message_id), inboxItemId: String(row.inbox_item_id), workAttemptId: String(row.work_attempt_id),
    delegationInstanceId: String(row.delegation_instance_id), delegationRevision: Number(row.delegation_revision),
    delegationScopeSha256: String(row.delegation_scope_sha256), approverAccountId: String(row.approver_account_id),
    expected: { requestId: String(row.request_id), requestVersion: Number(row.request_version), requestSha256: String(row.request_sha256),
      agentId: String(row.agent_id), roomId: String(row.room_id), executionGenerationId: String(row.execution_generation_id),
      runtimeGenerationId: String(row.runtime_generation_id), turnId: String(row.turn_id),
      providerContinuationId: String(row.provider_continuation_id), providerTurnId: String(row.provider_turn_id),
      connectionId: String(row.connection_id), nativeRequestId }, projectionSha256: String(row.projection_sha256),
    producedAtMs: Number(row.produced_at_ms), expiresAtMs: Number(row.expires_at_ms) });
  if (!["open", "attempted", "acknowledged", "closing", "closed", "conflict", "expired", "invalid"].includes(String(row.state))) invalid();
  const publicationId = row.publication_id === null ? null : text(row.publication_id);
  const publicationDigest = row.publication_digest === null ? null : digest(row.publication_digest);
  const publishedAtMs = row.published_at_ms === null ? null : int(row.published_at_ms);
  const closedAtMs = row.closed_at_ms === null ? null : int(row.closed_at_ms);
  const hasReceipt = publicationId !== null && publicationDigest !== null && publishedAtMs !== null;
  if (["acknowledged", "closing", "closed"].includes(String(row.state)) && !hasReceipt
    || ["open", "attempted"].includes(String(row.state)) && hasReceipt
    || (row.state === "closed") !== (closedAtMs !== null)) invalid();
  return { ...base, state: row.state as ExecutionApprovalPublicationRecord["state"],
    publicationId, publicationDigest, publishedAtMs, closedAtMs };
}
function normalizedSql(sql: string): string {
  return (sql.match(/'(?:''|[^'])*'|[^']+/g) ?? []).map(part => part.startsWith("'") ? part
    : part.replaceAll('"', "").replace(/\s+/g, "").toLowerCase()).join("").replace(/;$/, "");
}

export function applyExecutionApprovalPublicationSchema(database: DatabaseSync): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) {
    for (const definition of schema) database.exec(definition);
  }
  validateExecutionApprovalPublicationSchema(database);
}

export function validateExecutionApprovalPublicationSchema(database: DatabaseSync): void {
  const actual = database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND sql IS NOT NULL").all(table)
    .map(row => normalizedSql(String(row.sql))).sort();
  const expected = schema.map(normalizedSql).sort();
  if (actual.length !== expected.length || actual.some((definition, index) => definition !== expected[index])) {
    throw new Error("Execution approval publication journal has invalid or missing schema.");
  }
  let count = 0;
  for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY agent_id,room_id,delegation_instance_id,delegation_revision,request_id,request_version`).iterate()) {
    if (++count > MAX_PINS) invalid();
    decode(row);
  }
}

/** Immutable publication custody and exact remote receipt journal. */
export class ExecutionApprovalPublicationStore {
  constructor(private readonly database: DatabaseSync) {}
  private transaction<T>(body: () => T): T {
    if (this.database.isTransaction) throw new Error("Execution approval publication requires its own transaction.");
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = body(); this.database.exec("COMMIT"); return result; }
    catch (error) { try { this.database.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  }
  get(value: ExecutionApprovalPublicationPin): ExecutionApprovalPublicationRecord | null {
    const p = pin(value);
    const row = this.database.prepare(`SELECT * FROM ${table} WHERE ${identityColumns.map(column => `${column}=?`).join(" AND ")}`)
      .get(p.agentId, p.roomId, p.delegationInstanceId, p.delegationRevision, p.expected.requestId, p.expected.requestVersion);
    return row ? decode(row) : null;
  }
  pin(value: ExecutionApprovalPublicationPin, atMs = Date.now()): ExecutionApprovalPublicationRecord {
    const p = pin(value);
    int(atMs);
    return this.transaction(() => {
      const existing = this.get(p);
      if (existing) {
        if (JSON.stringify(pin(existing)) !== JSON.stringify(p)) invalid();
        return existing;
      }
      const count = Number(this.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
      if (count >= MAX_PINS) {
        this.database.prepare(`UPDATE ${table} SET state='expired'
          WHERE state='acknowledged' AND expires_at_ms<=?`).run(atMs);
        this.database.prepare(`DELETE FROM ${table} WHERE rowid IN (
          SELECT rowid FROM ${table} WHERE state IN ('closed','conflict','expired','invalid')
          ORDER BY COALESCE(published_at_ms,produced_at_ms),agent_id,room_id,delegation_instance_id,
            delegation_revision,request_id,request_version
          LIMIT ?
        )`).run(Math.max(1, count - TERMINAL_RETAIN));
      }
      this.database.prepare(`INSERT INTO ${table}(${immutableColumns.join(",")}) VALUES(${immutableColumns.map(() => "?").join(",")})`)
        .run(...values(p) as never[]);
      return this.get(p)!;
    });
  }
  nextOpenAgent(after: string): string | null {
    const cursor = after === "" ? "" : text(after);
    const row = this.database.prepare(`SELECT agent_id FROM ${table}
      WHERE state IN ('open','attempted','acknowledged','closing') AND agent_id>? ORDER BY agent_id LIMIT 1`).get(cursor);
    return row ? String(row.agent_id) : null;
  }
  listOpen(agentId: string): ExecutionApprovalPublicationRecord[] {
    return this.database.prepare(`SELECT * FROM ${table} WHERE state IN ('open','attempted','acknowledged','closing') AND agent_id=?
      ORDER BY room_id,delegation_instance_id,delegation_revision,request_id,request_version LIMIT 10001`).all(text(agentId)).map(decode);
  }
  markAttempted(sent: ExecutionApprovalPublicationRecord): ExecutionApprovalPublicationRecord {
    const p = pin(sent);
    return this.transaction(() => {
      this.database.prepare(`UPDATE ${table} SET state='attempted'
        WHERE ${identityColumns.map(column => `${column}=?`).join(" AND ")} AND state='open' AND projection_sha256=?`)
        .run(p.agentId, p.roomId, p.delegationInstanceId, p.delegationRevision,
          p.expected.requestId, p.expected.requestVersion, p.projectionSha256);
      const current = this.get(p);
      if (!current || current.state !== "attempted") invalid();
      return current;
    });
  }
  acknowledge(sent: ExecutionApprovalPublicationRecord, receipt: { publicationId: string; publicationDigest: string; publishedAtMs: number }): boolean {
    const p = pin(sent); const publicationId = text(receipt.publicationId); const publicationDigest = digest(receipt.publicationDigest);
    const publishedAtMs = int(receipt.publishedAtMs);
    if (publishedAtMs >= p.expiresAtMs) invalid();
    return this.transaction(() => Number(this.database.prepare(`UPDATE ${table} SET state='acknowledged',publication_id=?,publication_digest=?,published_at_ms=?
      WHERE ${identityColumns.map(column => `${column}=?`).join(" AND ")} AND state='attempted' AND projection_sha256=?`)
      .run(publicationId, publicationDigest, publishedAtMs, p.agentId, p.roomId, p.delegationInstanceId,
        p.delegationRevision, p.expected.requestId, p.expected.requestVersion, p.projectionSha256).changes) === 1);
  }
  beginClose(sent: ExecutionApprovalPublicationRecord): ExecutionApprovalPublicationRecord {
    const p = pin(sent);
    return this.transaction(() => {
      this.database.prepare(`UPDATE ${table} SET state='closing'
        WHERE ${identityColumns.map(column => `${column}=?`).join(" AND ")} AND state='acknowledged'
          AND publication_id=? AND publication_digest=?`)
        .run(p.agentId, p.roomId, p.delegationInstanceId, p.delegationRevision,
          p.expected.requestId, p.expected.requestVersion, sent.publicationId, sent.publicationDigest);
      const current = this.get(p);
      if (!current || current.state !== "closing") invalid();
      return current;
    });
  }
  acknowledgeClose(sent: ExecutionApprovalPublicationRecord, closedAtMs: number): boolean {
    const p = pin(sent); int(closedAtMs);
    return this.transaction(() => Number(this.database.prepare(`UPDATE ${table} SET state='closed',closed_at_ms=?
      WHERE ${identityColumns.map(column => `${column}=?`).join(" AND ")} AND state='closing'
        AND publication_id=? AND publication_digest=?`)
      .run(closedAtMs, p.agentId, p.roomId, p.delegationInstanceId, p.delegationRevision,
        p.expected.requestId, p.expected.requestVersion, sent.publicationId, sent.publicationDigest).changes) === 1);
  }
  conflict(sent: ExecutionApprovalPublicationRecord): void {
    const p = pin(sent);
    this.transaction(() => { this.database.prepare(`UPDATE ${table} SET state='conflict'
      WHERE ${identityColumns.map(column => `${column}=?`).join(" AND ")} AND state IN ('open','attempted','acknowledged','closing')`)
      .run(p.agentId, p.roomId, p.delegationInstanceId, p.delegationRevision, p.expected.requestId, p.expected.requestVersion); });
  }
  expire(sent: ExecutionApprovalPublicationRecord): void {
    const p = pin(sent);
    this.transaction(() => { this.database.prepare(`UPDATE ${table} SET state='expired'
      WHERE ${identityColumns.map(column => `${column}=?`).join(" AND ")} AND state IN ('open','attempted','acknowledged','closing')`)
      .run(p.agentId, p.roomId, p.delegationInstanceId, p.delegationRevision, p.expected.requestId, p.expected.requestVersion); });
  }
  invalidate(sent: ExecutionApprovalPublicationRecord): void {
    const p = pin(sent);
    this.transaction(() => { this.database.prepare(`UPDATE ${table} SET state='invalid'
      WHERE ${identityColumns.map(column => `${column}=?`).join(" AND ")} AND state IN ('open','attempted','acknowledged','closing')`)
      .run(p.agentId, p.roomId, p.delegationInstanceId, p.delegationRevision, p.expected.requestId, p.expected.requestVersion); });
  }
}

export function publicationPinFrom(
  origin: WorkerPublicationOrigin,
  delegation: LocalExecutionDelegation,
  input: Omit<ExecutionApprovalPublicationPin, keyof WorkerPublicationOrigin | "delegationInstanceId" | "delegationRevision" | "delegationScopeSha256" | "approverAccountId">,
): ExecutionApprovalPublicationPin {
  return pin({ ...origin, ...input, delegationInstanceId: delegation.delegationInstanceId,
    delegationRevision: delegation.revision, delegationScopeSha256: delegation.scopeSha256,
    approverAccountId: delegation.approverAccountId });
}
