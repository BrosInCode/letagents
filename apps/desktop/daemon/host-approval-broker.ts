import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { HostApprovalCandidate, HostApprovalDecision, HostApprovalPresentation, HostApprovalReference, HostApprovalStatus } from "../shared/host-approvals.js";
import type { CodexPermissionFileChange, ProviderPermissionRequest, ProviderPermissionObservation } from "../shared/provider-permissions.js";
import type { ApprovalAuthority, ExecutionApprovalRecord } from "./execution-approval-journal.js";
import type { ManifestStore } from "./manifest-store.js";
import { sameProviderActionConnectionIdentity, type ProviderActionHandle, type ProviderActionPort } from "./provider-action-port.js";
import type { SupervisedAgentInboxStore } from "./supervised-agent-inbox-store.js";
import type { DaemonManifestEntry } from "./types.js";
import type { WorkerBindingStore } from "./worker-binding-store.js";
import type { ProviderCheckpointCoordinator } from "./provider-checkpoint-coordinator.js";
import { HostApprovalVerifier } from "./host-approval-auth.js";
import { requestHostApprovalVerifier, type StateRecoveryBootstrap } from "./state-recovery-key.js";

/** Composition of the native broker and its privately enrolled host authority. */
export function createHostApprovalBridge(options: Omit<Options, "exactAuthority"> & {
  workerBindings: Pick<WorkerBindingStore, "get" | "credentialFor">;
  providerCheckpoints: Pick<ProviderCheckpointCoordinator, "isExactAuthority">;
  currentGeneration(): number;
}) {
  let verifier: HostApprovalVerifier | null = null;
  const broker = new HostApprovalBroker({
    ...options,
    exactAuthority: async (entry, handle, generation) => {
      const binding = await options.workerBindings.get(entry.id);
      if (!binding || binding.execution_generation_id !== generation) return false;
      const bearer = await options.workerBindings.credentialFor(binding);
      if (!bearer) return false;
      return options.providerCheckpoints.isExactAuthority({ agentId: entry.id, roomId: binding.room_id,
        provider: entry.provider, apiUrl: binding.api_url, agentSessionId: binding.agent_session_id, bearer,
        handle, workAttemptId: handle.workAttemptId, executionGenerationId: generation,
        providerContinuationId: handle.providerContinuationId, providerConnection: handle.providerConnection ?? null,
        daemonGeneration: options.currentGeneration() });
    },
  });
  return {
    install: broker.install.bind(broker),
    close: broker.close.bind(broker),
    async enroll(storage: StateRecoveryBootstrap): Promise<void> {
      verifier = new HostApprovalVerifier(options.currentGeneration(),
        await (storage.getHostApprovalPublicKey ?? requestHostApprovalVerifier)());
    },
    challenge: () => verifier?.challenge() ?? null,
    verify: (envelope: unknown) => verifier?.verify(envelope) ?? null,
    list: broker.list.bind(broker),
    decide: broker.decide.bind(broker),
  };
}

type Lane = {
  agentId: string; generation: string; handle: ProviderActionHandle; connection: NonNullable<ProviderActionHandle["providerConnection"]>;
  controller: AbortController; revision: number; state: "pending" | "degraded" | "unavailable";
  connectionId: string | null; requests: readonly ProviderPermissionRequest[];
};
type Options = {
  store: Pick<ManifestStore, "getEntry" | "admitExecutionApproval" | "readLatestExecutionApproval" | "getExecutionApproval" | "listExecutionApprovals" | "selectHostApproval" | "beginExecutionApprovalDispatch" | "recordExecutionApprovalOutcome" | "validateExecutionApprovalAuthority">;
  inbox: Pick<SupervisedAgentInboxStore, "head">;
  provider: ProviderActionPort | undefined;
  currentHandle(agentId: string): ProviderActionHandle | undefined;
  isCurrent(): boolean;
  exactAuthority(entry: DaemonManifestEntry, handle: ProviderActionHandle, generation: string): Promise<boolean>;
  fenceCommit(commit: () => Promise<void>): Promise<void>;
  nowMs?: () => number;
};
const MAX_REQUESTS = 32;
const MAX_PRESENTATION_BYTES = 24 * 1024;
const CODEX_FILE_CHANGE_UNAVAILABLE = "Codex has requested file changes, but the actual edits are not available to inspect here. Decisions are disabled until those exact edits can be shown.";
const id = z.string().min(1).max(256);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const decisionSchema = z.strictObject({
  expected: z.strictObject({ requestId: id, requestVersion: z.number().int().positive(), requestSha256: sha,
    agentId: id, roomId: id, executionGenerationId: id, runtimeGenerationId: id, turnId: id,
    providerContinuationId: id, providerTurnId: id, connectionId: id, nativeRequestId: z.union([id, z.number().int().nonnegative().safe()]) }),
  decisionId: id, actorId: id, decision: z.enum(["allow_once", "deny"]), projectionSha256: sha,
});

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function reference(record: ExecutionApprovalRecord): HostApprovalReference {
  const r = record.request;
  return { requestId: r.requestId, requestVersion: r.requestVersion, requestSha256: r.requestSha256,
    agentId: r.agentId, roomId: r.roomId, executionGenerationId: r.executionGenerationId,
    runtimeGenerationId: r.runtimeGenerationId, turnId: r.turnId, providerContinuationId: r.providerContinuationId,
    providerTurnId: r.providerTurnId, connectionId: r.connectionId, nativeRequestId: r.nativeRequestId };
}
function status(record: ExecutionApprovalRecord): HostApprovalStatus {
  if (record.request.state === "resolved") return "resolved";
  if (record.request.state === "requested") return "pending";
  if (record.request.state === "decision_recorded") return "decision_recorded";
  if (record.request.state === "dispatching") return "uncertain";
  return "unavailable";
}
function recordedDecision(record: ExecutionApprovalRecord): HostApprovalCandidate["recordedDecision"] {
  const decision = record.decision;
  return decision ? { decisionId: decision.decisionId, actorId: decision.actorId, decision: decision.decision,
    projectionSha256: decision.projectionSha256 } : null;
}
function literal(value: unknown): string {
  // JSON's fixed structure and literal control characters prevent terminal/RTL
  // sequences in agent-authored fields from impersonating the trusted labels.
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function inspectedRequest(native: ProviderPermissionRequest, fileChanges?: readonly CodexPermissionFileChange[]): unknown {
  return fileChanges ? { request: native.native, changes: fileChanges } : native.native;
}

/** Native payloads live only in this process. Optional execution capture is not consulted. */
export class HostApprovalBroker {
  private readonly lanes = new Map<string, Lane>();
  private readonly decisions = new Map<string, Promise<HostApprovalStatus>>();
  private readonly now: () => number;
  constructor(private readonly options: Options) { this.now = options.nowMs ?? Date.now; }

  install(agentId: string, handle: ProviderActionHandle, generation: string): () => void {
    this.lanes.get(agentId)?.controller.abort();
    const provider = this.options.provider;
    if (!provider?.observePermissions || !handle.providerConnection
      || !["codex_app_server", "opencode_server"].includes(handle.providerConnection.kind)) return () => {};
    const lane: Lane = { agentId, generation, handle, connection: { ...handle.providerConnection },
      controller: new AbortController(), revision: 0, state: "degraded", connectionId: null, requests: [] };
    this.lanes.set(agentId, lane);
    const receive = (event: ProviderPermissionObservation) => {
      if (!this.current(lane)) return;
      if (event.type === "snapshot" && event.requests.length <= MAX_REQUESTS) {
        if (lane.state !== "pending" || lane.connectionId !== event.connectionId) lane.revision += 1;
        lane.state = "pending";
        lane.connectionId = event.connectionId;
        // An unrelated new request or an identical OpenCode re-list does not
        // revoke this request. Codex callbacks retain exact object identity;
        // a new callback with a reused JSON-RPC ID is never the old request.
        lane.requests = event.requests.map(request => lane.requests.find(previous => previous.provider === request.provider
          && (request.provider === "codex" ? previous.native === request.native : isDeepStrictEqual(previous.native, request.native))) ?? request);
      } else {
        lane.revision += 1;
        lane.state = event.type === "unavailable" ? "unavailable" : "degraded";
      }
    };
    void provider.observePermissions(handle, receive, lane.controller.signal).catch(() => receive({ type: "degraded" }));
    return () => {
      lane.controller.abort();
      lane.requests = [];
      if (this.lanes.get(agentId) === lane) this.lanes.delete(agentId);
    };
  }

  close(): void { for (const lane of this.lanes.values()) { lane.controller.abort(); lane.requests = []; } this.lanes.clear(); }

  private current(lane: Lane): boolean {
    return this.options.isCurrent() && !lane.controller.signal.aborted && this.lanes.get(lane.agentId) === lane
      && this.options.currentHandle(lane.agentId) === lane.handle
      && sameProviderActionConnectionIdentity(lane.connection, lane.handle.providerConnection);
  }

  /** Caller authenticates the fixed host-list operation before reaching this method. */
  async list(roomId: string): Promise<HostApprovalCandidate[]> {
    if (!id.safeParse(roomId).success) throw new Error("An exact approval room is required.");
    const result: HostApprovalCandidate[] = [];
    for (const lane of this.lanes.values()) {
      const entry = await this.options.store.getEntry(lane.agentId);
      if (!entry || entry.room_id !== roomId || entry.delivery_mode !== "daemon_inbox") continue;
      for (const native of lane.requests) {
        if (result.length >= 64) break;
        try { result.push((await this.prepare(lane, native)).candidate); }
        catch { result.push({ reference: null, recordedDecision: null, presentation: this.presentation(entry, native, "Approval unavailable"),
          status: "unavailable", detail: native.provider === "codex" && native.native.method === "item/fileChange/requestApproval"
            ? CODEX_FILE_CHANGE_UNAVAILABLE
            : "This request cannot currently be matched to an active room turn. Decisions are disabled until it can be verified." }); }
      }
    }
    // Native callbacks can disappear immediately after sending, including when
    // the response is lost. Keep structural uncertainty visible across reloads;
    // an absent pending request never proves that our decision was applied.
    const shown = new Set(result.flatMap(item => item.reference ? [item.reference.requestId] : []));
    for (const record of await this.options.store.listExecutionApprovals(roomId)) {
      if (shown.has(record.request.requestId) || !["requested", "decision_recorded", "dispatching", "lost"].includes(record.request.state)) continue;
      const entry = await this.options.store.getEntry(record.request.agentId);
      if (!entry || entry.room_id !== roomId || !["codex", "open-model"].includes(entry.provider)) continue;
      result.push({ reference: reference(record), recordedDecision: recordedDecision(record),
        presentation: { agentId: entry.id, displayName: entry.display_name, provider: entry.provider as "codex" | "open-model",
          title: "Approval unavailable", details: "The native request is no longer available to inspect on this connection.",
          denyScope: entry.provider === "open-model" ? "session_pending" : "request" },
        status: record.decision?.dispatchId && record.request.applicationCertainty !== "impossible" ? "uncertain" : "unavailable",
        detail: record.decision?.dispatchId ? "A dispatch was recorded. Missing native evidence is not confirmation that the decision was applied."
          : "The original request must be available and match exactly before its recorded decision can be sent." });
    }
    return result;
  }

  private presentation(entry: DaemonManifestEntry, native: ProviderPermissionRequest,
    title: HostApprovalPresentation["title"], fileChanges?: readonly CodexPermissionFileChange[]): HostApprovalPresentation {
    const raw = literal(inspectedRequest(native, fileChanges));
    return { agentId: entry.id, displayName: entry.display_name, provider: native.provider, title,
      details: Buffer.byteLength(raw) <= MAX_PRESENTATION_BYTES ? raw : "The request is too large to present safely. No decision can be sent.",
      denyScope: native.provider === "open-model" ? "session_pending" : "request" };
  }

  private async prepare(lane: Lane, native: ProviderPermissionRequest) {
    const revision = lane.revision;
    if (!this.current(lane) || lane.state !== "pending" || !lane.connectionId || !lane.requests.includes(native)) throw new Error("Approval unavailable.");
    if (Buffer.byteLength(literal(native.native)) > MAX_PRESENTATION_BYTES) throw new Error("Approval presentation exceeds its limit.");
    const entry = await this.options.store.getEntry(lane.agentId);
    if (!entry || !await this.options.exactAuthority(entry, lane.handle, lane.generation)) throw new Error("Approval authority changed.");
    const correlated = await this.options.provider!.correlatePermissionTurn!(lane.handle, native);
    if (correlated.outcome !== "correlated") throw new Error("Approval turn is unproven.");
    const requiresEdits = native.provider === "codex" && native.native.method === "item/fileChange/requestApproval";
    const fileChanges = requiresEdits ? correlated.fileChanges : undefined;
    if (requiresEdits && !fileChanges?.length) throw new Error(CODEX_FILE_CHANGE_UNAVAILABLE);
    // The approved content includes the complete native proposal, not only
    // the RPC's IDs/grantRoot. Never approve a truncated presentation.
    const inspected = inspectedRequest(native, fileChanges);
    if (Buffer.byteLength(literal(inspected)) > MAX_PRESENTATION_BYTES) throw new Error("Approval presentation exceeds its limit.");
    const head = await this.options.inbox.head(lane.agentId);
    if (!head || head.room_id !== entry.room_id || head.provider_turn_id !== correlated.providerTurnId) throw new Error("Approval turn changed.");
    const owned: ApprovalAuthority = { inboxItemId: head.inbox_item_id, workAttemptId: lane.handle.workAttemptId,
      executionGenerationId: lane.generation, provider: native.provider,
      providerConnection: lane.connection as ApprovalAuthority["providerConnection"],
      configurationRevision: entry.runtime_configuration_revision ?? 1 };
    const requestId = `approval-${digest([lane.agentId, lane.connectionId, typeof native.native.id, native.native.id])}`;
    const requestSha256 = digest(inspected);
    const prior = await this.options.store.readLatestExecutionApproval(requestId);
    const unchanged = prior?.request.requestSha256 === requestSha256;
    const now = this.now();
    const admission = { request: { requestId, requestVersion: unchanged ? prior!.request.requestVersion : (prior?.request.requestVersion ?? 0) + 1,
      requestSha256, agentId: lane.agentId, roomId: entry.room_id,
      providerContinuationId: correlated.providerContinuationId, providerTurnId: correlated.providerTurnId,
      connectionId: lane.connectionId, nativeRequestId: native.native.id,
      kind: correlated.kind, risk: "high" as const, recoveryBoundary: native.provider === "codex" ? "connection" as const : "runtime" as const,
      createdAtMs: unchanged ? prior!.request.createdAtMs : now, expiresAtMs: unchanged ? prior!.request.expiresAtMs : now + 24 * 60 * 60 * 1000 }, authority: owned };
    const assertCurrent = () => {
      if (!this.current(lane) || lane.state !== "pending" || lane.revision !== revision || !lane.requests.includes(native)) throw new Error("Approval request changed.");
    };
    assertCurrent();
    const { approval } = await this.options.store.admitExecutionApproval(admission, commit =>
      this.options.fenceCommit(async () => { assertCurrent(); await commit(); }));
    assertCurrent();
    const presentation = this.presentation(entry, native, correlated.kind === "command" ? "Run a command" : "Change files", fileChanges);
    const candidate: HostApprovalCandidate = { reference: reference(approval), presentation,
      recordedDecision: recordedDecision(approval),
      status: now >= approval.request.expiresAtMs ? "unavailable" : status(approval),
      detail: now >= approval.request.expiresAtMs ? "This approval has expired. No new decision can be sent from this card." : null };
    return { candidate, owned, approval, assertCurrent, fileChanges };
  }

  async decide(input: unknown): Promise<HostApprovalStatus> {
    const parsed = decisionSchema.safeParse(input);
    if (!parsed.success) throw new Error("Approval decision is invalid.");
    const value = parsed.data;
    const previous = this.decisions.get(value.expected.requestId);
    // Serialize native dispatch only per request, never hold the delivery lane
    // while it waits for the human who is meant to release it.
    const operation = (previous?.catch(() => undefined) ?? Promise.resolve()).then(() => this.decideOnce(value));
    this.decisions.set(value.expected.requestId, operation);
    try { return await operation; }
    finally { if (this.decisions.get(value.expected.requestId) === operation) this.decisions.delete(value.expected.requestId); }
  }

  private async decideOnce(input: HostApprovalDecision): Promise<HostApprovalStatus> {
    const prior = await this.options.store.getExecutionApproval(input.expected);
    if (prior?.decision) {
      const decision = prior.decision;
      if (decision.decisionId !== input.decisionId || decision.actorId !== input.actorId
        || decision.decision !== input.decision || decision.projectionSha256 !== input.projectionSha256) throw new Error("An approval decision is already recorded.");
      if (decision.dispatchId) return status(prior); // A lost response never authorizes another send.
    }
    const lane = this.lanes.get(input.expected.agentId);
    const native = lane?.requests.find(request => request.native.id === input.expected.nativeRequestId);
    if (!lane || !native) throw new Error("The native approval request is unavailable.");
    const prepared = await this.prepare(lane, native);
    if (!isDeepStrictEqual(prepared.candidate.reference, input.expected)
      || digest(prepared.candidate.presentation) !== input.projectionSha256) throw new Error("The displayed approval request has changed.");
    const fence = (commit: () => Promise<void>) => this.options.fenceCommit(async () => { prepared.assertCurrent(); await commit(); });
    await this.options.store.selectHostApproval({ ...input, authority: prepared.owned, atMs: this.now() }, fence);
    const dispatchId = randomUUID();
    let dispatchStarted = false;
    let assertOperationalAuthority: (() => void) | null = null;
    try {
      const result = await this.options.provider!.replyPermission!(lane.handle, native, input.decision === "allow_once" ? "once" : "reject", {
        expectedFileChanges: prepared.fileChanges,
        beforeNativeDispatch: async () => {
          prepared.assertCurrent();
          const entry = await this.options.store.getEntry(lane.agentId);
          if (!entry || !await this.options.exactAuthority(entry, lane.handle, lane.generation)) throw new Error("Approval authority changed.");
          const permit = await this.options.store.beginExecutionApprovalDispatch({ expected: input.expected, authority: prepared.owned,
            decisionId: input.decisionId, dispatchId, projectionSha256: input.projectionSha256, atMs: this.now() }, fence);
          if (!permit.dispatch) throw new Error("This approval dispatch was already recorded.");
          dispatchStarted = true;
          assertOperationalAuthority = await this.options.store.validateExecutionApprovalAuthority(input.expected, prepared.owned);
          prepared.assertCurrent();
        },
        assertNativeDispatch: () => {
          prepared.assertCurrent();
          if (!assertOperationalAuthority || this.now() >= prepared.approval.request.expiresAtMs) throw new Error("Approval authority is unavailable.");
          assertOperationalAuthority();
        },
      });
      await this.options.store.recordExecutionApprovalOutcome({ expected: input.expected, decisionId: input.decisionId, dispatchId,
        evidence: result.outcome, atMs: this.now() }, this.options.fenceCommit);
      return result.outcome === "native_processed" ? "resolved" : "decision_sent";
    } catch {
      if (dispatchStarted) {
        await this.options.store.recordExecutionApprovalOutcome({ expected: input.expected, decisionId: input.decisionId, dispatchId,
          evidence: "dispatch_uncertain", atMs: this.now() }, this.options.fenceCommit).catch(() => undefined);
        return "uncertain";
      }
      throw new Error("The decision was recorded but could not be sent. Refresh the request before trying again.");
    }
  }
}
