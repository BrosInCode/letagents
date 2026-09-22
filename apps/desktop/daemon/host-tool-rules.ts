import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ApprovalReference, ExecutionApprovalRecord } from "./execution-approval-journal.js";
import type { DaemonManifestEntry } from "./types.js";
import type { ProviderPermissionRequest } from "../shared/provider-permissions.js";
import { createGitCommand, resolveSourceRepositoryIdentity, normalizeRemote, WORKSPACE_MARKER } from "./workspace-provisioner.js";

const id = z.string().min(1).max(256);
const label = id.regex(/^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const projectToolScopeSchema = z.strictObject({
  agentId: id, accountId: id, projectId: hash, projectName: label, sourceRepoPath: z.string().min(1).max(4096),
  canonicalSourcePath: z.string().min(1).max(4096), repository: z.string().min(1).max(4096), remoteUrl: z.string().min(1).max(4096),
  provider: z.enum(["codex", "claude-code", "open-model"]), toolId: id, toolLabel: label, policySha256: hash,
});
// Existing project serialization is unchanged: stored permission hashes remain valid.
const roomToolScopeSchema = z.strictObject({
  kind: z.literal("room_workspace"), version: z.literal(1), agentId: id, accountId: id, roomId: id,
  workAttemptId: z.string().uuid(), workspacePath: z.string().min(1).max(4096), canonicalWorkspacePath: z.string().min(1).max(4096),
  provider: z.enum(["codex", "claude-code", "open-model"]), toolId: id, toolLabel: label, policySha256: hash,
});
export const hostToolScopeSchema = z.union([projectToolScopeSchema, roomToolScopeSchema]);
export type HostToolScope = z.infer<typeof hostToolScopeSchema>;
export type HostToolRule = { id: string; revision: number; ownerId: string; scope: HostToolScope; createdAtMs: number };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const policy = (entry: DaemonManifestEntry) => digest([entry.permission_profile_id, entry.provider_launch_policy ?? null]);

/** Only structured native identities establish tool scope; prose never does. */
export function nativeToolIdentity(request: ProviderPermissionRequest): { id: string; label: string } | null {
  if (request.provider === "claude-code") {
    const name = request.native.request.tool_name;
    return id.safeParse(name).success ? { id: `claude:${name}`, label: name } : null;
  }
  if (request.provider === "codex") {
    const params = request.native.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) return null;
    const input = params as Record<string, unknown>;
    // A tool rule cannot silently accept a different environment or extra access.
    if (input.environmentId != null || input.additionalPermissions != null || input.networkApprovalContext != null) return null;
    if (request.native.method === "item/commandExecution/requestApproval" && (input.kind == null || input.kind === "command")) {
      return { id: "codex:command", label: "commands" };
    }
    if (request.native.method === "item/fileChange/requestApproval" && input.grantRoot == null) return { id: "codex:file-change", label: "file editing" };
    // MCP elicitation and permissions-profile payloads do not identify a tool.
    return null;
  }
  if (request.native.permission === "bash") return { id: "opencode:bash", label: "Bash" };
  if (request.native.permission === "edit") return { id: "opencode:edit", label: "file editing" };
  return null;
}

/** Reuse the provisioner's verified source identity, independent of an attempt's worktree. */
export async function resolveHostToolScope(entry: DaemonManifestEntry, request: ProviderPermissionRequest,
  ownedProject: HostToolContext | null): Promise<HostToolScope | null> {
  const tool = nativeToolIdentity(request);
  if (!ownedProject || !tool || entry.provider !== request.provider) return null;
  if (!entry.source_repo_path) {
    const canonical = roomWorkspaceIdentity(entry, ownedProject);
    if (!canonical) return null;
    return roomToolScopeSchema.parse({ kind: "room_workspace", version: 1, agentId: entry.id, accountId: entry.created_by,
      roomId: entry.room_id, workAttemptId: ownedProject.workAttemptId, workspacePath: ownedProject.workspacePath,
      canonicalWorkspacePath: canonical, provider: request.provider, toolId: tool.id, toolLabel: tool.label, policySha256: policy(entry) });
  }
  const canonical = await realpath(entry.source_repo_path);
  const repository = await resolveSourceRepositoryIdentity(canonical, createGitCommand(canonical));
  if (normalizeRemote(repository.remoteUrl) !== normalizeRemote(ownedProject.remoteUrl)) return null;
  return hostToolScopeSchema.parse({ agentId: entry.id, accountId: entry.created_by,
    projectId: digest([canonical, ownedProject.repo, ownedProject.remoteUrl]), projectName: basename(canonical), sourceRepoPath: entry.source_repo_path,
    canonicalSourcePath: canonical, repository: ownedProject.repo, remoteUrl: ownedProject.remoteUrl,
    provider: request.provider, toolId: tool.id, toolLabel: tool.label, policySha256: policy(entry) });
}

export function assertHostToolScope(db: DatabaseSync, scope: HostToolScope, entry: DaemonManifestEntry | undefined): void {
  const project = entry?.work_attempt_id ? readHostToolContext(db, entry.work_attempt_id) : null;
  if ("kind" in scope) {
    if (!entry || !project || entry.id !== scope.agentId || entry.created_by !== scope.accountId
      || entry.room_id !== scope.roomId || entry.provider !== scope.provider || policy(entry) !== scope.policySha256
      || project.workAttemptId !== scope.workAttemptId || project.workspacePath !== scope.workspacePath
      || roomWorkspaceIdentity(entry, project) !== scope.canonicalWorkspacePath) {
      throw new Error("The saved tool permission no longer matches this agent's room workspace or access settings.");
    }
    return;
  }
  if (!entry || !project || project.repo !== scope.repository || project.remoteUrl !== scope.remoteUrl
    || realpathSync(entry.source_repo_path ?? "") !== scope.canonicalSourcePath
    || digest([scope.canonicalSourcePath, project.repo, project.remoteUrl]) !== scope.projectId || entry.id !== scope.agentId || entry.created_by !== scope.accountId || entry.provider !== scope.provider
    || entry.source_repo_path !== scope.sourceRepoPath || policy(entry) !== scope.policySha256) {
    throw new Error("The saved tool permission no longer matches this agent's project or access settings.");
  }
}

export type HostToolContext = {
  repo: string; remoteUrl: string; workAttemptId: string; taskId: string; workspacePath: string;
  resolvedRevision: string; barePath: string;
};
export function readHostToolContext(db: DatabaseSync, workAttemptId: string): HostToolContext | null {
  const row = db.prepare(`SELECT workspace_repo,workspace_remote_url,work_attempt_id,task_id,workspace_path,
    workspace_resolved_revision,workspace_bare_path FROM work_attempts WHERE work_attempt_id=?`).get(workAttemptId);
  return row ? { repo: String(row.workspace_repo), remoteUrl: String(row.workspace_remote_url), workAttemptId: String(row.work_attempt_id),
    taskId: String(row.task_id), workspacePath: String(row.workspace_path), resolvedRevision: String(row.workspace_resolved_revision),
    barePath: String(row.workspace_bare_path) } : null;
}

/** Both the host-owned durable attempt and its private provisioner marker must agree. */
function roomWorkspaceIdentity(entry: DaemonManifestEntry, context: HostToolContext): string | null {
  if (entry.source_repo_path || entry.work_attempt_id !== context.workAttemptId || entry.workspace_path !== context.workspacePath
    || context.repo !== "room-only" || context.resolvedRevision !== "0".repeat(40)
    || context.remoteUrl !== `letagents-ephemeral:${createHash("sha256").update(context.taskId).digest("hex")}`) return null;
  const canonical = realpathSync(context.workspacePath);
  const directory = lstatSync(context.workspacePath);
  const markerPath = join(canonical, WORKSPACE_MARKER);
  const file = lstatSync(markerPath);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)
    || !file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) || file.size > 16_384
    || (process.getuid && (directory.uid !== process.getuid() || file.uid !== process.getuid()))
    || canonical !== context.barePath) return null;
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  if (!marker || marker.version !== 1 || marker.repo !== context.repo || marker.work_attempt_id !== context.workAttemptId
    || marker.task_id !== context.taskId || marker.remote_url !== context.remoteUrl
    || marker.resolved_revision !== context.resolvedRevision || marker.bare_path !== canonical) return null;
  return canonical;
}

const schema = [
  `CREATE TABLE host_tool_rules (
    rule_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    scope_json TEXT NOT NULL CHECK(json_valid(scope_json)), scope_sha256 TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0), state TEXT NOT NULL CHECK(state IN ('active','revoked')),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0), revoked_at_ms INTEGER
  ) STRICT`,
  `CREATE TABLE host_tool_rule_decisions (
    decision_id TEXT PRIMARY KEY REFERENCES execution_approval_decisions(decision_id) ON DELETE CASCADE,
    rule_id TEXT NOT NULL REFERENCES host_tool_rules(rule_id), rule_revision INTEGER NOT NULL CHECK(rule_revision > 0)
  ) STRICT`,
  `CREATE TABLE host_tool_rule_withdrawals (
    decision_id TEXT PRIMARY KEY REFERENCES host_tool_rule_decisions(decision_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, request_version INTEGER NOT NULL, request_sha256 TEXT NOT NULL,
    rule_id TEXT NOT NULL, rule_revision INTEGER NOT NULL, dispatch_id TEXT, withdrawn_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX host_tool_rules_active_scope ON host_tool_rules(owner_id,agent_id,scope_sha256) WHERE state='active'`,
];
const normalized = (sql: string) => sql.replace(/IF NOT EXISTS /gi, "").replace(/\s+/g, " ").trim();
export function applyHostToolRuleSchema(db: DatabaseSync): void {
  for (const sql of schema) db.exec(sql.replace(/CREATE (TABLE|UNIQUE INDEX)/, "CREATE $1 IF NOT EXISTS"));
  validateHostToolRuleSchema(db);
}
export function validateHostToolRuleSchema(db: DatabaseSync): void {
  for (const sql of schema) {
    const name = sql.match(/CREATE (?:TABLE|UNIQUE INDEX) (\w+)/)![1]!;
    const stored = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name);
    if (!stored || normalized(String(stored.sql)) !== normalized(sql)) throw new Error("Saved tool permission storage is missing or invalid.");
  }
}
function ruleFromRow(row: Record<string, unknown>): HostToolRule {
  const scope = hostToolScopeSchema.parse(JSON.parse(String(row.scope_json)));
  if (row.agent_id !== scope.agentId || row.scope_sha256 !== digest(scope)) throw new Error("Saved tool permission identity is invalid.");
  return { id: String(row.rule_id), revision: Number(row.revision), ownerId: String(row.owner_id), scope, createdAtMs: Number(row.created_at_ms) };
}
export function listHostToolRules(db: DatabaseSync, ownerId: string, agentId: string): HostToolRule[] {
  return db.prepare("SELECT * FROM host_tool_rules WHERE owner_id=? AND agent_id=? AND state='active' ORDER BY created_at_ms,rule_id")
    .all(id.parse(ownerId), id.parse(agentId)).map(ruleFromRow);
}
export function findHostToolRule(db: DatabaseSync, ownerId: string, scope: HostToolScope): HostToolRule | null {
  const row = db.prepare("SELECT * FROM host_tool_rules WHERE owner_id=? AND agent_id=? AND scope_sha256=? AND state='active' ORDER BY created_at_ms DESC LIMIT 1")
    .get(id.parse(ownerId), scope.agentId, digest(hostToolScopeSchema.parse(scope)));
  return row ? ruleFromRow(row) : null;
}
export function bindHostToolRule(db: DatabaseSync, input: {
  decisionId: string; ownerId: string; scope: HostToolScope; atMs: number;
  create?: boolean; rule?: { id: string; revision: number };
}, entry: DaemonManifestEntry | undefined): void {
  const scope = hostToolScopeSchema.parse(input.scope);
  assertHostToolScope(db, scope, entry);
  const prior = db.prepare("SELECT * FROM host_tool_rule_decisions WHERE decision_id=?").get(input.decisionId);
  const existing = input.create && !prior ? findHostToolRule(db, input.ownerId, scope) : null;
  const ruleId = input.create ? String(prior?.rule_id ?? existing?.id ?? `rule-${input.decisionId}`) : input.rule?.id;
  if (!ruleId) throw new Error("A saved tool permission is required.");
  if (input.create && !prior && !existing) {
    // This insert is in the same transaction as selecting the current once decision.
    // A repeated creation ID can never revive a revoked rule.
    db.prepare(`INSERT INTO host_tool_rules(rule_id,owner_id,agent_id,scope_json,scope_sha256,revision,state,created_at_ms)
      VALUES(?,?,?,?,?,1,'active',?)`).run(ruleId, id.parse(input.ownerId), scope.agentId, JSON.stringify(scope), digest(scope), input.atMs);
  }
  const row = db.prepare("SELECT * FROM host_tool_rules WHERE rule_id=? AND state='active'").get(ruleId);
  if (!row) throw new Error("This saved tool permission was revoked.");
  const rule = ruleFromRow(row);
  if (rule.ownerId !== input.ownerId || digest(rule.scope) !== digest(scope)
    || (!input.create && rule.revision !== input.rule?.revision)
    || (prior && (prior.rule_id !== ruleId || prior.rule_revision !== rule.revision))) {
    throw new Error("The saved tool permission changed.");
  }
  if (!prior) db.prepare("INSERT INTO host_tool_rule_decisions(decision_id,rule_id,rule_revision) VALUES(?,?,?)")
    .run(input.decisionId, rule.id, rule.revision);
}
export class HostToolRuleRevokedError extends Error {
  constructor(readonly ruleId: string, readonly ruleRevision: number) { super("This saved tool permission was revoked."); }
}
export function assertDecisionToolRule(db: DatabaseSync, decisionId: string, entry: DaemonManifestEntry | undefined): void {
  if (Number(db.prepare("PRAGMA user_version").get()!.user_version) < 44
    && !db.prepare("SELECT 1 FROM sqlite_master WHERE name='host_tool_rule_decisions'").get()) return;
  const bound = db.prepare("SELECT * FROM host_tool_rule_decisions WHERE decision_id=?").get(decisionId);
  if (!bound) return;
  const row = db.prepare("SELECT * FROM host_tool_rules WHERE rule_id=? AND state='active' AND revision=?")
    .get(bound.rule_id!, bound.rule_revision!);
  if (!row) throw new HostToolRuleRevokedError(String(bound.rule_id), Number(bound.rule_revision));
  assertHostToolScope(db, ruleFromRow(row).scope, entry);
}
export function revokeHostToolRule(db: DatabaseSync, ownerId: string, agentId: string, ruleId: string, revision: number, atMs: number): void {
  const row = db.prepare("SELECT * FROM host_tool_rules WHERE rule_id=? AND owner_id=? AND agent_id=?")
    .get(id.parse(ruleId), id.parse(ownerId), id.parse(agentId));
  if (!row) throw new Error("Saved tool permission not found.");
  if (row.state === "revoked") return;
  if (row.revision !== revision) throw new Error("The saved tool permission changed. Refresh Permissions.");
  db.prepare("UPDATE host_tool_rules SET state='revoked',revision=revision+1,revoked_at_ms=? WHERE rule_id=?").run(atMs, ruleId);
}

export type WithdrawHostToolApproval = {
  expected: ApprovalReference; decisionId: string; ruleId: string; ruleRevision: number; dispatchId: string | null; atMs: number;
};
export function hostToolDecisionWasWithdrawn(db: DatabaseSync, decision: Record<string, unknown>, request: Record<string, unknown>): boolean {
  if (Number(db.prepare("PRAGMA user_version").get()!.user_version) < 44
    && !db.prepare("SELECT 1 FROM sqlite_master WHERE name='host_tool_rule_withdrawals'").get()) return false;
  const receipt = db.prepare("SELECT * FROM host_tool_rule_withdrawals WHERE decision_id=?").get(String(decision.decision_id));
  if (!receipt) return false;
  const bound = db.prepare("SELECT * FROM host_tool_rule_decisions WHERE decision_id=?").get(String(decision.decision_id));
  const rule = bound && db.prepare("SELECT * FROM host_tool_rules WHERE rule_id=?").get(bound.rule_id!);
  if (!bound || !rule || rule.state !== "revoked" || Number(rule.revision) <= Number(bound.rule_revision)
    || receipt.rule_id !== bound.rule_id || receipt.rule_revision !== bound.rule_revision
    || receipt.request_id !== request.request_id || receipt.request_version !== request.request_version
    || receipt.request_sha256 !== request.request_sha256 || receipt.dispatch_id !== decision.dispatch_id
    || decision.source !== "host" || decision.actor_id !== rule.owner_id || decision.decision !== "allow_once"
    || decision.dispatch_state !== "lost" || decision.application_certainty !== "impossible"
    || request.state !== "lost" || request.application_certainty !== "impossible"
    || Number(receipt.withdrawn_at_ms) < Number(decision.decided_at_ms)
    || (decision.dispatch_started_at_ms !== null && Number(receipt.withdrawn_at_ms) < Number(decision.dispatch_started_at_ms))
    || receipt.withdrawn_at_ms !== decision.resolved_at_ms) throw new Error("Unsent tool decision evidence is invalid.");
  return true;
}
/** Only the owning dispatcher may attest that its final native-write mark was never reached. */
export function withdrawHostToolApproval(db: DatabaseSync, input: WithdrawHostToolApproval, record: ExecutionApprovalRecord): void {
  const decision = record.decision;
  const bound = db.prepare("SELECT * FROM host_tool_rule_decisions WHERE decision_id=?").get(input.decisionId);
  const rule = bound && db.prepare("SELECT * FROM host_tool_rules WHERE rule_id=?").get(bound.rule_id!);
  if (!decision || decision.decisionId !== input.decisionId || decision.decision !== "allow_once"
    || decision.dispatchId !== input.dispatchId || !bound || bound.rule_id !== input.ruleId || bound.rule_revision !== input.ruleRevision
    || !rule || rule.state !== "revoked" || Number(rule.revision) <= input.ruleRevision
    || input.atMs < decision.decidedAtMs || (decision.dispatchStartedAtMs !== null && input.atMs < decision.dispatchStartedAtMs)) {
    throw new Error("The unsent tool decision could not be established.");
  }
  const existing = db.prepare("SELECT * FROM host_tool_rule_withdrawals WHERE decision_id=?").get(input.decisionId);
  if (existing) {
    if (existing.request_id !== input.expected.requestId || existing.request_version !== input.expected.requestVersion
      || existing.request_sha256 !== input.expected.requestSha256 || existing.dispatch_id !== input.dispatchId) throw new Error("Withdrawal identity changed.");
    return;
  }
  if (!["decision_recorded", "dispatching"].includes(record.request.state)
    || !["not_dispatched", "dispatching"].includes(decision.dispatchState)) throw new Error("The decision may already have been sent.");
  db.prepare(`INSERT INTO host_tool_rule_withdrawals
    (decision_id,request_id,request_version,request_sha256,rule_id,rule_revision,dispatch_id,withdrawn_at_ms) VALUES(?,?,?,?,?,?,?,?)`)
    .run(input.decisionId, input.expected.requestId, input.expected.requestVersion, input.expected.requestSha256,
      input.ruleId, input.ruleRevision, input.dispatchId, input.atMs);
  db.prepare("UPDATE execution_approval_decisions SET dispatch_state='lost',application_certainty='impossible',resolved_at_ms=? WHERE decision_id=?")
    .run(input.atMs, input.decisionId);
  db.prepare("UPDATE execution_approval_requests SET state='lost',application_certainty='impossible' WHERE request_id=? AND request_version=?")
    .run(input.expected.requestId, input.expected.requestVersion);
}
