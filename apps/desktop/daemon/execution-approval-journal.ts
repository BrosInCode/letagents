import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { executionIdentity } from "./execution-protocol.js";
import type { ApprovalState } from "./execution-reducer.js";
import { executionStorageIdentity, materializeExecutionIdentity } from "./execution-shadow-store.js";
import { lifecycleAuthorityModeForProvider } from "./lifecycle-authority-mode.js";
import { sameProviderActionConnectionIdentity } from "./provider-action-port.js";
import type { DaemonManifestEntry } from "./types.js";

// Structural, host-only storage. These operations run inside ManifestStore's
// fenced transaction; none invokes a provider or authenticates a UI caller.
// The broker must prove native pendingness/ownership and produce a trusted
// presentation before calling them. Optional shadow capture is not authority.
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
// Native process birth witnesses are ps lstart strings on macOS, not journal IDs.
const processBirth = z.string().min(1).max(512);
const connection = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("codex_app_server"), url: z.string().min(1).max(4096), pid: time.min(1), processIdentity: processBirth }),
  z.strictObject({ kind: z.literal("opencode_server"), url: z.string().min(1).max(4096), pid: time.min(1), processIdentity: processBirth, serverAuthPath: z.string().min(1).max(4096) }),
]);
const authority = z.strictObject({ inboxItemId: executionIdentity, workAttemptId: executionIdentity,
  executionGenerationId: executionIdentity, provider: z.enum(["codex", "open-model"]),
  providerConnection: connection, configurationRevision: time.min(1) });
const reference = z.strictObject({
  requestId: executionIdentity, requestVersion: time.min(1), requestSha256: digest,
  agentId: executionIdentity, roomId: executionIdentity, executionGenerationId: executionIdentity,
  runtimeGenerationId: executionIdentity, turnId: executionIdentity,
  providerContinuationId: executionIdentity, providerTurnId: executionIdentity,
  connectionId: executionIdentity, nativeRequestId: z.union([executionIdentity, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)]),
});
const requestDetails = reference.extend({
  kind: z.enum(["command", "file_change"]), risk: z.enum(["low", "medium", "high"]),
  recoveryBoundary: z.enum(["none", "connection", "runtime"]), createdAtMs: time, expiresAtMs: time,
});
const admission = requestDetails.refine(v => v.expiresAtMs > v.createdAtMs);
const operationalAdmission = z.strictObject({
  request: requestDetails.omit({ executionGenerationId: true, runtimeGenerationId: true, turnId: true })
    .refine(v => v.expiresAtMs > v.createdAtMs), authority,
});
const selection = z.strictObject({
  expected: reference, authority, decisionId: executionIdentity, actorId: executionIdentity,
  decision: z.enum(["allow_once", "deny"]), projectionSha256: digest, atMs: time,
});
const dispatch = z.strictObject({
  expected: reference, authority, decisionId: executionIdentity, dispatchId: executionIdentity,
  projectionSha256: digest, atMs: time,
});
const outcome = z.strictObject({
  expected: reference, decisionId: executionIdentity, dispatchId: executionIdentity,
  evidence: z.enum(["sent_unacknowledged", "dispatch_uncertain", "native_processed"]), atMs: time,
});
const loss = z.strictObject({ expected: reference, atMs: time });
export type ApprovalReference = z.infer<typeof reference>;
export type AdmitExecutionApproval = z.infer<typeof admission>;
export type ApprovalAuthority = z.infer<typeof authority>;
export type AdmitOperationalExecutionApproval = z.infer<typeof operationalAdmission>;
export type SelectHostApproval = z.infer<typeof selection>;
export type DispatchExecutionApproval = z.infer<typeof dispatch>;
export type RecordExecutionApprovalOutcome = z.infer<typeof outcome>;
export type LoseExecutionApproval = z.infer<typeof loss>;
type Certainty = "impossible" | "unknown" | null;
export type ExecutionApprovalRecord = {
  request: AdmitExecutionApproval & { state: ApprovalState; applicationCertainty: Certainty };
  decision: null | {
    decisionId: string; actorId: string; decision: "allow_once" | "deny"; projectionSha256: string | null;
    dispatchState: "not_dispatched" | "dispatching" | "uncertain" | "acknowledged" | "lost";
    dispatchId: string | null; applicationCertainty: Certainty;
    decidedAtMs: number; dispatchStartedAtMs: number | null; resolvedAtMs: number | null;
  };
};
type Row = Record<string, unknown>;
export class ApprovalJournalError extends Error {
  constructor(readonly code: "invalid_input" | "identity_mismatch" | "missing_turn" | "invalid_transition" | "decision_conflict" | "expired") {
    super(`Approval journal rejected: ${code}.`); this.name = "ApprovalJournalError";
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApprovalJournalError("invalid_input");
  return result.data;
}
function reject(code: ApprovalJournalError["code"]): never { throw new ApprovalJournalError(code); }
function requireForeignKeys(db: DatabaseSync): void {
  if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1) reject("missing_turn");
}
function requestFromRow(row: Row): ExecutionApprovalRecord["request"] {
  if (row.delegatable !== 0 || (row.kind !== "command" && row.kind !== "file_change")) reject("identity_mismatch");
  return {
    requestId: String(row.request_id), requestVersion: Number(row.request_version), requestSha256: String(row.request_sha256),
    agentId: String(row.agent_id), roomId: String(row.room_id), executionGenerationId: String(row.execution_generation_id),
    runtimeGenerationId: String(row.runtime_generation_id), turnId: String(row.turn_id),
    providerContinuationId: String(row.provider_continuation_id), providerTurnId: String(row.provider_turn_id),
    connectionId: String(row.connection_id), nativeRequestId: row.native_request_id_type === "number" ? Number(row.native_request_id) : String(row.native_request_id),
    kind: row.kind as AdmitExecutionApproval["kind"], risk: row.risk as AdmitExecutionApproval["risk"],
    recoveryBoundary: row.recovery_boundary as AdmitExecutionApproval["recoveryBoundary"],
    createdAtMs: Number(row.created_at_ms), expiresAtMs: Number(row.expires_at_ms),
    state: row.state as ApprovalState, applicationCertainty: row.application_certainty as Certainty,
  };
}
function read(db: DatabaseSync, id: string, version: number): ExecutionApprovalRecord | null {
  const row = db.prepare("SELECT * FROM execution_approval_requests WHERE request_id=? AND request_version=?").get(id, version);
  if (!row) return null;
  const decision = db.prepare("SELECT * FROM execution_approval_decisions WHERE request_id=? AND request_version=?").get(id, version);
  if (decision && (decision.source !== "host" || decision.request_delegatable !== 0)) reject("identity_mismatch");
  return { request: requestFromRow(row), decision: decision ? {
    decisionId: String(decision.decision_id), actorId: String(decision.actor_id), decision: decision.decision as "allow_once" | "deny",
    projectionSha256: decision.projection_sha256 as string | null, dispatchState: decision.dispatch_state as NonNullable<ExecutionApprovalRecord["decision"]>["dispatchState"],
    dispatchId: decision.dispatch_id as string | null, applicationCertainty: decision.application_certainty as Certainty,
    decidedAtMs: Number(decision.decided_at_ms), dispatchStartedAtMs: decision.dispatch_started_at_ms as number | null,
    resolvedAtMs: decision.resolved_at_ms as number | null,
  } : null };
}
function exact(db: DatabaseSync, expected: ApprovalReference): ExecutionApprovalRecord {
  const found = read(db, expected.requestId, expected.requestVersion);
  if (!found || Object.entries(expected).some(([key, value]) => found.request[key as keyof ApprovalReference] !== value)) reject("identity_mismatch");
  return found;
}
function eligibleTurn(db: DatabaseSync, expected: Pick<ApprovalReference, "agentId" | "roomId" | "providerContinuationId" | "providerTurnId">, owned: ApprovalAuthority,
  current: DaemonManifestEntry | undefined): { generation: string; runtimeId: string; turnId: string; sourceMessageId: string; createdAtMs: number } {
  // Native pendingness comes from the broker's exact adapter callback. Storage
  // authority comes from the operational checkpoint, never observer projections.
  requireForeignKeys(db);
  if (!current || current.id !== expected.agentId || current.room_id !== expected.roomId
    || current.provider !== owned.provider || current.delivery_mode !== "daemon_inbox" || current.desired_state !== "running"
    || current.work_attempt_id !== owned.workAttemptId || current.provider_ref?.work_attempt_id !== owned.workAttemptId
    || current.provider_ref.execution_generation_id !== owned.executionGenerationId
    || current.provider_ref.provider_continuation_id !== expected.providerContinuationId
    || owned.providerConnection.kind !== (owned.provider === "codex" ? "codex_app_server" : "opencode_server")
    || !sameProviderActionConnectionIdentity(current.provider_ref.provider_connection, owned.providerConnection)) reject("missing_turn");
  const configuration = db.prepare("SELECT config_revision,runtime_configuration_revision FROM agent_configurations WHERE agent_id=?").get(expected.agentId);
  if (configuration?.config_revision !== owned.configurationRevision || configuration.runtime_configuration_revision !== owned.configurationRevision
    || !db.prepare("SELECT 1 FROM work_attempt_executions WHERE execution_generation_id=? AND work_attempt_id=? AND terminal_json IS NULL")
      .get(owned.executionGenerationId, owned.workAttemptId)) reject("missing_turn");
  const head = db.prepare(`SELECT inbox_item_id,room_id,state,provider_turn_id,outcome,source_message_id,created_at
    FROM supervised_agent_inbox WHERE agent_id=?
    AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
    ORDER BY fifo_sequence LIMIT 1`).get(expected.agentId);
  if (!head || head.inbox_item_id !== owned.inboxItemId || head.room_id !== expected.roomId
    || !["dispatching", "awaiting_result", "result_recovery"].includes(String(head.state))
    || head.provider_turn_id !== expected.providerTurnId || head.outcome !== null
    || db.prepare("SELECT 1 FROM supervised_agent_terminal_results WHERE inbox_item_id=?").get(owned.inboxItemId)) reject("missing_turn");
  const binding = db.prepare(`SELECT origin_execution_generation_id FROM supervised_agent_provider_turn_bindings
    WHERE inbox_item_id=? AND agent_id=? AND room_id=? AND work_attempt_id=? AND provider_continuation_id=? AND provider_turn_id=?`)
    .get(owned.inboxItemId, expected.agentId, expected.roomId, owned.workAttemptId, expected.providerContinuationId, expected.providerTurnId);
  if (!binding || !db.prepare("SELECT 1 FROM work_attempt_executions WHERE execution_generation_id=? AND work_attempt_id=?")
    .get(String(binding.origin_execution_generation_id), owned.workAttemptId)) reject("missing_turn");
  const generation = String(binding.origin_execution_generation_id);
  const runtimeId = executionStorageIdentity("runtime", expected.agentId, generation, owned.providerConnection.kind, owned.providerConnection.processIdentity);
  // Current durable reference attests this birth only in its own generation.
  // Never retroactively invent an old birth after an uncaptured recovery.
  if (generation !== owned.executionGenerationId && !db.prepare(`SELECT 1 FROM execution_runtime_generations
    WHERE runtime_generation_id=? AND execution_generation_id=? AND agent_id=? AND provider=? AND config_revision=?`)
    .get(runtimeId, generation, expected.agentId, owned.provider, owned.configurationRevision)) reject("missing_turn");
  const createdAtMs = Date.parse(String(head.created_at));
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) reject("missing_turn");
  return { generation, runtimeId, turnId: executionStorageIdentity("turn", expected.agentId, expected.providerContinuationId, expected.providerTurnId),
    sourceMessageId: String(head.source_message_id), createdAtMs };
}
export function validateExecutionApprovalAuthority(db: DatabaseSync, expected: ApprovalReference, input: ApprovalAuthority,
  current: DaemonManifestEntry | undefined): void {
  const r = parse(reference, expected); const owned = parse(authority, input);
  const turn = eligibleTurn(db, r, owned, current);
  if (r.executionGenerationId !== turn.generation || r.runtimeGenerationId !== turn.runtimeId || r.turnId !== turn.turnId) reject("missing_turn");
}
function liveSelection(db: DatabaseSync, record: ExecutionApprovalRecord, owned: ApprovalAuthority,
  current: DaemonManifestEntry | undefined, atMs: number): void {
  if (atMs < record.request.createdAtMs || atMs < (record.decision?.decidedAtMs ?? 0)) reject("invalid_input");
  if (atMs >= record.request.expiresAtMs) reject("expired");
  const expected = Object.fromEntries(Object.keys(reference.shape).map(key => [key, record.request[key as keyof ApprovalReference]])) as ApprovalReference;
  validateExecutionApprovalAuthority(db, expected, owned, current);
}

export function getExecutionApproval(db: DatabaseSync, input: ApprovalReference): ExecutionApprovalRecord | null {
  const expected = parse(reference, input);
  return read(db, expected.requestId, expected.requestVersion) ? exact(db, expected) : null;
}

/** Internal broker recovery by its deterministic native-occurrence ID. */
export function readLatestExecutionApproval(db: DatabaseSync, requestId: string): ExecutionApprovalRecord | null {
  const id = parse(executionIdentity, requestId);
  const row = db.prepare("SELECT request_version FROM execution_approval_requests WHERE request_id=? ORDER BY request_version DESC LIMIT 1").get(id);
  return row ? read(db, id, Number(row.request_version)) : null;
}

/** Bounded structural recovery cards; absence from native pending lists is not a terminal outcome. */
export function listExecutionApprovals(db: DatabaseSync, roomId: string, limit = 64): ExecutionApprovalRecord[] {
  const room = parse(executionIdentity, roomId);
  const count = parse(time.min(1).max(64), limit);
  const rows = db.prepare(`SELECT request_id,request_version FROM execution_approval_requests r WHERE room_id=?
    AND NOT EXISTS (SELECT 1 FROM execution_approval_requests newer WHERE newer.request_id=r.request_id AND newer.request_version>r.request_version)
    ORDER BY created_at_ms DESC,request_id LIMIT ?`).all(room, count);
  return rows.map(row => read(db, String(row.request_id), Number(row.request_version))!);
}

export function admitExecutionApproval(db: DatabaseSync, input: AdmitOperationalExecutionApproval,
  current: DaemonManifestEntry | undefined): { created: boolean; approval: ExecutionApprovalRecord } {
  const parsed = parse(operationalAdmission, input);
  const prior = read(db, parsed.request.requestId, parsed.request.requestVersion);
  if (prior) {
    if (Object.entries(parsed.request).some(([key, item]) => prior.request[key as keyof AdmitExecutionApproval] !== item)) reject("identity_mismatch");
    return { created: false, approval: prior }; // Receipt only; never reopens a request.
  }
  const turn = eligibleTurn(db, parsed.request, parsed.authority, current);
  const value = parse(admission, { ...parsed.request, executionGenerationId: turn.generation, runtimeGenerationId: turn.runtimeId, turnId: turn.turnId });
  // A caller cannot alias one native callback under another logical request ID.
  // The existing unique key has no occurrence/turn component: sequential reuse
  // of a native ID in this connection is conservatively unsupported here.
  const alias = db.prepare(`SELECT request_id FROM execution_approval_requests WHERE agent_id=? AND execution_generation_id=?
    AND runtime_generation_id=? AND connection_id=? AND native_request_id_type=? AND native_request_id=? AND request_id<>? LIMIT 1`)
    .get(value.agentId, value.executionGenerationId, value.runtimeGenerationId, value.connectionId, typeof value.nativeRequestId,
      String(value.nativeRequestId), value.requestId);
  if (alias) reject("identity_mismatch");
  const latest = db.prepare("SELECT * FROM execution_approval_requests WHERE request_id=? ORDER BY request_version DESC LIMIT 1").get(value.requestId);
  if (!latest && value.requestVersion !== 1) reject("invalid_transition");
  if (latest) {
    const old = read(db, value.requestId, Number(latest.request_version))!;
    const bindingKeys = Object.keys(reference.shape).filter(key => !["requestVersion", "requestSha256"].includes(key));
    if (bindingKeys.some(key => value[key as keyof ApprovalReference] !== old.request[key as keyof ApprovalReference])) reject("identity_mismatch");
    if (value.requestVersion !== old.request.requestVersion + 1 || value.requestSha256 === old.request.requestSha256
      || !["requested", "decision_recorded"].includes(old.request.state)
      || (old.decision && old.decision.dispatchState !== "not_dispatched")) reject("invalid_transition");
    if (value.createdAtMs < (old.decision?.decidedAtMs ?? old.request.createdAtMs)) reject("invalid_input");
    if (old.decision) db.prepare(`UPDATE execution_approval_decisions SET dispatch_state='lost',application_certainty='impossible',resolved_at_ms=?
      WHERE decision_id=?`).run(value.createdAtMs, old.decision.decisionId);
    db.prepare("UPDATE execution_approval_requests SET state='superseded' WHERE request_id=? AND request_version=?")
      .run(value.requestId, old.request.requestVersion);
  }
  const common = { agentId: value.agentId, roomId: value.roomId, executionGenerationId: turn.generation, createdAtMs: turn.createdAtMs };
  materializeExecutionIdentity(db, {
    runtime: { agentId: value.agentId, executionGenerationId: turn.generation, runtimeGenerationId: turn.runtimeId,
      provider: parsed.authority.provider, authorityMode: lifecycleAuthorityModeForProvider(parsed.authority.provider),
      configRevision: parsed.authority.configurationRevision, createdAtMs: turn.createdAtMs },
    message: { ...common, sourceMessageId: turn.sourceMessageId, workspaceId: parsed.authority.workAttemptId },
    turn: { ...common, turnId: turn.turnId, runtimeGenerationId: turn.runtimeId,
      providerContinuationId: value.providerContinuationId, providerTurnId: value.providerTurnId },
  });
  db.prepare(`INSERT INTO execution_approval_requests
    (request_id,request_version,agent_id,room_id,execution_generation_id,runtime_generation_id,turn_id,provider_continuation_id,provider_turn_id,
      connection_id,native_request_id_type,native_request_id,kind,risk,delegatable,request_sha256,state,recovery_boundary,created_at_ms,expires_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,'requested',?,?,?)`).run(
    value.requestId, value.requestVersion, value.agentId, value.roomId, value.executionGenerationId, value.runtimeGenerationId, value.turnId,
    value.providerContinuationId, value.providerTurnId, value.connectionId, typeof value.nativeRequestId, String(value.nativeRequestId),
    value.kind, value.risk, value.requestSha256, value.recoveryBoundary, value.createdAtMs, value.expiresAtMs);
  return { created: true, approval: read(db, value.requestId, value.requestVersion)! };
}

export function selectHostApproval(db: DatabaseSync, input: SelectHostApproval, entry: DaemonManifestEntry | undefined): ExecutionApprovalRecord {
  const value = parse(selection, input); const current = exact(db, value.expected);
  if (current.decision) {
    const old = current.decision;
    if (old.decisionId !== value.decisionId || old.actorId !== value.actorId || old.decision !== value.decision
      || old.projectionSha256 !== value.projectionSha256) reject("decision_conflict");
    return current;
  }
  if (current.request.state !== "requested") reject("invalid_transition");
  liveSelection(db, current, value.authority, entry, value.atMs);
  const r = current.request;
  db.prepare(`INSERT INTO execution_approval_decisions
    (decision_id,request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,request_delegatable,request_sha256,
      decision,source,actor_id,dispatch_state,decided_at_ms,projection_sha256)
    VALUES(?,?,?,?,?,?,?,0,?,?,'host',?,'not_dispatched',?,?)`).run(
    value.decisionId, r.requestId, r.requestVersion, r.agentId, r.roomId, r.executionGenerationId, r.turnId,
    r.requestSha256, value.decision, value.actorId, value.atMs, value.projectionSha256);
  db.prepare("UPDATE execution_approval_requests SET state='decision_recorded' WHERE request_id=? AND request_version=?")
    .run(r.requestId, r.requestVersion);
  return exact(db, value.expected);
}

/** A true result is a first committed intent, not proof of current native authority. */
export function beginExecutionApprovalDispatch(db: DatabaseSync, input: DispatchExecutionApproval, entry: DaemonManifestEntry | undefined): { dispatch: boolean; approval: ExecutionApprovalRecord } {
  const value = parse(dispatch, input); const current = exact(db, value.expected); const d = current.decision;
  if (!d || d.decisionId !== value.decisionId || !d.projectionSha256 || d.projectionSha256 !== value.projectionSha256) reject("identity_mismatch");
  if (d.dispatchId) {
    if (d.dispatchId !== value.dispatchId) reject("decision_conflict");
    return { dispatch: false, approval: current }; // Restart/lost response is not a second dispatch permit.
  }
  if (current.request.state !== "decision_recorded" || d.dispatchState !== "not_dispatched") reject("invalid_transition");
  liveSelection(db, current, value.authority, entry, value.atMs);
  db.prepare("UPDATE execution_approval_decisions SET dispatch_state='dispatching',dispatch_id=?,dispatch_started_at_ms=? WHERE decision_id=?")
    .run(value.dispatchId, value.atMs, d.decisionId);
  db.prepare("UPDATE execution_approval_requests SET state='dispatching' WHERE request_id=? AND request_version=?")
    .run(value.expected.requestId, value.expected.requestVersion);
  return { dispatch: true, approval: exact(db, value.expected) };
}

/** Evidence must come from the exact broker invocation, never a UI/provider narrative. */
export function recordExecutionApprovalOutcome(db: DatabaseSync, input: RecordExecutionApprovalOutcome): ExecutionApprovalRecord {
  const value = parse(outcome, input); const current = exact(db, value.expected); const d = current.decision;
  if (!d || d.decisionId !== value.decisionId || d.dispatchId !== value.dispatchId || d.dispatchStartedAtMs === null) reject("identity_mismatch");
  if (value.atMs < d.dispatchStartedAtMs) reject("invalid_input");
  if (value.evidence === "native_processed") {
    // Only the OpenCode endpoint confirms processing of our exact decision.
    // A Codex socket send or serverRequest/resolved proves no chosen decision.
    const provider = db.prepare("SELECT provider FROM execution_runtime_generations WHERE runtime_generation_id=? AND agent_id=? AND execution_generation_id=?")
      .get(value.expected.runtimeGenerationId, value.expected.agentId, value.expected.executionGenerationId)?.provider;
    if (provider !== "open-model") reject("invalid_transition");
    if (current.request.state === "resolved" && d.dispatchState === "acknowledged") return current;
  }
  if (current.request.state !== "dispatching" || !["dispatching", "uncertain"].includes(d.dispatchState)) reject("invalid_transition");
  if (value.evidence === "native_processed") {
    db.prepare("UPDATE execution_approval_decisions SET dispatch_state='acknowledged',resolved_at_ms=? WHERE decision_id=?").run(value.atMs, d.decisionId);
    db.prepare("UPDATE execution_approval_requests SET state='resolved' WHERE request_id=? AND request_version=?")
      .run(value.expected.requestId, value.expected.requestVersion);
  } else db.prepare("UPDATE execution_approval_decisions SET dispatch_state='uncertain' WHERE decision_id=?").run(d.decisionId);
  return exact(db, value.expected);
}

/** Call only for proven loss, not silence, timeout, or absence from a pending list. */
export function loseExecutionApproval(db: DatabaseSync, input: LoseExecutionApproval): ExecutionApprovalRecord {
  const value = parse(loss, input); const current = exact(db, value.expected); const d = current.decision;
  if (current.request.state === "lost") return current;
  if (!["requested", "decision_recorded", "dispatching"].includes(current.request.state)) reject("invalid_transition");
  if (d && !["not_dispatched", "dispatching", "uncertain"].includes(d.dispatchState)) reject("invalid_transition");
  if (value.atMs < (d?.dispatchStartedAtMs ?? d?.decidedAtMs ?? current.request.createdAtMs)) reject("invalid_input");
  const certainty = d?.dispatchId ? "unknown" : "impossible";
  if (d) db.prepare("UPDATE execution_approval_decisions SET dispatch_state='lost',application_certainty=?,resolved_at_ms=? WHERE decision_id=?")
    .run(certainty, value.atMs, d.decisionId);
  db.prepare("UPDATE execution_approval_requests SET state='lost',application_certainty=? WHERE request_id=? AND request_version=?")
    .run(certainty, value.expected.requestId, value.expected.requestVersion);
  return exact(db, value.expected);
}
