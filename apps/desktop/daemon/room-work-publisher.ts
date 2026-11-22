import { readableContributionText } from "../../../shared/contribution-text.mjs";
import { hasReviewableRoomContribution } from "../../../shared/room-agent-work.mjs";
import type { WorkspaceReviewPage } from "../../../shared/workspace-review.mjs";
import { RoomWorkspaceStore, type WorkspaceCaptureIdentity } from "./room-workspace-store.js";
import { captureRecordedRemoteTips, captureWorkspaceHead, releaseWorkspaceTree } from "../../../shared/workspace-turn-capture.mjs";
import { WorkspaceCapture } from "./workspace-capture.js";
import type { DatabaseSync } from "node:sqlite";
import { publishRoomWork, reportGroupedNoReply, type RoomWorkPublishInput, type RoomWorkPublishResult } from "./cloud-http.js";
import {
  completeEffectInTransaction,
  EffectClaimRefusedError,
  EffectExecutor,
  EffectFenceError,
  failEffect,
  getEffectByIdempotencyKey,
  hasInterruptedRoomWorkEffects,
  listActiveRoomWorkEffectsForAgent,
  parseRoomWorkGroupedNoReplyEffectPayload,
  parseRoomWorkPublishEffectPayload,
  pruneTerminalRoomWorkEffectsInTransaction,
  recoverInterruptedEffectsOnStartup,
  rescheduleEffectForRetry,
  ROOM_WORK_EFFECT_MAX_ATTEMPTS,
  ROOM_WORK_GROUPED_NO_REPLY_EFFECT_KIND,
  ROOM_WORK_PUBLISH_EFFECT_KIND,
  roomWorkGroupedNoReplyIdempotencyKey,
  roomWorkPublishIdempotencyKey,
  supersedeRoomWorkPublishEffects,
  withFencedEffectTransaction,
  type EffectHandler,
  type EffectRecord,
  type RoomWorkGroupedNoReplyEffectPayload,
  type RoomWorkPublishEffectPayload,
} from "./effect-journal/index.js";
import { PENDING_PEER_REPORT_SQL, resolvePeerReceipt, type PeerReceiptResult } from "./queued-peer-deliveries.js";
import { ExecutionShadowStore } from "./execution-shadow-store.js";
import { RoomWorkPublicationStore, type RoomWorkOrigin, type RoomWorkPublication } from "./room-work-publication-store.js";
import { DaemonFenceLostError } from "./singleton.js";
import type { SupervisedIngressAgent } from "./supervised-agent-delivery.js";
import type { WorkerRuntimeCustody } from "./worker-runtime-custody.js";
import { currentWorkerPublicationAuthority, sameWorkerPublicationOrigin } from "./worker-publication-authority.js";
import { isEphemeralWorkspaceMarker } from "./ephemeral-workspace-provisioner.js";
import { isNetworkRemote, type WorkspaceMarker } from "./workspace-provisioner.js";
import { RecordedRemoteAnswers } from "./recorded-remote-answers.js";
import { RoomLatencyTrace } from "./room-latency-trace.js";

type Options = {
  custody: Pick<WorkerRuntimeCustody, "hostGrant" | "workerAuthorization">;
  daemonGeneration(): number;
  isClosing(): boolean;
  assertCurrent(): Promise<void>;
  /** Synchronous generation fence check run inside every write transaction before COMMIT. */
  assertWriteFence?(): void;
  /** Shared process-wide effect executor; standalone tests create an internal executor if omitted. */
  effectExecutor?: EffectExecutor;
  publish?(input: RoomWorkPublishInput): Promise<RoomWorkPublishResult>;
  reportGroupedNoReply?: typeof reportGroupedNoReply;
  diagnostic?(code: "storage_unavailable" | "authority_unavailable" | "publication_unavailable" | "publication_conflict" | `remote_unanswered: ${string}`): void;
  now?(): number;
  /** `remote` is the remote to ask what upstream held (recordedRemote); without it a turn is compared plainly. */
  workspaceLocation?(workAttemptId: string): Promise<{ path: string; revision: string | null; remote?: string | null }>;
  askRemote?(remote: string): Promise<string[] | null>;
};
type Row = Record<string, string | number | null>;
type PublicationAuthority = NonNullable<ReturnType<typeof currentWorkerPublicationAuthority>>;
type PendingPublishSettlement = {
  attemptCount: number;
  record: RoomWorkPublication;
  reviewPage: WorkspaceReviewPage | null;
  result: RoomWorkPublishResult;
};
type PendingGroupedSettlement = {
  attemptCount: number;
  inboxItemId: string;
  result: PeerReceiptResult;
};
class RoomWorkSettlementStorageError extends Error {
  constructor(cause: unknown) {
    super("Room-work publication settlement storage write failed.", { cause });
    this.name = "RoomWorkSettlementStorageError";
  }
}
const COALESCE_MS = 1_000;
const RETRY_MS = 30_000;
/** How many receipt-derived `failed` summaries one pass stages. */
const FAILED_RECEIPTS_PER_PASS = 4;
const canonicalSource = (id: string) => /^msg_[1-9]\d{0,9}$/.test(id) && Number(id.slice(4)) <= 2147483647;
const key = (record: Pick<RoomWorkPublication, "agentId" | "roomId" | "sourceMessageId">) =>
  JSON.stringify([record.agentId, record.roomId, record.sourceMessageId]);
const terminalState = (state: unknown) => ["completed", "completed_no_reply", "failed", "interrupted"].includes(String(state));

/** Reserve one place for completion; the other three keep recovery moving.
 * This changes queue order only, never evidence, authority or retry eligibility. */
function completionFirst<T>(items: T[], pendingCompletion: (item: T) => boolean): T[] {
  const index = items.findIndex(pendingCompletion);
  if (index > 0) items.unshift(...items.splice(index, 1));
  return items;
}

/**
 * The remote to ask what a workspace's upstream held: the one the daemon recorded when it
 * provisioned the workspace, never one that the repository's own configuration names. An agent
 * can add a remote or point `origin` at a repository of its own; it cannot change this record.
 * Null when the record is not a repository reached over the network. A room-only workspace has
 * none. A project folder without an origin, a local path, a file: URL and a server on this
 * machine itself are places that any agent here can commit to.
 */
export function recordedRemote(identity: Pick<WorkspaceMarker, "remote_url" | "resolved_revision" | "bare_path">): string | null {
  const url = identity.remote_url;
  if (isEphemeralWorkspaceMarker(identity) || !isNetworkRemote(url)) return null;
  // scheme://[user@]host[:port]/path, or Git's scp-like [user@]host:path.
  const host = (/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?(\[[^\]]*\]|[^/:]*)/i.exec(url) ?? /^(?:[^/@:\s]+@)?(\[[^\]]*\]|[^/:\s]+):/.exec(url))?.[1] ?? "";
  return isThisMachine(host) ? null : url;
}

/**
 * A host that is this machine itself: localhost, an address in 127.0.0.0/8, ::1, the same
 * as IPv4 addresses inside IPv6, and the unspecified addresses, in any way of writing them
 * (127.1, 0x7f.1, 2130706433). An ssh alias or a name that only resolves to this machine
 * cannot be known without resolving it, and is not.
 */
function isThisMachine(host: string): boolean {
  let name: string;
  // The URL parser gives each address one form: 127.0.0.1, [::1], [::ffff:7f00:1].
  try { name = new URL(`http://${host}/`).hostname.replace(/\.$/, ""); } catch { return true; }
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  const inside = /^\[::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(name)?.slice(1).map((part) => parseInt(part, 16));
  const address = inside ? [inside[0] >> 8, inside[0] & 255, inside[1] >> 8, inside[1] & 255]
    : /^\d+\.\d+\.\d+\.\d+$/.test(name) ? name.split(".").map(Number) : null;
  return address ? address[0] === 127 || address.every((part) => part === 0) : name === "[::1]" || name === "[::]";
}

/** Optional, bounded evidence upload. Owns no provider, delivery or credential-recovery port. */
export class RoomWorkPublisher {
  private readonly store: RoomWorkPublicationStore;
  private readonly capture: ExecutionShadowStore;
  private readonly workspaces: RoomWorkspaceStore;
  private readonly executor: EffectExecutor;
  private readonly ownsExecutor: boolean;
  private recoveredOwnedExecutor = false;
  private readonly stamps = new Map<string, Map<string, string>>();
  private readonly stagingAttemptedAt = new Map<string, number>();
  private readonly pendingDispatchAuthority = new Map<string, PublicationAuthority>();
  private readonly pendingPublishSettlements = new Map<string, PendingPublishSettlement>();
  private readonly pendingGroupedSettlements = new Map<string, PendingGroupedSettlement>();
  /** The commit each open turn started on, and what the remotes held then. Like the delivery's own baseline, neither outlives this process. */
  private readonly turnStarts = new Map<string, { head: string; remoteTips: Promise<string[] | null> }>();
  /** One set of answers for all agents and turns of this daemon. It does not outlive this process either. */
  private readonly remoteAnswers = new RecordedRemoteAnswers(
    // A remote that gives no answer leaves the turn compared plainly; the reason goes to the daemon's diagnostics, not to a stderr nobody reads.
    (remote) => this.options.askRemote ? this.options.askRemote(remote)
      : captureRecordedRemoteTips(remote, undefined, { onNoAnswer: (reason) => this.report(`remote_unanswered: ${reason}`) }), () => this.now());
  private readonly cancellation = new AbortController();
  private readonly workspaceCapture = new WorkspaceCapture();
  private scheduled: NodeJS.Timeout | null = null;
  private scheduledFor = Infinity;
  private running = false;
  private readonly changedAgents = new Set<string>();
  private readonly settledAgents = new Set<string>();
  private sweepNext = false;
  private closed = false;
  private scanAfter = "";

  static attach(database: DatabaseSync, options: Options): RoomWorkPublisher {
    const publisher = new RoomWorkPublisher(database, options);
    publisher.schedule(0);
    return publisher;
  }

  constructor(private readonly database: DatabaseSync, private readonly options: Options) {
    this.store = new RoomWorkPublicationStore(database, options.assertWriteFence);
    this.capture = new ExecutionShadowStore(database, { assertWriteFence: options.assertWriteFence });
    this.workspaces = new RoomWorkspaceStore(database, options.assertWriteFence);
    this.ownsExecutor = !options.effectExecutor;
    this.executor = options.effectExecutor ?? new EffectExecutor({
      getDatabase: () => this.database,
      currentDaemonGeneration: () => this.options.daemonGeneration(),
      assertCurrent: () => this.options.assertCurrent(),
      assertWriteFence: () => { this.options.assertWriteFence?.(); },
      isClosing: () => this.closed || this.options.isClosing(),
      nowMs: () => this.now(),
      nowIso: () => this.nowIso(),
    });
    this.executor.registerHandler(ROOM_WORK_PUBLISH_EFFECT_KIND, this.createPublishEffectHandler());
    this.executor.registerHandler(ROOM_WORK_GROUPED_NO_REPLY_EFFECT_KIND, this.createGroupedNoReplyEffectHandler());
  }

  /** Called before the worker-authenticated poll, never after delayed native capture. */
  observeNewSources(agent: SupervisedIngressAgent): ((ids: readonly string[]) => void) | undefined {
    const authority = this.authority(agent.agentId);
    if (!authority || agent.deliveryMode !== "daemon_inbox" || agent.daemonGeneration !== this.options.daemonGeneration()
      || authority.origin.roomId !== agent.roomId || authority.origin.apiOrigin !== agent.apiUrl
      || authority.worker.agentSessionId !== agent.agentSessionId || authority.worker.bearer !== agent.bearer
      || authority.worker.workAttemptId !== agent.workAttemptId) return;
    const origin = { ...authority.origin };
    const generation = agent.daemonGeneration;
    return ids => {
      if (this.unavailable() || generation !== this.options.daemonGeneration()) return;
      const current = this.authority(origin.agentId);
      if (!current || !this.sameOrigin(current.origin, origin, true)) return;
      // A missed pin stays local. Replayed inbox rows never call this hook.
      try { this.store.pin(origin, ids.filter(canonicalSource)); this.changed(origin.agentId); }
      catch { this.report("storage_unavailable"); }
    };
  }

  private captureAuthority(agent: SupervisedIngressAgent, sourceMessageId: string) {
    const record = this.store.get(agent.agentId, agent.roomId, sourceMessageId);
    const authority = this.authority(agent.agentId);
    return record?.state === "open" && authority && this.sameOrigin(authority.origin, record, true)
      && authority.worker.workAttemptId === agent.workAttemptId && agent.daemonGeneration === this.options.daemonGeneration()
      ? { record, authority } : null;
  }

  /** Called only at the native pre-dispatch boundary, never while a message is queued. */
  async beginWorkspace(agent: SupervisedIngressAgent, sourceMessageId: string, inboxItemId: string): Promise<string | null> {
    if (this.unavailable() || !this.options.workspaceLocation) return null;
    const context = this.captureAuthority(agent, sourceMessageId);
    if (!context) return null;
    const identity = { ...agent, sourceMessageId, inboxItemId };
    try {
      if (!this.workspaces.begin(identity)) return null;
      const location = await this.options.workspaceLocation(agent.workAttemptId);
      const ref = JSON.stringify([agent.agentId, sourceMessageId, inboxItemId]);
      // Decided now, before the agent runs, and not awaited: a slow remote must not delay the turn.
      const remoteTips = location.remote ? this.remoteAnswers.forTurn(location.remote) : Promise.resolve(null);
      const tree = await this.workspaceCapture.begin(location.path, ref);
      const head = tree ? await captureWorkspaceHead(location.path) : null;
      await this.options.assertCurrent();
      const current = this.captureAuthority(agent, sourceMessageId);
      if (current?.authority.worker !== context.authority.worker || current?.authority.grant !== context.authority.grant) return null;
      this.workspaces.setBaseline(identity, tree);
      if (head) this.turnStarts.set(ref, { head, remoteTips });
      return tree;
    } catch { this.report("storage_unavailable"); return null; }
  }

  /** Save immutable settled bytes even when delayed native execution evidence isn't ready yet. */
  async captureWorkspace(agent: SupervisedIngressAgent, sourceMessageId: string, inboxItemId: string, summaryText?: string | null, invocationBaseline: string | null = null): Promise<void> {
    if (this.unavailable() || !this.options.workspaceLocation) return;
    const timing = new RoomLatencyTrace("workspace_capture");
    const context = this.captureAuthority(agent, sourceMessageId);
    const alreadySettled = context && (context.record.summary?.workspace || this.workspaces.settled(agent.agentId, agent.roomId, sourceMessageId));
    timing.mark("lookup");
    if (!context || alreadySettled) { timing.finish(); return; }
    const identity: WorkspaceCaptureIdentity = { ...agent, sourceMessageId, inboxItemId };
    try {
      const location = await this.options.workspaceLocation(agent.workAttemptId);
      timing.mark("location");
      const ref = JSON.stringify([agent.agentId, sourceMessageId, inboxItemId]);
      const start = this.turnStarts.get(ref);
      const pair = await this.workspaceCapture.settle(location.path, location.revision, invocationBaseline && invocationBaseline === this.workspaces.baseline(identity) ? invocationBaseline : null, ref, start?.head, start?.remoteTips);
      timing.mark("capture");
      pair.contribution.summary = readableContributionText(summaryText);
      await this.options.assertCurrent();
      const current = this.captureAuthority(agent, sourceMessageId);
      timing.mark("authority");
      if (current?.authority.worker !== context.authority.worker || current?.authority.grant !== context.authority.grant) return;
      const captured = this.capture.roomWorkSummary(agent.agentId, agent.roomId, sourceMessageId);
      const execution = captured.availability === "available" ? captured.summary : {
        recorded_state: "unknown" as const, evidence_incomplete: true, elapsed_ms: null,
        operation_counts: { unresolved: 0, succeeded: 0, failed: 0, denied_before_start: 0,
          cancelled_before_start: 0, interrupted_after_start: 0, lost_after_start: 0 },
      };
      const { review, ...preview } = pair;
      const summary = { ...execution, version: 3 as const, ...preview };
      const reviewable = hasReviewableRoomContribution(summary);
      timing.mark("projection");
      // Settlement is also the durable no-review decision. Preserve unavailable
      // evidence instead of treating it as no change or recapturing on restart.
      this.workspaces.settle(identity, summary, reviewable ? review : undefined);
      if (captured.availability === "available") this.store.stage(current.record,
        reviewable ? { ...captured, summary } : captured);
      timing.mark("persistence");
      this.changed(agent.agentId);
      await releaseWorkspaceTree(location.path, ref);
      timing.mark("cleanup");
    } catch { this.report("storage_unavailable"); }
    finally { timing.finish(); }
  }

  /** Release only our private retention refs, including Stop, recovery and fencing exits. */
  async releaseWorkspace(agent: SupervisedIngressAgent, sourceMessageId: string, inboxItemId: string): Promise<void> {
    const ref = JSON.stringify([agent.agentId, sourceMessageId, inboxItemId]);
    this.turnStarts.delete(ref);
    if (!this.options.workspaceLocation) return;
    try {
      const location = await this.options.workspaceLocation(agent.workAttemptId);
      await releaseWorkspaceTree(location.path, ref);
      await releaseWorkspaceTree(location.path, `${ref}:settled`);
    } catch { /* Optional retention cleanup cannot change delivery outcomes. */ }
  }

  /** Capture supplies only a postcommit hint; no SQL or HTTP runs on its stack. */
  changed(agentId: string): void {
    if (this.unavailable()) return;
    this.changedAgents.add(agentId);
    this.schedule(COALESCE_MS);
  }

  /** Delivery released its lane. This is only a prompt hint: durable evidence
   * and the usual authority checks still decide what can be published. */
  settled(agentId: string): void {
    if (this.unavailable()) return;
    this.changedAgents.add(agentId);
    this.settledAgents.add(agentId);
    this.schedule(0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.workspaceCapture.close();
    this.cancellation.abort();
    if (this.ownsExecutor) this.executor.fence();
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    this.scheduledFor = Infinity;
    this.changedAgents.clear();
    this.settledAgents.clear();
    this.stamps.clear();
    this.stagingAttemptedAt.clear();
    this.pendingDispatchAuthority.clear();
    this.pendingPublishSettlements.clear();
    this.pendingGroupedSettlements.clear();
    this.turnStarts.clear();
    this.remoteAnswers.clear();
  }

  private unavailable(): boolean { return this.closed || this.options.isClosing() || this.executor.isFenced; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private nowIso(): string { return new Date(this.now()).toISOString(); }
  private writeFence = (): void => { this.options.assertWriteFence?.(); };
  private report(code: Parameters<NonNullable<Options["diagnostic"]>>[0]): void {
    try { if (this.options.diagnostic) this.options.diagnostic(code); else console.warn(`[room_work_publication] ${code}`); } catch { /* optional diagnostics */ }
  }
  private schedule(delay: number, replace = false): void {
    if (this.unavailable()) return;
    const due = Date.now() + delay;
    if (!replace && this.scheduled && this.scheduledFor <= due) return;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduledFor = due;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      this.scheduledFor = Infinity;
      void this.flush();
    }, delay);
    this.scheduled.unref();
  }

  private authority(agentId: string) {
    return this.unavailable() ? null : currentWorkerPublicationAuthority(
      this.options.custody,
      agentId,
      this.options.daemonGeneration(),
      this.now(),
    );
  }

  private sameOrigin(left: RoomWorkOrigin, right: RoomWorkOrigin, requireOriginalSession = false): boolean {
    return sameWorkerPublicationOrigin(left, right, requireOriginalSession);
  }

  private pendingReviewPage(record: RoomWorkPublication) {
    return hasReviewableRoomContribution(record.summary)
      ? this.workspaces.pendingPage(record.agentId, record.roomId, record.sourceMessageId) : null;
  }

  /** The runtimes of this agent that a recovery boundary has archived. */
  private archivedRuntimes(agentId: string): Set<string> {
    try {
      return new Set((this.database.prepare(`SELECT DISTINCT runtime_generation_id FROM agent_runtime_recoveries
        WHERE agent_id=? AND phase IN ('stopped','complete')`).all(agentId) as Row[]).map(row => String(row.runtime_generation_id)));
    } catch { return new Set(); /* A database without the recovery journal has no boundary. */ }
  }

  /** Cheap, bounded change stamps avoid replaying every historical message on every output chunk. */
  private async stageChanged(agentId: string): Promise<boolean> {
    const records = this.store.list(agentId).filter(record => record.state === "open");
    if (!records.length) { this.stamps.delete(agentId); return false; }
    const facts = this.database.prepare(`SELECT f.sequence,f.runtime_generation_id,f.domain,t.attempt_id
      FROM (SELECT * FROM execution_facts WHERE agent_id=? ORDER BY sequence DESC LIMIT 10000) f
      LEFT JOIN runs t ON t.turn_id=f.turn_id AND t.agent_id=f.agent_id
        AND t.execution_generation_id=f.execution_generation_id AND t.runtime_generation_id=f.runtime_generation_id`).all(agentId) as Row[];
    const attempts = new Map<string, { sequence: number; runtimes: Set<string> }>();
    const runtimeSequence = new Map<string, number>();
    for (const fact of facts) {
      const runtime = String(fact.runtime_generation_id);
      if (fact.domain === "turn" || fact.domain === "execution") {
        if (!fact.attempt_id) continue;
        const value = attempts.get(String(fact.attempt_id)) ?? { sequence: 0, runtimes: new Set<string>() };
        value.sequence = Math.max(value.sequence, Number(fact.sequence)); value.runtimes.add(runtime);
        attempts.set(String(fact.attempt_id), value);
      } else runtimeSequence.set(runtime, Math.max(runtimeSequence.get(runtime) ?? 0, Number(fact.sequence)));
    }
    const observer = this.database.prepare("SELECT source_id,last_source_sequence,max_observed_sequence FROM execution_observers WHERE agent_id=?").get(agentId);
    // A recovery boundary keeps an earlier gap on record after the next runtime
    // starts a clean observer; the messages that failed inside it still do.
    const archived = this.archivedRuntimes(agentId);
    const incomplete = !observer || observer.source_id === null || Number(observer.max_observed_sequence) > Number(observer.last_source_sequence)
      || archived.size > 0;
    const previous = this.stamps.get(agentId) ?? new Map<string, string>();
    this.stamps.set(agentId, previous);
    const candidates: Array<{ record: RoomWorkPublication; stamp: string; pendingCompletion: boolean }> = [];
    let scanned = 0;
    for (const record of records) {
      if (++scanned % 64 === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (this.unavailable()) return false;
      }
      const attempt = this.database.prepare("SELECT attempt_id,state,conclusion FROM execution_message_attempts WHERE agent_id=? AND room_id=? AND source_message_id=?")
        .get(record.agentId, record.roomId, record.sourceMessageId);
      if (!attempt) continue;
      const evidence = attempts.get(String(attempt.attempt_id));
      if (!evidence) continue;
      const sequence = Math.max(evidence.sequence, ...[...evidence.runtimes].map(runtime => runtimeSequence.get(runtime) ?? 0));
      // Each boundary that archives a runtime this message ran on can make
      // its evidence incomplete, the second as much as the first.
      const boundaries = [...evidence.runtimes].filter(runtime => archived.has(runtime)).sort();
      const stamp = JSON.stringify([attempt.attempt_id, attempt.state, attempt.conclusion, sequence, incomplete, boundaries]);
      const recordKey = key(record);
      const state = attempt.state === "cleanly_concluded"
        ? attempt.conclusion === "replied" ? "completed" : "completed_no_reply" : attempt.state;
      if (previous.get(recordKey) !== stamp) candidates.push({ record, stamp,
        pendingCompletion: terminalState(state) && record.summary?.recorded_state !== state });
    }
    // A capture gap means a message's turn was never recorded and never will
    // be. Its delivery receipt still says whether it failed. A few per pass;
    // each one staged leaves the set, so the rest follow on later passes.
    if (incomplete) {
      let unstaged: RoomWorkPublication[] = [];
      try { unstaged = this.store.unstagedFailedReceipts(agentId, FAILED_RECEIPTS_PER_PASS); } catch { this.report("storage_unavailable"); }
      for (const record of unstaged) {
        await this.options.assertCurrent();
        if (this.unavailable()) return false;
        try { this.store.stageFailedReceipt(record); } catch { this.report("storage_unavailable"); }
      }
    }
    const eligible = candidates.filter(({ record }) => {
      const prior = this.stagingAttemptedAt.get(key(record));
      return prior === undefined || this.now() - prior >= RETRY_MS;
    }).sort((a, b) => (this.stagingAttemptedAt.get(key(a.record)) ?? -Infinity)
      - (this.stagingAttemptedAt.get(key(b.record)) ?? -Infinity));
    for (const { record, stamp } of completionFirst(eligible, item => item.pendingCompletion).slice(0, 4)) {
      await new Promise<void>(resolve => setImmediate(resolve));
      await this.options.assertCurrent();
      if (this.unavailable()) return false;
      const recordKey = key(record);
      this.stagingAttemptedAt.set(recordKey, this.now());
      try {
        const captured = this.capture.roomWorkSummary(record.agentId, record.roomId, record.sourceMessageId);
        if (captured.availability !== "available") continue;
        // Reuse the exact review captured at the turn boundary, including after restart.
        const current = this.store.get(record.agentId, record.roomId, record.sourceMessageId);
        if (!current || current.state !== "open") continue;
        const settled = this.workspaces.settled(record.agentId, record.roomId, record.sourceMessageId) ?? current.summary;
        // Retain already-staged legacy payloads; do not rewrite shared history.
        // New no-review settlements contribute execution evidence only.
        if (settled?.workspace && (current.summary?.workspace || hasReviewableRoomContribution(settled))) captured.summary = { ...captured.summary, version: settled.contribution ? 3 : 2,
          workspace: settled.workspace, ...(settled.contribution ? { contribution: settled.contribution } : {}) };
        this.store.stage(current, captured);
        previous.set(recordKey, stamp);
        this.stagingAttemptedAt.delete(recordKey);
      } catch { this.report("storage_unavailable"); }
    }
    return eligible.length > 4;
  }

  private createPublishEffectHandler(): EffectHandler {
    return {
      retryable: true,
      autoPump: false,
      defaultMaxAttempts: ROOM_WORK_EFFECT_MAX_ATTEMPTS,
      backoff: { baseDelayMs: RETRY_MS, maxDelayMs: RETRY_MS, factor: 1 },
      authorizeClaim: (_database, effect) => {
        const payload = parseRoomWorkPublishEffectPayload(effect.payload);
        if (!payload) return "Room work publication effect payload is invalid.";
        const record = this.store.get(effect.agent_id, payload.room_id, payload.source_message_id);
        if (!record || record.state !== "open" || !record.summary || record.attemptId !== payload.attempt_id) {
          return "Room work publication is no longer open.";
        }
        if (record.revision !== payload.revision || record.digest !== payload.digest) {
          return "Room work publication revision was superseded.";
        }
        if (payload.review_page_index === null) {
          if (record.acknowledgedRevision >= payload.revision) {
            return "Room work publication revision is already acknowledged.";
          }
          return null;
        }
        const pendingPage = this.pendingReviewPage(record);
        if (!pendingPage
          || pendingPage.index !== payload.review_page_index
          || pendingPage.total !== payload.review_page_total
          || pendingPage.digest !== payload.review_page_digest) {
          return "Room work review page is no longer pending.";
        }
        return null;
      },
      execute: async (claimed, context) => {
        const payload = parseRoomWorkPublishEffectPayload(claimed.payload);
        if (!payload) {
          return { status: "failed", error: "Room work publication effect payload is invalid." };
        }
        const record = this.store.get(claimed.agent_id, payload.room_id, payload.source_message_id);
        if (!record || record.state !== "open" || !record.summary || record.attemptId !== payload.attempt_id
          || record.revision !== payload.revision || record.digest !== payload.digest) {
          return { status: "failed", error: "publication_superseded_before_dispatch" };
        }
        const reviewPage = payload.review_page_index !== null ? this.pendingReviewPage(record) : null;
        if (payload.review_page_index !== null && (!reviewPage
          || reviewPage.index !== payload.review_page_index
          || reviewPage.total !== payload.review_page_total
          || reviewPage.digest !== payload.review_page_digest)) {
          return { status: "failed", error: "publication_review_page_superseded_before_dispatch" };
        }
        const expected = this.pendingDispatchAuthority.get(claimed.id);
        const current = this.authority(record.agentId);
        if (this.unavailable() || context.signal.aborted
          || !current || !this.sameOrigin(current.origin, record)
          || (expected && (current.grant !== expected.grant || current.worker !== expected.worker))) {
          return { status: "retry", error: "authority_unavailable", retryAfterMs: 0 };
        }
        const signal = AbortSignal.any([context.signal, this.cancellation.signal]);
        let result: RoomWorkPublishResult;
        try {
          result = await (this.options.publish ?? publishRoomWork)({
            apiOrigin: record.apiOrigin,
            grantId: current.grant.grantId,
            supervisorGrant: current.grant.supervisorGrant,
            grantGeneration: current.grant.grantGeneration,
            sessionId: current.worker.agentSessionId,
            roomId: record.roomId,
            sourceMessageId: record.sourceMessageId,
            agentKey: record.agentKey,
            revision: record.revision,
            summary: record.summary,
            ...(reviewPage ? { reviewPage } : {}),
            signal,
          });
        } catch (error) {
          if (error instanceof DaemonFenceLostError) throw error;
          if (this.unavailable() || signal.aborted) {
            return { status: "retry", error: "publication_cancelled_on_close", retryAfterMs: 0 };
          }
          // Never persist raw provider/HTTP exception text into SQLite `effects.last_error`.
          this.report("publication_unavailable");
          return { status: "retry", error: "publication_unavailable" };
        }
        try {
          await context.assertCurrent();
        } catch (error) {
          if (error instanceof DaemonFenceLostError) throw error;
          if (!this.unavailable()) this.report("authority_unavailable");
          return { status: "retry", error: "authority_unavailable", retryAfterMs: 0 };
        }
        if (this.unavailable() || signal.aborted) {
          return { status: "retry", error: "publication_cancelled_on_close", retryAfterMs: 0 };
        }
        this.pendingPublishSettlements.set(claimed.id, {
          attemptCount: claimed.attempt_count,
          record,
          reviewPage,
          result,
        });
        return {
          status: "completed",
          outcome: {
            status: result,
            revision: record.revision,
            ...(reviewPage ? { review_page_index: reviewPage.index } : {}),
          },
        };
      },
      settle: async (claimed, executionResult, defaultSettle) => {
        const pending = this.pendingPublishSettlements.get(claimed.id);
        this.pendingPublishSettlements.delete(claimed.id);
        if (executionResult.status !== "completed") {
          return this.runDefaultSettle(defaultSettle);
        }
        if (this.unavailable() || !pending || pending.attemptCount !== claimed.attempt_count) {
          return this.rescheduleCancelledEffect(claimed, "publication_cancelled_on_close");
        }
        try {
          const settled = withFencedEffectTransaction(this.database, this.writeFence, () => {
            if (pending.result === "acknowledged") {
              this.store.acknowledgeInTransaction(pending.record);
              if (pending.reviewPage) {
                this.workspaces.acknowledgePage(
                  pending.record.agentId,
                  pending.record.roomId,
                  pending.record.sourceMessageId,
                  pending.reviewPage,
                );
              }
            } else {
              this.store.stopInTransaction(pending.record, pending.result);
            }
            const completed = completeEffectInTransaction(this.database, {
              id: claimed.id,
              expectedEpoch: claimed.epoch,
              expectedAttemptCount: claimed.attempt_count,
              outcome: executionResult.outcome,
              nowIso: this.nowIso(),
            });
            pruneTerminalRoomWorkEffectsInTransaction(this.database, claimed.agent_id);
            return completed;
          });
          if (pending.result === "conflict") this.report("publication_conflict");
          return settled;
        } catch (error) {
          if (error instanceof DaemonFenceLostError) throw error;
          return this.handleSettlementStorageFailure(claimed, error);
        }
      },
    };
  }

  private createGroupedNoReplyEffectHandler(): EffectHandler {
    return {
      retryable: true,
      autoPump: false,
      defaultMaxAttempts: ROOM_WORK_EFFECT_MAX_ATTEMPTS,
      backoff: { baseDelayMs: RETRY_MS, maxDelayMs: RETRY_MS, factor: 1 },
      authorizeClaim: (database, effect) => {
        const payload = parseRoomWorkGroupedNoReplyEffectPayload(effect.payload);
        if (!payload) return "Grouped room-work receipt payload is invalid.";
        const stillPending = Boolean(database.prepare(`
          SELECT 1 FROM inbox_items i
          WHERE i.inbox_item_id = ? AND i.agent_id = ? AND i.room_id = ?
            AND i.source_message_id = ? AND i.state = 'acknowledged_no_reply'
            AND ${PENDING_PEER_REPORT_SQL}
        `).get(payload.inbox_item_id, effect.agent_id, payload.room_id, payload.source_message_id));
        if (!stillPending) return "Grouped room-work receipt is already resolved.";
        return null;
      },
      execute: async (claimed, context) => {
        const payload = parseRoomWorkGroupedNoReplyEffectPayload(claimed.payload);
        if (!payload) {
          return { status: "failed", error: "Grouped room-work receipt payload is invalid." };
        }
        const pin = this.store.get(claimed.agent_id, payload.room_id, payload.source_message_id);
        const expected = this.pendingDispatchAuthority.get(claimed.id);
        const current = this.authority(claimed.agent_id);
        if (this.unavailable() || context.signal.aborted
          || !pin || !current || !this.sameOrigin(current.origin, pin)
          || (expected && (current.grant !== expected.grant || current.worker !== expected.worker))) {
          return { status: "retry", error: "authority_unavailable", retryAfterMs: 0 };
        }
        const signal = AbortSignal.any([context.signal, this.cancellation.signal]);
        let result: PeerReceiptResult;
        try {
          result = await (this.options.reportGroupedNoReply ?? reportGroupedNoReply)({
            apiUrl: pin.apiOrigin,
            roomId: pin.roomId,
            sourceMessageId: pin.sourceMessageId,
            bearer: current.worker.bearer,
            signal,
          });
        } catch (error) {
          if (error instanceof DaemonFenceLostError) throw error;
          if (this.unavailable() || signal.aborted) {
            return { status: "retry", error: "publication_cancelled_on_close", retryAfterMs: 0 };
          }
          this.report("publication_unavailable");
          return { status: "retry", error: "publication_unavailable" };
        }
        try {
          await context.assertCurrent();
        } catch (error) {
          if (error instanceof DaemonFenceLostError) throw error;
          if (!this.unavailable()) this.report("authority_unavailable");
          return { status: "retry", error: "authority_unavailable", retryAfterMs: 0 };
        }
        const after = this.authority(claimed.agent_id);
        if (this.unavailable() || signal.aborted || after?.grant !== current.grant || after?.worker !== current.worker) {
          return { status: "retry", error: "authority_changed_during_grouped_report", retryAfterMs: 0 };
        }
        this.pendingGroupedSettlements.set(claimed.id, {
          attemptCount: claimed.attempt_count,
          inboxItemId: payload.inbox_item_id,
          result,
        });
        return {
          status: "completed",
          outcome: { status: result, inbox_item_id: payload.inbox_item_id },
        };
      },
      settle: async (claimed, executionResult, defaultSettle) => {
        const pending = this.pendingGroupedSettlements.get(claimed.id);
        this.pendingGroupedSettlements.delete(claimed.id);
        if (executionResult.status !== "completed") {
          return this.runDefaultSettle(defaultSettle);
        }
        if (this.unavailable() || !pending || pending.attemptCount !== claimed.attempt_count) {
          return this.rescheduleCancelledEffect(claimed, "publication_cancelled_on_close");
        }
        try {
          return withFencedEffectTransaction(this.database, this.writeFence, () => {
            resolvePeerReceipt(this.database, pending.inboxItemId, pending.result, this.nowIso());
            const completed = completeEffectInTransaction(this.database, {
              id: claimed.id,
              expectedEpoch: claimed.epoch,
              expectedAttemptCount: claimed.attempt_count,
              outcome: executionResult.outcome,
              nowIso: this.nowIso(),
            });
            pruneTerminalRoomWorkEffectsInTransaction(this.database, claimed.agent_id);
            return completed;
          });
        } catch (error) {
          if (error instanceof DaemonFenceLostError) throw error;
          return this.handleSettlementStorageFailure(claimed, error);
        }
      },
    };
  }

  private runDefaultSettle(defaultSettle: () => EffectRecord): EffectRecord {
    try {
      return defaultSettle();
    } catch (error) {
      if (error instanceof DaemonFenceLostError) throw error;
      if (error instanceof EffectFenceError) throw error;
      if (!this.unavailable()) this.report("storage_unavailable");
      throw new RoomWorkSettlementStorageError(error);
    }
  }

  private handleSettlementStorageFailure(claimed: EffectRecord, error: unknown): EffectRecord {
    if (this.unavailable()) throw error;
    if (error instanceof EffectFenceError) throw error;
    this.report("storage_unavailable");
    try {
      return this.rescheduleExecutingEffect(claimed, this.now() + RETRY_MS, "settlement_write_failed");
    } catch (retryError) {
      if (retryError instanceof DaemonFenceLostError) throw retryError;
      throw new RoomWorkSettlementStorageError(error);
    }
  }

  private rescheduleExecutingEffect(effect: EffectRecord, nextAttemptAtMs: number, error: string): EffectRecord {
    if (effect.attempt_count < effect.max_attempts) {
      return rescheduleEffectForRetry(this.database, this.writeFence, {
        id: effect.id,
        expectedEpoch: effect.epoch,
        expectedAttemptCount: effect.attempt_count,
        nextAttemptAtMs: Math.max(0, nextAttemptAtMs),
        error,
        nowIso: this.nowIso(),
      });
    }
    return failEffect(this.database, this.writeFence, {
      id: effect.id,
      expectedEpoch: effect.epoch,
      expectedAttemptCount: effect.attempt_count,
      error,
      nowIso: this.nowIso(),
    });
  }

  private rescheduleCancelledEffect(claimed: EffectRecord, error: string): EffectRecord {
    return this.rescheduleExecutingEffect(claimed, this.now(), error);
  }

  /**
   * Recovers an orphaned `executing` room-work effect whose execution promise
   * is no longer active in this process (for example after a failed SQLite
   * settlement write left the row `executing`). Never touches genuinely active
   * in-flight executions or future-epoch rows.
   */
  private recoverInactiveExecutingEffect(effect: EffectRecord, now: number): EffectRecord {
    if (effect.state !== "executing") return effect;
    if (this.executor.isEffectActive(effect.id)) return effect;
    if (effect.attempt_count < 1 || effect.epoch > this.options.daemonGeneration()) return effect;
    const updatedAtMs = Date.parse(effect.updated_at);
    const baseMs = Number.isFinite(updatedAtMs) ? Math.min(updatedAtMs, now) : now;
    try {
      return this.rescheduleExecutingEffect(effect, baseMs + RETRY_MS, "recovered_inactive_executing_effect");
    } catch (error) {
      if (error instanceof DaemonFenceLostError) throw error;
      if (!this.unavailable()) this.report("storage_unavailable");
      return effect;
    }
  }

  private pendingGroupedReports(agentId: string) {
    const authority = this.authority(agentId);
    if (!authority) return [];
    const now = this.now();
    // Filter the current Room before limiting: unavailable old-room custody
    // never starves reports for the worker's actual current Room.
    const rows = this.database.prepare(`SELECT i.inbox_item_id,i.source_message_id FROM inbox_items i
      WHERE i.agent_id=? AND i.room_id=? AND i.state='acknowledged_no_reply' AND ${PENDING_PEER_REPORT_SQL}
      ORDER BY i.fifo_sequence`).all(agentId, authority.origin.roomId);
    return rows.flatMap(row => {
      const inboxItemId = String(row.inbox_item_id);
      const sourceMessageId = String(row.source_message_id);
      const pin = this.store.get(agentId, authority.origin.roomId, sourceMessageId);
      if (!pin || !this.sameOrigin(authority.origin, pin)) return [];
      const idempotencyKey = roomWorkGroupedNoReplyIdempotencyKey({
        roomId: pin.roomId,
        sourceMessageId: pin.sourceMessageId,
        inboxItemId,
      });
      let existing = getEffectByIdempotencyKey(
        this.database,
        agentId,
        ROOM_WORK_GROUPED_NO_REPLY_EFFECT_KIND,
        idempotencyKey,
      );
      if (existing?.state === "executing") {
        existing = this.recoverInactiveExecutingEffect(existing, now);
      }
      if (existing) {
        if (existing.state !== "prepared") return [];
        if (existing.next_attempt_at_ms !== null && existing.next_attempt_at_ms > now) return [];
      }
      const payload: RoomWorkGroupedNoReplyEffectPayload = {
        room_id: pin.roomId,
        source_message_id: pin.sourceMessageId,
        inbox_item_id: inboxItemId,
      };
      return [{
        inboxItemId,
        pin,
        authority,
        idempotencyKey,
        payload,
        sortAt: existing?.next_attempt_at_ms ?? -Infinity,
      }];
    }).sort((a, b) => a.sortAt - b.sortAt);
  }

  /** Separable from the timer for deterministic real-store tests. No caller awaits this to run an agent. */
  async flush(): Promise<void> {
    if (this.unavailable() || this.running) return;
    this.running = true;
    let more = false;
    let failed = false;
    try {
      await this.options.assertCurrent();
      if (this.unavailable()) return;
      if (this.ownsExecutor && !this.recoveredOwnedExecutor) {
        if (hasInterruptedRoomWorkEffects(this.database)) {
          recoverInterruptedEffectsOnStartup(this.database, this.writeFence, {
            daemonGeneration: this.options.daemonGeneration(),
            nowMs: this.now(),
            nowIso: this.nowIso(),
          });
        }
        this.recoveredOwnedExecutor = true;
      }
      // Give changed agents the next pass, alternating with the recovery sweep
      // so continuous live output cannot starve missed hints or retry work.
      // Still only one agent (at most 10k pins/facts) per pass.
      const nextAgent = () => this.database.prepare(`SELECT agent_id FROM room_work_publications
        WHERE state='open' AND agent_id>? ORDER BY agent_id LIMIT 1`).get(this.scanAfter);
      const changedAgent = this.settledAgents.values().next().value ?? this.changedAgents.values().next().value;
      let agentId: string;
      if (changedAgent && !this.sweepNext) {
        agentId = changedAgent;
        this.sweepNext = true;
        more = true;
      } else {
        let row = nextAgent();
        if (!row) { this.scanAfter = ""; row = nextAgent(); }
        if (!row && !changedAgent) return;
        agentId = row ? String(row.agent_id) : changedAgent!;
        if (row) this.scanAfter = agentId;
        this.sweepNext = false;
        more = !!nextAgent();
      }
      // Consume before awaiting: a hint arriving during staging/upload must
      // remain queued for another pass, including a terminal no-reply update.
      this.changedAgents.delete(agentId);
      this.settledAgents.delete(agentId);
      try { more = await this.stageChanged(agentId) || more; }
      catch { this.report("storage_unavailable"); }
      if (this.unavailable()) return;
      const now = this.now();
      const grouped = this.pendingGroupedReports(agentId);
      const activePublish = listActiveRoomWorkEffectsForAgent(
        this.database,
        agentId,
        ROOM_WORK_PUBLISH_EFFECT_KIND,
      );
      const activeBySource = new Map<string, EffectRecord[]>();
      for (const rawEffect of activePublish) {
        const effect = rawEffect.state === "executing"
          ? this.recoverInactiveExecutingEffect(rawEffect, now)
          : rawEffect;
        if (effect.state !== "prepared" && effect.state !== "executing") continue;
        const parsed = parseRoomWorkPublishEffectPayload(effect.payload);
        if (!parsed) continue;
        const sourceKey = `${parsed.room_id}\0${parsed.source_message_id}`;
        const bucket = activeBySource.get(sourceKey);
        if (bucket) bucket.push(effect);
        else activeBySource.set(sourceKey, [effect]);
      }
      const pending = this.store.list(agentId)
        .filter(record => record.state === "open" && record.summary && (record.revision > record.acknowledgedRevision || this.pendingReviewPage(record)));
      const eligible: Array<{
        record: RoomWorkPublication;
        reviewPage: WorkspaceReviewPage | null;
        authority: PublicationAuthority;
        idempotencyKey: string;
        payload: RoomWorkPublishEffectPayload;
        sortAt: number;
      }> = [];
      for (const record of pending) {
        if (!record.attemptId || !record.digest) continue;
        const reviewPage = this.pendingReviewPage(record);
        const idempotencyKey = roomWorkPublishIdempotencyKey({
          roomId: record.roomId,
          sourceMessageId: record.sourceMessageId,
          revision: record.revision,
          digest: record.digest,
          reviewPageIndex: reviewPage?.index ?? null,
          reviewPageDigest: reviewPage?.digest ?? null,
        });
        const payload: RoomWorkPublishEffectPayload = {
          room_id: record.roomId,
          source_message_id: record.sourceMessageId,
          attempt_id: record.attemptId,
          revision: record.revision,
          digest: record.digest,
          review_page_index: reviewPage ? reviewPage.index : null,
          review_page_total: reviewPage ? reviewPage.total : null,
          review_page_digest: reviewPage ? reviewPage.digest : null,
        };
        const sourceKey = `${record.roomId}\0${record.sourceMessageId}`;
        const activeForSource = activeBySource.get(sourceKey) ?? [];
        if (activeForSource.some(effect => effect.state === "executing")) continue;
        const stalePrepared = activeForSource.filter(
          effect => effect.state === "prepared" && effect.idempotency_key !== idempotencyKey,
        );
        let existing: EffectRecord | null;
        if (stalePrepared.length > 0) {
          try {
            existing = supersedeRoomWorkPublishEffects(this.database, this.writeFence, {
              staleEffectIds: stalePrepared.map(effect => effect.id),
              replacement: {
                agent_id: record.agentId,
                idempotency_key: idempotencyKey,
                epoch: this.options.daemonGeneration(),
                payload,
              },
              nowIso: this.nowIso(),
            }).effect;
          } catch (error) {
            if (error instanceof DaemonFenceLostError) throw error;
            if (error instanceof EffectFenceError) {
              if (this.unavailable()) return;
              throw error;
            }
            if (!this.unavailable()) this.report("storage_unavailable");
            continue;
          }
        } else {
          existing = getEffectByIdempotencyKey(
            this.database,
            record.agentId,
            ROOM_WORK_PUBLISH_EFFECT_KIND,
            idempotencyKey,
          );
        }
        if (existing) {
          if (existing.state !== "prepared") continue;
          if (existing.next_attempt_at_ms !== null && existing.next_attempt_at_ms > now) continue;
        }
        const authority = this.authority(record.agentId);
        if (authority && this.sameOrigin(authority.origin, record)) {
          eligible.push({
            record,
            reviewPage,
            authority,
            idempotencyKey,
            payload,
            sortAt: existing?.next_attempt_at_ms ?? -Infinity,
          });
        }
      }
      eligible.sort((a, b) => a.sortAt - b.sortAt);
      const uploadLimit = grouped.length ? 3 : 4;
      more = eligible.length > uploadLimit || more;
      for (const { record, reviewPage, authority, idempotencyKey, payload } of completionFirst(eligible,
        ({ record }) => record.revision > record.acknowledgedRevision && terminalState(record.summary?.recorded_state)).slice(0, uploadLimit)) {
        await this.options.assertCurrent();
        const current = this.authority(record.agentId);
        if (this.unavailable() || current?.grant !== authority.grant || current?.worker !== authority.worker) continue;
        let effectId: string | null = null;
        try {
          const prepared = await this.executor.prepare({
            agent_id: record.agentId,
            kind: ROOM_WORK_PUBLISH_EFFECT_KIND,
            idempotency_key: idempotencyKey,
            payload,
            retryable: true,
            max_attempts: ROOM_WORK_EFFECT_MAX_ATTEMPTS,
          });
          if (prepared.effect.state !== "prepared") continue;
          if (prepared.effect.next_attempt_at_ms !== null && prepared.effect.next_attempt_at_ms > this.now()) continue;
          effectId = prepared.effect.id;
          this.pendingDispatchAuthority.set(effectId, current);
          const settled = await this.executor.runEffect(effectId);
          if (settled.state === "completed" && reviewPage) {
            more = more || !!this.pendingReviewPage(record);
          }
        } catch (error) {
          if (error instanceof DaemonFenceLostError) throw error;
          if (error instanceof EffectClaimRefusedError) continue;
          if (error instanceof RoomWorkSettlementStorageError) continue;
          if (error instanceof EffectFenceError) {
            if (this.unavailable()) return;
            throw error;
          }
          if (!this.unavailable()) this.report("publication_unavailable");
        } finally {
          if (effectId) {
            this.pendingDispatchAuthority.delete(effectId);
            this.pendingPublishSettlements.delete(effectId);
          }
        }
      }
      // Grouped deliveries have no native attempt or RoomWork summary. Spend
      // at most one remaining slot after ordinary completion uploads.
      more = grouped.length > 1 || more;
      for (const { authority, idempotencyKey, payload } of grouped.slice(0, 1)) {
        await this.options.assertCurrent();
        const current = this.authority(agentId);
        if (this.unavailable() || current?.grant !== authority.grant || current?.worker !== authority.worker) continue;
        let effectId: string | null = null;
        try {
          const prepared = await this.executor.prepare({
            agent_id: agentId,
            kind: ROOM_WORK_GROUPED_NO_REPLY_EFFECT_KIND,
            idempotency_key: idempotencyKey,
            payload,
            retryable: true,
            max_attempts: ROOM_WORK_EFFECT_MAX_ATTEMPTS,
          });
          if (prepared.effect.state !== "prepared") continue;
          if (prepared.effect.next_attempt_at_ms !== null && prepared.effect.next_attempt_at_ms > this.now()) continue;
          effectId = prepared.effect.id;
          this.pendingDispatchAuthority.set(effectId, current);
          await this.executor.runEffect(effectId);
        } catch (error) {
          if (error instanceof DaemonFenceLostError) throw error;
          if (error instanceof EffectClaimRefusedError) continue;
          if (error instanceof RoomWorkSettlementStorageError) continue;
          if (error instanceof EffectFenceError) {
            if (this.unavailable()) return;
            throw error;
          }
          if (!this.unavailable()) this.report("publication_unavailable");
        } finally {
          if (effectId) {
            this.pendingDispatchAuthority.delete(effectId);
            this.pendingGroupedSettlements.delete(effectId);
          }
        }
      }
    } catch { failed = true; if (!this.unavailable()) this.report("authority_unavailable"); }
    finally {
      this.running = false;
      // A failed pass may not have consumed its hint. Preserve it, but replace
      // even a wake queued during the failure so lost authority cannot spin.
      this.schedule(failed ? RETRY_MS : this.settledAgents.size ? 0 : more || this.changedAgents.size ? COALESCE_MS : RETRY_MS, failed);
    }
  }
}
